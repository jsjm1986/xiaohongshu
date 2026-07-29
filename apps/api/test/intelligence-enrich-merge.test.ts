import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { IntelligenceEnrichService } from '../src/intelligence-enrich.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import { KnowledgeService } from '../src/knowledge.service.js';

/* 合并与保存:真 app + 真库,只把模型那一层换掉(同 intelligence-enrich-draft)。 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let otherProjectId = '';
let enrich: IntelligenceEnrichService;
let knowledge: KnowledgeService;
let principal: { userId: string; systemRole: string };

const PASSWORD = 'Merge-bootstrap-123!';
const NEW_PASSWORD = 'Merge-updated-456!';

let capturedPrompts: string[] = [];
let modelReply: Record<string, unknown> = { document: '# 合并结果\n\n正文。' };

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

async function createGap(target: string, title: string) {
  const res = await request(`/api/projects/${target}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title, question: `${title}?`, sourceStatus: 'unknown' }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

async function upload(target: string, filename: string, content: string, category = '方法论') {
  const res = await request(`/api/projects/${target}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({ filename, content, category, evidenceStatus: '已知事实' }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-merge-'));
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
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.body));

  for (const name of ['合并项目', '另一个项目']) {
    const project = await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, domain: '留学' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    if (name === '合并项目') projectId = project.body.id;
    else otherProjectId = project.body.id;
  }

  enrich = app.get(IntelligenceEnrichService);
  knowledge = app.get(KnowledgeService);
  const intelligence = app.get(IntelligenceService);
  (intelligence as unknown as Record<string, unknown>).runEnrichmentModel = async (
    _projectId: string,
    _principal: unknown,
    prompt: string,
  ) => {
    capturedPrompts.push(prompt);
    return modelReply;
  };
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('目标文件缺省时优先选 INDEX.md,并标为已有文件', async () => {
  await upload(projectId, 'INDEX.md', '# 原有资料\n\n已有的内容。');
  await upload(projectId, '其它.md', '# 其它\n\n无关内容。');
  const gapId = await createGap(projectId, '申请费用');

  capturedPrompts = [];
  modelReply = { document: '# 原有资料\n\n已有的内容。\n\n## 申请费用\n\n补充说明。' };
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '费用约 3 万起,待确认。' }],
    undefined,
    principal as never,
  );

  assert.equal(result.targetFile, 'INDEX.md');
  assert.equal(result.isNewFile, false);
  assert.match(result.preview, /申请费用/);
  // 原文与补充都要进提示词,否则「不要删除原文信息」这条无从执行
  assert.match(capturedPrompts.at(-1)!, /已有的内容/);
  assert.match(capturedPrompts.at(-1)!, /费用约 3 万起/);
  assert.match(capturedPrompts.at(-1)!, /### 申请费用/, '补充内容应带缺口标题');
});

test('项目里没有 INDEX.md 时目标为 INDEX.md 且标为新文件', async () => {
  const gapId = await createGap(otherProjectId, '签证周期');
  await upload(otherProjectId, '资料.md', '# 资料\n\n只有这一个文件。');

  modelReply = { document: '# 签证周期\n\n约四周,待确认。' };
  const result = await enrich.mergeEnrichedKnowledge(
    otherProjectId,
    [{ gapId, status: 'confirmed', content: '约四周,待确认。' }],
    undefined,
    principal as never,
  );
  assert.equal(result.targetFile, 'INDEX.md');
  assert.equal(result.isNewFile, true);
});

test('跨项目的 gapId 被拒,报错不泄露那条缺口的标题', async () => {
  const foreign = await createGap(otherProjectId, '机密缺口标题');
  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [{ gapId: foreign, status: 'confirmed', content: '内容' }],
      undefined,
      principal as never,
    ),
    (error: Error) => {
      assert.match(error.message, /不存在或不属于本项目/);
      assert.doesNotMatch(error.message, /机密缺口标题/, '报错不该带出别的项目的数据');
      assert.doesNotMatch(error.message, new RegExp(foreign), '也不该回显 id');
      return true;
    },
  );
});

test('全部删除时拒绝合并', async () => {
  const gapId = await createGap(projectId, '住宿安排');
  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [{ gapId, status: 'deleted' }],
      undefined,
      principal as never,
    ),
    /至少保留一条/,
  );
});

test('确认的条目缺正文时拒绝合并', async () => {
  const gapId = await createGap(projectId, '语言要求');
  for (const content of [undefined, '', '   ']) {
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content }],
        undefined,
        principal as never,
      ),
      /必须带上正文内容/,
    );
  }
});

test('模型返回空 document 时拒绝,不把空文档当结果', async () => {
  const gapId = await createGap(projectId, '奖学金');
  for (const reply of [{ document: '' }, { document: '   ' }, {}, { document: 42 }]) {
    modelReply = reply as Record<string, unknown>;
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content: '内容' }],
        undefined,
        principal as never,
      ),
      /没能生成合并结果/,
    );
  }
});

test('保存成同名文件的新版本,旧版本仍在', async () => {
  await upload(projectId, '版本文件.md', '第一版内容。');
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '第二版内容,含补充。',
    '版本文件.md',
    principal as never,
  );
  assert.equal(Number(saved.version), 2);

  const rows = knowledge.list(projectId).filter((row) => String(row.filename) === '版本文件.md');
  assert.equal(rows.length, 2, '旧版本行必须保留,用户要能回看');
  const first = rows.find((row) => Number(row.version) === 1)!;
  const content = await knowledge.getWithContent(String(first.id));
  assert.match(String(content.content), /第一版内容/, '旧版本正文不该被覆盖');
});

test('保存沿用原文件的分类,但证据类型降为猜想', async () => {
  await upload(projectId, '分类文件.md', '原文。', '知识地图');
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '补充后的正文。',
    '分类文件.md',
    principal as never,
  );
  assert.equal(saved.category, '知识地图', '分类要沿用:它决定这份资料参与哪类语料');
  // 关键一条:补充内容是模型推断 + 用户审查,审查不等于核实。
  // 继承「已知事实」会经 evidenceStatus() 映射成 observed,让 agent-core 把推断当事实用。
  assert.equal(saved.evidenceStatus, '猜想');
  assert.equal((saved.metadata as Record<string, unknown>).source, 'ai-enrichment');
});

test('保存到新文件时分类落到未分类', async () => {
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '全新文件的正文。',
    '全新补充.md',
    principal as never,
  );
  assert.equal(Number(saved.version), 1);
  assert.equal(saved.category, '未分类');
  assert.equal(saved.evidenceStatus, '猜想');
});

test('合并吃掉不确定标记时回报 hedgeLossCount', async () => {
  // 实测过的退化:把「待确认:是否达到 E1 级」改写成「达到 E1 级」,凭空造出事实。
  // 这里只要求「能报出来」,不要求阻断——判断某句是否真从推断变成断言需要理解上下文。
  const gapId = await createGap(projectId, '环保标准');
  modelReply = { document: '## 环保标准\n\n主材达到国家环保标准 E1 级。' };
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '**待确认**:建议明确主材是否达到国家环保标准（如 E1 级）?' }],
    '环保.md',
    principal as never,
  );
  assert.ok(result.hedgeLossCount > 0, `应报出限定词丢失,实际 ${result.hedgeLossCount}`);
});

test('限定词原样保留时 hedgeLossCount 为 0', async () => {
  const gapId = await createGap(projectId, '保留标记');
  const content = '**待确认**:主材是否达到 E1 级?';
  modelReply = { document: `## 保留标记\n\n${content}` };
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content }],
    '保留.md',
    principal as never,
  );
  assert.equal(result.hedgeLossCount, 0);
});

test('模型多加限定词不会报成负数', async () => {
  const gapId = await createGap(projectId, '不会负数');
  modelReply = { document: '## 不会负数\n\n待确认:是否可能?通常一般应会原则上。' };
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '一句陈述。' }],
    '负数.md',
    principal as never,
  );
  assert.equal(result.hedgeLossCount, 0);
});

test('合并提示词明确要求保留不确定说法', async () => {
  // 这条是回归防护:第 6 条约束被删掉的话,退化会重新出现,而它不容易被别的测试发现。
  const gapId = await createGap(projectId, '提示词约束');
  capturedPrompts = [];
  modelReply = { document: '## 提示词约束\n\n正文。' };
  await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '内容' }],
    '约束.md',
    principal as never,
  );
  const prompt = capturedPrompts.at(-1)!;
  assert.match(prompt, /不确定的说法必须保持不确定/);
  assert.match(prompt, /不要改写成陈述句/);
});
