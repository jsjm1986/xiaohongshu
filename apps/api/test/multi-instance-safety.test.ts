import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { DatabaseService } from '../src/database.service.js';
import { claimNextJob, heartbeatJob, reclaimStaleJobs } from '../src/job-claim.js';

/**
 * 两个实例共用同一个 SQLite 文件。
 *
 * 这是实测踩到的场景:两个 API 进程共用 data/app.db,各自启动时的恢复逻辑把对方
 * 正在跑的任务判成「被重启打断」,计数 +1 并抢回队列。三轮之后任务被判 failed,
 * 报「任务被应用重启多次打断(3 次)」——而实际上没有任何一次真正的重启。
 *
 * 用两个独立的 DatabaseService 指向同一个文件来复现:每个实例有自己的连接、自己
 * 的 instanceId,和真实部署一致。WAL + busy_timeout + BEGIN IMMEDIATE 已经保证
 * 引擎层安全,这里验的是**业务不变式**:不重复执行、不误杀、不丢任务。
 */

let dataDir = '';
let databasePath = '';
let instanceA: DatabaseService;
let instanceB: DatabaseService;

const ID_A = 'host:1001:aaaa';
const ID_B = 'host:1002:bbbb';
const CLAIM_TIMEOUT_MS = 90_000;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-multi-instance-'));
  databasePath = join(dataDir, 'app.db');
  // 两个连接,同一个文件——迁移幂等,第二个构造只会读到 user_version 已是最新。
  instanceA = new DatabaseService({ dataDir, databasePath } as never);
  instanceB = new DatabaseService({ dataDir, databasePath } as never);
  seedParents();
});

after(async () => {
  instanceA?.onModuleDestroy?.();
  instanceB?.onModuleDestroy?.();
  await rm(dataDir, { recursive: true, force: true });
});

function seedParents(): void {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, system_role, created_at, updated_at)
       VALUES ('u1','multi-instance-fixture','x','admin',?,?)`,
    )
    .run(now, now);
  instanceA
    .prepare('INSERT OR IGNORE INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('w1', 'ws', 'ws', 'u1', now, now);
  instanceA
    .prepare(
      `INSERT OR IGNORE INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES ('p1','w1','proj','项目','u1',?,?)`,
    )
    .run(now, now);
}

function seedQueued(id: string, createdAt: string): void {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT INTO generation_jobs
         (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
          topic, goal, mode, progress, knowledge_context_json, style_profile_version,
          resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
          planning_context_json, image_context_json, research_snapshot_json, quality_status)
       VALUES (?, 'p1', 'queued', '{}', 's', 'u1', ?, ?, ?, 'g', 'simple', 0, '{}', 1,
          '{}', '{}', '{}', '{}', '[]', '{}', 'unknown')`,
    )
    .run(id, createdAt, now, `选题-${id}`);
}

function rowOf(id: string) {
  return instanceA
    .prepare('SELECT status, claimed_by, resolution_snapshot_json FROM generation_jobs WHERE id=?')
    .get(id) as { status: string; claimed_by: string | null; resolution_snapshot_json: string };
}

function interruptionsOf(id: string): number {
  return Number((JSON.parse(rowOf(id).resolution_snapshot_json) as { restartInterruptions?: number }).restartInterruptions ?? 0);
}

beforeEach(() => {
  instanceA.prepare('DELETE FROM generation_jobs').run();
});

test('24 篇任务被两个实例分完:每篇恰好领一次,没有一篇漏掉', () => {
  // 批量上限就是 24 篇,用真实规模。
  for (let i = 0; i < 24; i += 1) {
    seedQueued(`batch-${String(i).padStart(2, '0')}`, `2026-07-26T00:00:${String(i).padStart(2, '0')}.000Z`);
  }

  const claimedByA: string[] = [];
  const claimedByB: string[] = [];
  // 交替领取,直到两边都领不到——模拟两个实例各自 drainQueue。
  for (;;) {
    const a = claimNextJob(instanceA, ID_A, new Date().toISOString());
    const b = claimNextJob(instanceB, ID_B, new Date().toISOString());
    if (a) claimedByA.push(a);
    if (b) claimedByB.push(b);
    if (!a && !b) break;
  }

  const all = [...claimedByA, ...claimedByB];
  assert.equal(all.length, 24, '24 篇都要被领走,不能有漏');
  assert.equal(new Set(all).size, 24, '不能有任何一篇被领两次');
  assert.ok(claimedByA.length > 0 && claimedByB.length > 0, '两个实例都该分到活');
  // 领完之后队列空,库里全是 running。
  const stillQueued = instanceA
    .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='queued'")
    .get() as { value: number };
  assert.equal(Number(stillQueued.value), 0);
});

