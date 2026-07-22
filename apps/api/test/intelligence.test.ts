import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  F30_MIGRATION_DESCRIPTOR,
  F32_F33_MIGRATION_DESCRIPTOR,
  createFormulaVersion,
  DEFAULT_FORMULA_VERSION,
  filterTopicOpportunities,
  formulaEquationFingerprint,
  isLegacyOfficialF30,
  isLegacyOfficialF32OrF33,
  PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
  type FormulaDefinition,
} from '@content-agent/agent-core';
import sharp from 'sharp';
import { createApplication } from '../src/app.js';
import { resolveOptions } from '../src/config.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function startApp(options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-intelligence-'));
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'intelligence-test-encryption-key',
    logger: false,
    ...options,
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  cleanup.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let cookie = '';
  let csrf = '';
  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
    if (typeof options.body === 'string') headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const text = await response.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* binary response */ }
    return { response, body };
  };
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }),
  });
  return { app, dataDir, request, user: login.body.user };
}

async function waitForJob(request: (path: string, options?: RequestInit) => Promise<{ body: any }>, id: string) {
  let job: any;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    job = (await request(`/api/generations/${id}`)).body;
    if (['completed', 'failed'].includes(job.status)) return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return job;
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

function previousReviewedF30(): FormulaDefinition {
  const current = structuredClone(
    DEFAULT_FORMULA_VERSION.formulas.find((formula) => formula.id === 'F30')!,
  );
  const previousDescriptions: Record<string, string> = {
    trendSourceKind: '热点来源类型：xiaohongshu_hotspot_rank=指定时间观察到的小红书热点榜条目；xiaohongshu_hot_discussion=小红书热议话题但不宣称进入榜单；other_explicit_source=其他明确来源且不得伪装成前两类',
    trendSourceRef: '具体热点榜条目、热议话题或其他来源对象；不是待生成的标签',
    sourceObservedAt: '判断热点来源与时效性的观察时间或快照时间',
  };
  current.variables = current.variables.map((variable) => {
    if (!(variable.path in previousDescriptions)) return variable;
    const { format: _currentFormat, ...withoutFormat } = variable;
    return { ...withoutFormat, description: previousDescriptions[variable.path]! };
  });
  current.calculatorContract!.boundaries = [
    'xiaohongshu_hotspot_rank 只表示在 sourceObservedAt 观察到一个具体小红书热点榜条目，不证明持续热度或触达增量。',
    'xiaohongshu_hot_discussion 只表示一个具体小红书热议对象，不得冒充热点榜条目。',
    'other_explicit_source 必须填写具体来源对象，且不得改写成小红书热点榜或热议来源。',
    'relevance、bridgeClarity、timeliness 都是用户手工情景输入，未校准且不是平台观测值。',
    '标签与热点词只能表达内容关联，不能保证曝光、推荐、进入或合格触达。',
  ];
  return current;
}

test('migrates a v3 database to the current schema with source-image boundaries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-v3-current-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const databasePath = join(dataDir, 'app.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE generation_jobs (id TEXT PRIMARY KEY);
    CREATE TABLE content_packages (id TEXT PRIMARY KEY);
    INSERT INTO generation_jobs (id) VALUES ('legacy-job');
    PRAGMA user_version=3;
  `);
  legacy.close();

  const migrated = new DatabaseService(resolveOptions({ dataDir, databasePath, logger: false }));
  try {
    assert.equal(Number(migrated.prepare('PRAGMA user_version').get()?.user_version), 9);
    const tables = new Set((migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of ['project_intelligence', 'project_blueprint_modules', 'analysis_tasks', 'information_gaps', 'expression_strategies', 'image_assets', 'image_analysis_versions', 'topic_opportunities', 'coverage_records']) {
      assert.ok(tables.has(table), table);
    }
    const imageAssetColumns = migrated.prepare('PRAGMA table_info(image_assets)').all() as Array<Record<string, unknown>>;
    const assetKind = imageAssetColumns.find((column) => column.name === 'asset_kind');
    assert.equal(assetKind?.notnull, 1);
    assert.equal(assetKind?.dflt_value, "'source_material'");
    const legacyJob = migrated.prepare(
      'SELECT opportunity_snapshot_json, planning_context_json, image_context_json FROM generation_jobs WHERE id=?',
    ).get('legacy-job') as Record<string, unknown>;
    assert.equal(legacyJob.opportunity_snapshot_json, '{}');
    assert.equal(legacyJob.planning_context_json, '{}');
    assert.equal(legacyJob.image_context_json, '[]');
    const coverageFks = migrated.prepare('PRAGMA foreign_key_list(coverage_records)').all() as Array<Record<string, unknown>>;
    assert.ok(coverageFks.some((fk) => fk.table === 'content_packages' && fk.on_update === 'CASCADE'));
  } finally {
    migrated.onModuleDestroy();
  }
});

test('derives both exact official F30 parents while format or description customizations remain fail-closed', async () => {
  const { app, request, user } = await startApp();
  const database = app.get(DatabaseService);
  assert.equal(isLegacyOfficialF30(LEGACY_OFFICIAL_F30), true);

  const insertLegacyVersion = (projectId: string, formula: FormulaDefinition) => {
    database.prepare('DELETE FROM formula_versions WHERE project_id=?').run(projectId);
    const id = randomUUID();
    const createdAt = '2026-07-13T00:00:00.000Z';
    const version = createFormulaVersion({
      id,
      projectId,
      version: '1.0.0',
      status: 'active',
      createdAt,
      formulas: DEFAULT_FORMULA_VERSION.formulas.map((candidate) => candidate.id === 'F30' ? formula : candidate),
    });
    database.prepare(
      `INSERT INTO formula_versions
       (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
       VALUES (?, ?, 1, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      JSON.stringify({ name: '迁移测试公式', description: '旧版公式', version, config: {} }),
      user.id,
      createdAt,
      createdAt,
    );
    return version;
  };

  const officialProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Official F30 migration' }),
  });
  assert.equal(officialProject.response.status, 201);
  const officialProjectId = String(officialProject.body.id);
  const legacyVersion = insertLegacyVersion(officialProjectId, LEGACY_OFFICIAL_F30);

  const migrationRequest = await request(
    `/api/formulas/projects/${officialProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(migrationRequest.response.status, 200, JSON.stringify(migrationRequest.body));
  assert.equal(migrationRequest.body.changed, true);
  const migratedList = await request(`/api/formulas?projectId=${officialProjectId}`);
  assert.equal(migratedList.response.status, 200, JSON.stringify(migratedList.body));
  assert.equal(migratedList.body.length, 2);
  const migratedActive = migratedList.body.find((row: any) => row.status === 'active');
  const migratedArchived = migratedList.body.find((row: any) => row.id === legacyVersion.id);
  assert.ok(migratedActive);
  assert.equal(migratedActive.version, '2.0.0');
  assert.equal(migratedArchived.status, 'archived');
  const migratedF30 = migratedActive.formulas.find((formula: any) => formula.id === 'F30');
  assert.ok(migratedF30.calculatorContract);
  assert.equal(migratedF30.calculatorContract.outputMetric, 'TrendFit');
  assert.deepEqual(migratedF30.variables.map((variable: any) => variable.path), [
    'trendSourceKind',
    'trendSourceRef',
    'sourceObservedAt',
    'relevance',
    'bridgeClarity',
    'timeliness',
  ]);
  assert.equal(isLegacyOfficialF30(migratedF30), false);

  const migratedRow = database.prepare(
    'SELECT definition_json FROM formula_versions WHERE id=?',
  ).get(migratedActive.id) as { definition_json: string };
  const migratedStored = JSON.parse(migratedRow.definition_json);
  assert.equal(migratedStored.version.parentId, legacyVersion.id);
  assert.equal(migratedStored.version.digest, migratedActive.digest);

  const migrationAudit = database.prepare(
    "SELECT details_json FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id=?",
  ).get(migratedActive.id) as { details_json: string };
  const migrationDetails = JSON.parse(migrationAudit.details_json);
  assert.deepEqual(migrationDetails.addedFormulaIds, []);
  assert.deepEqual(migrationDetails.replacedFormulaIds, ['F30']);
  assert.deepEqual(migrationDetails.f30Migration, F30_MIGRATION_DESCRIPTOR);
  const idempotentMigration = await request(
    `/api/formulas/projects/${officialProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(idempotentMigration.body.changed, false);
  const idempotentList = await request(`/api/formulas?projectId=${officialProjectId}`);
  assert.equal(idempotentList.body.length, 2);
  assert.equal(idempotentList.body.filter((row: any) => row.status === 'active').length, 1);

  const previousReviewed = previousReviewedF30();
  assert.equal(
    formulaEquationFingerprint(previousReviewed, false),
    PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
  );
  assert.equal(isLegacyOfficialF30(previousReviewed), true);
  const previousProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Previous reviewed F30 migration' }),
  });
  assert.equal(previousProject.response.status, 201);
  const previousProjectId = String(previousProject.body.id);
  const previousVersion = insertLegacyVersion(previousProjectId, previousReviewed);
  const previousMigration = await request(
    `/api/formulas/projects/${previousProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(previousMigration.response.status, 200, JSON.stringify(previousMigration.body));
  assert.equal(previousMigration.body.changed, true);
  const previousList = await request(`/api/formulas?projectId=${previousProjectId}`);
  assert.equal(previousList.body.length, 2);
  const previousActive = previousList.body.find((row: any) => row.status === 'active');
  assert.equal(previousList.body.find((row: any) => row.id === previousVersion.id)?.status, 'archived');
  const previousMigratedF30 = previousActive.formulas.find((formula: any) => formula.id === 'F30');
  assert.equal(previousMigratedF30.variables.find((variable: any) => variable.path === 'trendSourceRef')?.format, 'trend_source_ref');
  assert.equal(previousMigratedF30.variables.find((variable: any) => variable.path === 'sourceObservedAt')?.format, 'rfc3339_timestamp');
  assert.ok(previousMigratedF30.calculatorContract.boundaries.some((boundary: string) => boundary.includes('不联网核验')));

  const assertCustomizationPending = async (name: string, customizedF30: FormulaDefinition) => {
    assert.equal(isLegacyOfficialF30(customizedF30), false, name);
    const customProject = await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    assert.equal(customProject.response.status, 201);
    const customProjectId = String(customProject.body.id);
    const customVersion = insertLegacyVersion(customProjectId, customizedF30);
    const ensureResult = await request(
      `/api/formulas/projects/${customProjectId}/ensure-reviewed-defaults`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    assert.equal(ensureResult.response.status, 200, JSON.stringify(ensureResult.body));
    assert.equal(ensureResult.body.changed, false, name);
    const customList = await request(`/api/formulas?projectId=${customProjectId}`);
    assert.equal(customList.body.length, 1, name);
    assert.equal(customList.body[0].id, customVersion.id, name);
    assert.equal(customList.body[0].status, 'active', name);
    const trace = customList.body[0].executionAudit.formulaTrace.find((formula: any) => formula.id === 'F30');
    assert.equal(trace.compatibilityStatus, 'pending_review', name);
    assert.equal(trace.handlerState, 'pending_review', name);
    return { customProjectId, customVersion };
  };

  const descriptionCustomized = structuredClone(previousReviewed);
  descriptionCustomized.variables.find((variable) => variable.path === 'trendSourceRef')!.description += '（项目自定义）';
  const descriptionPending = await assertCustomizationPending(
    'F30 description customization stays pending',
    descriptionCustomized,
  );
  const formatCustomized = structuredClone(previousReviewed);
  formatCustomized.variables.find((variable) => variable.path === 'trendSourceRef')!.format = 'rfc3339_timestamp';
  await assertCustomizationPending('F30 format customization stays pending', formatCustomized);

  const customCalculation = await request(`/api/formulas/${descriptionPending.customVersion.id}/F30/calculate`, {
    method: 'POST',
    body: JSON.stringify({ variables: {} }),
  });
  assert.equal(customCalculation.response.status, 400);
  assert.equal(customCalculation.body.code, 'FORMULA_CALCULATOR_NOT_AVAILABLE');
  assert.equal(customCalculation.body.compatibilityStatus, 'pending_review');
});

test('migrates only exact official legacy F32/F33 contracts on the explicit manage path', async () => {
  const { app, request, user } = await startApp();
  const database = app.get(DatabaseService);
  const legacyDiagnostic = (formulaId: 'F32' | 'F33'): FormulaDefinition => {
    const formula = structuredClone(DEFAULT_FORMULA_VERSION.formulas.find((item) => item.id === formulaId)!);
    if (formulaId === 'F32') {
      formula.title = '正文诊断卡';
      formula.equation = 'Q̂B=positive signals-costs-risks-errors';
      formula.purpose = '逐项体检正文';
      formula.plainLanguage = '正文诊断卡：逐项体检正文。它是待验证的推理或离线代理，不是平台经验定律。';
    } else {
      formula.title = '评论诊断卡';
      formula.equation = 'Q̂C=coverage+increment+fit+grounding+liveness-contradiction-marketing';
      formula.purpose = '逐项体检问答线程';
      formula.plainLanguage = '评论诊断卡：逐项体检问答线程。它是待验证的推理或离线代理，不是平台经验定律。';
    }
    delete formula.diagnosticContract;
    return formula;
  };
  const legacyF32 = legacyDiagnostic('F32');
  const legacyF33 = legacyDiagnostic('F33');
  assert.equal(isLegacyOfficialF32OrF33(legacyF32), true);
  assert.equal(isLegacyOfficialF32OrF33(legacyF33), true);

  const insertVersion = (
    projectId: string,
    f32: FormulaDefinition,
    f33: FormulaDefinition,
  ) => {
    database.prepare('DELETE FROM formula_versions WHERE project_id=?').run(projectId);
    const id = randomUUID();
    const createdAt = '2026-07-14T00:00:00.000Z';
    const version = createFormulaVersion({
      id,
      projectId,
      version: '1.0.0',
      status: 'active',
      createdAt,
      formulas: DEFAULT_FORMULA_VERSION.formulas.map((formula) => formula.id === 'F32'
        ? f32
        : formula.id === 'F33'
          ? f33
          : formula),
    });
    database.prepare(
      `INSERT INTO formula_versions
       (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
       VALUES (?, ?, 1, 'active', ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      JSON.stringify({ name: 'R13 migration', description: 'legacy official diagnostics', version, config: {} }),
      user.id,
      createdAt,
      createdAt,
    );
    return version;
  };

  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Exact F32 F33 migration' }),
  });
  assert.equal(project.response.status, 201);
  const projectId = String(project.body.id);
  const legacyVersion = insertVersion(projectId, legacyF32, legacyF33);
  const rowsBeforeRead = JSON.stringify(database.prepare(
    'SELECT id, status, definition_json FROM formula_versions WHERE project_id=? ORDER BY version',
  ).all(projectId));
  const auditBeforeRead = Number((database.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id IN (SELECT id FROM formula_versions WHERE project_id=?)",
  ).get(projectId) as { value: number }).value);
  const readOnlyList = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(readOnlyList.response.status, 200);
  assert.equal(readOnlyList.body.length, 1);
  assert.equal(JSON.stringify(database.prepare(
    'SELECT id, status, definition_json FROM formula_versions WHERE project_id=? ORDER BY version',
  ).all(projectId)), rowsBeforeRead);
  assert.equal(Number((database.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id IN (SELECT id FROM formula_versions WHERE project_id=?)",
  ).get(projectId) as { value: number }).value), auditBeforeRead);

  const migration = await request(
    `/api/formulas/projects/${projectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(migration.response.status, 200, JSON.stringify(migration.body));
  assert.equal(migration.body.changed, true);
  const migratedList = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(migratedList.body.length, 2);
  const active = migratedList.body.find((row: any) => row.status === 'active');
  assert.equal(migratedList.body.find((row: any) => row.id === legacyVersion.id)?.status, 'archived');
  for (const formulaId of ['F32', 'F33']) {
    const formula = active.formulas.find((item: any) => item.id === formulaId);
    assert.equal(formula.diagnosticContract.mode, 'display_priority_metadata');
    assert.equal(formula.diagnosticContract.scoreProduced, false);
    assert.equal(formula.diagnosticContract.missingDataPolicy, 'unknown_not_zero');
    assert.equal(isLegacyOfficialF32OrF33(formula), false);
  }
  const audit = database.prepare(
    "SELECT details_json FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id=?",
  ).get(active.id) as { details_json: string };
  const details = JSON.parse(audit.details_json);
  assert.deepEqual(details.replacedFormulaIds, ['F32', 'F33']);
  assert.deepEqual(details.f32F33Migration, {
    ...F32_F33_MIGRATION_DESCRIPTOR,
    migratedFormulaIds: ['F32', 'F33'],
  });
  const idempotent = await request(
    `/api/formulas/projects/${projectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(idempotent.body.changed, false);

  const customProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Custom F32 preserved' }),
  });
  const customProjectId = String(customProject.body.id);
  const customF32 = structuredClone(legacyF32);
  customF32.title += '（项目自定义）';
  assert.equal(isLegacyOfficialF32OrF33(customF32), false);
  const customParent = insertVersion(customProjectId, customF32, legacyF33);
  const customMigration = await request(
    `/api/formulas/projects/${customProjectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(customMigration.body.changed, true);
  const customList = await request(`/api/formulas?projectId=${customProjectId}`);
  const customActive = customList.body.find((row: any) => row.status === 'active');
  assert.equal(customList.body.find((row: any) => row.id === customParent.id)?.status, 'archived');
  const preservedF32 = customActive.formulas.find((item: any) => item.id === 'F32');
  const migratedF33 = customActive.formulas.find((item: any) => item.id === 'F33');
  assert.equal(preservedF32.title, customF32.title);
  assert.equal(preservedF32.diagnosticContract, undefined);
  assert.equal(migratedF33.diagnosticContract.mode, 'display_priority_metadata');
  const f32Trace = customActive.executionAudit.formulaTrace.find((item: any) => item.id === 'F32');
  assert.equal(f32Trace.compatibilityStatus, 'pending_review');
  const customAudit = database.prepare(
    "SELECT details_json FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id=?",
  ).get(customActive.id) as { details_json: string };
  assert.deepEqual(JSON.parse(customAudit.details_json).replacedFormulaIds, ['F33']);

  const draftProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Draft creation does not migrate' }),
  });
  const draftProjectId = String(draftProject.body.id);
  const draftLegacyParent = insertVersion(draftProjectId, legacyF32, legacyF33);
  const migrationAuditBeforeDraft = Number((database.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id IN (SELECT id FROM formula_versions WHERE project_id=?)",
  ).get(draftProjectId) as { value: number }).value);
  const draftCreation = await request('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({
      projectId: draftProjectId,
      name: '从旧启用版本创建草稿',
      description: '不得隐式迁移父版本',
    }),
  });
  assert.equal(draftCreation.response.status, 201, JSON.stringify(draftCreation.body));
  assert.equal(draftCreation.body.status, 'draft');
  assert.equal(draftCreation.body.formulas.find((item: any) => item.id === 'F32').diagnosticContract, undefined);
  assert.equal(draftCreation.body.formulas.find((item: any) => item.id === 'F33').diagnosticContract, undefined);
  const rowsAfterDraft = await request(`/api/formulas?projectId=${draftProjectId}`);
  assert.equal(rowsAfterDraft.body.length, 2);
  const unchangedActive = rowsAfterDraft.body.find((row: any) => row.status === 'active');
  assert.equal(unchangedActive.id, draftLegacyParent.id);
  assert.equal(rowsAfterDraft.body.filter((row: any) => row.status === 'archived').length, 0);
  assert.equal(Number((database.prepare(
    "SELECT COUNT(*) AS value FROM audit_logs WHERE action='formula.auto-upgrade' AND entity_id IN (SELECT id FROM formula_versions WHERE project_id=?)",
  ).get(draftProjectId) as { value: number }).value), migrationAuditBeforeDraft);
});

test('unknown opportunity metrics remain null and no longer block selection or generation', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Unknown metric gate' }),
  });
  assert.equal(project.response.status, 201);
  const projectId = String(project.body.id);
  seedApprovedProjectBlueprint(app, projectId);

  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Which evidence changes the decision?', priority: 90 }),
  });
  const strategy = await request(`/api/projects/${projectId}/expression-strategies`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Evidence-first answer' }),
  });
  const incomplete = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Incomplete opportunity',
      gapIds: [gap.body.id],
      strategyId: strategy.body.id,
      status: 'eligible',
    }),
  });
  assert.equal(incomplete.response.status, 201, JSON.stringify(incomplete.body));
  const expectedUnknownMetrics = [
    'relevance',
    'importance',
    'proofability',
    'decisionLeverage',
    'novelty',
    'cognitiveCost',
    'risk',
  ];
  for (const metric of expectedUnknownMetrics) {
    assert.equal(incomplete.body[metric], null, metric);
    assert.equal(incomplete.body.data[metric], null, `stored ${metric}`);
  }
  // M10 解耦：资格状态由用户显式断言（此处提交 eligible），不再被未知度量改写为 unknown。
  // 预测轴（reviewRequired / unknownMetrics）独立标记度量待复核，仅作参考提示；未知度量不再阻断
  // 审批 / 选择 / 生成（需求 2.4 / 2.5 / 2.7），真正的阻断只来自结构轴硬门禁（需求 3）。
  assert.equal(incomplete.body.eligibilityStatus, 'eligible');
  assert.equal(incomplete.body.reviewRequired, true);
  assert.deepEqual(incomplete.body.unknownMetrics, expectedUnknownMetrics);
  assert.equal(incomplete.body.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(incomplete.body.heuristic.version, '1.0.0');
  assert.equal(incomplete.body.heuristic.weightsCalibrated, false);
  assert.equal(incomplete.body.heuristic.causal, false);
  assert.equal(incomplete.body.heuristic.notF28, true);
  assert.equal(incomplete.body.scoreSemantics, 'ordinal_noncausal_heuristic');
  assert.equal(incomplete.body.finalScore, null);
  assert.equal(incomplete.body.rank, null);
  assert.equal(incomplete.body.effectiveEligibility, 'review_required');
  assert.equal(incomplete.body.recentCoverage.status, 'provided');
  assert.equal(incomplete.body.recentCoverage.count, 0);
  assert.equal(incomplete.body.recentCoverage.source.source, 'observed');
  assert.equal(incomplete.body.inputSources.options.source, 'default_policy');
  assert.equal(incomplete.body.components.length, 7);
  assert.ok(incomplete.body.components.every((item: any) => item.rawValue === null));
  assert.ok(incomplete.body.components.every((item: any) => item.source.source === 'unknown'));
  // M10 解耦：持久化的资格状态保留用户断言（eligible），不被未知度量改写。
  assert.equal(incomplete.body.data.status, 'eligible');
  assert.equal(incomplete.body.data.score, null);
  // 预测轴：度量 provenance 如实标记未知。
  assert.equal(incomplete.body.data.rankInputSources.metrics.relevance.source, 'unknown');
  // 结构轴：资格状态 provenance 反映用户断言，两轴分列后不再被未知度量改写为 system_heuristic 的"被迫 unknown"。
  assert.equal(incomplete.body.data.rankInputSources.status.source, 'user');

  // 需求 2.5 / 2.7 + 需求 3：未知度量不再阻断可选择性——此处 /select 不再因"缺度量"被拒绝
  // （旧的 "missing metrics" 度量门禁已移除）。它被拒绝的原因是真正的结构轴硬门禁：引用的信息缺口
  // 尚未独立审批。命中即拒绝且不持久化（approvalStatus 仍为 draft）。
  const blockedByGapApproval = await request(
    `/api/projects/${projectId}/topic-opportunities/${incomplete.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(blockedByGapApproval.response.status, 400);
  assert.match(String(blockedByGapApproval.body.message), /Approve the referenced information gaps independently/);
  assert.doesNotMatch(String(blockedByGapApproval.body.message), /missing metrics/);
  const unchangedIncomplete = await request(
    `/api/projects/${projectId}/topic-opportunities/${incomplete.body.id}`,
  );
  assert.equal(unchangedIncomplete.body.approvalStatus, 'draft');

  const service = app.get(IntelligenceService);
  const hydrated = await service.hydratePlanningContext(projectId, {
    opportunities: [{
      id: 'legacy-incomplete',
      topic: 'Legacy incomplete opportunity',
      angle: '',
      gapIds: [gap.body.id],
      audienceStage: 'collecting',
      entry: 'search',
      relevance: 0.9,
      importance: 0.8,
      proofability: 0.7,
      novelty: 0.6,
      decisionLeverage: 0.8,
      cognitiveCost: 0.3,
      evidenceIds: [],
      boundaries: [],
      tags: [],
      imageAssetIds: [],
      status: 'eligible',
    } as any],
  });
  assert.equal(hydrated?.opportunities?.[0]?.risk, null);
  // M10 解耦：即使 risk 未知，资格状态仍保留用户断言（eligible），不被未知度量改写。
  assert.equal(hydrated?.opportunities?.[0]?.status, 'eligible');
  assert.deepEqual((hydrated?.opportunities?.[0] as any).unknownMetrics, ['risk']);
  // M3（需求 5.3/5.4）预期变化：filterTopicOpportunities 已降为结构过滤，未标定阈值
  // （minProofability/maxRisk）与未知度量不再筛除结构可选选题。该选题 status=eligible、有主题、
  // 有缺口引用，结构可选，故保留（length=1）；而非旧行为下因 risk 未知被度量门禁筛除（length=0）。
  assert.equal(filterTopicOpportunities(hydrated?.opportunities ?? []).length, 1);

  const noGap = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'No implicit dependencies',
      relevance: 0.9,
      importance: 0.8,
      proofability: 0.7,
      novelty: 0.6,
      decisionLeverage: 0.8,
      cognitiveCost: 0.3,
      risk: 0.2,
      status: 'eligible',
      rankInputSources: { metrics: { risk: { source: 'observed', sourceRef: 'untrusted-client-claim' } } },
    }),
  });
  const rejectedNoGap = await request(
    `/api/projects/${projectId}/topic-opportunities/${noGap.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(noGap.body.data.rankInputSources.metrics.risk.source, 'user');
  assert.equal(noGap.body.data.rankInputSources.metrics.risk.sourceRef, 'api:user_input');
  assert.equal(rejectedNoGap.response.status, 400);
  assert.match(String(rejectedNoGap.body.message), /explicitly reference at least one information gap/);

  const complete = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Complete opportunity',
      gapIds: [gap.body.id],
      strategyId: strategy.body.id,
      relevance: 0.9,
      importance: 0.8,
      proofability: 0.7,
      novelty: 0.6,
      decisionLeverage: 0.8,
      cognitiveCost: 0.3,
      risk: 0.2,
      score: 0.99,
      status: 'eligible',
    }),
  });
  assert.equal(complete.body.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(complete.body.finalScore === null, false);
  assert.notEqual(complete.body.finalScore, 0.99);
  assert.deepEqual(complete.body.legacyInputScore, {
    value: 0.99,
    used: false,
    semantics: 'legacy_heuristic',
  });
  assert.equal(complete.body.rank, 1);
  assert.equal(complete.body.effectiveEligibility, 'eligible');
  assert.equal(complete.body.reviewRequired, false);
  assert.ok(complete.body.components.every((item: any) => item.source.source === 'user'));
  assert.ok(Object.values(complete.body.data.rankInputSources.metrics).every((item: any) => item.source === 'user'));
  const storedComplete = app.get(DatabaseService).prepare(
    'SELECT data_json FROM topic_opportunities WHERE id=?',
  ).get(complete.body.id) as { data_json: string };
  const storedCompleteData = JSON.parse(storedComplete.data_json);
  assert.equal(storedCompleteData.rankInputSources.metrics.risk.source, 'user');
  assert.equal(storedCompleteData.finalScore, undefined);
  assert.equal(storedCompleteData.heuristic, undefined);
  const rejectedDraftGap = await request(
    `/api/projects/${projectId}/topic-opportunities/${complete.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(rejectedDraftGap.response.status, 400);
  assert.match(String(rejectedDraftGap.body.message), /Approve the referenced information gaps independently/);
  assert.equal((await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}`)).body.approvalStatus, 'draft');
  assert.equal((await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}`)).body.approvalStatus, 'draft');

  // 组件 B · M2（需求 2.1 / 2.2 / 2.3）：信息缺口的度量完备性不再作为硬门禁。
  // 该缺口仍带未知度量（importance/decisionLeverage/proofability 均为 null），
  // 但审批不再因此被阻断——可直接审批通过，且未知度量原样保留（不补零/中位值/默认值）。
  const approvedGap = await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(approvedGap.response.status, 201, JSON.stringify(approvedGap.body));
  assert.equal(approvedGap.body.approvalStatus, 'approved');
  assert.equal(approvedGap.body.importance, null);
  assert.equal(approvedGap.body.decisionLeverage, null);
  assert.equal(approvedGap.body.proofability, null);
  const rejectedDraftStrategy = await request(
    `/api/projects/${projectId}/topic-opportunities/${complete.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(rejectedDraftStrategy.response.status, 400);
  assert.match(String(rejectedDraftStrategy.body.message), /Approve the referenced expression strategy independently/);
  assert.equal((await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}`)).body.approvalStatus, 'draft');

  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  const selected = await request(
    `/api/projects/${projectId}/topic-opportunities/${complete.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(selected.response.status, 201, JSON.stringify(selected.body));
  assert.equal(selected.body.opportunity.approvalStatus, 'approved');
  assert.equal(selected.body.opportunity.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(selected.body.opportunity.scoreSemantics, 'ordinal_noncausal_heuristic');
  assert.equal(selected.body.opportunity.heuristic.causal, false);
  assert.equal(selected.body.opportunity.heuristic.notF28, true);
  assert.equal(selected.body.opportunity.approvalRankAudit.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(selected.body.opportunity.approvalRankAudit.heuristic.weightsCalibrated, false);
  assert.equal(selected.body.opportunity.approvalRankAudit.heuristic.causal, false);
  assert.equal(selected.body.opportunity.approvalRankAudit.heuristic.notF28, true);
  assert.equal(selected.body.opportunity.approvalRankAudit.scoreSemantics, 'ordinal_noncausal_heuristic');
  const approvedOpportunityRow = app.get(DatabaseService).prepare(
    'SELECT data_json FROM topic_opportunities WHERE id=?',
  ).get(complete.body.id) as { data_json: string };
  const approvedOpportunityData = JSON.parse(approvedOpportunityRow.data_json);
  assert.equal(approvedOpportunityData.approvalRankAudit.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(approvedOpportunityData.approvalRankAudit.notF28, undefined);
  assert.equal(approvedOpportunityData.approvalRankAudit.heuristic.notF28, true);
  assert.equal(selected.body.informationGaps[0].approvalStatus, 'approved');
  assert.equal(selected.body.expressionStrategy.approvalStatus, 'approved');

  // 需求 2.4 / 2.5 / 2.7：含未知度量的 eligible 选题（引用已审批缺口与策略、非 blocked）应能成功选中。
  // 此前（2.2 中间态）该 /select 被 assertOpportunitySelectable 的 review_required 门禁临时阻断；
  // 放开后未知度量不再阻断可选择性，选中成功，且未知度量在审批后原样保留（不补零 / 中位值 / 默认值）。
  const selectedIncomplete = await request(
    `/api/projects/${projectId}/topic-opportunities/${incomplete.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(selectedIncomplete.response.status, 201, JSON.stringify(selectedIncomplete.body));
  assert.equal(selectedIncomplete.body.opportunity.approvalStatus, 'approved');
  assert.equal(selectedIncomplete.body.opportunity.eligibilityStatus, 'eligible');
  assert.deepEqual(selectedIncomplete.body.opportunity.unknownMetrics, expectedUnknownMetrics);
  for (const metric of expectedUnknownMetrics) {
    assert.equal(selectedIncomplete.body.opportunity[metric], null, `selected ${metric}`);
  }

  // 需求 2.5 / 2.6：生成准备对含未知度量的已选选题继续执行，并把未知度量原样透传给规划引擎
  // （不补零 / 中位值 / 默认值）。
  const preparedUnknown = service.prepareGeneration(projectId, { opportunityId: incomplete.body.id });
  const preparedOpportunities = preparedUnknown.planningContext.opportunities as Record<string, unknown>[];
  const preparedIncomplete = preparedOpportunities.find(
    (item) => String(item.id) === String(incomplete.body.id),
  );
  assert.ok(preparedIncomplete, 'the unknown-metric opportunity should reach the planning context');
  for (const metric of expectedUnknownMetrics) {
    assert.equal(preparedIncomplete![metric], null, `planning ${metric}`);
  }
  assert.deepEqual((preparedIncomplete as Record<string, unknown>).unknownMetrics, expectedUnknownMetrics);
});

