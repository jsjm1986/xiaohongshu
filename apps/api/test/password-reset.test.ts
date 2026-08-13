import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * 忘记密码通道:admin 核身后生成一次性链接,用户凭链接自设新密码。
 * 关键性质:令牌 24h 有效、用一次即废、再生成作废旧链接、
 * 重置后全部旧会话失效、失败不区分令牌状态。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';

async function call(path: string, options: RequestInit = {}, useCookie = cookie, useCsrf = csrf) {
  const headers = new Headers(options.headers);
  if (useCookie) headers.set('cookie', useCookie);
  if (useCsrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', useCsrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

const post = (path: string, body: Record<string, unknown> = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-pwreset-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'password-reset-test-master-key!!',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await post('/api/auth/login', { username: 'admin', password: 'Admin-bootstrap-123!' });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await post('/api/auth/change-password', { currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' });
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('重置链接全链路：生成→旧会话有效→重置→旧密码/旧会话失效→令牌即废', async () => {
  const created = await post('/api/admin/users', { username: 'forgetful', password: 'Forgetful-init-123!', systemRole: 'user' });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const userId = String(created.body.id);

  // 用户登录拿到一个会话(重置后必须被踢下线)
  const userLogin = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'forgetful', password: 'Forgetful-init-123!' }) }, '', '');
  assert.equal(userLogin.response.status, 201);
  const userCookie = userLogin.response.headers.get('set-cookie')!.split(';', 1)[0]!;

  // admin 生成一次性链接
  const link = await post(`/api/admin/users/${userId}/reset-link`);
  assert.equal(link.response.status, 201, JSON.stringify(link.body));
  assert.match(String(link.body.resetPath), /^\/reset-password\?token=/u);
  const token = String(link.body.resetPath).split('token=')[1]!;

  // 再生成一次:旧令牌作废,只有最新的有效
  const secondLink = await post(`/api/admin/users/${userId}/reset-link`);
  const secondToken = String(secondLink.body.resetPath).split('token=')[1]!;
  const staleReset = await call('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: 'Fresh-secret-789!' }) }, '', '');
  assert.equal(staleReset.response.status, 400, '被替换的旧令牌必须失效');

  // 用最新令牌重置
  const reset = await call('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: secondToken, newPassword: 'Fresh-secret-789!' }) }, '', '');
  assert.equal(reset.response.status, 201, JSON.stringify(reset.body));

  // 旧密码失效、新密码可登录、旧会话被撤销
  const oldPassword = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'forgetful', password: 'Forgetful-init-123!' }) }, '', '');
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'forgetful', password: 'Fresh-secret-789!' }) }, '', '');
  assert.equal(newPassword.response.status, 201);
  const staleSession = await call('/api/auth/me', {}, userCookie, '');
  assert.equal(staleSession.response.status, 401, '重置后旧会话必须失效');

  // 令牌用一次即废
  const replay = await call('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: secondToken, newPassword: 'Another-secret-000!' }) }, '', '');
  assert.equal(replay.response.status, 400);

  // 重置动作有审计
  const database = app.get(DatabaseService);
  const audits = database.prepare("SELECT COUNT(*) AS v FROM audit_logs WHERE action='user.reset-link' AND entity_id=?").get(userId) as { v: number };
  assert.equal(Number(audits.v), 2, '两次生成链接都要留审计');
});

test('非管理员不能生成重置链接；伪造令牌统一 400 不泄露状态', async () => {
  const created = await post('/api/admin/users', { username: 'plainuser', password: 'Plain-user-123!', systemRole: 'user' });
  const plainLogin = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'plainuser', password: 'Plain-user-123!' }) }, '', '');
  const plainCookie = plainLogin.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  const plainCsrf = plainLogin.body.csrfToken;

  const forbidden = await call(`/api/admin/users/${created.body.id}/reset-link`, { method: 'POST', body: '{}' }, plainCookie, plainCsrf);
  assert.equal(forbidden.response.status, 403);

  const forged = await call('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: 'forged-token', newPassword: 'Whatever-123!' }) }, '', '');
  assert.equal(forged.response.status, 400);
  assert.match(String(forged.body.message), /无效或已过期/u);
});
