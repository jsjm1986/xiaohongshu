import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { APP_OPTIONS } from '../src/config.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

/**
 * 执行阶段。这里不打真实模型:createApplication 不配 provider 时
 * ContentGenerationAgent 走 deterministicDraft 路径(engine.ts 的 else 分支),
 * 所以任务能真的跑完,只是内容是确定性草稿——正好用来验流程而不烧额度。
 *
 * 成功路径用**真实生成**建任务,不手塞库:agent.revise 会校验
 * package.configSnapshot.formula.versionId 与传入公式版本一致,还要 compile 一遍
 * 参数,手工构造的最小包在到达执行逻辑之前就先失败了,验不到成功路径。
 * 手塞的任务留给失败用例——它要的正是"必然失败"。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'RevExec-bootstrap-123!';
const NEW_PASSWORD = 'RevExec-updated-456!';

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
 * 内容包的最小骨架。
 *
 * mapCandidate 会无条件读 validation.issues / H.hashtags / Cref.threads /
 * diagnostics / evidence / unknowns / conflicts,少一个 GET job 就 500。
 */
function minimalPackage(packageId: string, candidateId: string): Record<string, unknown> {
  return {
    id: packageId,
    candidateId,
    seed: 's',
    content: {
      H: { hashtags: ['杭州去眼袋'] },
      N: { title: '标题', body: '正文', imageBrief: '' },
      Cref: { threads: [], disclaimer: '商家答复参考' },
    },
    validation: { valid: true, repairAttempts: 0, issues: [] },
    diagnostics: [],
    evidence: [],
    unknowns: [],
    conflicts: [],
    revisions: [],
  };
}

/** 手塞一条 completed 任务 + 一个内容包。formula_version_id 为空,执行时必然失败。 */
function seedCompletedJob(jobId: string, packageId: string, candidateId: string): void {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, 'completed', '{"formula":{"versionId":"fv"},"knowledge":{"mode":"full","selectedFileIds":[]}}',
        's', ?, datetime('now'), datetime('now'), '选题', 'g', 'simple', 100, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(jobId, projectId, admin.id);
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, datetime('now'), datetime('now'))`,
  ).run(packageId, jobId, projectId, JSON.stringify(minimalPackage(packageId, candidateId)));
}

/** 真实生成一个任务并等它完成,返回 { jobId, candidateId }。 */
async function createRealJob(topic: string): Promise<{ jobId: string; candidateId: string }> {
  const created = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, mode: 'simple', topic, goal: '验证改稿执行', seed: 4242 }),
  });
  assert.equal(created.response.status, 201, `建任务失败：${JSON.stringify(created.body).slice(0, 300)}`);
  const jobId = String(created.body.id);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const detail = await request(`/api/generations/${jobId}`);
    if (detail.body.status === 'completed') {
      return { jobId, candidateId: String(detail.body.candidates[0].id) };
    }
    if (detail.body.status === 'failed') throw new Error(`生成失败：${detail.body.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('生成任务没有在 60s 内完成');
}

