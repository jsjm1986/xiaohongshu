import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { APP_OPTIONS } from '../src/config.js';
import { DatabaseService } from '../src/database.service.js';
import { claimNext, heartbeatTask, reclaimStale, REVISION_TASKS_SPEC } from '../src/job-claim.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

/**
 * 修改任务的端到端不变量。
 *
 * 这些是规格里逐条列出、且必须能在实现错误时变红的性质。它们比单元测试贵,但覆盖的
 * 都是"错了会让用户丢东西或丢钱"的路径。分工:
 *
 *  - 不变量 2(配额):本文件锁「扣了不该退的不退」与「没到模型就不该扣」。
 *    「模型不可用要退」那一半已由 revision-execution.test.ts 的 502 用例锁住
 *    (真实生成 + stub 中继),不在这里重复造。
 *  - 不变量 3(孤儿回收与触顶):锁 reclaimAndDrain 真的把 revision_tasks 接上了
 *    回收实现,以及触顶判 failed 时旧内容包字节不变。
 *  - 不变量 4(两实例只领一次):job-claim.test.ts 用单连接锁了原子性,这里用两个
 *    独立连接指向同一个库文件——那才是真实部署的形状。
 *
 * 定时器周期刻意调小(默认心跳 15s / 认领超时 90s):回收要在用例里跑完好几轮。
 */

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let workspaceId = '';
let adminId = '';
let formulaVersionId = '';

const PASSWORD = 'RevInv-bootstrap-123!';
const NEW_PASSWORD = 'RevInv-updated-456!';
/** 回收周期。心跳 200ms、超时 600ms:一次等待里能跑好几轮回收。 */
const HEARTBEAT_MS = 200;
const CLAIM_TIMEOUT_MS = 600;

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 内容包骨架。
 *
 * configSnapshot 是本文件的关键字段:agent.revise 一进门就比
 * package.configSnapshot.formula.versionId 与传入的公式版本。给一个对不上的值,
 * 就能在**扣完额度之后**稳定抛一个不带 status 的普通 Error——正是 other 类。
 */
function minimalPackage(packageId: string, candidateId: string, formulaVersionId: string): Record<string, unknown> {
  return {
    id: packageId,
    candidateId,
    seed: 1,
    configSnapshot: { formula: { versionId: formulaVersionId } },
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

/**
 * 手塞一条 completed 任务 + 一个内容包。
 *
 * formulaId 为 null 时 generation_jobs.formula_version_id 落 NULL,执行时
 * formulas.get 抛 NotFoundException——那是「扣额度之前就失败」的路径。
 */
function seedCompletedJob(input: {
  jobId: string;
  packageId: string;
  candidateId: string;
  formulaId?: string | null;
  packageFormulaId?: string;
}): void {
  const db = app.get(DatabaseService);
  const now = new Date().toISOString();
  // config_json 必须带 formula:mapJob 无条件读 config.formula.versionId,缺了 GET job 就 500。
  const config = JSON.stringify({
    formula: { versionId: input.formulaId ?? 'unknown' },
    knowledge: { mode: 'full', selectedFileIds: [] },
  });
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, formula_version_id, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status)
     VALUES (?, ?, 'completed', ?, 's', ?, ?, ?, ?,
        '选题', 'g', 'simple', 100, '{}', 1, '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
  ).run(input.jobId, projectId, config, input.formulaId ?? null, adminId, now, now);
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    input.packageId, input.jobId, projectId,
    JSON.stringify(minimalPackage(input.packageId, input.candidateId, input.packageFormulaId ?? 'mismatch-version')),
    now, now,
  );
}

/** 直接轮询任务行。GET /api/generations 的投影由 revision-execution 负责,这里只要 DB 真值。 */
async function waitForRevisionRow(jobId: string, timeoutMs = 30_000) {
  const db = app.get(DatabaseService);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db
      .prepare('SELECT id, status, progress, error FROM revision_tasks WHERE job_id=? ORDER BY created_at DESC LIMIT 1')
      .get(jobId) as { id: string; status: string; progress: number; error: string | null } | undefined;
    if (row && ['completed', 'failed'].includes(row.status)) return row;
    await sleep(50);
  }
  throw new Error(`修改任务在 ${timeoutMs}ms 内没有到达终态`);
}

function quotaUsed(): number {
  const db = app.get(DatabaseService);
  const row = db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspaceId) as
    { quota_used: number };
  return Number(row.quota_used);
}

