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
  // 真探活:必须实际写库并报告队列/磁盘,不能只报版本装健康。
  assert.equal(health.body.databaseWritable, true);
  assert.ok(health.body.queuedJobs >= 0);
  assert.ok(health.body.diskFreeBytes > 0);

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

test('oversized login passwords are rejected before password verification', async () => {
  const result = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(257) }),
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.message, '用户名或密码错误');
});

test('CSRF and first-login password change are enforced', async () => {
  const readBeforeChange = await call('/api/projects', { cookie: adminCookie });
  assert.equal(readBeforeChange.response.status, 403);
  assert.equal(readBeforeChange.body.code, 'PASSWORD_CHANGE_REQUIRED');

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

  const ownerDb = app.get(DatabaseService);
  const owner = ownerDb.prepare('SELECT owner_id FROM workspaces WHERE id = ?')
    .get(workspaceId) as { owner_id: string };
  const downgradeOwner = await call(`/api/workspaces/${workspaceId}/members/${owner.owner_id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ role: 'Viewer' }),
  });
  assert.equal(downgradeOwner.response.status, 409, '不能借成员更新降级 owner_id 指向的所有者');
  const createSecondOwner = await call(`/api/workspaces/${workspaceId}/members/${user.body.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ role: 'Owner' }),
  });
  assert.equal(createSecondOwner.response.status, 409, '不能借角色更新隐式转移所有权');
  const roles = ownerDb.prepare(
    'SELECT user_id, role FROM workspace_members WHERE workspace_id = ? ORDER BY user_id',
  ).all(workspaceId) as Array<{ user_id: string; role: string }>;
  assert.equal(roles.find((row) => row.user_id === owner.owner_id)?.role, 'Owner');
  assert.equal(roles.find((row) => row.user_id === user.body.id)?.role, 'Viewer');

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

  // project.write 不等于成员管理。否则一个只被授予项目编辑权的人可以改自己的
  // project ACL，再给自己追加 project.delete / generation.export 等任意权限。
  const grantProjectWrite = await call(`/api/projects/${projectId}/acl/${user.body.id}`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ grants: ['project.write'], denies: [] }),
  });
  assert.equal(grantProjectWrite.response.status, 200);
  const escalateAcl = await call(`/api/projects/${projectId}/acl/${user.body.id}`, {
    method: 'PUT',
    cookie: viewer.cookie,
    csrf: viewer.csrf,
    body: JSON.stringify({ grants: ['project.write', 'project.delete'], denies: [] }),
  });
  assert.equal(escalateAcl.response.status, 403);
  const storedAcl = app.get(DatabaseService).prepare(
    'SELECT grants_json FROM project_acl WHERE project_id=? AND user_id=?',
  ).get(projectId, user.body.id) as { grants_json: string };
  assert.deepEqual(JSON.parse(storedAcl.grants_json), ['project.write']);
  const clearProjectWrite = await call(`/api/projects/${projectId}/acl/${user.body.id}`, {
    method: 'DELETE', cookie: adminCookie, csrf: adminCsrf,
  });
  assert.equal(clearProjectWrite.response.status, 200);

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

