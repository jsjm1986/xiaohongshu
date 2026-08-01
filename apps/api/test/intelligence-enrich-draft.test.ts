import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { evidenceIdForSection, indexKnowledgeSource, selectKnowledgeContext } from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceEnrichService } from '../src/intelligence-enrich.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/*
  起草逻辑的测试:真 app + 真库,只把模型那一层换掉。

  runEnrichmentModel 是 public 方法,替换它就能在不联网、不消耗额度的前提下,
  覆盖「查待补缺口 → 抽相关资料 → 校验模型产物」这段真正的业务逻辑。
  同时它也是 extractRelevantContext 唯一的可观测出口——断言 stub 收到的 prompt。
*/

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let enrich: IntelligenceEnrichService;
let intelligence: IntelligenceService;
let principal: { userId: string; systemRole: string };

const PASSWORD = 'Enrich-bootstrap-123!';
const NEW_PASSWORD = 'Enrich-updated-456!';

/** 每次调用记下收到的提示词,并回放预设产物。 */
let capturedPrompts: Array<{ prompt: string; purpose: string }> = [];
let modelReply: Record<string, unknown> = { items: [] };

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

async function createGap(title: string, data: Record<string, unknown>) {
  const res = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title, knowledgeAction: 'organize_existing', ...data }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

/*
 * 分析器判定「资料里有出处」的缺口。
 *
 * supplied_fact 只能由分析器基于 evidenceSections 写,人工路径(POST/PATCH)
 * 会被 assertNoAnalyzerOnlySource 拦成 400。这里直接改库模拟分析器落库,
 * 而不是放宽那道门禁——待补充判据要覆盖的正是分析器写出来的这一档。
 */
async function createAnalyzerFactGap(title: string, data: Record<string, unknown>) {
  const { sourceStatus: _dropped, ...rest } = data;
  const id = await createGap(title, rest);
  app.get(DatabaseService).prepare(
    "UPDATE information_gaps SET data_json = json_set(data_json, '$.sourceStatus', 'supplied_fact') WHERE id=?",
  ).run(id);
  return id;
}

async function upload(filename: string, content: string, category = '未分类') {
  const res = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({ filename, content, category, evidenceStatus: '已知事实' }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-enrich-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  principal = { userId: login.body.user?.id ?? login.body.id, systemRole: 'admin' };

  // 首次登录必须改密码,否则后续写操作一律 403 PASSWORD_CHANGE_REQUIRED
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.body));

  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '知识补充项目', domain: '装修' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;

  enrich = app.get(IntelligenceEnrichService);
  intelligence = app.get(IntelligenceService);
  // 换掉模型层。保留任务生命周期不测:那部分由既有的 analysis-task 测试覆盖。
  (intelligence as unknown as Record<string, unknown>).runEnrichmentModel = async (
    _projectId: string,
    _principal: unknown,
    prompt: string,
    purpose: string,
  ) => {
    capturedPrompts.push({ prompt, purpose });
    return modelReply;
  };
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('没有任何缺口时拒绝起草', async () => {
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never),
    /没有需要补充的信息缺口/,
  );
});

test('历史缺口缺少 knowledgeAction 时保守回落 none', async () => {
  const gapId = await createGap('历史规划缺口', {
    question: '这是选题问题吗?',
    sourceStatus: 'unknown',
    knowledgeAction: undefined,
  });
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]),
    /指定的缺口不存在/,
  );
});

test('ask_user 直接要求用户填写事实，不调用模型编答案', async () => {
  const gapId = await createGap('真实成交价格', {
    question: '本项目最终成交价格是多少?',
    sourceStatus: 'unknown',
    knowledgeAction: 'ask_user',
    knowledgeReason: '现有资料没有最终合同价格，只有项目负责人能确认。',
  });
  capturedPrompts = [];
  modelReply = { items: [{ gapId, content: '模型不应生成这段价格。', confidence: 'high' }] };

  const result = await enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]);

  assert.equal(capturedPrompts.length, 0);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].knowledgeAction, 'ask_user');
  assert.equal(result.gaps[0].aiDraft, '');
  assert.match(result.gaps[0].knowledgeReason, /项目负责人/);
});

