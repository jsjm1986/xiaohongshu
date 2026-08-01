import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/* 三个端点的接线:路由、权限、请求校验、全链路版本递增。模型层仍是 stub。 */

interface Session { cookie: string; csrf: string }

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let admin: Session;
let viewer: Session;
let writerWithoutKnowledgeRead: Session;
let projectId = '';
let workspaceId = '';
let gapId = '';

const PASSWORD = 'EnrichApi-bootstrap-123!';
const NEW_PASSWORD = 'EnrichApi-updated-456!';

let modelReply: Record<string, unknown> = {};

async function call(path: string, options: RequestInit = {}, session?: Session) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('cookie', session.cookie);
    if (!['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', session.csrf);
  }
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

async function login(username: string, password: string): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 201, `${username} 登录失败`);
  const body = (await response.json()) as { csrfToken: string };
  return { cookie: response.headers.get('set-cookie')!.split(';', 1)[0]!, csrf: body.csrfToken };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-enrich-api-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  admin = await login('admin', PASSWORD);
  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  }, admin);
  assert.equal(changed.status, 201, JSON.stringify(changed.body));

  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '端点项目', domain: '法律咨询' }),
  }, admin);
  assert.equal(project.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;
  workspaceId = project.body.workspaceId;

  const gap = await call(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({
      title: '收费方式',
      question: '按件还是按时计费?',
      sourceStatus: 'unknown',
      knowledgeAction: 'organize_existing',
    }),
  }, admin);
  assert.equal(gap.status, 201, JSON.stringify(gap.body));
  gapId = gap.body.id;

  const upload = await call(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({
      filename: 'INDEX.md',
      content: '# 事务所资料\n\n## 收费方式\n\n以协商为准。',
      category: '未分类',
      evidenceStatus: '已知事实',
    }),
  }, admin);
  assert.equal(upload.status, 201, JSON.stringify(upload.body));

  // 只读账号:用于验权限门。Viewer 既没有 project.write 也没有 knowledge.import。
  const db = app.get(DatabaseService);
  const created = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'enrich-viewer', password: 'Viewer-pass-123!', systemRole: 'user' }),
  }, admin);
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get('enrich-viewer') as { id: string };
  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)'
    + " VALUES (?, ?, 'Viewer', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceId, row.id);
  // 清掉首登改密门,否则测出来的 403 不是越权判定的功劳
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(row.id);
  viewer = await login('enrich-viewer', 'Viewer-pass-123!');

  const writer = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'enrich-writer', password: 'Writer-pass-123!', systemRole: 'user' }),
  }, admin);
  assert.ok([200, 201].includes(writer.status), JSON.stringify(writer.body));
  const writerRow = db.prepare('SELECT id FROM users WHERE username = ?').get('enrich-writer') as { id: string };
  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)'
    + " VALUES (?, ?, 'Admin', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceId, writerRow.id);
  db.prepare(
    "INSERT INTO project_acl (project_id, user_id, grants_json, denies_json, updated_at) VALUES (?, ?, '[]', '[\"knowledge.read\"]', datetime('now'))",
  ).run(projectId, writerRow.id);
  db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(writerRow.id);
  writerWithoutKnowledgeRead = await login('enrich-writer', 'Writer-pass-123!');

  const intelligence = app.get(IntelligenceService);
  (intelligence as unknown as Record<string, unknown>).runEnrichmentModel = async () => modelReply;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('draft → merge → save 全链路,版本递增且旧版本保留', async () => {
  modelReply = {
    items: [{
      gapId,
      content: '## 收费方式\n\n收费方式由双方在委托合同中书面约定。',
      confidence: 'medium',
    }],
  };
  const draft = await call(`/api/projects/${projectId}/intelligence/enrich/draft`, { method: 'POST' }, admin);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.gaps.length, 1);
  assert.equal(draft.body.gaps[0].gapId, gapId);
  assert.ok(['low', 'medium', 'high'].includes(draft.body.gaps[0].confidence));

  const merge = await call(`/api/projects/${projectId}/intelligence/enrich/merge`, {
    method: 'POST',
    body: JSON.stringify({
      items: draft.body.gaps.map((gap: any) => ({ gapId: gap.gapId, status: 'confirmed', content: gap.aiDraft })),
    }),
  }, admin);
  assert.equal(merge.status, 201, JSON.stringify(merge.body));
  assert.equal(merge.body.targetFile, 'INDEX.md');
  assert.equal(merge.body.isNewFile, false);

  const save = await call(`/api/projects/${projectId}/intelligence/enrich/save`, {
    method: 'POST',
    body: JSON.stringify({
      content: merge.body.preview,
      targetFile: merge.body.targetFile,
      baseFileId: merge.body.baseFileId,
    }),
  }, admin);
  assert.equal(save.status, 201, JSON.stringify(save.body));
  assert.equal(Number(save.body.version), 2);

  const list = await call(`/api/projects/${projectId}/knowledge`, {}, admin);
  const versions = (Array.isArray(list.body) ? list.body : list.body.items)
    .filter((file: any) => file.filename === 'INDEX.md')
    .map((file: any) => Number(file.version))
    .sort();
  assert.deepEqual(versions, [1, 2], '旧版本必须留着,用户要能对比');

  // 补全保存不是终点：后续生成必须自动读取同名最新版，并拿到完整原文和确认事实。
  const generation = app.get(GenerationService) as unknown as {
    loadKnowledge(projectId: string): Promise<Array<{ id: string; version: string; content: string }>>;
  };
  const generationKnowledge = await generation.loadKnowledge(projectId);
  const indexDocuments = generationKnowledge.filter((document) => document.content.includes('# 事务所资料'));
  assert.equal(indexDocuments.length, 1, '生成上下文只能包含 INDEX.md 的最新版');
  assert.equal(indexDocuments[0]!.id, save.body.id);
  assert.equal(indexDocuments[0]!.version, '2');
  assert.match(indexDocuments[0]!.content, /以协商为准/u, '原始知识不能在补全后丢失');
  assert.match(indexDocuments[0]!.content, /收费方式由双方在委托合同中书面约定/u, '人工确认事实必须进入生成上下文');
});