async function waitForRevision(jobId: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await request(`/api/generations/${jobId}`);
    const revision = detail.body.activeRevision;
    if (revision && ['completed', 'failed'].includes(revision.status)) return revision;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`修改任务在 ${timeoutMs}ms 内没有到达终态`);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-revision-exec-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
    // 显式关掉供应商:本文件断言离线确定性改稿。不写这行,resolveOptions 会捡起
    // 环境里的 OPENAI_API_KEY,用例就会打到真实中继并随对端状态飘红。
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
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
    method: 'POST', body: JSON.stringify({ name: '改稿执行项目', domain: '去眼袋' }),
  });
  projectId = project.body.id;
  // 正式生成要求项目分析已审批,复用既有 fixture
  seedApprovedProjectBlueprint(app, projectId);
  await request('/api/settings');
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('修改任务被认领、推进进度、最终完成', async () => {
  const { jobId, candidateId } = await createRealJob('改稿执行-完成');
  await request(`/api/generations/${jobId}/revise`, {
    method: 'POST', body: JSON.stringify({ candidateId, instruction: '正文不要有价格' }),
  });
  const revision = await waitForRevision(jobId);
  assert.equal(revision.status, 'completed', `失败原因：${revision.error}`);
  assert.equal(revision.progress, 100);
  assert.ok(revision.resultPackageId, '完成后要记下结果包 id');
  assert.ok(Array.isArray(revision.rerunChannels) && revision.rerunChannels.length > 0, '要记下实际重跑了哪些通道');
  assert.equal(revision.completedAt !== null, true);

  // 内容真的被换掉了:改稿记录 +1,且结果包 id 就是投影里那个
  const detail = await request(`/api/generations/${jobId}`);
  const revised = detail.body.candidates.find((item: any) => item.packageId === revision.resultPackageId);
  assert.ok(revised, `结果包应出现在候选里，实际：${detail.body.candidates.map((c: any) => c.packageId).join(',')}`);
  assert.equal(revised.revisions.length, 1, '执行落地后要有一条改稿记录');
});

test('执行期间 job.status 始终是 completed,旧候选一直可读', async () => {
  const { jobId, candidateId } = await createRealJob('改稿执行-可见');
  await request(`/api/generations/${jobId}/revise`, {
    method: 'POST', body: JSON.stringify({ candidateId, instruction: '换个开头' }),
  });
  // 不等终态,立刻读一次:此刻任务可能 queued 或 running
  const mid = await request(`/api/generations/${jobId}`);
  assert.equal(mid.body.status, 'completed');
  assert.ok(mid.body.candidates.length > 0, '改稿期间旧候选必须可读');
  await waitForRevision(jobId);
});

test('事件流记下 queued / running / revised', async () => {
  const { jobId, candidateId } = await createRealJob('改稿执行-事件');
  await request(`/api/generations/${jobId}/revise`, {
    method: 'POST', body: JSON.stringify({ candidateId, instruction: '改一下措辞' }),
  });
  const revision = await waitForRevision(jobId);
  assert.equal(revision.status, 'completed', `失败原因：${revision.error}`);
  const db = app.get(DatabaseService);
  const events = (db.prepare('SELECT event FROM generation_events WHERE job_id=? ORDER BY id').all(jobId) as { event: string }[])
    .map((row) => row.event);
  // revise 原来只在成功后记一个 revised,起点与中途完全没有痕迹——查耗时都查不了。
  assert.ok(events.includes('revision_queued'), `实际事件：${events.join(',')}`);
  assert.ok(events.includes('revision_running'), `实际事件：${events.join(',')}`);
  assert.ok(events.includes('revised'), `实际事件：${events.join(',')}`);
});

/*
 * 前置读取抛错也必须收敛成 failed。
 *
 * jobRow / projectRow 在项目或任务不存在时抛 NotFoundException。它们放在 try 之外时
 * 异常会被 drainRevisions 的 .catch(() => undefined) 吞掉:任务停在 running,没有
 * failed、没有事件,还占着 revision_tasks_active_pkg_idx 的名额,该包再也提不了新
 * 修改,只能等孤儿回收跑满 3 轮才收敛。
 */
