import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/**
 * 额度结算的统一原则:交付了产出留 1,零产出留 0。
 *
 * 这组测试钉住三条曾经漏账的路径:
 * 1. 删除项目/软删任务:排队与在跑的生成任务从未交付,入队扣款必须退还;
 *    harness 沿用它自己的可退语义(provider 已启动不退)且必须被终止。
 * 2. 断供清队:排队任务从未执行,清掉时退款。
 * 3. 分析任务心跳失速:周期回收(而非只有重启)把它判失败并退款。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let adminId = '';

async function call(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* assertions preserve text */ }
  return { response, body };
}

const post = (path: string, body: Record<string, unknown> = {}) => call(path, {
  method: 'POST',
  body: JSON.stringify(body),
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-quota-settle-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'quota-settlement-test-master-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await post('/api/auth/login', { username: 'admin', password: 'Admin-bootstrap-123!' });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await post('/api/auth/change-password', {
    currentPassword: 'Admin-bootstrap-123!',
    newPassword: 'Admin-updated-456!',
  });
  assert.equal(changed.response.status, 201);
  const database = app.get(DatabaseService);
  adminId = String((database.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface Seeded { projectId: string; workspaceId: string }

async function seedProject(name: string): Promise<Seeded> {
  const project = await post('/api/projects', { name, domain: '眼袋' });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  const database = app.get(DatabaseService);
  const row = database.prepare('SELECT workspace_id FROM projects WHERE id=?').get(project.body.id) as { workspace_id: string };
  const workspaceId = String(row.workspace_id);
  // settings 行平时由 ensure() 惰性创建;退款路径要求它必须存在,直接种好。
  database.prepare(
    `INSERT INTO workspace_settings (workspace_id, quota_used, updated_at) VALUES (?, 0, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET quota_used=0`,
  ).run(workspaceId, new Date().toISOString());
  return { projectId: project.body.id, workspaceId };
}

function quotaUsed(workspaceId: string): number {
  const database = app.get(DatabaseService);
  const row = database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { quota_used: number };
  return Number(row.quota_used);
}

function setQuotaUsed(workspaceId: string, value: number): void {
  app.get(DatabaseService).prepare('UPDATE workspace_settings SET quota_used=? WHERE workspace_id=?').run(value, workspaceId);
}

function seedGenerationJob(projectId: string, status: string, quota = 1): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  app.get(DatabaseService).prepare(
    `INSERT INTO generation_jobs (id, project_id, status, config_json, seed, created_by, created_at, updated_at, quota_consumed_count)
     VALUES (?, ?, ?, '{}', '1', ?, ?, ?, ?)`,
  ).run(id, projectId, status, adminId, now, now, quota);
  return id;
}

function seedHarnessJob(projectId: string, status: string, providerStarted: boolean, quota = 1): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  app.get(DatabaseService).prepare(
    `INSERT INTO agent_harness_jobs
       (id, project_id, status, topic, created_by, created_at, updated_at, quota_consumed_count, provider_started_at)
     VALUES (?, ?, ?, '话术复核', ?, ?, ?, ?, ?)`,
  ).run(id, projectId, status, adminId, now, now, quota, providerStarted ? now : null);
  return id;
}

