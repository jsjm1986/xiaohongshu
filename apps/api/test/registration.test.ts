import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../src/database.service.js';
import type { ApiOptions } from '../src/config.js';
import { AuthService } from '../src/auth.service.js';

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

function makeAuth(db: DatabaseService): AuthService {
  const options = { adminUsername: 'admin', adminPassword: 'Admin-change-me-2026!', sessionTtlMs: 3_600_000 } as unknown as ApiOptions;
  return new AuthService(db, options);
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

test('provisionUserWithWorkspace creates user + workspace + Owner member', async () => {
  const db = makeDb();
  const auth = makeAuth(db);
  const passwordHash = await auth.hashPassword('a-strong-password-123');
  const { userId, workspaceId } = db.transaction(() =>
    auth.provisionUserWithWorkspace({
      username: 'clinic01',
      passwordHash,
      systemRole: 'user',
      mustChangePassword: false,
      workspaceName: '示范口腔诊所',
    }),
  );
  const user = db.prepare('SELECT username, system_role, must_change_password FROM users WHERE id = ?').get(userId) as any;
  assert.equal(user.username, 'clinic01');
  assert.equal(user.system_role, 'user');
  assert.equal(Number(user.must_change_password), 0);
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId) as any;
  assert.equal(member.role, 'Owner');
});
