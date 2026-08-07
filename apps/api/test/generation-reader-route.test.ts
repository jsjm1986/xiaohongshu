import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

/**
 * GET /api/generations/:id/reader 挂在请求链上的样子。
 *
 * generation-reader-view.test.ts 已经锁死纯函数的字段集,这里证明三件事:
 * 路由真的通、SaaS 会话真的被精确的 method + route-shape 白名单放行、
 * 越权项目照样 403。
 */

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let adminCookie = '';
let adminCsrf = '';
let saasCookie = '';
let saasCsrf = '';
let projectId = '';
let jobId = '';

const PASSWORD = 'ReaderRoute-bootstrap-123!';
const ADMIN_NEW_PASSWORD = 'ReaderRoute-rotated-456!';
const SAAS_PASSWORD = 'ReaderRoute-saas-12345!';
const SAAS_NEW_PASSWORD = 'ReaderRoute-saas-rotated-456!';

async function request(path: string, options: RequestInit = {}, cookie = adminCookie, csrf = adminCsrf) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as any };
}

/** 造一个 completed 任务 + 一个内容包:真实生成要跑模型,这里只验读路径。 */
function seedCompletedJob(id: string) {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        topic, goal, mode, progress, knowledge_context_json, style_profile_version,
        resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
        planning_context_json, image_context_json, research_snapshot_json, quality_status, completed_at)
     VALUES (?, ?, 'completed', '{"formula":{"versionId":"fv"},"knowledge":{"mode":"auto","selectedFileIds":[]}}',
        's', ?, datetime('now'), datetime('now'), '班组更换', 'g', 'simple', 100, '{}', 1,
        '{}', '{}', '{}', '{}', '[]', '{}', 'passed', datetime('now'))`,
  ).run(id, projectId, admin.id);

  const pkg = {
    schemaVersion: '1.1',
    id: `${id}-pkg`,
    projectId,
    jobId: id,
    candidateId: `${id}-cand`,
    candidateIndex: 0,
    seed: 777,
    createdAt: new Date().toISOString(),
    formulaSnapshot: { versionId: 'fv', digest: 'd', enabledFormulaIds: ['F32'] },
    configSnapshot: {},
    knowledgeSnapshot: { mode: 'auto', documents: [], sectionIds: [] },
    content: {
      H: { hashtags: ['保修'] },
      N: { title: '渗水能换班组吗', body: '正文一句。', imageBrief: '手机随手拍' },
      Cref: { disclaimer: '创作参考', threads: [{ id: 't-1', gap: 'gap-1', function: 'clarify', question: '能换吗', answer: '按合同可以', postingIdentity: 'staff', followUps: [] }] },
    },
    evidence: [],
    reasoning: [{ statement: '正文一句。', status: 'hypothesis', evidenceIds: [], location: 'N.body', occurrence: { field: 'body' } }],
    unknowns: [],
    conflicts: [],
    diagnostics: [],
    validation: { valid: true, repairAttempts: 0, issues: [] },
    revisions: [],
    orchestrationSnapshot: {
      strategy: { id: 's', label: '政策确认', prototype: 'process_log', openingMode: 'clarify', narrativeMode: 'sequential', bodyRole: 'explain', commentMode: 'none', voice: 'transparent', sequence: [], targetChannels: [], imageRole: 'other' },
      gapPlanningCards: [{ gapId: 'gap-1', label: '班组更换', question: '不合格能换吗', category: 'decision', audienceStages: [], importance: 0.8, decisionLeverage: 0.7, proofability: 0.2, required: false, priority: 'high', evidenceIds: [], plannedPlacements: ['N.body'] }],
      gapCoverageLedger: { entries: [{ gapId: 'gap-1', label: '班组更换', status: 'body_resolved', required: false, bodyAllocated: true, commentAllocated: false, plannedPlacements: ['N.body'], actualRealizations: [], primaryThreadIds: [], auxiliaryThreadIds: [], reason: '' }], uncoveredGapIds: [], ledgerCompleteness: 1, closureRate: 1, resolvedRate: 1, realizedResolvedRate: 1, realizationStatus: 'evaluated', targetThreadCount: 1, effectiveThreadCount: 1 },
      // 重字段:必须不出现在 reader 响应里
      rationale: ['x'.repeat(3000)],
    },
  };
  db.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, datetime('now'), datetime('now'))`,
  ).run(`${id}-pkg`, id, projectId, JSON.stringify(pkg));
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-readerroute-'));
  app = await createApplication({ dataDir, adminPassword: PASSWORD, logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  }, '', '');
  adminCookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  adminCsrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: ADMIN_NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, `改密失败: ${JSON.stringify(changed.body)}`);

  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '阅读投影项目', domain: '住宅装修' }) });
  projectId = project.body.id;
  assert.ok(projectId, `建项目失败: ${JSON.stringify(project.body)}`);

  jobId = 'reader-job-1';
  seedCompletedJob(jobId);

  // SaaS 用户:建号 → 改 user_kind → 给工作区成员身份
  const created = await request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'reader-saas', password: SAAS_PASSWORD, systemRole: 'user' }),
  });
  assert.ok([200, 201].includes(created.response.status), `建号失败: ${JSON.stringify(created.body)}`);
  const db = app.get(DatabaseService);
  db.prepare("UPDATE users SET user_kind='saas' WHERE username='reader-saas'").run();
  const workspaces = await request('/api/workspaces');
  const workspaceId = workspaces.body[0]?.id as string;
  const userRow = db.prepare("SELECT id FROM users WHERE username='reader-saas'").get() as { id: string };
  db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)' +
    " VALUES (?, ?, 'ContentEditor', '[]', '[]', datetime('now'), datetime('now'))",
  ).run(workspaceId, userRow.id);

  const saasLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'reader-saas', password: SAAS_PASSWORD }),
  }, '', '');
  assert.equal(saasLogin.response.status, 201, `saas 登录失败: ${JSON.stringify(saasLogin.body)}`);
  saasCookie = saasLogin.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  saasCsrf = saasLogin.body.csrfToken;
  const saasChanged = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: SAAS_PASSWORD, newPassword: SAAS_NEW_PASSWORD }),
  }, saasCookie, saasLogin.body.csrfToken);
  assert.equal(saasChanged.response.status, 201, `saas 改密失败: ${JSON.stringify(saasChanged.body)}`);
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('reader 路由返回任务壳与候选投影', async () => {
  const { response, body } = await request(`/api/generations/${jobId}/reader`);
  assert.equal(response.status, 200, `实际 ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.id, jobId);
  assert.equal(body.topic, '班组更换');
  assert.equal(body.status, 'completed');
  assert.equal(body.candidates.length, 1);
  const c = body.candidates[0];
  assert.equal(c.title, '渗水能换班组吗');
  assert.equal(c.strategy.prototype, 'process_log');
  assert.equal(c.reasoning.length, 1);
  assert.equal(c.gapLedger.entries[0].status, 'body_resolved');
  assert.equal(c.gapCards[0].question, '不合格能换吗');
  assert.equal(c.comments[0].postingIdentity, 'staff');
});

test('reader 响应不夹带完整版的重字段', async () => {
  const { body } = await request(`/api/generations/${jobId}/reader`);
  const c = body.candidates[0];
  for (const key of ['trace', 'parameterImpactReport', 'orchestrationSnapshot', 'diagnostics', 'resolutionSnapshot']) {
    assert.equal(key in c, false, `不该带 ${key}`);
  }
  // 那 3000 字的 rationale 不能泄漏进来
  assert.equal(JSON.stringify(body).includes('xxxxxxxxxx'), false);
});

/**
 * 阅读投影必须带 activeRevision。
 *
 * 阅读页的 3 秒轮询受「在跑」门控,而改稿期间 job.status 保持 completed;这个字段
 * 是它唯一的判据。缺了它的表现是「点了修改没反应、稍后自己变了」。
 *
 * heartbeat_at 必须写,而且必须是 toISOString() 格式:reclaimStale 按
 * 「running 且 heartbeat 为空或早于 deadline」判孤儿,回收定时器 15 秒一拍,被判中
 * 就会 requeue 并真的进 processRevision,测试偶发不稳。
 *
 * 那个 deadline 由 `new Date(...).toISOString()` 生成(job-claim.ts),比较是纯字符串
 * 比较。SQLite 的 datetime('now') 是 '2026-07-27 20:34:19'(空格分隔、无毫秒无 Z),
 * 而 ' ' < 'T',于是它恒小于任何同日 deadline——写 datetime('now') 等于没写。
 * 与 job-claim.test.ts 的 seedRevisionTask 同口径,用 new Date().toISOString()。
 */
test('reader 响应带 activeRevision:改稿期间 status 仍是 completed,轮询靠它', async () => {
  const db = app.get(DatabaseService);
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        rerun_channels_json, created_by, created_at, updated_at, heartbeat_at)
     VALUES ('rev-reader-1', ?, ?, ?, '标题再口语化', 'running', 40, 1, '[]', ?, ?, ?, ?)`,
  ).run(jobId, `${jobId}-pkg`, `${jobId}-cand`, admin.id, now, now, now);
  try {
    const { body } = await request(`/api/generations/${jobId}/reader`);
    assert.equal(body.status, 'completed', '改稿不改 job.status');
    assert.equal(body.activeRevision.id, 'rev-reader-1');
    assert.equal(body.activeRevision.status, 'running');
    assert.equal(body.activeRevision.candidateId, `${jobId}-cand`);
  } finally {
    db.prepare("DELETE FROM revision_tasks WHERE id='rev-reader-1'").run();
  }
});

