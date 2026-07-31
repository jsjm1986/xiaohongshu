import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { DatabaseService } from '../src/database.service.js';
import {
  claimNext,
  claimNextJob,
  heartbeatJob,
  heartbeatTask,
  queuedJobCount,
  queuedJobPosition,
  reclaimStale,
  reclaimStaleJobs,
  RESTART_INTERRUPTION_LIMIT,
  REVISION_TASKS_SPEC,
} from '../src/job-claim.js';

/**
 * 多实例并发正确性。
 *
 * 原实现的队列是进程内内存数组、恢复逻辑无条件抓全表 queued/running 重置,于是
 * 两个 API 进程共用同一个 data/app.db 时会互相误判:B 启动把 A 正在跑的任务判成
 * 「被重启打断」,计数 +1 并抢回队列。实测两个任务因此被判 failed,报「被应用
 * 重启多次打断(3 次)」而实际上没有任何一次真正的重启。
 *
 * 这些用例锁住四件事:同一任务只能被一个实例领到;心跳新鲜的任务谁都不许碰;
 * 心跳超时的任务能被任意实例回收;反复打断仍有上限。
 */

let dataDir = '';
let database: DatabaseService;

const INSTANCE_A = 'host:111:aaaa';
const INSTANCE_B = 'host:222:bbbb';
const CLAIM_TIMEOUT_MS = 90_000;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ca-job-claim-'));
  database = new DatabaseService({ dataDir, databasePath: join(dataDir, 'app.db') } as never);
  seedParents();
});

after(async () => {
  database?.onModuleDestroy?.();
  await rm(dataDir, { recursive: true, force: true });
});

/** 满足外键的最小父行:user → workspace → project。 */
function seedParents(): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, system_role, created_at, updated_at)
       VALUES ('u1','job-claim-fixture','x','admin',?,?)`,
    )
    .run(now, now);
  database
    .prepare('INSERT OR IGNORE INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('w1', 'ws', 'ws', 'u1', now, now);
  database
    .prepare('INSERT OR IGNORE INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run('w2', 'ws-valid', 'ws-valid', 'u1', now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES ('p1','w1','proj','项目','u1',?,?)`,
    )
    .run(now, now);
  database
    .prepare(
      `INSERT OR IGNORE INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
       VALUES ('p2','w2','proj-valid','有效项目','u1',?,?)`,
    )
    .run(now, now);
}

/** createdAt 显式传入:领取顺序按 (created_at, id),用例要能控制先后。 */
function seedJob(id: string, input: {
  status: string;
  createdAt?: string;
  claimedBy?: string | null;
  heartbeatAt?: string | null;
  interruptions?: number;
  projectId?: string;
} ): void {
  const now = new Date().toISOString();
  const snapshot = input.interruptions === undefined
    ? '{}'
    : JSON.stringify({ restartInterruptions: input.interruptions });
  database
    .prepare(
      `INSERT INTO generation_jobs
         (id, project_id, status, config_json, seed, created_by, created_at, updated_at,
          topic, goal, mode, progress, knowledge_context_json, style_profile_version,
          resolution_snapshot_json, config_impact_json, opportunity_snapshot_json,
          planning_context_json, image_context_json, research_snapshot_json, quality_status,
          claimed_by, claimed_at, heartbeat_at)
       VALUES (?, ?, ?, '{}', 's', 'u1', ?, ?, ?, 'g', 'simple', 0, '{}', 1,
          ?, '{}', '{}', '{}', '[]', '{}', 'unknown', ?, ?, ?)`,
    )
    .run(
      id, input.projectId ?? 'p1', input.status, input.createdAt ?? now, now, `选题-${id}`, snapshot,
      input.claimedBy ?? null, input.claimedBy ? now : null, input.heartbeatAt ?? null,
    );
}

/** 造一条修改任务。父 job 必须先由 seedJob 建好,否则外键失败。 */
/**
 * packageId 默认按 id 取,不再固定 'pkg-1'。
 * revision_tasks_active_job_idx 是「一个 job 同时只能有一条未终态修改」的部分唯一索引,
 * 所以要造两条同时活跃的任务就得挂在两个不同的 job 上;现实中也正是如此。本文件验的是
 * 认领与回收,与目标 job / 包无关。
 */
