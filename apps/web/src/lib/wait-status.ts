import type { GenerationJob } from "../types";

/**
 * 等待态文案。
 *
 * 实测线上 55 篇成功生成:单篇平均 891s(约 15 分钟),批量平均 3335s(约 56 分钟),
 * 最长 9798s(2.7 小时)。而 progress 在整个过程里只有 5 个离散值(12/28/44/88/100),
 * queued 阶段恒为 0。也就是说用户面对的是一个几十分钟不动的进度条,既不知道排在
 * 第几,也不知道该等多久,只能猜"是不是卡死了"。
 *
 * 这里把三件事讲清楚:排在第几、已经等了多久、同类任务通常要多久。
 */

/** 单篇任务的经验耗时区间(秒),来自线上完成任务实测。 */
export const SINGLE_ETA_SECONDS: readonly [number, number] = [600, 1800];
/** 批量任务的经验耗时区间(秒):并发上限 2,批量提交时排队占了大头。 */
export const BATCH_ETA_SECONDS: readonly [number, number] = [1800, 5400];

/** 超过这个等待时长就提示"可以关掉页面,任务在后台继续"。 */
export const LONG_WAIT_SECONDS = 900;

export type WaitPhase = "queued" | "running" | "settled";

export interface WaitStatus {
  phase: WaitPhase;
  /** 一句话主状态,如「排队中 · 第 3/24 位」。 */
  headline: string;
  /** 已等待时长,如「已等待 42 分钟」;拿不到 createdAt 时为 undefined。 */
  elapsedLabel?: string;
  /** 经验耗时提示,如「同批量任务通常 30–90 分钟」。 */
  etaLabel: string;
  /** 等待偏长,前端据此提示可以离开页面。 */
  longWait: boolean;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function etaLabel(isBatch: boolean): string {
  const [low, high] = isBatch ? BATCH_ETA_SECONDS : SINGLE_ETA_SECONDS;
  const scope = isBatch ? "批量任务" : "单篇任务";
  return `${scope}通常 ${Math.round(low / 60)}–${Math.round(high / 60)} 分钟`;
}

/**
 * 计算等待态。终态(completed/failed)返回 phase='settled',调用方不该显示等待卡片。
 *
 * now 显式传入而不是内部取 Date.now():等待时长要跟着轮询刷新,组件用同一个
 * tick 驱动多张卡片才不会各自漂移;测试也才能锁死具体文案。
 */
export function waitStatus(job: GenerationJob, now: number = Date.now()): WaitStatus {
  const phase: WaitPhase =
    job.status === "queued" ? "queued" : job.status === "running" ? "running" : "settled";
  const isBatch = Boolean(job.batchId);

  let elapsedSeconds: number | undefined;
  if (job.createdAt) {
    const started = Date.parse(job.createdAt);
    // 无法解析的时间戳当作没有,而不是算出一个 NaN 分钟。
    if (Number.isFinite(started)) elapsedSeconds = Math.max(0, (now - started) / 1000);
  }

  let headline: string;
  if (phase === "queued") {
    // 位次可能缺失:服务重启后队列是内存态,老任务恢复入队前读不到位次。
    headline = job.queuePosition
      ? `排队中 · 第 ${job.queuePosition}${job.queueLength && job.queueLength >= job.queuePosition ? `/${job.queueLength}` : ""} 位`
      : "排队中 · 等待空闲名额";
  } else if (phase === "running") {
    headline = `生成中 · ${job.progress ?? 0}%`;
  } else {
    headline = job.status === "completed" ? "已完成" : "已结束";
  }

  return {
    phase,
    headline,
    elapsedLabel: elapsedSeconds === undefined ? undefined : `已等待 ${formatDuration(elapsedSeconds)}`,
    etaLabel: etaLabel(isBatch),
    longWait: phase !== "settled" && (elapsedSeconds ?? 0) >= LONG_WAIT_SECONDS,
  };
}
