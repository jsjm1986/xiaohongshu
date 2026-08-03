import type { AnalysisTask } from '../types';

/**
 * 「换一批」的前端对账:不把新选题的可见性押在那一个长连接上。
 *
 * 原来的流程只有一条路径——POST /topic-opportunities/refresh 返回后
 * setOpportunities。那个请求要跑几十秒,期间任何中断(切标签被挂起、组件卸载、
 * 网络抖动、代理超时)都会让响应丢掉,而服务端其实**已经把这批选题落库了**。
 * 用户看到的就是:进度条转完什么也没变,手动刷新页面才出现。
 *
 * 所以这里改成以服务端任务表为准。两个后端事实让对账是安全的:
 *
 * 1. `completeTask` 与选题的 INSERT 在**同一个事务**里(intelligence.service
 *    refreshTopicOpportunities)。所以只要任务是 completed,数据一定已提交——
 *    不存在「任务说完成了但列表还没写进去」的中间态。
 * 2. 任务的 source_fingerprint 形如 `<项目指纹>:topic-refresh:<批次 id>`,
 *    所以能把「换一批」和完整项目分析区分开。两者 kind 都是 'project',
 *    只看 kind 会把八轮分析误判成换一批。
 */

/** 换一批任务在 source_fingerprint 里的标记。与后端 refreshTopicOpportunities 对齐。 */
export const TOPIC_REFRESH_MARKER = ':topic-refresh:';

export function isTopicRefreshTask(task: AnalysisTask): boolean {
  return task.kind === 'project' && (task.sourceFingerprint || '').includes(TOPIC_REFRESH_MARKER);
}

/**
 * 本次换一批在服务端的结局。
 *
 * `waiting` 含两种情况:任务还没出现(POST 刚发出),以及任务在跑。两者对前端是
 * 同一件事——继续等,所以不分开。
 */
export type TopicRefreshOutcome =
  | { state: 'waiting' }
  | { state: 'completed'; taskId: string }
  | { state: 'failed'; taskId: string; error: string | null };

/**
 * 对账最多等多久(毫秒)。
 *
 * 请求根本没到服务端时,任务表里永远不会出现这次的行,光等是等不出结果的。没有上限
 * 就会变成一个永远转着的进度条——那正是这次要修掉的那种「界面卡住只能刷新」。
 * 上限到了就把话说清:后台可能没收到,让用户自己决定重试还是刷新看看。
 */
export const TOPIC_REFRESH_RECONCILE_TIMEOUT_MS = 240_000;

/** 对账是否已经等过了头。`startedAt` 与 `now` 都是毫秒时间戳。 */
export function reconcileTimedOut(startedAt: number, now: number): boolean {
  return now - startedAt >= TOPIC_REFRESH_RECONCILE_TIMEOUT_MS;
}

/**
 * 这一批真正新增了几个。
 *
 * 后端返回的是**全量**列表,不是增量。所以「已追加 N 个」不能拿列表长度去说——
 * 那会把历史选题算进去(原先就是这么报的,第二次换一批时数字明显偏大)。
 * 用开工前的 id 快照做差集才是这次新增的条数。
 */
export function appendedCount(
  items: readonly { id: string }[],
  knownOpportunityIds: readonly string[],
): number {
  const known = new Set(knownOpportunityIds);
  return items.reduce((count, item) => (known.has(item.id) ? count : count + 1), 0);
}

/**
 * 判断这一轮轮询能不能收工。
 *
 * `knownTaskIds` 是**发起换一批之前**已经见过的任务 id。只认不在这个集合里的
 * 换一批任务,否则上一次换一批留下的 completed 行会让这次立刻「完成」,进度条
 * 一闪而过、列表还是旧的。用 id 集合而不是时间戳:客户端与服务端时钟不一定同步,
 * 拿本地时间当基线会在时钟偏移时误判。
 */
export function topicRefreshOutcome(
  tasks: readonly AnalysisTask[],
  knownTaskIds: readonly string[],
): TopicRefreshOutcome {
  const known = new Set(knownTaskIds);
  const fresh = tasks
    .filter((task) => isTopicRefreshTask(task) && !known.has(task.id))
    // 同一次换一批只会建一个任务;真出现多个就以最新的为准
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const task = fresh[0];
  if (!task) return { state: 'waiting' };
  if (task.status === 'completed') return { state: 'completed', taskId: task.id };
  if (task.status === 'failed') return { state: 'failed', taskId: task.id, error: task.error };
  return { state: 'waiting' };
}
