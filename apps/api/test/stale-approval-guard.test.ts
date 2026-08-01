import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

/*
 * 两道收紧,都是写入侧的门禁:
 *   1. 失效(stale)的项目分析不能直接确认——只翻 status 会把资料变动之前算出来的
 *      缺口与 evidenceId 重新标成「已就绪」。
 *   2. 人工路径不得新声称 supplied_fact——它表示「资料里有出处」,只能由分析器
 *      基于 evidenceSections 判定。
 * 都要真实应用与真库,所以走 HTTP,不放进纯单元的 gap-source-status.test.ts。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'Guard-bootstrap-123!';
const NEW_PASSWORD = 'Guard-updated-456!';

async function call(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-stale-approve-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  // 首次登录必须改密码,否则后续写操作一律 403 PASSWORD_CHANGE_REQUIRED
  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.status, 201, JSON.stringify(changed.body));

  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '失效确认门禁', domain: '装修' }),
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** 直接造一行分析:跑真分析要调模型,这里只验门禁。 */
function seedIntelligence(status: string): string {
  const db = app.get(DatabaseService);
  const id = randomUUID();
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const version = Number((db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS value FROM project_intelligence WHERE project_id=?',
  ).get(projectId) as { value: number }).value) + 1;
  db.prepare(
    `INSERT INTO project_intelligence
       (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'fp-guard-test', '{}', ?, datetime('now'), datetime('now'))`,
  ).run(id, projectId, version, status, admin.id);
  return id;
}

async function createGap(payload: Record<string, unknown>) {
  const res = await call(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res;
}

test('stale 的分析不能确认,错误信息说清该做什么', async () => {
  /*
   * approveResource 此前只翻 status,不校验 stale。实测线上时间线:
   *   18:29 分析完成 → 18:33 补充存新版本 markProjectStale → 18:34 点「确认」变回 approved
   * 结果缺口与 evidenceId 全部来自资料变动之前,界面挂满「引用已失效」。
   * 不拦这一步,任何待办提示都能被一次点击消掉。
   */
  const id = seedIntelligence('stale');
  const result = await call(`/api/projects/${projectId}/intelligence/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body.message), /重新分析/u);
});

test('draft 的分析仍然可以确认', async () => {
  // 门禁只拦 stale。把正常流程也堵死就是过度收紧。
  const id = seedIntelligence('draft');
  const result = await call(`/api/projects/${projectId}/intelligence/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
});

test('资料变动会让待确认分析失效，不能事后批准旧草稿', async () => {
  const id = seedIntelligence('draft');
  const database = app.get(DatabaseService);
  app.get(IntelligenceService).markProjectStale(projectId);
  assert.equal(
    (database.prepare('SELECT status FROM project_intelligence WHERE id=?').get(id) as { status: string }).status,
    'stale',
  );
  const result = await call(`/api/projects/${projectId}/intelligence/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body.message), /重新分析/u);
});

test('stale 的缺口不受门禁影响,仍然可以确认', async () => {
  /*
   * 门禁限定 project_intelligence。缺口/策略/选题的 stale 是 markProjectStale
   * 级联下来的,重新分析会重建它们;把这些也拦住只会把用户堵死——他手上没有
   * 「重新分析这一条缺口」的操作。这条守住那个限定,去掉 table 判断它就会红。
   */
  const created = await createGap({ title: '级联失效', data: { label: '级联失效', question: '级联的能确认吗?' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  app.get(DatabaseService).prepare("UPDATE information_gaps SET status='stale' WHERE id=?").run(created.body.id);
  const result = await call(`/api/projects/${projectId}/information-gaps/${created.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.approvalStatus, 'approved');
});

test('PATCH 顶层 sourceStatus 不能把缺口标成 supplied_fact', async () => {
  // 手写顶层字段的直接调用者:resourceData 把顶层键也展开进 data_json,躲不过
  const created = await createGap({ title: '写入守卫', data: { label: '写入守卫', question: '能被人工标成资料出处吗?' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = await call(`/api/projects/${projectId}/information-gaps/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '写入守卫', sourceStatus: 'supplied_fact' }),
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body.message), /资料|分析/u);
});

test('PATCH 嵌在 data 里的 sourceStatus 同样拦住(UI 走的就是这条)', async () => {
  // 真实载荷见 apps/web/src/lib/metric-payload.ts:34,gapPayload 把输入整个塞进 data
  const created = await createGap({ title: '嵌套守卫', data: { label: '嵌套守卫', question: '嵌在 data 里能绕过吗?' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = await call(`/api/projects/${projectId}/information-gaps/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '嵌套守卫', data: { label: '嵌套守卫', question: '问题', sourceStatus: 'supplied_fact' } }),
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body.message), /资料|分析/u);
});

test('POST 新建缺口也不能直接标成 supplied_fact', async () => {
  // 只拦 PATCH 会留下 POST 这条路
  const result = await createGap({
    title: '新建即声称',
    data: { label: '新建即声称', question: '建的时候就标行不行?', sourceStatus: 'supplied_fact' },
  });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body.message), /资料|分析/u);
});

test('PATCH 可以把缺口标成 user_supplied', async () => {
  // 人工确认是合法路径,不能一起拦掉
  const created = await createGap({ title: '人工确认', data: { label: '人工确认', question: '能标成我确认过吗?' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = await call(`/api/projects/${projectId}/information-gaps/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '人工确认', data: { label: '人工确认', question: '问题', answer: '答案', sourceStatus: 'user_supplied' } }),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.sourceStatus, 'user_supplied');
});

test('PATCH 原样回传分析器判定的 supplied_fact 不被拦', async () => {
  // 缺口编辑器会显示并回传分析器的判定(Task 3),拦掉它等于该缺口再也存不了
  const created = await createGap({ title: '分析判定', data: { label: '分析判定', question: '问题' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // 直接改库模拟分析器写入,绕开守卫
  app.get(DatabaseService).prepare(
    "UPDATE information_gaps SET data_json = json_set(data_json, '$.sourceStatus', 'supplied_fact') WHERE id = ?",
  ).run(created.body.id);
  const result = await call(`/api/projects/${projectId}/information-gaps/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: '分析判定', data: { label: '分析判定', question: '问题', sourceStatus: 'supplied_fact' } }),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.sourceStatus, 'supplied_fact');
});