/** 切到 platform 模式并给足额度。apiKey 来自注入选项,所以调用方还要设 platformApiKey。 */
function setPlatformQuota(used: number): void {
  const db = app.get(DatabaseService);
  db.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', monthly_quota=100, quota_used=?, updated_at=? WHERE workspace_id=?",
  ).run(used, new Date().toISOString(), workspaceId);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-revision-invariants-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
    // 显式关掉供应商:不写这行 resolveOptions 会捡起环境里的 OPENAI_API_KEY,用例
    // 就会打到真实中继并随对端状态飘红。需要「扣额度真的发生」的用例自己临时设回来。
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
    jobHeartbeatMs: HEARTBEAT_MS,
    jobClaimTimeoutMs: CLAIM_TIMEOUT_MS,
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
    method: 'POST', body: JSON.stringify({ name: '改稿不变量项目', domain: '去眼袋' }),
  });
  projectId = project.body.id;
  seedApprovedProjectBlueprint(app, projectId);
  // 建出 workspace_settings 行,后面的用例直接改它
  await request('/api/settings');

  const db = app.get(DatabaseService);
  adminId = (db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id;
  workspaceId = (db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string }).id;
  // 项目创建时 formulas.ensureDefault 已经建了 active 版本,拿它的真 id:
  // 要让 formulas.get 成功、扣额度真的发生,失败才会落在模型这一侧。
  formulaVersionId = (db
    .prepare("SELECT id FROM formula_versions WHERE project_id=? AND status='active' ORDER BY version DESC LIMIT 1")
    .get(projectId) as { id: string }).id;
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/*
 * 不变量 2 之一:扣了额度、失败判 other,不退。
 *
 * other 是「消耗了真实算力并产出了可判定结果」那一类(校验不通过、指令与包对不上)。
 * 退它等于白送一次调用。反过来,文案里也绝不能出现「已退还」——那是假承诺,用户
 * 按它去核对账目会发现数字没动。
 *
 * 构造:公式版本给真 id(所以 formulas.get 成功、额度真的被扣),内容包的
 * configSnapshot.formula.versionId 给一个对不上的值,agent.revise 第二行就抛一个
 * 不带 status 的普通 Error。这条路径不发网络请求,不烧任何真实调用。
 */
test('校验类失败(other)不退额度,文案也不承诺退还', async () => {
  const options = app.get<Record<string, unknown>>(APP_OPTIONS);
  const restoreKey = options.platformApiKey;
  // provider().apiKey 在 platform 模式下取注入选项;为空则 processRevision 跳过扣额度,
  // 那样这条用例会退化成「什么都没扣所以没退」,验不到东西。
  options.platformApiKey = 'stub-key';
  setPlatformQuota(3);
  seedCompletedJob({
    jobId: 'job-noref', packageId: 'pkg-noref', candidateId: 'cand-noref',
    formulaId: formulaVersionId, packageFormulaId: 'mismatch-version',
  });

  const before = quotaUsed();
  let row: { status: string; error: string | null };
  try {
    const accepted = await request('/api/generations/job-noref/revise', {
      method: 'POST', body: JSON.stringify({ candidateId: 'cand-noref', instruction: '改一下' }),
    });
    assert.equal(accepted.response.status, 201, `受理应立即返回：${JSON.stringify(accepted.body).slice(0, 200)}`);
    row = await waitForRevisionRow('job-noref');
  } finally {
    options.platformApiKey = restoreKey;
  }

  assert.equal(row.status, 'failed');
  assert.equal(quotaUsed(), before + 1, `校验类失败扣掉的那一次不该退：${before} → ${quotaUsed()}`);
  assert.ok(!(row.error ?? '').includes('已退还'), `不该承诺退还：${row.error}`);
  assert.match(row.error ?? '', /修改失败/u, 'other 类要透出原文给一点线索');
});

/*
 * 不变量 2 之二:失败发生在扣额度之前时,一分都不扣。
 *
 * 额度必须在**确认能调模型之后**才扣。把 consumePlatformQuota 提到前置校验之前,
 * 每一次「公式查不到 / 候选已删除」都会白扣一次:它判 other 不退,用户为一次从未
 * 发生的模型调用付了钱。这条用例锁死那个顺序。
 */
