import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createFormulaVersion, DEFAULT_FORMULA_VERSION, type FormulaDefinition } from '@content-agent/agent-core';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

const ADMIN_PASSWORD = 'Admin-bootstrap-123!';
const ADMIN_NEW_PASSWORD = 'Admin-updated-456!';
let app: NestExpressApplication;
let dataDir: string;
let baseUrl: string;
let adminCookie = '';
let adminCsrf = '';
let workspaceId = '';
let projectId = '';

interface ApiResponse {
  response: Response;
  body: any;
}

const LEGACY_OFFICIAL_F30 = {
  id: 'F30',
  title: '热点相关性与合格触达',
  type: 'proxy',
  equation: 'TrendFit=Relevance·BridgeClarity·Timeliness',
  purpose: '先通过相关性门槛',
  evidenceStatus: 'unvalidated',
  plainLanguage: '热点相关性与合格触达：先通过相关性门槛。它是待验证的推理或离线代理，不是平台经验定律。',
  variables: [
    { path: 'relevance', description: 'relevance', valueType: 'number', required: true },
    { path: 'bridgeClarity', description: 'bridgeClarity', valueType: 'number', required: true },
    { path: 'timeliness', description: 'timeliness', valueType: 'number', required: true },
  ],
  expression: {
    op: 'multiply',
    args: [
      { op: 'var', path: 'relevance' },
      { op: 'var', path: 'bridgeClarity' },
      { op: 'var', path: 'timeliness' },
    ],
  },
} satisfies FormulaDefinition;

async function call(
  path: string,
  options: RequestInit & { cookie?: string; csrf?: string } = {},
): Promise<ApiResponse> {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.csrf) headers.set('x-csrf-token', options.csrf);
  if (typeof options.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Preserve non-JSON error output for assertions.
  }
  return { response, body };
}

async function login(username: string, password: string): Promise<{ cookie: string; csrf: string; body: any }> {
  const result = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.response.status, 201);
  const setCookie = result.response.headers.get('set-cookie');
  assert.ok(setCookie);
  return {
    cookie: setCookie.split(';', 1)[0]!,
    csrf: result.body.csrfToken,
    body: result.body,
  };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-api-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: ADMIN_PASSWORD,
    secureCookies: false,
    logger: false,
    // 显式关掉模型供应商:本用例断言的是离线确定性生成路径
    // (generation.service.ts 的 modelProvider() 在没有 apiKey 时返回 undefined)。
    // 不写这行的话,resolveOptions 会捡起环境里的 OPENAI_API_KEY /
    // ANTHROPIC_AUTH_TOKEN 把用例打到真实中继上——本机 shell 里残留一个
    // ANTHROPIC_BASE_URL=http://127.0.0.1:8990(少了 /v1)就让这条用例常红,
    // 而 --env-file 不覆盖已存在的环境变量,所以连 .env 也救不回来。
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('health endpoint and bootstrap login work', async () => {
  const health = await call('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const session = await login('admin', ADMIN_PASSWORD);
  adminCookie = session.cookie;
  adminCsrf = session.csrf;
  assert.equal(session.body.user.mustChangePassword, true);

  const me = await call('/api/auth/me', { cookie: adminCookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.username, 'admin');
});

test('repeated failed logins are rate limited', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'rate-limited-user', password: 'incorrect-password' }),
    });
    assert.equal(failed.response.status, 401);
  }
  const blocked = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'rate-limited-user', password: 'incorrect-password' }),
  });
  assert.equal(blocked.response.status, 429);
});

test('CSRF and first-login password change are enforced', async () => {
  const withoutCsrf = await call('/api/projects', {
    method: 'POST',
    cookie: adminCookie,
    body: JSON.stringify({ name: '拒绝的项目' }),
  });
  assert.equal(withoutCsrf.response.status, 401);

  const beforeChange = await call('/api/projects', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ name: '仍应拒绝' }),
  });
  assert.equal(beforeChange.response.status, 403);
  assert.equal(beforeChange.body.code, 'PASSWORD_CHANGE_REQUIRED');

  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201);
});

test('workspace and project CRUD persist structured project data', async () => {
  const workspaces = await call('/api/workspaces', { cookie: adminCookie });
  assert.equal(workspaces.response.status, 200);
  assert.equal(workspaces.body.length, 1);
  workspaceId = workspaces.body[0].id;

  const created = await call('/api/projects', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({
      name: '去眼袋项目',
      description: '测试项目',
      domain: '医美',
      cities: ['上海'],
    }),
  });
  assert.equal(created.response.status, 201);
  projectId = created.body.id;
  assert.equal(created.body.profile.domain, '医美');
  const initializedFormula = app.get(DatabaseService).prepare(
    'SELECT status, definition_json FROM formula_versions WHERE project_id=?',
  ).all(projectId) as unknown as Array<{ status: string; definition_json: string }>;
  assert.equal(initializedFormula.length, 1);
  assert.equal(initializedFormula[0]?.status, 'active');
  assert.equal(JSON.parse(initializedFormula[0]!.definition_json).version.formulas.length, 43);

  const updated = await call(`/api/projects/${projectId}`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ description: '更新后的说明' }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.description, '更新后的说明');
});

