import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 从 /register 自助开通进来的用户,实际可达面。
 *
 * 起因是实测发现:registration.service 走 provisionUserWithWorkspace,而那个 INSERT
 * 压根不写 user_kind,于是落到列默认值 'research' —— 从「申请开通」进来的付费客户
 * 全部被建成专家类用户。前端白名单与后端 guard 都只对 userKind === 'saas' 生效,
 * 所以两边都不拦,等于把完整专家版权限发出去了。
 *
 * saas-access.test.ts 只测纯函数,saas-quota-access.test.ts 只测额度那一条。
 * 这个文件走真实注册审批流程,然后逐个打专家 API,把边界钉死。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let adminCookie = '';
let adminCsrf = '';
let tenantCookie = '';

const ADMIN_PASSWORD = 'ShellBoundary-bootstrap-123!';
const ADMIN_NEW_PASSWORD = 'ShellBoundary-rotated-456!';
const TENANT_PASSWORD = 'Tenant-signup-pass-12345!';

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
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-shellboundary-'));
  app = await createApplication({
    dataDir,
    adminPassword: ADMIN_PASSWORD,
    logger: false,
    // 离线确定性:本文件只验权限面,不该依赖环境里的模型供应商(见 PR #34)
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  }, '', '');
  adminCookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  adminCsrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, `改密失败: ${JSON.stringify(changed.body)}`);

  // 走真实的自助开通流程:提交申请 → 管理员审批
  const submitted = await request('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'paying-tenant',
      password: TENANT_PASSWORD,
      organizationName: '示范机构',
      phone: '13800000000',
    }),
  }, '', '');
  assert.ok([200, 201].includes(submitted.response.status), `提交申请失败 ${submitted.response.status}: ${JSON.stringify(submitted.body)}`);

  const pending = await request('/api/admin/registrations?status=pending');
  const requestId = (Array.isArray(pending.body) ? pending.body : pending.body.items)?.[0]?.id;
  assert.ok(requestId, `拿不到待审申请: ${JSON.stringify(pending.body)}`);
  const approved = await request(`/api/admin/registrations/${requestId}/approve`, { method: 'POST' });
  assert.ok([200, 201].includes(approved.response.status), `审批失败 ${approved.response.status}: ${JSON.stringify(approved.body)}`);

  const tenantLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'paying-tenant', password: TENANT_PASSWORD }),
  }, '', '');
  assert.equal(tenantLogin.response.status, 201, `租户登录失败: ${JSON.stringify(tenantLogin.body)}`);
  tenantCookie = tenantLogin.response.headers.get('set-cookie')!.split(';', 1)[0]!;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('自助开通的用户在库里就是 saas,不是 research', () => {
  const db = app.get(DatabaseService);
  const row = db.prepare("SELECT user_kind FROM users WHERE username='paying-tenant'").get() as { user_kind: string };
  assert.equal(row.user_kind, 'saas');
});

test('/api/auth/me 对外报出 saas,前端才能据此选壳', async () => {
  const { response, body } = await request('/api/auth/me', {}, tenantCookie, '');
  assert.equal(response.status, 200);
  // 响应形状是 { user: {...} };前端 AuthContext 也读这一层
  assert.equal(body.user.userKind, 'saas');
});

test('极简创作要用的接口全部可达', async () => {
  for (const path of ['/api/workspaces', '/api/projects']) {
    const { response } = await request(path, {}, tenantCookie, '');
    assert.equal(response.status, 200, `${path} 应放行,实际 ${response.status}`);
  }
});

test('专家版接口一律 403 且带 SAAS_RESTRICTED', async () => {
  const expertPaths = [
    '/api/settings',
    '/api/formulas',
    '/api/admin/users',
    '/api/admin/registrations',
    '/api/audit',
  ];
  for (const path of expertPaths) {
    const { response, body } = await request(path, {}, tenantCookie, '');
    assert.equal(response.status, 403, `${path} 必须拦下,实际 ${response.status}`);
    assert.equal(body.code, 'SAAS_RESTRICTED', `${path} 应报 SAAS_RESTRICTED,实际 ${JSON.stringify(body)}`);
  }
});

test('research 子路径即使挂在放行前缀下也拒绝', async () => {
  // 刚开通的租户还没有项目,所以自己建一个(/api/projects 对 saas 放行)。
  const workspaces = await request('/api/workspaces', {}, tenantCookie, '');
  const workspaceId = workspaces.body[0]?.id as string;
  assert.ok(workspaceId, `自助开通用户应有自己的工作区: ${JSON.stringify(workspaces.body)}`);
  // 重新登录拿一对配套的 cookie+csrf:csrf 与会话是绑定的,混用会 401。
  const fresh = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'paying-tenant', password: TENANT_PASSWORD }),
  }, '', '');
  const freshCookie = fresh.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  const created = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name: '租户项目', domain: '住宅装修' }),
  }, freshCookie, fresh.body.csrfToken);
  assert.ok([200, 201].includes(created.response.status), `建项目失败 ${created.response.status}: ${JSON.stringify(created.body)}`);
  const projectId = created.body.id as string;

  // /api/projects 整个前缀是放行的,但 research 子路径被显式排除(禁止优先)
  const { response, body } = await request(`/api/projects/${projectId}/research/claims`, {}, tenantCookie, '');
  assert.equal(response.status, 403, `research 子路径必须拦下,实际 ${response.status}`);
  assert.equal(body.code, 'SAAS_RESTRICTED');
});

test('额度只读放行,但裸 /api/settings 仍拒绝——放行是精确路径不是前缀', async () => {
  const workspaces = await request('/api/workspaces', {}, tenantCookie, '');
  const workspaceId = workspaces.body[0]?.id as string;
  assert.ok(workspaceId);
  const quota = await request(`/api/settings/quota?workspaceId=${encodeURIComponent(workspaceId)}`, {}, tenantCookie, '');
  assert.equal(quota.response.status, 200, `额度应放行,实际 ${quota.response.status}`);
  assert.equal(typeof quota.body.remaining, 'number');
  // 供应商字段不该夹带出来
  assert.equal('apiKey' in quota.body, false);
  assert.equal('apiBaseUrl' in quota.body, false);
});
