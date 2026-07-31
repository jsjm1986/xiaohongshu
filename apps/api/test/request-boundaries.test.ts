import assert from 'node:assert/strict';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) as unknown : null; } catch { /* Keep non-JSON responses as text. */ }
  return { response, body };
}

async function entries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function png(color: string): Promise<Buffer> {
  return sharp({
    create: { width: 24, height: 24, channels: 3, background: color },
  }).png().toBuffer();
}

async function uploadPng(source: Buffer, filename: string) {
  const form = new FormData();
  form.set('file', new Blob([source], { type: 'image/png' }), filename);
  return request(`/api/projects/${projectId}/image-assets`, { method: 'POST', body: form });
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-request-boundaries-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Boundary-bootstrap-123!',
    masterEncryptionKey: 'request-boundaries-test-encryption-key',
    logger: false,
    platformApiKey: '',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Boundary-bootstrap-123!' }),
  });
  assert.equal(login.response.status, 201, JSON.stringify(login.body));
  const loginBody = login.body as { csrfToken: string };
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = loginBody.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: 'Boundary-bootstrap-123!',
      newPassword: 'Boundary-updated-456!',
    }),
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.body));
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '请求边界测试项目' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = String((project.body as { id: string }).id);
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('optional intelligence request bodies reject arrays and excessive nesting', async () => {
  const arrayBody = await request(`/api/projects/${projectId}/intelligence/analyze`, {
    method: 'POST',
    body: JSON.stringify([]),
  });
  assert.equal(arrayBody.response.status, 400, JSON.stringify(arrayBody.body));
  assert.match(String((arrayBody.body as { message?: unknown }).message), /JSON 对象/u);

  const deepBody = await request(`/api/projects/${projectId}/image-assets/missing/analyze`, {
    method: 'POST',
    body: JSON.stringify(nestedObject(34)),
  });
  assert.equal(deepBody.response.status, 400, JSON.stringify(deepBody.body));
  assert.match(String((deepBody.body as { message?: unknown }).message), /嵌套层级过深/u);
});

test('both knowledge upload routes require object metadata and bound parsed multipart JSON', async () => {
  const flat = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({ projectId, filename: 'flat.md', content: '# flat', metadata: [] }),
  });
  assert.equal(flat.response.status, 400, JSON.stringify(flat.body));
  assert.match(String((flat.body as { message?: unknown }).message), /metadata 必须是 JSON 对象/u);

  const arrayMetadata = new FormData();
  arrayMetadata.set('file', new Blob(['# nested'], { type: 'text/markdown' }), 'nested.md');
  arrayMetadata.set('metadata', '[]');
  const nested = await request(`/api/projects/${projectId}/knowledge`, { method: 'POST', body: arrayMetadata });
  assert.equal(nested.response.status, 400, JSON.stringify(nested.body));
  assert.match(String((nested.body as { message?: unknown }).message), /metadata 必须是 JSON 对象/u);

  const deepMetadata = new FormData();
  deepMetadata.set('file', new Blob(['# deep'], { type: 'text/markdown' }), 'deep.md');
  deepMetadata.set('metadata', JSON.stringify(nestedObject(34)));
  const deep = await request(`/api/projects/${projectId}/knowledge`, { method: 'POST', body: deepMetadata });
  assert.equal(deep.response.status, 400, JSON.stringify(deep.body));
  assert.match(String((deep.body as { message?: unknown }).message), /嵌套层级过深/u);
});

