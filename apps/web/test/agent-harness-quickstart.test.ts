import assert from 'node:assert/strict';
import test from 'node:test';
import { HARNESS_AUDIENCE_STAGES, HARNESS_INTENTS, resolveHarnessQuickStart } from '../src/lib/agent-harness-quickstart.js';
import { DEFAULT_HARNESS_METHOD_ID, HARNESS_METHOD_PROFILES } from '@content-agent/agent-harness-core/methods';

test('Agent 快速开始默认已有推荐选择，不要求用户填写主题', () => {
  assert.equal(HARNESS_INTENTS.filter((item) => item.recommended).length, 1);
  assert.equal(HARNESS_AUDIENCE_STAGES.length, 5);
  assert.equal(HARNESS_AUDIENCE_STAGES.filter((item) => item.recommended).length, 1);
  assert.equal(HARNESS_METHOD_PROFILES.length, 10);
  const input = resolveHarnessQuickStart({ projectId: 'p1', approvedImageAssetIds: ['a1', 'a2'] });
  assert.equal(input.topicMode, 'agent_discovery');
  assert.equal(input.methodProfileId, DEFAULT_HARNESS_METHOD_ID);
  assert.equal(input.creativeIntent, 'project_value');
  assert.equal(input.audienceStage, 'discovering');
  assert.equal(input.entryPoint, '推荐流中的状态与生活线索');
  assert.equal(input.bodyLength, 'short');
  assert.equal(input.topic, undefined, '自主发现模式不应伪造主题字符串');
  assert.match(input.goal ?? '', /种草成品/u);
  assert.match(input.tone ?? '', /不写说明书/u);
  assert.ok(input.audience);
  assert.ok(input.entryPoint);
  assert.ok(input.tone);
  assert.ok(input.callToAction);
  assert.deepEqual(input.imageAssetIds, ['a1', 'a2']);
});

test('用户只需点选意图和阶段，系统自动换成完整任务设置', () => {
  const input = resolveHarnessQuickStart({ projectId: 'p1', intentId: 'checklist', audienceStageId: 'ready' });
  assert.match(input.goal ?? '', /行动清单/u);
  assert.match(input.audience ?? '', /准备采取下一步/u);
  assert.match(input.callToAction ?? '', /保存清单/u);
});

test('只有明确选择自定义主题时才采用用户输入，并允许关闭自动素材', () => {
  const input = resolveHarnessQuickStart({
    projectId: 'p1', useCustomTopic: true, customTopic: '三天假期前先核验什么',
    approvedImageAssetIds: ['a1'], useApprovedImages: false,
  });
  assert.equal(input.topic, '三天假期前先核验什么');
  assert.equal(input.topicMode, 'user_defined');
  assert.deepEqual(input.imageAssetIds, []);
});


test('选择旧方法会联动阶段、入口与篇幅，用户覆盖仍然优先', () => {
  const automatic = resolveHarnessQuickStart({ projectId: 'p1', methodProfileId: 'real_minimal' });
  assert.equal(automatic.audienceStage, 'collecting');
  assert.equal(automatic.entryPoint, '推荐流中的真实处境切入');
  assert.equal(automatic.bodyLength, 'short');
  const overridden = resolveHarnessQuickStart({
    projectId: 'p1', methodProfileId: 'real_minimal', audienceStageId: 'hesitating',
    overrides: { entryPoint: '用户明确入口', bodyLength: 'long' },
  });
  assert.equal(overridden.audienceStage, 'hesitating');
  assert.match(overridden.audience ?? '', /担心选错/u);
  assert.equal(overridden.entryPoint, '用户明确入口');
  assert.equal(overridden.bodyLength, 'long');
});