test('项目被软删时任务收敛为 failed,不是永远卡在 running', async () => {
  seedCompletedJob('job-orphan', 'pkg-orphan', 'cand-orphan');
  const db = app.get(DatabaseService);
  await request('/api/generations/job-orphan/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-orphan', instruction: '孤儿项目' }),
  });
  // 受理之后、执行开始之前软删项目:projectRow 带 deleted_at IS NULL 过滤,会抛
  // NotFoundException。删完立刻恢复,别影响后面的用例。
  db.prepare("UPDATE projects SET deleted_at=datetime('now') WHERE id=?").run(projectId);
  let row: { status: string; error: string | null } | undefined;
  try {
    // 直接轮询任务行,不走 GET /api/generations:那条投影自己也要读项目行,
    // 项目软删期间它读不出来,轮询它只会一直超时。
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      row = db.prepare('SELECT status, error FROM revision_tasks WHERE job_id=?').get('job-orphan') as typeof row;
      if (row && ['completed', 'failed'].includes(row.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    db.prepare('UPDATE projects SET deleted_at=NULL WHERE id=?').run(projectId);
  }
  assert.equal(row?.status, 'failed', `前置读取失败也要落到终态，实际：${row?.status}`);
  assert.ok(row?.error, '要有可读原因');
  // 终态行不进部分唯一索引,所以该包还能再提修改——这是"没被锁住"的证据
  const active = db.prepare("SELECT COUNT(*) AS n FROM revision_tasks WHERE package_id='pkg-orphan' AND status IN ('queued','running')")
    .get() as { n: number };
  assert.equal(Number(active.n), 0, '不该留下活跃行占着索引名额');
});

/*
 * 单事务的原子性。
 *
 * 上一条用例在 formulas.get() 就失败,发生在任何写库动作之前——所以它锁不住本任务
 * 最重要的不变量:删掉 database.transaction 包裹它照样绿。这条把失败注入到两条
 * UPDATE**之间**:内容包已经写过了,改稿任务行的收尾 UPDATE 抛错。没有事务包裹时
 * 内容包的那次写入会留在库里,也就是"半个包"。
 */
test('写库阶段中途失败时内容包回滚,不留半个包', async () => {
  const { jobId, candidateId } = await createRealJob('改稿执行-事务');
  const db = app.get(DatabaseService);
  const pkgBefore = db.prepare('SELECT id, content_json, updated_at FROM content_packages WHERE job_id=? ORDER BY candidate_index LIMIT 1')
    .get(jobId) as { id: string; content_json: string; updated_at: string };

  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    const statement = original(sql);
    // 只拦改稿任务的「置 completed」那一条:它在事务里、在内容包写入之后。
    if (sql.includes("SET status='completed'")) {
      return { ...statement, run: () => { throw new Error('注入故障：收尾写库失败'); } } as unknown as ReturnType<typeof original>;
    }
    return statement;
  };
  let revision: any;
  try {
    await request(`/api/generations/${jobId}/revise`, {
      method: 'POST', body: JSON.stringify({ candidateId, instruction: '事务原子性' }),
    });
    revision = await waitForRevision(jobId);
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }

  assert.equal(revision.status, 'failed', '收尾写库失败要落到 failed');
  assert.equal(revision.resultPackageId, null, '没写成的结果不该留下结果包 id');
  const pkgAfter = db.prepare('SELECT id, content_json, updated_at FROM content_packages WHERE id=?')
    .get(pkgBefore.id) as { id: string; content_json: string; updated_at: string } | undefined;
  assert.ok(pkgAfter, '内容包的 id 不该被换成新包 id（那正是半个包的样子）');
  assert.equal(pkgAfter.content_json, pkgBefore.content_json, '事务回滚后内容包一个字节都不该变');
  assert.equal(pkgAfter.updated_at, pkgBefore.updated_at, '回滚后不该留下 updated_at 的痕迹');
});

/*
 * 真实模型错误的分类与退额度。
 *
 * 这条是本任务的要害:agent.revise 抛的是 agent-core 的 ModelProviderError,不是
 * 分析路径的 AnalysisGatewayError。分类只认后者时,revise 的每一种模型失败都落进
 * other——退额度成为死代码(用户模型故障也被扣钱),报错还是英文原文。
 * model-failure.test.ts 锁纯函数判据,这里锁「processRevision 真的走到那条分支」。
 *
 * 生成阶段要走离线确定性路径(否则建不出可改的稿),所以先用空 apiKey 生成,再把
 * 注入的运行时选项指向 stub 中继——这样只有改稿这一步会打到 502。
 */
