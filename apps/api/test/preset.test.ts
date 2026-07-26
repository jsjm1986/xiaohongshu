import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService, SCHEMA_VERSION } from '../src/database.service.js';
import { resolveOptions } from '../src/config.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let projectId = '';
let customPresetId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json();
  return { response, body: body as any };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-preset-'));
  app = await createApplication({
    dataDir,
    adminPassword: 'Preset-bootstrap-123!',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Preset-bootstrap-123!' }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: 'Preset-bootstrap-123!',
      newPassword: 'Preset-updated-456!',
    }),
  });
  assert.equal(changed.response.status, 201);
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: '预设测试项目',
      domain: '医美',
      productPoints: ['先判断适用条件'],
    }),
  });
  assert.equal(project.response.status, 201);
  projectId = project.body.id;
  seedApprovedProjectBlueprint(app, projectId);
  const formulas = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(formulas.response.status, 200);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('schema is a flattened projection of the core parameter registry', async () => {
  const result = await request(`/api/generation-parameters/schema?projectId=${projectId}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.schemaVersion, '1.0');
  assert.ok(result.body.parameters.length > 30);
  const breadth = result.body.parameters.find((item: any) => item.id === 'information_breadth');
  assert.equal(breadth.control, 'slider');
  assert.equal(breadth.min, 0);
  assert.equal(breadth.max, 100);
  assert.ok(Array.isArray(breadth.formulaIds));
  assert.ok(typeof breadth.equation === 'string' && breadth.equation.length > 0);
  assert.equal(result.body.presets.length, 10);
  assert.ok(result.body.presets.some((item: any) => item.id === 'minimal_body_conditional_comments'));
  assert.ok(result.body.styleProfiles.some((item: any) => item.id === 'reference_compact_70'));
  assert.equal(result.body.sampleBaseline.evidenceStatus, 'sample_observation');
});

test('built-in and custom differential presets support CRUD, copy and default selection', async () => {
  const initial = await request(`/api/projects/${projectId}/presets`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.length, 10);
  assert.deepEqual(
    initial.body.map((item: any) => item.id),
    [
      'real_minimal',
      'first_research',
      'rational_compare',
      'hesitation_completion',
      'local_choice',
      'balanced_information',
      'search_decision',
      'minimal_body_conditional_comments',
      'comparison_framework',
      'state_experience_entry',
    ],
  );
  assert.equal(initial.body.filter((item: any) => item.isDefault).length, 1);
  const balanced = initial.body.find((item: any) => item.id === 'balanced_information');
  const minimal = initial.body.find((item: any) => item.id === 'minimal_body_conditional_comments');
  assert.equal(balanced.isDefault, true);
  assert.equal(balanced.values.body_min_chars, 40);
  assert.equal(balanced.values.body_max_chars, 140);
  assert.equal(minimal.values.body_min_chars, 20);
  assert.equal(minimal.values.body_max_chars, 70);
  assert.ok(initial.body.every((item: any) => Array.isArray(item.instructions) && item.instructions.length >= 2));

  const created = await request(`/api/projects/${projectId}/presets`, {
    method: 'POST',
    body: JSON.stringify({
      name: '我的短正文预设',
      basePresetId: 'minimal_body_conditional_comments',
      values: { novelty_angle: 72, comment_thread_max: 5 },
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  customPresetId = created.body.id;
  assert.equal(created.body.source, 'custom');
  assert.equal(created.body.basePresetId, 'minimal_body_conditional_comments');
  assert.equal(created.body.values.body_min_chars, 20);
  assert.deepEqual(Object.keys(created.body.difference).sort(), ['novelty_angle']);

  const updated = await request(`/api/projects/${projectId}/presets/${customPresetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ values: { question_naturalness: 88 } }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.values.question_naturalness, 88);

  const defaulted = await request(`/api/projects/${projectId}/presets/${customPresetId}/default`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(defaulted.response.status, 201);
  assert.equal(defaulted.body.isDefault, true);

  const copied = await request(`/api/projects/${projectId}/presets/${customPresetId}/copy`, {
    method: 'POST',
    body: JSON.stringify({ name: '复制预设' }),
  });
  assert.equal(copied.response.status, 201);
  assert.notEqual(copied.body.id, customPresetId);
  assert.equal(copied.body.values.question_naturalness, 88);

  const removed = await request(`/api/projects/${projectId}/presets/${copied.body.id}`, {
    method: 'DELETE',
  });
  assert.equal(removed.response.status, 200);
});

test('style profile versions increment and participate in config resolution', async () => {
  const before = await request(`/api/projects/${projectId}/style-profile`);
  assert.equal(before.body.version, 1);
  const updated = await request(`/api/projects/${projectId}/style-profile`, {
    method: 'PATCH',
    body: JSON.stringify({
      baseStyleProfileId: 'calm_explanatory',
      parameterValues: { question_naturalness: 82 },
      notes: '测试画像',
    }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.version, 2);
  assert.equal(updated.body.values.baseStyleProfileId, 'calm_explanatory');
  assert.equal(updated.body.values.parameterValues.question_naturalness, 82);
});

test('resolve-config returns final config, source map, warnings and both impact projections', async () => {
  const result = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: '短正文配置预览',
      goal: '验证预设解析',
      audienceStage: 'comparing',
      entryPoint: 'search',
      presetId: customPresetId,
      parameterValues: {
        body_min_chars: 90,
        body_max_chars: 160,
        comment_thread_min: 2,
        comment_thread_max: 2,
      },
      overrides: {
        route_specificity: 90,
        comment_role_diversity: 90,
        comment_constraint_density: 85,
        comment_gap_multiplexing: 80,
        comment_reply_increment: 88,
        question_compression: 80,
        comment_discovery_strength: 80,
        comment_inference_effort: 45,
        comment_self_verification: 85,
        comment_false_closure_guard: 98,
        content: { hashtagMin: 2, hashtagMax: 2 },
      },
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.resolvedConfig.task.theme, '短正文配置预览');
  assert.equal(result.body.resolvedConfig.task.audienceStage, 'comparing');
  assert.equal(result.body.resolvedConfig.content.bodyMinChars, 90);
  assert.equal(result.body.resolvedConfig.content.bodyMaxChars, 160);
  assert.equal(result.body.resolvedConfig.content.commentThreadMin, 2);
  assert.equal(result.body.resolvedConfig.content.hashtagMin, 2);
  assert.equal(result.body.styleProfileVersion, 2);
  assert.ok(Array.isArray(result.body.impacts));
  assert.ok(Array.isArray(result.body.impactReport));
  assert.ok(Array.isArray(result.body.parameterImpactReport.parameterTraces));
  assert.equal(result.body.sourceMap.body_min_chars, 'parameter-values');
  assert.equal(result.body.sourceMap.comment_role_diversity, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_constraint_density, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_gap_multiplexing, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_reply_increment, 'task-overrides');
  assert.equal(result.body.sourceMap.question_compression, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_discovery_strength, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_inference_effort, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_self_verification, 'task-overrides');
  assert.equal(result.body.sourceMap.comment_false_closure_guard, 'task-overrides');
  assert.equal(result.body.resolvedConfig.parameters.commentRoleDiversity, 90);
  assert.equal(result.body.resolvedConfig.parameters.commentConstraintDensity, 85);
  assert.equal(result.body.resolvedConfig.parameters.commentGapMultiplexing, 80);
  assert.equal(result.body.resolvedConfig.parameters.commentReplyIncrement, 88);
  assert.equal(result.body.resolvedConfig.parameters.questionCompression, 80);
  assert.equal(result.body.resolvedConfig.parameters.commentDiscoveryStrength, 80);
  assert.equal(result.body.resolvedConfig.parameters.commentInferenceEffort, 45);
  assert.equal(result.body.resolvedConfig.parameters.commentSelfVerification, 85);
  assert.equal(result.body.resolvedConfig.parameters.commentFalseClosureGuard, 98);
  assert.ok(result.body.impacts.some((item: any) => item.parameterId === 'body_min_chars'));
});

test('per-run task fields beat presets while omitted and explicit blank remain distinct', async () => {
  const preset = await request(`/api/projects/${projectId}/presets`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Task precedence fixture',
      basePresetId: 'balanced_information',
      values: {
        audience_stage: 'ready',
        entry_route: 'profile',
        must_mention: ['preset must'],
        forbidden_phrases: ['preset forbidden'],
      },
    }),
  });
  assert.equal(preset.response.status, 201, JSON.stringify(preset.body));

  const database = app.get(DatabaseService);
  const project = database.prepare('SELECT created_by FROM projects WHERE id=?').get(projectId) as { created_by: string };
  database.prepare(
    `INSERT INTO project_settings (project_id, config_json, updated_by, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    projectId,
    JSON.stringify({ task: { city: 'inherited city', doctor: 'inherited doctor' } }),
    project.created_by,
    new Date().toISOString(),
  );

  try {
    const omitted = await request(`/api/projects/${projectId}/resolve-config`, {
      method: 'POST',
      body: JSON.stringify({ topic: 'omitted task fields', presetId: preset.body.id }),
    });
    assert.equal(omitted.response.status, 201, JSON.stringify(omitted.body));
    assert.equal(omitted.body.resolvedConfig.task.city, 'inherited city');
    assert.equal(omitted.body.resolvedConfig.task.doctor, 'inherited doctor');
    assert.deepEqual(omitted.body.resolvedConfig.task.mustMention, ['preset must']);
    assert.deepEqual(omitted.body.resolvedConfig.task.forbidden, ['preset forbidden']);

    const cleared = await request(`/api/projects/${projectId}/resolve-config`, {
      method: 'POST',
      body: JSON.stringify({
        topic: 'explicitly cleared task fields',
        presetId: preset.body.id,
        city: '',
        doctor: '',
        mustInclude: '',
        forbidden: '',
      }),
    });
    assert.equal(cleared.response.status, 201, JSON.stringify(cleared.body));
    assert.equal(cleared.body.resolvedConfig.task.city, undefined);
    assert.equal(cleared.body.resolvedConfig.task.doctor, undefined);
    assert.deepEqual(cleared.body.resolvedConfig.task.mustMention, []);
    assert.deepEqual(cleared.body.resolvedConfig.task.forbidden, []);

    const explicit = await request(`/api/projects/${projectId}/resolve-config`, {
      method: 'POST',
      body: JSON.stringify({
        topic: 'explicit task fields',
        presetId: preset.body.id,
        audienceStage: 'comparing',
        entryPoint: 'recommendation',
        city: 'request city',
        doctor: 'request doctor',
        mustInclude: 'request must',
        forbidden: 'request forbidden',
      }),
    });
    assert.equal(explicit.response.status, 201, JSON.stringify(explicit.body));
    assert.equal(explicit.body.resolvedConfig.task.audienceStage, 'comparing');
    assert.equal(explicit.body.resolvedConfig.task.entry, 'recommendation');
    assert.equal(explicit.body.resolvedConfig.task.city, 'request city');
    assert.equal(explicit.body.resolvedConfig.task.doctor, 'request doctor');
    assert.deepEqual(explicit.body.resolvedConfig.task.mustMention, ['request must']);
    assert.deepEqual(explicit.body.resolvedConfig.task.forbidden, ['request forbidden']);
    assert.equal(explicit.body.sourceMap.audience_stage, 'task-request');
    assert.equal(explicit.body.sourceMap.entry_route, 'task-request');
    assert.equal(explicit.body.sourceMap.must_mention, 'task-request');
    assert.equal(explicit.body.sourceMap.forbidden_phrases, 'task-request');
  } finally {
    database.prepare('DELETE FROM project_settings WHERE project_id=?').run(projectId);
    await request(`/api/projects/${projectId}/presets/${preset.body.id}`, { method: 'DELETE' });
  }
});

test('reader scenario fields are normalized, remain optional, and support expert core overrides', async () => {
  const defaults = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({ topic: 'reader scenario defaults' }),
  });
  assert.equal(defaults.response.status, 201, JSON.stringify(defaults.body));
  assert.deepEqual(defaults.body.resolvedConfig.task.preContactKnown, []);
  assert.deepEqual(defaults.body.resolvedConfig.task.readerConstraints, []);
  assert.equal(defaults.body.resolvedConfig.task.readerHistory, undefined);

  const direct = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: 'direct reader scenario',
      preContactKnown: ['  已经了解基础区别  ', '已经了解基础区别', ''],
      readerHistory: [' 搜索过恢复时间 ', '搜索过恢复时间'],
      readerConstraints: [' 两周内需要正常工作 ', '不能接受确定性承诺'],
    }),
  });
  assert.equal(direct.response.status, 201, JSON.stringify(direct.body));
  assert.deepEqual(direct.body.resolvedConfig.task.preContactKnown, ['已经了解基础区别']);
  assert.deepEqual(direct.body.resolvedConfig.task.readerHistory, ['搜索过恢复时间']);
  assert.deepEqual(direct.body.resolvedConfig.task.readerConstraints, ['两周内需要正常工作', '不能接受确定性承诺']);

  const expertOverride = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: 'expert reader scenario',
      overrides: {
        task: {
          preContactKnown: [' 覆盖路径中的已知信息 '],
          readerHistory: [' 看过比较清单 '],
          readerConstraints: [' 只接受可核验信息 '],
        },
      },
    }),
  });
  assert.equal(expertOverride.response.status, 201, JSON.stringify(expertOverride.body));
  assert.deepEqual(expertOverride.body.resolvedConfig.task.preContactKnown, ['覆盖路径中的已知信息']);
  assert.deepEqual(expertOverride.body.resolvedConfig.task.readerHistory, ['看过比较清单']);
  assert.deepEqual(expertOverride.body.resolvedConfig.task.readerConstraints, ['只接受可核验信息']);

  const clearedHistory = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: 'unknown reader history',
      overrides: { task: { readerHistory: ['旧的继承历史'] } },
      readerHistory: null,
    }),
  });
  assert.equal(clearedHistory.response.status, 201, JSON.stringify(clearedHistory.body));
  assert.equal(clearedHistory.body.resolvedConfig.task.readerHistory, undefined);

  const invalid = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: 'invalid reader scenario',
      overrides: { task: { preContactKnown: '项目事实不能冒充读者已知' } },
    }),
  });
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
  assert.match(String(invalid.body.message), /preContactKnown/u);
});

test('legacy advanced request fields map to bottom-level config and generation stores snapshots', async () => {
  const legacy = await request(`/api/projects/${projectId}/resolve-config`, {
    method: 'POST',
    body: JSON.stringify({
      topic: '旧设置模式兼容',
      audienceStage: '比较期',
      entryPoint: '搜索',
      config: {
        knowledgeScope: 'all',
        informationBreadth: 80,
        informationDepth: 75,
        expressionFreedom: 65,
        vigilanceLevel: 85,
        bodyLength: 120,
        commentThreads: 2,
        tone: '理性功课',
        titleStyle: '清单与方法',
        evidenceMode: 'strict',
        temperature: 0.4,
        repairRounds: 1,
        overrides: { content: { hashtagMin: 2, hashtagMax: 2 } },
      },
    }),
  });
  assert.equal(legacy.response.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body.resolvedConfig.content.bodyMinChars, 80);
  assert.equal(legacy.body.resolvedConfig.content.bodyMaxChars, 170);
  assert.equal(legacy.body.resolvedConfig.content.commentThreadMin, 2);
  assert.equal(legacy.body.resolvedConfig.content.hashtagMax, 2);
  assert.equal(legacy.body.resolvedConfig.model.temperature, 0.4);
  assert.equal(legacy.body.resolvedConfig.generation.maxRepairAttempts, 1);
  assert.match(legacy.body.resolvedConfig.expressionWindow.voice, /理性功课/u);

  const generation = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: '预设生成快照',
      goal: '验证保存',
      mode: 'advanced',
      presetId: customPresetId,
      overrides: { body_min_chars: 100, body_max_chars: 180 },
      seed: 42,
    }),
  });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(generation.body.presetId, customPresetId);
  assert.equal(generation.body.styleProfileVersion, 2);
  assert.equal(generation.body.resolvedConfig.content.bodyMinChars, 100);
  assert.ok(Array.isArray(generation.body.impactReport));
  assert.ok(generation.body.parameterImpactReport.parameterTraces.length > 0);
  assert.ok(generation.body.resolutionSnapshot.values);

  const row = app.get(DatabaseService).prepare(
    `SELECT preset_id, style_profile_version, resolution_snapshot_json, config_impact_json
     FROM generation_jobs WHERE id=?`,
  ).get(generation.body.id) as Record<string, unknown>;
  assert.equal(row.preset_id, customPresetId);
  assert.equal(row.style_profile_version, 2);
  assert.equal(JSON.parse(String(row.resolution_snapshot_json)).preset.id, customPresetId);
  assert.ok(JSON.parse(String(row.config_impact_json)).parameterTraces.length > 0);
  assert.equal(
    Number(app.get(DatabaseService).prepare('PRAGMA user_version').get()?.user_version),
    SCHEMA_VERSION,
  );
});

test('a version-2 SQLite database migrates incrementally without a service database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-agent-v2-migration-'));
  const databasePath = join(root, 'legacy.db');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE generation_jobs (
      id TEXT PRIMARY KEY
    );
    PRAGMA user_version = 2;
  `);
  legacy.close();
  const migrated = new DatabaseService(resolveOptions({ dataDir: root, databasePath, logger: false }));
  try {
    assert.equal(Number(migrated.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
    const projectColumns = migrated.prepare('PRAGMA table_info(projects)').all() as unknown as Array<{ name: string }>;
    assert.ok(projectColumns.some((column) => column.name === 'style_profile_version'));
    const jobColumns = migrated.prepare('PRAGMA table_info(generation_jobs)').all() as unknown as Array<{ name: string }>;
    assert.ok(jobColumns.some((column) => column.name === 'resolution_snapshot_json'));
    assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_presets'").get());
    const imageColumns = migrated.prepare('PRAGMA table_info(image_assets)').all() as unknown as Array<{ name: string }>;
    assert.ok(imageColumns.some((column) => column.name === 'asset_kind'));
  } finally {
    migrated.onModuleDestroy();
    await rm(root, { recursive: true, force: true });
  }
});
