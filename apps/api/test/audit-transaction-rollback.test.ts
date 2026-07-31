import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createFormulaVersion, DEFAULT_FORMULA_VERSION } from '@content-agent/agent-core';
import type { Request } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AdminController } from '../src/admin.controller.js';
import { createApplication } from '../src/app.js';
import { AuthService } from '../src/auth.service.js';
import { DatabaseService } from '../src/database.service.js';
import { FormulaService } from '../src/formula.service.js';
import type { SessionPrincipal } from '../src/models.js';
import { PresetService } from '../src/preset.service.js';
import { ProjectController } from '../src/project.controller.js';
import { RegistrationService } from '../src/registration.service.js';
import { ResearchService } from '../src/research.service.js';
import { SettingsService } from '../src/settings.service.js';
import { WorkspaceController } from '../src/workspace.controller.js';

let app: NestExpressApplication;
let database: DatabaseService;
let admin: AdminController;
let auth: AuthService;
let formulas: FormulaService;
let presets: PresetService;
let projects: ProjectController;
let registration: RegistrationService;
let research: ResearchService;
let settings: SettingsService;
let workspaces: WorkspaceController;
let dataDir = '';
let principal: SessionPrincipal;
let workspaceId = '';
let triggerSequence = 0;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-audit-rollback-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Audit-rollback-bootstrap-123!',
    masterEncryptionKey: 'audit-rollback-test-encryption-key',
    logger: false,
    platformApiKey: '',
  });
  database = app.get(DatabaseService);
  admin = app.get(AdminController);
  auth = app.get(AuthService);
  formulas = app.get(FormulaService);
  presets = app.get(PresetService);
  projects = app.get(ProjectController);
  registration = app.get(RegistrationService);
  research = app.get(ResearchService);
  settings = app.get(SettingsService);
  workspaces = app.get(WorkspaceController);
  const user = database.prepare(
    "SELECT id, username, system_role, user_kind, must_change_password FROM users WHERE username='admin'",
  ).get() as {
    id: string;
    username: string;
    system_role: 'admin' | 'user';
    user_kind: 'research' | 'saas';
    must_change_password: number;
  };
  const workspace = database.prepare('SELECT id FROM workspaces WHERE owner_id=?').get(user.id) as { id: string };
  workspaceId = workspace.id;
  principal = {
    kind: 'session',
    userId: user.id,
    username: user.username,
    systemRole: user.system_role,
    userKind: user.user_kind,
    mustChangePassword: Boolean(user.must_change_password),
    tokenHash: 'audit-rollback-test-token',
    csrfHash: 'audit-rollback-test-csrf',
  };
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function createRawProject(label: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    'INSERT INTO projects ' +
    '(id, workspace_id, slug, name, description, profile_json, created_by, created_at, updated_at) ' +
    "VALUES (?, ?, ?, ?, '', '{}', ?, ?, ?)",
  ).run(id, workspaceId, 'audit-rollback-' + id, label, principal.userId, now, now);
  return id;
}

function bootstrapProject(label: string): string {
  const projectId = createRawProject(label);
  formulas.ensureDefault(projectId, principal);
  research.bootstrapProject(projectId, principal.userId);
  return projectId;
}

function sqlLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function expectAuditFailure(action: string, operation: () => unknown): void {
  const trigger = 'audit_rollback_' + String(++triggerSequence);
  database.db.exec(
    'CREATE TRIGGER ' + trigger + ' ' +
    'BEFORE INSERT ON audit_logs WHEN NEW.action=' + sqlLiteral(action) + ' ' +
    "BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END",
  );
  try {
    assert.throws(operation, /forced audit failure/u, action);
  } finally {
    database.db.exec('DROP TRIGGER IF EXISTS ' + trigger);
  }
}

