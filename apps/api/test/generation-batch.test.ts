import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { resolveOptions } from '../src/config.js';
import { computeBatchStatus } from '../src/generation.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-mig-'));
  const db = new DatabaseService(resolveOptions({ dataDir: dir }));
  return { db, cleanup: () => { db.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); } };
}

test('migration v12 creates generation_batches and jobs.batch_id', () => {
  const { db, cleanup } = freshDb();
  try {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version >= 12, true);
    const batchCols = db.prepare("PRAGMA table_info(generation_batches)").all() as Array<{ name: string }>;
    const names = batchCols.map((c) => c.name);
    for (const col of ['id', 'project_id', 'name', 'status', 'total_jobs', 'config_json', 'created_by', 'created_at', 'updated_at', 'completed_at']) {
      assert.equal(names.includes(col), true, `generation_batches 缺列 ${col}`);
    }
    const jobCols = db.prepare("PRAGMA table_info(generation_jobs)").all() as Array<{ name: string }>;
    assert.equal(jobCols.map((c) => c.name).includes('batch_id'), true, 'generation_jobs 缺 batch_id');
  } finally {
    cleanup();
  }
});

test('computeBatchStatus aggregates job statuses', () => {
  assert.equal(computeBatchStatus(['queued', 'queued']), 'queued');
  assert.equal(computeBatchStatus(['running', 'queued']), 'running');
  assert.equal(computeBatchStatus(['completed', 'running']), 'running');
  assert.equal(computeBatchStatus(['completed', 'completed']), 'completed');
  assert.equal(computeBatchStatus(['failed', 'failed']), 'failed');
  assert.equal(computeBatchStatus(['completed', 'failed']), 'partial');
  assert.equal(computeBatchStatus([]), 'completed');
});

// ── 冒烟：真实 HTTP 全链路（登录 → 项目 → 审批链 → 2 选题 × 2 预设 → 批次落库 → 状态聚合） ──

const teardown: Array<() => Promise<void>> = [];
after(async () => {
  while (teardown.length) await teardown.pop()?.();
});

async function startApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'batch-e2e-'));
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'batch-e2e-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  teardown.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
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
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
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
  return { app, request };
}