test('分析引用的 evidence ID 优先进入提示词并返回来源摘录', async () => {
  const content = '# 服务规则\n\n## 退款条件\n\n签约后七日内且服务尚未开始，可以申请全额退款。';
  const file = await upload('退款规则.md', content);
  const indexed = indexKnowledgeSource({
    id: String(file.id),
    projectId: 'enrichment',
    path: '退款规则.md',
    content,
    metadata: {
      title: '退款规则.md', kind: 'fact', evidenceStatus: 'user_supplied', keywords: [], scope: [], caveats: [],
    },
  });
  const sections = selectKnowledgeContext({
    documents: [indexed],
    query: '',
    budget: { maxInputTokens: 100_000_000, systemPromptTokens: 0, formulaPromptTokens: 0, outputReserveTokens: 0 },
  }).sections.filter((section) => section.documentId !== 'generated');
  const source = sections.find((section) => section.content.includes('七日内'))!;
  const evidenceId = evidenceIdForSection(source);
  const gapId = await createAnalyzerFactGap('退费约束整理', {
    question: '把已确认的合同解除规则整理清楚。',
    sourceStatus: 'supplied_fact',
    knowledgeAction: 'organize_existing',
    evidenceIds: [evidenceId],
  });
  capturedPrompts = [];
  modelReply = {
    items: [{ gapId, content: '签约后七日内且服务尚未开始时，可以申请全额退款。', confidence: 'high' }],
  };

  const result = await enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]);

  assert.match(capturedPrompts[0].prompt, /已引用证据：退款规则\.md/);
  assert.match(capturedPrompts[0].prompt, /签约后七日内/);
  assert.equal(result.gaps[0].sources[0].evidenceId, evidenceId);
  assert.equal(result.gaps[0].sources[0].filename, '退款规则.md');
  assert.match(result.gaps[0].sources[0].excerpt, /全额退款/);
});

test('没有 evidence ID 时把关键词命中的真实分节作为来源返回', async () => {
  await upload(
    '咨询抵扣规则.md',
    '# 咨询规则\n\n## 诊断与抵扣\n\n视频诊断为 60 分钟，费用 199 元；七日内签约可抵扣基础服务费。',
  );
  const gapId = await createGap('整理视频诊断与抵扣规则', {
    question: '把视频诊断时长、费用和签约抵扣条件整理清楚。',
    sourceStatus: 'unknown',
    knowledgeAction: 'organize_existing',
  });
  modelReply = {
    items: [{
      gapId,
      content: '视频诊断为 60 分钟，费用 199 元；七日内签约可抵扣基础服务费。',
      confidence: 'high',
    }],
  };

  const result = await enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]);

  assert.ok(result.gaps[0].sources.length > 0, '关键词检索喂给模型的资料也必须对用户可见');
  assert.equal(result.gaps[0].sources[0].filename, '咨询抵扣规则.md');
  assert.match(result.gaps[0].sources[0].heading, /诊断与抵扣/);
  assert.match(result.gaps[0].sources[0].excerpt, /60 分钟/);
});

test('只挑答案为空或来源是推断/假设/未知的缺口', async () => {
  const done = await createAnalyzerFactGap('已有答案的缺口', {
    question: '工期多久？',
    answer: '常规两居 45 天。',
    sourceStatus: 'supplied_fact',
    knowledgeAction: 'none',
  });
  const unknown = await createGap('价格区间', { question: '整装报价多少？', sourceStatus: 'unknown' });
  const inference = await createGap('主材品牌', {
    question: '主材用什么品牌？',
    answer: '推测是中端国产品牌。',
    sourceStatus: 'inference',
  });
  const hypothesis = await createGap('售后年限', {
    question: '保修几年？',
    answer: '可能两年。',
    sourceStatus: 'hypothesis',
  });

  capturedPrompts = [];
  modelReply = {
    items: [unknown, inference, hypothesis, done].map((gapId) => ({
      gapId,
      content: '## 小标题\n\n这是一段足够长的补充内容,用于通过最短长度校验。',
      confidence: 'medium',
    })),
  };

  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  const ids = result.gaps.map((gap) => gap.gapId);
  assert.equal(ids.includes(unknown), true, '未知档应入选');
  assert.equal(ids.includes(inference), true, '推断档应入选');
  assert.equal(ids.includes(hypothesis), true, '假设档应入选');
  assert.equal(ids.includes(done), false, '已有答案且来源是事实的不该入选');
  assert.equal(capturedPrompts.at(-1)!.purpose, 'draft');
});