test('generation revalidates selected opportunity dependencies and locks its explicit strategy', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Dependency freshness gate' }),
  });
  const projectId = String(project.body.id);
  seedApprovedProjectBlueprint(app, projectId);
  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({
      title: '应该先核对什么？',
      answer: '先核对适用条件。',
      importance: 0.9,
      decisionLeverage: 0.9,
      proofability: 0.9,
      enabled: true,
    }),
  });
  const strategy = await request(`/api/projects/${projectId}/expression-strategies`, {
    method: 'POST',
    body: JSON.stringify({ name: '选题明确策略', enabled: true, openingMode: 'dependency_opening' }),
  });
  const competingStrategy = await request(`/api/projects/${projectId}/expression-strategies`, {
    method: 'POST',
    body: JSON.stringify({ name: '全局锁定策略', enabled: true, openingMode: 'global_opening', locked: true }),
  });
  for (const [kind, id] of [
    ['information-gaps', gap.body.id],
    ['expression-strategies', strategy.body.id],
    ['expression-strategies', competingStrategy.body.id],
  ]) {
    const approved = await request(`/api/projects/${projectId}/${kind}/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(approved.response.status, 201, JSON.stringify(approved.body));
  }
  const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({
      title: '生成前核对依赖',
      gapIds: [gap.body.id],
      strategyId: strategy.body.id,
      relevance: 0.9,
      importance: 0.9,
      proofability: 0.9,
      novelty: 0.6,
      decisionLeverage: 0.9,
      cognitiveCost: 0.2,
      risk: 0.1,
      status: 'eligible',
    }),
  });
  const selected = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(selected.response.status, 201, JSON.stringify(selected.body));
  assert.equal(selected.body.opportunity.strategyId, strategy.body.id);

  const service = app.get(IntelligenceService);
  const prepared = service.prepareGeneration(projectId, {
    opportunityId: opportunity.body.id,
    lockedStrategyId: competingStrategy.body.id,
    locks: { strategyId: competingStrategy.body.id },
  });
  assert.equal(prepared.opportunitySnapshot.strategyId, strategy.body.id);
  assert.equal(
    (prepared.planningContext.orchestrationOptions as Record<string, unknown>).lockedStrategyId,
    strategy.body.id,
  );

  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ answer: '改为先核对两项条件。' }),
  });
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /information gaps are not currently approved and enabled/,
  );
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /information gaps changed or were re-approved/,
  );

  const reselectedAfterGap = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(reselectedAfterGap.response.status, 201, JSON.stringify(reselectedAfterGap.body));
  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ description: '策略内容已变更' }),
  });
  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /expression strategy changed or was re-approved/,
  );

  const reselectedAfterStrategy = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(reselectedAfterStrategy.response.status, 201, JSON.stringify(reselectedAfterStrategy.body));
  const database = app.get(DatabaseService);
  database.prepare('UPDATE information_gaps SET status=\'stale\' WHERE id=?').run(gap.body.id);
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /information gaps are not currently approved and enabled/,
  );
  database.prepare('UPDATE information_gaps SET status=\'approved\' WHERE id=?').run(gap.body.id);
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}`, { method: 'DELETE' });
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /information gaps are no longer available/,
  );
});

