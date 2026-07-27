import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
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