test('模型编造的 gapId 被丢弃', async () => {
  const gapId = await createGap('施工资质', { question: '有哪些资质？', sourceStatus: 'unknown' });
  modelReply = {
    items: [
      { gapId, content: '## 资质\n\n这是一段足够长的正文内容。', confidence: 'high' },
      { gapId: 'fabricated-gap-id', content: '## 编造\n\n这条不该出现在结果里。', confidence: 'high' },
    ],
  };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  assert.equal(result.gaps.some((gap) => gap.gapId === 'fabricated-gap-id'), false);
  assert.equal(result.gaps.some((gap) => gap.gapId === gapId), true);
});

test('正文过短的条目被丢弃', async () => {
  const short = await createGap('过短条目', { question: '短的?', sourceStatus: 'unknown' });
  const ok = await createGap('正常条目', { question: '正常?', sourceStatus: 'unknown' });
  modelReply = {
    items: [
      { gapId: short, content: '太短', confidence: 'high' },
      { gapId: ok, content: '## 正常\n\n这是一段足够长的正文内容。', confidence: 'high' },
    ],
  };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  assert.equal(result.gaps.some((gap) => gap.gapId === short), false);
  assert.equal(result.gaps.some((gap) => gap.gapId === ok), true);
});

test('把握程度缺失或是垃圾值时保守取 low', async () => {
  const a = await createGap('缺 confidence', { question: 'a?', sourceStatus: 'unknown' });
  const b = await createGap('垃圾 confidence', { question: 'b?', sourceStatus: 'unknown' });
  modelReply = {
    items: [
      { gapId: a, content: '## A\n\n这是一段足够长的正文内容。' },
      { gapId: b, content: '## B\n\n这是一段足够长的正文内容。', confidence: 'VERY_HIGH' },
    ],
  };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  for (const gapId of [a, b]) {
    const found = result.gaps.find((gap) => gap.gapId === gapId);
    assert.equal(found?.confidence, 'low', `${gapId} 应落到 low`);
  }
});

test('模型产物全被丢弃时报错并允许重试或直接编辑', async () => {
  const gapId = await createGap('无法生成', { question: '?', sourceStatus: 'unknown' });
  modelReply = { items: [{ gapId: 'nope', content: 'x' }] };
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]),
    /没能基于现有资料整理出可用内容/,
  );

  modelReply = {};
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]),
    /重试或直接编辑知识库/,
  );
});

test('模型起草期间知识版本变化时不返回过期草稿', async () => {
  const gapId = await createGap('起草期间更新资料', { question: '最新资料是什么?', sourceStatus: 'unknown' });
  const original = (intelligence as any).runEnrichmentModel;
  (intelligence as any).runEnrichmentModel = async () => {
    await upload('起草竞态.md', '模型运行期间上传的新版本资料。');
    return {
      items: [{ gapId, content: '## 旧草稿\n\n这是基于上传前资料生成的过期内容。', confidence: 'low' }],
    };
  };
  try {
    await assert.rejects(
      () => enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]),
      /起草期间发生了变化/,
    );
  } finally {
    (intelligence as any).runEnrichmentModel = original;
  }
});

