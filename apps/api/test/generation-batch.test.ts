import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/database.service.js';
import { resolveOptions } from '../src/config.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-mig-'));
  const db = new DatabaseService(resolveOptions({ dataDir: dir }));
  return { db, cleanup: () => { db.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); } };
}

test('migration v12 creates generation_batches and jobs.batch_id', () => {
  const { db, cleanup } = freshDb();
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version >= 12, true);
    const batchCols = db.prepare("PRAGMA table_info(generation_batches)").all() as Array<{ name: string }>;
    const names = batchCols.map((c) => c.name);
    for (const col of ['id', 'project_id', 'name', 'status', 'total_jobs', 'config_json', 'created_by', 'created_at', 'updated_at', 'completed_at']) {
      assert.equal(names.includes(col), true, `generation_batches 缺列 ${col}`);
    }
    const jobCols = db.prepare("PRAGMA table_info(generation_jobs)").all() as Array<{ name: string }>;
    assert.equal(jobCols.map((c) => c.name).includes('batch_id'), true, 'generation_jobs 缺 batch_id');
  } finally {
    cleanup();
  }
});
