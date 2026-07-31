import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { DatabaseService, SCHEMA_VERSION } from '../src/database.service.js';

/**
 * 数据库迁移。直接构造 DatabaseService 而不起整个应用:这里只验存储结构,
 * 与 job-claim.test.ts 的做法一致(见该文件 before 钩子)。
 */
let dataDir = '';
let database: DatabaseService;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-revision-migration-'));
  database = new DatabaseService({ dataDir, databasePath: join(dataDir, 'app.db') } as never);
});

after(async () => {
  database?.onModuleDestroy?.();
  await rm(dataDir, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  return (database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[])
    .map((row) => row.name);
}

test('建出 revision_tasks 与全部列', () => {
  const columns = columnsOf('revision_tasks');
  for (const expected of [
    'id', 'job_id', 'package_id', 'candidate_id', 'instruction', 'status', 'progress',
    'attempt_count', 'error', 'rerun_channels_json', 'result_package_id',
    'created_by', 'created_at', 'updated_at', 'completed_at', 'claimed_by', 'heartbeat_at',
    // 已扣未退的额度次数。重试靠孤儿回收重新入队,每轮扣一次,回收判死那一侧要按它退。
    'quota_consumed_count',
  ]) {
    assert.ok(columns.includes(expected), `缺列 ${expected}:实际 ${columns.join(',')}`);
  }
});

test('三个索引都建在新表上', () => {
  const names = (database
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='revision_tasks'")
    .all() as { name: string }[]).map((row) => row.name);
  assert.ok(names.includes('revision_tasks_job_idx'), `实际索引:${names.join(',')}`);
  assert.ok(names.includes('revision_tasks_claim_idx'), `实际索引:${names.join(',')}`);
  assert.ok(names.includes('revision_tasks_active_job_idx'), `实际索引:${names.join(',')}`);
});

/*
 * 互斥的粒度是 job,不是 package。
 *
 * 包级互斥允许同一个 job 的两个候选并发改稿,而投影 activeFor(jobId) 只回一条活跃任务:
 * 先提交的那个候选在轮询里看不到自己的任务,立刻判「已完成」,把未更新的旧候选当成改稿
 * 结果报给用户(假成功)。索引回到 package_id 会让这条变红。
 */
test('活跃修改的唯一索引建在 job_id 上,且是限定未终态的部分唯一索引', () => {
  const sql = (database
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='revision_tasks_active_job_idx'")
    .get() as { sql: string } | undefined)?.sql;
  assert.ok(sql, '缺 revision_tasks_active_job_idx');
  assert.match(sql, /UNIQUE\s+INDEX/i);
  assert.match(sql, /\(\s*job_id\s*\)/i, '互斥列必须是 job_id:包级互斥会放过同 job 的第二个候选');
  // 少了 WHERE 就成了「一篇稿子一辈子只能改一次」,是比多实例竞态更糟的回归。
  assert.match(sql, /WHERE\s+status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*\)/i);
});

test('generation_jobs 一列都没加', () => {
  // 规格明确:状态留在 revision_tasks,不污染 job。任何 revision_* 列都是回归。
  const columns = columnsOf('generation_jobs');
  assert.ok(
    !columns.some((name) => name.startsWith('revision_')),
    `不该出现 revision_* 列:${columns.join(',')}`,
  );
});

test('user_version 推进到最新版本', () => {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, SCHEMA_VERSION);
});

