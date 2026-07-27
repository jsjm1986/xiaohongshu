import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

const PASSWORD = 'RevEnq-bootstrap-123!';
const NEW_PASSWORD = 'RevEnq-updated-456!';

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
 * diagnostics / evidence / unknowns / conflicts,少一个 GET job 就 500。这里给齐
 * 空集合而不是 `{H:{},N:{},Cref:{}}`,本用例关心的是入队与投影,不是包的内容。
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

/** 造一条 completed 任务 + 一个内容包,revise 的前提。 */
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

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-revision-enqueue-'));
  app = await createApplication({
    dataDir, adminUsername: 'admin', adminPassword: PASSWORD,
    masterEncryptionKey: 'integration-test-master-encryption-key', logger: false,
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
    method: 'POST', body: JSON.stringify({ name: '修改任务项目', domain: '去眼袋' }),
  });
  projectId = project.body.id;
  // workspace_settings 由 SettingsService.ensure 懒建。读一次 /api/settings 把行
  // 建出来,后面的"额度没被扣"断言才有行可查。
  await request('/api/settings');
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('入队后立即返回,不等模型;job.status 保持 completed', async () => {
  seedCompletedJob('job-a', 'pkg-a', 'cand-a');
  const started = Date.now();
  const result = await request('/api/generations/job-a/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-a', instruction: '正文不要有价格' }),
  });
  const elapsed = Date.now() - started;
  assert.ok([200, 201].includes(result.response.status), `受理失败：${JSON.stringify(result.body)}`);
  // 同步实现会在这里阻塞几分钟。5 秒是宽松上限,只要不是"等模型跑完"就够。
  assert.ok(elapsed < 5_000, `受理应立即返回,实际 ${elapsed}ms`);

  const db = app.get(DatabaseService);
  const job = db.prepare('SELECT status FROM generation_jobs WHERE id=?').get('job-a') as { status: string };
  assert.equal(job.status, 'completed', '改稿期间 job.status 必须保持 completed');
  // 受理返回体里的状态是确定的 queued:领取推到了下一拍(见 enqueueRevision)。
  // 库里的 status 不断言——执行已接上,读的时候它可能已经在跑或已收敛,那是对的。
  assert.equal(result.body.activeRevision.status, 'queued', '按下按钮那一刻应当看到排队中');
  const task = db.prepare('SELECT status, package_id, candidate_id, instruction FROM revision_tasks WHERE job_id=?')
    .get('job-a') as { status: string; package_id: string; candidate_id: string; instruction: string };
  assert.equal(task.package_id, 'pkg-a', 'package_id 是入队时解析出的权威目标');
  assert.equal(task.candidate_id, 'cand-a', 'candidate_id 保留用户传入的原值');
  assert.equal(task.instruction, '正文不要有价格');
});

test('GET job 带上活跃修改任务,候选仍是旧版本', async () => {
  seedCompletedJob('job-b', 'pkg-b', 'cand-b');
  const accepted = await request('/api/generations/job-b/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-b', instruction: '换个开头' }),
  });
  assert.equal(accepted.body.activeRevision.status, 'queued', '受理返回体里应当是排队中');
  const detail = await request('/api/generations/job-b');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.status, 'completed');
  // 状态不断言:执行已接上,这条手塞任务(formula_version_id 为空)会很快失败。
  // 这里要的是「投影一直带着这条修改任务、指令没丢」。
  assert.ok(detail.body.activeRevision, '投影里要有 activeRevision');
  assert.equal(detail.body.activeRevision.instruction, '换个开头');
  // 用户在改稿期间必须还能看旧稿
  assert.ok(Array.isArray(detail.body.candidates) && detail.body.candidates.length > 0, '旧候选必须还在');
});

test('指令为空直接拒绝,不入队、不扣额度', async () => {
  seedCompletedJob('job-c', 'pkg-c', 'cand-c');
  const db = app.get(DatabaseService);
  const before = db.prepare('SELECT quota_used FROM workspace_settings LIMIT 1').get() as { quota_used: number };
  const result = await request('/api/generations/job-c/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-c', instruction: '   ' }),
  });
  assert.equal(result.response.status, 400);
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-c') as { n: number };
  assert.equal(count.n, 0, '拒绝的请求不该留下任务行');
  const after = db.prepare('SELECT quota_used FROM workspace_settings LIMIT 1').get() as { quota_used: number };
  assert.equal(after.quota_used, before.quota_used, '拒绝在扣额度之前发生');
});

