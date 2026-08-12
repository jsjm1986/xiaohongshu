import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { claimNextJob, queuedJobPosition } from '../src/job-claim.js';

/**
 * 队列的工作区公平性。
 *
 * 并发槽只有 2:全局 FIFO 下一个客户提 60 篇批量,另一个客户的单篇要排到
 * 第 61 位(2.5-8 小时)。公平认领按「该工作区正在运行的任务数」优先,并发槽
 * 在活跃工作区之间均分;单工作区场景退化回 FIFO,与旧语义一致。
 */

let app: NestExpressApplication;
let dataDir = '';
let database: DatabaseService;
let adminId = '';

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-queue-fair-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'queue-fairness-test-master-key!!',
    logger: false,
  });
  database = app.get(DatabaseService);
  adminId = String((database.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function seedWorkspaceWithProject(name: string): { workspaceId: string; projectId: string } {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const now = new Date().toISOString();
  database.prepare('INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(workspaceId, `ws-${workspaceId.slice(0, 8)}`, name, adminId, now, now);
  database.prepare(
    `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, workspaceId, `slug-${projectId.slice(0, 8)}`, name, adminId, now, now);
  return { workspaceId, projectId };
}

function seedJob(projectId: string, status: 'queued' | 'running', createdAt: string): string {
  const id = randomUUID();
  database.prepare(
    `INSERT INTO generation_jobs (id, project_id, status, config_json, seed, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '{}', '1', ?, ?, ?)`,
  ).run(id, projectId, status, adminId, createdAt, createdAt);
  return id;
}

test('有批量在跑的工作区让位：并发槽在工作区间均分', () => {
  const a = seedWorkspaceWithProject('客户A-批量');
  const b = seedWorkspaceWithProject('客户B-单篇');
  // A 先提交且已占用一个并发槽;B 的单篇更晚提交
  seedJob(a.projectId, 'running', '2026-08-13T10:00:00.000Z');
  const aQueued = seedJob(a.projectId, 'queued', '2026-08-13T10:00:01.000Z');
  const bQueued = seedJob(b.projectId, 'queued', '2026-08-13T10:05:00.000Z');

  const first = claimNextJob(database, 'fair-test-instance', new Date().toISOString());
  assert.equal(first, bQueued, 'B 工作区无任务在跑,必须先于 A 的批量尾部被服务');

  // B 被认领后(B running=1, A running=1),回到提交时间序:A 的排队任务被取
  const second = claimNextJob(database, 'fair-test-instance', new Date().toISOString());
  assert.equal(second, aQueued);
});

test('无运行中任务时保持 FIFO：单工作区行为与旧语义一致', () => {
  const c = seedWorkspaceWithProject('客户C');
  const early = seedJob(c.projectId, 'queued', '2026-08-13T11:00:00.000Z');
  const late = seedJob(c.projectId, 'queued', '2026-08-13T11:00:05.000Z');
  const claimed = claimNextJob(database, 'fair-test-instance', new Date().toISOString());
  assert.equal(claimed, early, '同工作区内先提交先服务');
  // 清场,避免影响其他用例
  database.prepare("UPDATE generation_jobs SET status='completed' WHERE id IN (?, ?)").run(early, claimed);
  database.prepare("UPDATE generation_jobs SET status='completed' WHERE id=?").run(late);
});

test('排队位次按同工作区口径：别的客户的批量不出现在你的位次里', () => {
  const d = seedWorkspaceWithProject('客户D-大批量');
  const e = seedWorkspaceWithProject('客户E-单篇');
  for (let index = 0; index < 5; index += 1) {
    seedJob(d.projectId, 'queued', `2026-08-13T12:00:0${index}.000Z`);
  }
  const eFirst = seedJob(e.projectId, 'queued', '2026-08-13T12:10:00.000Z');
  const eSecond = seedJob(e.projectId, 'queued', '2026-08-13T12:10:01.000Z');

  assert.equal(queuedJobPosition(database, eFirst), 1, 'E 的第一篇在自己工作区位次 1,不被 D 的 5 篇顶到第 6');
  assert.equal(queuedJobPosition(database, eSecond), 2);
});