async function expectAuditFailureAsync(action: string, operation: () => Promise<unknown>): Promise<void> {
  const trigger = 'audit_rollback_' + String(++triggerSequence);
  database.db.exec(
    'CREATE TRIGGER ' + trigger + ' ' +
    'BEFORE INSERT ON audit_logs WHEN NEW.action=' + sqlLiteral(action) + ' ' +
    "BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END",
  );
  try {
    await assert.rejects(operation, /forced audit failure/u, action);
  } finally {
    database.db.exec('DROP TRIGGER IF EXISTS ' + trigger);
  }
}

function rawRequest(): Request {
  return { principal } as unknown as Request;
}

function snapshot(sql: string, ...params: string[]): string {
  return JSON.stringify(rows(sql, ...params));
}

function rows(sql: string, ...params: string[]): unknown[] {
  return database.prepare(sql).all(...params);
}

test('formula business writes roll back when their audit insert fails', () => {
  const projectId = createRawProject('公式事务回滚');
  expectAuditFailure('formula.bootstrap', () => formulas.ensureDefault(projectId, principal));
  assert.equal(rows('SELECT id FROM formula_versions WHERE project_id=?', projectId).length, 0);

  formulas.ensureDefault(projectId, principal);
  research.bootstrapProject(projectId, principal.userId);
  const active = formulas.active(projectId);
  const countBeforeCreate = rows('SELECT id FROM formula_versions WHERE project_id=?', projectId).length;
  expectAuditFailure('formula.create', () => formulas.create(
    projectId,
    { parentId: active.id, description: '该草稿必须随审计失败回滚' },
    principal,
  ));
  assert.equal(rows('SELECT id FROM formula_versions WHERE project_id=?', projectId).length, countBeforeCreate);

  const draft = formulas.create(
    projectId,
    { parentId: active.id, description: '用于激活事务回滚验证' },
    principal,
  );
  const activationState = () => JSON.stringify({
    formulas: rows(
      'SELECT id, status, activated_at FROM formula_versions WHERE project_id=? ORDER BY version',
      projectId,
    ),
    releases: rows(
      'SELECT id, status, activated_at FROM release_manifests WHERE project_id=? ORDER BY created_at, id',
      projectId,
    ),
  });
  const beforeActivation = activationState();
  expectAuditFailure('formula.activate', () => formulas.activate(String(draft.id), principal));
  assert.equal(activationState(), beforeActivation);

  const upgradeProjectId = createRawProject('公式自动升级事务回滚');
  const legacyId = randomUUID();
  const createdAt = new Date().toISOString();
  const legacyVersion = createFormulaVersion({
    id: legacyId,
    projectId: upgradeProjectId,
    version: '1.0.0',
    status: 'active',
    createdAt,
    formulas: DEFAULT_FORMULA_VERSION.formulas.filter(
      (formula) => !['F38', 'F39', 'F40', 'F41', 'F42', 'F43'].includes(formula.id),
    ),
  });
  database.prepare(
    'INSERT INTO formula_versions ' +
    '(id, project_id, version, status, definition_json, created_by, created_at, activated_at) ' +
    "VALUES (?, ?, 1, 'active', ?, ?, ?, ?)",
  ).run(
    legacyId,
    upgradeProjectId,
    JSON.stringify({ name: '旧公式', description: '缺少规划公式', version: legacyVersion, config: {} }),
    principal.userId,
    createdAt,
    createdAt,
  );
  research.bootstrapProject(upgradeProjectId, principal.userId);
  const upgradeState = () => JSON.stringify({
    formulas: rows(
      'SELECT id, status, definition_json FROM formula_versions WHERE project_id=? ORDER BY version',
      upgradeProjectId,
    ),
    releases: rows(
      'SELECT id, status FROM release_manifests WHERE project_id=? ORDER BY created_at, id',
      upgradeProjectId,
    ),
  });
  const beforeUpgrade = upgradeState();
  expectAuditFailure('formula.auto-upgrade', () => formulas.ensureDefault(upgradeProjectId, principal));
  assert.equal(upgradeState(), beforeUpgrade);
});