test('候选 id 找不到报 404,不入队', async () => {
  seedCompletedJob('job-d', 'pkg-d', 'cand-d');
  const result = await request('/api/generations/job-d/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: '不存在的候选', instruction: '改一下' }),
  });
  assert.equal(result.response.status, 404);
  const db = app.get(DatabaseService);
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-d') as { n: number };
  assert.equal(count.n, 0);
});

test('未完成的任务不能改', async () => {
  const db = app.get(DatabaseService);
  seedCompletedJob('job-e', 'pkg-e', 'cand-e');
  db.prepare("UPDATE generation_jobs SET status='running' WHERE id=?").run('job-e');
  const result = await request('/api/generations/job-e/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-e', instruction: '改一下' }),
  });
  assert.equal(result.response.status, 400);
});

/**
 * 直接插一条修改任务行,绕过应用层的 pending 检查。
 *
 * heartbeat_at 写 ISO 格式(不是 datetime('now')):reclaimStale 的 deadline 是
 * `new Date(...).toISOString()`,而 SQLite 的空格分隔格式恒小于同日 ISO deadline,
 * 写它等于没写,行会被判成孤儿并真的进 processRevision。
 */
function insertTaskRow(id: string, jobId: string, packageId: string, status: string, candidateId = 'c'): void {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        rerun_channels_json, created_by, created_at, updated_at, heartbeat_at)
     VALUES (?, ?, ?, ?, 'i', ?, 0, 0, '[]', ?, ?, ?, ?)`,
  ).run(id, jobId, packageId, candidateId, status, admin.id, now, now, now);
}

test('DB 层挡住同一篇稿子的第二条活跃修改(应用层检查失效时的最后防线)', () => {
  seedCompletedJob('job-g', 'pkg-g', 'cand-g');
  insertTaskRow('rev-g1', 'job-g', 'pkg-g', 'queued');
  // 绕过应用层直接插第二条。多实例下两个进程能在彼此的「查 pending」与「INSERT」
  // 之间穿插,应用层的先查后写拦不住,只有部分唯一索引拦得住。
  assert.throws(
    () => insertTaskRow('rev-g2', 'job-g', 'pkg-g', 'running'),
    /UNIQUE constraint failed/,
    '缺 revision_tasks_active_job_idx 时这里会插进去',
  );
  const db = app.get(DatabaseService);
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-g') as { n: number };
  assert.equal(count.n, 1);
});

/*
 * 互斥是 job 级的:同一个 job 的**另一个候选**同样挡住。
 *
 * 包级互斥会放过这一条,而投影 activeFor(jobId) 只回一条活跃任务——先提交的那个候选在
 * 轮询里看不到自己的任务、立刻判「已完成」,把未更新的旧候选当成改稿结果报给用户。
 */
test('同一 job 的另一个候选也挡住:互斥是 job 级', () => {
  const db = app.get(DatabaseService);
  seedCompletedJob('job-j', 'pkg-j1', 'cand-j1');
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES ('pkg-j2', 'job-j', ?, 1, ?, datetime('now'), datetime('now'))`,
  ).run(projectId, JSON.stringify(minimalPackage('pkg-j2', 'cand-j2')));
  insertTaskRow('rev-j1', 'job-j', 'pkg-j1', 'running');
  assert.throws(
    () => insertTaskRow('rev-j2', 'job-j', 'pkg-j2', 'queued'),
    /UNIQUE constraint failed/,
    '包级互斥会放过它,于是同一 job 的两个候选并发改稿',
  );
});

test('终态行不占名额:同一篇稿子改完还能再改', () => {
  seedCompletedJob('job-h', 'pkg-h', 'cand-h');
  insertTaskRow('rev-h1', 'job-h', 'pkg-h', 'completed');
  insertTaskRow('rev-h2', 'job-h', 'pkg-h', 'failed');
  // 索引带 WHERE status IN ('queued','running'),终态行不进索引。少了这个条件就成了
  // 「一篇稿子一辈子只能改一次」。
  insertTaskRow('rev-h3', 'job-h', 'pkg-h', 'queued');
  const db = app.get(DatabaseService);
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-h') as { n: number };
  assert.equal(count.n, 3);
});

