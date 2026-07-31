import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { SettingsService } from '../src/settings.service.js';

const PASSWORD = 'Project-delete-admin-123!';
const NEW_PASSWORD = 'Project-delete-admin-456!';

interface Session {
  cookie: string;
  csrf: string;
}

let app: NestExpressApplication | undefined;
let dataDir = '';
let baseUrl = '';

async function call(path: string, options: RequestInit = {}, session?: Session) {
  const headers = new Headers(options.headers);
  if (session?.cookie) headers.set('cookie', session.cookie);
  if (session?.csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) {
    headers.set('x-csrf-token', session.csrf);
  }
  if (typeof options.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(baseUrl + path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as any };
}

async function login(username: string, password: string): Promise<Session> {
  const response = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json() as { csrfToken?: string; message?: string };
  assert.equal(response.status, 201, JSON.stringify(body));
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(body.csrfToken);
  return { cookie: setCookie.split(';', 1)[0]!, csrf: body.csrfToken };
}

after(async () => {
  if (app) await app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('soft-deleting a project settles only its active tasks and quota', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-project-delete-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    secureCookies: false,
    logger: false,
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
    jobHeartbeatMs: 60_000,
    jobClaimTimeoutMs: 120_000,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const admin = await login('admin', PASSWORD);
  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  }, admin);
  assert.equal(changed.status, 201, JSON.stringify(changed.body));

  const workspaceCreated = await call('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: '项目删除测试区' }),
  }, admin);
  assert.equal(workspaceCreated.status, 201, JSON.stringify(workspaceCreated.body));
  const workspaceId = String(workspaceCreated.body.id);

  const targetCreated = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name: '待删除项目', domain: '安全审计' }),
  }, admin);
  const siblingCreated = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name: '保留项目', domain: '安全审计' }),
  }, admin);
  assert.equal(targetCreated.status, 201, JSON.stringify(targetCreated.body));
  assert.equal(siblingCreated.status, 201, JSON.stringify(siblingCreated.body));
  const projectId = String(targetCreated.body.id);
  const siblingProjectId = String(siblingCreated.body.id);

  const db = app.get(DatabaseService);
  const adminId = String((db.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id);
  const now = new Date().toISOString();
  const targetQueuedJobId = randomUUID();
  const targetRunningJobId = randomUUID();
  const targetTerminalJobId = randomUUID();
  const targetQueuedRevisionParentId = randomUUID();
  const targetRunningRevisionParentId = randomUUID();
  const siblingRunningJobId = randomUUID();
  const siblingRevisionParentId = randomUUID();
  const insertJob = db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        progress, claimed_by, claimed_at, heartbeat_at)
     VALUES (?, ?, ?, '{}', 'seed', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertJob.run(targetQueuedJobId, projectId, 'queued', adminId, now, now, 0, 'old-target-queued', now, now);
  insertJob.run(targetRunningJobId, projectId, 'running', adminId, now, now, 45, 'old-target-running', now, now);
  insertJob.run(targetTerminalJobId, projectId, 'completed', adminId, now, now, 100, null, null, null);
  insertJob.run(targetQueuedRevisionParentId, projectId, 'completed', adminId, now, now, 100, null, null, null);
  insertJob.run(targetRunningRevisionParentId, projectId, 'completed', adminId, now, now, 100, null, null, null);
  insertJob.run(siblingRunningJobId, siblingProjectId, 'running', adminId, now, now, 35, 'sibling-worker', now, now);
  insertJob.run(siblingRevisionParentId, siblingProjectId, 'completed', adminId, now, now, 100, null, null, null);

  const targetQueuedRevisionId = randomUUID();
  const targetRunningRevisionId = randomUUID();
  const siblingRevisionId = randomUUID();
  const insertRevision = db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, ?, ?, '核实项目删除边界', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  insertRevision.run(targetQueuedRevisionId, targetQueuedRevisionParentId, randomUUID(), 'target-queued', 'queued', 0, adminId, now, now, 'old-revision-queued', now, 2);
  insertRevision.run(targetRunningRevisionId, targetRunningRevisionParentId, randomUUID(), 'target-running', 'running', 55, adminId, now, now, 'old-revision-running', now, 1);
  insertRevision.run(siblingRevisionId, siblingRevisionParentId, randomUUID(), 'sibling-running', 'running', 25, adminId, now, now, 'sibling-revision-worker', now, 1);

  const targetQueuedAnalysisId = randomUUID();
  const targetRunningAnalysisId = randomUUID();
  const siblingAnalysisId = randomUUID();
  const insertAnalysis = db.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, 'project', NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  insertAnalysis.run(targetQueuedAnalysisId, projectId, 'queued', 'target-analysis-queued', adminId, now, now, 'old-analysis-queued', now, 2);
  insertAnalysis.run(targetRunningAnalysisId, projectId, 'running', 'target-analysis-running', adminId, now, now, 'old-analysis-running', now, 1);
  insertAnalysis.run(siblingAnalysisId, siblingProjectId, 'running', 'sibling-analysis-running', adminId, now, now, 'sibling-analysis-worker', now, 1);

  app.get(SettingsService).ensure(workspaceId, adminId);
  db.prepare('UPDATE workspace_settings SET monthly_quota=100, quota_used=12 WHERE workspace_id=?')
    .run(workspaceId);

  const removed = await call('/api/projects/' + projectId, { method: 'DELETE' }, admin);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const projectRow = db.prepare('SELECT deleted_at FROM projects WHERE id=?').get(projectId) as { deleted_at: string | null };
  const siblingProjectRow = db.prepare('SELECT deleted_at FROM projects WHERE id=?').get(siblingProjectId) as { deleted_at: string | null };
  assert.ok(projectRow.deleted_at, '目标项目必须被软删除');
  assert.equal(siblingProjectRow.deleted_at, null, '兄弟项目不能被连带删除');
  const quotaUsed = Number((db.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?')
    .get(workspaceId) as { quota_used: number }).quota_used);
  assert.equal(quotaUsed, 6, '只退目标项目改稿 3 次和分析 3 次未结余额');

  for (const id of [targetQueuedJobId, targetRunningJobId]) {
    const row = db.prepare(
      `SELECT status, progress, error, completed_at, claimed_by, claimed_at, heartbeat_at
         FROM generation_jobs WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.equal(row.progress, 100);
    assert.match(String(row.error), /项目已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.claimed_at, null);
    assert.equal(row.heartbeat_at, null);
  }
  assert.equal(
    (db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(targetTerminalJobId) as { status: string }).status,
    'completed',
    '目标项目既有终态任务不能被改写',
  );
  const siblingJob = db.prepare('SELECT status, claimed_by FROM generation_jobs WHERE id=?')
    .get(siblingRunningJobId) as { status: string; claimed_by: string | null };
  assert.equal(siblingJob.status, 'running');
  assert.equal(siblingJob.claimed_by, 'sibling-worker');

  for (const id of [targetQueuedRevisionId, targetRunningRevisionId]) {
    const row = db.prepare(
      `SELECT status, progress, error, completed_at, claimed_by, heartbeat_at, quota_consumed_count
         FROM revision_tasks WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.equal(row.progress, 100);
    assert.match(String(row.error), /项目已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.quota_consumed_count, 0);
  }
  const siblingRevision = db.prepare(
    'SELECT status, claimed_by, quota_consumed_count FROM revision_tasks WHERE id=?',
  ).get(siblingRevisionId) as Record<string, unknown>;
  assert.equal(siblingRevision.status, 'running');
  assert.equal(siblingRevision.claimed_by, 'sibling-revision-worker');
  assert.equal(siblingRevision.quota_consumed_count, 1);

  for (const id of [targetQueuedAnalysisId, targetRunningAnalysisId]) {
    const row = db.prepare(
      `SELECT status, error, completed_at, claimed_by, heartbeat_at, quota_consumed_count
         FROM analysis_tasks WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.match(String(row.error), /项目已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.quota_consumed_count, 0);
  }
  const siblingAnalysis = db.prepare(
    'SELECT status, claimed_by, quota_consumed_count FROM analysis_tasks WHERE id=?',
  ).get(siblingAnalysisId) as Record<string, unknown>;
  assert.equal(siblingAnalysis.status, 'running');
  assert.equal(siblingAnalysis.claimed_by, 'sibling-analysis-worker');
  assert.equal(siblingAnalysis.quota_consumed_count, 1);

  assert.equal((await call('/api/projects/' + projectId, {}, admin)).status, 404);
  assert.equal((await call('/api/projects/' + siblingProjectId, {}, admin)).status, 200);
  const projects = await call('/api/projects?workspaceId=' + workspaceId, {}, admin);
  assert.deepEqual(projects.body.map((item: any) => item.id), [siblingProjectId]);

  const staleGenerationPackageId = randomUUID();
  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO content_packages
         (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, '{"title":"旧生成执行者产物"}', ?, ?)`,
    ).run(staleGenerationPackageId, targetRunningJobId, projectId, now, now);
    const completed = db.prepare(
      `UPDATE generation_jobs SET status='completed'
        WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).run(targetRunningJobId, 'old-target-running');
    if (completed.changes !== 1) throw new Error('generation claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS value FROM content_packages WHERE id=?')
      .get(staleGenerationPackageId) as { value: number }).value,
    0,
  );

  const staleRevisionPackageId = randomUUID();
  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO content_packages
         (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, '{"title":"旧改稿执行者产物"}', ?, ?)`,
    ).run(staleRevisionPackageId, targetRunningRevisionParentId, projectId, now, now);
    const completed = db.prepare(
      `UPDATE revision_tasks SET status='completed', result_package_id=?
        WHERE id=? AND status='running' AND claimed_by=?`,
    ).run(staleRevisionPackageId, targetRunningRevisionId, 'old-revision-running');
    if (completed.changes !== 1) throw new Error('revision claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS value FROM content_packages WHERE id=?')
      .get(staleRevisionPackageId) as { value: number }).value,
    0,
  );

  const staleAnalysisResultId = randomUUID();
  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO project_intelligence
         (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at)
       VALUES (?, ?, 999, 'draft', 'stale-project-delete-result', '{}', ?, ?, ?)`,
    ).run(staleAnalysisResultId, projectId, adminId, now, now);
    const completed = db.prepare(
      `UPDATE analysis_tasks SET status='completed', result_id=?
        WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).run(staleAnalysisResultId, targetRunningAnalysisId, 'old-analysis-running');
    if (completed.changes !== 1) throw new Error('analysis claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS value FROM project_intelligence WHERE id=?')
      .get(staleAnalysisResultId) as { value: number }).value,
    0,
  );

  const audit = db.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='project.delete' AND entity_id=?",
  ).get(projectId) as { value: number };
  assert.equal(audit.value, 1);
});