test('research create, review, link and transition writes roll back with audit failures', () => {
  const projectId = bootstrapProject('Research 基础事务回滚');

  const claimInput = {
    logicalKey: 'audit-rollback-claim',
    title: '审计回滚主张',
    statement: '只用于验证审计失败时不留下业务数据。',
    claimType: 'internal_observation',
    scope: ['transaction-test'],
  };
  expectAuditFailure('research.claim.create', () => research.createClaim(projectId, claimInput, principal));
  assert.equal(rows(
    'SELECT id FROM research_claims WHERE project_id=? AND logical_key=?',
    projectId,
    claimInput.logicalKey,
  ).length, 0);
  const claim = research.createClaim(projectId, claimInput, principal);
  expectAuditFailure('research.claim.review', () => research.reviewClaim(
    projectId,
    String(claim.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, reviewed_by, reviewed_at FROM research_claims WHERE id=?',
  ).get(String(claim.id))), JSON.stringify({ status: 'draft', reviewed_by: null, reviewed_at: null }));

  const sourceInput = {
    sourceKey: 'audit-rollback-source',
    kind: 'internal_observation',
    citation: '审计事务测试来源',
    limitations: '不支持任何外推。',
  };
  expectAuditFailure('research.source.create', () => research.createSource(projectId, sourceInput, principal));
  assert.equal(rows(
    'SELECT id FROM evidence_sources WHERE project_id=? AND source_key=?',
    projectId,
    sourceInput.sourceKey,
  ).length, 0);
  const source = research.createSource(projectId, sourceInput, principal);
  expectAuditFailure('research.source.review', () => research.reviewSource(
    projectId,
    String(source.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, reviewed_by, reviewed_at FROM evidence_sources WHERE id=?',
  ).get(String(source.id))), JSON.stringify({ status: 'draft', reviewed_by: null, reviewed_at: null }));

  expectAuditFailure('research.claim.link-evidence', () => research.linkEvidence(
    projectId,
    String(claim.id),
    { evidenceSourceId: source.id, relation: 'limits', strength: 'moderate' },
    principal,
  ));
  assert.equal(rows(
    'SELECT claim_id FROM claim_evidence_links WHERE claim_id=? AND evidence_source_id=?',
    String(claim.id),
    String(source.id),
  ).length, 0);

  const datasetInput = {
    datasetKey: 'audit-rollback-dataset',
    label: '审计回滚数据快照',
    kind: 'internal_sample',
    sha256: 'a'.repeat(64),
    schema: { fields: ['value'] },
  };
  expectAuditFailure('research.dataset.create', () => research.createDataset(projectId, datasetInput, principal));
  assert.equal(rows(
    'SELECT id FROM dataset_snapshots WHERE project_id=? AND dataset_key=?',
    projectId,
    datasetInput.datasetKey,
  ).length, 0);
  const dataset = research.createDataset(projectId, datasetInput, principal);
  expectAuditFailure('research.dataset.review', () => research.reviewDataset(
    projectId,
    String(dataset.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, approved_by, approved_at FROM dataset_snapshots WHERE id=?',
  ).get(String(dataset.id))), JSON.stringify({ status: 'draft', approved_by: null, approved_at: null }));

  const experimentInput = {
    experimentKey: 'audit-rollback-experiment',
    title: '审计回滚实验',
    hypothesis: '审计失败时实验写入必须回滚。',
    design: { arms: ['control', 'candidate'] },
    metrics: ['transaction_integrity'],
    analysisPlan: { primaryMetric: 'transaction_integrity' },
  };
  expectAuditFailure('research.experiment.create', () => research.createExperiment(
    projectId,
    experimentInput,
    principal,
  ));
  assert.equal(rows(
    'SELECT id FROM experiment_versions WHERE project_id=? AND experiment_key=?',
    projectId,
    experimentInput.experimentKey,
  ).length, 0);
  const experiment = research.createExperiment(projectId, experimentInput, principal);
  expectAuditFailure('research.experiment.transition', () => research.transitionExperiment(
    projectId,
    String(experiment.id),
    { status: 'preregistered' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, approved_by, approved_at FROM experiment_versions WHERE id=?',
  ).get(String(experiment.id))), JSON.stringify({ status: 'draft', approved_by: null, approved_at: null }));
  research.transitionExperiment(projectId, String(experiment.id), { status: 'preregistered' }, principal);
  research.transitionExperiment(projectId, String(experiment.id), { status: 'running' }, principal);

  const resultInput = { result: { transaction_integrity: 1 }, conclusion: 'supports' };
  expectAuditFailure('research.experiment-result.create', () => research.createExperimentResult(
    projectId,
    String(experiment.id),
    resultInput,
    principal,
  ));
  assert.equal(rows(
    'SELECT id FROM experiment_results WHERE experiment_version_id=?',
    String(experiment.id),
  ).length, 0);
  const result = research.createExperimentResult(projectId, String(experiment.id), resultInput, principal);
  expectAuditFailure('research.experiment-result.review', () => research.reviewExperimentResult(
    projectId,
    String(result.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, reviewed_by, reviewed_at FROM experiment_results WHERE id=?',
  ).get(String(result.id))), JSON.stringify({ status: 'draft', reviewed_by: null, reviewed_at: null }));

  const calibrationInput = {
    targetType: 'parameter',
    targetKey: 'comment_expansion',
    current: { value: 70 },
    proposed: { value: 63 },
    rationale: '只用于审计事务回滚验证。',
    evidence: { kind: 'transaction-test' },
    impact: { expected: 'none' },
  };
  expectAuditFailure('research.calibration.create', () => research.createCalibration(
    projectId,
    calibrationInput,
    principal,
  ));
  assert.equal(rows(
    'SELECT id FROM calibration_proposals WHERE project_id=? AND target_key=?',
    projectId,
    calibrationInput.targetKey,
  ).length, 0);
  const calibration = research.createCalibration(projectId, calibrationInput, principal);
  expectAuditFailure('research.calibration.review', () => research.reviewCalibration(
    projectId,
    String(calibration.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, reviewed_by, reviewed_at FROM calibration_proposals WHERE id=?',
  ).get(String(calibration.id))), JSON.stringify({ status: 'draft', reviewed_by: null, reviewed_at: null }));
});