test('模型返回 502 时退还额度,并给中文可行动文案', async () => {
  const { jobId, candidateId } = await createRealJob('改稿执行-退额度');
  const db = app.get(DatabaseService);
  const settings = app.get(SettingsService);
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  settings.ensure(workspace.id);
  const stub = createServer((_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Bad gateway' } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = (stub.address() as { port: number }).port;

  // base_url 在设置行建出来的那一刻就落库了(SettingsService.ensure 写的是当时的
  // platformBaseUrl),而 provider() 读行内值优先。只改注入选项不够,行也要改,
  // 否则请求打到 before 里配的 127.0.0.1:1 变成「连接失败」——那是另一种错误。
  const baseUrlBefore = (db.prepare('SELECT base_url FROM workspace_settings WHERE workspace_id=?').get(workspace.id) as { base_url: string }).base_url;
  db.prepare("UPDATE workspace_settings SET provider_mode='platform', monthly_quota=100, quota_used=5, base_url=? WHERE workspace_id=?")
    .run(`http://127.0.0.1:${port}/v1`, workspace.id);

  const options = app.get<Record<string, unknown>>(APP_OPTIONS);
  const restore = { apiKey: options.platformApiKey, baseUrl: options.platformBaseUrl, attempts: options.modelRetryAttempts, delay: options.modelRetryBaseDelayMs };
  options.platformApiKey = 'stub-key';
  options.platformBaseUrl = `http://127.0.0.1:${port}/v1`;
  options.modelRetryAttempts = 1;
  options.modelRetryBaseDelayMs = 0;

  let revision: any;
  try {
    await request(`/api/generations/${jobId}/revise`, {
      method: 'POST', body: JSON.stringify({ candidateId, instruction: '打到 502' }),
    });
    revision = await waitForRevision(jobId);
  } finally {
    options.platformApiKey = restore.apiKey;
    options.platformBaseUrl = restore.baseUrl;
    options.modelRetryAttempts = restore.attempts;
    options.modelRetryBaseDelayMs = restore.delay;
    db.prepare('UPDATE workspace_settings SET base_url=? WHERE workspace_id=?').run(baseUrlBefore, workspace.id);
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }

  assert.equal(revision.status, 'failed');
  assert.match(revision.error, /模型服务暂时不可用/u, `文案应是中文可行动话术，实际：${revision.error}`);
  assert.match(revision.error, /已退还本次额度/u);
  assert.ok(!revision.error.includes('rejected the request'), `不该把英文原文塞给用户：${revision.error}`);
  const used = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspace.id) as { quota_used: number };
  assert.equal(Number(used.quota_used), 5, '扣一次再退一次,计数应回到原点');
});

test('执行失败时旧内容包字节不变', async () => {
  seedCompletedJob('job-fail', 'pkg-fail', 'cand-fail');
  const db = app.get(DatabaseService);
  // 手塞任务的 formula_version_id 为空,formulas.get 会抛「公式版本不存在」。
  // 这是"确认无产出"的失败,用来验旧稿完好。
  const before = db.prepare('SELECT content_json, updated_at FROM content_packages WHERE id=?').get('pkg-fail') as
    { content_json: string; updated_at: string };

  await request('/api/generations/job-fail/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-fail', instruction: '改一下' }),
  });
  const revision = await waitForRevision('job-fail');
  assert.equal(revision.status, 'failed');
  assert.ok(revision.error, '失败要有可读原因');

  const after = db.prepare('SELECT content_json, updated_at FROM content_packages WHERE id=?').get('pkg-fail') as
    { content_json: string; updated_at: string };
  assert.equal(after.content_json, before.content_json, '失败不能改动内容包一个字节');
  assert.equal(after.updated_at, before.updated_at, '失败不该碰 updated_at');
  const job = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get('job-fail') as { status: string };
  assert.equal(job.status, 'completed', '改稿失败不该让产出消失');
});