test('merge 拒绝路径穿越的 targetFile', async () => {
  for (const targetFile of ['../../../etc/passwd', 'sub/dir.md', 'evil.sh']) {
    const res = await call(`/api/projects/${projectId}/intelligence/enrich/merge`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ gapId, status: 'confirmed', content: '内容' }], targetFile }),
    }, admin);
    assert.equal(res.status, 400, `${targetFile} 应被拒:${JSON.stringify(res.body)}`);
  }
});

test('save 拒绝路径穿越,且不会写出新版本', async () => {
  const before = await call(`/api/projects/${projectId}/knowledge`, {}, admin);
  const countBefore = (Array.isArray(before.body) ? before.body : before.body.items).length;

  const res = await call(`/api/projects/${projectId}/intelligence/enrich/save`, {
    method: 'POST',
    body: JSON.stringify({ content: '恶意内容', targetFile: '../../../tmp/evil.md' }),
  }, admin);
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const after = await call(`/api/projects/${projectId}/knowledge`, {}, admin);
  const countAfter = (Array.isArray(after.body) ? after.body : after.body.items).length;
  assert.equal(countAfter, countBefore, '被拒的请求不该留下任何文件');
});

test('save 拒绝空正文——这条只有入口校验能挡住', async () => {
  // knowledge.service 的 validateFilename 是路径穿越的第二道防线,所以「拒绝 ../」
  // 那条测试在入口校验被摘掉时依然会绿。空正文不同:import 不校验内容非空,
  // 少了 parseSaveRequest 就会静默存出一个空文件。用它锚定入口校验确实接上了。
  const before = await call(`/api/projects/${projectId}/knowledge`, {}, admin);
  const countBefore = (Array.isArray(before.body) ? before.body : before.body.items).length;

  for (const content of ['', '   ']) {
    const res = await call(`/api/projects/${projectId}/intelligence/enrich/save`, {
      method: 'POST',
      body: JSON.stringify({ content, targetFile: '空文件.md' }),
    }, admin);
    assert.equal(res.status, 400, `空正文应被拒:${JSON.stringify(res.body)}`);
  }

  const after = await call(`/api/projects/${projectId}/knowledge`, {}, admin);
  assert.equal(
    (Array.isArray(after.body) ? after.body : after.body.items).length,
    countBefore,
    '不该留下空文件',
  );
});

test('merge 拒绝空 items', async () => {
  const res = await call(`/api/projects/${projectId}/intelligence/enrich/merge`, {
    method: 'POST',
    body: JSON.stringify({ items: [] }),
  }, admin);
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('未登录一律 401', async () => {
  for (const path of ['draft', 'merge', 'save']) {
    const res = await call(`/api/projects/${projectId}/intelligence/enrich/${path}`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ gapId, status: 'confirmed', content: 'x' }], content: 'x', targetFile: 'a.md' }),
    });
    assert.equal(res.status, 401, `${path} 未登录应 401:${JSON.stringify(res.body)}`);
  }
});

test('只读账号三个端点全部 403', async () => {
  const cases: Array<[string, unknown]> = [
    ['draft', {}],
    ['merge', { items: [{ gapId, status: 'confirmed', content: 'x' }] }],
    ['save', { content: 'x', targetFile: 'a.md' }],
  ];
  for (const [path, body] of cases) {
    const res = await call(`/api/projects/${projectId}/intelligence/enrich/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, viewer);
    assert.equal(res.status, 403, `${path} 只读账号应 403:${JSON.stringify(res.body)}`);
  }
});

test('有 project.write 但被拒绝 knowledge.read 时不能借补全读取正文', async () => {
  for (const [path, body] of [
    ['draft', {}],
    ['merge', { items: [{ gapId, status: 'confirmed', content: 'x' }] }],
  ] as const) {
    const res = await call(`/api/projects/${projectId}/intelligence/enrich/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, writerWithoutKnowledgeRead);
    assert.equal(res.status, 403, `${path} 应被 knowledge.read 门禁拒绝:${JSON.stringify(res.body)}`);
    assert.match(String(res.body.message), /knowledge\.read/);
  }
});

test('save 判的是 knowledge.import,与知识库上传同一把锁', async () => {
  // 回归防护:如果有人把 save 的权限改成 project.write,能上传知识库但没有
  // project.write 的角色就会被误拒;反之改松了则出现绕过 knowledge.import 的通路。
  // 这里直接断言两条路由声明的权限一致。
  const { IntelligenceController } = await import('../src/intelligence.controller.js');
  const { REQUIRE_PERMISSION } = await import('../src/guards.js');
  const saveMeta = Reflect.getMetadata(
    REQUIRE_PERMISSION,
    (IntelligenceController.prototype as Record<string, never>).enrichSave,
  ) as { permission: string } | undefined;
  assert.equal(saveMeta?.permission, 'knowledge.import');
});

test('save 的 content 超过 2 MiB 被拒', async () => {
  const res = await call(`/api/projects/${projectId}/intelligence/enrich/save`, {
    method: 'POST',
    body: JSON.stringify({ content: '中'.repeat(700_000), targetFile: 'big.md', baseFileId: null }),
  }, admin);
  assert.ok(res.status === 400 || res.status === 413, `应是 4xx,实际 ${res.status}`);
});