test('release creation, review and activation remain atomic with audit failures', () => {
  const projectId = bootstrapProject('发布事务回滚');
  const calibration = research.createCalibration(projectId, {
    targetType: 'parameter',
    targetKey: 'comment_expansion',
    current: { value: 70 },
    proposed: { value: 61 },
    rationale: '验证发布激活中的多行事务回滚。',
    evidence: { kind: 'transaction-test' },
    impact: { expected: 'none' },
  }, principal);
  research.reviewCalibration(projectId, String(calibration.id), { status: 'approved' }, principal);

  const releaseInput = {
    version: 'audit-rollback-release',
    bindings: { calibrationProposalIds: [calibration.id] },
  };
  const countBeforeCreate = rows('SELECT id FROM release_manifests WHERE project_id=?', projectId).length;
  expectAuditFailure('research.release.create', () => research.createRelease(projectId, releaseInput, principal));
  assert.equal(rows('SELECT id FROM release_manifests WHERE project_id=?', projectId).length, countBeforeCreate);

  const release = research.createRelease(projectId, releaseInput, principal);
  expectAuditFailure('research.release.review', () => research.reviewRelease(
    projectId,
    String(release.id),
    { status: 'approved' },
    principal,
  ));
  assert.equal(JSON.stringify(database.prepare(
    'SELECT status, approved_by, approved_at FROM release_manifests WHERE id=?',
  ).get(String(release.id))), JSON.stringify({ status: 'draft', approved_by: null, approved_at: null }));
  research.reviewRelease(projectId, String(release.id), { status: 'approved' }, principal);

  const activationState = () => JSON.stringify({
    releases: rows(
      'SELECT id, status, activated_at FROM release_manifests WHERE project_id=? ORDER BY created_at, id',
      projectId,
    ),
    calibration: database.prepare(
      'SELECT status, applied_release_id FROM calibration_proposals WHERE id=?',
    ).get(String(calibration.id)),
  });
  const beforeActivation = activationState();
  expectAuditFailure('research.release.activate', () => research.activateRelease(
    projectId,
    String(release.id),
    principal,
  ));
  assert.equal(activationState(), beforeActivation);
});

