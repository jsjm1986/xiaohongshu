import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PIN_FUNCTION_LABEL, deploymentPlanView } from '../src/lib/deployment-plan.js';

const full = {
  postingIdentity: 'publisher',
  ownedFirstComment: true,
  pinPriority: ['verification', 'clarify'],
  sla: '工作日 24h 内答复真实评论；需要个体结论的问题不承诺即时答复',
  liveRouting: [
    { route: '项目事实类问题', condition: '知识库已有已批准口径', action: '由发布账号引用已批准口径答复，并保留适用边界' },
    { route: '个体结论类问题', condition: '需要个人条件或未披露信息才能判断', action: '转专业/人工渠道处理，禁止代填个体结论' },
  ],
  updateTriggers: ['知识库证据变化', '适用边界变化'],
  updatePolicy: ['真实评论中反复出现且当前口径未覆盖的问题进入更新队列'],
  stopRules: ['无法核验时不代填答案', '不得伪装消费者或第三方口碑'],
};

test('摘要给出发布身份、首评与答复时限', () => {
  const v = deploymentPlanView(full as any);
  assert.ok(v);
  assert.equal(v.identityLabel, '发布账号');
  assert.equal(v.ownedFirstComment, true);
  assert.equal(v.sla, full.sla);
});

test('置顶优先级翻译成中文,保持原顺序', () => {
  const v = deploymentPlanView(full as any);
  assert.deepEqual(v!.pinLabels, [PIN_FUNCTION_LABEL.verification, PIN_FUNCTION_LABEL.clarify]);
});

test('未知的置顶枚举回落原文,不显示 undefined', () => {
  const v = deploymentPlanView({ ...full, pinPriority: ['weird_fn'] } as any);
  assert.deepEqual(v!.pinLabels, ['weird_fn']);
});

test('未知的发布身份回落原文', () => {
  const v = deploymentPlanView({ ...full, postingIdentity: 'unknown_role' } as any);
  assert.equal(v!.identityLabel, 'unknown_role');
});

test('分流规则原样带出,条数不变', () => {
  const v = deploymentPlanView(full as any);
  assert.equal(v!.routing.length, 2);
  assert.equal(v!.routing[0].route, '项目事实类问题');
  assert.equal(v!.routing[0].action, full.liveRouting[0].action);
});

test('停止规则与更新触发条件原样带出', () => {
  const v = deploymentPlanView(full as any);
  assert.deepEqual(v!.stopRules, full.stopRules);
  assert.deepEqual(v!.updateTriggers, full.updateTriggers);
});

test('缺字段不崩:只有 postingIdentity 也能出摘要', () => {
  const v = deploymentPlanView({ postingIdentity: 'publisher' } as any);
  assert.ok(v);
  assert.equal(v.identityLabel, '发布账号');
  assert.deepEqual(v.pinLabels, []);
  assert.deepEqual(v.routing, []);
  assert.equal(v.sla, null);
});

test('空对象或缺省返回 null:没有方案就不渲染这一块', () => {
  assert.equal(deploymentPlanView(undefined), null);
  assert.equal(deploymentPlanView(null), null);
  assert.equal(deploymentPlanView({} as any), null);
});

test('hasDetail 标记是否值得给展开区', () => {
  // 只有摘要字段时不必给展开入口,否则点开是空的
  const summaryOnly = deploymentPlanView({ postingIdentity: 'publisher', sla: 'x' } as any);
  assert.equal(summaryOnly!.hasDetail, false);
  const withDetail = deploymentPlanView(full as any);
  assert.equal(withDetail!.hasDetail, true);
});

test('liveRouting 里缺 route/action 的条目被剔除,不显示空行', () => {
  const v = deploymentPlanView({
    ...full,
    liveRouting: [{ route: '', condition: 'c', action: 'a' }, { route: 'r', condition: 'c', action: '' }, full.liveRouting[0]],
  } as any);
  assert.equal(v!.routing.length, 1);
});
