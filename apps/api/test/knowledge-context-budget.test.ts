import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import {
  assertKnowledgeContextBudget,
  assertKnowledgeRowsBudget,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_FILES,
} from '../src/knowledge-budget.js';
import { SettingsService } from '../src/settings.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let database: DatabaseService;
let adminId = '';
let workspaceId = '';

const PASSWORD = 'Knowledge-budget-bootstrap-123!';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body: body as Record<string, any> };
}

async function createProject(name: string): Promise<string> {
  const created = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, domain: '边界测试' }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  return String(created.body.id);
}

function seedKnowledge(projectId: string, count: number, bytes = 32): string[] {
  const ids: string[] = [];
  const now = new Date().toISOString();
  const insert = database.prepare(
    `INSERT INTO knowledge_files
       (id, project_id, filename, storage_path, media_type, bytes, sha256, version,
        category, evidence_status, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text/markdown', ?, ?, 1, 'fact', 'observed', '{}', ?, ?, ?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      const suffix = index.toString().padStart(3, '0');
      insert.run(
        id,
        projectId,
        `knowledge-${suffix}.md`,
        `knowledge/${projectId}/${id}.md`,
        bytes,
        index.toString(16).padStart(64, '0'),
        adminId,
        now,
        now,
      );
    }
  });
  return ids;
}

function seedApprovedImages(projectId: string, observations: string[]): void {
  const now = new Date().toISOString();
  const insertAsset = database.prepare(
    `INSERT INTO image_assets
       (id, project_id, filename, storage_path, media_type, bytes, sha256, width, height,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'image/png', 1, ?, 1, 1, ?, ?, ?)`,
  );
  const insertAnalysis = database.prepare(
    `INSERT INTO image_analysis_versions
       (id, image_asset_id, project_id, version, status, source_fingerprint, observation_json,
        created_by, approved_by, created_at, updated_at, approved_at)
     VALUES (?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.transaction(() => {
    observations.forEach((observation, index) => {
      const assetId = randomUUID();
      const suffix = index.toString().padStart(3, '0');
      insertAsset.run(
        assetId,
        projectId,
        `image-${suffix}.png`,
        `images/${projectId}/${assetId}.png`,
        index.toString(16).padStart(64, '0'),
        adminId,
        now,
        now,
      );
      insertAnalysis.run(
        randomUUID(),
        assetId,
        projectId,
        `image-budget-${index}`,
        observation,
        adminId,
        adminId,
        now,
        now,
        now,
      );
    });
  });
}

function count(table: 'generation_jobs' | 'analysis_tasks', projectId: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE project_id=?`).get(projectId) as { value: number };
  return Number(row.value);
}

function quotaUsed(): number {
  const row = database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?')
    .get(workspaceId) as { quota_used: number };
  return Number(row.quota_used);
}

function exceptionBody(action: () => void): Record<string, any> {
  try {
    action();
  } catch (error) {
    const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
    assert.equal(exception.getStatus?.(), 413);
    const body = exception.getResponse?.();
    assert.equal(typeof body, 'object');
    return body as Record<string, any>;
  }
  assert.fail('Expected a payload-too-large exception');
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-knowledge-budget-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'knowledge-budget-integration-key',
    platformApiKey: 'platform-budget-test-key',
    platformBaseUrl: 'https://platform.invalid/v1',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.response.status, 201);
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = String(login.body.csrfToken);
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'Knowledge-budget-updated-456!' }),
  });
  assert.equal(changed.response.status, 201);

  database = app.get(DatabaseService);
  adminId = String((database.prepare("SELECT id FROM users WHERE username='admin'").get() as { id: string }).id);
  workspaceId = String((database.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string }).id);
  app.get(SettingsService).provider(workspaceId, adminId);
  database.prepare(
    "UPDATE workspace_settings SET provider_mode='platform', monthly_quota=100, quota_used=7 WHERE workspace_id=?",
  ).run(workspaceId);

  // Keep accepted generation jobs queued so this boundary suite never calls a model.
  app.get(GenerationService).onModuleDestroy();
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('shared knowledge budget accepts exact limits and rejects either dimension above them', () => {
  assert.doesNotThrow(() => assertKnowledgeContextBudget({
    operation: '测试',
    fileCount: MAX_KNOWLEDGE_CONTEXT_FILES,
    totalBytes: MAX_KNOWLEDGE_CONTEXT_BYTES,
  }));

  const tooMany = exceptionBody(() => assertKnowledgeRowsBudget(
    '测试',
    Array.from({ length: MAX_KNOWLEDGE_CONTEXT_FILES + 1 }, () => ({ bytes: 0 })),
  ));
  assert.equal(tooMany.code, 'KNOWLEDGE_CONTEXT_LIMIT');
  assert.equal(tooMany.usage.fileCount, MAX_KNOWLEDGE_CONTEXT_FILES + 1);

  const tooLarge = exceptionBody(() => assertKnowledgeContextBudget({
    operation: '测试',
    fileCount: 1,
    totalBytes: MAX_KNOWLEDGE_CONTEXT_BYTES + 1,
  }));
  assert.equal(tooLarge.code, 'KNOWLEDGE_CONTEXT_LIMIT');
  assert.equal(tooLarge.usage.totalBytes, MAX_KNOWLEDGE_CONTEXT_BYTES + 1);

  const invalidMetadata = exceptionBody(() => assertKnowledgeRowsBudget('测试', [{}]));
  assert.equal(invalidMetadata.code, 'KNOWLEDGE_CONTEXT_LIMIT');
});

test('generation filters explicit selection before budget and rejects default overflow before charge or insert', async () => {
  const projectId = await createProject('生成知识预算');
  const knowledgeIds = seedKnowledge(projectId, MAX_KNOWLEDGE_CONTEXT_FILES + 1);
  seedApprovedProjectBlueprint(app, projectId);
  const jobsBefore = count('generation_jobs', projectId);
  const quotaBefore = quotaUsed();

  const rejected = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, topic: '默认全量知识应被预算拒绝', seed: 101 }),
  });
  assert.equal(rejected.response.status, 413, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, 'KNOWLEDGE_CONTEXT_LIMIT');
  assert.equal(count('generation_jobs', projectId), jobsBefore, '超限前不得创建生成任务');
  assert.equal(quotaUsed(), quotaBefore, '超限前不得扣平台额度');

  const selected = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: '只使用一份明确选择的知识',
      knowledgeScope: 'selected',
      selectedFileIds: [knowledgeIds[0]],
      seed: 102,
    }),
  });
  assert.equal(selected.response.status, 201, JSON.stringify(selected.body));
  assert.equal(count('generation_jobs', projectId), jobsBefore + 1);
  assert.equal(quotaUsed(), quotaBefore + 1, '放行的正式生成只扣一次额度');
  const stored = database.prepare('SELECT status, config_json FROM generation_jobs WHERE id=?')
    .get(String(selected.body.id)) as { status: string; config_json: string };
  const storedConfig = JSON.parse(stored.config_json) as { knowledge: { selectedFileIds: string[] } };
  assert.equal(stored.status, 'queued');
  assert.deepEqual(storedConfig.knowledge.selectedFileIds, [knowledgeIds[0]]);
});

test('project analysis and evidence catalogue reject 65 latest knowledge files without creating an analysis task', async () => {
  const projectId = await createProject('分析知识预算');
  seedKnowledge(projectId, MAX_KNOWLEDGE_CONTEXT_FILES + 1);
  const tasksBefore = count('analysis_tasks', projectId);
  const quotaBefore = quotaUsed();

  const analyzed = await request(`/api/projects/${projectId}/intelligence/analyze`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(analyzed.response.status, 413, JSON.stringify(analyzed.body));
  assert.equal(analyzed.body.code, 'KNOWLEDGE_CONTEXT_LIMIT');
  assert.equal(count('analysis_tasks', projectId), tasksBefore);
  assert.equal(quotaUsed(), quotaBefore);

  const evidence = await request(`/api/projects/${projectId}/knowledge/evidence-sections`);
  assert.equal(evidence.response.status, 413, JSON.stringify(evidence.body));
  assert.equal(evidence.body.code, 'KNOWLEDGE_CONTEXT_LIMIT');
});

test('project analysis bounds approved image observation count, bytes and historical JSON complexity before task creation', async () => {
  const countProjectId = await createProject('图片观察数量预算');
  seedApprovedImages(
    countProjectId,
    Array.from({ length: 65 }, (_, index) => JSON.stringify({ altText: `image-${index}` })),
  );
  let result = await request(`/api/projects/${countProjectId}/intelligence/analyze`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.code, 'ANALYSIS_IMAGE_CONTEXT_LIMIT');
  assert.equal(count('analysis_tasks', countProjectId), 0);

  const byteProjectId = await createProject('图片观察字节预算');
  seedApprovedImages(byteProjectId, [JSON.stringify({ altText: 'x'.repeat(4 * 1024 * 1024) })]);
  result = await request(`/api/projects/${byteProjectId}/intelligence/analyze`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.code, 'ANALYSIS_IMAGE_CONTEXT_LIMIT');
  assert.equal(count('analysis_tasks', byteProjectId), 0);

  const complexityProjectId = await createProject('图片观察结构预算');
  const complex = Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`key-${index}`, index]));
  seedApprovedImages(complexityProjectId, [JSON.stringify(complex)]);
  result = await request(`/api/projects/${complexityProjectId}/intelligence/analyze`, { method: 'POST', body: '{}' });
  assert.equal(result.response.status, 413, JSON.stringify(result.body));
  assert.equal(result.body.code, 'ANALYSIS_IMAGE_CONTEXT_LIMIT');
  assert.equal(count('analysis_tasks', complexityProjectId), 0);
});