test('提示词只带入与缺口相关的资料段落', async () => {
  await upload(
    '项目资料.md',
    ['## 报价说明', '整装报价按平方计,含主材。', '', '## 团建活动', '每季度组织一次员工爬山。'].join('\n'),
  );
  const gapId = await createGap('报价构成', { question: '整装报价包含哪些项?', sourceStatus: 'unknown' });

  capturedPrompts = [];
  modelReply = { items: [{ gapId, content: '## 报价\n\n这是一段足够长的正文内容。', confidence: 'medium' }] };
  await enrich.generateEnrichmentDraft(projectId, principal as never);

  const prompt = capturedPrompts.at(-1)!.prompt;
  assert.match(prompt, /整装报价按平方计/, '相关段落应进提示词');
  assert.doesNotMatch(prompt, /员工爬山/, '无关段落不该进提示词');
  assert.match(prompt, new RegExp(`gapId=${gapId}`), '缺口清单应带 gapId');
  assert.match(prompt, /不要编造具体数字/, '禁止编造事实的约束必须在提示词里');
});

test('指定 gapIds 时只起草那几条,不整批跑', async () => {
  const a = await createGap('精补A', { question: 'a?', sourceStatus: 'unknown' });
  const b = await createGap('精补B', { question: 'b?', sourceStatus: 'unknown' });
  await createGap('不该出现的C', { question: 'c?', sourceStatus: 'unknown' });

  capturedPrompts = [];
  modelReply = { items: [a, b].map((gapId) => ({
    gapId, content: '## 标题\n\n这是一段足够长的补充内容。', confidence: 'medium',
  })) };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never, [a, b]);

  assert.equal(result.gaps.length, 2);
  const prompt = capturedPrompts.at(-1)!.prompt;
  assert.doesNotMatch(prompt, /不该出现的C/, '未指定的缺口不该进提示词');
  assert.equal((prompt.match(/gapId=/g) || []).length, 2);
});

test('指定的 gapId 不属于知识完善流程时拒绝', async () => {
  const answered = await createAnalyzerFactGap('已有答案的', {
    question: 'x?', answer: '已经填好了。', sourceStatus: 'supplied_fact', knowledgeAction: 'none',
  });
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, [answered]),
    /指定的缺口不存在.*或已经有答案/,
    '指名一条已有答案的缺口,不能拿去重写',
  );
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, ['00000000-0000-0000-0000-000000000000']),
    /指定的缺口不存在/,
  );
});

test('模型把同一个 gapId 返回两次时只保留第一条', async () => {
  /*
   * 边界探查发现的缺陷。重复的后果是实际的:
   * - 前端 EnrichmentDraftList 用 key={item.gapId},重复 key 让 React 渲染行为未定义
   * - applyDraftChange 按 gapId 匹配,用户改一条会同时改掉两条
   * - 合并时同一个缺口的内容会进去两遍
   * 保留第一条而不是最后一条:模型通常把最完整的答案放在前面。
   */
  const gapId = await createGap('重复缺口', { question: '会重复吗?', sourceStatus: 'unknown' });
  modelReply = {
    items: [
      { gapId, content: '## 第一次\n\n这是第一段足够长的内容。', confidence: 'high' },
      { gapId, content: '## 第二次\n\n这是第二段足够长的内容。', confidence: 'low' },
    ],
  };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  const dupes = result.gaps.filter((gap) => gap.gapId === gapId);
  assert.equal(dupes.length, 1, '同一 gapId 只能出现一次');
  assert.match(dupes[0].aiDraft, /第一次/, '保留的应是第一条');
  assert.equal(dupes[0].confidence, 'high');
});

test('起草提示词禁止编造，且丢弃模型返回的未决占位内容', async () => {
  /*
   * 冒烟测试(宠物医院)发现的真问题:原文完全没提线上问诊、微信支付、多宠折扣,
   * 草稿却写成「暂未开通线上咨询」「支付方式包括现金、微信、支付宝」
   * 「目前未针对多宠家庭提供折扣」——把信息缺失说成了事实上的否认。
   * 这等于替商家否认了它可能确实有的服务,和编造事实一样是凭空断言。
   */
  const gapId = await createGap('线上咨询', { question: '是否支持线上问诊?', sourceStatus: 'unknown' });
  capturedPrompts = [];
  modelReply = { items: [{ gapId, content: '## 线上咨询\n\n资料未提及,待确认。', confidence: 'low' }] };
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]),
    /没能基于现有资料整理出可用内容/,
  );

  const prompt = capturedPrompts.at(-1)!.prompt;
  assert.match(prompt, /不允许合理推断、行业常识或假设/);
  assert.match(prompt, /不要输出「待确认」「资料未提及」/);
});

