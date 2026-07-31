import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { GenerationService } from '../src/generation.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';

const SECRET_MARKER = 'OUTSIDE_DATA_DIRECTORY_SECRET';

let app: NestExpressApplication;
let baseUrl = '';
let cookie = '';
let csrf = '';
let dataDir = '';
let outsideDir = '';
let outsideFile = '';
let projectId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* Preserve binary/text responses. */ }
  return { response, body, text };
}

function isBadRequestWithoutSecret(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'getStatus' in error
    ? (error as { getStatus(): number }).getStatus()
    : undefined;
  return status === 400 && !String(error).includes(SECRET_MARKER);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-storage-security-data-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'content-agent-storage-security-outside-'));
  outsideFile = join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, SECRET_MARKER);
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'storage-security-test-encryption-key',
    logger: false,
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }),
  });
  assert.equal(changed.response.status, 201);
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Storage boundary project' }),
  });
  assert.equal(project.response.status, 201, project.text);
  projectId = String(project.body.id);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

test('project storage paths reject symlink escapes without leaking, deleting, or soft-deleting external data', async () => {
  const uploaded = await request(`/api/projects/${projectId}/knowledge`, {
    method: 'POST',
    body: JSON.stringify({
      filename: 'malicious.md',
      content: '# Safe original',
      category: 'fact',
      evidenceStatus: 'observed',
    }),
  });
  assert.equal(uploaded.response.status, 201, uploaded.text);

  const database = app.get(DatabaseService);
  const knowledgeRow = database.prepare(
    'SELECT storage_path FROM knowledge_files WHERE id=?',
  ).get(uploaded.body.id) as { storage_path: string };
  const knowledgePath = resolve(dataDir, knowledgeRow.storage_path);
  await unlink(knowledgePath);
  await symlink(outsideFile, knowledgePath);

  const fetched = await request(`/api/knowledge/${uploaded.body.id}`);
  assert.equal(fetched.response.status, 400, fetched.text);
  assert.ok(!fetched.text.includes(SECRET_MARKER));

  const generation = app.get(GenerationService) as unknown as {
    loadKnowledge(projectId: string): Promise<unknown>;
  };
  await assert.rejects(generation.loadKnowledge(projectId), isBadRequestWithoutSecret);

  const project = database.prepare(
    'SELECT * FROM projects WHERE id=? AND deleted_at IS NULL',
  ).get(projectId) as Record<string, unknown>;
  const intelligence = app.get(IntelligenceService) as unknown as {
    projectAnalysisSource(project: Record<string, unknown>): Promise<unknown>;
  };
  await assert.rejects(intelligence.projectAnalysisSource(project), isBadRequestWithoutSecret);

  const evidence = await request(`/api/projects/${projectId}/knowledge/evidence-sections`);
  assert.equal(evidence.response.status, 200, evidence.text);
  assert.deepEqual(evidence.body.documents, []);
  assert.equal(evidence.body.warnings.length, 1);
  assert.match(evidence.body.warnings[0], /malicious.md/u);
  assert.ok(!evidence.text.includes(SECRET_MARKER));

  const removed = await request(`/api/knowledge/${uploaded.body.id}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 400, removed.text);
  assert.ok(!removed.text.includes(SECRET_MARKER));
  const retained = database.prepare(
    'SELECT deleted_at FROM knowledge_files WHERE id=?',
  ).get(uploaded.body.id) as { deleted_at: string | null };
  assert.equal(retained.deleted_at, null);
  assert.equal(await readFile(outsideFile, 'utf8'), SECRET_MARKER);

  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } },
  }).png().toBuffer();
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'source.png');
  const uploadedImage = await request(`/api/projects/${projectId}/image-assets`, {
    method: 'POST',
    body: form,
  });
  assert.equal(uploadedImage.response.status, 201, uploadedImage.text);
  const imageRow = database.prepare(
    'SELECT storage_path FROM image_assets WHERE id=?',
  ).get(uploadedImage.body.id) as { storage_path: string };
  const imagePath = resolve(dataDir, imageRow.storage_path);
  await unlink(imagePath);
  await symlink(outsideFile, imagePath);

  const imageContent = await request(
    `/api/projects/${projectId}/image-assets/${uploadedImage.body.id}/content`,
  );
  assert.equal(imageContent.response.status, 400, imageContent.text);
  assert.ok(!imageContent.text.includes(SECRET_MARKER));

  const analyze = await request(
    `/api/projects/${projectId}/image-assets/${uploadedImage.body.id}/analyze`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(analyze.response.status, 400, analyze.text);
  assert.ok(!analyze.text.includes(SECRET_MARKER));

  await assert.rejects(
    app.get(IntelligenceService).hydratePlanningContext(projectId, {
      opportunities: [],
      imageAnalyses: [{ assetId: uploadedImage.body.id }],
    } as any),
    isBadRequestWithoutSecret,
  );
  assert.equal(await readFile(outsideFile, 'utf8'), SECRET_MARKER);
});
