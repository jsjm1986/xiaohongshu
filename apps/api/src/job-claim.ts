import type { DatabaseService } from './database.service.js';

/** 同一个任务允许被打断并重跑的次数上限。 */
export const RESTART_INTERRUPTION_LIMIT = 3;

/**
 * 任务的原子领取、心跳续约与孤儿回收。
 *
 * 这里替换了原来的 generation-restart-recovery:它无条件抓全表 queued/running
 * 重置,于是多实例下 B 实例启动会把 A 实例**正在跑**的任务判成「被重启打断」,
 * 计数 +1 并标回 queued 重新入队。后果是同一任务被两个实例并发执行(重复消耗
 * 模型调用),三轮误判后触顶判 failed。实测两个任务就是这么死的,报「被应用重启
 * 多次打断(3 次)」而实际上没有任何一次真正的重启。
 *
 * 修法是让 DB 成为唯一权威:
 *  - claimed_by 记录归属,领取靠单条 UPDATE 的 changes 判定成败(SQLite 单写者
 *    模型保证两个实例不可能都拿到 1);
 *  - heartbeat_at 区分「实例死了」与「实例在正常跑」,回收只动前者。
 *
 * 计数仍写在 resolution_snapshot_json.restartInterruptions,避免为此加一列。
 */

interface ClaimableRow {
  id: string;
  status: string;
  claimed_by: string | null;
  heartbeat_at: string | null;
  resolution_snapshot_json: string;
}

