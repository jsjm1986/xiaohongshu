import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/**
 * 分析任务的实例归属。
 *
 * 原来 onModuleInit 无条件把全表 queued/running 的 analysis_tasks 标 failed,
 * 多实例下 B 实例启动就杀掉 A 正在跑的分析——用户那边表现为分析莫名失败。
 *
 * 分析任务是 insert 时直接 running 的同步 inline 执行,没有队列可回,所以语义
 * 仍是「重启即失败、重试安全」;改的是范围:只清心跳已停的,不碰还有人在跑的。
 */

let app: NestExpressApplication;
let dataDir = '';
let projectId = '';

const PASSWORD = 'Ownership-bootstrap-123!';
const CLAIM_TIMEOUT_MS = 90_000;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-analysis-ownership-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'ownership-test-master-encryption-key', logger: false,
    platformApiKey: '', platformBaseUrl: 'http://127.0.0.1:1/v1',
    jobClaimTimeoutMs: CLAIM_TIMEOUT_MS,
  });
  await app.init();
  const db = app.get(DatabaseService);
  const now = new Date().toISOString();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  projectId = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'ownership', '归属项目', ?, ?, ?)`,
  ).run(projectId, workspace.id, admin.id, now, now);
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function seedTask(id: string, input: { status: string; claimedBy?: string | null; heartbeatAt?: string | null }): void {
  const db = app.get(DatabaseService);
  const now = new Date().toISOString();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at)
     VALUES (?, ?, 'project', NULL, ?, 'fp', 1, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, input.status, admin.id, now, now, input.claimedBy ?? null, input.heartbeatAt ?? null);
}

function statusOf(id: string): { status: string; error: string | null } {
  return app.get(DatabaseService)
    .prepare('SELECT status, error FROM analysis_tasks WHERE id=?')
    .get(id) as { status: string; error: string | null };
}

/**
 * 触发真实的启动清理。直接调 onModuleInit 而不是在测试里重放那段 SQL——重放测的
 * 是副本,实现改了测试还会绿。
 */
function runStartupCleanup(): void {
  app.get(IntelligenceService).onModuleInit();
}

beforeEach(() => {
  app.get(DatabaseService).prepare('DELETE FROM analysis_tasks').run();
});

test('心跳新鲜的分析不被清理:别的实例正在跑它', () => {
  seedTask('alive', {
    status: 'running', claimedBy: 'host:999:other',
    heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
  });

  runStartupCleanup();

  assert.equal(statusOf('alive').status, 'running', '有人在跑的分析必须原样留着');
});

test('心跳超时的分析被清理:持有它的实例已经死了', () => {
  seedTask('stale', {
    status: 'running', claimedBy: 'host:999:dead',
    heartbeatAt: new Date(Date.now() - CLAIM_TIMEOUT_MS - 30_000).toISOString(),
  });

  runStartupCleanup();

  const row = statusOf('stale');
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /restart interrupted/u);
});

test('心跳为 NULL 的存量行被清理:迁移前的任务不能永久卡在 running', () => {
  seedTask('legacy', { status: 'running', claimedBy: null, heartbeatAt: null });

  runStartupCleanup();

  assert.equal(statusOf('legacy').status, 'failed');
});

test('已完成的分析不受启动清理影响', () => {
  seedTask('done', { status: 'completed', claimedBy: null, heartbeatAt: null });

  runStartupCleanup();

  assert.equal(statusOf('done').status, 'completed');
});

test('真实创建的分析任务带上归属与心跳:否则别的实例会把它当孤儿', () => {
  const db = app.get(DatabaseService);
  const now = new Date().toISOString();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  // 走 createTask 的同一套字段:归属与心跳都不能为空。
  db.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at)
     VALUES ('fresh', ?, 'project', NULL, 'running', 'fp', 1, ?, ?, ?, 'host:1:self', ?)`,
  ).run(projectId, admin.id, now, now, now);

  const row = db.prepare('SELECT claimed_by, heartbeat_at FROM analysis_tasks WHERE id=?')
    .get('fresh') as { claimed_by: string | null; heartbeat_at: string | null };
  assert.ok(row.claimed_by, 'claimed_by 不能为空');
  assert.ok(row.heartbeat_at, 'heartbeat_at 不能为空');

  // 心跳新鲜,所以启动清理不该动它。
  runStartupCleanup();
  assert.equal(statusOf('fresh').status, 'running');
});
