import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIENCE_STAGE_LABEL, ENTRY_LABEL, topicCardFields } from '../src/lib/topic-card.js';

const base = {
  id: 'o1',
  projectId: 'p1',
  title: '从报名到拿证的真实记录：一个学员的45天',
  coreQuestion: '',
  summary: '',
  gapIds: [],
  readerStages: [],
  decisionTask: '',
  whyValuable: '',
  answerability: 'verifiable' as const,
  evidenceIds: [],
  unknowns: [],
  boundaries: [],
  suggestedImageAssetIds: [],
  compatibleStrategyIds: [],
};

test('topicCardFields 原样带出推荐理由,不截断(截断交给 CSS)', () => {
  const long = '学车周期长、流程不透明是学员的主要顾虑，真实记录可缓解焦虑并建立合理预期。'.repeat(3);
  const v = topicCardFields({ ...base, rationale: long } as any);
  assert.equal(v.rationale, long);
});

test('topicCardFields 缺 rationale 时回落到 angle,两者都缺则为 null', () => {
  const withAngle = topicCardFields({ ...base, angle: '以学员视角逐步记录' } as any);
  assert.equal(withAngle.rationale, '以学员视角逐步记录');
  const neither = topicCardFields({ ...base } as any);
  assert.equal(neither.rationale, null);
});

test('读者阶段与流入口翻译成中文,未知值回落原文而不是崩', () => {
  const v = topicCardFields({ ...base, audienceStage: 'collecting', entry: 'recommendation' } as any);
  assert.equal(v.stageLabel, AUDIENCE_STAGE_LABEL.collecting);
  assert.equal(v.entryLabel, ENTRY_LABEL.recommendation);

  const odd = topicCardFields({ ...base, audienceStage: 'weird_stage', entry: 'weird_entry' } as any);
  assert.equal(odd.stageLabel, 'weird_stage');
  assert.equal(odd.entryLabel, 'weird_entry');

  const missing = topicCardFields({ ...base } as any);
  assert.equal(missing.stageLabel, null);
  assert.equal(missing.entryLabel, null);
});

test('finalScore 保留三位小数;缺省或 null 时 scoreText 为 null', () => {
  assert.equal(topicCardFields({ ...base, finalScore: 0.658 } as any).scoreText, '0.658');
  assert.equal(topicCardFields({ ...base, finalScore: 0.6 } as any).scoreText, '0.600');
  assert.equal(topicCardFields({ ...base, finalScore: null } as any).scoreText, null);
  assert.equal(topicCardFields({ ...base } as any).scoreText, null);
});

test('rank 转成序位文本;缺省为 null', () => {
  assert.equal(topicCardFields({ ...base, rank: 1 } as any).rankText, '推荐 1');
  assert.equal(topicCardFields({ ...base } as any).rankText, null);
});

test('七项指标只输出非 null 的,顺序稳定', () => {
  const v = topicCardFields({ ...base, relevance: 0.8, decisionLeverage: 0.6, risk: null } as any);
  const keys = v.metrics.map((m) => m.key);
  assert.deepEqual(keys, ['relevance', 'decisionLeverage']);
  assert.equal(v.metrics[0].value, 0.8);
  assert.ok(v.metrics[0].label.length > 0);
  assert.ok(!keys.includes('risk'), 'null 指标不该出现');
});

test('七项全给时输出七项,且按合同固定顺序', () => {
  const v = topicCardFields({
    ...base, relevance: 1, importance: 1, proofability: 1,
    decisionLeverage: 0.8, novelty: 0.3, cognitiveCost: 0.2, risk: 0.1,
  } as any);
  assert.deepEqual(
    v.metrics.map((m) => m.key),
    ['relevance', 'importance', 'proofability', 'decisionLeverage', 'novelty', 'cognitiveCost', 'risk'],
  );
});

// 这条锁的是产品承诺,不是实现细节:后端把这些分标成
// ordinal_noncausal_heuristic(未校准、非因果),UI 必须同屏标注。
// 谁顺手把标注删了,这个用例就会红。
test('uncalibrated 恒为 true:分数必须带未校准标注', () => {
  assert.equal(topicCardFields({ ...base, finalScore: 0.9 } as any).uncalibrated, true);
  assert.equal(topicCardFields({ ...base } as any).uncalibrated, true);
});

// 认知成本与风险方向相反(越低越好)。这不是样式偏好:全按同一方向着色
// 会把「风险 0.9」画成和「相关 0.9」一样的正面信号,把坏消息说成好消息。
test('认知成本与风险标记为 inverse,其余五项不标记', () => {
  const v = topicCardFields({
    ...base, relevance: 1, importance: 1, proofability: 1,
    decisionLeverage: 0.8, novelty: 0.3, cognitiveCost: 0.2, risk: 0.1,
  } as any);
  const inverse = v.metrics.filter((m) => m.inverse).map((m) => m.key);
  assert.deepEqual(inverse, ['cognitiveCost', 'risk']);
  const normal = v.metrics.filter((m) => !m.inverse).map((m) => m.key);
  assert.deepEqual(normal, ['relevance', 'importance', 'proofability', 'decisionLeverage', 'novelty']);
});

test('证据数与边界数如实反映数组长度', () => {
  const v = topicCardFields({ ...base, evidenceIds: ['e1', 'e2'], boundaries: ['b1'] } as any);
  assert.equal(v.evidenceCount, 2);
  assert.equal(v.boundaryCount, 1);
});
