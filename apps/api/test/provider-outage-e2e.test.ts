import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

/**
 * 端到端:真的让模型供应商报余额不足,看排队任务是否被连带判掉。
 *
 * 前两个文件分别锁"哪些错误算 outage"(纯函数)与"清队列的行为"(直接调方法)。
 * 这里补最后一环:错误从 provider 抛出 → process 的 catch 捕获 → detectProviderOutage
 * 命中 → failQueuedForOutage 执行。这条链路上任何一处接错,前两个测试都发现不了。
 *
 * 用一个本地 stub 中继,永远返回 Insufficient Balance —— 真实供应商的余额耗尽状态
 * 不可复现。
 */

let app: NestExpressApplication;
let stub: Server;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let stubCalls = 0;

const PASSWORD = 'OutageE2E-bootstrap-123!';
const NEW_PASSWORD = 'OutageE2E-rotated-456!';

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
 * 走真实的 POST /api/generations 建任务。
 *
 * 不手工塞库:process() 在到达模型之前要过好几道校验(公式版本存在、config 里的
 * versionId 与 formula_version_id 一致、planning 快照结构完整…),手工构造的行会
 * 在这些地方先失败,验不到 outage 那条路。用真接口建出来的任务才是真场景。
 */
async function createJob(topic: string): Promise<string> {
  const created = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      mode: 'simple',
      topic,
      goal: '验证余额耗尽时的快失败',
      audienceStage: '收集期',
      entryPoint: '搜索',
      seed: 4242,
    }),
  });
  assert.equal(created.response.status, 201, `建任务失败: ${JSON.stringify(created.body).slice(0, 200)}`);
  return String(created.body.id);
}

async function waitAllSettled(ids: string[], timeoutMs = 20_000): Promise<void> {
  const db = app.get(DatabaseService);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM generation_jobs WHERE id IN (${ids.map(() => '?').join(',')}) AND status IN ('queued','running')`,
    ).get(...ids) as { n: number };
    if (Number(pending.n) === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等待任务收敛超时');
}

before(async () => {
  // stub 中继:任何请求都报余额不足(OpenAI 兼容的错误体形状)
  stub = createServer((req, res) => {
    stubCalls += 1;
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'insufficient_quota' } }));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = (stub.address() as { port: number }).port;

  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-outage-e2e-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'outage-e2e-master-encryption-key', logger: false,
    platformApiKey: 'stub-key',
    platformBaseUrl: `http://127.0.0.1:${stubPort}/v1`,
    // 退避基数压到 0,否则重试要等 7 秒;本用例验的是错误分类而非退避
    modelRetryAttempts: 1,
    modelRetryBaseDelayMs: 0,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const project = await request('/api/projects', {
    method: 'POST', body: JSON.stringify({ name: '余额耗尽项目', domain: '住宅装修' }),
  });
  projectId = project.body.id;
  assert.ok(projectId, `建项目失败: ${JSON.stringify(project.body)}`);
  // 正式生成要求项目分析已审批,复用既有 fixture
  seedApprovedProjectBlueprint(app, projectId);
});

after(async () => {
  await app?.close();
  await new Promise<void>((r) => stub.close(() => r()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const jobIds: string[] = [];

test('一篇撞上余额不足后,排队中的其余任务被立刻判失败而不是逐个再跑一遍', async () => {
  const callsBefore = stubCalls;
  // 一次提 5 篇(模拟批量)。并发上限是 2,所以至少 3 篇会真的在队列里排着。
  for (let i = 1; i <= 5; i += 1) jobIds.push(await createJob(`余额耗尽选题-${i}`));
  await waitAllSettled(jobIds);

  const db = app.get(DatabaseService);
  const rows = db.prepare(
    `SELECT id, status, error FROM generation_jobs WHERE id IN (${jobIds.map(() => '?').join(',')})`,
  ).all(...jobIds) as Array<{ id: string; status: string; error: string | null }>;

  assert.equal(rows.length, 5);
  for (const row of rows) assert.equal(row.status, 'failed', `${row.id} 应失败`);

  // 命中供应商和被连带停止的任务都只保存安全业务文案。真实命中由下面的
  // provider_outage 事件证明，不能再靠泄露供应商响应体来区分。
  for (const row of rows) {
    assert.match(row.error ?? '', /余额不足/u);
    assert.match(row.error ?? '', /产出区批量重试/u);
    assert.doesNotMatch(row.error ?? '', /Insufficient Balance|insufficient_quota|provider rejected/iu);
  }
  const outageEvents = db.prepare(
    `SELECT job_id, details_json FROM generation_events
      WHERE event='provider_outage' AND job_id IN (${jobIds.map(() => '?').join(',')})`,
  ).all(...jobIds) as Array<{ job_id: string; details_json: string }>;
  assert.ok(outageEvents.length >= 1, '至少一篇真的打到了供应商并留下安全事件');
  assert.ok(
    outageEvents.some((event) => Number(JSON.parse(event.details_json).clearedQueuedJobs) >= 1),
    '至少一次真实命中应连带停止仍在排队的任务',
  );

  /**
   * 关键:被连带判掉的那几篇,一次模型调用都没发起 —— 这正是省下来的成本。
   * 改前每篇都要跑完知识加载/规划/写作、平均 983 秒才撞上同一面墙。
   *
   * 每篇任务最多 3 次调用(3 个候选;402 不进重试,retryModelProvider 对 <500
   * 且非 429 的状态直接抛)。所以调用总数应只与"真正撞墙的篇数"成比例,
   * 与被连带的篇数无关。
   */
  const calls = stubCalls - callsBefore;
  const CALLS_PER_JOB = 3;
  assert.ok(
    calls <= outageEvents.length * CALLS_PER_JOB,
    `调用数应只与真正撞墙的 ${outageEvents.length} 篇相关(≤${outageEvents.length * CALLS_PER_JOB}),实际 ${calls} 次`,
  );
  assert.ok(
    calls < 5 * CALLS_PER_JOB,
    `必须显著少于"5 篇全跑一遍"的 ${5 * CALLS_PER_JOB} 次,实际 ${calls} 次`,
  );

  // 队列在 DB 里,所以「清空」就是「没有行还停在 queued」。原来读的是本实例内存
  // 数组——多实例下那个数字只反映自己那一段,别的实例上同项目的排队任务照样会
  // 各花 16 分钟撞同一面墙。
  const stillQueued = app.get(DatabaseService)
    .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='queued' AND deleted_at IS NULL")
    .get() as { value: number };
  assert.equal(Number(stillQueued.value), 0, '队列应被清空');
});

test('事件流里留下 provider_outage 记录,便于事后排查', () => {
  const db = app.get(DatabaseService);
  const rows = db.prepare(
    `SELECT details_json FROM generation_events WHERE event='provider_outage' AND job_id IN (${jobIds.map(() => '?').join(',')})`,
  ).all(...jobIds) as Array<{ details_json: string }>;
  assert.ok(rows.length >= 1, '应写入 provider_outage 事件');
  const payloads = rows.map((row) => JSON.parse(row.details_json) as { kind: string; clearedQueuedJobs: number });
  assert.ok(payloads.every((payload) => payload.kind === 'insufficient_balance'));
  assert.ok(
    payloads.some((payload) => payload.clearedQueuedJobs >= 1),
    `至少一次应记录清掉的条数,实际 ${payloads.map((payload) => payload.clearedQueuedJobs).join(',')}`,
  );
});
