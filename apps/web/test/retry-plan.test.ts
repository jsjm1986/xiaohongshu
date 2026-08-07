import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureDigest, failureReason, planBatchRetry } from '../src/lib/retry-plan.js';

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

test('失效选题的失败任务进入 skipped，不重复消耗额度', () => {
  const stale = [{ id: 'o1', status: 'stale' }] as any[];
  const plan = planBatchRetry([job()], stale, presets);
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0]!.reason, /失效|当前选题池/);
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


test('同选题同预设但发布视角不同不去重', () => {
  const plan = planBatchRetry([
    job({ id: 'consumer', resolvedConfig: { task: { publishingTopology: 'creative_scenario' } } }),
    job({ id: 'institution', resolvedConfig: { task: { publishingTopology: 'institution_owned' } } }),
  ], opps, presets);
  assert.equal(plan.retryable.length, 2);
  assert.deepEqual(plan.retryable.map((item) => item.publishing.publishingTopology).sort(), ['creative_scenario', 'institution_owned']);
  assert.equal(plan.deduped, 0);
});

test('同选题同预设但参数或图片不同不去重', () => {
  const plan = planBatchRetry([
    job({ id: 'beijing', resolvedConfig: { task: { city: '北京' } }, imageContext: [{ assetId: 'a1' }] }),
    job({ id: 'shanghai', resolvedConfig: { task: { city: '上海' } }, imageContext: [{ assetId: 'a2' }] }),
  ], opps, presets);
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

test('后端快失败写入的中文原因要能归类,不掉进「未归类」', () => {
  // 这三句是 apps/api 的 provider-outage.ts 写进 job.error 的原文。
  // 其中后两句不含 balance 字样,若没有专门的中文规则会显示成一长串原文。
  const d = failureDigest([
    job({ id: 'a', error: '模型账户余额不足，本项目排队中的任务已停止，充值后可在产出区批量重试' }),
    job({ id: 'b', error: '模型服务暂无可用账号，本项目排队中的任务已停止，稍后可在产出区批量重试' }),
    job({ id: 'c', error: '模型服务的凭据全部在冷却中，本项目排队中的任务已停止，稍后可在产出区批量重试' }),
  ]);
  assert.equal(d.groups.length, 3);
  for (const g of d.groups) {
    assert.equal(g.label.startsWith('未归类'), false, `应归类:${g.label}`);
  }
  // 余额不足是阻塞的(重试必然再失败);无可用账号/冷却是暂时的,重试可能成功
  const byLabel = new Map(d.groups.map((g) => [g.label, g]));
  assert.equal(byLabel.get('模型账户余额不足，充值后再重试')?.blocking, true);
  assert.equal(byLabel.get('模型服务暂无可用账号，稍后重试')?.blocking, false);
  assert.equal(byLabel.get('模型服务凭据冷却中，稍后重试')?.blocking, false);
  assert.equal(d.blockingCount, 1);
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

/*
 * failureReason:单条失败行的可读原因。
 *
 * 实测缺口——批次摘要显示的是归类好的中文,而单条失败行直接摊出原文:
 * 「生成失败：模型候选 1 生成失败,任务已停止且未生成可发布降级稿：Model provider
 * rejected the request: Insufficient Balance」。付费用户读不出该怎么办。
 */
test('failureReason:余额不足归类为阻塞,重试不该开放', () => {
  const r = failureReason('模型候选 1 生成失败，任务已停止：Model provider rejected the request: Insufficient Balance');
  assert.equal(r.label, '模型账户余额不足，充值后再重试');
  assert.equal(r.blocking, true);
});

test('failureReason:可重试类不阻塞', () => {
  assert.equal(failureReason('应用重启导致任务中断，请重新生成').blocking, false);
  assert.equal(failureReason('Model provider rejected the request: unexpected EOF').blocking, false);
  assert.match(failureReason('Model output did not contain a complete JSON object.').label, /重试通常可恢复/);
});

test('failureReason:密钥失效阻塞,不让用户白烧额度', () => {
  const r = failureReason('Model provider rejected the request: invalid_api_key');
  assert.equal(r.blocking, true);
});

// 归不了类时保留原文:排查与报障全靠它,不能吞掉
test('failureReason:归不了类时原文照出,不显示空白', () => {
  const r = failureReason('something nobody classified yet');
  assert.equal(r.label, 'something nobody classified yet');
  assert.equal(r.blocking, false);
});

test('failureReason:没有错误信息时给兜底文案', () => {
  assert.equal(failureReason(undefined).label, '未记录失败原因');
  assert.equal(failureReason('').label, '未记录失败原因');
  assert.equal(failureReason('   ').label, '未记录失败原因');
});

// raw 与 label 相同时界面不该再折一层「技术细节」
test('failureReason:raw 始终是 trim 过的原文', () => {
  assert.equal(failureReason('  boom  ').raw, 'boom');
  assert.equal(failureReason('  boom  ').label, 'boom');
});
