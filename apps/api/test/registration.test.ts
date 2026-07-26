import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService, SCHEMA_VERSION } from '../src/database.service.js';
import type { ApiOptions } from '../src/config.js';
import { AuthService } from '../src/auth.service.js';
import { RegistrationService } from '../src/registration.service.js';

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

test('migration v11 adds user_kind column and bumps user_version', () => {
  const db = makeDb();
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registration_requests'")
    .get() as { name: string } | undefined;
  assert.equal(row?.name, 'registration_requests');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  assert.equal(version, SCHEMA_VERSION);
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; dflt_value: string | null }>;
  const userKind = columns.find((column) => column.name === 'user_kind');
  assert.ok(userKind, 'users.user_kind 列应存在');
  assert.equal(userKind.dflt_value, "'research'");
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
      userKind: 'saas',
      mustChangePassword: false,
      workspaceName: '示范口腔诊所',
    }),
  );
  const user = db.prepare('SELECT username, system_role, user_kind, must_change_password FROM users WHERE id = ?').get(userId) as any;
  assert.equal(user.username, 'clinic01');
  assert.equal(user.system_role, 'user');
  // userKind 必须落库。原来这个 INSERT 压根不写 user_kind,于是落到列默认值
  // 'research',把专家版权限发给了每个自助开通的客户。
  assert.equal(user.user_kind, 'saas');
  assert.equal(Number(user.must_change_password), 0);
  const member = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId) as any;
  assert.equal(member.role, 'Owner');
});

function makeReg(db: DatabaseService, auth: AuthService): RegistrationService {
  const audit = { record: () => undefined } as any;
  return new RegistrationService(db, auth, audit);
}

const validInput = () => ({
  username: 'clinicA',
  password: 'a-strong-password-123',
  organizationName: 'A 口腔',
  phone: '13800138000',
});

test('submit stores a pending request with hashed password', async () => {
  const db = makeDb();
  const reg = makeReg(db, makeAuth(db));
  await reg.submit(validInput());
  const row = db.prepare('SELECT status, password_hash, phone FROM registration_requests WHERE username = ?').get('clinicA') as any;
  assert.equal(row.status, 'pending');
  assert.notEqual(row.password_hash, 'a-strong-password-123');
  assert.match(row.password_hash, /^\$argon2/);
});

test('submit rejects duplicate username taken by an existing user', async () => {
  const db = makeDb();
  const auth = makeAuth(db);
  db.transaction(() => auth.provisionUserWithWorkspace({ username: 'taken', passwordHash: 'x', systemRole: 'user', userKind: 'saas', mustChangePassword: false, workspaceName: 'w' }));
  const reg = makeReg(db, auth);
  await assert.rejects(() => reg.submit({ ...validInput(), username: 'taken' }));
});

test('submit rejects duplicate pending phone', async () => {
  const db = makeDb();
  const reg = makeReg(db, makeAuth(db));
  await reg.submit(validInput());
  await assert.rejects(() => reg.submit({ ...validInput(), username: 'clinicB' }));
});

test('approve provisions user and marks request approved', async () => {
  const db = makeDb();
  const auth = makeAuth(db);
  const reg = makeReg(db, auth);
  await reg.submit(validInput());
  const req = db.prepare('SELECT id FROM registration_requests WHERE username = ?').get('clinicA') as any;
  const { userId } = reg.approve(req.id, 'admin-id');
  const user = db.prepare('SELECT username, user_kind, must_change_password FROM users WHERE id = ?').get(userId) as any;
  assert.equal(user.username, 'clinicA');
  // /register 审批通过的是付费 SaaS 客户,必须建成 saas。
  // 改前这里落的是列默认值 'research' —— 等于把完整专家版权限发出去了,
  // 因为前端白名单与后端 guard 都只对 userKind === 'saas' 生效。
  assert.equal(user.user_kind, 'saas');
  assert.equal(Number(user.must_change_password), 0);
  const after = db.prepare('SELECT status, created_user_id FROM registration_requests WHERE id = ?').get(req.id) as any;
  assert.equal(after.status, 'approved');
  assert.equal(after.created_user_id, userId);
});

test('reject stores note and allows re-apply with same username', async () => {
  const db = makeDb();
  const reg = makeReg(db, makeAuth(db));
  await reg.submit(validInput());
  const req = db.prepare('SELECT id FROM registration_requests WHERE username = ?').get('clinicA') as any;
  reg.reject(req.id, 'admin-id', '资料不全');
  assert.equal(reg.loginHintFor('clinicA')?.status, 'rejected');
  await reg.submit(validInput()); // 拒绝后可重申,不抛错
  assert.equal(reg.loginHintFor('clinicA')?.status, 'pending');
});

test('rate limit blocks after threshold per key', async () => {
  const db = makeDb();
  const reg = makeReg(db, makeAuth(db));
  for (let i = 0; i < 5; i++) reg.recordSubmit('1.2.3.4');
  assert.throws(() => reg.assertSubmitAllowed('1.2.3.4'), /频繁|too many/i);
});