test('knowledge API accepts md/txt in JSON and multipart, and rejects other extensions', async () => {
  const jsonUpload = await call('/api/knowledge', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({
      projectId,
      filename: '受众.md',
      content: '# 受众\n\n处于信息收集阶段。',
      category: 'audience',
      evidenceStatus: 'reasoning',
    }),
  });
  assert.equal(jsonUpload.response.status, 201);
  assert.equal(jsonUpload.body.filename, '受众.md');

  const form = new FormData();
  form.set('projectId', projectId);
  form.set('category', 'facts');
  form.set('file', new Blob(['事实内容'], { type: 'text/plain' }), 'facts.txt');
  const multipartUpload = await call('/api/knowledge', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: form,
  });
  assert.equal(multipartUpload.response.status, 201);
  assert.equal(multipartUpload.body.filename, 'facts.txt');

  const rejected = await call('/api/knowledge', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ projectId, filename: 'unsafe.pdf', content: 'x' }),
  });
  assert.equal(rejected.response.status, 400);

  const index = await call(`/api/projects/${projectId}/knowledge/index`, { cookie: adminCookie });
  assert.equal(index.response.status, 200);
  assert.match(index.body.content, /受众\.md/);
  assert.match(index.body.content, /facts\.txt/);
});

test('viewer can read but cannot write projects', async () => {
  const user = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ username: 'viewer', password: 'Viewer-bootstrap-123!' }),
  });
  assert.equal(user.response.status, 201);

  const membership = await call(`/api/workspaces/${workspaceId}/members/${user.body.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ role: 'Viewer' }),
  });
  assert.equal(membership.response.status, 200);

  const viewer = await login('viewer', 'Viewer-bootstrap-123!');
  const changed = await call('/api/auth/change-password', {
    method: 'POST',
    cookie: viewer.cookie,
    csrf: viewer.csrf,
    body: JSON.stringify({
      currentPassword: 'Viewer-bootstrap-123!',
      newPassword: 'Viewer-updated-456!',
    }),
  });
  assert.equal(changed.response.status, 201);

  const list = await call('/api/projects', { cookie: viewer.cookie });
  assert.equal(list.response.status, 200);
  assert.equal(list.body.length, 1);

  const create = await call('/api/projects', {
    method: 'POST',
    cookie: viewer.cookie,
    csrf: viewer.csrf,
    body: JSON.stringify({ workspaceId, name: '无权限项目' }),
  });
  assert.equal(create.response.status, 403);

  const legacyProject = await call('/api/projects', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ workspaceId, name: '公式只读迁移边界' }),
  });
  assert.equal(legacyProject.response.status, 201);
  const legacyProjectId = String(legacyProject.body.id);
  const database = app.get(DatabaseService);
  database.prepare('DELETE FROM formula_versions WHERE project_id=?').run(legacyProjectId);
  const admin = database.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string };
  const legacyFormulaId = randomUUID();
  const createdAt = '2026-07-13T00:00:00.000Z';
  const legacyVersion = createFormulaVersion({
    id: legacyFormulaId,
    projectId: legacyProjectId,
    version: '1.0.0',
    status: 'active',
    createdAt,
    formulas: DEFAULT_FORMULA_VERSION.formulas.map((formula) => formula.id === 'F30' ? LEGACY_OFFICIAL_F30 : formula),
  });
  database.prepare(
    `INSERT INTO formula_versions
     (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
     VALUES (?, ?, 1, 'active', ?, ?, ?, ?)`,
  ).run(
    legacyFormulaId,
    legacyProjectId,
    JSON.stringify({ name: '旧官方公式', description: '只允许管理者迁移', version: legacyVersion, config: {} }),
    admin.id,
    createdAt,
    createdAt,
  );
  const formulaRows = () => database.prepare(
    'SELECT id, version, status, definition_json, created_by, created_at, activated_at FROM formula_versions WHERE project_id=? ORDER BY version',
  ).all(legacyProjectId);
  const autoUpgradeCount = () => Number((database.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='formula.auto-upgrade'",
  ).get() as { value: number }).value);
  const beforeReadRows = JSON.stringify(formulaRows());
  const beforeReadAuditCount = autoUpgradeCount();

  const viewerFormulaList = await call(`/api/formulas?projectId=${legacyProjectId}`, {
    cookie: viewer.cookie,
  });
  assert.equal(viewerFormulaList.response.status, 200, JSON.stringify(viewerFormulaList.body));
  assert.equal(viewerFormulaList.body.length, 1);
  assert.equal(viewerFormulaList.body[0].id, legacyFormulaId);
  assert.equal(JSON.stringify(formulaRows()), beforeReadRows);
  assert.equal(autoUpgradeCount(), beforeReadAuditCount);
  const viewerMigrationAttempt = await call(
    `/api/formulas/projects/${legacyProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', cookie: viewer.cookie, csrf: viewer.csrf, body: JSON.stringify({}) },
  );
  assert.equal(viewerMigrationAttempt.response.status, 403);
  assert.equal(JSON.stringify(formulaRows()), beforeReadRows);
  assert.equal(autoUpgradeCount(), beforeReadAuditCount);

  const promoteToEditor = await call(`/api/workspaces/${workspaceId}/members/${user.body.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ role: 'ContentEditor' }),
  });
  assert.equal(promoteToEditor.response.status, 200);
  seedApprovedProjectBlueprint(app, legacyProjectId);
  const editorGeneration = await call('/api/generations', {
    method: 'POST',
    cookie: viewer.cookie,
    csrf: viewer.csrf,
    body: JSON.stringify({
      projectId: legacyProjectId,
      mode: 'simple',
      topic: '验证只读公式解析',
      goal: '不触发公式迁移',
      audienceStage: '收集期',
      entryPoint: '搜索',
      seed: 90210,
    }),
  });
  assert.equal(editorGeneration.response.status, 201, JSON.stringify(editorGeneration.body));
  let editorJob = editorGeneration.body;
  for (let attempt = 0; attempt < 60 && !['completed', 'failed'].includes(editorJob.status); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    editorJob = (await call(`/api/generations/${editorGeneration.body.id}`, { cookie: viewer.cookie })).body;
  }
  assert.equal(editorJob.status, 'completed', editorJob.error);
  assert.equal(JSON.stringify(formulaRows()), beforeReadRows);
  assert.equal(autoUpgradeCount(), beforeReadAuditCount);

  const ownerReadBeforeMigration = await call(`/api/formulas?projectId=${legacyProjectId}`, {
    cookie: adminCookie,
  });
  assert.equal(ownerReadBeforeMigration.response.status, 200, JSON.stringify(ownerReadBeforeMigration.body));
  assert.equal(ownerReadBeforeMigration.body.length, 1);
  assert.equal(JSON.stringify(formulaRows()), beforeReadRows);
  assert.equal(autoUpgradeCount(), beforeReadAuditCount);

  const explicitMigration = await call(
    `/api/formulas/projects/${legacyProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: JSON.stringify({}) },
  );
  assert.equal(explicitMigration.response.status, 200, JSON.stringify(explicitMigration.body));
  assert.equal(explicitMigration.body.changed, true);
  assert.equal(explicitMigration.body.operation, 'ensure_reviewed_defaults');
  const managerFormulaList = await call(`/api/formulas?projectId=${legacyProjectId}`, {
    cookie: adminCookie,
  });
  assert.equal(managerFormulaList.response.status, 200, JSON.stringify(managerFormulaList.body));
  assert.equal(managerFormulaList.body.length, 2);
  const migratedActive = managerFormulaList.body.find((row: any) => row.status === 'active');
  const migratedLegacy = managerFormulaList.body.find((row: any) => row.id === legacyFormulaId);
  assert.ok(migratedActive);
  assert.equal(migratedLegacy.status, 'archived');
  assert.ok(migratedActive.formulas.find((formula: any) => formula.id === 'F30')?.calculatorContract);
  const migrationAudit = database.prepare(
    "SELECT user_id, details_json FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id=?",
  ).get(migratedActive.id) as { user_id: string; details_json: string };
  assert.equal(migrationAudit.user_id, admin.id);
  assert.equal(JSON.parse(migrationAudit.details_json).projectId, legacyProjectId);
  const rowsAfterMigration = JSON.stringify(formulaRows());
  const auditCountAfterMigration = autoUpgradeCount();
  const idempotentMigration = await call(
    `/api/formulas/projects/${legacyProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: JSON.stringify({}) },
  );
  assert.equal(idempotentMigration.response.status, 200);
  assert.equal(idempotentMigration.body.changed, false);
  assert.equal(JSON.stringify(formulaRows()), rowsAfterMigration);
  assert.equal(autoUpgradeCount(), auditCountAfterMigration);

  const restoreViewer = await call(`/api/workspaces/${workspaceId}/members/${user.body.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ role: 'Viewer' }),
  });
  assert.equal(restoreViewer.response.status, 200);
  const deletedLegacyProject = await call(`/api/projects/${legacyProjectId}`, {
    method: 'DELETE',
    cookie: adminCookie,
    csrf: adminCsrf,
  });
  assert.equal(deletedLegacyProject.response.status, 200);
});

test('read-only API keys are workspace-scoped', async () => {
  const createdKey = await call(`/api/workspaces/${workspaceId}/api-keys`, {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ name: 'integration-test' }),
  });
  assert.equal(createdKey.response.status, 201);
  assert.match(createdKey.body.key, /^cak_/);

  const projects = await call('/v1/projects', {
    headers: { authorization: `Bearer ${createdKey.body.key}` },
  });
  assert.equal(projects.response.status, 200);
  assert.equal(projects.body.length, 1);
  assert.equal(projects.body[0].id, projectId);

  const knowledge = await call(`/v1/knowledge/files?projectId=${projectId}`, {
    headers: { authorization: `Bearer ${createdKey.body.key}` },
  });
  assert.equal(knowledge.response.status, 200);
  assert.equal(knowledge.body.length, 2);
  assert.equal(knowledge.body[0].content, undefined);
});
