import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureDigest, planBatchRetry } from '../src/lib/retry-plan.js';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  projectId: 'p1',
  topic: '选题A',
  mode: 'simple',
  status: 'failed',
  opportunitySnapshot: { id: 'o1' },
  presetId: 'pre1',
  ...over,
}) as any;

const opps = [{ id: 'o1' }, { id: 'o2' }] as any[];
const presets = [{ id: 'pre1', isDefault: true }, { id: 'pre2' }] as any[];

test('把多个失败任务规划成一次提交:可重试的进 retryable', () => {
  const plan = planBatchRetry(
    [job({ id: 'j1' }), job({ id: 'j2', opportunitySnapshot: { id: 'o2' } })],
    opps, presets,
  );
  assert.equal(plan.retryable.length, 2);
  assert.equal(plan.skipped.length, 0);
  assert.deepEqual(plan.retryable.map((r) => r.opportunityId).sort(), ['o1', 'o2']);
});

test('选题已不在池里的任务进 skipped 并带原因,不静默丢弃', () => {
  // 实测库里就有这种孤儿任务(70 条失败里 1 条),不能悄悄少重试一个
  const plan = planBatchRetry([job({ id: 'j9', opportunitySnapshot: { id: 'gone' } })], opps, presets);
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].jobId, 'j9');
  assert.match(plan.skipped[0].reason, /选题/);
});

test('同一选题+同一预设的重复失败去重,只重试一次', () => {
  // 批量里同一配方失败多次很常见(实测三个批次是同一组 10 篇),
  // 不去重会把额度花在完全相同的任务上
  const plan = planBatchRetry(
    [job({ id: 'j1' }), job({ id: 'j2' }), job({ id: 'j3' })],
    opps, presets,
  );
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.deduped, 2);
});

test('选题相同但预设不同不算重复', () => {
  const plan = planBatchRetry(
    [job({ id: 'j1', presetId: 'pre1' }), job({ id: 'j2', presetId: 'pre2' })],
    opps, presets,
  );
  assert.equal(plan.retryable.length, 2);
  assert.equal(plan.deduped, 0);
});

test('预设已删除时回落到默认预设,并计入 warnings', () => {
  const plan = planBatchRetry([job({ presetId: 'gone' })], opps, presets);
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.retryable[0].presetId, 'pre1');
  assert.ok(plan.warnings.length > 0);
});

test('空输入给空计划,不抛', () => {
  const plan = planBatchRetry([], opps, presets);
  assert.deepEqual(plan.retryable, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.deduped, 0);
});

test('只规划失败任务:已完成或进行中的传进来也不重试', () => {
  const plan = planBatchRetry(
    [job({ id: 'ok', status: 'completed' }), job({ id: 'run', status: 'running' }), job({ id: 'bad', status: 'failed' })],
    opps, presets,
  );
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.retryable[0].jobIds[0], 'bad');
});

// ---- 失败汇总 ----

test('failureDigest 按错误类型归并,给出可读原因与条数', () => {
  const d = failureDigest([
    job({ id: 'a', error: '模型候选 1 生成失败：Model provider rejected the request: Insufficient Balance' }),
    job({ id: 'b', error: '模型候选 1 生成失败：Model provider rejected the request: Insufficient Balance' }),
    job({ id: 'c', error: '模型候选 2 生成失败：Model provider rejected the request: unexpected EOF' }),
  ]);
  assert.equal(d.total, 3);
  assert.equal(d.groups[0].count, 2);
  assert.match(d.groups[0].label, /余额|额度/);
  assert.equal(d.groups[1].count, 1);
});

test('failureDigest 按条数倒序,最主要的原因排最前', () => {
  const d = failureDigest([
    job({ id: 'a', error: 'Model output did not contain a complete JSON object.' }),
    job({ id: 'b', error: 'Model provider rejected the request: Insufficient Balance' }),
    job({ id: 'c', error: 'Model provider rejected the request: Insufficient Balance' }),
  ]);
  assert.equal(d.groups[0].count, 2);
});

// blockingCount 决定界面是否劝阻「一键重试全部」:实测 21 条失败里 10 条是余额不足,
// 全量重试会再失败一遍,每篇还各扣 1 次额度。
test('blockingCount 统计重试也无用的任务数', () => {
  const d = failureDigest([
    job({ error: 'Insufficient Balance' }),
    job({ error: 'Insufficient Balance' }),
    job({ error: '应用重启导致任务中断，请重新生成' }),
  ]);
  assert.equal(d.blockingCount, 2);
});

test('全部可重试时 blockingCount 为 0', () => {
  const d = failureDigest([job({ error: '应用重启导致任务中断，请重新生成' })]);
  assert.equal(d.blockingCount, 0);
});

test('服务重启中断单独归类,且不标记为 blocking(重试可恢复)', () => {
  // 后端 generation.service.ts:216 在启动时写这句;实测是最主要的失败原因,
  // 漏了它会退化成「未归类：应用重启导致任务中断…」一串原文。
  const d = failureDigest([job({ error: '应用重启导致任务中断，请重新生成' })]);
  assert.equal(d.groups.length, 1);
  assert.equal(d.groups[0].blocking, false);
  assert.doesNotMatch(d.groups[0].label, /未归类/);
});

test('failureDigest 无法归类的错误保留原文摘要,不丢信息', () => {
  const d = failureDigest([job({ id: 'x', error: '某个没见过的错误 zzz' })]);
  assert.equal(d.groups.length, 1);
  assert.match(d.groups[0].label, /某个没见过的错误|未归类/);
});

test('failureDigest 空错误与空列表都不崩', () => {
  assert.equal(failureDigest([]).total, 0);
  const d = failureDigest([job({ error: undefined })]);
  assert.equal(d.total, 1);
  assert.equal(d.groups.length, 1);
});