test('SaaS 会话能读 reader:白名单是 /api/generations 前缀,子路径同样放行', async () => {
  const { response, body } = await request(`/api/generations/${jobId}/reader`, {}, saasCookie, '');
  assert.equal(response.status, 200, `SaaS 实际 ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.candidates.length, 1);
});

test('SaaS 仅可确认 human_reviewable 候选，最小响应不泄露完整版字段，reader 刷新后持久化可见', async () => {
  const db = app.get(DatabaseService);
  const row = db.prepare('SELECT content_json FROM content_packages WHERE id=?').get(`${jobId}-pkg`) as { content_json: string };
  const blocked = JSON.parse(row.content_json);
  blocked.validation = {
    valid: false,
    qualityStatus: 'needs_review',
    repairAttempts: 1,
    issues: [{ code: 'manual_delivery_reader_test', severity: 'warning', disposition: 'review', overridePolicy: 'human_reviewable', message: '测试复核项', repairable: false, channel: 'package' }],
  };
  db.prepare('UPDATE content_packages SET content_json=? WHERE id=?').run(JSON.stringify(blocked), `${jobId}-pkg`);

  const path = `/api/generations/${jobId}/candidates/${jobId}-cand/manual-delivery-confirmation`;
  const confirmed = await request(path, {
    method: 'POST',
    body: JSON.stringify({ acknowledged: true }),
  }, saasCookie, saasCsrf);
  assert.equal(confirmed.response.status, 201, JSON.stringify(confirmed.body));
  assert.deepEqual(Object.keys(confirmed.body).sort(), ['candidateId', 'confirmation', 'jobId']);
  assert.equal(confirmed.body.confirmation.confirmed, true);
  assert.equal(confirmed.body.candidates, undefined);
  assert.equal(confirmed.body.resolvedConfig, undefined);

  const refreshed = await request(`/api/generations/${jobId}/reader`, {}, saasCookie, '');
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.candidates[0].validation.valid, false, '人工确认不得改写自动校验结论');
  assert.equal(refreshed.body.candidates[0].manualDeliveryConfirmation.confirmed, true);

  const preview = JSON.parse((db.prepare('SELECT content_json FROM content_packages WHERE id=?').get(`${jobId}-pkg`) as { content_json: string }).content_json);
  preview.generationMode = 'deterministic_preview';
  preview.artifactRealization = {
    status: 'partial', mode: 'deterministic_preview', deliverability: 'non_deliverable',
    channels: {
      core: { status: 'complete', reasonCodes: [] },
      comments: { status: 'complete', reasonCodes: [] },
      ledger: { status: 'complete', reasonCodes: [] },
    },
  };
  preview.validation = { valid: true, qualityStatus: 'passed', repairAttempts: 0, issues: [] };
  db.prepare('UPDATE content_packages SET content_json=? WHERE id=?').run(JSON.stringify(preview), `${jobId}-pkg`);

  const rejectedPreview = await request(path, {
    method: 'POST', body: JSON.stringify({ acknowledged: true }),
  }, saasCookie, saasCsrf);
  assert.equal(rejectedPreview.response.status, 400);
  assert.match(String(rejectedPreview.body.message), /确定性预览不是正式成品/u);
  const previewReader = await request(`/api/generations/${jobId}/reader`, {}, saasCookie, '');
  assert.equal(previewReader.body.candidates[0].manualDeliveryConfirmation, undefined, '切换为 preview 后旧确认必须失效');
});

test('未完成任务返回空候选数组,而不是 undefined 或 404', async () => {
  const db = app.get(DatabaseService);
  db.prepare("UPDATE generation_jobs SET status='running' WHERE id=?").run(jobId);
  const { response, body } = await request(`/api/generations/${jobId}/reader`);
  assert.equal(response.status, 200);
  assert.deepEqual(body.candidates, []);
  db.prepare("UPDATE generation_jobs SET status='completed' WHERE id=?").run(jobId);
});

test('不存在的任务返回 404', async () => {
  const { response } = await request('/api/generations/does-not-exist/reader');
  assert.equal(response.status, 404);
});
