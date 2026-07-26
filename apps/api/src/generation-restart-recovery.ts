import type { DatabaseService } from './database.service.js';

/** 同一个任务允许被重启打断并重跑的次数上限。 */
export const RESTART_INTERRUPTION_LIMIT = 3;

interface InterruptedJobRow {
  id: string;
  status: string;
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
 * 重启后恢复被打断的生成任务，返回需要重新入队的 jobId。
 *
 * 旧行为把所有 queued/running 一律置 failed，且内存队列不从库里重建 —— 一次重启
 * 就永久丢掉整条队列（实测一次丢掉 40 个任务）。恢复语义按副作用是否已发生区分：
 *
 *  - `queued`：从未开始执行，重新入队完全无损。
 *  - `running`：已经消耗过模型调用，但 content_packages 只在成功末尾写入，所以库
 *    里不会留半成品；配额在任务创建时已计费，重跑也不会重复计费。因此标回 queued
 *    由队列重新完整执行一遍，比直接作废更符合用户预期。
 *  - 超过 RESTART_INTERRUPTION_LIMIT 次的任务判 failed —— 否则一旦进入"重启→重跑
 *    →又被重启"的循环，会无上限地消耗模型调用。
 *
 * 计数写在 resolution_snapshot_json.restartInterruptions，避免为此加数据库迁移。
 */
export function recoverInterruptedJobs(database: DatabaseService): string[] {
  const rows = database
    .prepare("SELECT id, status, resolution_snapshot_json FROM generation_jobs WHERE status IN ('queued','running')")
    .all() as unknown as InterruptedJobRow[];
  if (!rows.length) return [];

  const now = new Date().toISOString();
  const requeue: string[] = [];
  const failStatement = database.prepare(
    "UPDATE generation_jobs SET status='failed', error=?, updated_at=? WHERE id=?",
  );
  const requeueStatement = database.prepare(
    "UPDATE generation_jobs SET status='queued', progress=0, error=NULL, resolution_snapshot_json=?, updated_at=? WHERE id=?",
  );

  for (const row of rows) {
    const attempts = interruptionCount(row.resolution_snapshot_json);
    // 只有真正跑起来过的任务才算被"打断"一次；纯排队的任务无损，不累加计数。
    const nextAttempts = row.status === 'running' ? attempts + 1 : attempts;
    if (nextAttempts > RESTART_INTERRUPTION_LIMIT) {
      failStatement.run(
        `任务被应用重启多次打断（${nextAttempts - 1} 次），已停止自动重跑，请检查服务稳定性后手动重新生成`,
        now,
        row.id,
      );
      continue;
    }
    requeueStatement.run(withInterruptionCount(row.resolution_snapshot_json, nextAttempts), now, row.id);
    requeue.push(row.id);
  }
  return requeue;
}
