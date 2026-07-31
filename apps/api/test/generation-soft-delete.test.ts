import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { SettingsService } from '../src/settings.service.js';

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
  const idsBefore = before.body.items.map((j: any) => j.id);
  assert.ok(idsBefore.includes('d-gone'));

  const del = await request('/api/generations/d-gone', { method: 'DELETE' });
  assert.equal(del.response.status, 200);
  assert.equal(del.body.alreadyDeleted, false);

  const after = await request(`/api/generations?projectId=${projectId}`);
  const idsAfter = after.body.items.map((j: any) => j.id);
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
  const ids = list.body.items.map((j: any) => j.id);
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

/**
 * 队列在 DB 里(status='queued' AND deleted_at IS NULL),所以「不会白跑一次」现在
 * 由领取查询本身保证,不需要额外摘队列。断言从「内存数组里没有它」改成「它不再
 * 算在排队里、也领不到」——测的是同一个用户可见要求,而且比原来更强:多实例下
 * 别的实例照样领不到它。
 */
test('删除排队中的任务后它不再排队,也不会被领取去跑', async () => {
  const service = app.get(GenerationService);
  seedJob('d-queued', 'queued');
  assert.equal(service.queuePosition('d-queued'), 1, '删除前它确实在排队');

  await request('/api/generations/d-queued', { method: 'DELETE' });

  assert.equal(service.queuePosition('d-queued'), undefined, '已删任务不该还有排队位次');
  const row = app.get(DatabaseService)
    .prepare(
      `SELECT status, progress, error, completed_at, claimed_by, claimed_at, heartbeat_at
         FROM generation_jobs WHERE id=?`,
    )
    .get('d-queued') as Record<string, unknown>;
  assert.equal(row.status, 'failed', '删除必须把排队任务结为终态,不能留下隐藏的 queued');
  assert.equal(row.progress, 100);
  assert.match(String(row.error), /生成任务已删除/u);
  assert.ok(row.completed_at);
  assert.equal(row.claimed_by, null);
  assert.equal(row.claimed_at, null);
  assert.equal(row.heartbeat_at, null);
});

// 撤销只恢复可见性:删除时旧任务已经结为 failed,不会重新进入 DB 队列。
test('恢复排队任务不会自动开跑:用户删它往往正是为了让它别跑', async () => {
  const db = app.get(DatabaseService);
  await request('/api/generations/d-queued/restore', { method: 'POST' });

  // 恢复后保持失败终态,真正重试必须显式创建一条新任务。
  const row = db.prepare('SELECT status, claimed_by FROM generation_jobs WHERE id=?')
    .get('d-queued') as { status: string; claimed_by: string | null };
  assert.equal(row.status, 'failed');
  assert.equal(row.claimed_by, null, '恢复不该顺带领取开跑');
});

test('删除运行中的生成任务会清租约并拒绝旧执行者迟到产物', async () => {
  const db = app.get(DatabaseService);
  seedJob('d-running', 'running');
  const heartbeat = new Date().toISOString();
  db.prepare(
    `UPDATE generation_jobs
        SET progress=45, claimed_by='old-generation-worker', claimed_at=?, heartbeat_at=?
      WHERE id='d-running'`,
  ).run(heartbeat, heartbeat);

  const removed = await request('/api/generations/d-running', { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  const row = db.prepare(
    `SELECT status, progress, error, completed_at, claimed_by, claimed_at, heartbeat_at
       FROM generation_jobs WHERE id='d-running'`,
  ).get() as Record<string, unknown>;
  assert.equal(row.status, 'failed');
  assert.equal(row.progress, 100);
  assert.match(String(row.error), /生成任务已删除/u);
  assert.ok(row.completed_at);
  assert.equal(row.claimed_by, null);
  assert.equal(row.claimed_at, null);
  assert.equal(row.heartbeat_at, null);

  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO content_packages
         (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
       VALUES ('stale-generation-package', 'd-running', ?, 0, '{}', ?, ?)`,
    ).run(projectId, heartbeat, heartbeat);
    const completed = db.prepare(
      `UPDATE generation_jobs SET status='completed'
        WHERE id='d-running' AND status='running' AND claimed_by='old-generation-worker'`,
    ).run();
    if (completed.changes !== 1) throw new Error('generation claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS value FROM content_packages WHERE id='stale-generation-package'")
      .get() as { value: number }).value,
    0,
  );
});

test('删除有活跃改稿的产出会退款一次、终止改稿并拒绝旧执行者迟到产物', async () => {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const project = db.prepare('SELECT workspace_id FROM projects WHERE id=?').get(projectId) as { workspace_id: string };
  app.get(SettingsService).ensure(project.workspace_id, admin.id);
  db.prepare('UPDATE workspace_settings SET monthly_quota=100, quota_used=7 WHERE workspace_id=?')
    .run(project.workspace_id);
  seedJob('d-revision-parent', 'completed');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES ('d-revision-active', 'd-revision-parent', 'old-package', 'candidate', '删除边界',
             'running', 55, 1, ?, ?, ?, 'old-revision-worker', ?, 2)`,
  ).run(admin.id, now, now, now);

  const removed = await request('/api/generations/d-revision-parent', { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  const quota = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?')
    .get(project.workspace_id) as { quota_used: number };
  assert.equal(quota.quota_used, 5, '两次未交付的改稿扣款都应退还');
  const revision = db.prepare(
    `SELECT status, progress, error, completed_at, claimed_by, heartbeat_at, quota_consumed_count
       FROM revision_tasks WHERE id='d-revision-active'`,
  ).get() as Record<string, unknown>;
  assert.equal(revision.status, 'failed');
  assert.equal(revision.progress, 100);
  assert.match(String(revision.error), /生成任务已删除/u);
  assert.ok(revision.completed_at);
  assert.equal(revision.claimed_by, null);
  assert.equal(revision.heartbeat_at, null);
  assert.equal(revision.quota_consumed_count, 0);

  const repeated = await request('/api/generations/d-revision-parent', { method: 'DELETE' });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.alreadyDeleted, true);
  assert.equal(
    (db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?')
      .get(project.workspace_id) as { quota_used: number }).quota_used,
    5,
    '幂等删除不能重复退款',
  );

  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO content_packages
         (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
       VALUES ('stale-revision-package', 'd-revision-parent', ?, 0, '{}', ?, ?)`,
    ).run(projectId, now, now);
    const completed = db.prepare(
      `UPDATE revision_tasks SET status='completed', result_package_id='stale-revision-package'
        WHERE id='d-revision-active' AND status='running' AND claimed_by='old-revision-worker'`,
    ).run();
    if (completed.changes !== 1) throw new Error('revision claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS value FROM content_packages WHERE id='stale-revision-package'")
      .get() as { value: number }).value,
    0,
  );
});

test('删除不存在的任务返回 404', async () => {
  const res = await request('/api/generations/nope-does-not-exist', { method: 'DELETE' });
  assert.equal(res.response.status, 404);
});
