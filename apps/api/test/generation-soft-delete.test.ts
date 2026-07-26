import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';

/**
 * 产出的软删除与撤销。
 *
 * 起因是实测缺口:极简创作的产出区没有任何删除入口,单个项目跑到 33 条之后列表
 * 只增不减——失败的、试错的、重复的全堆在一起,用户无法整理自己的工作区。
 *
 * 这些用例锁住语义:
 *  - 软删只把行从**列表**里摘掉,单条详情仍读得到(旧链接不至于 404)
 *  - 内容包与生成事件不受影响(审计痕迹要留)
 *  - 可撤销,且撤销不会把任务重新丢进队列(删排队任务往往正是为了让它别跑)
 *  - 幂等:重复删/重复恢复不报错
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'Softdel-bootstrap-123!';
const NEW_PASSWORD = 'Softdel-updated-456!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

function seedJob(id: string, status: string) {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, ?, '{"formula":{"versionId":"fv"},"knowledge":{"mode":"full","selectedFileIds":[]}}',
        's', ?, datetime('now'), datetime('now'), ?, 'g', 'simple', 0, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(id, projectId, status, admin.id, `选题-${id}`);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-softdel-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '软删项目', domain: '去眼袋' }) });
  projectId = project.body.id;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('DELETE 把任务从列表里摘掉,其余任务不受影响', async () => {
  seedJob('d-keep', 'completed');
  seedJob('d-gone', 'completed');

  const before = await request(`/api/generations?projectId=${projectId}`);
  const idsBefore = (before.body.items ?? before.body).map((j: any) => j.id);
  assert.ok(idsBefore.includes('d-gone'));

  const del = await request('/api/generations/d-gone', { method: 'DELETE' });
  assert.equal(del.response.status, 200);
  assert.equal(del.body.alreadyDeleted, false);

  const after = await request(`/api/generations?projectId=${projectId}`);
  const idsAfter = (after.body.items ?? after.body).map((j: any) => j.id);
  assert.ok(!idsAfter.includes('d-gone'), '已删的不该出现在列表里');
  assert.ok(idsAfter.includes('d-keep'), '别的任务不受影响');
});

// 删除后地址可能还在收藏里;让它继续读得到比 404 更少惊吓——列表里看不见就够了
test('软删后单条详情与阅读投影仍可读', async () => {
  const detail = await request('/api/generations/d-gone');
  assert.equal(detail.response.status, 200);
  const reader = await request('/api/generations/d-gone/reader');
  assert.equal(reader.response.status, 200);
});

test('软删不动数据库记录本身:行还在,只是有了 deleted_at', () => {
  const db = app.get(DatabaseService);
  const row = db.prepare('SELECT id, deleted_at FROM generation_jobs WHERE id=?').get('d-gone') as { id: string; deleted_at: string | null };
  assert.equal(row.id, 'd-gone');
  assert.ok(row.deleted_at, 'deleted_at 应有时间戳');
});

test('删除动作写进生成事件,审计留痕', () => {
  const db = app.get(DatabaseService);
  const events = db.prepare('SELECT event FROM generation_events WHERE job_id=?').all('d-gone') as Array<{ event: string }>;
  assert.ok(events.some((e) => e.event === 'deleted'));
});

test('restore 撤销删除,任务回到列表', async () => {
  const res = await request('/api/generations/d-gone/restore', { method: 'POST' });
  assert.equal(res.response.status, 201);
  assert.equal(res.body.alreadyActive, false);

  const list = await request(`/api/generations?projectId=${projectId}`);
  const ids = (list.body.items ?? list.body).map((j: any) => j.id);
  assert.ok(ids.includes('d-gone'), '恢复后应回到列表');
});

// 幂等:用户手快点两次、或撤销后又点一次撤销,都不该报错
test('重复删除与重复恢复都是幂等的', async () => {
  await request('/api/generations/d-gone', { method: 'DELETE' });
  const twice = await request('/api/generations/d-gone', { method: 'DELETE' });
  assert.equal(twice.response.status, 200);
  assert.equal(twice.body.alreadyDeleted, true);

  await request('/api/generations/d-gone/restore', { method: 'POST' });
  const restoreTwice = await request('/api/generations/d-gone/restore', { method: 'POST' });
  assert.equal(restoreTwice.body.alreadyActive, true);
});

test('删除排队中的任务会把它摘出内存队列,避免白跑一次', async () => {
  const service = app.get(GenerationService);
  seedJob('d-queued', 'queued');
  const queue = (service as unknown as { queue: string[] }).queue;
  queue.length = 0;
  queue.push('d-queued');

  await request('/api/generations/d-queued', { method: 'DELETE' });
  assert.ok(!queue.includes('d-queued'), '已删任务不该留在队列里');
});

// 撤销一个排队任务不重新入队:用户删它往往正是为了让它别跑(省额度、改主意)
test('恢复排队任务不会把它重新丢进队列', async () => {
  const service = app.get(GenerationService);
  const queue = (service as unknown as { queue: string[] }).queue;
  queue.length = 0;

  await request('/api/generations/d-queued/restore', { method: 'POST' });
  assert.deepEqual(queue, [], '恢复不该自动开跑');
});

test('删除不存在的任务返回 404', async () => {
  const res = await request('/api/generations/nope-does-not-exist', { method: 'DELETE' });
  assert.equal(res.response.status, 404);
});