test('还没走到模型就失败时不扣额度', async () => {
  const options = app.get<Record<string, unknown>>(APP_OPTIONS);
  const restoreKey = options.platformApiKey;
  options.platformApiKey = 'stub-key';
  setPlatformQuota(7);
  // formulaId 为 null → formulas.get 抛「公式版本不存在」,发生在扣额度之前
  seedCompletedJob({ jobId: 'job-early', packageId: 'pkg-early', candidateId: 'cand-early', formulaId: null });

  const before = quotaUsed();
  let row: { status: string; error: string | null };
  try {
    await request('/api/generations/job-early/revise', {
      method: 'POST', body: JSON.stringify({ candidateId: 'cand-early', instruction: '改一下' }),
    });
    row = await waitForRevisionRow('job-early');
  } finally {
    options.platformApiKey = restoreKey;
  }

  assert.equal(row.status, 'failed');
  assert.match(row.error ?? '', /公式版本不存在/u, `前提:这条要在 formulas.get 就失败，实际：${row.error}`);
  assert.equal(quotaUsed(), before, `没到模型这一步不该扣额度：${before} → ${quotaUsed()}`);
});

/*
 * 不变量 3:孤儿任务被回收,触顶后判 failed,而旧内容包字节不变。
 *
 * 模拟一个被 kill -9 的实例留下的行:running + 心跳很旧 + attempt_count 已到上限。
 * 回收要判 failed 而不是再入队(否则「打断→重跑→又被打断」会无上限烧模型调用),
 * 并且改稿失败不该让用户已有的产出消失。
 *
 * heartbeat_at 一律写 new Date().toISOString():reclaimStale 的 deadline 是 ISO
 * 格式,而 SQLite 的 datetime('now') 产出空格分隔的 '2026-07-27 20:34:19',
 * ' ' < 'T' 恒真——用 datetime('now') 写心跳等于没写,那行会永远被判成孤儿。
 */
test('孤儿任务触顶后判 failed,旧内容包字节不变', async () => {
  const db = app.get(DatabaseService);
  seedCompletedJob({
    jobId: 'job-orphan', packageId: 'pkg-orphan', candidateId: 'cand-orphan', formulaId: formulaVersionId,
  });
  const before = db.prepare('SELECT content_json, updated_at FROM content_packages WHERE id=?').get('pkg-orphan') as
    { content_json: string; updated_at: string };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        rerun_channels_json, created_by, created_at, updated_at, claimed_by, heartbeat_at)
     VALUES ('rev-orphan', 'job-orphan', 'pkg-orphan', 'cand-orphan', '改一下', 'running', 40, 3,
        '[]', ?, ?, ?, 'host:999:dead', '2020-01-01T00:00:00.000Z')`,
  ).run(adminId, now, now);

  // 等定时回收跑一轮(周期 HEARTBEAT_MS)
  const deadline = Date.now() + 20_000;
  let row = db.prepare('SELECT status, error FROM revision_tasks WHERE id=?').get('rev-orphan') as
    { status: string; error: string | null };
  while (Date.now() < deadline && row.status === 'running') {
    await sleep(50);
    row = db.prepare('SELECT status, error FROM revision_tasks WHERE id=?').get('rev-orphan') as typeof row;
  }

  assert.equal(row.status, 'failed', 'attempt_count 已达上限,回收时应判 failed 而不是再入队');
  assert.match(row.error ?? '', /修改被反复打断/u, `要给可读原因，实际：${row.error}`);
  // 最关键的一条:改稿失败不该让产出消失
  const after = db.prepare('SELECT content_json, updated_at FROM content_packages WHERE id=?').get('pkg-orphan') as
    { content_json: string; updated_at: string };
  assert.equal(after.content_json, before.content_json, '回收判 failed 不能动内容包一个字节');
  assert.equal(after.updated_at, before.updated_at, '回收判 failed 不该碰 updated_at');
  const job = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get('job-orphan') as { status: string };
  assert.equal(job.status, 'completed', '改稿失败不该让产出消失');
  // 事件是排查依据:回收判死必须留痕,否则用户只看到一条 failed 而查不到是谁判的
  const events = (db.prepare('SELECT event FROM generation_events WHERE job_id=?').all('job-orphan') as { event: string }[])
    .map((item) => item.event);
  assert.ok(events.includes('revision_failed'), `回收判死要记事件，实际：${events.join(',') || '无'}`);
  // 终态行不进部分唯一索引,所以这个包还能再提修改——不该被永久锁住
  const active = db
    .prepare("SELECT COUNT(*) AS n FROM revision_tasks WHERE package_id='pkg-orphan' AND status IN ('queued','running')")
    .get() as { n: number };
  assert.equal(Number(active.n), 0);
});

/*
 * 不变量 4 之一:心跳没超时的任务,本实例的定时回收不许碰。
 *
 * 抢走会导致同一任务被两个实例并发执行、各写一次产出,正是 v14 修掉的那个 bug。
 * 判据只看 heartbeat_at、不看 claimed_by:instanceId 含 pid 与随机后缀,重启后是
 * 新身份,按归属放行会让回收把自己正在跑的任务抢回队列。
 *
 * 这里由用例扮演"另一个活着的实例":持续续约心跳,跨过好几个回收周期。
 */
test('心跳新鲜的任务不被回收:别的实例正在正常跑它', async () => {
  const db = app.get(DatabaseService);
  seedCompletedJob({
    jobId: 'job-alive', packageId: 'pkg-alive', candidateId: 'cand-alive', formulaId: formulaVersionId,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        rerun_channels_json, created_by, created_at, updated_at, claimed_by, heartbeat_at)
     VALUES ('rev-alive', 'job-alive', 'pkg-alive', 'cand-alive', '改一下', 'running', 40, 0,
        '[]', ?, ?, ?, 'host:888:other', ?)`,
  ).run(adminId, now, now, now);

  // 跨过至少 5 个回收周期,期间心跳一直新鲜
  const until = Date.now() + HEARTBEAT_MS * 8;
  while (Date.now() < until) {
    db.prepare("UPDATE revision_tasks SET heartbeat_at=? WHERE id='rev-alive'").run(new Date().toISOString());
    await sleep(HEARTBEAT_MS / 4);
  }

  const row = db.prepare('SELECT status, attempt_count, claimed_by FROM revision_tasks WHERE id=?').get('rev-alive') as
    { status: string; attempt_count: number; claimed_by: string | null };
  assert.equal(row.status, 'running', '别的实例正在跑的任务必须原样留着');
  assert.equal(Number(row.attempt_count), 0, '打断计数不能被别的实例的回收污染');
  assert.equal(row.claimed_by, 'host:888:other', '归属不能被抢走');
});

