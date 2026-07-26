import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';

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

/**
 * 额度扣减的并发正确性。
 *
 * 原来是 check-then-write(SELECT 读 quota_used → JS 比较 → UPDATE +1),调用点
 * 在事务外。多实例下两个请求能都读到 99(上限 100)、都通过检查、都 +1 变成 101。
 * 检查下推进 SQL 之后,「不超额」由 DB 的 WHERE 保证。
 */
test('扣到上限即拒绝,quota_used 不会越过 monthly_quota', async () => {
  const snapshot = await request('/api/settings/quota');
  const workspaceId = snapshot.body.workspaceId as string;
  const db = app.get(DatabaseService);
  db.prepare("UPDATE workspace_settings SET provider_mode='platform', monthly_quota=3, quota_used=0 WHERE workspace_id=?")
    .run(workspaceId);
  const settings = app.get(SettingsService);

  let granted = 0;
  let rejected = 0;
  // 连扣 6 次,上限 3。多出来的必须被拒,而不是把计数推到 6。
  for (let i = 0; i < 6; i += 1) {
    try { settings.consumePlatformQuota(workspaceId); granted += 1; } catch { rejected += 1; }
  }

  assert.equal(granted, 3, '只应放行到上限');
  assert.equal(rejected, 3);
  const row = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { quota_used: number };
  assert.equal(Number(row.quota_used), 3, 'quota_used 不得越过 monthly_quota');
});

test('已用等于配额时直接拒绝,不出现「扣了但没放行」的错账', async () => {
  const snapshot = await request('/api/settings/quota');
  const workspaceId = snapshot.body.workspaceId as string;
  const db = app.get(DatabaseService);
  db.prepare("UPDATE workspace_settings SET provider_mode='platform', monthly_quota=5, quota_used=5 WHERE workspace_id=?")
    .run(workspaceId);
  const settings = app.get(SettingsService);

  assert.throws(() => settings.consumePlatformQuota(workspaceId), /额度/u);
  const row = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { quota_used: number };
  assert.equal(Number(row.quota_used), 5, '被拒的请求不该留下扣减痕迹');
});

test('BYOK 工作区不走平台额度:扣减是空操作', async () => {
  const snapshot = await request('/api/settings/quota');
  const workspaceId = snapshot.body.workspaceId as string;
  const db = app.get(DatabaseService);
  db.prepare("UPDATE workspace_settings SET provider_mode='byok', monthly_quota=1, quota_used=1 WHERE workspace_id=?")
    .run(workspaceId);
  const settings = app.get(SettingsService);

  // 用自己密钥的工作区不该被平台额度拦住,也不该被计数。
  settings.consumePlatformQuota(workspaceId);
  const row = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as { quota_used: number };
  assert.equal(Number(row.quota_used), 1);
});
