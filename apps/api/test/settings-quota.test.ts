import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { APP_OPTIONS, type ApiOptions } from '../src/config.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';

const PASSWORD = 'Quota-bootstrap-123!';
const NEW_PASSWORD = 'Quota-updated-456!';

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
  app = await createApplication({
    dataDir,
    adminPassword: PASSWORD,
    logger: false,
    masterEncryptionKey: 'quota-test-master-encryption-key',
    platformApiKey: 'platform-test-key',
    platformBaseUrl: 'https://platform.example.test/v1',
    platformTransport: 'responses',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201);
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

test('公开示例 SESSION_SECRET 不能回退为 BYOK 加密主密钥', async () => {
  const snapshot = await request('/api/settings/quota');
  const workspaceId = snapshot.body.workspaceId as string;
  const db = app.get(DatabaseService);
  const insecure = new SettingsService(
    db,
    { ...db.options, masterEncryptionKey: 'replace-with-at-least-32-random-characters' },
    { record: () => undefined } as never,
  );

  assert.throws(
    () => insecure.update(
      workspaceId,
      { providerMode: 'byok', apiKey: 'test-key-that-must-not-be-encrypted' },
      { userId: 'u-test' } as never,
    ),
    /MASTER_ENCRYPTION_KEY|非示例值/u,
  );
  const row = db.prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { encrypted_api_key: string | null };
  assert.equal(row.encrypted_api_key, null, '拒绝后不能留下以公开密钥加密的密文');
});

test('BYOK 默认拒绝 HTTP、内网、凭据、查询和片段 URL', async () => {
  const db = app.get(DatabaseService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const originalBaseUrl = 'https://api.example.com/v1';
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', base_url=?, transport='responses', encrypted_api_key=NULL WHERE workspace_id=?",
  ).run(originalBaseUrl, workspace.id);

  const unsafeUrls = [
    'http://api.example.com/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.1/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?token=secret',
    'https://api.example.com/v1?',
    'https://api.example.com/v1#fragment',
    'https://api.example.com/v1#',
  ];

  for (const apiBaseUrl of unsafeUrls) {
    const { response } = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerMode: 'byok', apiKey: 'byok-test-key', apiBaseUrl }),
    });
    assert.equal(response.status, 400, `${apiBaseUrl} 必须被拒绝`);
  }

  const row = db.prepare(
    'SELECT provider_mode, base_url, encrypted_api_key FROM workspace_settings WHERE workspace_id=?',
  ).get(workspace.id) as { provider_mode: string; base_url: string; encrypted_api_key: string | null };
  assert.equal(row.provider_mode, 'platform', '非法设置不得切换供应商模式');
  assert.equal(row.base_url, originalBaseUrl, '非法设置不得污染已保存 URL');
  assert.equal(row.encrypted_api_key, null, '非法设置不得提前写入密钥');
});

test('私网 HTTP BYOK 必须同时开启两个显式开关', async () => {
  const db = app.get(DatabaseService);
  const options = app.get<ApiOptions>(APP_OPTIONS);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const privateUrl = 'http://127.0.0.1:9999/v1';
  const restore = { allowHttp: options.byokAllowHttp, allowPrivate: options.byokAllowPrivateNetwork };
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', base_url='https://api.example.com/v1', encrypted_api_key=NULL WHERE workspace_id=?",
  ).run(workspace.id);

  try {
    options.byokAllowHttp = true;
    options.byokAllowPrivateNetwork = false;
    let result = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerMode: 'byok', apiKey: 'byok-test-key', apiBaseUrl: privateUrl }),
    });
    assert.equal(result.response.status, 400, '只开启 HTTP 不得放行私网');

    options.byokAllowHttp = false;
    options.byokAllowPrivateNetwork = true;
    result = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerMode: 'byok', apiKey: 'byok-test-key', apiBaseUrl: privateUrl }),
    });
    assert.equal(result.response.status, 400, '只开启私网不得放行明文 HTTP');

    options.byokAllowHttp = true;
    options.byokAllowPrivateNetwork = true;
    result = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerMode: 'byok', apiKey: 'byok-test-key', apiBaseUrl: privateUrl }),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.providerMode, 'byok');
    assert.equal(result.body.apiBaseUrl, privateUrl);
  } finally {
    options.byokAllowHttp = restore.allowHttp;
    options.byokAllowPrivateNetwork = restore.allowPrivate;
    db.prepare(
      "UPDATE workspace_settings SET provider_mode='platform', base_url='https://api.example.com/v1', transport='responses', encrypted_api_key=NULL WHERE workspace_id=?",
    ).run(workspace.id);
  }
});

test('切换 BYOK 时会重新校验数据库中的存量 URL', async () => {
  const db = app.get(DatabaseService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const saved = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      providerMode: 'byok',
      apiKey: 'byok-test-key',
      apiBaseUrl: 'https://api.example.com/v1',
    }),
  });
  assert.equal(saved.response.status, 200);
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', base_url='http://127.0.0.1:9999/v1' WHERE workspace_id=?",
  ).run(workspace.id);

  try {
    const { response } = await request('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerMode: 'byok' }),
    });
    assert.equal(response.status, 400, '未随 PATCH 提交 URL 时也必须校验最终生效值');
    const row = db.prepare('SELECT provider_mode FROM workspace_settings WHERE workspace_id=?')
      .get(workspace.id) as { provider_mode: string };
    assert.equal(row.provider_mode, 'platform', '拒绝后不得部分切换到 BYOK');
  } finally {
    db.prepare(
      "UPDATE workspace_settings SET provider_mode='platform', base_url='https://api.example.com/v1', encrypted_api_key=NULL WHERE workspace_id=?",
    ).run(workspace.id);
  }
});

