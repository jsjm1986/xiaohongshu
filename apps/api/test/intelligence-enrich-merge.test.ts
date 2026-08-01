import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
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
let intelligence: IntelligenceService;
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
    body: JSON.stringify({
      title,
      question: `${title}?`,
      sourceStatus: 'unknown',
      knowledgeAction: 'organize_existing',
    }),
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
  intelligence = app.get(IntelligenceService);
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

test('目标文件缺省时优先选 INDEX.md,原文不变并确定性追加确认事实', async () => {
  const original = '# 原有资料\n\n已有的内容。\n  ';
  await upload(projectId, 'INDEX.md', original);
  await upload(projectId, '其它.md', '# 其它\n\n无关内容。');
  const gapId = await createGap(projectId, '申请费用');

  capturedPrompts = [];
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '申请服务费用确定为人民币 3 万元起。' }],
    undefined,
    principal as never,
  );

  assert.equal(result.targetFile, 'INDEX.md');
  assert.equal(result.isNewFile, false);
  assert.equal(result.preview.startsWith(original), true, '既有原文必须逐字节保留');
  assert.match(result.preview, /^## 人工确认补充$/mu);
  assert.match(result.preview, /^### 申请费用$/mu);
  assert.match(result.preview, /申请服务费用确定为人民币 3 万元起/);
  assert.equal(result.appendedCount, 1);
  assert.equal(capturedPrompts.length, 0, '合并阶段不应调用模型重写全文');
});

test('项目里没有 INDEX.md 时目标为 INDEX.md 且标为新文件', async () => {
  const gapId = await createGap(otherProjectId, '签证周期');
  await upload(otherProjectId, '资料.md', '# 资料\n\n只有这一个文件。');

  const result = await enrich.mergeEnrichedKnowledge(
    otherProjectId,
    [{ gapId, status: 'confirmed', content: '签证办理周期确定为四个自然周。' }],
    undefined,
    principal as never,
  );
  assert.equal(result.targetFile, 'INDEX.md');
  assert.equal(result.isNewFile, true);
  assert.match(result.preview, /^# 项目知识库$/mu);
  assert.match(result.preview, /^### 签证周期$/mu);
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

test('起草后缺口已被填写时拒绝继续合并旧草稿', async () => {
  const gapId = await createGap(projectId, '已更新缺口');
  const database = app.get(DatabaseService);
  const row = database.prepare('SELECT data_json FROM information_gaps WHERE id=?').get(gapId) as { data_json: string };
  database.prepare('UPDATE information_gaps SET data_json=? WHERE id=?').run(
    JSON.stringify({ ...JSON.parse(row.data_json), answer: '用户已经填写真实答案。', sourceStatus: 'user_supplied' }),
    gapId,
  );
  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [{ gapId, status: 'confirmed', content: '这是之前生成的旧草稿。' }],
      undefined,
      principal as never,
    ),
    /已被更新或已有答案/,
  );
});

test('读取知识文件期间缺口被更新时不返回过期预览', async () => {
  const gapId = await createGap(projectId, '合并期间更新');
  const database = app.get(DatabaseService);
  const original = knowledge.getWithContent.bind(knowledge);
  let updated = false;
  (knowledge as any).getWithContent = async (id: string) => {
    const full = await original(id);
    if (updated) return full;
    updated = true;
    const row = database.prepare('SELECT data_json FROM information_gaps WHERE id=?').get(gapId) as { data_json: string };
    database.prepare('UPDATE information_gaps SET data_json=?, updated_at=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(row.data_json), answer: '模型运行期间人工补入的答案', sourceStatus: 'user_supplied' }),
      new Date().toISOString(),
      gapId,
    );
    return full;
  };
  try {
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content: '这是文件读取前确认过的旧版事实内容。' }],
        undefined,
        principal as never,
      ),
      /合并期间发生了变化/,
    );
  } finally {
    (knowledge as any).getWithContent = original;
  }
});

