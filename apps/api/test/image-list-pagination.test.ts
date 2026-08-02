import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let projectId = '';
let userId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(baseUrl + path, { ...options, headers });
  const bodyText = await response.text();
  let body: any = bodyText;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* Keep non-JSON bodies as text. */ }
  return { response, body };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-image-pagination-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Image-pagination-bootstrap-123!',
    masterEncryptionKey: 'image-pagination-test-encryption-key',
    logger: false,
    platformApiKey: '',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Image-pagination-bootstrap-123!' }),
  });
  assert.equal(login.response.status, 201, JSON.stringify(login.body));
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = String(login.body.csrfToken);
  userId = String(login.body.user.id);
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: 'Image-pagination-bootstrap-123!',
      newPassword: 'Image-pagination-updated-456!',
    }),
  });
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '图片分页测试项目' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = String(project.body.id);

  const database = app.get(DatabaseService);
  const insertAsset = database.prepare(
    "INSERT INTO image_assets " +
    "(id, project_id, filename, storage_path, media_type, bytes, sha256, width, height, " +
    "created_by, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, 'image/png', 16, ?, 4, 4, ?, ?, ?)",
  );
  for (let index = 1; index <= 3; index += 1) {
    const id = 'asset-' + String(index);
    const createdAt = new Date(Date.UTC(2026, 0, index)).toISOString();
    insertAsset.run(
      id, projectId, 'image-' + String(index) + '.png',
      'images/' + projectId + '/' + id + '.png',
      String(index).padStart(64, '0'), userId, createdAt, createdAt,
    );
  }
  const insertAnalysis = database.prepare(
    "INSERT INTO image_analysis_versions " +
    "(id, image_asset_id, project_id, version, status, source_fingerprint, observation_json, " +
    "created_by, created_at, updated_at) " +
    "VALUES (?, 'asset-2', ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const v1 = '2026-01-04T00:00:00.000Z';
  const v2 = '2026-01-05T00:00:00.000Z';
  insertAnalysis.run(
    'analysis-v1', projectId, 1, 'approved', 'fingerprint-v1',
    JSON.stringify({ observedFacts: ['旧观察'], quality: { clarity: 0.5 } }), userId, v1, v1,
  );
  insertAnalysis.run(
    'analysis-v2', projectId, 2, 'draft', 'fingerprint-v2',
    JSON.stringify({ observedFacts: ['最新观察'], visibleText: ['标题'], quality: { clarity: 0.8 } }), userId, v2, v2,
  );
});

after(async () => {
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('image list is explicitly paginated and embeds the latest analysis in one response', async () => {
  const result = await request('/api/projects/' + projectId + '/image-assets?limit=1&offset=1');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.total, 3);
  assert.equal(result.body.limit, 1);
  assert.equal(result.body.offset, 1);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].id, 'asset-2');
  assert.equal(result.body.items[0].latestAnalysisId, 'analysis-v2');
  assert.equal(result.body.items[0].analysisStatus, 'draft');
  assert.equal(result.body.items[0].latestAnalysis.id, 'analysis-v2');
  assert.equal(result.body.items[0].latestAnalysis.observationStatus, 'unapproved');
  assert.deepEqual(result.body.items[0].latestAnalysis.observedFacts, ['最新观察']);
});

test('image analysis history has pagination and detail does not hide a full history read', async () => {
  const history = await request(
    '/api/projects/' + projectId + '/image-assets/asset-2/analyses?limit=1&offset=1',
  );
  assert.equal(history.response.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.total, 2);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].id, 'analysis-v1');
  assert.equal(history.body.items[0].observationStatus, 'approved');

  const detail = await request('/api/projects/' + projectId + '/image-assets/asset-2');
  assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.latestAnalysis.id, 'analysis-v2');
  assert.equal(Object.hasOwn(detail.body, 'analyses'), false);
});

test('approved observation filter pages eligible assets and returns the approved version', async () => {
  const result = await request(
    '/api/projects/' + projectId + '/image-assets?limit=1&offset=0&observationStatus=approved',
  );
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.total, 1);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].id, 'asset-2');
  assert.equal(result.body.items[0].latestAnalysisId, 'analysis-v1');
  assert.equal(result.body.items[0].analysisStatus, 'approved');
  assert.equal(result.body.items[0].latestAnalysis.observationStatus, 'approved');
  assert.deepEqual(result.body.items[0].latestAnalysis.observedFacts, ['旧观察']);
});

test('image list rejects unsupported observation status filters', async () => {
  const result = await request(
    '/api/projects/' + projectId + '/image-assets?observationStatus=draft',
  );
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
});

test('image pagination rejects malformed or excessive values instead of coercing them', async () => {
  const queries = [
    'limit=0', 'limit=101', 'limit=1.5', 'limit=-1',
    'offset=-1', 'offset=1.5', 'offset=1000001',
  ];
  for (const query of queries) {
    const result = await request('/api/projects/' + projectId + '/image-assets?' + query);
    assert.equal(result.response.status, 400, query + ': ' + JSON.stringify(result.body));
  }
});