test('blueprint edits create a new version and stale dependent approvals before generation', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Blueprint version gate', domain: 'general decision support' }),
  });
  const projectId = String(project.body.id);
  const intelligenceId = seedApprovedProjectBlueprint(app, projectId);
  const listed = await request(`/api/projects/${projectId}/blueprint-modules`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.filter((module: any) => module.status === 'approved').length, 7);
  const domain = listed.body.find((module: any) => module.moduleKey === 'domain_model' && module.status === 'approved');
  assert.ok(domain);

  const updated = await request(`/api/projects/${projectId}/blueprint-modules/${domain.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      data: { ...domain.data, projectNoun: '更新后的项目名词', decisionTasks: ['核验新的选择条件'] },
    }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.notEqual(updated.body.id, domain.id);
  assert.equal(updated.body.version, domain.version + 1);
  assert.equal(updated.body.status, 'draft');

  const database = app.get(DatabaseService);
  const oldDomain = database.prepare('SELECT status FROM project_blueprint_modules WHERE id=?')
    .get(domain.id) as { status: string };
  assert.equal(oldDomain.status, 'stale');
  const intelligence = database.prepare('SELECT status FROM project_intelligence WHERE id=?')
    .get(intelligenceId) as { status: string };
  assert.equal(intelligence.status, 'stale');
  const dependentStatuses = database.prepare(
    `SELECT module_key, status FROM project_blueprint_modules
     WHERE intelligence_id=? AND module_key IN ('audience_model','scenario_model','role_model','claim_policy','surface_language')`,
  ).all(intelligenceId) as unknown as Array<{ module_key: string; status: string }>;
  assert.ok(dependentStatuses.every((module) => module.status === 'stale'));

  const blocked = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, topic: '不应绕过蓝图审核' }),
  });
  assert.equal(blocked.response.status, 400, JSON.stringify(blocked.body));
  assert.match(String(blocked.body.message), /approved project analysis/u);
});

test('planning CRUD, explicit approvals, image safety and generation snapshots work together', async () => {
  const { app, request, user } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Planning integration', domain: 'health education' }),
  });
  assert.equal(project.response.status, 201);
  const projectId = project.body.id as string;
  seedApprovedProjectBlueprint(app, projectId);
  const database = app.get(DatabaseService);
  const legacyFormulaId = crypto.randomUUID();
  const formulaCreatedAt = new Date().toISOString();
  const legacyFormula = createFormulaVersion({
    id: legacyFormulaId,
    projectId,
    version: '1.0.0',
    status: 'active',
    createdAt: formulaCreatedAt,
    formulas: DEFAULT_FORMULA_VERSION.formulas.filter((formula) => Number(formula.id.slice(1)) <= 37),
  });
  database.prepare('DELETE FROM formula_versions WHERE project_id=?').run(projectId);
  database.prepare(
    `INSERT INTO formula_versions
     (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
     VALUES (?, ?, 1, 'active', ?, ?, ?, ?)`,
  ).run(
    legacyFormulaId,
    projectId,
    JSON.stringify({ name: 'Legacy customized formula', description: 'keep me', version: legacyFormula, config: { custom: true } }),
    user.id,
    formulaCreatedAt,
    formulaCreatedAt,
  );
  const formulaUpgrade = await request(
    `/api/formulas/projects/${projectId}/ensure-reviewed-defaults`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  assert.equal(formulaUpgrade.response.status, 200, JSON.stringify(formulaUpgrade.body));
  assert.equal(formulaUpgrade.body.changed, true);
  const upgradedFormulas = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(upgradedFormulas.body[0].formulaCount, 43);
  assert.equal(upgradedFormulas.body[0].status, 'active');
  assert.equal(upgradedFormulas.body[1].formulaCount, 37);
  assert.equal(upgradedFormulas.body[1].status, 'archived');
  const upgradedStored = database.prepare(
    "SELECT id, definition_json FROM formula_versions WHERE project_id=? AND status='active'",
  ).get(projectId) as { id: string; definition_json: string };
  assert.equal(JSON.parse(upgradedStored.definition_json).version.parentId, legacyFormulaId);
  const upgradedRelease = await request(`/api/projects/${projectId}/research/releases`, {
    method: 'POST',
    body: JSON.stringify({
      version: '0.2.0-planning-test',
      formulaVersionId: upgradedStored.id,
      notes: '绑定显式升级后的公式。',
      bindings: {},
    }),
  });
  assert.equal(upgradedRelease.response.status, 201, JSON.stringify(upgradedRelease.body));
  const reviewedRelease = await request(`/api/projects/${projectId}/research/releases/${upgradedRelease.body.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(reviewedRelease.body.status, 'approved', JSON.stringify(reviewedRelease.body));
  const activatedRelease = await request(`/api/projects/${projectId}/research/releases/${upgradedRelease.body.id}/activate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(activatedRelease.body.status, 'active', JSON.stringify(activatedRelease.body));

  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({
      title: '适用边界是什么？',
      priority: 90,
      category: 'decision',
      audienceStages: ['collecting'],
      importance: 0.9,
      decisionLeverage: 0.85,
      proofability: 0.8,
      required: true,
      preferredChannels: ['N.body', 'Cref'],
    }),
  });
  assert.equal(gap.response.status, 201);
  assert.equal(gap.body.approvalStatus, 'draft');
  assert.equal(gap.body.status, 'draft');
  assert.equal(gap.body.proofability, 0.8);

  const strategy = await request(`/api/projects/${projectId}/expression-strategies`, {
    method: 'POST',
    body: JSON.stringify({
      name: '问题入口',
      openingMode: 'reader_question',
      narrativeMode: 'question_framework_boundary',
      bodyRole: 'minimum_sufficient_information',
      imageRole: 'evidence',
      commentMode: 'gap_completion',
      sequence: ['question', 'answer', 'boundary'],
      targetChannels: ['N.body', 'Cref'],
    }),
  });
  assert.equal(strategy.response.status, 201);
  assert.equal(strategy.body.openingMode, 'reader_question');
  assert.equal(strategy.body.bodyRole, 'minimum_sufficient_information');
  assert.equal(strategy.body.enabled, true);
  assert.equal(strategy.body.randomization.enabled, true);

  const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({
      title: '做决定前先核对适用边界',
      topic: '做决定前先核对适用边界',
      angle: '从常见遗漏切入',
      gapIds: [gap.body.id],
      strategyId: strategy.body.id,
      audienceStage: 'collecting',
      entry: 'search',
      relevance: 0.9,
      importance: 0.9,
      proofability: 0.8,
      novelty: 0.5,
      decisionLeverage: 0.85,
      cognitiveCost: 0.3,
      risk: 0.1,
      score: 0.99,
      status: 'eligible',
    }),
  });
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  const selected = await request(`/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`, { method: 'POST' });
  assert.equal(selected.response.status, 201, JSON.stringify(selected.body));
  assert.equal(selected.body.opportunity.approvalStatus, 'approved');
  assert.equal(selected.body.informationGaps[0].approvalStatus, 'approved');

  const conflictingPreset = await request(`/api/projects/${projectId}/presets`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Planning precedence fixture',
      basePresetId: 'balanced_information',
      values: {
        audience_stage: 'ready',
        entry_route: 'profile',
        must_mention: ['preset must'],
        forbidden_phrases: ['preset forbidden'],
      },
    }),
  });
  assert.equal(conflictingPreset.response.status, 201, JSON.stringify(conflictingPreset.body));

  const generation = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      opportunityId: opportunity.body.id,
      goal: '补全决策信息',
      presetId: conflictingPreset.body.id,
      audienceStage: 'comparing',
      entryPoint: 'recommendation',
      city: 'request city',
      doctor: 'request doctor',
      mustInclude: 'request must',
      forbidden: 'request forbidden',
    }),
  });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(generation.body.resolvedConfig.task.audienceStage, 'comparing');
  assert.equal(generation.body.resolvedConfig.task.entry, 'recommendation');
  assert.equal(generation.body.resolvedConfig.task.city, 'request city');
  assert.equal(generation.body.resolvedConfig.task.doctor, 'request doctor');
  assert.deepEqual(generation.body.resolvedConfig.task.mustMention, ['request must']);
  assert.deepEqual(generation.body.resolvedConfig.task.forbidden, ['request forbidden']);
  assert.equal(generation.body.opportunitySnapshot.audienceStage, 'comparing');
  assert.equal(generation.body.opportunitySnapshot.entry, 'recommendation');
  assert.equal(generation.body.opportunitySelectionAudit.selectionMode, 'explicit_locked');
  assert.equal(generation.body.opportunitySelectionAudit.rankStatus, 'not_applied');
  assert.equal(generation.body.opportunitySelectionAudit.approvalBasis, 'approved_dependency');
  assert.equal(generation.body.opportunitySelectionAudit.selectedOpportunityRank, undefined);
  assert.equal(generation.body.opportunitySnapshot.score, undefined);
  assert.equal(generation.body.opportunitySnapshot.data.score, undefined);
  assert.equal(generation.body.opportunitySnapshot.approvalRankAudit.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.deepEqual(
    generation.body.opportunitySnapshot.opportunitySelectionAudit,
    generation.body.opportunitySelectionAudit,
  );
  assert.equal(generation.body.planningContext.recentCoverageSource.source, 'observed');
  assert.equal(generation.body.planningContext.recentCoverageSource.sourceRef, 'coverage_records');
  assert.equal(generation.body.planningContext.orchestrationOptionsSource.source, 'default_policy');
  assert.deepEqual(
    {
      minProofability: generation.body.planningContext.orchestrationOptions.minProofability,
      maxRisk: generation.body.planningContext.orchestrationOptions.maxRisk,
      recentPenaltyWeight: generation.body.planningContext.orchestrationOptions.recentPenaltyWeight,
      reuseCooldown: generation.body.planningContext.orchestrationOptions.reuseCooldown,
    },
    opportunity.body.policy,
  );
  const plannedOpportunity = generation.body.planningContext.opportunities.find((item: any) => item.id === opportunity.body.id);
  assert.equal(plannedOpportunity.audienceStage, 'comparing');
  assert.equal(plannedOpportunity.entry, 'recommendation');
  const completed = await waitForJob(request, generation.body.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.topic, '做决定前先核对适用边界');
  assert.equal(completed.opportunitySnapshot.approvalStatus, 'approved');
  assert.equal(completed.opportunitySelectionAudit.selectionMode, 'explicit_locked');
  assert.equal(completed.opportunitySelectionAudit.rankStatus, 'not_applied');
  assert.equal(completed.opportunitySelectionAudit.selectedOpportunityRank, undefined);
  assert.equal(completed.candidates.length, 3);
  assert.ok(completed.candidates.every((item: any) =>
    item.opportunitySnapshot.opportunitySelectionAudit.selectionMode === 'explicit_locked'));
  assert.ok(completed.candidates.every((item: any) => item.orchestrationSnapshot.stateSeed.stage === 'comparing'));
  assert.ok(completed.candidates.every((item: any) => item.orchestrationSnapshot.stateSeed.entry === 'recommendation'));
  assert.equal(JSON.stringify(completed.planningContext).includes('base64'), false);
  assert.equal(completed.planningContext.expressionStrategies.length, 3);
  assert.equal(completed.planningContext.expressionStrategies.filter((item: any) => item.runtimeDerived === true).length, 2);
  const coverage = await request(`/api/projects/${projectId}/coverage`);
  assert.equal(coverage.body.length, 3);

  const automaticGeneration = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: 'automatic opportunity selection audit',
      goal: 'verify that only Core supplies the applied ranking audit',
      orchestrationOptions: { minStructureDistance: 0 },
    }),
  });
  assert.equal(automaticGeneration.response.status, 201, JSON.stringify(automaticGeneration.body));
  assert.equal(automaticGeneration.body.opportunitySelectionAudit, undefined);
  const automaticCompleted = await waitForJob(request, automaticGeneration.body.id);
  assert.equal(automaticCompleted.status, 'completed', automaticCompleted.error);
  const automaticAudit = automaticCompleted.opportunitySelectionAudit;
  assert.equal(automaticCompleted.opportunitySnapshot.score, undefined);
  assert.equal(automaticAudit.selectionMode, 'heuristic_ranked');
  assert.equal(automaticAudit.rankStatus, 'applied');
  assert.equal(automaticAudit.selectedOpportunityId, opportunity.body.id);
  assert.equal(automaticAudit.selectedOpportunityRank.heuristic.id, 'OpportunityRankHeuristicV1');
  assert.equal(automaticAudit.selectedOpportunityRank.heuristic.version, '1.0.0');
  assert.equal(automaticAudit.selectedOpportunityRank.heuristic.weightsCalibrated, false);
  assert.equal(automaticAudit.selectedOpportunityRank.heuristic.causal, false);
  assert.equal(automaticAudit.selectedOpportunityRank.heuristic.notF28, true);
  assert.equal(automaticAudit.selectedOpportunityRank.scoreSemantics, 'ordinal_noncausal_heuristic');
  assert.deepEqual(automaticAudit.selectedOpportunityRank.legacyInputScore, {
    value: 0.99,
    used: false,
    semantics: 'legacy_heuristic',
  });
  assert.equal(automaticAudit.selectedOpportunityRank.reviewRequired, false);
  assert.equal(automaticAudit.selectedOpportunityRank.unknownMetrics.length, 0);
  assert.equal(automaticAudit.selectedOpportunityRank.recentCoverage.source.source, 'observed');
  assert.equal(automaticAudit.selectedOpportunityRank.components.length, 7);
  assert.ok(automaticAudit.selectedOpportunityRank.components.every((item: any) => item.source.source === 'user'));
  assert.ok(automaticCompleted.candidates.every((item: any) =>
    item.opportunitySnapshot.opportunitySelectionAudit.selectionMode === 'heuristic_ranked'));
  const storedAutomaticJob = database.prepare(
    'SELECT opportunity_snapshot_json FROM generation_jobs WHERE id=?',
  ).get(automaticCompleted.id) as { opportunity_snapshot_json: string };
  const storedAutomaticSnapshot = JSON.parse(storedAutomaticJob.opportunity_snapshot_json);
  assert.equal(storedAutomaticSnapshot.opportunitySelectionAudit.selectionMode, 'heuristic_ranked');
  assert.equal(
    storedAutomaticSnapshot.opportunitySelectionAudit.selectedOpportunityRank.heuristic.id,
    'OpportunityRankHeuristicV1',
  );
  const storedAutomaticPackage = database.prepare(
    'SELECT content_json FROM content_packages WHERE job_id=? ORDER BY candidate_index LIMIT 1',
  ).get(automaticCompleted.id) as { content_json: string };
  assert.equal(
    JSON.parse(storedAutomaticPackage.content_json).opportunitySnapshot.opportunitySelectionAudit.rankStatus,
    'applied',
  );
  const exportableAutomaticCandidate = automaticCompleted.candidates.find((item: any) => item.validation?.valid === true);
  assert.ok(exportableAutomaticCandidate, JSON.stringify(automaticCompleted.candidates.map((item: any) => item.validation)));
  const exportedAutomatic = await request(
    `/api/generations/${automaticCompleted.id}/candidates/${exportableAutomaticCandidate.id}/export?format=json`,
  );
  assert.equal(exportedAutomatic.response.status, 200);
  assert.equal(exportedAutomatic.body.opportunitySnapshot.opportunitySelectionAudit.selectionMode, 'heuristic_ranked');
  assert.equal(
    exportedAutomatic.body.opportunitySnapshot.opportunitySelectionAudit.selectedOpportunityRank.heuristic.id,
    'OpportunityRankHeuristicV1',
  );

  const source = await sharp({
    create: { width: 3_000, height: 40, channels: 3, background: '#cc3355' },
  }).png().toBuffer();
  const form = new FormData();
  form.set('file', new Blob([source], { type: 'image/png' }), 'wide.png');
  const uploaded = await request(`/api/projects/${projectId}/image-assets`, { method: 'POST', body: form });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.width, 2_048);
  assert.ok(uploaded.body.height <= 2_048);
  assert.equal(uploaded.body.assetKind, 'source_material');
  assert.equal(uploaded.body.lifecycleStage, 'source_asset');
  assert.equal(uploaded.body.isFinalAsset, false);
  assert.match(uploaded.body.usageBoundary, /not a generated final image/u);
  assert.throws(
    () => database.prepare("UPDATE image_assets SET asset_kind='final_asset' WHERE id=?").run(uploaded.body.id),
    /constraint failed/iu,
  );
  const duplicateForm = new FormData();
  duplicateForm.set('file', new Blob([source], { type: 'image/png' }), 'wide.png');
  const duplicate = await request(`/api/projects/${projectId}/image-assets`, { method: 'POST', body: duplicateForm });
  assert.equal(duplicate.body.id, uploaded.body.id);
  assert.equal(duplicate.body.deduplicated, true);

  const invalidForm = new FormData();
  invalidForm.set('file', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  const invalid = await request(`/api/projects/${projectId}/image-assets`, { method: 'POST', body: invalidForm });
  assert.equal(invalid.response.status, 400);

  const analysisId = crypto.randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO image_analysis_versions
     (id, image_asset_id, project_id, version, status, source_fingerprint, observation_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?)`,
  ).run(
    analysisId,
    uploaded.body.id,
    projectId,
    uploaded.body.sha256,
    JSON.stringify({ observedFacts: ['红色横幅'], inferredSignals: [], unknowns: ['拍摄地点未知'], visibleText: [], roles: ['cover'], quality: { clarity: 0.8, relevance: 0.7, textLegibility: 0.5 }, safetyFlags: [], evidenceIds: [], source: 'uploaded' }),
    user.id,
    now,
    now,
  );
  const blocked = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, topic: '图片门槛', imageAssetIds: [uploaded.body.id] }),
  });
  assert.equal(blocked.response.status, 400);
  const approved = await request(`/api/projects/${projectId}/image-assets/${uploaded.body.id}/analyses/${analysisId}/approve`, { method: 'POST' });
  assert.equal(approved.body.approvalStatus, 'approved');
  assert.equal(approved.body.status, 'approved');
  assert.equal(approved.body.mimeType, 'image/png');
  assert.equal(approved.body.sourceAssetId, uploaded.body.id);
  assert.equal(approved.body.assetKind, 'source_material');
  assert.equal(approved.body.observationStatus, 'approved');
  assert.equal(approved.body.isFinalAsset, false);
  assert.deepEqual(approved.body.observedFacts, ['红色横幅']);
  seedApprovedProjectBlueprint(app, projectId);
  const approvedImage = await request(`/api/projects/${projectId}/image-assets/${uploaded.body.id}`);
  assert.equal(approvedImage.body.analysisStatus, 'approved');
  assert.equal(approvedImage.body.latestAnalysis.id, analysisId);
  const withImage = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, topic: '图片门槛', imageAssetIds: [uploaded.body.id] }),
  });
  assert.equal(withImage.response.status, 201, JSON.stringify(withImage.body));
  const imageJob = await waitForJob(request, withImage.body.id);
  assert.equal(imageJob.status, 'completed', imageJob.error);
  assert.equal(JSON.stringify(imageJob).includes('base64'), false);
  assert.equal(imageJob.imageContextKind, 'approved_source_observations');
  assert.equal(imageJob.sourceImageAssets[0].assetKind, 'source_material');
  assert.equal(imageJob.sourceImageAssets[0].isFinalAsset, false);
  assert.deepEqual(imageJob.planningContext.imageAnalyses[0].observedFacts, ['红色横幅']);
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.imagePlan));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.schemaVersion === '1.0'));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.imageObservation?.status === 'approved'));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.imageObservation?.analysisAssetIds?.includes(uploaded.body.id)));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.finalImageAsset?.status === 'absent'));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.entrySnapshot?.status === 'absent'));
  assert.ok(imageJob.candidates.every((candidate: any) => candidate.productionArtifacts?.deployment?.status === 'not_deployed'));

  const revisedImageJob = await request(`/api/generations/${imageJob.id}/revise`, {
    method: 'POST',
    body: JSON.stringify({ candidateId: imageJob.candidates[0].id, instruction: 'make the image brief more concise' }),
  });
  assert.equal(revisedImageJob.response.status, 201, JSON.stringify(revisedImageJob.body));
  assert.equal(revisedImageJob.body.candidates[0].productionArtifacts.imageObservation.status, 'approved');
  assert.ok(revisedImageJob.body.candidates[0].productionArtifacts.imageObservation.analysisAssetIds.includes(uploaded.body.id));
  assert.equal(revisedImageJob.body.candidates[0].productionArtifacts.finalImageAsset.status, 'absent');
  assert.equal(revisedImageJob.body.candidates[0].productionArtifacts.entrySnapshot.status, 'absent');
  assert.equal(revisedImageJob.body.candidates[0].productionArtifacts.deployment.status, 'not_deployed');
  const revisionEvent = database.prepare(
    `SELECT details_json FROM generation_events WHERE job_id=? AND event='revised' ORDER BY id DESC LIMIT 1`,
  ).get(imageJob.id) as { details_json: string };
  assert.equal(JSON.parse(revisionEvent.details_json).approvedSourceImageAnalysisCount, 1);

  const service = app.get(IntelligenceService);
  const principal: SessionPrincipal = {
    kind: 'session', userId: user.id, username: 'admin', systemRole: 'admin', mustChangePassword: false, tokenHash: '', csrfHash: '',
  };
  await assert.rejects(
    service.uploadImage({ projectId, filename: '../escape.png', buffer: source, principal }),
    /filename cannot contain a path/,
  );
  assert.throws(
    () => service.prepareGeneration(projectId, { topic: 'too many', imageAssetIds: Array.from({ length: 10 }, (_, index) => `asset-${index}`) }),
    /at most 9/,
  );
  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { ...strategy.body.data, locked: true, randomization: { enabled: true } } }),
  });
  await request(`/api/projects/${projectId}/expression-strategies/${strategy.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  const lockedPlanning = service.prepareGeneration(projectId, { topic: 'locked strategy check' });
  const lockedStrategies = lockedPlanning.planningContext.expressionStrategies as Array<Record<string, unknown>>;
  assert.equal(lockedStrategies.length, 1);
  assert.equal(lockedStrategies[0]?.locked, true);
  assert.equal(lockedStrategies[0]?.runtimeDerived, undefined);
});

test('project analysis is cached and failed retries do not create intelligence facts', async () => {
  let calls = 0;
  let fail = false;
  let lastRequestBody = '';
  const modelServer: Server = createServer(async (request, response) => {
    calls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    lastRequestBody = Buffer.concat(chunks).toString('utf8');
    if (fail) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'temporary failure' } }));
      return;
    }
    const analysis = {
      blueprintModules: {
        knowledge_map: { entries: [] },
        domain_model: {
          projectNoun: '课程选择', industry: 'education', domain: 'decision support',
          objects: ['课程'], actions: ['比较', '核验'], concepts: ['适用边界'],
          decisionTasks: ['确认选择条件'], vocabulary: ['适用边界'],
        },
        audience_model: {
          states: [{
            id: 'collector', label: '信息收集者', stages: ['collecting', 'comparing'],
            goals: ['补全判断依据'], constraints: [], knowledgeState: '缺少比较依据',
            hesitationReasons: ['信息口径不同'], actionConditions: ['关键边界可核验'],
            source: { status: 'inference', evidenceIds: [] },
          }],
        },
        scenario_model: {
          families: [{
            id: 'course-comparison', label: '课程比较', prototype: 'option_comparison',
            applicableStages: ['collecting', 'comparing'], hostIdentityCues: ['正在选课的人'],
            lifeContexts: ['午休时查资料'], timeAnchors: ['今天'], settings: ['查看课程页时'],
            triggers: ['两种介绍对不上'], observableActions: ['记下差异'], frictions: ['时间有限'],
            emotionalAftertastes: ['想问清再决定'], imageMoments: ['课程比较记录'],
            prohibitedUnsupportedHistories: [], source: { status: 'hypothesis', evidenceIds: [] },
          }],
        },
        role_model: {
          hostVoiceTraits: ['具体'], hostSpeechMarkers: ['短句'],
          roles: [{
            id: 'peer', displayRole: '同阶段选课者', relationToHost: '也在比较课程',
            identityCues: ['也在做功课'], situationCues: ['时间有限'], motives: ['确认边界'],
            knowledgePosition: '只知道公开课程信息', speechPatterns: ['窄问题'], lexicalCues: [],
            interactionHooks: ['追问条件'], permittedContributions: ['条件化问题'],
            utteranceModes: ['direct_question'], replyDisplayRoles: ['发布者'], targetChars: [6, 30],
            accountable: false, source: { status: 'hypothesis', evidenceIds: [] },
          }],
        },
        claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: ['保持未知'] },
        surface_language: {
          registerDescription: '自然具体', preferredTerms: ['课程'], optionalColloquialisms: [],
          prohibitedCliches: ['闭眼入'], antiCopyRules: ['不复制样本原句'],
        },
      },
      intelligence: { industry: 'education', domain: 'decision support', projectSummary: 'test', verifiedFacts: [], differentiators: [], audienceStates: ['collecting'], hardBoundaries: [], prohibitedClaims: [], dynamicUnknowns: [], evidenceIds: [] },
      informationGaps: [
        { key: 'proof_gap', title: '还缺什么证据？', priority: 80, label: '证据缺口', question: '还缺什么证据？', category: 'verification', audienceStages: ['collecting'], importance: 0.8, decisionLeverage: 0.8, proofability: 0.6, evidenceIds: [], required: true },
        { key: 'boundary_gap', title: '适用边界是什么？', priority: 75, label: '边界缺口', question: '适用边界是什么？', category: 'decision', audienceStages: ['comparing'], importance: 0.75, decisionLeverage: 0.7, proofability: 0.7, evidenceIds: [], required: true },
      ],
      expressionStrategies: [{ name: '克制问答', label: '克制问答', openingMode: 'reader_question', narrativeMode: 'question_framework_boundary', bodyRole: 'minimum_sufficient_information', imageRole: 'other', commentMode: 'gap_completion', voice: '克制', sequence: [], targetChannels: ['N.body'] }],
      topicOpportunities: [
        { title: '先找证据再决定', topic: '先找证据再决定', angle: '核验', gapKeys: ['proof_gap'], audienceStage: 'collecting', entry: 'search', relevance: 0.9, importance: 0.8, proofability: 0.6, novelty: 0.5, decisionLeverage: 0.8, cognitiveCost: 0.3, risk: 0.2, evidenceIds: [], boundaries: [], tags: [], imageAssetIds: [], status: 'eligible' },
        { title: '边界比结论更重要', topic: '边界比结论更重要', angle: '条件', gapKeys: ['boundary_gap'], audienceStage: 'comparing', entry: 'search', relevance: 0.85, importance: 0.75, proofability: 0.7, novelty: 0.55, decisionLeverage: 0.7, cognitiveCost: 0.3, risk: 0.2, evidenceIds: [], boundaries: [], tags: [], imageAssetIds: [], status: 'eligible' },
      ],
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ output_text: JSON.stringify(analysis) }));
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen));
  cleanup.push(() => new Promise<void>((resolveClose, rejectClose) => modelServer.close((error) => error ? rejectClose(error) : resolveClose())));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');
  const { app, request, user } = await startApp({
    platformApiKey: 'test-key',
    platformBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    platformModel: 'analysis-test',
    platformTransport: 'responses',
  });
  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Cache project' }) });
  const oldKnowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.body.id,
      filename: 'analysis-facts.md',
      category: 'facts',
      evidenceStatus: 'observed',
      content: 'SUPERSEDED_ANALYSIS_KNOWLEDGE',
      metadata: { kind: 'fact' },
    }),
  });
  assert.equal(oldKnowledge.response.status, 201, JSON.stringify(oldKnowledge.body));
  const currentKnowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.body.id,
      filename: 'analysis-facts.md',
      category: 'facts',
      evidenceStatus: 'observed',
      content: 'CURRENT_ANALYSIS_KNOWLEDGE',
      metadata: { kind: 'fact' },
    }),
  });
  assert.equal(currentKnowledge.response.status, 201, JSON.stringify(currentKnowledge.body));
  const path = `/api/projects/${project.body.id}/intelligence/analyze`;
  const first = await request(path, { method: 'POST', body: '{}' });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.ok(lastRequestBody.includes('CURRENT_ANALYSIS_KNOWLEDGE'));
  assert.equal(lastRequestBody.includes('SUPERSEDED_ANALYSIS_KNOWLEDGE'), false);
  assert.ok(lastRequestBody.includes('OpportunityRankHeuristicV1'));
  assert.ok(lastRequestBody.includes('Do not emit score, rank, finalScore'));
  assert.equal(lastRequestBody.includes('"relevance":0.8'), false);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.blueprintModules.length, 7);
  assert.ok(first.body.blueprintModules.every((module: any) => module.status === 'draft'));
  assert.equal(first.body.topicOpportunities.length, 2);
  assert.equal(first.body.topicOpportunities[0].gapIds.length, 1);
  assert.equal(first.body.topicOpportunities[1].gapIds.length, 1);
  assert.notEqual(first.body.topicOpportunities[0].gapIds[0], first.body.topicOpportunities[1].gapIds[0]);
  for (const analyzedOpportunity of first.body.topicOpportunities) {
    assert.equal(analyzedOpportunity.heuristic.id, 'OpportunityRankHeuristicV1');
    assert.equal(analyzedOpportunity.scoreSemantics, 'ordinal_noncausal_heuristic');
    assert.equal(analyzedOpportunity.heuristic.weightsCalibrated, false);
    assert.equal(analyzedOpportunity.heuristic.causal, false);
    assert.equal(analyzedOpportunity.heuristic.notF28, true);
    assert.equal(analyzedOpportunity.reviewRequired, false);
    assert.equal(analyzedOpportunity.recentCoverage.status, 'provided');
    assert.ok(analyzedOpportunity.components.every((item: any) => item.source.source === 'model_heuristic'));
    assert.ok(Object.values(analyzedOpportunity.data.rankInputSources.metrics)
      .every((item: any) => item.source === 'model_heuristic'));
  }
  const second = await request(path, { method: 'POST', body: '{}' });
  assert.equal(second.body.cached, true);
  assert.equal(calls, 3);
  for (const module of first.body.blueprintModules) {
    const approvedModule = await request(
      `/api/projects/${project.body.id}/blueprint-modules/${module.id}/approve`,
      { method: 'POST', body: JSON.stringify({ status: 'approved' }) },
    );
    assert.equal(approvedModule.response.status, 201, JSON.stringify(approvedModule.body));
    assert.equal(approvedModule.body.status, 'approved');
  }
  const approvedIntelligence = await request(
    `/api/projects/${project.body.id}/intelligence/${first.body.intelligence.id}/approve`,
    { method: 'POST', body: JSON.stringify({ status: 'approved' }) },
  );
  assert.equal(approvedIntelligence.body.status, 'approved');
  const imageBuffer = await sharp({
    create: { width: 24, height: 24, channels: 3, background: '#225588' },
  }).png().toBuffer();
  const imageForm = new FormData();
  imageForm.set('file', new Blob([imageBuffer], { type: 'image/png' }), 'cache-source.png');
  const uploaded = await request(`/api/projects/${project.body.id}/image-assets`, { method: 'POST', body: imageForm });
  const imageAnalysisId = crypto.randomUUID();
  const now = new Date().toISOString();
  app.get(DatabaseService).prepare(
    `INSERT INTO image_analysis_versions
     (id, image_asset_id, project_id, version, status, source_fingerprint, observation_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?)`,
  ).run(
    imageAnalysisId,
    uploaded.body.id,
    project.body.id,
    uploaded.body.sha256,
    JSON.stringify({ observedFacts: ['蓝色方形图片'], inferredSignals: [], unknowns: [], visibleText: [], roles: ['cover'], quality: { clarity: 0.9, relevance: 0.7, textLegibility: 0.5 }, safetyFlags: [], evidenceIds: [], source: 'uploaded' }),
    user.id,
    now,
    now,
  );
  await request(
    `/api/projects/${project.body.id}/image-assets/${uploaded.body.id}/analyses/${imageAnalysisId}/approve`,
    { method: 'POST', body: JSON.stringify({ status: 'approved' }) },
  );
  const stale = await request(`/api/projects/${project.body.id}/intelligence`);
  assert.equal(stale.body.find((item: any) => item.id === first.body.intelligence.id).status, 'stale');
  const imageAware = await request(path, { method: 'POST', body: '{}' });
  assert.equal(imageAware.body.cached, false);
  assert.equal(calls, 6);
  assert.ok(lastRequestBody.includes(uploaded.body.id));
  const before = await request(`/api/projects/${project.body.id}/intelligence`);
  fail = true;
  const failed = await request(path, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(failed.response.status, 500);
  assert.equal(calls, 9);
  const after = await request(`/api/projects/${project.body.id}/intelligence`);
  assert.equal(after.body.length, before.body.length);
  const tasks = await request(`/api/projects/${project.body.id}/intelligence/analysis-tasks`);
  assert.equal(tasks.body[0].status, 'failed');
  assert.equal(tasks.body[0].attemptCount, 3);
});
