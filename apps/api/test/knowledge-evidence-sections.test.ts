import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  evidenceIdForSection,
  indexKnowledgeSource,
  selectKnowledgeContext,
  type KnowledgeDocument,
} from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';
let emptyProjectId = '';

const PRICE_CONTENT = [
  '# 价格口径',
  '',
  '单次价格为 6800 元，以当期确认为准。',
  '',
  '## 恢复期',
  '',
  '恢复期约 7 天，具体因人而异。',
].join('\n');
const NOTES_CONTENT = '面诊前请停用抗凝药物一周。';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.arrayBuffer();
  return { response, body: body as any };
}

async function importKnowledge(input: {
  project: string;
  filename: string;
  content: string;
  category: string;
  evidenceStatus: string;
}) {
  const { project, ...body } = input;
  const uploaded = await request('/api/knowledge', { method: 'POST', body: JSON.stringify({ projectId: project, ...body }) });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
  return uploaded.body;
}

/** Recompute what the endpoint must disclose, straight from agent-core. */
function expectedSections(document: KnowledgeDocument) {
  const selection = selectKnowledgeContext({
    documents: [document],
    query: '',
    budget: {
      maxInputTokens: 100_000_000,
      systemPromptTokens: 0,
      formulaPromptTokens: 0,
      outputReserveTokens: 0,
      safetyMarginTokens: 0,
    },
  });
  return selection.sections.map((section) => ({
    evidenceId: evidenceIdForSection(section),
    sectionId: section.id,
    heading: section.heading ?? '',
    excerpt: section.content.replace(/\s+/gu, ' ').trim().slice(0, 120),
    charLength: section.content.length,
  }));
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-evidence-sections-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }) });
  assert.equal(changed.response.status, 201);

  const project = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '证据分节项目', domain: '去眼袋' }) });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;
  const empty = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: '空知识库项目', domain: '去眼袋' }) });
  assert.equal(empty.response.status, 201, JSON.stringify(empty.body));
  emptyProjectId = empty.body.id;
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('evidence sections match agent-core evidenceIdForSection and pass kind/evidenceStatus through', async () => {
  const price = await importKnowledge({ project: projectId, filename: 'price.md', content: PRICE_CONTENT, category: 'fact', evidenceStatus: 'observed' });
  const notes = await importKnowledge({ project: projectId, filename: 'notes.txt', content: NOTES_CONTENT, category: 'fact', evidenceStatus: 'observed' });

  const listed = await request(`/api/projects/${projectId}/knowledge/evidence-sections`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.warnings, []);
  assert.deepEqual(listed.body.documents.map((document: any) => document.path), ['notes.txt', 'price.md']);

  const expectedByPath = new Map([
    ['price.md', expectedSections(indexKnowledgeSource({
      id: price.id, projectId, path: 'price.md', content: PRICE_CONTENT, version: '1', importedAt: price.createdAt,
      metadata: { title: 'price.md', kind: 'fact', evidenceStatus: 'observed', keywords: [], scope: [], caveats: [] },
    }))],
    ['notes.txt', expectedSections(indexKnowledgeSource({
      id: notes.id, projectId, path: 'notes.txt', content: NOTES_CONTENT, version: '1', importedAt: notes.createdAt,
      metadata: { title: 'notes.txt', kind: 'fact', evidenceStatus: 'observed', keywords: [], scope: [], caveats: [] },
    }))],
  ]);
  for (const document of listed.body.documents) {
    assert.equal(document.kind, 'fact');
    assert.equal(document.evidenceStatus, 'observed');
    assert.ok(document.title, 'title passthrough');
    assert.deepEqual(
      document.sections.map((section: any) => ({
        evidenceId: section.evidenceId,
        sectionId: section.sectionId,
        heading: section.heading,
        excerpt: section.excerpt,
        charLength: section.charLength,
      })),
      expectedByPath.get(document.path),
      `sections for ${document.path}`,
    );
    for (const section of document.sections) {
      assert.match(section.evidenceId, /^evidence_section_[0-9a-f]{20}$/u);
      assert.equal(section.kind, 'fact');
      assert.equal(section.evidenceStatus, 'observed');
      assert.deepEqual(section.caveats, []);
      assert.ok(section.excerpt.length <= 120);
    }
  }
  // The .txt file splits into a single whole-document section without heading.
  const txtDocument = listed.body.documents.find((document: any) => document.path === 'notes.txt');
  assert.equal(txtDocument.sections.length, 1);
  assert.equal(txtDocument.sections[0].heading, '');
});

test('reference-corpus is excluded and only the latest version of a file is indexed', async () => {
  await importKnowledge({ project: projectId, filename: 'corpus.md', content: '# 对标样本\n\n样本话术，不是证据。', category: 'reference-corpus', evidenceStatus: 'unknown' });
  const updated = await importKnowledge({ project: projectId, filename: 'price.md', content: '# 价格口径\n\n新版价格 7200 元，以当期确认为准。', category: 'fact', evidenceStatus: 'observed' });
  assert.equal(updated.version, 2);

  const listed = await request(`/api/projects/${projectId}/knowledge/evidence-sections`);
  assert.equal(listed.response.status, 200);
  const paths = listed.body.documents.map((document: any) => document.path);
  assert.deepEqual(paths, ['notes.txt', 'price.md'], '风格语料不是证据，不得出现在分节列表');
  const priceDocument = listed.body.documents.find((document: any) => document.path === 'price.md');
  assert.equal(priceDocument.id, updated.id, '索引的是最新版本的行');
  assert.equal(priceDocument.sections.length, 1);
  assert.match(priceDocument.sections[0].excerpt, /7200 元/u);
  assert.ok(!priceDocument.sections[0].excerpt.includes('6800'));
});

test('empty project returns an empty document list', async () => {
  const listed = await request(`/api/projects/${emptyProjectId}/knowledge/evidence-sections`);
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body, { documents: [], warnings: [] });
});

test('files above 2 MiB are skipped with a warning instead of failing the endpoint', async () => {
  const database = app.get(DatabaseService);
  const admin = database.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
  const bigId = randomUUID();
  const storagePath = `knowledge/${emptyProjectId}/${bigId}.md`;
  await mkdir(join(database.knowledgeDir, emptyProjectId), { recursive: true });
  await writeFile(join(database.options.dataDir, storagePath), `# 大文件\n\n${'长'.repeat(2 * 1024 * 1024)}`);
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO knowledge_files
         (id, project_id, filename, storage_path, media_type, bytes, sha256, version,
          category, evidence_status, metadata_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(bigId, emptyProjectId, 'big.md', storagePath, 'text/markdown', 3 * 1024 * 1024, 'unused-sha', 1, 'fact', 'observed', '{}', admin.id, now, now);

  const listed = await request(`/api/projects/${emptyProjectId}/knowledge/evidence-sections`);
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.documents, []);
  assert.equal(listed.body.warnings.length, 1);
  assert.match(listed.body.warnings[0], /big\.md/u);
  assert.match(listed.body.warnings[0], /跳过/u);
});

test('unauthenticated requests are rejected', async () => {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/knowledge/evidence-sections`);
  assert.equal(response.status, 401);
});
