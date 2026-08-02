import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseService, SCHEMA_VERSION } from '../src/database.service.js';

let dataDir = '';
let database: DatabaseService;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agent-harness-migration-'));
  database = new DatabaseService({ dataDir, databasePath: join(dataDir, 'app.db') } as never);
});
after(async () => {
  database.onModuleDestroy();
  await rm(dataDir, { recursive: true, force: true });
});

test('Agent Harness 使用独立任务、候选与工具轨迹表', () => {
  const tables = ['agent_harness_jobs', 'agent_harness_candidates', 'agent_harness_tool_calls'];
  for (const table of tables) {
    const row = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as { name: string } | undefined;
    assert.equal(row?.name, table);
  }
  const jobColumns = (database.prepare("SELECT name FROM pragma_table_info('agent_harness_jobs')").all() as { name: string }[]).map((row) => row.name);
  for (const column of ['runtime_snapshot_json', 'evidence_snapshot_json', 'image_snapshot_json', 'parent_job_id', 'run_kind', 'source_candidate_id', 'instruction', 'claim_audit_summary', 'quota_consumed_count', 'claimed_by', 'heartbeat_at', 'review_status', 'review_error', 'review_attempt_count', 'candidate_checkpoint_at', 'read_evidence_ids_json']) {
    assert.ok(jobColumns.includes(column), `agent_harness_jobs 缺列 ${column}`);
  }
  const triggers = (database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='agent_harness_jobs'").all() as { name: string }[])
    .map((row) => row.name);
  assert.ok(triggers.includes('agent_harness_jobs_active_retry_guard'));
  assert.ok(triggers.includes('agent_harness_jobs_active_revision_guard'));
  assert.equal(Number(database.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
});

test('v22 旧库已有重复活跃派生时仍能升级，并阻止迁移后的新重复写入', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'agent-harness-v22-'));
  const databasePath = join(legacyDir, 'app.db');
  let legacy: DatabaseService | undefined;
  let migrated: DatabaseService | undefined;
  try {
    legacy = new DatabaseService({ dataDir: legacyDir, databasePath } as never);
    const now = new Date().toISOString();
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    legacy.transaction(() => {
      legacy!.prepare(
        `INSERT INTO users (id, username, password_hash, system_role, created_at, updated_at)
         VALUES (?, ?, 'test-hash', 'admin', ?, ?)`,
      ).run(userId, `migration-${userId}`, now, now);
      legacy!.prepare(
        `INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at)
         VALUES (?, ?, '迁移测试', ?, ?, ?)`,
      ).run(workspaceId, `migration-${workspaceId}`, userId, now, now);
      legacy!.prepare(
        `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, '迁移项目', ?, ?, ?)`,
      ).run(projectId, workspaceId, `migration-${projectId}`, userId, now, now);
      legacy!.db.exec(`
        DROP TRIGGER agent_harness_jobs_active_retry_guard;
        DROP TRIGGER agent_harness_jobs_active_revision_guard;
        PRAGMA user_version = 22;
      `);
      const insert = legacy!.prepare(
        `INSERT INTO agent_harness_jobs
         (id, project_id, status, topic, parent_job_id, run_kind, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run('parent', projectId, 'completed', '父运行', null, 'original', userId, now, now);
      insert.run('retry-1', projectId, 'queued', '历史重试一', 'parent', 'retry', userId, now, now);
      insert.run('retry-2', projectId, 'running', '历史重试二', 'parent', 'retry', userId, now, now);
    });
    legacy.onModuleDestroy();
    legacy = undefined;

    migrated = new DatabaseService({ dataDir: legacyDir, databasePath } as never);
    assert.equal(Number(migrated.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
    assert.equal(
      Number((migrated.prepare("SELECT COUNT(*) AS value FROM agent_harness_jobs WHERE parent_job_id='parent'").get() as { value: number }).value),
      2,
      '迁移不得清理或改写历史重复记录',
    );
    assert.throws(() => {
      migrated!.prepare(
        `INSERT INTO agent_harness_jobs
         (id, project_id, status, topic, parent_job_id, run_kind, created_by, created_at, updated_at)
         VALUES ('retry-3', ?, 'queued', '新重复重试', 'parent', 'retry', ?, ?, ?)`,
      ).run(projectId, userId, now, now);
    }, /active agent harness retry already exists/u);
  } finally {
    migrated?.onModuleDestroy();
    legacy?.onModuleDestroy();
    await rm(legacyDir, { recursive: true, force: true });
  }
});
