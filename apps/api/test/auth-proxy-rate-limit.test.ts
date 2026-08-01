import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';

const PASSWORD = 'Admin-bootstrap-123!';
let app: NestExpressApplication;
let dataDir: string;
let baseUrl: string;

async function login(username: string, password: string, forwardedFor: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    body: JSON.stringify({ username, password }),
  });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-auth-proxy-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    secureCookies: false,
    logger: false,
    platformApiKey: '',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('同一真实来源对同一账号连续失败会被限制', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login('limited-account', 'wrong', '198.51.100.10')).status, 401);
  }
  assert.equal((await login('limited-account', 'wrong', '198.51.100.10')).status, 429);
});

test('一个来源触发限制不会锁定其他来源上的同一账号', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login('admin', 'wrong', '198.51.100.20')).status, 401);
  }
  const legitimate = await login('admin', PASSWORD, '198.51.100.21');
  assert.equal(legitimate.status, 201);
});

test('只信任回环代理，改变更远端的转发地址不能绕过限制', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const forged = `203.0.113.${attempt + 1}, 198.51.100.30`;
    assert.equal((await login('forward-chain-account', 'wrong', forged)).status, 401);
  }
  assert.equal(
    (await login('forward-chain-account', 'wrong', '203.0.113.99, 198.51.100.30')).status,
    429,
  );
});

test('同一来源跨账号的尝试总量也有上限', async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await login(`rotating-${attempt}`, 'wrong', '198.51.100.40');
    assert.equal(response.status, 401);
  }
  assert.equal((await login('rotating-over-limit', 'wrong', '198.51.100.40')).status, 429);
});
