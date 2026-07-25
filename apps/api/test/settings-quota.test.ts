import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';

const PASSWORD = 'Quota-bootstrap-123!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-quota-'));
  app = await createApplication({ dataDir, adminPassword: PASSWORD, logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('GET /api/settings/quota 返回额度快照', async () => {
  const { response, body } = await request('/api/settings/quota');
  assert.equal(response.status, 200);
  assert.equal(typeof body.monthlyQuota, 'number');
  assert.equal(typeof body.quotaUsed, 'number');
  assert.equal(typeof body.remaining, 'number');
  assert.ok(['platform', 'byok'].includes(body.providerMode), `providerMode=${body.providerMode}`);
  assert.equal(body.remaining, Math.max(0, body.monthlyQuota - body.quotaUsed));
});

// 本用例是这个端点存在的理由。直接放行 GET /api/settings 会把 apiBaseUrl、
// model、generationDefaults 一起交给租户——那是基础设施细节,不是他的额度。
// 所以这里逐键断言"不存在",而不是只断言"额度对"。
test('额度端点不泄露任何供应商/密钥/配置字段', async () => {
  const { body } = await request('/api/settings/quota');
  for (const forbidden of [
    'apiBaseUrl', 'model', 'transport', 'provider',
    'generationDefaults', 'hasApiKey', 'apiKey', 'encryptedApiKey', 'defaultTemperature',
  ]) {
    assert.equal(forbidden in body, false, `响应体不应包含 ${forbidden}`);
  }
  // 允许出现的键只有这五个
  assert.deepEqual(
    Object.keys(body).sort(),
    ['monthlyQuota', 'providerMode', 'quotaUsed', 'remaining', 'workspaceId'],
  );
});

// 配额可以被下调到低于既有用量(管理员改小额度),此时朴素相减会得到负数,
// 界面上会显示「剩余 -8 次」。直接改库把 quota_used 顶到配额之上来验真。
test('remaining 不为负:已用超过配额时归零', async () => {
  const snapshot = await request('/api/settings/quota');
  const workspaceId = snapshot.body.workspaceId as string;

  const db = app.get(DatabaseService);
  db.prepare('UPDATE workspace_settings SET monthly_quota = 5, quota_used = 13 WHERE workspace_id = ?')
    .run(workspaceId);

  const { body } = await request('/api/settings/quota');
  assert.equal(body.monthlyQuota, 5);
  assert.equal(body.quotaUsed, 13);
  assert.equal(body.remaining, 0, '已用超配额时余量必须归零而不是 -8');
});

test('未登录一律 401', async () => {
  const saved = cookie;
  cookie = '';
  const { response } = await request('/api/settings/quota');
  cookie = saved;
  assert.equal(response.status, 401);
});