test('索引被踩到时报 409,不是 500', async () => {
  seedCompletedJob('job-i', 'pkg-i', 'cand-i');
  insertTaskRow('rev-i1', 'job-i', 'pkg-i', 'queued');
  const db = app.get(DatabaseService);
  const original = db.prepare.bind(db);
  // 复现多实例竞态:让 pending 查询装作没看见已存在的活跃任务(等价于另一个实例在
  // 我们读完之后才插进去),于是 INSERT 撞索引。用户该看到 409 而不是 500。
  (db as unknown as { prepare: typeof original }).prepare = (sql: string) => {
    const statement = original(sql);
    if (sql.includes('FROM revision_tasks WHERE job_id=?') && sql.includes('queued')) {
      return { ...statement, get: () => undefined } as unknown as ReturnType<typeof original>;
    }
    return statement;
  };
  try {
    const result = await request('/api/generations/job-i/revise', {
      method: 'POST', body: JSON.stringify({ candidateId: 'cand-i', instruction: '并发提交' }),
    });
    assert.equal(result.response.status, 409, `实际 ${result.response.status}：${JSON.stringify(result.body)}`);
    assert.match(String(result.body.message), /修改正在进行/);
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE package_id=?').get('pkg-i') as { n: number };
  assert.equal(count.n, 1, '撞索引的那条不该留下半行');
});

/*
 * 假成功的完整链路,锁在受理这一层。
 *
 * 包级互斥下:A 候选在改 → B 候选(另一标签页/另一用户)入队成功 → 投影
 * activeFor(jobId) 只回**最近一条**,于是 A 的轮询里 candidateId 对不上、
 * isRevisionInFlight 为 false、循环立刻退出,前端拿到未更新的旧候选却提示「已按意见
 * 修改」。断言两件事:B 拿到 409 而不是被受理;A 的活跃任务仍然是 A 自己那条(投影没被
 * 顶掉),所以 A 的轮询不会假成功。
 */
test('同 job 的第二个候选入队被拒,第一个候选的投影不被顶掉', async () => {
  const db = app.get(DatabaseService);
  seedCompletedJob('job-k', 'pkg-k1', 'cand-k1');
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES ('pkg-k2', 'job-k', ?, 1, ?, datetime('now'), datetime('now'))`,
  ).run(projectId, JSON.stringify(minimalPackage('pkg-k2', 'cand-k2')));
  // A 候选:手塞 running 行,模拟"正在改"且不会自己跑完
  insertTaskRow('rev-k1', 'job-k', 'pkg-k1', 'running', 'cand-k1');

  const second = await request('/api/generations/job-k/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-k2', instruction: '另一个候选也改' }),
  });
  assert.equal(second.response.status, 409, `包级互斥会放过它并造成假成功，实际 ${second.response.status}`);

  const detail = await request('/api/generations/job-k');
  assert.equal(detail.body.activeRevision.id, 'rev-k1', '投影里的活跃任务必须还是第一个候选那条');
  assert.equal(detail.body.activeRevision.candidateId, 'cand-k1');
  assert.equal(detail.body.activeRevision.status, 'running', '第一个候选还在改,不能被显示成已完成');
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-k') as { n: number };
  assert.equal(Number(count.n), 1, '被拒的那次不该留下任务行');
});

test('同一候选已有排队中的修改时不重复入队', async () => {
  seedCompletedJob('job-f', 'pkg-f', 'cand-f');
  const first = await request('/api/generations/job-f/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-f', instruction: '第一次' }),
  });
  assert.ok([200, 201].includes(first.response.status));
  const second = await request('/api/generations/job-f/revise', {
    method: 'POST', body: JSON.stringify({ candidateId: 'cand-f', instruction: '第二次' }),
  });
  assert.equal(second.response.status, 409, '重复提交应 409,而不是排两条改同一个包');
  const db = app.get(DatabaseService);
  const count = db.prepare('SELECT COUNT(*) AS n FROM revision_tasks WHERE job_id=?').get('job-f') as { n: number };
  assert.equal(count.n, 1);
});