test('workspace Admin cannot override the canonical Owner permissions', async () => {
  const ownerCreated = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ username: 'security-owner', password: 'Owner-bootstrap-123!' }),
  });
  assert.equal(ownerCreated.response.status, 201);
  const attackerCreated = await call('/api/admin/users', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ username: 'security-admin', password: 'Attacker-bootstrap-123!' }),
  });
  assert.equal(attackerCreated.response.status, 201);

  const workspaceCreated = await call('/api/workspaces', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ name: 'Owner 权限边界', ownerUserId: ownerCreated.body.id }),
  });
  assert.equal(workspaceCreated.response.status, 201, JSON.stringify(workspaceCreated.body));
  const securityWorkspaceId = String(workspaceCreated.body.id);
  const attackerMembership = await call(
    '/api/workspaces/' + securityWorkspaceId + '/members/' + attackerCreated.body.id,
    {
      method: 'PUT',
      cookie: adminCookie,
      csrf: adminCsrf,
      body: JSON.stringify({ role: 'Admin' }),
    },
  );
  assert.equal(attackerMembership.response.status, 200);

  const owner = await login('security-owner', 'Owner-bootstrap-123!');
  const ownerPasswordChanged = await call('/api/auth/change-password', {
    method: 'POST',
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: JSON.stringify({
      currentPassword: 'Owner-bootstrap-123!',
      newPassword: 'Owner-updated-456!',
    }),
  });
  assert.equal(ownerPasswordChanged.response.status, 201);
  const attacker = await login('security-admin', 'Attacker-bootstrap-123!');
  const attackerPasswordChanged = await call('/api/auth/change-password', {
    method: 'POST',
    cookie: attacker.cookie,
    csrf: attacker.csrf,
    body: JSON.stringify({
      currentPassword: 'Attacker-bootstrap-123!',
      newPassword: 'Attacker-updated-456!',
    }),
  });
  assert.equal(attackerPasswordChanged.response.status, 201);

  const projectCreated = await call('/api/projects', {
    method: 'POST',
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: JSON.stringify({ workspaceId: securityWorkspaceId, name: 'Owner 管理权限回归' }),
  });
  assert.equal(projectCreated.response.status, 201, JSON.stringify(projectCreated.body));
  const securityProjectId = String(projectCreated.body.id);

  const workspaceOverride = await call(
    '/api/workspaces/' + securityWorkspaceId + '/members/' + ownerCreated.body.id,
    {
      method: 'PUT',
      cookie: attacker.cookie,
      csrf: attacker.csrf,
      body: JSON.stringify({ role: 'Owner', grants: [], denies: ['workspace.manage'] }),
    },
  );
  assert.equal(workspaceOverride.response.status, 409, JSON.stringify(workspaceOverride.body));
  const projectOverride = await call(
    '/api/projects/' + securityProjectId + '/acl/' + ownerCreated.body.id,
    {
      method: 'PUT',
      cookie: attacker.cookie,
      csrf: attacker.csrf,
      body: JSON.stringify({ grants: [], denies: ['project.write'] }),
    },
  );
  assert.equal(projectOverride.response.status, 409, JSON.stringify(projectOverride.body));

  const database = app.get(DatabaseService);
  const storedOwner = database.prepare(
    'SELECT role, grants_json, denies_json FROM workspace_members WHERE workspace_id=? AND user_id=?',
  ).get(securityWorkspaceId, ownerCreated.body.id) as {
    role: string;
    grants_json: string;
    denies_json: string;
  };
  assert.deepEqual({ ...storedOwner }, { role: 'Owner', grants_json: '[]', denies_json: '[]' });
  const ownerAclCount = database.prepare(
    'SELECT COUNT(*) AS value FROM project_acl WHERE project_id=? AND user_id=?',
  ).get(securityProjectId, ownerCreated.body.id) as { value: number };
  assert.equal(Number(ownerAclCount.value), 0);

  const ownerWorkspaceUpdate = await call('/api/workspaces/' + securityWorkspaceId, {
    method: 'PATCH',
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: JSON.stringify({ name: 'Owner 权限仍然有效' }),
  });
  assert.equal(ownerWorkspaceUpdate.response.status, 200, JSON.stringify(ownerWorkspaceUpdate.body));
  const ownerProjectUpdate = await call('/api/projects/' + securityProjectId, {
    method: 'PATCH',
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: JSON.stringify({ description: 'Owner 未被权限覆盖锁死' }),
  });
  assert.equal(ownerProjectUpdate.response.status, 200, JSON.stringify(ownerProjectUpdate.body));

  const projectDeleted = await call('/api/projects/' + securityProjectId, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(projectDeleted.response.status, 200);
  const workspaceDeleted = await call('/api/workspaces/' + securityWorkspaceId, {
    method: 'DELETE', cookie: owner.cookie, csrf: owner.csrf,
  });
  assert.equal(workspaceDeleted.response.status, 200);
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

test('V1 内容包端点与交付硬门禁同线：blocked 候选不提供可见文案', async () => {
  const createdKey = await call(`/api/workspaces/${workspaceId}/api-keys`, {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: JSON.stringify({ name: 'delivery-gate-test' }),
  });
  assert.equal(createdKey.response.status, 201);
  const auth = { authorization: `Bearer ${createdKey.body.key}` };

  // 直接落库两个内容包:一个带不可覆盖硬门禁 issue,一个仅 needs_review。
  const database = app.get(DatabaseService);
  const adminId = String((database.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id);
  const jobId = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO generation_jobs (id, project_id, status, config_json, seed, created_by, created_at, updated_at)
     VALUES (?, ?, 'completed', '{}', '1', ?, ?, ?)`,
  ).run(jobId, projectId, adminId, now, now);
  const basePackage = {
    content: { H: { hashtags: [] }, N: { title: '标题', body: '正文' }, Cref: { disclaimer: '模拟情景', threads: [] } },
  };
  const blockedId = randomUUID();
  database.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  ).run(blockedId, jobId, projectId, JSON.stringify({
    ...basePackage,
    // restricted_source_content_visible 在不可覆盖硬门禁白名单里;顺带钉住的
    // 事实是:不在白名单里的 code(如 fabricated_testimonial)会被归一化层降为
    // 可人工覆盖的 review,不触发本门禁——白名单是唯一判据。
    validation: { valid: false, issues: [{ code: 'restricted_source_content_visible', severity: 'error', message: '保密来源内容出现在可见文案' }] },
  }), now, now);
  const reviewableId = randomUUID();
  database.prepare(
    `INSERT INTO content_packages (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  ).run(reviewableId, jobId, projectId, JSON.stringify({
    ...basePackage,
    validation: { valid: false, issues: [{ code: 'gap_resolution_not_realized', severity: 'error', message: '计划缺口未达成' }] },
  }), now, now);

  // 硬门禁候选:Web 复制门控与后端导出都拒绝,只读 API 必须同线,
  // 否则程序化集成成了唯一能拿到 blocked 全文的出口。
  const blocked = await call(`/v1/content-packages/${blockedId}`, { headers: auth });
  assert.equal(blocked.response.status, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, 'CONTENT_PACKAGE_DELIVERY_BLOCKED');
  assert.equal(JSON.stringify(blocked.body).includes('正文'), false, '硬门禁候选的可见文案不得出现在响应里');

  // needs_review(可人工覆盖)照常返回,qualityStatus 让集成方不解析全部
  // issues 就能判断「需人工复核」。
  const reviewable = await call(`/v1/content-packages/${reviewableId}`, { headers: auth });
  assert.equal(reviewable.response.status, 200, JSON.stringify(reviewable.body));
  assert.equal(reviewable.body.qualityStatus, 'needs_review');
  assert.equal(reviewable.body.content.content.N.body, '正文');
});
