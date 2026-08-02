import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canExportHarnessRun,
  filterHarnessRuns,
  harnessCompletedResultState,
  harnessFailureGuidance,
  harnessReviewBlocked,
  harnessTaskContract,
  shouldWarnHarnessPolling,
} from '../src/lib/agent-harness-view';
import type { AgentHarnessJob } from '../src/types';

const job = (id: string, status: AgentHarnessJob['status'], topic: string): AgentHarnessJob => ({
  id, projectId: 'p', channel: 'agent_harness', status, progress: 0, topic, goal: '帮助比较', runKind: 'original',
  attemptCount: 0, createdAt: '2025-01-01', updatedAt: '2025-01-01',
});

test('运行筛选同时支持状态和主题/目标关键词', () => {
  const jobs = [job('1', 'running', '恢复安排'), job('2', 'completed', '核验清单'), job('3', 'failed', '项目价值')];
  assert.deepEqual(filterHarnessRuns(jobs, '', 'active').map((item) => item.id), ['1']);
  assert.deepEqual(filterHarnessRuns(jobs, '比较', 'completed').map((item) => item.id), ['2']);
  assert.deepEqual(filterHarnessRuns(jobs, '项目价值', 'all').map((item) => item.id), ['3']);
});

test('冻结任务合同从历史安全投影，不把缺字段显示成 undefined', () => {
  const view = harnessTaskContract({
    topicMode: 'agent_discovery', methodProfileId: 'real_minimal', audienceStage: 'collecting', entryPoint: '推荐流', bodyLength: 'short',
    methodProfile: { label: '真实极简', bodyRole: '正文职责', commentRole: '评论职责', boundaryPolicy: '证据边界' },
    mustInclude: ['核验'], forbidden: ['保证'], imageAssetIds: ['a'],
  });
  assert.equal(view.methodLabel, '真实极简');
  assert.equal(view.bodyLength, '短正文');
  assert.equal(view.audienceStage, '正在收集信息');
  assert.equal(view.imageCount, 1);
  assert.deepEqual(view.forbidden, ['保证']);
  assert.equal(harnessTaskContract({}).boundaryPolicy, '旧运行未记录');
});

test('凭据和额度失败先引导设置，临时与结构失败允许独立重试', () => {
  assert.equal(harnessFailureGuidance('Agent 模型凭据异常').action, 'settings');
  assert.equal(harnessFailureGuidance('额度不足').action, 'settings');
  assert.equal(harnessFailureGuidance('模型输出不完整').action, 'retry');
});

test('连续三次轮询失败才提示，避免瞬时网络抖动打扰用户', () => {
  assert.equal(shouldWarnHarnessPolling(1), false);
  assert.equal(shouldWarnHarnessPolling(2), false);
  assert.equal(shouldWarnHarnessPolling(3), true);
});

test('完成态区分候选缺失、全部阻断和存在可用候选', () => {
  const completed = { ...job('done', 'completed', '结果') };
  assert.equal(harnessCompletedResultState(completed), 'missing_candidates');
  assert.equal(canExportHarnessRun(completed), false, '空数组不能利用 every 的真空真值启用导出');
  const blocked = {
    ...completed,
    candidates: [{ validation: { valid: false, issues: [] } }],
  } as AgentHarnessJob;
  assert.equal(harnessCompletedResultState(blocked), 'all_blocked');
  assert.equal(canExportHarnessRun(blocked), false);
  const mixed = {
    ...completed,
    candidates: [
      { validation: { valid: true, issues: [] } },
      { validation: { valid: false, issues: [] } },
    ],
  } as AgentHarnessJob;
  assert.equal(harnessCompletedResultState(mixed), 'ready');
  assert.equal(canExportHarnessRun(mixed), false, '整次导出仍要求所有候选通过');
});


test('复核阻断只在候选检查点存在时提供原位恢复', () => {
  const blocked = {
    ...job('blocked', 'completed', '复核恢复'),
    reviewStatus: 'blocked' as const,
    candidateCheckpointAt: '2025-01-01T00:00:00.000Z',
    candidates: [{ validation: { valid: false, issues: [] } }],
  } as AgentHarnessJob;
  assert.equal(harnessReviewBlocked(blocked), true);
  assert.equal(harnessReviewBlocked({ ...blocked, candidateCheckpointAt: null }), false);
  assert.equal(harnessReviewBlocked({ ...blocked, reviewStatus: 'completed' }), false);
  assert.equal(canExportHarnessRun(blocked), false);
});