test('settings and preset writes roll back when their audit insert fails', () => {
  settings.ensure(workspaceId, principal.userId);
  const settingsState = () => snapshot(
    `SELECT provider_mode, provider, model, base_url, transport, encrypted_api_key,
            monthly_quota, default_temperature, config_json, updated_by, updated_at
       FROM workspace_settings WHERE workspace_id=?`,
    workspaceId,
  );
  const beforeSettings = settingsState();
  expectAuditFailure('settings.update', () => settings.update(
    workspaceId,
    { monthlyQuota: 321, defaultTemperature: 0.45, generationDefaults: { auditRollback: true } },
    principal,
  ));
  assert.equal(settingsState(), beforeSettings);

  const projectId = bootstrapProject('预设事务回滚');
  const presetCount = () => rows(
    'SELECT id FROM generation_presets WHERE project_id=?',
    projectId,
  ).length;
  const beforeCreate = presetCount();
  expectAuditFailure('preset.create', () => presets.create(
    projectId,
    { name: '必须回滚的预设', values: { novelty_angle: 72 } },
    principal,
  ));
  assert.equal(presetCount(), beforeCreate);

  const custom = presets.create(
    projectId,
    { name: '事务预设', values: { novelty_angle: 70 } },
    principal,
  );
  const presetId = String(custom.id);
  const presetState = () => snapshot(
    `SELECT name, description, values_json, updated_at, deleted_at
       FROM generation_presets WHERE id=?`,
    presetId,
  );
  const beforeUpdate = presetState();
  expectAuditFailure('preset.update', () => presets.update(
    projectId,
    presetId,
    { name: '审计失败不能保存', values: { novelty_angle: 74 } },
    principal,
  ));
  assert.equal(presetState(), beforeUpdate);

  const defaultState = () => snapshot(
    'SELECT preset_id, updated_by, updated_at FROM project_preset_defaults WHERE project_id=?',
    projectId,
  );
  const beforeDefault = defaultState();
  expectAuditFailure('preset.set-default', () => presets.setDefault(projectId, presetId, principal));
  assert.equal(defaultState(), beforeDefault);

  const styleState = () => snapshot(
    `SELECT style_profile_json, style_profile_version, style_profile_updated_at, updated_at
       FROM projects WHERE id=?`,
    projectId,
  );
  const beforeStyle = styleState();
  expectAuditFailure('style-profile.update', () => presets.updateStyleProfile(
    projectId,
    { preferredTone: '审计失败不能保存的风格' },
    principal,
  ));
  assert.equal(styleState(), beforeStyle);

  presets.setDefault(projectId, presetId, principal);
  const beforeRemovePreset = presetState();
  const beforeRemoveDefault = defaultState();
  expectAuditFailure('preset.delete', () => presets.remove(projectId, presetId, principal));
  assert.equal(presetState(), beforeRemovePreset);
  assert.equal(defaultState(), beforeRemoveDefault);
});

