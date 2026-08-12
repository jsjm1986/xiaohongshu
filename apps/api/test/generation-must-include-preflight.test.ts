import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

let app: NestExpressApplication;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let projectId = '';
let workspaceId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { response, body };
}

function count(sql: string, ...params: unknown[]): number {
  const row = app.get(DatabaseService).prepare(sql).get(...params) as { total: number | bigint };
  return Number(row.total);
}

function quotaUsed(): number {
  const row = app.get(DatabaseService)
    .prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?')
    .get(workspaceId) as { quota_used: number };
  return Number(row.quota_used);
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'must-include-preflight-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'must-include-preflight-master-key',
    logger: false,
    platformApiKey: 'test-platform-key',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
    modelRetryAttempts: 1,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
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

  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '强制声明预检项目', domain: '清单工具' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = String(project.body.id);
  workspaceId = String((app.get(DatabaseService)
    .prepare('SELECT workspace_id FROM projects WHERE id=?').get(projectId) as { workspace_id: string }).workspace_id);
  const settings = await request('/api/settings');
  assert.equal(settings.response.status, 200, JSON.stringify(settings.body));
  const knowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      filename: 'confirmed-facts.md',
      category: 'facts',
      evidenceStatus: 'observed',
      content: '# 已确认事实\n\n核心功能免费。\n\n建立清单通常需要20分钟。',
      metadata: { kind: 'fact' },
    }),
  });
  assert.equal(knowledge.response.status, 201, JSON.stringify(knowledge.body));
  seedApprovedProjectBlueprint(app, projectId);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('无依据的数字和复合承诺在扣额度、建任务前被拒绝', async () => {
  const jobsBefore = count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId);
  const quotaBefore = quotaUsed();
  const result = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: '轻量清单怎么开始',
      mustInclude: ['2分钟建立清单', '核心功能免费且无广告'],
    }),
  });
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'MUST_INCLUDE_EVIDENCE_UNSUPPORTED');
  assert.deepEqual(result.body.unsupportedClaims, ['2分钟建立清单', '核心功能免费且无广告']);
  assert.equal(count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId), jobsBefore);
  assert.equal(quotaUsed(), quotaBefore);
});

test('普通写作要求不需要知识证据，仍可正常入队', async () => {
  const jobsBefore = count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId);
  const quotaBefore = quotaUsed();
  const result = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: '轻量清单怎么开始',
      mustInclude: ['先判断问题类型'],
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId), jobsBefore + 1);
  assert.equal(quotaUsed(), quotaBefore + 1);
});

test('有精确事实依据的敏感必含声明可以正常入队', async () => {
  const jobsBefore = count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId);
  const quotaBefore = quotaUsed();
  const result = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topic: '核心功能怎么使用',
      mustInclude: ['核心功能免费'],
    }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal(count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId), jobsBefore + 1);
  assert.equal(quotaUsed(), quotaBefore + 1);
});

test('批量中任一强制声明无依据时不留下批次、任务或额度扣款', async () => {
  const batchesBefore = count('SELECT COUNT(*) AS total FROM generation_batches WHERE project_id=?', projectId);
  const jobsBefore = count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId);
  const quotaBefore = quotaUsed();
  const result = await request('/api/generation-batches', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      name: '原子预检批次',
      jobs: [
        { mode: 'simple', topic: '普通要求', mustInclude: ['先判断问题类型'] },
        { mode: 'simple', topic: '无依据要求', mustInclude: ['2分钟建立清单'] },
      ],
    }),
  });
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'MUST_INCLUDE_EVIDENCE_UNSUPPORTED');
  assert.equal(count('SELECT COUNT(*) AS total FROM generation_batches WHERE project_id=?', projectId), batchesBefore);
  assert.equal(count('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?', projectId), jobsBefore);
  assert.equal(quotaUsed(), quotaBefore);
});
