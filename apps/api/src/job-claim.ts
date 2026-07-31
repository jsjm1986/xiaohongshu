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
 *  - claimed_by 记录归属,候选选择与归属写入放在同一条 UPDATE ... RETURNING 中
 *    (SQLite 单写者模型保证两个实例不会同时持有同一行);
 *  - heartbeat_at 区分「实例死了」与「实例在正常跑」,回收只动前者。
 *
 * 计数仍写在 resolution_snapshot_json.restartInterruptions,避免为此加一列。
 */

/**
 * 认领/心跳/回收对哪张表生效。
 *
 * 泛化而不是复制:多实例正确性的判据(单条原子领取、只看心跳不看归属)
 * 只该有一处实现。仓库里 analysis_tasks 已经是第三份独立实现,它能用,并进来属于
 * 无关重构、不在本次范围;这里只让 revision_tasks 接到同一份实现上。
 *
 * attemptColumn 为 null 表示重试计数写在 resolution_snapshot_json.restartInterruptions
 * (generation_jobs 的历史做法,当时为了不加列);revision_tasks 有真列。
 */
export interface ClaimTableSpec {
  table: string;
  /** 重试计数列;null 表示走 resolution_snapshot_json 里的 restartInterruptions */
  attemptColumn: 'attempt_count' | null;
  /** 该表是否有 deleted_at 需要过滤。没有这列时带上过滤会直接 SQL 报错。 */
  softDelete: boolean;
  /** 该表是否有 claimed_at。revision_tasks 没有:claimed_by + heartbeat_at 已够用。 */
  hasClaimedAt: boolean;
  /** 重新入队时一并复位的列(不含 status/claimed_by/heartbeat_at/updated_at) */
  resetColumns: string;
  /** 父任务、项目与工作区仍有效的相关子查询。 */
  parentAlive: string;
}

export const GENERATION_JOBS_SPEC: ClaimTableSpec = {
  table: 'generation_jobs',
  attemptColumn: null,
  softDelete: true,
  hasClaimedAt: true,
  resetColumns: 'progress=0, error=NULL, claimed_at=NULL',
  parentAlive:
    'EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=generation_jobs.project_id AND p.deleted_at IS NULL AND w.deleted_at IS NULL)',
};

export const REVISION_TASKS_SPEC: ClaimTableSpec = {
  table: 'revision_tasks',
  attemptColumn: 'attempt_count',
  softDelete: false,
  hasClaimedAt: false,
  resetColumns: 'progress=0, error=NULL',
  parentAlive:
    'EXISTS (SELECT 1 FROM generation_jobs j JOIN projects p ON p.id=j.project_id JOIN workspaces w ON w.id=p.workspace_id WHERE j.id=revision_tasks.job_id AND j.deleted_at IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL)',
};