test('v17 升级会为分析任务增加非空额度余额列', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'ca-v18-analysis-quota-'));
  const databasePath = join(legacyDir, 'app.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE analysis_tasks (id TEXT PRIMARY KEY);
    INSERT INTO analysis_tasks (id) VALUES ('legacy-analysis');
    PRAGMA user_version = 17;
  `);
  legacy.close();

  let migrated: DatabaseService | undefined;
  try {
    migrated = new DatabaseService({ dataDir: legacyDir, databasePath } as never);
    const column = migrated.prepare(
      "SELECT name, \"notnull\" AS required, dflt_value FROM pragma_table_info('analysis_tasks') WHERE name='quota_consumed_count'",
    ).get() as { name: string; required: number; dflt_value: string } | undefined;
    assert.ok(column);
    assert.equal(column.required, 1);
    assert.equal(column.dflt_value, '0');
    assert.equal(
      (migrated.prepare('SELECT quota_consumed_count FROM analysis_tasks WHERE id=?')
        .get('legacy-analysis') as { quota_consumed_count: number }).quota_consumed_count,
      0,
    );
    assert.equal(
      (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      SCHEMA_VERSION,
    );
  } finally {
    migrated?.onModuleDestroy();
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test('外键指向 generation_jobs 且级联删除', () => {
  const fks = database.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('revision_tasks')")
    .all() as { table: string; on_delete: string }[];
  const jobFk = fks.find((fk) => fk.table === 'generation_jobs');
  assert.ok(jobFk, `应有指向 generation_jobs 的外键:${JSON.stringify(fks)}`);
  assert.equal(jobFk.on_delete, 'CASCADE', 'job 删掉后遗留的修改任务没有意义');
});

test('v17 修复重复知识版本、Owner 权限漂移与项目 ACL,并建立数据库约束', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'ca-v17-dirty-'));
  const databasePath = join(legacyDir, 'app.db');
  let legacy: DatabaseService | undefined = new DatabaseService({ dataDir: legacyDir, databasePath } as never);
  try {
    legacy.db.exec([
      'DROP TRIGGER workspace_member_owner_delete_guard',
      'DROP TRIGGER workspace_member_owner_update_guard',
      'DROP TRIGGER workspace_member_owner_insert_guard',
      'DROP TRIGGER workspace_owner_update_guard',
      'DROP TRIGGER project_acl_owner_insert_guard',
      'DROP TRIGGER project_acl_owner_update_guard',
      'DROP INDEX workspace_members_single_owner_idx',
      'DROP INDEX knowledge_files_version_idx',
      'PRAGMA user_version = 15',
    ].join(';'));
    const now = '2026-07-28T00:00:00.000Z';
    const insertUser = legacy.prepare(
      "INSERT INTO users (id, username, password_hash, system_role, created_at, updated_at) " +
      "VALUES (?, ?, 'x', 'user', ?, ?)",
    );
    insertUser.run('owner', 'legacy-owner', now, now);
    insertUser.run('other', 'legacy-other', now, now);
    legacy.prepare(
      'INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-ws', 'legacy-ws', '旧工作区', 'owner', now, now);
    const insertMember = legacy.prepare(
      "INSERT INTO workspace_members " +
      "(workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, '[]', '[]', ?, ?)",
    );
    insertMember.run('legacy-ws', 'owner', 'Viewer', now, now);
    insertMember.run('legacy-ws', 'other', 'Owner', now, now);
    legacy.prepare(
      "UPDATE workspace_members SET grants_json='[\"project.read\"]', " +
      "denies_json='[\"workspace.manage\"]' WHERE workspace_id='legacy-ws' AND user_id='owner'",
    ).run();
    legacy.prepare(
      'INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('legacy-project', 'legacy-ws', 'legacy-project', '旧项目', 'owner', now, now);
    legacy.prepare(
      "INSERT INTO project_acl (project_id, user_id, grants_json, denies_json, updated_at) " +
      "VALUES ('legacy-project', 'owner', '[]', '[\"project.write\"]', ?)",
    ).run(now);
    const insertKnowledge = legacy.prepare(
      "INSERT INTO knowledge_files " +
      "(id, project_id, filename, storage_path, media_type, bytes, sha256, version, " +
      "category, evidence_status, metadata_json, created_by, created_at, updated_at) " +
      "VALUES (?, 'legacy-project', 'same.md', ?, 'text/markdown', 1, ?, 1, " +
      "'general', 'unknown', '{}', 'owner', ?, ?)",
    );
    insertKnowledge.run('knowledge-a', 'knowledge/a.md', 'hash-a', now, now);
    insertKnowledge.run('knowledge-b', 'knowledge/b.md', 'hash-b', now, now);
    legacy.onModuleDestroy();
    legacy = undefined;

    legacy = new DatabaseService({ dataDir: legacyDir, databasePath } as never);
    const roles = (legacy.prepare(
      'SELECT user_id, role FROM workspace_members WHERE workspace_id = ? ORDER BY user_id',
    ).all('legacy-ws') as Array<{ user_id: string; role: string }>).map((row) => ({
      user_id: String(row.user_id),
      role: String(row.role),
    }));
    assert.deepEqual(roles, [
      { user_id: 'other', role: 'Admin' },
      { user_id: 'owner', role: 'Owner' },
    ]);
    const ownerOverrides = legacy.prepare(
      "SELECT grants_json, denies_json FROM workspace_members " +
      "WHERE workspace_id='legacy-ws' AND user_id='owner'",
    ).get() as { grants_json: string; denies_json: string };
    assert.deepEqual({ ...ownerOverrides }, { grants_json: '[]', denies_json: '[]' });
    const ownerAclCount = legacy.prepare(
      "SELECT COUNT(*) AS value FROM project_acl WHERE project_id='legacy-project' AND user_id='owner'",
    ).get() as { value: number };
    assert.equal(Number(ownerAclCount.value), 0);
    const versions = legacy.prepare(
      'SELECT version FROM knowledge_files WHERE project_id = ? AND filename = ? ORDER BY version',
    ).all('legacy-project', 'same.md') as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => Number(row.version)), [1, 2]);
    assert.throws(
      () => legacy!.prepare(
        "UPDATE workspace_members SET role='Viewer' WHERE workspace_id='legacy-ws' AND user_id='owner'",
      ).run(),
      /owner role or permission override mismatch/u,
    );
    assert.throws(
      () => legacy!.prepare(
        "UPDATE workspace_members SET denies_json='[\"workspace.manage\"]' " +
        "WHERE workspace_id='legacy-ws' AND user_id='owner'",
      ).run(),
      /owner role or permission override mismatch/u,
    );
    assert.throws(
      () => legacy!.prepare(
        "UPDATE workspace_members SET role='Owner' WHERE workspace_id='legacy-ws' AND user_id='other'",
      ).run(),
      /owner role or permission override mismatch|UNIQUE/u,
    );
    assert.throws(
      () => legacy!.prepare(
        "UPDATE workspaces SET owner_id='other' WHERE id='legacy-ws'",
      ).run(),
      /explicit transfer transaction/u,
    );
    assert.throws(
      () => legacy!.prepare(
        "INSERT INTO project_acl (project_id, user_id, grants_json, denies_json, updated_at) " +
        "VALUES ('legacy-project', 'owner', '[]', '[\"project.write\"]', ?)",
      ).run(now),
      /workspace owner project ACL is not allowed/u,
    );
    legacy.prepare(
      "INSERT INTO project_acl (project_id, user_id, grants_json, denies_json, updated_at) " +
      "VALUES ('legacy-project', 'other', '[]', '[]', ?)",
    ).run(now);
    assert.throws(
      () => legacy!.prepare(
        "UPDATE project_acl SET user_id='owner' " +
        "WHERE project_id='legacy-project' AND user_id='other'",
      ).run(),
      /workspace owner project ACL is not allowed/u,
    );
    assert.throws(
      () => legacy!.prepare(
        "INSERT INTO knowledge_files " +
        "(id, project_id, filename, storage_path, media_type, bytes, sha256, version, " +
        "category, evidence_status, metadata_json, created_by, created_at, updated_at) " +
        "VALUES ('knowledge-c', 'legacy-project', 'same.md', 'knowledge/c.md', 'text/markdown', " +
        "1, 'hash-c', 2, 'general', 'unknown', '{}', 'owner', ?, ?)",
      ).run(now, now),
      /UNIQUE/u,
    );
  } finally {
    legacy?.onModuleDestroy?.();
    await rm(legacyDir, { recursive: true, force: true });
  }
});
