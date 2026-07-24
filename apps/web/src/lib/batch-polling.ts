import type { GenerationJob } from "../types";

export interface JobLike {
  id: string;
  status: string;
}

/** 取出仍需轮询的 job id(排队中/生成中),跨批次去重。 */
export function pendingJobIds(jobs: JobLike[]): string[] {
  const ids: string[] = [];
  for (const job of jobs) {
    if (job.status !== "queued" && job.status !== "running") continue;
    if (ids.includes(job.id)) continue;
    ids.push(job.id);
  }
  return ids;
}

/**
 * 把一轮轮询拿到的新 job 合并回「批次 → job 列表」映射。
 * 轮询失败的项以 null 传入并被忽略;若这一轮没有任何有效更新,原对象原样返回
 * (不制造新引用,避免无内容变化的重渲染)。
 */
export function mergeJobUpdates(
  current: Record<string, GenerationJob[]>,
  updates: Array<GenerationJob | null>,
): Record<string, GenerationJob[]> {
  const fresh = new Map<string, GenerationJob>();
  for (const job of updates) {
    if (job?.id) fresh.set(job.id, job);
  }
  if (fresh.size === 0) return current;

  let changed = false;
  const next: Record<string, GenerationJob[]> = {};
  for (const [batchId, jobs] of Object.entries(current)) {
    let listChanged = false;
    const merged = jobs.map((job) => {
      const updated = fresh.get(job.id);
      if (!updated) return job;
      listChanged = true;
      return updated;
    });
    next[batchId] = listChanged ? merged : jobs;
    if (listChanged) changed = true;
  }
  return changed ? next : current;
}