/** 走完前端批量提交前置的审批链，返回两个可生成的已审批选题。 */
async function seedApprovedOpportunities(
  app: NestExpressApplication,
  request: (path: string, options?: RequestInit) => Promise<{ response: Response; body: any }>,
  projectId: string,
): Promise<string[]> {
  seedApprovedProjectBlueprint(app, projectId);
  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title: '应该先核对什么？', answer: '先核对适用条件。', priority: 80, enabled: true }),
  });
  assert.equal(gap.response.status, 201, JSON.stringify(gap.body));
  const approvedGap = await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(approvedGap.response.status, 201, JSON.stringify(approvedGap.body));

  const ids: string[] = [];
  for (const title of ['批量选题甲', '批量选题乙']) {
    const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
      method: 'POST',
      body: JSON.stringify({ title, gapIds: [gap.body.id], status: 'eligible' }),
    });
    assert.equal(opportunity.response.status, 201, JSON.stringify(opportunity.body));
    const selected = await request(
      `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
      { method: 'POST' },
    );
    assert.equal(selected.response.status, 201, JSON.stringify(selected.body));
    ids.push(String(opportunity.body.id));
  }
  return ids;
}

test('smoke: 2 选题 × 2 预设经 HTTP 展开为一个 4 任务批次并被列表/详情如实聚合', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '批量冒烟项目', domain: '去眼袋', cities: ['成都'] }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  const projectId = String(project.body.id);
  const opportunityIds = await seedApprovedOpportunities(app, request, projectId);

  const presets = await request(`/api/projects/${projectId}/presets`);
  assert.equal(presets.response.status, 200, JSON.stringify(presets.body));
  const presetIds = presets.body.slice(0, 2).map((item: any) => String(item.id));
  assert.equal(presetIds.length, 2);

  // 二维展开：每个选题 × 每个预设 = 4 个任务，与前端 buildBatchJobs 的笛卡尔积一致。
  const jobs = opportunityIds.flatMap((opportunityId) =>
    presetIds.map((presetId: string) => ({ mode: 'simple', opportunityId, presetId })));
  assert.equal(jobs.length, 4);

  const batch = await request('/api/generation-batches', {
    method: 'POST',
    body: JSON.stringify({ projectId, name: '冒烟批次', jobs }),
  });
  assert.equal(batch.response.status, 201, JSON.stringify(batch.body));
  const batchId = String(batch.body.id);
  assert.equal(batch.body.name, '冒烟批次');
  assert.equal(batch.body.totalJobs, 4);
  assert.equal(batch.body.jobs.length, 4);
  // 无 API key 时任务会失败，但批次结构必须完整：4 个任务都挂在这个批次上，选题/预设各按笛卡尔积落位。
  assert.deepEqual(
    [...new Set(batch.body.jobs.map((job: any) => String(job.presetId)))].sort(),
    [...presetIds].sort(),
  );
  const batchIdColumn = app.get(DatabaseService)
    .prepare('SELECT COUNT(*) AS total FROM generation_jobs WHERE batch_id=?')
    .get(batchId) as { total: number | bigint };
  assert.equal(Number(batchIdColumn.total), 4);

  // 状态聚合：轮询到终态，且聚合值必须与四个任务的真实状态一致（不是硬编码）。
  let detail: any;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    detail = (await request(`/api/generation-batches/${batchId}`)).body;
    if (!detail.jobs.some((job: any) => ['queued', 'running'].includes(job.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(detail.jobs.length, 4);
  assert.equal(detail.status, computeBatchStatus(detail.jobs.map((job: any) => String(job.status))));
  assert.ok(['completed', 'failed', 'partial'].includes(detail.status), `未收敛到终态: ${detail.status}`);
  assert.ok(detail.completedAt, '终态批次应回写 completedAt');

  // 列表接口返回裸数组且内联 jobs（前端 BatchBoard 依赖这个形状）。
  const list = await request(`/api/generation-batches?projectId=${projectId}`);
  assert.equal(list.response.status, 200);
  assert.ok(Array.isArray(list.body), '列表应为裸数组，不是 { items }');
  const listed = list.body.find((item: any) => String(item.id) === batchId);
  assert.ok(listed, '新建批次应出现在列表里');
  assert.equal(listed.jobs.length, 4);
  assert.equal(listed.status, detail.status);
});

test('smoke: 批次校验拒绝空任务与超限，且拒绝时不留下半个批次', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '批量校验项目' }),
  });
  const projectId = String(project.body.id);
  const [opportunityId] = await seedApprovedOpportunities(app, request, projectId);

  const empty = await request('/api/generation-batches', {
    method: 'POST',
    body: JSON.stringify({ projectId, jobs: [] }),
  });
  assert.equal(empty.response.status, 400, JSON.stringify(empty.body));

  const tooMany = await request('/api/generation-batches', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      jobs: Array.from({ length: 61 }, () => ({ mode: 'simple', opportunityId })),
    }),
  });
  assert.equal(tooMany.response.status, 400, JSON.stringify(tooMany.body));

  // 整批回滚：任一任务校验失败(此处第二个任务引用不存在的选题)，批次账本与任务都不得残留。
  const partiallyInvalid = await request('/api/generation-batches', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      jobs: [{ mode: 'simple', opportunityId }, { mode: 'simple', opportunityId: 'does-not-exist' }],
    }),
  });
  assert.ok(partiallyInvalid.response.status >= 400, JSON.stringify(partiallyInvalid.body));
  const database = app.get(DatabaseService);
  const batches = database.prepare('SELECT COUNT(*) AS total FROM generation_batches WHERE project_id=?')
    .get(projectId) as { total: number | bigint };
  assert.equal(Number(batches.total), 0, '被拒绝的批次不应留下账本行');
  const orphanJobs = database.prepare('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=? AND batch_id IS NOT NULL')
    .get(projectId) as { total: number | bigint };
  assert.equal(Number(orphanJobs.total), 0, '被拒绝的批次不应留下任务行');

  const list = await request(`/api/generation-batches?projectId=${projectId}`);
  assert.deepEqual(list.body, []);
});