function seedRevisionTask(id: string, jobId: string, input: {
  status?: string;
  claimedBy?: string | null;
  heartbeatAt?: string | null;
  attempts?: number;
  packageId?: string;
} = {}): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO revision_tasks
         (id, job_id, package_id, candidate_id, instruction, status, progress, attempt_count,
          rerun_channels_json, created_by, created_at, updated_at, claimed_by, heartbeat_at)
       VALUES (?, ?, ?, 'cand-1', '正文不要有价格', ?, 0, ?, '[]', 'u1', ?, ?, ?, ?)`,
    )
    .run(
      id, jobId, input.packageId ?? `pkg-${id}`, input.status ?? 'queued', input.attempts ?? 0, now, now,
      input.claimedBy ?? null, input.heartbeatAt ?? null,
    );
}

function revisionRowOf(id: string) {
  return database
    .prepare('SELECT status, progress, attempt_count, claimed_by, heartbeat_at, error FROM revision_tasks WHERE id=?')
    .get(id) as {
      status: string; progress: number; attempt_count: number;
      claimed_by: string | null; heartbeat_at: string | null; error: string | null;
    };
}

/** 两张表共用的失败文案生成器,与 revision.service 传的那份保持一致。 */
const revisionFailMessage = (attempts: number) =>
  `修改被反复打断（${attempts} 次），已停止自动重跑，请重新提交修改要求`;

function rowOf(id: string) {
  return database
    .prepare(
      'SELECT status, progress, claimed_by, claimed_at, heartbeat_at, error, resolution_snapshot_json FROM generation_jobs WHERE id=?',
    )
    .get(id) as {
      status: string; progress: number; claimed_by: string | null;
      claimed_at: string | null; heartbeat_at: string | null; error: string | null;
      resolution_snapshot_json: string;
    };
}

function interruptionsOf(id: string): number {
  return Number((JSON.parse(rowOf(id).resolution_snapshot_json) as { restartInterruptions?: number }).restartInterruptions ?? 0);
}

beforeEach(() => {
  // revision_tasks 先删:它有 job_id 外键,虽然是 CASCADE,显式顺序更不容易误解。
  database.prepare('DELETE FROM revision_tasks').run();
  database.prepare('DELETE FROM generation_jobs').run();
  database.prepare('UPDATE projects SET deleted_at=NULL').run();
  database.prepare('UPDATE workspaces SET deleted_at=NULL').run();
});

test('同一个排队任务只会被一个实例领到:第二个实例拿不到它', () => {
  seedJob('only-one', { status: 'queued' });

  const first = claimNextJob(database, INSTANCE_A, new Date().toISOString());
  const second = claimNextJob(database, INSTANCE_B, new Date().toISOString());

  assert.equal(first, 'only-one');
  assert.equal(second, undefined, '队列已空,第二个实例不该领到任何任务');
  assert.equal(rowOf('only-one').claimed_by, INSTANCE_A);
  assert.equal(rowOf('only-one').status, 'running', '领取即置 running,不留中间态');
});

test('两个实例交替领取:各拿到不同任务,没有一条被领两次', () => {
  seedJob('j-1', { status: 'queued', createdAt: '2026-07-26T00:00:01.000Z' });
  seedJob('j-2', { status: 'queued', createdAt: '2026-07-26T00:00:02.000Z' });
  seedJob('j-3', { status: 'queued', createdAt: '2026-07-26T00:00:03.000Z' });

  const claimed = [
    claimNextJob(database, INSTANCE_A, new Date().toISOString()),
    claimNextJob(database, INSTANCE_B, new Date().toISOString()),
    claimNextJob(database, INSTANCE_A, new Date().toISOString()),
    claimNextJob(database, INSTANCE_B, new Date().toISOString()),
  ];

  // 按 (created_at, id) 顺序发放,第四次队列已空。
  assert.deepEqual(claimed, ['j-1', 'j-2', 'j-3', undefined]);
  assert.equal(new Set(claimed.filter(Boolean)).size, 3, '不能有任务被领两次');
  assert.equal(rowOf('j-1').claimed_by, INSTANCE_A);
  assert.equal(rowOf('j-2').claimed_by, INSTANCE_B);
  assert.equal(rowOf('j-3').claimed_by, INSTANCE_A);
});

test('心跳新鲜的任务不会被回收:别的实例正在正常跑它', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  // A 的心跳只落后 10 秒,远小于 90 秒超时。
  seedJob('alive', { status: 'running', claimedBy: INSTANCE_A, heartbeatAt: new Date(now.getTime() - 10_000).toISOString() });

  const result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result, { requeued: [], failed: [] });
  assert.equal(rowOf('alive').status, 'running', '别人在跑的任务必须原样留着');
  assert.equal(rowOf('alive').claimed_by, INSTANCE_A, '归属不能被抢走');
});

test('B 实例启动不会动 A 正在跑的任务:这是原实现误判的那条路径', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  seedJob('a-running', { status: 'running', claimedBy: INSTANCE_A, heartbeatAt: new Date(now.getTime() - 5_000).toISOString() });
  seedJob('b-queued', { status: 'queued' });

  // B 启动:先回收孤儿,再领队列。
  const reclaimed = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);
  const claimed = claimNextJob(database, INSTANCE_B, now.toISOString());

  assert.deepEqual(reclaimed, { requeued: [], failed: [] }, 'A 的任务不该被回收');
  assert.equal(claimed, 'b-queued', 'B 只应领到真正排队的那条');
  assert.equal(interruptionsOf('a-running'), 0, '打断计数不能被别的实例启动污染');
});

test('心跳超时的任务被归还队列并累加打断计数:持有它的实例已经死了', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  seedJob('orphan', {
    status: 'running', claimedBy: INSTANCE_A, interruptions: 1,
    heartbeatAt: new Date(now.getTime() - 120_000).toISOString(),
  });

  const result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result.requeued, ['orphan']);
  const row = rowOf('orphan');
  assert.equal(row.status, 'queued');
  assert.equal(row.claimed_by, null, '归还时要清空归属,否则谁都领不走');
  assert.equal(row.claimed_at, null, '归还时也要清空旧领取时间');
  assert.equal(row.heartbeat_at, null);
  assert.equal(Number(row.progress), 0, '重跑要从头开始');
  assert.equal(interruptionsOf('orphan'), 2);
});

test('心跳为 NULL 的存量 running 行被接管:升级那一刻在跑的任务不能永久卡住', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  // 迁移前的行:三列都是 NULL。
  seedJob('legacy', { status: 'running', claimedBy: null, heartbeatAt: null });

  const result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result.requeued, ['legacy']);
  assert.equal(rowOf('legacy').status, 'queued');
  assert.equal(interruptionsOf('legacy'), 1);
});

test('排队中的任务不被回收:它本来就在等领取,谁都能领', () => {
  seedJob('waiting', { status: 'queued', heartbeatAt: null });

  const result = reclaimStaleJobs(database, new Date().toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result, { requeued: [], failed: [] });
  assert.equal(rowOf('waiting').status, 'queued');
  assert.equal(interruptionsOf('waiting'), 0, '排队从未开始执行,不算被打断');
  // 与旧实现的语义差异:旧的 recoverInterruptedJobs 要把 queued 任务「重新入队」
  // (因为队列在内存里,重启就丢了)。队列改到 DB 之后 queued 本身就是排队状态,
  // 不需要任何动作——少一次无谓的写库,也少一处能出错的地方。
});

test('终态任务不受回收影响:completed / failed 都不该被翻回队列', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  // 心跳早就过期,但状态是终态——回收只看 running。
  seedJob('done', { status: 'completed', heartbeatAt: new Date(now.getTime() - 600_000).toISOString() });
  seedJob('dead', { status: 'failed', heartbeatAt: null });

  const result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result, { requeued: [], failed: [] });
  assert.equal(rowOf('done').status, 'completed');
  assert.equal(rowOf('dead').status, 'failed');
});

test('超过打断上限的任务判 failed,不再无限重跑烧模型调用', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  seedJob('looping', {
    status: 'running', claimedBy: INSTANCE_A, interruptions: RESTART_INTERRUPTION_LIMIT,
    heartbeatAt: new Date(now.getTime() - 120_000).toISOString(),
  });

  const result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);

  assert.deepEqual(result.failed, ['looping']);
  assert.deepEqual(result.requeued, []);
  const row = rowOf('looping');
  assert.equal(row.status, 'failed');
  assert.match(String(row.error), /反复打断/u);
  assert.equal(row.claimed_by, null, '判死也要清归属,避免残留误导');
  assert.equal(row.claimed_at, null, '失败终态不能残留旧领取时间');
});

test('心跳续约成功;丢失所有权时返回 false,让调用方中止写入', () => {
  const now = new Date().toISOString();
  seedJob('mine', { status: 'running', claimedBy: INSTANCE_A, heartbeatAt: now });

  assert.equal(heartbeatJob(database, 'mine', INSTANCE_A, new Date().toISOString()), true);
  // B 不持有它,续约必须失败——否则两个实例会同时写同一个任务的产出。
  assert.equal(heartbeatJob(database, 'mine', INSTANCE_B, new Date().toISOString()), false);
  // 被回收后归属清空,原持有者也续不上。
  database.prepare("UPDATE generation_jobs SET claimed_by=NULL WHERE id='mine'").run();
  assert.equal(heartbeatJob(database, 'mine', INSTANCE_A, new Date().toISOString()), false);
});

test('generation_jobs:终态与软删任务拒绝迟到心跳且不改原时间', () => {
  const heartbeatAt = '2026-07-26T11:59:00.000Z';
  const attemptedAt = '2026-07-26T12:00:00.000Z';
  seedJob('completed-heartbeat', { status: 'completed', claimedBy: INSTANCE_A, heartbeatAt });
  seedJob('failed-heartbeat', { status: 'failed', claimedBy: INSTANCE_A, heartbeatAt });
  seedJob('deleted-heartbeat', { status: 'running', claimedBy: INSTANCE_A, heartbeatAt });
  database.prepare("UPDATE generation_jobs SET deleted_at=? WHERE id='deleted-heartbeat'").run(attemptedAt);

  assert.equal(heartbeatJob(database, 'completed-heartbeat', INSTANCE_A, attemptedAt), false);
  assert.equal(heartbeatJob(database, 'failed-heartbeat', INSTANCE_A, attemptedAt), false);
  assert.equal(heartbeatJob(database, 'deleted-heartbeat', INSTANCE_A, attemptedAt), false);
  assert.equal(rowOf('completed-heartbeat').heartbeat_at, heartbeatAt);
  assert.equal(rowOf('failed-heartbeat').heartbeat_at, heartbeatAt);
  assert.equal(rowOf('deleted-heartbeat').heartbeat_at, heartbeatAt);
});

test('generation_jobs:回收使用旧快照时不覆盖新心跳或新领取者', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  const staleHeartbeat = new Date(now.getTime() - 600_000).toISOString();
  const refreshedHeartbeat = new Date(now.getTime() - 1_000).toISOString();
  seedJob('freshened-during-reclaim', {
    status: 'running', claimedBy: INSTANCE_A, heartbeatAt: staleHeartbeat, interruptions: 1,
  });
  seedJob('reclaimed-during-reclaim', {
    status: 'running', claimedBy: INSTANCE_A, heartbeatAt: staleHeartbeat, interruptions: 1,
  });

  const originalPrepare = database.prepare.bind(database);
  let raceInjected = false;
  (database as unknown as { prepare: typeof originalPrepare }).prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('SELECT id, claimed_by, heartbeat_at') || !sql.includes('FROM generation_jobs')) {
      return statement;
    }
    return {
      all: (...args: unknown[]) => {
        const rows = statement.all(...args);
        if (!raceInjected) {
          raceInjected = true;
          originalPrepare(
            "UPDATE generation_jobs SET heartbeat_at=?, updated_at=? WHERE id='freshened-during-reclaim'",
          ).run(refreshedHeartbeat, refreshedHeartbeat);
          originalPrepare(
            `UPDATE generation_jobs
                SET status='queued', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, updated_at=?
              WHERE id='reclaimed-during-reclaim'`,
          ).run(refreshedHeartbeat);
          assert.equal(claimNextJob(database, INSTANCE_B, refreshedHeartbeat), 'reclaimed-during-reclaim');
        }
        return rows;
      },
    } as unknown as ReturnType<typeof originalPrepare>;
  };

  let result;
  try {
    result = reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS);
  } finally {
    (database as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;
  }

  assert.equal(raceInjected, true, '前提:旧快照读出后确实注入了状态变化');
  assert.deepEqual(result, { requeued: [], failed: [] }, 'CAS 失败的行不能被误报为已回收');
  const freshened = rowOf('freshened-during-reclaim');
  assert.equal(freshened.status, 'running');
  assert.equal(freshened.claimed_by, INSTANCE_A);
  assert.equal(freshened.heartbeat_at, refreshedHeartbeat, '新心跳不能被旧快照覆盖');
  assert.equal(interruptionsOf('freshened-during-reclaim'), 1);
  const reclaimed = rowOf('reclaimed-during-reclaim');
  assert.equal(reclaimed.status, 'running');
  assert.equal(reclaimed.claimed_by, INSTANCE_B, '新领取者不能被迟到的回收覆盖');
  assert.equal(reclaimed.heartbeat_at, refreshedHeartbeat);
  assert.equal(interruptionsOf('reclaimed-during-reclaim'), 1, 'CAS 失败不能错误累加打断次数');
});

test('队列位次与总数从 DB 算,是跨实例的全局真值', () => {
  seedJob('p-1', { status: 'queued', createdAt: '2026-07-26T00:00:01.000Z' });
  seedJob('p-2', { status: 'queued', createdAt: '2026-07-26T00:00:02.000Z' });
  seedJob('p-3', { status: 'queued', createdAt: '2026-07-26T00:00:03.000Z' });
  seedJob('p-running', { status: 'running', claimedBy: INSTANCE_A, heartbeatAt: new Date().toISOString() });

  assert.equal(queuedJobCount(database), 3, 'running 的不算排队');
  assert.equal(queuedJobPosition(database, 'p-1'), 1);
  assert.equal(queuedJobPosition(database, 'p-2'), 2);
  assert.equal(queuedJobPosition(database, 'p-3'), 3);
  // 不在排队的一律 undefined:0 会被前端 `if (pos)` 判为假。
  assert.equal(queuedJobPosition(database, 'p-running'), undefined);
  assert.equal(queuedJobPosition(database, 'no-such-job'), undefined);

  // 领走第一条后,后面的位次前移——位次反映的是「还要等几个」。
  claimNextJob(database, INSTANCE_A, new Date().toISOString());
  assert.equal(queuedJobCount(database), 2);
  assert.equal(queuedJobPosition(database, 'p-2'), 1);
  assert.equal(queuedJobPosition(database, 'p-3'), 2);
});

test('软删的任务不参与领取与位次:产出区删掉的不该再跑', () => {
  seedJob('deleted', { status: 'queued', createdAt: '2026-07-26T00:00:01.000Z' });
  seedJob('kept', { status: 'queued', createdAt: '2026-07-26T00:00:02.000Z' });
  database.prepare("UPDATE generation_jobs SET deleted_at=datetime('now') WHERE id='deleted'").run();

  assert.equal(queuedJobCount(database), 1);
  assert.equal(queuedJobPosition(database, 'deleted'), undefined);
  assert.equal(queuedJobPosition(database, 'kept'), 1);
  assert.equal(claimNextJob(database, INSTANCE_A, new Date().toISOString()), 'kept');
});

test('已删除项目下的生成任务不参与领取、心跳、回收、总数与位次', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  seedJob('deleted-project-queued', {
    status: 'queued', createdAt: '2026-07-27T00:00:01.000Z', projectId: 'p1',
  });
  seedJob('deleted-project-running', {
    status: 'running', projectId: 'p1', claimedBy: INSTANCE_A,
    heartbeatAt: new Date(now.getTime() - 600_000).toISOString(),
  });
  seedJob('valid-project-queued', {
    status: 'queued', createdAt: '2026-07-27T00:00:02.000Z', projectId: 'p2',
  });
  database.prepare("UPDATE projects SET deleted_at=? WHERE id='p1'").run(now.toISOString());

  assert.equal(queuedJobCount(database), 1);
  assert.equal(queuedJobPosition(database, 'deleted-project-queued'), undefined);
  assert.equal(queuedJobPosition(database, 'valid-project-queued'), 1);
  assert.equal(heartbeatJob(database, 'deleted-project-running', INSTANCE_A, now.toISOString()), false);
  assert.deepEqual(
    reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS),
    { requeued: [], failed: [] },
  );
  assert.equal(rowOf('deleted-project-running').status, 'running', '失效父级不能被回收回队列');
  assert.equal(claimNextJob(database, INSTANCE_B, now.toISOString()), 'valid-project-queued');
  assert.equal(rowOf('deleted-project-queued').status, 'queued');
});

test('已删除工作区下的生成任务不参与领取、心跳、回收、总数与位次', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  seedJob('deleted-workspace-queued', {
    status: 'queued', createdAt: '2026-07-27T00:00:01.000Z', projectId: 'p1',
  });
  seedJob('deleted-workspace-running', {
    status: 'running', projectId: 'p1', claimedBy: INSTANCE_A,
    heartbeatAt: new Date(now.getTime() - 600_000).toISOString(),
  });
  seedJob('valid-workspace-queued', {
    status: 'queued', createdAt: '2026-07-27T00:00:02.000Z', projectId: 'p2',
  });
  database.prepare("UPDATE workspaces SET deleted_at=? WHERE id='w1'").run(now.toISOString());

  assert.equal(queuedJobCount(database), 1);
  assert.equal(queuedJobPosition(database, 'deleted-workspace-queued'), undefined);
  assert.equal(queuedJobPosition(database, 'valid-workspace-queued'), 1);
  assert.equal(heartbeatJob(database, 'deleted-workspace-running', INSTANCE_A, now.toISOString()), false);
  assert.deepEqual(
    reclaimStaleJobs(database, now.toISOString(), CLAIM_TIMEOUT_MS),
    { requeued: [], failed: [] },
  );
  assert.equal(claimNextJob(database, INSTANCE_B, now.toISOString()), 'valid-workspace-queued');
  assert.equal(rowOf('deleted-workspace-queued').status, 'queued');
});

/**
 * 泛化后的认领实现要同时服务两张表。这里锁三件事:
 *  1. revision_tasks 的领取同样原子(两次领取不会拿到同一条)
 *  2. 回收只看 heartbeat_at,不看 claimed_by——instanceId 含 pid,重启即换身份
 *  3. 两张表互不串扰
 * 第 3 条是真实风险:claimNextJob 只按 status='queued' 取,drainQueue 拿到 id
 * 后直接调 process() 跑首次生成全流程,不看任务类型。串表的后果是用全新的 3 个
 * 候选覆盖用户已有产出。
 */
test('revision_tasks:领取是原子的,同一条不会被领两次', () => {
  seedJob('job-1', { status: 'completed' });
  seedRevisionTask('rev-1', 'job-1');
  const first = claimNext(database, REVISION_TASKS_SPEC, INSTANCE_A, new Date().toISOString());
  const second = claimNext(database, REVISION_TASKS_SPEC, INSTANCE_B, new Date().toISOString());
  assert.equal(first, 'rev-1');
  assert.equal(second, undefined, '第二个实例不该领到同一条');
  const row = revisionRowOf('rev-1');
  assert.equal(row.status, 'running');
  assert.equal(row.claimed_by, INSTANCE_A);
});

test('revision_tasks:已删除父任务下的任务拒绝领取、心跳与回收', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  seedJob('deleted-parent-queued', { status: 'completed', projectId: 'p1' });
  seedJob('deleted-parent-running', { status: 'completed', projectId: 'p1' });
  seedJob('valid-parent', { status: 'completed', projectId: 'p2' });
  seedRevisionTask('rev-deleted-parent-queued', 'deleted-parent-queued');
  seedRevisionTask('rev-deleted-parent-running', 'deleted-parent-running', {
    status: 'running', claimedBy: INSTANCE_A,
    heartbeatAt: new Date(now.getTime() - 600_000).toISOString(),
  });
  seedRevisionTask('rev-valid-parent', 'valid-parent');
  database.prepare(
    "UPDATE generation_jobs SET deleted_at=? WHERE id IN ('deleted-parent-queued','deleted-parent-running')",
  ).run(now.toISOString());

  assert.equal(
    heartbeatTask(database, REVISION_TASKS_SPEC, 'rev-deleted-parent-running', INSTANCE_A, now.toISOString()),
    false,
  );
  assert.deepEqual(
    reclaimStale(database, REVISION_TASKS_SPEC, now.toISOString(), CLAIM_TIMEOUT_MS, revisionFailMessage),
    { requeued: [], failed: [] },
  );
  assert.equal(
    claimNext(database, REVISION_TASKS_SPEC, INSTANCE_B, now.toISOString()),
    'rev-valid-parent',
  );
  assert.equal(revisionRowOf('rev-deleted-parent-queued').status, 'queued');
  assert.equal(revisionRowOf('rev-deleted-parent-running').status, 'running');
});

test('revision_tasks:已删除项目或工作区下的任务均拒绝领取', () => {
  const now = new Date().toISOString();
  seedJob('project-parent', { status: 'completed', projectId: 'p1' });
  seedJob('valid-parent', { status: 'completed', projectId: 'p2' });
  seedRevisionTask('rev-deleted-project', 'project-parent');
  seedRevisionTask('rev-valid-project', 'valid-parent');
  database.prepare("UPDATE projects SET deleted_at=? WHERE id='p1'").run(now);
  assert.equal(claimNext(database, REVISION_TASKS_SPEC, INSTANCE_A, now), 'rev-valid-project');
  assert.equal(revisionRowOf('rev-deleted-project').status, 'queued');

  database.prepare("UPDATE projects SET deleted_at=NULL WHERE id='p1'").run();
  database.prepare("UPDATE workspaces SET deleted_at=? WHERE id='w1'").run(now);
  seedJob('valid-parent-2', { status: 'completed', projectId: 'p2' });
  seedRevisionTask('rev-valid-workspace', 'valid-parent-2');
  assert.equal(claimNext(database, REVISION_TASKS_SPEC, INSTANCE_B, now), 'rev-valid-workspace');
  assert.equal(revisionRowOf('rev-deleted-project').status, 'queued');
});

test('revision_tasks:心跳新鲜的不回收,心跳超时的才回收', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  // 两条同时活跃的任务必须挂在两个 job 上:revision_tasks_active_job_idx 只允许一个 job
  // 有一条未终态修改。
  seedJob('job-1', { status: 'completed' });
  seedJob('job-2', { status: 'completed' });
  seedRevisionTask('rev-fresh', 'job-1', {
    status: 'running', claimedBy: INSTANCE_B,
    heartbeatAt: new Date(now.getTime() - 5_000).toISOString(),
  });
  seedRevisionTask('rev-stale', 'job-2', {
    status: 'running', claimedBy: 'host:999:dead',
    heartbeatAt: new Date(now.getTime() - 600_000).toISOString(),
  });

  const result = reclaimStale(database, REVISION_TASKS_SPEC, now.toISOString(), CLAIM_TIMEOUT_MS, revisionFailMessage);
  assert.deepEqual(result.requeued, ['rev-stale']);
  assert.deepEqual(result.failed, []);
  assert.equal(revisionRowOf('rev-fresh').status, 'running', '别的实例正在跑的任务不能被抢走');
  const stale = revisionRowOf('rev-stale');
  assert.equal(stale.status, 'queued');
  assert.equal(stale.attempt_count, 1, '回收即计数 +1');
  assert.equal(stale.claimed_by, null);
  assert.equal(stale.heartbeat_at, null);
});

test('revision_tasks:attempt_count 触顶后判 failed', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  seedJob('job-1', { status: 'completed' });
  seedRevisionTask('rev-doomed', 'job-1', {
    status: 'running', attempts: RESTART_INTERRUPTION_LIMIT,
    heartbeatAt: new Date(now.getTime() - 600_000).toISOString(),
  });
  const result = reclaimStale(database, REVISION_TASKS_SPEC, now.toISOString(), CLAIM_TIMEOUT_MS, revisionFailMessage);
  assert.deepEqual(result.failed, ['rev-doomed']);
  const row = revisionRowOf('rev-doomed');
  assert.equal(row.status, 'failed');
  assert.match(row.error ?? '', /修改被反复打断（3 次）/u);
});

test('两张表互不串扰', () => {
  seedJob('job-1', { status: 'completed' });
  seedRevisionTask('rev-1', 'job-1');
  // 没有任何 queued 的 generation_job,claimNextJob 必须什么都领不到
  assert.equal(claimNextJob(database, INSTANCE_A, new Date().toISOString()), undefined);
  assert.equal(revisionRowOf('rev-1').status, 'queued', 'revision 任务必须还在排队');

  // 反向也要成立:排队中的 generation_job 不会被 revision 的认领拿走
  seedJob('job-queued', { status: 'queued' });
  assert.equal(claimNext(database, REVISION_TASKS_SPEC, INSTANCE_A, new Date().toISOString()), 'rev-1');
  assert.equal(rowOf('job-queued').status, 'queued', '生成任务不该被修改任务的认领动到');
});

test('心跳:不持有的实例续约失败', () => {
  seedJob('job-1', { status: 'completed' });
  seedRevisionTask('rev-1', 'job-1', { status: 'running', claimedBy: INSTANCE_A });
  const now = new Date().toISOString();
  assert.equal(heartbeatTask(database, REVISION_TASKS_SPEC, 'rev-1', INSTANCE_A, now), true);
  assert.equal(
    heartbeatTask(database, REVISION_TASKS_SPEC, 'rev-1', INSTANCE_B, now), false,
    '不持有的实例续约必须返回 false,调用方据此中止写入',
  );
});

test('revision_tasks:终态任务拒绝迟到心跳且不改原时间', () => {
  const heartbeatAt = '2026-07-27T11:59:00.000Z';
  const attemptedAt = '2026-07-27T12:00:00.000Z';
  seedJob('job-completed-heartbeat', { status: 'completed' });
  seedJob('job-failed-heartbeat', { status: 'completed' });
  seedRevisionTask('rev-completed-heartbeat', 'job-completed-heartbeat', {
    status: 'completed', claimedBy: INSTANCE_A, heartbeatAt,
  });
  seedRevisionTask('rev-failed-heartbeat', 'job-failed-heartbeat', {
    status: 'failed', claimedBy: INSTANCE_A, heartbeatAt,
  });

  assert.equal(
    heartbeatTask(database, REVISION_TASKS_SPEC, 'rev-completed-heartbeat', INSTANCE_A, attemptedAt),
    false,
  );
  assert.equal(
    heartbeatTask(database, REVISION_TASKS_SPEC, 'rev-failed-heartbeat', INSTANCE_A, attemptedAt),
    false,
  );
  assert.equal(revisionRowOf('rev-completed-heartbeat').heartbeat_at, heartbeatAt);
  assert.equal(revisionRowOf('rev-failed-heartbeat').heartbeat_at, heartbeatAt);
});

test('revision_tasks:回收使用旧快照时不覆盖新心跳或新领取者', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');
  const staleHeartbeat = new Date(now.getTime() - 600_000).toISOString();
  const refreshedHeartbeat = new Date(now.getTime() - 1_000).toISOString();
  seedJob('job-rev-freshened', { status: 'completed' });
  seedJob('job-rev-reclaimed', { status: 'completed' });
  seedRevisionTask('rev-freshened-during-reclaim', 'job-rev-freshened', {
    status: 'running', claimedBy: INSTANCE_A, heartbeatAt: staleHeartbeat, attempts: 1,
  });
  seedRevisionTask('rev-reclaimed-during-reclaim', 'job-rev-reclaimed', {
    status: 'running', claimedBy: INSTANCE_A, heartbeatAt: staleHeartbeat, attempts: 1,
  });

  const originalPrepare = database.prepare.bind(database);
  let raceInjected = false;
  (database as unknown as { prepare: typeof originalPrepare }).prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('SELECT id, claimed_by, heartbeat_at') || !sql.includes('FROM revision_tasks')) {
      return statement;
    }
    return {
      all: (...args: unknown[]) => {
        const rows = statement.all(...args);
        if (!raceInjected) {
          raceInjected = true;
          originalPrepare(
            "UPDATE revision_tasks SET heartbeat_at=?, updated_at=? WHERE id='rev-freshened-during-reclaim'",
          ).run(refreshedHeartbeat, refreshedHeartbeat);
          originalPrepare(
            `UPDATE revision_tasks
                SET status='queued', claimed_by=NULL, heartbeat_at=NULL, updated_at=?
              WHERE id='rev-reclaimed-during-reclaim'`,
          ).run(refreshedHeartbeat);
          assert.equal(
            claimNext(database, REVISION_TASKS_SPEC, INSTANCE_B, refreshedHeartbeat),
            'rev-reclaimed-during-reclaim',
          );
        }
        return rows;
      },
    } as unknown as ReturnType<typeof originalPrepare>;
  };

  let result;
  try {
    result = reclaimStale(
      database, REVISION_TASKS_SPEC, now.toISOString(), CLAIM_TIMEOUT_MS, revisionFailMessage,
    );
  } finally {
    (database as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;
  }

  assert.equal(raceInjected, true);
  assert.deepEqual(result, { requeued: [], failed: [] });
  const freshened = revisionRowOf('rev-freshened-during-reclaim');
  assert.equal(freshened.status, 'running');
  assert.equal(freshened.claimed_by, INSTANCE_A);
  assert.equal(freshened.heartbeat_at, refreshedHeartbeat);
  assert.equal(freshened.attempt_count, 1);
  const reclaimed = revisionRowOf('rev-reclaimed-during-reclaim');
  assert.equal(reclaimed.status, 'running');
  assert.equal(reclaimed.claimed_by, INSTANCE_B);
  assert.equal(reclaimed.heartbeat_at, refreshedHeartbeat);
  assert.equal(reclaimed.attempt_count, 1, 'CAS 失败不能错误累加 attempt_count');
});