test('project and ACL writes roll back when their audit insert fails', async () => {
  const request = rawRequest();
  const beforeProjectCount = rows('SELECT id FROM projects WHERE workspace_id=?', workspaceId).length;
  expectAuditFailure('project.create', () => projects.create(request, {
    workspaceId,
    name: '审计失败项目',
    domain: 'transaction-test',
  }));
  assert.equal(rows('SELECT id FROM projects WHERE workspace_id=?', workspaceId).length, beforeProjectCount);
  assert.equal(rows(
    `SELECT id FROM projects WHERE workspace_id=? AND name='审计失败项目'`,
    workspaceId,
  ).length, 0);

  const projectId = bootstrapProject('项目管理事务回滚');
  const projectState = () => snapshot(
    'SELECT name, description, profile_json, updated_at, deleted_at FROM projects WHERE id=?',
    projectId,
  );
  const beforeUpdate = projectState();
  expectAuditFailure('project.update', () => projects.update(
    request,
    projectId,
    { name: '审计失败不能保存', domain: 'changed' },
  ));
  assert.equal(projectState(), beforeUpdate);

  const target = await auth.createUser({
    username: 'audit-project-member',
    password: 'Audit-project-member-123!',
    systemRole: 'user',
  });
  const targetId = String(target.id);
  workspaces.upsertMember(request, workspaceId, targetId, { role: 'Viewer' });

  expectAuditFailure('project-acl.upsert', () => projects.setAcl(
    request,
    projectId,
    targetId,
    { grants: ['project.read'], denies: [] },
  ));
  assert.equal(rows(
    'SELECT project_id FROM project_acl WHERE project_id=? AND user_id=?',
    projectId,
    targetId,
  ).length, 0);

  projects.setAcl(request, projectId, targetId, { grants: ['project.read'], denies: [] });
  const aclState = () => snapshot(
    'SELECT grants_json, denies_json, updated_at FROM project_acl WHERE project_id=? AND user_id=?',
    projectId,
    targetId,
  );
  const beforeAclDelete = aclState();
  expectAuditFailure('project-acl.delete', () => projects.deleteAcl(request, projectId, targetId));
  assert.equal(aclState(), beforeAclDelete);

  const beforeProjectDelete = projectState();
  expectAuditFailure('project.delete', () => projects.remove(request, projectId));
  assert.equal(projectState(), beforeProjectDelete);
});

test('workspace, member and API key writes roll back with audit failures', async () => {
  const request = rawRequest();
  const failedWorkspaceName = '审计失败工作区';
  expectAuditFailure('workspace.create', () => workspaces.create(request, { name: failedWorkspaceName }));
  assert.equal(rows('SELECT id FROM workspaces WHERE name=?', failedWorkspaceName).length, 0);

  const workspace = workspaces.create(request, { name: '管理事务测试工作区' });
  const managedWorkspaceId = String(workspace.id);
  const workspaceState = () => snapshot(
    'SELECT name, updated_at, deleted_at FROM workspaces WHERE id=?',
    managedWorkspaceId,
  );
  const beforeUpdate = workspaceState();
  expectAuditFailure('workspace.update', () => workspaces.update(
    request,
    managedWorkspaceId,
    { name: '审计失败不能保存的工作区名' },
  ));
  assert.equal(workspaceState(), beforeUpdate);

  const target = await auth.createUser({
    username: 'audit-workspace-member',
    password: 'Audit-workspace-member-123!',
    systemRole: 'user',
  });
  const targetId = String(target.id);
  expectAuditFailure('member.upsert', () => workspaces.upsertMember(
    request,
    managedWorkspaceId,
    targetId,
    { role: 'Viewer', grants: ['project.read'] },
  ));
  assert.equal(rows(
    'SELECT user_id FROM workspace_members WHERE workspace_id=? AND user_id=?',
    managedWorkspaceId,
    targetId,
  ).length, 0);

  workspaces.upsertMember(request, managedWorkspaceId, targetId, {
    role: 'Viewer',
    grants: ['project.read'],
  });
  const memberState = () => snapshot(
    `SELECT role, grants_json, denies_json, updated_at
       FROM workspace_members WHERE workspace_id=? AND user_id=?`,
    managedWorkspaceId,
    targetId,
  );
  const beforeMemberDelete = memberState();
  expectAuditFailure('member.delete', () => workspaces.deleteMember(
    request,
    managedWorkspaceId,
    targetId,
  ));
  assert.equal(memberState(), beforeMemberDelete);

  expectAuditFailure('api-key.create', () => workspaces.createApiKey(
    request,
    managedWorkspaceId,
    { name: '必须回滚的密钥' },
  ));
  assert.equal(rows(
    'SELECT id FROM api_keys WHERE workspace_id=? AND name=?',
    managedWorkspaceId,
    '必须回滚的密钥',
  ).length, 0);

  const key = workspaces.createApiKey(request, managedWorkspaceId, { name: '撤销事务密钥' });
  const keyId = String(key.id);
  const keyState = () => snapshot(
    'SELECT revoked_at FROM api_keys WHERE id=? AND workspace_id=?',
    keyId,
    managedWorkspaceId,
  );
  const beforeRevoke = keyState();
  expectAuditFailure('api-key.revoke', () => workspaces.revokeApiKey(
    request,
    managedWorkspaceId,
    keyId,
  ));
  assert.equal(keyState(), beforeRevoke);

  const beforeWorkspaceDelete = workspaceState();
  const beforeDeleteKey = keyState();
  expectAuditFailure('workspace.delete', () => workspaces.remove(request, managedWorkspaceId));
  assert.equal(workspaceState(), beforeWorkspaceDelete);
  assert.equal(keyState(), beforeDeleteKey);
});

