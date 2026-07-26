import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service.js';

/**
 * 重启恢复:重启不应让排队中的任务作废。
 *
 * 旧行为(onModuleInit)把所有 queued/running 一律置为 failed,且内存队列不从库里
 * 重建 —— 于是一次重启就永久丢掉整条队列。实测今天被触发三次,一次丢掉 40 个任
 * 务,两次打断验证批次。
 *
 * 恢复语义按"副作用是否已发生"区分:
 *  - queued:从未开始执行,重新入队即可,完全无损。
 *  - running:已经消耗过模型调用且可能写了一半,不能静默续跑;标回 queued 并记录
 *    中断次数,由队列重新完整执行一遍(content_packages 只在成功末尾写入,所以不
 *    会留下半成品;配额在创建时已计费,重跑不会重复计费)。
 *  - 反复被中断的任务(超过上限)才判 failed,避免无限重启循环里烧钱。
 */
let dataDir = '';
let database: DatabaseService;
let recoverInterruptedJobs: (db: DatabaseService) => string[];

const RESTART_LIMIT = 3;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-restart-'));
  // 迁移在构造函数里跑完,拿到即可用。
  database = new DatabaseService({ dataDir, databasePath: join(dataDir, 'app.db') } as never);
  ({ recoverInterruptedJobs } = await import('../src/generation-restart-recovery.js'));
});

after(async () => {
  database.onModuleDestroy?.();
  await rm(dataDir, { recursive: true, force: true });
});

/** 满足外键的最小父行：workspace → project。只建一次。 */
function seedParents(): void {
  const now = new Date().toISOString();
  const has = database.prepare("SELECT 1 FROM projects WHERE id='p1'").get();
  if (has) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, system_role, created_at, updated_at)
       VALUES ('u1','restart-recovery-fixture','x','admin',?,?)`,
    )
    .run(now, now);
  database
    .prepare('INSERT OR IGNORE INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('w1', 'ws', 'ws', 'u1', now, now);
  database
    .prepare(
      `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('p1', 'w1', 'proj', '项目', 'u1', now, now);
}

function seedJob(status: string, interruptions = 0): string {
  seedParents();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, project_id, status, config_json, seed, formula_version_id, created_by, created_at, updated_at,
         topic, goal, mode, progress, error, knowledge_context_json, preset_id, style_profile_version,
         resolution_snapshot_json, config_impact_json, opportunity_snapshot_json, planning_context_json,
         image_context_json, research_snapshot_json, quality_status)
       VALUES (?, ?, ?, '{}', 1, NULL, 'u1', ?, ?, 't', 'g', 'advanced', ?, ?, '{}', 'real_minimal', 1,
               ?, '{}', '{}', '{}', '{}', '{}', 'unknown')`,
    )
    .run(
      id,
      'p1',
      status,
      now,
      now,
      status === 'running' ? 44 : 0,
      null,
      JSON.stringify({ restartInterruptions: interruptions }),
    );
  return id;
}

function statusOf(id: string): { status: string; error: string | null } {
  return database.prepare('SELECT status, error FROM generation_jobs WHERE id = ?').get(id) as never;
}

test('queued 任务在重启后回到队列，不再被判 failed', () => {
  const id = seedJob('queued');
  const recovered = recoverInterruptedJobs(database);
  assert.equal(statusOf(id).status, 'queued');
  assert.ok(recovered.includes(id), '排队中的任务必须被重新入队');
});

test('running 任务标回 queued 由队列重跑，而不是直接作废', () => {
  const id = seedJob('running');
  const recovered = recoverInterruptedJobs(database);
  assert.equal(statusOf(id).status, 'queued');
  assert.ok(recovered.includes(id));
});

test('反复被中断超过上限的任务判 failed，避免无限重启烧钱', () => {
  const id = seedJob('running', RESTART_LIMIT);
  const recovered = recoverInterruptedJobs(database);
  const row = statusOf(id);
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /多次/);
  assert.ok(!recovered.includes(id), '已判 failed 的任务不得再入队');
});

test('completed 任务不受重启恢复影响', () => {
  const id = seedJob('completed');
  recoverInterruptedJobs(database);
  assert.equal(statusOf(id).status, 'completed');
});