test('B 实例启动不会抢走 A 正在跑的任务:实测被判 failed 的那条路径', () => {
  seedQueued('a-job', '2026-07-26T00:00:01.000Z');
  const claimed = claimNextJob(instanceA, ID_A, new Date().toISOString());
  assert.equal(claimed, 'a-job');

  // B 启动:回收孤儿 → 领队列。A 的心跳是刚才领取时写的,新鲜。
  const reclaimed = reclaimStaleJobs(instanceB, new Date().toISOString(), CLAIM_TIMEOUT_MS);
  const bClaim = claimNextJob(instanceB, ID_B, new Date().toISOString());

  assert.deepEqual(reclaimed, { requeued: [], failed: [] }, 'A 的任务不该被回收');
  assert.equal(bClaim, undefined, '没有排队任务了,B 不该领到东西');
  assert.equal(rowOf('a-job').claimed_by, ID_A, '归属不能被抢走');
  assert.equal(interruptionsOf('a-job'), 0, '打断计数不能被别的实例启动污染');
});

test('反复启动 B 也不会把 A 的任务累计打断到触顶判死', () => {
  seedQueued('long-job', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, new Date().toISOString());

  // 模拟 B 反复重启(实测就是这样把计数推到 3 的),期间 A 持续续心跳。
  for (let i = 0; i < 5; i += 1) {
    assert.equal(heartbeatJob(instanceA, 'long-job', ID_A, new Date().toISOString()), true);
    reclaimStaleJobs(instanceB, new Date().toISOString(), CLAIM_TIMEOUT_MS);
  }

  const row = rowOf('long-job');
  assert.equal(row.status, 'running', '任务必须一直在跑,不能被判 failed');
  assert.equal(row.claimed_by, ID_A);
  assert.equal(interruptionsOf('long-job'), 0);
});

test('A 停止心跳后 B 能接管:实例崩掉的任务不会永久卡住', () => {
  const start = new Date('2026-07-26T12:00:00.000Z');
  seedQueued('handover', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, start.toISOString());

  // A 崩了,心跳停在 start;时间前进到超时之后。
  const later = new Date(start.getTime() + CLAIM_TIMEOUT_MS + 30_000);
  const reclaimed = reclaimStaleJobs(instanceB, later.toISOString(), CLAIM_TIMEOUT_MS);
  assert.deepEqual(reclaimed.requeued, ['handover']);

  const bClaim = claimNextJob(instanceB, ID_B, later.toISOString());
  assert.equal(bClaim, 'handover', 'B 应能接着跑');
  assert.equal(rowOf('handover').claimed_by, ID_B);
  assert.equal(interruptionsOf('handover'), 1, '真实中断才计数');

  // A 若「复活」再想续心跳,必须失败——否则两个实例会同时写同一份产出。
  assert.equal(heartbeatJob(instanceA, 'handover', ID_A, later.toISOString()), false);
});

test('两个实例同时回收同一批孤儿:任务只被归还一次,计数不重复累加', () => {
  const start = new Date('2026-07-26T12:00:00.000Z');
  seedQueued('shared-orphan', '2026-07-26T00:00:01.000Z');
  claimNextJob(instanceA, ID_A, start.toISOString());
  const later = new Date(start.getTime() + CLAIM_TIMEOUT_MS + 30_000);

  const first = reclaimStaleJobs(instanceA, later.toISOString(), CLAIM_TIMEOUT_MS);
  const second = reclaimStaleJobs(instanceB, later.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(first.requeued, ['shared-orphan']);
  // 第一次已把它标回 queued,第二次扫描只看 running,所以看不到它。
  assert.deepEqual(second.requeued, [], '同一个孤儿不该被回收两次');
  assert.equal(interruptionsOf('shared-orphan'), 1, '计数不能被多个实例各加一次');
});

test('配额扣减在两个连接间不超发:上限就是上限', () => {
  const now = new Date().toISOString();
  instanceA
    .prepare(
      `INSERT OR REPLACE INTO workspace_settings
         (workspace_id, provider_mode, provider, model, base_url, transport,
          monthly_quota, quota_used, default_temperature, updated_by, updated_at)
       VALUES ('w1','platform','openai','m','http://x/v1','chat_completions',5,0,0.8,'u1',?)`,
    )
    .run(now);

  // 两个连接交替扣,共尝试 12 次,上限 5。
  const consume = (db: DatabaseService) => db
    .prepare(
      `UPDATE workspace_settings SET quota_used = quota_used + 1, updated_at=?
        WHERE workspace_id='w1' AND quota_used < monthly_quota`,
    )
    .run(new Date().toISOString()).changes;

  let granted = 0;
  for (let i = 0; i < 12; i += 1) granted += consume(i % 2 === 0 ? instanceA : instanceB) ? 1 : 0;

  assert.equal(granted, 5, '只应放行到上限');
  const row = instanceA.prepare("SELECT quota_used FROM workspace_settings WHERE workspace_id='w1'").get() as { quota_used: number };
  assert.equal(Number(row.quota_used), 5, 'quota_used 不得越过 monthly_quota');
});