function interruptionCount(raw: string): number {
  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    const value = parsed.restartInterruptions;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function withInterruptionCount(raw: string, count: number): string {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(raw || '{}') as unknown;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  return JSON.stringify({ ...parsed, restartInterruptions: count });
}

/**
 * 领取下一个排队任务,领到则返回它的 id。
 *
 * 子查询挑最早排队的一条,外层 `AND status='queued'` 再确认一次——两者之间存在
 * 竞态窗口,少了这个守卫,两个实例可能都通过子查询选到同一行。加上它之后
 * changes===1 就是「本实例独占领到」的充分证据。
 *
 * 领取即置 running:让「被领取」和「在跑」成为同一个原子事实,不留中间态。
 */
export function claimNextJob(database: DatabaseService, instanceId: string, now: string): string | undefined {
  // 先取候选 id 再按 id 更新,而不是「UPDATE ... WHERE id=(SELECT ...)」后回查:
  // 回查无法可靠区分本实例同一时刻领到的多条(claimed_at 相同),会返回错的 id。
  const candidate = database
    .prepare(
      `SELECT id FROM generation_jobs
        WHERE status='queued' AND deleted_at IS NULL
        ORDER BY created_at, id
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!candidate) return undefined;
  const result = database
    .prepare(
      `UPDATE generation_jobs
          SET status='running', claimed_by=?, claimed_at=?, heartbeat_at=?, updated_at=?
        WHERE id=? AND status='queued'`,
    )
    .run(instanceId, now, now, now, candidate.id);
  // changes===0 说明这一瞬间被别的实例抢先领走了。不重试:调用方在循环里,
  // 下一轮会取到新的候选。
  return result.changes ? candidate.id : undefined;
}

/**
 * 续约心跳。返回 false 表示本实例已经**不再持有**这个任务(被回收过,或被别的
 * 实例接管),调用方应当中止后续写入——否则两个实例会同时写同一个任务的产出。
 */
export function heartbeatJob(database: DatabaseService, jobId: string, instanceId: string, now: string): boolean {
  const result = database
    .prepare('UPDATE generation_jobs SET heartbeat_at=?, updated_at=? WHERE id=? AND claimed_by=?')
    .run(now, now, jobId, instanceId);
  return result.changes > 0;
}

export interface ReclaimResult {
  /** 归还队列、需要重新入队的任务 */
  requeued: string[];
  /** 反复被打断、已超上限判 failed 的任务 */
  failed: string[];
}

/**
 * 回收孤儿任务。只动确实无人负责的,按行内状态分五类:
 *
 *  - `queued`(任何归属):不动。它本来就在等领取,谁都能领。
 *  - `running` + 心跳新鲜:**不动**,不论归属谁。有人在正常跑——这条是修掉误杀
 *    的关键,原实现在这里把别的实例的任务抢走了。
 *  - `running` + 心跳超时:持有它的实例已死,归还队列并计数 +1。
 *  - `running` + 心跳为 NULL:迁移前的存量行,或旧版本进程留下的。当作孤儿接管,
 *    否则升级那一刻在跑的任务会永久卡在 running。
 *
 * 判据只看心跳、不看归属,是因为 instanceId 含 pid 与随机后缀:进程重启后是**新
 * 身份**,所以「归属为本实例」必然意味着本进程真的在跑它。若改按归属放行,定时
 * 回收会把自己正在跑的任务抢回队列。旧进程留下的行心跳必然已经停止更新,靠超时
 * 判据一样能收回来。
 *
 * 超过 RESTART_INTERRUPTION_LIMIT 的判 failed:否则一旦进入「打断→重跑→又被
 * 打断」的循环会无上限烧模型调用。现在计数只在真实中断时累加,不再被其它实例的
 * 启动污染。
 */
export function reclaimStaleJobs(
  database: DatabaseService,
  now: string,
  claimTimeoutMs: number,
): ReclaimResult {
  const deadline = new Date(new Date(now).getTime() - claimTimeoutMs).toISOString();
  const rows = database
    .prepare(
      `SELECT id, status, claimed_by, heartbeat_at, resolution_snapshot_json
         FROM generation_jobs
        WHERE status='running' AND deleted_at IS NULL
          AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(deadline) as unknown as ClaimableRow[];
  const result: ReclaimResult = { requeued: [], failed: [] };
  if (!rows.length) return result;

  const failStatement = database.prepare(
    "UPDATE generation_jobs SET status='failed', error=?, claimed_by=NULL, heartbeat_at=NULL, updated_at=? WHERE id=?",
  );
  const requeueStatement = database.prepare(
    `UPDATE generation_jobs
        SET status='queued', progress=0, error=NULL, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL,
            resolution_snapshot_json=?, updated_at=?
      WHERE id=?`,
  );

  for (const row of rows) {
    const attempts = interruptionCount(row.resolution_snapshot_json) + 1;
    if (attempts > RESTART_INTERRUPTION_LIMIT) {
      failStatement.run(
        `任务被反复打断（${attempts - 1} 次），已停止自动重跑，请检查服务稳定性后手动重新生成`,
        now,
        row.id,
      );
      result.failed.push(row.id);
      continue;
    }
    requeueStatement.run(withInterruptionCount(row.resolution_snapshot_json, attempts), now, row.id);
    result.requeued.push(row.id);
  }
  return result;
}

/** 排队总数。队列在 DB 里,这是全局真值,不再是某个实例的内存视角。 */
export function queuedJobCount(database: DatabaseService): number {
  const row = database
    .prepare("SELECT COUNT(*) AS value FROM generation_jobs WHERE status='queued' AND deleted_at IS NULL")
    .get() as { value: number };
  return Number(row.value);
}

/**
 * 任务在队列里的位次(1 起),不在排队返回 undefined——不是 0 也不是 -1,前端
 * 一律用 `if (pos)` 判存在,0 会被当成「没有位次」。
 *
 * 按 (created_at, id) 排序,与 claimNextJob 的取件顺序一致,所以位次是真实的
 * 「还要等几个」。
 */
export function queuedJobPosition(database: DatabaseService, jobId: string): number | undefined {
  const self = database
    .prepare("SELECT created_at FROM generation_jobs WHERE id=? AND status='queued' AND deleted_at IS NULL")
    .get(jobId) as { created_at: string } | undefined;
  if (!self) return undefined;
  const row = database
    .prepare(
      `SELECT COUNT(*) AS value FROM generation_jobs
        WHERE status='queued' AND deleted_at IS NULL
          AND (created_at < ? OR (created_at = ? AND id < ?))`,
    )
    .get(self.created_at, self.created_at, jobId) as { value: number };
  return Number(row.value) + 1;
}