test('平台公开设置忽略数据库中的租户 URL 与 transport', async () => {
  const db = app.get(DatabaseService);
  const options = app.get<ApiOptions>(APP_OPTIONS);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', base_url='http://127.0.0.1:9/v1', transport='chat_completions' WHERE workspace_id=?",
  ).run(workspace.id);

  try {
    const { response, body } = await request('/api/settings');
    assert.equal(response.status, 200);
    assert.equal(body.providerMode, 'platform');
    assert.equal(body.apiBaseUrl, options.platformBaseUrl);
    assert.equal(body.transport, options.platformTransport);
  } finally {
    db.prepare(
      'UPDATE workspace_settings SET base_url=?, transport=? WHERE workspace_id=?',
    ).run(options.platformBaseUrl, options.platformTransport, workspace.id);
  }
});

test('设置更新严格拒绝非法字段且不污染已保存配置', async () => {
  const db = app.get(DatabaseService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.prepare("UPDATE workspace_settings SET provider_mode='platform', provider='openai', model='stable-model', base_url='https://api.example.com/v1', transport='responses', encrypted_api_key=NULL, monthly_quota=100, default_temperature=0.8, config_json='{}' WHERE workspace_id=?").run(workspace.id);
  const before = db.prepare('SELECT provider_mode, provider, model, base_url, transport, encrypted_api_key, monthly_quota, default_temperature, config_json FROM workspace_settings WHERE workspace_id=?').get(workspace.id);

  const invalidBodies: string[] = [
    JSON.stringify({ providerMode: 'unknown' }),
    JSON.stringify({ provider: '' }),
    JSON.stringify({ model: '   ' }),
    JSON.stringify({ transport: 'legacy' }),
    '{"defaultTemperature":1e309}',
    JSON.stringify({ defaultTemperature: -0.1 }),
    JSON.stringify({ monthlyQuota: 1.5 }),
    JSON.stringify({ monthlyQuota: 1_000_001 }),
    JSON.stringify({ generationDefaults: [] }),
    JSON.stringify({ clearApiKey: 'true' }),
    JSON.stringify({ apiKey: 'x'.repeat(8_193) }),
  ];
  for (const body of invalidBodies) {
    const result = await request('/api/settings', { method: 'PATCH', body });
    assert.equal(result.response.status, 400, '非法设置应返回 400');
  }

  const after = db.prepare('SELECT provider_mode, provider, model, base_url, transport, encrypted_api_key, monthly_quota, default_temperature, config_json FROM workspace_settings WHERE workspace_id=?').get(workspace.id);
  assert.deepEqual(after, before, '任何被拒请求都不能留下部分更新');
});

test('过深 JSON 在服务层处理前被拒绝且合法 prototype 领域字段保留', async () => {
  let nested: Record<string, unknown> = { value: true };
  for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
  const rejected = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ generationDefaults: nested }),
  });
  assert.equal(rejected.response.status, 400);
  assert.match(String(rejected.body.message), /嵌套层级过深/u);

  const accepted = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ generationDefaults: { scenario: { prototype: 'option_comparison' } } }),
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body.generationDefaults, { scenario: { prototype: 'option_comparison' } });
});

test('清除 BYOK 密钥回到平台模式且冲突请求不清除现有密钥', async () => {
  const db = app.get(DatabaseService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  const saved = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ providerMode: 'byok', apiKey: 'existing-byok-key', apiBaseUrl: 'https://api.example.com/v1' }),
  });
  assert.equal(saved.response.status, 200);
  const encryptedBefore = (db.prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id=?').get(workspace.id) as { encrypted_api_key: string }).encrypted_api_key;
  assert.ok(encryptedBefore);

  const conflict = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ apiKey: 'replacement-key', clearApiKey: true }),
  });
  assert.equal(conflict.response.status, 400);
  const afterConflict = db.prepare('SELECT encrypted_api_key FROM workspace_settings WHERE workspace_id=?').get(workspace.id) as { encrypted_api_key: string };
  assert.equal(afterConflict.encrypted_api_key, encryptedBefore);

  const cleared = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ providerMode: 'byok', clearApiKey: true }),
  });
  assert.equal(cleared.response.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.providerMode, 'platform');
  assert.equal(cleared.body.hasApiKey, true, '平台密钥仍由部署配置提供');
  const row = db.prepare('SELECT provider_mode, encrypted_api_key FROM workspace_settings WHERE workspace_id=?').get(workspace.id) as { provider_mode: string; encrypted_api_key: string | null };
  assert.equal(row.provider_mode, 'platform');
  assert.equal(row.encrypted_api_key, null);
});


test('provider 执行合同指纹不受额度消费和退还影响，但模型配置变化会改变', async () => {
  const db = app.get(DatabaseService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', model='fingerprint-model-a', monthly_quota=100, quota_used=0 WHERE workspace_id=?",
  ).run(workspace.id);
  const settings = app.get(SettingsService);
  const before = settings.provider(workspace.id).configVersion;
  settings.consumePlatformQuota(workspace.id);
  const afterConsume = settings.provider(workspace.id).configVersion;
  settings.refundPlatformQuota(workspace.id);
  const afterRefund = settings.provider(workspace.id).configVersion;
  assert.equal(afterConsume, before, '额度计数不能伪装成 provider 配置漂移');
  assert.equal(afterRefund, before, '额度退还不能伪装成 provider 配置漂移');
  db.prepare("UPDATE workspace_settings SET model='fingerprint-model-b' WHERE workspace_id=?").run(workspace.id);
  assert.notEqual(settings.provider(workspace.id).configVersion, before, '执行模型变化必须改变合同指纹');
});
