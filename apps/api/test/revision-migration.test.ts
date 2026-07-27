import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service.js';

/**
 * v15 迁移。直接构造 DatabaseService 而不起整个应用:这里只验存储结构,
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
  assert.ok(names.includes('revision_tasks_active_pkg_idx'), `实际索引:${names.join(',')}`);
});

test('活跃修改的唯一索引是部分唯一索引,条件限定在未终态', () => {
  const sql = (database
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='revision_tasks_active_pkg_idx'")
    .get() as { sql: string } | undefined)?.sql;
  assert.ok(sql, '缺 revision_tasks_active_pkg_idx');
  // 少了 WHERE 就成了「一个包一辈子只能改一次」,是比多实例竞态更糟的回归。
  assert.match(sql, /UNIQUE\s+INDEX/i);
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

test('user_version 推进到 15', () => {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, 15);
});

test('外键指向 generation_jobs 且级联删除', () => {
  const fks = database.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('revision_tasks')")
    .all() as { table: string; on_delete: string }[];
  const jobFk = fks.find((fk) => fk.table === 'generation_jobs');
  assert.ok(jobFk, `应有指向 generation_jobs 的外键:${JSON.stringify(fks)}`);
  assert.equal(jobFk.on_delete, 'CASCADE', 'job 删掉后遗留的修改任务没有意义');
});
