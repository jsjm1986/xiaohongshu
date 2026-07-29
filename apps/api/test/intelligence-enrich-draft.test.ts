import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
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
    body: JSON.stringify({ title, ...data }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

async function upload(filename: string, content: string) {
  const res = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({ filename, content, category: '未分类', evidenceStatus: '已知事实' }),
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
  const intelligence = app.get(IntelligenceService);
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

test('只挑答案为空或来源是推断/假设/未知的缺口', async () => {
  const done = await createGap('已有答案的缺口', {
    question: '工期多久？',
    answer: '常规两居 45 天。',
    sourceStatus: 'supplied_fact',
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

test('模型产物全被丢弃时报错,并指向补充原始资料', async () => {
  await createGap('无法生成', { question: '?', sourceStatus: 'unknown' });
  modelReply = { items: [{ gapId: 'nope', content: 'x' }] };
  await assert.rejects(
    () => enrich.generateEnrichmentDraft(projectId, principal as never),
    /先补充一些原始资料/,
  );

  modelReply = {};
  await assert.rejects(() => enrich.generateEnrichmentDraft(projectId, principal as never), /原始资料/);
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

test('起草提示词禁止把「资料没写」写成「这项不存在」', async () => {
  /*
   * 冒烟测试(宠物医院)发现的真问题:原文完全没提线上问诊、微信支付、多宠折扣,
   * 草稿却写成「暂未开通线上咨询」「支付方式包括现金、微信、支付宝」
   * 「目前未针对多宠家庭提供折扣」——把信息缺失说成了事实上的否认。
   * 这等于替商家否认了它可能确实有的服务,和编造事实一样是凭空断言。
   */
  const gapId = await createGap(projectId, '线上咨询', { question: '是否支持线上问诊?', sourceStatus: 'unknown' });
  capturedPrompts = [];
  modelReply = { items: [{ gapId, content: '## 线上咨询\n\n资料未提及,待确认。', confidence: 'low' }] };
  await enrich.generateEnrichmentDraft(projectId, principal as never);

  const prompt = capturedPrompts.at(-1)!.prompt;
  assert.match(prompt, /"资料里没写"不等于"这项不存在"|资料里没写.{0,4}不等于.{0,4}这项不存在/);
  assert.match(prompt, /暂未开通/, '要明确点出这类禁用说法');
  assert.match(prompt, /资料未提及/, '要给出正确的替代写法');
});

test('起草任务用 enrich: 前缀记账,不污染分析进度', async () => {
  // 走真实的 runEnrichmentModel 会打模型,这里只验前缀常量与前端过滤的契约一致。
  const { ENRICH_FINGERPRINT_PREFIX } = await import('../src/intelligence.service.js');
  assert.equal(ENRICH_FINGERPRINT_PREFIX, 'enrich:');
});
