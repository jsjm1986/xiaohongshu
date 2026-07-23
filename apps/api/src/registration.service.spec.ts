import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from './database.service.js';
import type { ApiOptions } from './config.js';

function makeDb(): DatabaseService {
  const dir = mkdtempSync(join(tmpdir(), 'reg-test-'));
  const options = {
    dataDir: dir,
    databasePath: join(dir, 'test.db'),
    adminUsername: 'admin',
    adminPassword: 'Admin-change-me-2026!',
    sessionTtlMs: 3_600_000,
  } as unknown as ApiOptions;
  return new DatabaseService(options);
}

test('migration v10 creates registration_requests table', () => {
  const db = makeDb();
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registration_requests'")
    .get() as { name: string } | undefined;
  assert.equal(row?.name, 'registration_requests');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  assert.equal(version, 10);
});