test('both knowledge recategorize routes reject non-object request bodies', async () => {
  const uploaded = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({ filename: 'recategorize.md', content: '# recategorize' }),
  });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
  const fileId = String((uploaded.body as { id: string }).id);

  for (const path of [
    `/api/knowledge/${fileId}`,
    `/api/projects/${projectId}/knowledge/${fileId}`,
  ]) {
    const response = await request(path, { method: 'PATCH', body: JSON.stringify([]) });
    assert.equal(response.response.status, 400, `${path}: ${JSON.stringify(response.body)}`);
    assert.match(String((response.body as { message?: unknown }).message), /JSON 对象/u);
  }

  const removed = await request(`/api/projects/${projectId}/knowledge/${fileId}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
});

test('image upload removes temporary and final files when the database insert fails', async () => {
  const database = app.get(DatabaseService);
  const projectDir = join(database.imageDir, projectId);
  const beforeFiles = await entries(projectDir);
  database.prepare(
    `CREATE TRIGGER request_boundaries_reject_image_insert
       BEFORE INSERT ON image_assets
       BEGIN SELECT RAISE(ABORT, 'forced image insert failure'); END`,
  ).run();

  try {
    const uploaded = await uploadPng(await png('#225577'), 'rollback.png');
    assert.equal(uploaded.response.status, 500, JSON.stringify(uploaded.body));
  } finally {
    database.prepare('DROP TRIGGER request_boundaries_reject_image_insert').run();
  }

  assert.deepEqual(await entries(projectDir), beforeFiles);
  const rows = database.prepare('SELECT COUNT(*) AS count FROM image_assets WHERE project_id=?').get(projectId) as { count: number };
  assert.equal(Number(rows.count), 0);
});

test('image create and restore roll back when their audit insert fails', async () => {
  const database = app.get(DatabaseService);
  const projectDir = join(database.imageDir, projectId);
  const beforeFiles = await entries(projectDir);
  database.prepare(
    `CREATE TRIGGER request_boundaries_reject_image_create_audit
       BEFORE INSERT ON audit_logs WHEN NEW.action='image-asset.create'
       BEGIN SELECT RAISE(ABORT, 'forced image create audit failure'); END`,
  ).run();

  try {
    const failed = await uploadPng(await png('#713842'), 'audit-create.png');
    assert.equal(failed.response.status, 500, JSON.stringify(failed.body));
  } finally {
    database.prepare('DROP TRIGGER request_boundaries_reject_image_create_audit').run();
  }
  assert.deepEqual(await entries(projectDir), beforeFiles);
  const failedRows = database.prepare(
    "SELECT COUNT(*) AS count FROM image_assets WHERE filename='audit-create.png'",
  ).get() as { count: number };
  assert.equal(Number(failedRows.count), 0);

  const source = await png('#184e62');
  const created = await uploadPng(source, 'audit-restore.png');
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const assetId = String((created.body as { id: string }).id);
  const removed = await request(`/api/projects/${projectId}/image-assets/${assetId}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  const deletedBefore = database.prepare('SELECT deleted_at FROM image_assets WHERE id=?').get(assetId) as { deleted_at: string | null };
  assert.ok(deletedBefore.deleted_at);

  database.prepare(
    `CREATE TRIGGER request_boundaries_reject_image_restore_audit
       BEFORE INSERT ON audit_logs WHEN NEW.action='image-asset.restore'
       BEGIN SELECT RAISE(ABORT, 'forced image restore audit failure'); END`,
  ).run();
  try {
    const restored = await uploadPng(source, 'audit-restore-again.png');
    assert.equal(restored.response.status, 500, JSON.stringify(restored.body));
  } finally {
    database.prepare('DROP TRIGGER request_boundaries_reject_image_restore_audit').run();
  }
  const deletedAfter = database.prepare('SELECT deleted_at FROM image_assets WHERE id=?').get(assetId) as { deleted_at: string | null };
  assert.equal(deletedAfter.deleted_at, deletedBefore.deleted_at);
});

