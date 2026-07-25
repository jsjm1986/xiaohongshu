import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'Recat-bootstrap-123!';
const NEW_PASSWORD = 'Recat-updated-456!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

async function upload(filename: string, category: string) {
  const res = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({ filename, content: `# ${filename}\n\n内容正文。`, category, evidenceStatus: '已知事实' }),
  });
  assert.equal(res.response.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-recat-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201);
  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '改分类项目', domain: '去眼袋' }) });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('PATCH 可以改分类,不需要删除后重传', async () => {
  const file = await upload('a.md', '未分类');
  const res = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '方法论' }),
  });
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.category, '方法论');

  // 落库而非只改返回值。这个列表路由返回裸数组,不是 {items}
  const list = await request(`/api/projects/${projectId}/knowledge`);
  const items = Array.isArray(list.body) ? list.body : list.body.items;
  const found = items.find((f: any) => f.id === file.id);
  assert.equal(found.category, '方法论');
});

test('改分类不动文件内容与版本:只是重新归类,不是新版本', async () => {
  const file = await upload('b.md', '未分类');
  const before = await request(`/api/projects/${projectId}/knowledge/${file.id}`);
  const patched = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '约束' }),
  });
  // 必须断言改成功,否则 404 也能让下面的「内容未变」通过,用例就成了空壳
  assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
  const after2 = await request(`/api/projects/${projectId}/knowledge/${file.id}`);
  assert.equal(after2.body.content, before.body.content);
  assert.equal(after2.body.version, before.body.version);
  assert.equal(after2.body.sha256, before.body.sha256);
});

test('可以改证据类型', async () => {
  const file = await upload('c.md', '未分类');
  const res = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ evidenceStatus: '猜想' }),
  });
  assert.equal(res.response.status, 200);
  assert.equal(res.body.evidenceStatus, '猜想');
});

// 分类不是标签:reference-corpus 会被排除出生成、只用于校准校验器
// (knowledge.service.ts 的 selectKnowledgeContext)。改分类等于改「喂给模型什么」,
// 所以必须让已审批的分析链失效,否则内容地图与实际语料不符还显示「已就绪」。
test('改分类会把已审批的分析链置为 stale', async () => {
  const file = await upload('d.md', '未分类');
  const db = app.get(DatabaseService);
  // 这个项目没跑过分析,库里没有可失效的行——直接造一条 approved 内容地图,
  // 否则断言「改完不再有 approved」在空集上恒真,等于什么也没验。
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO project_intelligence
       (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at)
     VALUES (?, ?, 1, 'approved', 'fp-test', '{}', ?, datetime('now'), datetime('now'))`,
  ).run(randomUUID(), projectId, admin.id);
  const before = db.prepare("SELECT COUNT(*) AS n FROM project_intelligence WHERE project_id=? AND status='approved'").get(projectId) as { n: number };

  const patched = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '案例样本' }),
  });
  assert.equal(patched.response.status, 200, JSON.stringify(patched.body));

  const after2 = db.prepare("SELECT COUNT(*) AS n FROM project_intelligence WHERE project_id=? AND status='approved'").get(projectId) as { n: number };
  // before.n 必须 > 0,否则这条断言什么也没验证
  assert.ok(before.n > 0, '前置:应有一条 approved 分析可供失效');
  assert.equal(after2.n, 0, '改分类后不应还有 approved 的分析');
});

test('空 body 或无可改字段返回 400,不做无声空操作', async () => {
  const file = await upload('e.md', '未分类');
  const res = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  assert.equal(res.response.status, 400);
});

test('跨项目改分类被拒', async () => {
  const other = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '别的项目', domain: '去眼袋' }) });
  const file = await upload('f.md', '未分类');
  const res = await request(`/api/projects/${other.body.id}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '方法论' }),
  });
  assert.equal(res.response.status, 400);
});

test('已删除的文件不能改分类', async () => {
  const file = await upload('g.md', '未分类');
  // 先确认这个文件本来是改得动的,再删,这样 404 才真的来自「已删除」
  const ok = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '方法论' }),
  });
  assert.equal(ok.response.status, 200, JSON.stringify(ok.body));

  await request(`/api/projects/${projectId}/knowledge/${file.id}`, { method: 'DELETE' });
  const res = await request(`/api/projects/${projectId}/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '约束' }),
  });
  assert.ok(res.response.status >= 400, `已删除文件应拒绝,实际 ${res.response.status}`);
});

// 前端用的是扁平路由 /api/knowledge/:fileId(不是项目内嵌那条),两条都得能改,
// 否则界面上点了没反应。
test('扁平路由 /api/knowledge/:fileId 同样可以改分类', async () => {
  const file = await upload('h.md', '未分类');
  const res = await request(`/api/knowledge/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: '项目与服务' }),
  });
  assert.equal(res.response.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.category, '项目与服务');
});
