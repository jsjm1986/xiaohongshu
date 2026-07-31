import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseService } from '../src/database.service.js';
import { RateLimitService } from '../src/rate-limit.service.js';

let dataDir = '';
let databasePath = '';
let databaseA: DatabaseService;
let databaseB: DatabaseService;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-rate-limit-'));
  databasePath = join(dataDir, 'app.db');
  databaseA = new DatabaseService({ dataDir, databasePath } as never);
  databaseB = new DatabaseService({ dataDir, databasePath } as never);
});

after(async () => {
  databaseA?.onModuleDestroy();
  databaseB?.onModuleDestroy();
  await rm(dataDir, { recursive: true, force: true });
});

test('two instances share one atomic attempt budget', () => {
  const limiterA = new RateLimitService(databaseA);
  const limiterB = new RateLimitService(databaseB);
  const options = { maxAttempts: 5, windowMs: 60_000, message: 'too many' };

  limiterA.consume('login', 'shared-key', options);
  limiterB.consume('login', 'shared-key', options);
  limiterA.consume('login', 'shared-key', options);
  limiterB.consume('login', 'shared-key', options);
  limiterA.consume('login', 'shared-key', options);
  assert.throws(() => limiterB.consume('login', 'shared-key', options), /too many/u);

  const row = databaseA.prepare(
    'SELECT key_hash, attempt_count FROM rate_limit_buckets WHERE scope=?',
  ).get('login') as { key_hash: string; attempt_count: number };
  assert.equal(Number(row.attempt_count), 5);
  assert.notEqual(row.key_hash, 'shared-key', 'raw IP/username keys must not be persisted');
});

test('limits survive service recreation and clear is visible across instances', () => {
  const options = { maxAttempts: 1, windowMs: 60_000, message: 'blocked' };
  new RateLimitService(databaseA).consume('registration', 'restart-key', options);
  assert.throws(
    () => new RateLimitService(databaseB).consume('registration', 'restart-key', options),
    /blocked/u,
  );
  new RateLimitService(databaseA).clear('registration', 'restart-key');
  assert.doesNotThrow(
    () => new RateLimitService(databaseB).consume('registration', 'restart-key', options),
  );
});

test('expired windows reset the attempt counter', () => {
  const limiter = new RateLimitService(databaseA);
  const options = { maxAttempts: 1, windowMs: 60_000, message: 'blocked' };
  limiter.consume('login', 'expired-key', options);
  databaseA.prepare(
    'UPDATE rate_limit_buckets SET reset_at=? WHERE scope=?',
  ).run('2000-01-01T00:00:00.000Z', 'login');
  assert.doesNotThrow(() => limiter.consume('login', 'expired-key', options));
});