/*
 * 不变量 4 之二:两个实例(独立连接、同一个库文件)对同一条修改任务只有一个领到。
 *
 * job-claim.test.ts 用单连接锁了 claimNext 的原子性;这里换成真实部署的形状——两个
 * DatabaseService 各自打开同一个 app.db。领取靠单条 UPDATE 的 changes 判定,SQLite
 * 单写者模型保证不可能两边都拿到 1。同时验:B 的回收不会抢走 A 正在跑(心跳新鲜)的
 * 那条。
 */
test('两个实例共用同一个库文件:同一条修改任务只被领一次', async () => {
  const twinDir = await mkdtemp(join(tmpdir(), 'ca-revision-twin-'));
  const databasePath = join(twinDir, 'app.db');
  // 迁移幂等,第二个构造只会读到 user_version 已是最新
  const instanceA = new DatabaseService({ dataDir: twinDir, databasePath } as never);
  const instanceB = new DatabaseService({ dataDir: twinDir, databasePath } as never);
  const ID_A = 'host:1001:aaaa';
  const ID_B = 'host:1002:bbbb';
  try {
    const now = new Date().toISOString();
    instanceA.prepare(
      `INSERT INTO users (id, username, password_hash, system_role, created_at, updated_at)
       VALUES ('u1','revision-twin-fixture','x','admin',?,?)`,
    ).run(now, now);
    instanceA.prepare('INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('w1', 'ws', 'ws', 'u1', now, now);
    instanceA.prepare(
      `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES ('p1','w1','proj','项目','u1',?,?)`,
    ).run(now, now);
    instanceA.prepare(
      `INSERT INTO generation_jobs
         (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
          topic, goal, mode, progress, knowledge_context_json, style_profile_version,
          resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
          planning_context_json, image_context_json, research_snapshot_json, quality_status)
       VALUES ('j1','p1','completed','{}','s','u1',?,?,'选题','g','simple',100,'{}',1,
          '{}','{}','{}','{}','[]','{}','unknown')`,
    ).run(now, now);
    // 每条任务落在各自的包上:revision_tasks_active_pkg_idx 禁止同一个包有两条活跃行
    const seedTask = (id: string, packageId: string) => instanceA.prepare(
      `INSERT INTO revision_tasks
         (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
          rerun_channels_json, created_by, created_at, updated_at)
       VALUES (?, 'j1', ?, 'c1', '改一下', 'queued', 0, 0, '[]', 'u1', ?, ?)`,
    ).run(id, packageId, now, now);
    seedTask('rev-1', 'pkg-1');

    // 两个实例同时来领:只有一个能拿到
    const first = claimNext(instanceA, REVISION_TASKS_SPEC, ID_A, new Date().toISOString());
    const second = claimNext(instanceB, REVISION_TASKS_SPEC, ID_B, new Date().toISOString());
    assert.equal(first, 'rev-1');
    assert.equal(second, undefined, '队列已空,第二个实例不该领到同一条');
    const claimed = instanceB.prepare('SELECT claimed_by, status FROM revision_tasks WHERE id=?').get('rev-1') as
      { claimed_by: string; status: string };
    assert.equal(claimed.claimed_by, ID_A, 'B 的连接必须看到 A 的归属');
    assert.equal(claimed.status, 'running', '领取即置 running');

    // A 续约心跳后,B 的回收不许动它
    assert.equal(heartbeatTask(instanceA, REVISION_TASKS_SPEC, 'rev-1', ID_A, new Date().toISOString()), true);
    const reclaimed = reclaimStale(
      instanceB, REVISION_TASKS_SPEC, new Date().toISOString(), 90_000,
      (attempts) => `修改被反复打断（${attempts} 次）`,
    );
    assert.deepEqual(reclaimed, { requeued: [], failed: [] }, 'A 正在跑的任务不该被 B 回收');
    const afterReclaim = instanceA.prepare('SELECT status, claimed_by, attempt_count FROM revision_tasks WHERE id=?')
      .get('rev-1') as { status: string; claimed_by: string; attempt_count: number };
    assert.equal(afterReclaim.status, 'running');
    assert.equal(afterReclaim.claimed_by, ID_A);
    assert.equal(Number(afterReclaim.attempt_count), 0, 'B 的启动不该污染 A 的打断计数');

    // B 只领得到真正排队的那条,A 手上那条不受影响
    seedTask('rev-2', 'pkg-2');
    assert.equal(claimNext(instanceB, REVISION_TASKS_SPEC, ID_B, new Date().toISOString()), 'rev-2');
    const owners = (instanceA.prepare('SELECT id, claimed_by FROM revision_tasks ORDER BY id')
      .all() as { id: string; claimed_by: string }[])
      .map((row) => `${row.id}=${row.claimed_by}`);
    assert.deepEqual(owners, [`rev-1=${ID_A}`, `rev-2=${ID_B}`], '两条任务各归一个实例,没有一条被领两次');

    /*
     * 竞态窗口:两个实例都已经通过「挑最早排队的一条」的子查询,然后才各自 UPDATE。
     *
     * 顺序调用复现不了它——A 的 UPDATE 先落库,B 的子查询就已经看不到那一行了。这里
     * 把 B 的选取结果冻结在 A 动手之前:先让 B 选,再让 A 完整领走,最后让 B 拿着
     * 过期的候选去 UPDATE。外层 UPDATE 的 `AND status='queued'` 是唯一挡住它的东西;
     * 去掉那个守卫,B 会把 A 正在跑的任务改成自己的,同一条修改被两个实例并发执行。
     */
    seedTask('rev-race', 'pkg-race');
    // 钩住 B 的选取语句:它返回候选之后、B 自己 UPDATE 之前,让 A 完整领走这一条。
    // 这样跑的是真正的 claimNext,而不是在用例里重抄一遍它的 SQL——重抄的话
    // 生产代码怎么改这条用例都是绿的。
    const originalPrepare = instanceB.prepare.bind(instanceB);
    let raceInjected = false;
    (instanceB as unknown as { prepare: typeof originalPrepare }).prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes("status='queued'") || !sql.includes('SELECT id')) return statement;
      return {
        ...statement,
        get: (...args: never[]) => {
          const row = (statement.get as (...a: never[]) => unknown)(...args);
          if (!raceInjected) {
            raceInjected = true;
            claimNext(instanceA, REVISION_TASKS_SPEC, ID_A, new Date().toISOString());
          }
          return row;
        },
      } as unknown as ReturnType<typeof originalPrepare>;
    };
    let racedClaim: string | undefined;
    try {
      racedClaim = claimNext(instanceB, REVISION_TASKS_SPEC, ID_B, new Date().toISOString());
    } finally {
      (instanceB as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;
    }
    assert.ok(raceInjected, '前提:竞态确实注入了');
    assert.equal(racedClaim, undefined, 'A 已经在这一瞬间领走了,B 必须认领失败而不是也返回 id');
    const owner = instanceA.prepare('SELECT claimed_by FROM revision_tasks WHERE id=?').get('rev-race') as
      { claimed_by: string };
    assert.equal(owner.claimed_by, ID_A, '归属不能被迟到的那次领取覆盖');
  } finally {
    instanceA.onModuleDestroy?.();
    instanceB.onModuleDestroy?.();
    await rm(twinDir, { recursive: true, force: true });
  }
});
