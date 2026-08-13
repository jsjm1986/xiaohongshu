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

const ADMIN_PASSWORD = 'Workspace-delete-admin-123!';
const ADMIN_NEW_PASSWORD = 'Workspace-delete-admin-456!';
const OWNER_PASSWORD = 'Workspace-delete-owner-123!';
const OWNER_NEW_PASSWORD = 'Workspace-delete-owner-456!';

interface Session {
  cookie: string;
  csrf: string;
}

let app: NestExpressApplication | undefined;
let dataDir = '';
let baseUrl = '';

async function startApplication(): Promise<void> {
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: ADMIN_PASSWORD,
    secureCookies: false,
    logger: false,
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}

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
  assert.equal(response.status, 201, username + ' 登录失败：' + JSON.stringify(body));
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.ok(body.csrfToken);
  return { cookie: setCookie.split(';', 1)[0]!, csrf: body.csrfToken };
}

async function changePassword(session: Session, currentPassword: string, newPassword: string): Promise<void> {
  const result = await call('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  }, session);
  assert.equal(result.status, 201, JSON.stringify(result.body));
}

after(async () => {
  if (app) await app.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('soft-deleting a workspace closes every access path and skips restart bootstrap', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-workspace-delete-'));
  await startApplication();

  const admin = await login('admin', ADMIN_PASSWORD);
  await changePassword(admin, ADMIN_PASSWORD, ADMIN_NEW_PASSWORD);

  const ownerCreated = await call('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: 'workspace-owner', password: OWNER_PASSWORD, systemRole: 'user' }),
  }, admin);
  assert.equal(ownerCreated.status, 201, JSON.stringify(ownerCreated.body));
  const ownerId = String(ownerCreated.body.id);

  const workspaceCreated = await call('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: '待删除工作区', ownerUserId: ownerId }),
  }, admin);
  assert.equal(workspaceCreated.status, 201, JSON.stringify(workspaceCreated.body));
  const workspaceId = String(workspaceCreated.body.id);

  const owner = await login('workspace-owner', OWNER_PASSWORD);
  await changePassword(owner, OWNER_PASSWORD, OWNER_NEW_PASSWORD);
  const projectCreated = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, name: '删除边界项目', domain: '安全审计' }),
  }, owner);
  assert.equal(projectCreated.status, 201, JSON.stringify(projectCreated.body));
  const projectId = String(projectCreated.body.id);

  const db = app!.get(DatabaseService);
  const knowledgeId = randomUUID();
  const jobId = randomUUID();
  const packageId = randomUUID();
  const queuedJobId = randomUUID();
  const runningJobId = randomUUID();
  const queuedRevisionParentId = randomUUID();
  const runningRevisionParentId = randomUUID();
  const queuedRevisionId = randomUUID();
  const runningRevisionId = randomUUID();
  const queuedAnalysisId = randomUUID();
  const runningAnalysisId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO knowledge_files " +
      "(id, project_id, filename, storage_path, media_type, bytes, sha256, version, " +
      "category, evidence_status, metadata_json, created_by, created_at, updated_at) " +
      "VALUES (?, ?, 'private.md', 'knowledge/private.md', 'text/markdown', 7, 'digest', 1, " +
      "'reference', 'unknown', '{}', ?, ?, ?)",
  ).run(knowledgeId, projectId, ownerId, now, now);
  db.prepare(
    "INSERT INTO generation_jobs " +
      "(id, project_id, status, config_json, seed, created_by, created_at, updated_at, " +
      "topic, goal, mode, progress, knowledge_context_json, style_profile_version, " +
      "resolution_snapshot_json, config_impact_json, opportunity_snapshot_json, " +
      "planning_context_json, image_context_json, research_snapshot_json, quality_status) " +
      "VALUES (?, ?, 'completed', '{}', 'seed', ?, ?, ?, '私有选题', '私有目标', 'simple', 100, " +
      "'{}', 1, '{}', '{}', '{}', '{}', '[]', '{}', 'passed')",
  ).run(jobId, projectId, ownerId, now, now);
  db.prepare(
    "INSERT INTO content_packages " +
      "(id, job_id, project_id, candidate_index, content_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, 0, " +
      "'{\"title\":\"私有内容\",\"validation\":{\"valid\":true,\"qualityStatus\":\"passed\",\"issues\":[]}}', ?, ?)",
  ).run(packageId, jobId, projectId, now, now);

  const insertJob = db.prepare(
    `INSERT INTO generation_jobs
       (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
        progress, claimed_by, claimed_at, heartbeat_at)
     VALUES (?, ?, ?, '{}', 'seed', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertJob.run(
    queuedJobId, projectId, 'queued', ownerId, now, now, 0,
    'old-queued-generation', now, now,
  );
  insertJob.run(
    runningJobId, projectId, 'running', ownerId, now, now, 45,
    'old-running-generation', now, now,
  );
  insertJob.run(
    queuedRevisionParentId, projectId, 'completed', ownerId, now, now, 100,
    null, null, null,
  );
  insertJob.run(
    runningRevisionParentId, projectId, 'completed', ownerId, now, now, 100,
    null, null, null,
  );

  const insertRevision = db.prepare(
    `INSERT INTO revision_tasks
       (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, ?, ?, '核实删除边界', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  insertRevision.run(
    queuedRevisionId, queuedRevisionParentId, randomUUID(), 'queued-candidate',
    'queued', 0, ownerId, now, now, 'old-queued-revision', now, 2,
  );
  insertRevision.run(
    runningRevisionId, runningRevisionParentId, randomUUID(), 'running-candidate',
    'running', 55, ownerId, now, now, 'old-running-revision', now, 1,
  );

  const insertAnalysis = db.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, 'project', NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  );
  insertAnalysis.run(
    queuedAnalysisId, projectId, 'queued', 'delete-queued-analysis', ownerId, now, now,
    'old-queued-analysis', now, 2,
  );
  insertAnalysis.run(
    runningAnalysisId, projectId, 'running', 'delete-running-analysis', ownerId, now, now,
    'old-running-analysis', now, 1,
  );

  app!.get(SettingsService).ensure(workspaceId, ownerId);
  db.prepare('UPDATE workspace_settings SET monthly_quota=100, quota_used=10 WHERE workspace_id=?')
    .run(workspaceId);

  const keyCreated = await call('/api/workspaces/' + workspaceId + '/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name: '删除边界 Key' }),
  }, owner);
  assert.equal(keyCreated.status, 201, JSON.stringify(keyCreated.body));
  const apiKey = String(keyCreated.body.key);
  const apiKeyId = String(keyCreated.body.id);
  const keyHeaders = { authorization: 'Bearer ' + apiKey };

  assert.equal((await call('/api/projects/' + projectId, {}, owner)).status, 200);
  assert.equal((await call('/api/projects/' + projectId, {}, admin)).status, 200);
  const keyProjects = await call('/v1/projects?workspaceId=' + workspaceId, { headers: keyHeaders });
  assert.equal(keyProjects.status, 200);
  assert.deepEqual(keyProjects.body.map((item: any) => item.id), [projectId]);
  assert.equal((await call('/v1/knowledge/files?projectId=' + projectId, { headers: keyHeaders })).body.length, 1);
  const keyJobs = await call('/v1/generation-jobs?projectId=' + projectId, { headers: keyHeaders });
  assert.deepEqual(
    new Set(keyJobs.body.map((item: any) => item.id)),
    new Set([jobId, queuedJobId, runningJobId, queuedRevisionParentId, runningRevisionParentId]),
  );
  assert.equal((await call('/v1/content-packages/' + packageId, { headers: keyHeaders })).status, 200);
  assert.equal((await call('/v1/knowledge/files?workspaceId=' + workspaceId, {}, admin)).body.length, 1);

  const removed = await call('/api/workspaces/' + workspaceId, { method: 'DELETE' }, owner);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const workspaceRow = db.prepare('SELECT deleted_at FROM workspaces WHERE id=?').get(workspaceId) as { deleted_at: string | null };
  const keyRow = db.prepare('SELECT revoked_at FROM api_keys WHERE id=?').get(apiKeyId) as { revoked_at: string | null };
  const projectRow = db.prepare('SELECT deleted_at FROM projects WHERE id=?').get(projectId) as { deleted_at: string | null };
  assert.ok(workspaceRow.deleted_at, '工作区必须被软删除');
  assert.ok(keyRow.revoked_at, '删除工作区必须同步撤销仍有效的 API Key');
  assert.equal(projectRow.deleted_at, null, '子项目应保留，访问阻断不能依赖物理删除或级联软删');
  const quotaRow = db.prepare(
    'SELECT quota_used FROM workspace_settings WHERE workspace_id=?',
  ).get(workspaceId) as { quota_used: number };
  assert.equal(quotaRow.quota_used, 4, '删除应退还改稿 3 次与分析 3 次未结余额');

  for (const id of [queuedJobId, runningJobId]) {
    const row = db.prepare(
      `SELECT status, progress, error, completed_at, claimed_by, claimed_at, heartbeat_at
         FROM generation_jobs WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.equal(row.progress, 100);
    assert.match(String(row.error), /工作区已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.claimed_at, null);
    assert.equal(row.heartbeat_at, null);
  }
  for (const id of [queuedRevisionId, runningRevisionId]) {
    const row = db.prepare(
      `SELECT status, progress, error, completed_at, claimed_by, heartbeat_at, quota_consumed_count
         FROM revision_tasks WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.equal(row.progress, 100);
    assert.match(String(row.error), /工作区已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.quota_consumed_count, 0);
  }
  for (const id of [queuedAnalysisId, runningAnalysisId]) {
    const row = db.prepare(
      `SELECT status, error, completed_at, claimed_by, heartbeat_at, quota_consumed_count
         FROM analysis_tasks WHERE id=?`,
    ).get(id) as Record<string, unknown>;
    assert.equal(row.status, 'failed');
    assert.match(String(row.error), /工作区已删除/u);
    assert.ok(row.completed_at);
    assert.equal(row.claimed_by, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.quota_consumed_count, 0);
  }
  assert.equal(
    (db.prepare('SELECT status FROM generation_jobs WHERE id=?').get(jobId) as { status: string }).status,
    'completed',
    '既有终态任务不能被删除结算改写',
  );

  const staleGenerationPackageId = randomUUID();
  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO content_packages
         (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, '{"title":"旧执行者越权产物"}', ?, ?)`,
    ).run(staleGenerationPackageId, runningJobId, projectId, now, now);
    const completed = db.prepare(
      `UPDATE generation_jobs SET status='completed'
        WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).run(runningJobId, 'old-running-generation');
    if (completed.changes !== 1) throw new Error('generation claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS value FROM content_packages WHERE id=?')
      .get(staleGenerationPackageId) as { value: number }).value,
    0,
    '生成旧执行者的内容包必须随终态 CAS 失败回滚',
  );

  const staleAnalysisResultId = randomUUID();
  assert.throws(() => db.transaction(() => {
    db.prepare(
      `INSERT INTO project_intelligence
         (id, project_id, version, status, source_fingerprint, map_json, created_by, created_at, updated_at)
       VALUES (?, ?, 999, 'draft', 'stale-delete-result', '{}', ?, ?, ?)`,
    ).run(staleAnalysisResultId, projectId, ownerId, now, now);
    const completed = db.prepare(
      `UPDATE analysis_tasks SET status='completed', result_id=?
        WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).run(staleAnalysisResultId, runningAnalysisId, 'old-running-analysis');
    if (completed.changes !== 1) throw new Error('analysis claim lost');
  }), /claim lost/u);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS value FROM project_intelligence WHERE id=?')
      .get(staleAnalysisResultId) as { value: number }).value,
    0,
    '分析旧执行者的结果必须随终态 CAS 失败回滚',
  );

  const me = await call('/api/auth/me', {}, owner);
  assert.equal(me.status, 200, '删除工作区不应无故注销用户会话');
  assert.equal(me.body.user.workspaceRole, null, '展示角色不能来自已删除工作区');
  for (const session of [owner, admin]) {
    assert.equal((await call('/api/workspaces/' + workspaceId, {}, session)).status, 404);
    assert.equal((await call('/api/projects/' + projectId, {}, session)).status, 404);
    assert.equal((await call('/api/knowledge/' + knowledgeId, {}, session)).status, 404);
    assert.equal((await call('/api/generations/' + jobId, {}, session)).status, 404);
    assert.equal((await call('/api/projects/' + projectId + '/research/overview', {}, session)).status, 404);
  }
  assert.equal((await call('/api/settings?workspaceId=' + workspaceId, {}, admin)).status, 404);
  assert.equal((await call('/v1/projects', { headers: keyHeaders })).status, 401);

  const adminProjects = await call('/v1/projects?workspaceId=' + workspaceId, {}, admin);
  const adminKnowledge = await call('/v1/knowledge/files?workspaceId=' + workspaceId, {}, admin);
  const adminJobs = await call('/v1/generation-jobs?workspaceId=' + workspaceId, {}, admin);
  const adminPackage = await call('/v1/content-packages/' + packageId, {}, admin);
  assert.deepEqual(adminProjects.body, []);
  assert.deepEqual(adminKnowledge.body, []);
  assert.deepEqual(adminJobs.body, []);
  assert.equal(adminPackage.status, 404);

  db.prepare('DELETE FROM research_claims WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM release_manifests WHERE project_id=?').run(projectId);
  assert.equal((db.prepare('SELECT COUNT(*) AS value FROM research_claims WHERE project_id=?').get(projectId) as { value: number }).value, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS value FROM release_manifests WHERE project_id=?').get(projectId) as { value: number }).value, 0);

  await app!.close();
  app = undefined;
  await startApplication();
  const restartedDb = app!.get(DatabaseService);
  assert.equal(
    (restartedDb.prepare('SELECT COUNT(*) AS value FROM research_claims WHERE project_id=?').get(projectId) as { value: number }).value,
    0,
    '重启时不能为已删除工作区重新导入研究目录',
  );
  assert.equal(
    (restartedDb.prepare('SELECT COUNT(*) AS value FROM release_manifests WHERE project_id=?').get(projectId) as { value: number }).value,
    0,
    '重启时不能为已删除工作区重建发布清单',
  );
});
