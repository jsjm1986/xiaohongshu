import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';

/**
 * 排队位置。
 *
 * 起因是实测:队列并发上限是 2,而用户一次批量能提 24 篇;完成任务的真实耗时
 * 单篇平均 15 分钟、批量平均 56 分钟。用户盯着一个几十分钟不动的进度条,
 * 不知道是在跑还是卡死,也看不到自己排在第几位。
 *
 * 这些用例锁住:queued 任务要能报出队列位置,running/completed 不报。
 *
 * 位次现在从 DB 算(status='queued' 按 created_at 排序),不再是某个实例的内存
 * 数组下标——内存队列在多实例下让用户看到的位次是错的,每个实例只看得见自己的
 * 那一段。并发上限 2 仍是每实例语义。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'Queuepos-bootstrap-123!';
const NEW_PASSWORD = 'Queuepos-updated-456!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

/**
 * 队列在 DB 里(status='queued'),位次按 (created_at, id) 算——与 claimNextJob 的
 * 取件顺序一致。所以用例要显式给 createdAt 来控制先后,不能靠插入顺序。
 *
 * 原来这些用例往 service 的内存队列数组里 push 来造位次。队列改成 DB 驱动之后
 * 那个注入点不存在了,而且内存队列本身就是被修掉的缺陷:多实例下它让位次失真。
 * 现在 seed 真实的 queued 行,测的是真链路。
 */
function seedJob(id: string, status: string, createdAt?: string) {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, ?, '{"formula":{"versionId":"fv"},"knowledge":{"mode":"full","selectedFileIds":[]}}',
        's', ?, ?, datetime('now'), ?, 'g', 'simple', 0, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(id, projectId, status, admin.id, createdAt ?? new Date().toISOString(), `选题-${id}`);
}

/** 每个用例独占队列状态:位次是全局真值,残留的 queued 行会串味。 */
function clearJobs() {
  app.get(DatabaseService).prepare('DELETE FROM generation_jobs').run();
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-queuepos-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '排队位置项目', domain: '去眼袋' }) });
  projectId = project.body.id;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('queued 任务报出队列位置,按排队先后从 1 开始', () => {
  const service = app.get(GenerationService);
  clearJobs();
  seedJob('q-1', 'queued', '2026-07-26T00:00:01.000Z');
  seedJob('q-2', 'queued', '2026-07-26T00:00:02.000Z');
  seedJob('q-3', 'queued', '2026-07-26T00:00:03.000Z');

  assert.equal(service.queuePosition('q-1'), 1);
  assert.equal(service.queuePosition('q-2'), 2);
  assert.equal(service.queuePosition('q-3'), 3);
});

test('不在队列里的任务返回 undefined,不返回 0 或 -1', () => {
  const service = app.get(GenerationService);
  // 0 会被前端 `if (pos)` 判为假,-1 更是无意义;必须是 undefined
  assert.equal(service.queuePosition('not-queued'), undefined);
});

test('详情接口给 queued 任务带上 queuePosition', async () => {
  clearJobs();
  seedJob('q-api', 'queued');

  const { response, body } = await request('/api/generations/q-api');
  assert.equal(response.status, 200);
  assert.equal(body.queuePosition, 1);
});

test('running 任务不带 queuePosition:它已经在跑,不在排队', async () => {
  clearJobs();
  seedJob('r-api', 'running');
  const { body } = await request('/api/generations/r-api');
  assert.equal(body.queuePosition, undefined);
});

test('列表也带 queuePosition:产出区要显示每条排在第几', async () => {
  clearJobs();
  seedJob('q-list-a', 'queued', '2026-07-26T00:00:01.000Z');
  seedJob('q-list-b', 'queued', '2026-07-26T00:00:02.000Z');

  const { body } = await request(`/api/generations?projectId=${projectId}`);
  const a = body.find((j: any) => j.id === 'q-list-a');
  const bJob = body.find((j: any) => j.id === 'q-list-b');
  assert.equal(a.queuePosition, 1);
  assert.equal(bJob.queuePosition, 2);
});

test('不排队的任务连 queueLength 都不带:已完成的稿子带全局队列长度只是噪声', async () => {
  clearJobs();
  seedJob('c-api', 'completed');
  // 另有一条真在排队:证明「不带 queueLength」不是因为队列恰好空。
  seedJob('someone-else', 'queued');

  const detail = await request('/api/generations/c-api');
  assert.equal(detail.body.queuePosition, undefined);
  assert.equal(detail.body.queueLength, undefined);

  const list = await request(`/api/generations?projectId=${projectId}`);
  const row = list.body.find((j: any) => j.id === 'c-api');
  assert.equal(row.queueLength, undefined);
});

test('queueLength 报出当前排队总数,让「第 3/24 位」成立', () => {
  const service = app.get(GenerationService);
  clearJobs();
  seedJob('len-a', 'queued');
  seedJob('len-b', 'queued');
  seedJob('len-c', 'queued');
  // running 与终态不计入排队总数。
  seedJob('len-running', 'running');
  seedJob('len-done', 'completed');

  assert.equal(service.queueLength(), 3);
});

test('软删的任务不占位次:产出区删掉的不该再显示在排队里', () => {
  const service = app.get(GenerationService);
  clearJobs();
  seedJob('del-1', 'queued', '2026-07-26T00:00:01.000Z');
  seedJob('del-2', 'queued', '2026-07-26T00:00:02.000Z');
  service.softDelete('del-1');

  assert.equal(service.queueLength(), 1);
  assert.equal(service.queuePosition('del-1'), undefined);
  assert.equal(service.queuePosition('del-2'), 1, '前面那条删掉后位次应前移');
});