test('knowledge upload removes temporary and final files when the database transaction fails', async () => {
  const database = app.get(DatabaseService);
  const projectDir = join(database.knowledgeDir, projectId);
  const beforeFiles = await entries(projectDir);
  database.prepare(
    `CREATE TRIGGER request_boundaries_reject_knowledge_insert
       BEFORE INSERT ON knowledge_files
       BEGIN SELECT RAISE(ABORT, 'forced knowledge insert failure'); END`,
  ).run();

  try {
    const uploaded = await request(`/api/projects/${projectId}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({ filename: 'rollback.md', content: '# rollback' }),
    });
    assert.equal(uploaded.response.status, 500, JSON.stringify(uploaded.body));
  } finally {
    database.prepare('DROP TRIGGER request_boundaries_reject_knowledge_insert').run();
  }

  assert.deepEqual(await entries(projectDir), beforeFiles);
  const rows = database
    .prepare("SELECT COUNT(*) AS count FROM knowledge_files WHERE project_id=? AND filename='rollback.md'")
    .get(projectId) as { count: number };
  assert.equal(Number(rows.count), 0);
});

test('formula drafts reject invalid shapes and bounded definitions', async () => {
  const listed = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  const active = (listed.body as Array<{ id: string; formulas: unknown[] }>).find((item) => item.formulas.length > 0);
  assert.ok(active);

  const invalidBodies: Array<Record<string, unknown>> = [
    { projectId, parentId: active.id, formulas: {} },
    { projectId, parentId: active.id, config: [] },
    { projectId, parentId: active.id, parentIdInvalid: true, version: 1 },
    { projectId, parentId: active.id, name: [] },
    { projectId, parentId: active.id, description: {} },
    { projectId, parentId: active.id, formulas: Array.from({ length: 201 }, () => active.formulas[0]) },
  ];
  for (const body of invalidBodies) {
    const result = await request('/api/formulas', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
  }

  const invalidParent = await request('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({ projectId, parentId: 1 }),
  });
  assert.equal(invalidParent.response.status, 400, JSON.stringify(invalidParent.body));

  const oversized = await request('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({ projectId, parentId: active.id, config: { padding: 'x'.repeat(1_048_576) } }),
  });
  assert.equal(oversized.response.status, 413, JSON.stringify(oversized.body));
});

test('research JSON fields reject wrong roots and oversized persisted values', async () => {
  const cases: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: 'claims', body: { title: 'invalid scope', statement: 'scope must be an array', claimType: 'hypothesis', scope: {} } },
    { path: 'claims', body: { title: 'invalid metadata', statement: 'metadata must be an object', claimType: 'hypothesis', metadata: [] } },
    { path: 'evidence-sources', body: { kind: 'internal_observation', citation: 'invalid metadata', metadata: [] } },
    { path: 'datasets', body: { label: 'invalid schema', kind: 'external', sha256: 'a'.repeat(64), schema: [] } },
    { path: 'experiments', body: { title: 'invalid design', hypothesis: 'design must be an object', design: [], metrics: [], analysisPlan: {} } },
    { path: 'experiments', body: { title: 'invalid metrics', hypothesis: 'metrics must be an array', design: {}, metrics: {}, analysisPlan: {} } },
    { path: 'experiments', body: { title: 'invalid analysis plan', hypothesis: 'analysisPlan must be an object', design: {}, metrics: [], analysisPlan: [] } },
    { path: 'calibrations', body: { targetType: 'parameter', targetKey: 'comment_expansion', current: [], proposed: {}, rationale: 'invalid current', evidence: {}, impact: {} } },
    { path: 'calibrations', body: { targetType: 'parameter', targetKey: 'comment_expansion', current: {}, proposed: [], rationale: 'invalid proposed', evidence: {}, impact: {} } },
    { path: 'calibrations', body: { targetType: 'parameter', targetKey: 'comment_expansion', current: {}, proposed: {}, rationale: 'invalid evidence', evidence: [], impact: {} } },
    { path: 'calibrations', body: { targetType: 'parameter', targetKey: 'comment_expansion', current: {}, proposed: {}, rationale: 'invalid impact', evidence: {}, impact: [] } },
  ];
  for (const item of cases) {
    const result = await request(`/api/projects/${projectId}/research/${item.path}`, {
      method: 'POST',
      body: JSON.stringify(item.body),
    });
    assert.equal(result.response.status, 400, `${item.path}: ${JSON.stringify(result.body)}`);
  }

  const oversized = await request(`/api/projects/${projectId}/research/claims`, {
    method: 'POST',
    body: JSON.stringify({
      title: 'oversized metadata',
      statement: 'metadata must stay within its persisted JSON budget',
      claimType: 'hypothesis',
      metadata: { padding: 'x'.repeat(262_144) },
    }),
  });
  assert.equal(oversized.response.status, 413, JSON.stringify(oversized.body));

  const experiment = await request(`/api/projects/${projectId}/research/experiments`, {
    method: 'POST',
    body: JSON.stringify({
      experimentKey: 'invalid-result-shape',
      title: 'result shape boundary',
      hypothesis: 'result must be an object',
      design: {},
      metrics: [],
      analysisPlan: {},
    }),
  });
  assert.equal(experiment.response.status, 201, JSON.stringify(experiment.body));
  const experimentId = String((experiment.body as { id: string }).id);
  for (const status of ['preregistered', 'running']) {
    const transitioned = await request(`/api/projects/${projectId}/research/experiments/${experimentId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    assert.equal(transitioned.response.status, 201, JSON.stringify(transitioned.body));
  }
  const invalidResult = await request(`/api/projects/${projectId}/research/experiments/${experimentId}/results`, {
    method: 'POST',
    body: JSON.stringify({ result: [] }),
  });
  assert.equal(invalidResult.response.status, 400, JSON.stringify(invalidResult.body));
});

test('release bindings reject invalid roots, duplicates and excessive IDs', async () => {
  const bodies: Array<Record<string, unknown>> = [
    { version: '0.0.1-array-bindings', bindings: [] },
    { version: '0.0.1-object-ids', bindings: { datasetSnapshotIds: {} } },
    { version: '0.0.1-duplicate', bindings: { datasetSnapshotIds: ['same', 'same'] } },
    {
      version: '0.0.1-excessive',
      bindings: { datasetSnapshotIds: Array.from({ length: 101 }, (_, index) => `dataset-${index}`) },
    },
  ];
  for (const body of bodies) {
    const result = await request(`/api/projects/${projectId}/research/releases`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
  }
});