test('起草不把 reference-corpus 对标样本当作项目事实资料', async () => {
  const gapId = await createGap('参考语料隔离', {
    question: '项目承诺是什么?',
    sourceStatus: 'unknown',
  });
  await upload('竞品样本.md', '竞品承诺百分百成功，这是风格样本，不是本项目事实。', 'reference-corpus');
  capturedPrompts = [];
  modelReply = {
    items: [{ gapId, content: '## 项目承诺\n\n本项目仅提供书面咨询服务。', confidence: 'low' }],
  };

  await enrich.generateEnrichmentDraft(projectId, principal as never, [gapId]);

  assert.doesNotMatch(capturedPrompts.at(-1)!.prompt, /竞品承诺百分百成功/);
});

test('起草任务用 enrich: 前缀记账,不污染分析进度', async () => {
  // 走真实的 runEnrichmentModel 会打模型,这里只验前缀常量与前端过滤的契约一致。
  const { ENRICH_FINGERPRINT_PREFIX } = await import('../src/intelligence.service.js');
  assert.equal(ENRICH_FINGERPRINT_PREFIX, 'enrich:');
});

test('多轮分析后只起草最新批次和人工缺口,旧批次留库但不参与当前流程', async () => {
  const db = app.get(DatabaseService);
  const userId = principal.userId;
  const now = new Date().toISOString();
  const oldTask = 'analysis-old';
  const newTask = 'analysis-new';
  const oldResult = 'intelligence-old';
  const newResult = 'intelligence-new';
  for (const [taskId, resultId, version] of [[oldTask, oldResult, 1], [newTask, newResult, 2]] as const) {
    db.prepare(
      `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count, result_id,
        created_by, created_at, updated_at, completed_at)
       VALUES (?, ?, 'project', NULL, 'completed', ?, 1, ?, ?, ?, ?, ?)`,
    ).run(taskId, projectId, `fp-${version}`, resultId, userId, now, now, now);
    db.prepare(
      `INSERT INTO project_intelligence
       (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, '{}', ?, ?, ?)`,
    ).run(resultId, projectId, version, `fp-${version}`, userId, now, now);
  }
  const insertGap = (id: string, source: string | null, title: string) => db.prepare(
    `INSERT INTO information_gaps
     (id, project_id, title, priority, status, source_analysis_id, data_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 50, 'draft', ?, '{"sourceStatus":"unknown","knowledgeAction":"organize_existing"}', ?, ?, ?)`,
  ).run(id, projectId, title, source, userId, now, now);
  insertGap('old-batch-gap', oldTask, '旧批次不应出现');
  insertGap('new-batch-gap', newTask, '最新批次应出现');
  insertGap('manual-gap', null, '人工缺口应保留');

  capturedPrompts = [];
  modelReply = {
    items: [
      { gapId: 'old-batch-gap', content: '## 旧\n\n这条不应被接受。', confidence: 'low' },
      { gapId: 'new-batch-gap', content: '## 新\n\n最新批次补充内容。', confidence: 'low' },
      { gapId: 'manual-gap', content: '## 人工\n\n人工缺口补充内容。', confidence: 'low' },
    ],
  };
  const result = await enrich.generateEnrichmentDraft(projectId, principal as never);
  assert.deepEqual(
    result.gaps.filter((gap) => ['old-batch-gap', 'new-batch-gap', 'manual-gap'].includes(gap.gapId)).map((gap) => gap.gapId).sort(),
    ['manual-gap', 'new-batch-gap'],
  );
  assert.doesNotMatch(capturedPrompts.at(-1)!.prompt, /旧批次不应出现/);
  assert.equal(
    Number((db.prepare("SELECT COUNT(*) AS count FROM information_gaps WHERE id='old-batch-gap'").get() as { count: number }).count),
    1,
    '历史行必须保留用于审计',
  );
});