test('删除项目结清全部挂账：生成任务退款，harness 终止并按其可退语义退款', async () => {
  const { projectId, workspaceId } = await seedProject('删除项目结算');
  const database = app.get(DatabaseService);
  const queuedGeneration = seedGenerationJob(projectId, 'queued');
  const completedGeneration = seedGenerationJob(projectId, 'completed');
  const pendingHarness = seedHarnessJob(projectId, 'queued', false);
  const startedHarness = seedHarnessJob(projectId, 'running', true);
  setQuotaUsed(workspaceId, 10);

  const removed = await call(`/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));

  // 排队生成任务(1) + provider 未启动的 harness(1) 退款;已完成的生成任务与
  // provider 已启动的 harness 不退。
  assert.equal(quotaUsed(workspaceId), 8);

  const generationRow = database.prepare('SELECT status, quota_consumed_count FROM generation_jobs WHERE id=?')
    .get(queuedGeneration) as { status: string; quota_consumed_count: number };
  assert.equal(generationRow.status, 'failed');
  assert.equal(generationRow.quota_consumed_count, 0);
  const keptGeneration = database.prepare('SELECT status FROM generation_jobs WHERE id=?')
    .get(completedGeneration) as { status: string };
  assert.equal(keptGeneration.status, 'completed', '已完成任务不被删除流程改写');

  for (const id of [pendingHarness, startedHarness]) {
    const harnessRow = database.prepare(
      'SELECT status, failure_stage, quota_consumed_count, claimed_by FROM agent_harness_jobs WHERE id=?',
    ).get(id) as { status: string; failure_stage: string; quota_consumed_count: number; claimed_by: string | null };
    assert.equal(harnessRow.status, 'failed', 'harness 任务必须被终止,不能留成孤儿');
    assert.equal(harnessRow.failure_stage, 'cancelled');
    assert.equal(harnessRow.quota_consumed_count, 0);
    assert.equal(harnessRow.claimed_by, null);
  }
});

test('软删排队中的生成任务退还入队扣款；已完成任务的账不动', async () => {
  const { projectId, workspaceId } = await seedProject('软删结算');
  const queued = seedGenerationJob(projectId, 'queued');
  const completed = seedGenerationJob(projectId, 'completed');
  setQuotaUsed(workspaceId, 5);

  const removedQueued = await call(`/api/generations/${queued}`, { method: 'DELETE' });
  assert.equal(removedQueued.response.status, 200, JSON.stringify(removedQueued.body));
  assert.equal(quotaUsed(workspaceId), 4, '排队任务零产出,入队扣款必须退');

  const removedCompleted = await call(`/api/generations/${completed}`, { method: 'DELETE' });
  assert.equal(removedCompleted.response.status, 200, JSON.stringify(removedCompleted.body));
  assert.equal(quotaUsed(workspaceId), 4, '已完成任务交付过产出,删除不退款');
});

test('断供清队退还从未执行任务的扣款', async () => {
  const { projectId, workspaceId } = await seedProject('断供清队结算');
  const database = app.get(DatabaseService);
  const first = seedGenerationJob(projectId, 'queued');
  const second = seedGenerationJob(projectId, 'queued');
  setQuotaUsed(workspaceId, 5);

  const generation = app.get(GenerationService) as unknown as {
    failQueuedForOutage(projectId: string, reason: string): number;
  };
  const cleared = generation.failQueuedForOutage(projectId, '平台额度已用完');
  assert.equal(cleared, 2);
  assert.equal(quotaUsed(workspaceId), 3, '被清掉的任务从未执行,扣款全退');
  for (const id of [first, second]) {
    const row = database.prepare('SELECT status, quota_consumed_count FROM generation_jobs WHERE id=?')
      .get(id) as { status: string; quota_consumed_count: number };
    assert.equal(row.status, 'failed');
    assert.equal(row.quota_consumed_count, 0);
  }
});

test('回收判死的生成任务退还入队扣款', async () => {
  const { projectId, workspaceId } = await seedProject('回收判死结算');
  const database = app.get(DatabaseService);
  const id = randomUUID();
  const now = new Date().toISOString();
  const staleHeartbeat = new Date(Date.now() - 86_400_000).toISOString();
  // 已被打断 3 次(上限)且心跳停更的 running 任务:下一轮回收判 failed。
  database.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        quota_consumed_count, claimed_by, heartbeat_at, resolution_snapshot_json)
     VALUES (?, ?, 'running', '{}', '1', ?, ?, ?, 1, 'dead-instance', ?, ?)`,
  ).run(id, projectId, adminId, now, now, staleHeartbeat, JSON.stringify({ restartInterruptions: 3 }));
  setQuotaUsed(workspaceId, 5);

  const generation = app.get(GenerationService) as unknown as { reclaimAndDrain(): void };
  generation.reclaimAndDrain();

  const row = database.prepare('SELECT status, quota_consumed_count, error FROM generation_jobs WHERE id=?')
    .get(id) as { status: string; quota_consumed_count: number; error: string };
  assert.equal(row.status, 'failed');
  assert.equal(row.quota_consumed_count, 0);
  assert.match(row.error, /反复打断/);
  assert.equal(quotaUsed(workspaceId), 4, '回收判死 = 零产出,入队扣款退还');
  const event = database.prepare(
    "SELECT details_json FROM generation_events WHERE job_id=? AND event='failed' ORDER BY id DESC LIMIT 1",
  ).get(id) as { details_json: string };
  assert.equal(JSON.parse(event.details_json).refundedQuota, 1, 'failed 事件要如实记录退款额');
});

test('分析任务心跳失速由周期回收清理并退款，不再依赖重启', async () => {
  const { projectId, workspaceId } = await seedProject('分析回收');
  const database = app.get(DatabaseService);
  const staleId = randomUUID();
  const staleHeartbeat = new Date(Date.now() - 86_400_000).toISOString();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, status, source_fingerprint, created_by, created_at, updated_at,
        claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, 'project', 'running', 'fp-stale', ?, ?, ?, 'dead-instance', ?, 1)`,
  ).run(staleId, projectId, adminId, now, now, staleHeartbeat);
  // 心跳新鲜的任务代表还有活着的实例在跑,回收不得误杀。
  const freshId = randomUUID();
  database.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, status, source_fingerprint, created_by, created_at, updated_at,
        claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, 'project', 'running', 'fp-fresh', ?, ?, ?, 'alive-instance', ?, 1)`,
  ).run(freshId, projectId, adminId, now, now, new Date().toISOString());
  setQuotaUsed(workspaceId, 5);

  const intelligence = app.get(IntelligenceService) as unknown as {
    reclaimStaleAnalysisTasks(message: string): void;
    reclaimTimer?: NodeJS.Timeout;
  };
  assert.ok(intelligence.reclaimTimer, '启动后必须挂上周期回收定时器,不能只靠重启清理');
  intelligence.reclaimStaleAnalysisTasks('The analysis instance stopped heartbeating; the task was reclaimed. Retry is safe.');

  const staleRow = database.prepare('SELECT status, quota_consumed_count, error FROM analysis_tasks WHERE id=?')
    .get(staleId) as { status: string; quota_consumed_count: number; error: string };
  assert.equal(staleRow.status, 'failed');
  assert.equal(staleRow.quota_consumed_count, 0);
  assert.match(staleRow.error, /reclaimed/);
  assert.equal(quotaUsed(workspaceId), 4, '失速任务的扣款退还');

  const freshRow = database.prepare('SELECT status FROM analysis_tasks WHERE id=?')
    .get(freshId) as { status: string };
  assert.equal(freshRow.status, 'running', '心跳新鲜的任务不能被误杀');
});