test('读取目标文件期间目标被更新时不返回基于旧正文的预览', async () => {
  await upload(projectId, '运行中更新.md', '第一版正文。');
  const gapId = await createGap(projectId, '目标文件运行中更新');
  const original = knowledge.getWithContent.bind(knowledge);
  let updated = false;
  (knowledge as any).getWithContent = async (id: string) => {
    const full = await original(id);
    if (!updated && String(full.filename) === '运行中更新.md') {
      updated = true;
      await upload(projectId, '运行中更新.md', '读取期间写入的第二版正文。');
    }
    return full;
  };
  try {
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content: '这是人工确认过的完整补充事实内容。' }],
        '运行中更新.md',
        principal as never,
      ),
      /合并期间发生了变化/,
    );
  } finally {
    (knowledge as any).getWithContent = original;
  }
});

test('拒绝把 AI 补全合并进 reference-corpus 参考语料', async () => {
  const reference = await upload(
    projectId,
    '对标样本.md',
    '这是竞品风格样本，不是本项目事实。',
    'reference-corpus',
  );
  const gapId = await createGap(projectId, '参考语料目标隔离');
  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [{ gapId, status: 'confirmed', content: '这是本项目人工确认过的事实补充。' }],
      '对标样本.md',
      principal as never,
    ),
    /不能合并进参考语料/,
  );
  await assert.rejects(
    () => enrich.saveEnrichedKnowledge(
      projectId,
      '绕过合并接口直接保存。',
      '对标样本.md',
      reference.id,
      principal as never,
    ),
    /不能合并进参考语料/,
  );
});

test('预览后目标被改成 reference-corpus 时事务内拒绝保存', async () => {
  const base = await upload(projectId, '分类竞态.md', '项目事实原文。', '知识地图');
  knowledge.recategorize(base.id, { category: 'reference-corpus' }, principal as never);
  await assert.rejects(
    () => enrich.saveEnrichedKnowledge(
      projectId,
      '旧预览内容。',
      '分类竞态.md',
      base.id,
      principal as never,
    ),
    /不能合并进参考语料/,
  );
  assert.equal(knowledge.list(projectId).filter((row) => row.filename === '分类竞态.md').length, 1);
});

test('合并不依赖模型返回值', async () => {
  const gapId = await createGap(projectId, '奖学金');
  capturedPrompts = [];
  modelReply = { document: '' };
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '奖学金金额确定为每学年人民币一万元。' }],
    '奖学金.md',
    principal as never,
  );
  assert.match(result.preview, /奖学金金额确定为每学年人民币一万元/);
  assert.equal(capturedPrompts.length, 0);
});

test('事实句已在目标文件中时拒绝仅换标题和标点的重复追加', async () => {
  await upload(
    projectId,
    '重复事实保护.md',
    '# 服务说明\n\n基础服务费为 6800 元。视频诊断为 60 分钟，费用 199 元；七日内签约可抵扣基础服务费。',
  );
  const gapId = await createGap(projectId, '整理价格与抵扣');

  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [{
        gapId,
        status: 'confirmed',
        content: '#### 基础价格\n\n基础服务费为 6800 元。\n\n#### 咨询抵扣\n\n视频诊断为 60 分钟，费用 199 元。七日内签约可抵扣基础服务费。',
      }],
      '重复事实保护.md',
      principal as never,
    ),
    /确认内容已存在于目标文件|无需重复保存/,
  );
});

test('保存成同名文件的新版本,旧版本仍在', async () => {
  const base = await upload(projectId, '版本文件.md', '第一版内容。');
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '第二版内容,含补充。',
    '版本文件.md',
    base.id,
    principal as never,
  );
  assert.equal(Number(saved.version), 2);

  const rows = knowledge.list(projectId).filter((row) => String(row.filename) === '版本文件.md');
  assert.equal(rows.length, 2, '旧版本行必须保留,用户要能回看');
  const first = rows.find((row) => Number(row.version) === 1)!;
  const content = await knowledge.getWithContent(String(first.id));
  assert.match(String(content.content), /第一版内容/, '旧版本正文不该被覆盖');
});

test('保存沿用原文件的分类,并标记为人工确认的已知事实', async () => {
  const base = await upload(projectId, '分类文件.md', '原文。', '知识地图');
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '补充后的正文。',
    '分类文件.md',
    base.id,
    principal as never,
  );
  assert.equal(saved.category, '知识地图', '分类要沿用:它决定这份资料参与哪类语料');
  assert.equal(saved.evidenceStatus, '已知事实');
  assert.equal((saved.metadata as Record<string, unknown>).source, 'ai-enrichment');
  assert.equal((saved.metadata as Record<string, unknown>).humanConfirmed, true);
});

