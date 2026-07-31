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
 * 供应商级故障时清空同项目队列。
 *
 * provider-outage.test.ts 锁的是"哪些错误算 outage"这个纯判断;这里锁真正的行为:
 * 队列里的任务被判失败、跨项目不牵连、单篇级错误不触发。
 *
 * 直接调私有的 failQueuedForOutage 而不是跑真实生成——真实触发需要一个余额耗尽的
 * 模型供应商,不可复现;而这一层的逻辑(选哪些任务、怎么改状态)是可以钉死的。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectA = '';
let projectB = '';

const PASSWORD = 'Outage-bootstrap-123!';
const NEW_PASSWORD = 'Outage-rotated-456!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

function seedQueued(id: string, projectId: string) {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, 'queued', '{"formula":{"versionId":"fv"},"knowledge":{"mode":"auto","selectedFileIds":[]}}',
        's', ?, datetime('now'), datetime('now'), ?, 'g', 'simple', 0, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(id, projectId, admin.id, `选题-${id}`);
}

function statusOf(id: string) {
  const db = app.get(DatabaseService);
  return db.prepare('SELECT status, error, progress FROM generation_jobs WHERE id=?').get(id) as
    { status: string; error: string | null; progress: number };
}

/** 私有方法:测试要验的正是它的行为,公开它只为了摆样子反而更差。 */
function failQueued(projectId: string, reason: string): number {
  const service = app.get(GenerationService) as unknown as {
    failQueuedForOutage: (p: string, r: string) => number;
  };
  return service.failQueuedForOutage(projectId, reason);
}

/**
 * 队列在 DB 里(status='queued'),所以「清空队列」就是「那些行不再是 queued」。
 * 原来这些用例往内存数组里 push id 来造队列——那个数组已经删掉了,它本身就是被
 * 修掉的缺陷:多实例下 failQueuedForOutage 只看得见自己那一段,别的实例上同项目
 * 的排队任务照样会各花 16 分钟去撞同一面墙。
 */
function queuedIds(): string[] {
  return (app.get(DatabaseService)
    .prepare("SELECT id FROM generation_jobs WHERE status='queued' AND deleted_at IS NULL ORDER BY created_at, id")
    .all() as Array<{ id: string }>).map((row) => row.id);
}

function clearJobs(): void {
  app.get(DatabaseService).prepare('DELETE FROM generation_jobs').run();
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-outage-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'outage-test-master-encryption-key', logger: false,
    platformApiKey: '', platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const a = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '项目A', domain: '住宅装修' }) });
  const b = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '项目B', domain: '口腔正畸' }) });
  projectA = a.body.id;
  projectB = b.body.id;
  assert.ok(projectA && projectB, '两个项目都要建出来');
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('余额不足时同项目排队任务全部判失败,并写明原因与出路', () => {
  clearJobs();
  for (const id of ['a1', 'a2', 'a3']) seedQueued(id, projectA);

  const reason = '模型账户余额不足，本项目排队中的任务已停止，充值后可在产出区批量重试';
  assert.equal(failQueued(projectA, reason), 3);

  for (const id of ['a1', 'a2', 'a3']) {
    const row = statusOf(id);
    assert.equal(row.status, 'failed', `${id} 应判失败`);
    assert.equal(row.error, reason);
    // progress 置 100 与既有失败路径一致,前端不会显示成"还在跑"
    assert.equal(Number(row.progress), 100);
  }
  assert.deepEqual(queuedIds(), [], '队列应被清空');
});

test('跨项目不牵连:另一个项目可能用自己的 BYOK 密钥', () => {
  clearJobs();
  seedQueued('x1', projectA);
  seedQueued('y1', projectB);
  seedQueued('x2', projectA);

  assert.equal(failQueued(projectA, '余额不足'), 2);
  assert.equal(statusOf('x1').status, 'failed');
  assert.equal(statusOf('x2').status, 'failed');
  // B 项目的任务既不改状态,也要留在队列里继续跑
  assert.equal(statusOf('y1').status, 'queued');
  assert.deepEqual(queuedIds(), ['y1']);
});

test('队列里没有该项目的任务时返回 0,不误伤别人', () => {
  clearJobs();
  seedQueued('z1', projectB);
  assert.equal(failQueued(projectA, '余额不足'), 0);
  assert.equal(statusOf('z1').status, 'queued');
  assert.deepEqual(queuedIds(), ['z1']);
});

test('队列为空时安全返回 0', () => {
  clearJobs();
  assert.equal(failQueued(projectA, '余额不足'), 0);
});

test('只清排队中的:已在跑的任务不被牵连,它可能马上就出稿了', () => {
  clearJobs();
  seedQueued('run-1', projectA);
  app.get(DatabaseService).prepare("UPDATE generation_jobs SET status='running' WHERE id='run-1'").run();
  seedQueued('wait-1', projectA);

  assert.equal(failQueued(projectA, '余额不足'), 1);
  assert.equal(statusOf('run-1').status, 'running', '在跑的任务由它自己的失败路径处理');
  assert.equal(statusOf('wait-1').status, 'failed');
});

test('软删的任务不被清:它已经不在队列里,再判一次失败只是噪声', () => {
  clearJobs();
  seedQueued('gone', projectA);
  const service = app.get(GenerationService);
  service.softDelete('gone');
  const deletedBeforeOutage = statusOf('gone');
  assert.equal(deletedBeforeOutage.status, 'failed', '软删会立即终止尚未完成的任务');
  assert.match(deletedBeforeOutage.error ?? '', /已删除/u);
  seedQueued('alive', projectA);

  assert.equal(failQueued(projectA, '余额不足'), 1);
  assert.deepEqual(statusOf('gone'), deletedBeforeOutage, 'outage 清理不该覆盖软删任务的终态与原因');
  assert.equal(statusOf('alive').status, 'failed');
});

test('已扣的配额不退:计费在创建时发生,重试走产出区', async () => {
  const db = app.get(DatabaseService);
  const before = db.prepare('SELECT quota_used FROM workspace_settings LIMIT 1').get() as { quota_used: number } | undefined;
  clearJobs();
  seedQueued('q1', projectA);
  failQueued(projectA, '余额不足');
  const afterRow = db.prepare('SELECT quota_used FROM workspace_settings LIMIT 1').get() as { quota_used: number } | undefined;
  assert.equal(afterRow?.quota_used, before?.quota_used, '快失败不该改动配额');
});