test('registration decisions and admin user creation roll back with audit failures', async () => {
  const rejectUsername = 'audit-registration-reject';
  await registration.submit({
    username: rejectUsername,
    password: 'Audit-registration-reject-123!',
    organizationName: '拒绝事务机构',
    phone: '13800138081',
  });
  const rejectRequest = database.prepare(
    'SELECT id FROM registration_requests WHERE username=?',
  ).get(rejectUsername) as { id: string };
  const rejectionState = () => snapshot(
    `SELECT status, review_note, reviewed_by, reviewed_at, updated_at
       FROM registration_requests WHERE id=?`,
    rejectRequest.id,
  );
  const beforeReject = rejectionState();
  expectAuditFailure('registration.reject', () => registration.reject(
    rejectRequest.id,
    principal.userId,
    '强制审计失败',
  ));
  assert.equal(rejectionState(), beforeReject);

  const approveUsername = 'audit-registration-approve';
  await registration.submit({
    username: approveUsername,
    password: 'Audit-registration-approve-123!',
    organizationName: '批准事务机构',
    phone: '13800138082',
  });
  const approveRequest = database.prepare(
    'SELECT id FROM registration_requests WHERE username=?',
  ).get(approveUsername) as { id: string };
  const approvalState = () => snapshot(
    `SELECT status, created_user_id, reviewed_by, reviewed_at, updated_at
       FROM registration_requests WHERE id=?`,
    approveRequest.id,
  );
  const beforeApprove = approvalState();
  const workspaceCount = rows('SELECT id FROM workspaces').length;
  expectAuditFailure('registration.approve', () => registration.approve(
    approveRequest.id,
    principal.userId,
  ));
  assert.equal(approvalState(), beforeApprove);
  assert.equal(rows('SELECT id FROM users WHERE username=?', approveUsername).length, 0);
  assert.equal(rows('SELECT id FROM workspaces').length, workspaceCount);

  const adminUsername = 'audit-admin-create';
  await expectAuditFailureAsync('user.create', () => admin.createUser(rawRequest(), {
    username: adminUsername,
    password: 'Audit-admin-create-123!',
    systemRole: 'user',
  }));
  assert.equal(rows('SELECT id FROM users WHERE username=?', adminUsername).length, 0);
});