test('预览后原文件被重新归类时保存沿用事务内的最新分类', async () => {
  const base = await upload(projectId, '重新归类.md', '原文。', '知识地图');
  knowledge.recategorize(base.id, { category: '约束' }, principal as never);
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '补充后的正文。',
    '重新归类.md',
    base.id,
    principal as never,
  );
  assert.equal(saved.category, '约束');
  assert.equal(saved.evidenceStatus, '已知事实');
});

test('保存到新文件时分类落到未分类', async () => {
  const saved = await enrich.saveEnrichedKnowledge(
    projectId,
    '全新文件的正文。',
    '全新补充.md',
    null,
    principal as never,
  );
  assert.equal(Number(saved.version), 1);
  assert.equal(saved.category, '未分类');
  assert.equal(saved.evidenceStatus, '已知事实');
});

test('预览后目标文件被更新时拒绝保存旧预览', async () => {
  const base = await upload(projectId, '并发文件.md', '第一版。');
  const gapId = await createGap(projectId, '并发更新');
  modelReply = { document: '# 合并预览\n\n基于第一版的结果。' };
  const preview = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '这是人工确认过的并发更新补充内容。' }],
    '并发文件.md',
    principal as never,
  );
  assert.equal(preview.baseFileId, base.id);

  await upload(projectId, '并发文件.md', '第二版由其他用户写入。');
  await assert.rejects(
    () => enrich.saveEnrichedKnowledge(
      projectId,
      preview.preview,
      preview.targetFile,
      preview.baseFileId,
      principal as never,
    ),
    /预览后已被更新/,
  );
  assert.equal(knowledge.list(projectId).filter((row) => row.filename === '并发文件.md').length, 2);
});

test('未决占位和问句不能被人工确认成事实', async () => {
  for (const content of ['资料未提及具体标准。', '主材是否达到 E1 级？', '目前未知具体执行时间。']) {
    const gapId = await createGap(projectId, `未决-${content}`);
    await assert.rejects(
      () => enrich.mergeEnrichedKnowledge(
        projectId,
        [{ gapId, status: 'confirmed', content }],
        '未决.md',
        principal as never,
      ),
      /仍包含.*未决表述/,
    );
  }
});

test('明确事实确定性追加时兼容字段 hedgeLossCount 恒为 0', async () => {
  const gapId = await createGap(projectId, '明确环保标准');
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [{ gapId, status: 'confirmed', content: '项目主材环保等级确定执行国家 E1 标准。' }],
    '环保.md',
    principal as never,
  );
  assert.equal(result.hedgeLossCount, 0);
  assert.match(result.preview, /项目主材环保等级确定执行国家 E1 标准/);
});

test('merge 收到重复 gapId 时只追加最后一条', async () => {
  const gapId = await createGap(projectId, '重复合并项');
  capturedPrompts = [];
  const result = await enrich.mergeEnrichedKnowledge(
    projectId,
    [
      { gapId, status: 'confirmed', content: '第一份内容不是最终确认的事实版本。' },
      { gapId, status: 'edited', content: '第二份内容才是人工确认的最终事实版本。' },
    ],
    '重复.md',
    principal as never,
  );
  assert.equal((result.preview.match(/^### 重复合并项$/gmu) || []).length, 1, '标题只能出现一次');
  assert.match(result.preview, /第二份内容才是人工确认的最终事实版本/);
  assert.doesNotMatch(result.preview, /第一份内容不是最终确认的事实版本/);
  assert.equal(capturedPrompts.length, 0);
});

test('merge 同一 gapId 先 confirmed 后 deleted 时按 deleted 处理', async () => {
  const gapId = await createGap(projectId, '先确认后删除');
  await assert.rejects(
    () => enrich.mergeEnrichedKnowledge(
      projectId,
      [
        { gapId, status: 'confirmed', content: '这份要被后面的 deleted 覆盖' },
        { gapId, status: 'deleted' },
      ],
      '覆盖.md',
      principal as never,
    ),
    /至少保留一条/,
    '唯一一条被删掉后应拒绝合并,而不是拿被删的内容去合并',
  );
});
