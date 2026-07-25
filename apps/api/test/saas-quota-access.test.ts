import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 端到端确认 SaaS 用户的实际可达面:额度端点通,裸 /api/settings 仍被 SessionAuthGuard
 * 的白名单拦下。单测 isSaasApiAllowed 只证明纯函数对,这里证明它真的挂在请求链上。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let adminCookie = '';
let adminCsrf = '';
let saasCookie = '';

const PASSWORD = 'SaasQuota-bootstrap-123!';
const ADMIN_NEW_PASSWORD = 'SaasQuota-rotated-456!';
const SAAS_PASSWORD = 'SaasUser-pass-12345!';

async function request(path: string, options: RequestInit = {}, cookie = adminCookie, csrf = adminCsrf) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-saasquota-'));
  app = await createApplication({ dataDir, adminPassword: PASSWORD, logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  }, '', '');
  adminCookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  adminCsrf = login.body.csrfToken;

  // bootstrap 管理员首次登录后必须改密,否则任何写操作都是 403
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: ADMIN_NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, `改密失败: ${JSON.stringify(changed.body)}`);

  // 建一个 saas 用户:管理员建号后直接把 user_kind 改成 saas(注册接口不暴露该字段)
  const created = await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'saas-tenant', password: SAAS_PASSWORD, systemRole: 'user' }),
  });
  assert.ok([200, 201].includes(created.response.status), `建号失败 ${created.response.status} ${JSON.stringify(created.body)}`);

  const db = app.get(DatabaseService);
  db.prepare("UPDATE users SET user_kind='saas' WHERE username='saas-tenant'").run();

  // 开号时要给工作区成员身份,否则他没有任何工作区可读(真实开通流程同理)
  const workspaces = await request('/api/workspaces');
  const workspaceId = workspaces.body[0]?.id as string;
  assert.ok(workspaceId, '管理员应看得到 bootstrap 工作区');
  const userRow = db.prepare("SELECT id FROM users WHERE username='saas-tenant'").get() as { id: string };
  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)' +
    " VALUES (?, ?, 'ContentEditor', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceId, userRow.id);

  const saasLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'saas-tenant', password: SAAS_PASSWORD }),
  }, '', '');
  assert.equal(saasLogin.response.status, 201, `saas 登录失败: ${JSON.stringify(saasLogin.body)}`);
  saasCookie = saasLogin.response.headers.get('set-cookie')!.split(';', 1)[0]!;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('SaaS 用户读得到额度端点', async () => {
  // 与前端一致地带上 workspaceId:用户可能属于多个工作区,inferWorkspace 不猜。
  const workspaces = await request('/api/workspaces', {}, saasCookie, '');
  assert.equal(workspaces.response.status, 200, `工作区列表: ${JSON.stringify(workspaces.body)}`);
  const workspaceId = workspaces.body[0]?.id as string;
  assert.ok(workspaceId, `saas 用户应至少有一个工作区: ${JSON.stringify(workspaces.body)}`);

  const { response, body } = await request(
    `/api/settings/quota?workspaceId=${encodeURIComponent(workspaceId)}`, {}, saasCookie, '',
  );
  assert.equal(response.status, 200, `实际 ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(typeof body.remaining, 'number');
  // 放行的是只读快照,不该夹带供应商字段
  assert.equal('apiBaseUrl' in body, false);
  assert.equal('hasApiKey' in body, false);
});

// 这是本轮唯一的权限面改动,必须证明放行是精确的、没有顺带放开别的。
test('SaaS 用户仍读不到裸 /api/settings(白名单外)', async () => {
  const { response } = await request('/api/settings', {}, saasCookie, '');
  assert.equal(response.status, 403, `裸 /api/settings 必须拦下,实际 ${response.status}`);
});

test('SaaS 用户改不了额度(PATCH 不在白名单)', async () => {
  const { response } = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ monthlyQuota: 99999 }),
  }, saasCookie, 'irrelevant');
  assert.ok(response.status === 403 || response.status === 401, `实际 ${response.status}`);
});