function aliveClause(spec: ClaimTableSpec): string {
  const clauses = [
    spec.softDelete ? spec.table + '.deleted_at IS NULL' : '',
    spec.parentAlive,
  ].filter(Boolean);
  return clauses.map((clause) => ' AND ' + clause).join('');
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
 * 候选子查询与归属写入属于同一条写语句。SQLite 取得写锁后基于最新快照选择
 * 最早排队行,并通过 RETURNING 返回实际领到的 id;后执行的实例会继续选择下一行。
 * 外层 status/deleted_at 条件保留为防御性约束,确保只有仍可领取的行会被更新。
 *
 * 领取即置 running:让「被领取」和「在跑」成为同一个原子事实,不留中间态。
 */
export function claimNext(
  database: DatabaseService,
  spec: ClaimTableSpec,
  instanceId: string,
  now: string,
): string | undefined {
  const claimedAtAssign = spec.hasClaimedAt ? 'claimed_at=?, ' : '';
  const params = spec.hasClaimedAt
    ? [instanceId, now, now, now]
    : [instanceId, now, now];
  const claimed = database
    .prepare(
      `UPDATE ${spec.table}
          SET status='running', claimed_by=?, ${claimedAtAssign}heartbeat_at=?, updated_at=?
        WHERE id=(
          SELECT id FROM ${spec.table}
           WHERE status='queued'${aliveClause(spec)}
           ORDER BY created_at, id
           LIMIT 1
        )
          AND status='queued'${aliveClause(spec)}
        RETURNING id`,
    )
    .get(...params) as { id: string } | undefined;
  // 候选选择、状态确认和归属写入处于同一条 SQLite 写语句中。并发实例会按写锁
  // 串行执行,后执行者会直接看到队列里的下一条,不会把一次抢输误报成队列为空。
  return claimed?.id;
}

/**
 * 续约心跳。返回 false 表示本实例已经**不再持有**这个任务(被回收过,或被别的
 * 实例接管),调用方应当中止后续写入——否则两个实例会同时写同一个任务的产出。
 */
export function heartbeatTask(
  database: DatabaseService,
  spec: ClaimTableSpec,
  id: string,
  instanceId: string,
  now: string,
): boolean {
  const result = database
    .prepare(
      `UPDATE ${spec.table} SET heartbeat_at=?, updated_at=?
        WHERE id=? AND status='running' AND claimed_by=?${aliveClause(spec)}`,
    )
    .run(now, now, id, instanceId);
  return result.changes > 0;
}

/** 保留签名以免动 generation.service 的调用点;实现见 claimNext。 */
export function claimNextJob(database: DatabaseService, instanceId: string, now: string): string | undefined {
  return claimNext(database, GENERATION_JOBS_SPEC, instanceId, now);
}

/** 保留签名以免动 generation.service 的调用点;实现见 heartbeatTask。 */
export function heartbeatJob(database: DatabaseService, jobId: string, instanceId: string, now: string): boolean {
  return heartbeatTask(database, GENERATION_JOBS_SPEC, jobId, instanceId, now);
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
 *
 * failMessage 由调用方给而不是在这里拼:generation_jobs 的原文案带
 * 「请检查服务稳定性后手动重新生成」尾巴且已被现有用例断言,在此拼一个通用尾巴
 * 会把它改掉。
 */
export function reclaimStale(
  database: DatabaseService,
  spec: ClaimTableSpec,
  now: string,
  claimTimeoutMs: number,
  failMessage: (attempts: number) => string,
  onFailed?: (id: string) => void,
): ReclaimResult {
  const deadline = new Date(new Date(now).getTime() - claimTimeoutMs).toISOString();
  const attemptSelect = spec.attemptColumn ?? 'resolution_snapshot_json';
  const rows = database
    .prepare(
      `SELECT id, claimed_by, heartbeat_at, ${attemptSelect} AS attempt_source
         FROM ${spec.table}
        WHERE status='running'${aliveClause(spec)}
          AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(deadline) as unknown as {
      id: string;
      claimed_by: string | null;
      heartbeat_at: string | null;
      attempt_source: string | number | null;
    }[];
  const result: ReclaimResult = { requeued: [], failed: [] };
  if (!rows.length) return result;

  database.transaction(() => {
    const claimedAtReset = spec.hasClaimedAt ? ', claimed_at=NULL' : '';
    const ownershipGuard =
      `id=? AND status='running'${aliveClause(spec)}
       AND claimed_by IS ? AND heartbeat_at IS ? AND ${attemptSelect} IS ?
       AND (heartbeat_at IS NULL OR heartbeat_at < ?)`;
    const failStatement = database.prepare(
      `UPDATE ${spec.table}
          SET status='failed', error=?, claimed_by=NULL, heartbeat_at=NULL${claimedAtReset}, updated_at=?
        WHERE ${ownershipGuard}`,
    );
    const requeueStatement = database.prepare(
      spec.attemptColumn
        ? `UPDATE ${spec.table}
              SET status='queued', ${spec.resetColumns}, ${spec.attemptColumn}=?, claimed_by=NULL,
                  heartbeat_at=NULL, updated_at=?
            WHERE ${ownershipGuard}`
        : `UPDATE ${spec.table}
              SET status='queued', ${spec.resetColumns}, claimed_by=NULL, heartbeat_at=NULL,
                  resolution_snapshot_json=?, updated_at=?
            WHERE ${ownershipGuard}`,
    );

    for (const row of rows) {
      const raw = row.attempt_source;
      const previous = spec.attemptColumn
        ? (typeof raw === 'number' ? raw : 0)
        : interruptionCount(String(raw ?? '{}'));
      const attempts = previous + 1;
      const guardParams = [row.id, row.claimed_by, row.heartbeat_at, raw, deadline];
      if (attempts > RESTART_INTERRUPTION_LIMIT) {
        const changed = failStatement.run(failMessage(attempts - 1), now, ...guardParams).changes;
        if (changed === 1) {
          // 修改任务在这里同步结清额度。回调仍处于本次 BEGIN IMMEDIATE 内,任何
          // 退款/记账错误都会连同 failed 状态一起回滚。
          onFailed?.(row.id);
          result.failed.push(row.id);
        }
        continue;
      }
      const changed = requeueStatement.run(
        spec.attemptColumn ? attempts : withInterruptionCount(String(raw ?? '{}'), attempts),
        now,
        ...guardParams,
      ).changes;
      if (changed === 1) result.requeued.push(row.id);
    }
  });
  return result;
}

/** 保留签名以免动 generation.service 的调用点;实现见 reclaimStale。 */
export function reclaimStaleJobs(
  database: DatabaseService,
  now: string,
  claimTimeoutMs: number,
): ReclaimResult {
  return reclaimStale(
    database, GENERATION_JOBS_SPEC, now, claimTimeoutMs,
    (attempts) => `任务被反复打断（${attempts} 次），已停止自动重跑，请检查服务稳定性后手动重新生成`,
  );
}

/** 排队总数。队列在 DB 里,这是全局真值,不再是某个实例的内存视角。 */
export function queuedJobCount(database: DatabaseService): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS value FROM generation_jobs
        WHERE status='queued'${aliveClause(GENERATION_JOBS_SPEC)}`,
    )
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
    .prepare(
      `SELECT created_at FROM generation_jobs
        WHERE id=? AND status='queued'${aliveClause(GENERATION_JOBS_SPEC)}`,
    )
    .get(jobId) as { created_at: string } | undefined;
  if (!self) return undefined;
  const row = database
    .prepare(
      `SELECT COUNT(*) AS value FROM generation_jobs
        WHERE status='queued'${aliveClause(GENERATION_JOBS_SPEC)}
          AND (created_at < ? OR (created_at = ? AND id < ?))`,
    )
    .get(self.created_at, self.created_at, jobId) as { value: number };
  return Number(row.value) + 1;
}
