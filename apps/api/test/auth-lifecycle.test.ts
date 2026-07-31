import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ApiOptions } from '../src/config.js';
import { AuthService } from '../src/auth.service.js';
import { DatabaseService } from '../src/database.service.js';
import { RateLimitService } from '../src/rate-limit.service.js';

const PASSWORD = 'Lifecycle-password-123!';
let dataDir = '';
let database: DatabaseService;
let auth: AuthService;
let userId = '';
let workspaceId = '';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-auth-lifecycle-'));
  const options = {
    dataDir,
    databasePath: join(dataDir, 'app.db'),
    adminUsername: 'admin',
    adminPassword: 'Lifecycle-admin-123!',
    sessionTtlMs: 3_600_000,
  } as unknown as ApiOptions;
  database = new DatabaseService(options);
  auth = new AuthService(database, options, new RateLimitService(database));
  const passwordHash = await auth.hashPassword(PASSWORD);
  ({ userId, workspaceId } = auth.provisionUserWithWorkspace({
    username: 'lifecycle-user',
    passwordHash,
    systemRole: 'user',
    userKind: 'saas',
    mustChangePassword: false,
    workspaceName: 'Lifecycle workspace',
  }));
});

after(async () => {
  database?.onModuleDestroy();
  await rm(dataDir, { recursive: true, force: true });
});

test('successful login removes expired sessions and caps active sessions at ten', async () => {
  const insert = database.prepare(
    'INSERT INTO sessions ' +
    '(token_hash, user_id, csrf_hash, expires_at, created_at, last_seen_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?)',
  );
  const future = '2099-01-01T00:00:00.000Z';
  for (let index = 0; index < 10; index += 1) {
    const created = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
    insert.run('existing-' + String(index), userId, 'csrf-' + String(index), future, created, created);
  }
  insert.run(
    'expired-session', userId, 'expired-csrf',
    '2000-01-02T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
  );

  const loggedIn = await auth.login('lifecycle-user', PASSWORD);

  const rows = database.prepare(
    'SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at',
  ).all(userId) as Array<{ token_hash: string }>;
  assert.equal(rows.length, 10);
  assert.equal(rows.some((row) => row.token_hash === 'expired-session'), false);
  assert.equal(rows.some((row) => row.token_hash === 'existing-0'), false, 'oldest active session must be evicted');
  assert.equal(rows.some((row) => row.token_hash === loggedIn.principal.tokenHash), true);
});

test('session and API key usage timestamps are throttled to avoid a write on every request', async () => {
  const loggedIn = await auth.login('lifecycle-user', PASSWORD);
  const sessionTimestamp = () => String((database.prepare(
    'SELECT last_seen_at FROM sessions WHERE token_hash=?',
  ).get(loggedIn.principal.tokenHash) as { last_seen_at: string }).last_seen_at);
  const initialSessionTouch = sessionTimestamp();
  auth.authenticateSession(loggedIn.token);
  assert.equal(sessionTimestamp(), initialSessionTouch, 'a fresh session read must not rewrite last_seen_at');

  database.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?')
    .run('2000-01-01T00:00:00.000Z', loggedIn.principal.tokenHash);
  auth.authenticateSession(loggedIn.token);
  assert.notEqual(sessionTimestamp(), '2000-01-01T00:00:00.000Z');

  const apiKey = auth.createApiKey(workspaceId, 'lifecycle key', userId);
  const keyTimestamp = () => (database.prepare(
    'SELECT last_used_at FROM api_keys WHERE id=?',
  ).get(String(apiKey.id)) as { last_used_at: string | null }).last_used_at;
  auth.authenticateApiKey(String(apiKey.key));
  const firstKeyTouch = keyTimestamp();
  assert.ok(firstKeyTouch);
  auth.authenticateApiKey(String(apiKey.key));
  assert.equal(keyTimestamp(), firstKeyTouch, 'a fresh API key read must not rewrite last_used_at');

  database.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?')
    .run('2000-01-01T00:00:00.000Z', String(apiKey.id));
  auth.authenticateApiKey(String(apiKey.key));
  assert.notEqual(keyTimestamp(), '2000-01-01T00:00:00.000Z');
});
