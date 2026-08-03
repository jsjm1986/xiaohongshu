import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  appendedCount,
  isTopicRefreshTask,
  reconcileTimedOut,
  TOPIC_REFRESH_MARKER,
  TOPIC_REFRESH_RECONCILE_TIMEOUT_MS,
  topicRefreshOutcome,
} from '../src/lib/topic-refresh-sync';
import type { AnalysisTask } from '../src/types';

/*
  「换一批」原来只靠那一个长连接的响应更新列表。响应丢了(切标签、卸载、网络抖动、
  代理超时)服务端其实已经落库,用户却只看到进度条转完没反应,得手动刷新页面。
  这些用例钉住以服务端任务表对账的判据。
*/

const task = (overrides: Partial<AnalysisTask> = {}): AnalysisTask => ({
  id: 't1',
  projectId: 'p1',
  kind: 'project',
  targetId: null,
  status: 'running',
  sourceFingerprint: `fp-abc${TOPIC_REFRESH_MARKER}batch-1`,
  attemptCount: 1,
  resultId: null,
  error: null,
  createdAt: '2026-08-03T10:00:00.000Z',
  updatedAt: '2026-08-03T10:00:00.000Z',
  completedAt: null,
  ...overrides,
});

test('靠 fingerprint 标记区分换一批与完整项目分析', () => {
  /*
    两者 kind 都是 'project'。只看 kind 会把八轮分析误认成换一批,于是分析一完成
    就宣布「新选题已就绪」。
  */
  assert.equal(isTopicRefreshTask(task()), true);
  assert.equal(isTopicRefreshTask(task({ sourceFingerprint: 'fp-abc' })), false);
  assert.equal(isTopicRefreshTask(task({ kind: 'image' })), false);
});

test('任务还没出现时继续等:POST 刚发出,任务行可能还没写进去', () => {
  assert.deepEqual(topicRefreshOutcome([], []), { state: 'waiting' });
});

test('任务在跑时继续等', () => {
  assert.deepEqual(topicRefreshOutcome([task({ status: 'running' })], []), { state: 'waiting' });
});

test('任务完成即可对账:后端在同一事务里落库并完成任务,不存在中间态', () => {
  const outcome = topicRefreshOutcome([task({ status: 'completed' })], []);
  assert.deepEqual(outcome, { state: 'completed', taskId: 't1' });
});

test('任务失败要带上原因,不能只说失败', () => {
  const outcome = topicRefreshOutcome([task({ status: 'failed', error: '模型额度不足' })], []);
  assert.deepEqual(outcome, { state: 'failed', taskId: 't1', error: '模型额度不足' });
});

test('已知任务不算这次的结果:上次换一批的 completed 行不能让这次立刻收工', () => {
  /*
    这是最容易错的一条。不排除历史任务的话,第二次点换一批会在第一轮轮询就判定
    「完成」——进度条一闪而过,列表还是旧的,退回到这次要修的那个体验。
  */
  const old = task({ id: 'old', status: 'completed' });
  assert.deepEqual(topicRefreshOutcome([old], ['old']), { state: 'waiting' });

  const fresh = task({ id: 'new', status: 'completed', createdAt: '2026-08-03T10:05:00.000Z' });
  assert.deepEqual(topicRefreshOutcome([old, fresh], ['old']), { state: 'completed', taskId: 'new' });
});

test('多个新任务时取最新的一个', () => {
  const earlier = task({ id: 'a', status: 'running', createdAt: '2026-08-03T10:00:00.000Z' });
  const later = task({ id: 'b', status: 'completed', createdAt: '2026-08-03T10:09:00.000Z' });
  assert.deepEqual(topicRefreshOutcome([earlier, later], []), { state: 'completed', taskId: 'b' });
});

test('追加条数按 id 差集算,不是列表长度', () => {
  /*
   * 后端返回全量列表。拿长度当「本次追加」会把历史选题算进去——原先的文案
   * 「已追加一批新选题（N 个）」就是这么报的,第二次换一批时数字明显偏大。
   */
  const items = [{ id: 'old-1' }, { id: 'old-2' }, { id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }];
  assert.equal(appendedCount(items, ['old-1', 'old-2']), 3);
  // 快照为空(比如快照请求失败)时退化成全量,宁可多报也不谎报成 0
  assert.equal(appendedCount(items, []), 5);
  assert.equal(appendedCount([], ['old-1']), 0);
});

test('对账有上限:请求没到服务端时不能无限等下去', () => {
  /*
   * 请求根本没发出去时,任务表里永远不会出现这次的行。没有上限的话进度条会一直转,
   * 那就是把「只能刷新页面」换了个样子而已,并没有修掉。
   */
  assert.equal(reconcileTimedOut(1_000, 1_000), false);
  assert.equal(reconcileTimedOut(1_000, 1_000 + TOPIC_REFRESH_RECONCILE_TIMEOUT_MS - 1), false);
  assert.equal(reconcileTimedOut(1_000, 1_000 + TOPIC_REFRESH_RECONCILE_TIMEOUT_MS), true);
});

test('对账上限要够长:换一批本身就要几十秒,不能比它还短', () => {
  // 后端提示「约几十秒」。上限设得太短会在正常生成中途就把用户劝走。
  assert.ok(TOPIC_REFRESH_RECONCILE_TIMEOUT_MS >= 120_000, `上限只有 ${TOPIC_REFRESH_RECONCILE_TIMEOUT_MS}ms,比一次正常生成还短`);
});

test('sourceFingerprint 缺失不崩:老数据没有这一列', () => {
  const legacy = { ...task(), sourceFingerprint: undefined } as unknown as AnalysisTask;
  assert.equal(isTopicRefreshTask(legacy), false);
  assert.deepEqual(topicRefreshOutcome([legacy], []), { state: 'waiting' });
});

test('页面真的接上了对账轮询,不是只有纯函数在测试里绿着', () => {
  /*
   * 这个模块全绿但页面没接上,用户看到的还是原来那个卡住的界面。所以要钉住接线:
   *
   * - refreshing 期间有一条独立的对账 effect(只依赖 refreshing/projectId,
   *   不能跟进度条那条合并——那条只 setLatestTask,不碰列表)
   * - 完成后从 opportunities.list 拉权威列表,而不是继续等那个可能回不来的响应
   * - 连接类错误不当失败:后端很可能已经存好了,只有 ApiError(服务端明确回绝)才报错
   */
  const source = readFileSync(new URL('../src/pages/IntelligentSimpleFlow.tsx', import.meta.url), 'utf8');
  assert.match(source, /topicRefreshOutcome\(tasks, knownTaskIds\.current\)/u, '页面没有调用对账判据');
  assert.match(source, /reconcileTimedOut\(refreshStartedAt\.current/u, '页面没有接上对账超时,会无限转');
  assert.match(source, /api\.opportunities\.list\(requestedProjectId\)/u, '对账完成后没有重新拉列表');
  assert.match(source, /error instanceof ApiError/u, '没有区分服务端回绝与连接中断');
  // 快照必须在 POST 之前取,否则本次任务会被自己当成旧任务而永远等不到
  const snapshotAt = source.indexOf('knownTaskIds.current =');
  const postAt = source.indexOf('api.opportunities.refresh(requestedProjectId');
  assert.ok(snapshotAt > 0 && postAt > 0, '没找到快照或请求的位置');
  assert.ok(snapshotAt < postAt, '任务快照必须在发请求之前取');
});
