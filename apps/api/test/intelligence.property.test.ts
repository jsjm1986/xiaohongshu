// Feature: content-methodology-self-consistency, Property 1: 结构有效性与预测表现字段相互独立
//
// Property 1 (Validates: Requirements 1.2):
// 对任意资源（信息缺口 / 选题 / 图片观察）及其任意的预测表现字段改动（置为未知、改为任意合法数值、
// 或删除），该资源的结构有效性字段（选题 eligibility/status、gapIds、依赖快照、审批相关状态）的
// 规范化/持久化取值保持逐字不变；反之，对结构字段的改动也不改变预测字段（度量 / metricStatus /
// unknownMetrics）的输出。
//
// 单一属性测试，含两个方向的断言，覆盖三类资源。被测的是设计 Testing Strategy 中 P1 映射到的纯函数：
// canonicalOpportunityData（选题持久化规范化）、normalizeOpportunity / normalizeGap /
// normalizeImageAnalysis（读取规范化）。运行 numRuns=300（≥100）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  canonicalOpportunityData,
  normalizeGap,
  normalizeImageAnalysis,
  normalizeOpportunity,
} from '../src/intelligence.service.js';

// 预测表现度量字段（预测轴）。
const OPPORTUNITY_METRICS = [
  'relevance',
  'importance',
  'proofability',
  'decisionLeverage',
  'novelty',
  'cognitiveCost',
  'risk',
] as const;
const GAP_METRICS = ['importance', 'decisionLeverage', 'proofability'] as const;
const IMAGE_METRICS = ['clarity', 'relevance', 'textLegibility'] as const;

type AnyRecord = Record<string, unknown>;

// OMIT 表示"删除该字段"（提交时不含该键）。
const OMIT = Symbol('omit');

// 单个度量字段的取值：删除 / 未知（非数值、错误类型、非有限值）/ 任意合法数值（含越界后被规范化）。
const metricCell = fc.oneof(
  fc.constant(OMIT), // 删除：不写入该键
  fc.constant(null), // 未知：非数值
  fc.constant('n/a'), // 未知：错误类型
  fc.constant(Number.NaN), // 未知：非有限
  fc.double({ min: 0, max: 1, noNaN: true }), // 合法数值（区间内）
  fc.double({ min: 1, max: 100, noNaN: true }), // 越界数值（会被规范化为合法值，仍为已知）
);

function metricsArb(fields: readonly string[]) {
  return fc.record(Object.fromEntries(fields.map((field) => [field, metricCell])));
}

function pick(source: AnyRecord, keys: readonly string[]): AnyRecord {
  const result: AnyRecord = {};
  for (const key of keys) result[key] = source[key];
  return result;
}

function withMetrics(base: AnyRecord, fields: readonly string[], cells: AnyRecord): AnyRecord {
  const data: AnyRecord = { ...base };
  for (const field of fields) {
    if (cells[field] !== OMIT) data[field] = cells[field];
  }
  return data;
}

const shortText = fc.string({ maxLength: 30 });
const strArray = fc.array(fc.string({ maxLength: 15 }), { maxLength: 4 });

// —— 结构字段生成器（结构有效性轴，direction 1 中保持不变、direction 2 中被改动）——
const opportunityStructArb = fc.record({
  topic: shortText,
  angle: shortText,
  gapIds: strArray,
  strategyId: shortText,
  audienceStage: fc.constantFrom('collecting', 'comparing', 'ready', 'weird'),
  entry: fc.constantFrom('search', 'recommendation', 'profile', 'weird'),
  evidenceIds: strArray,
  boundaries: strArray,
  tags: strArray,
  imageAssetIds: strArray,
  // 结构有效性：资格状态由用户/分析显式断言（含非法值 -> unknown）。
  status: fc.constantFrom('eligible', 'blocked', 'unknown', 'weird', undefined),
  // 依赖快照相关（结构轴）。
  dependencySnapshot: fc.record({
    gapsRevision: fc.integer({ min: 0, max: 20 }),
    approvedAt: shortText,
  }),
});

const gapStructArb = fc.record({
  label: shortText,
  question: shortText,
  category: fc.constantFrom('decision', 'verification', 'weird'),
  audienceStages: fc.array(fc.constantFrom('collecting', 'comparing', 'ready'), { maxLength: 3 }),
  answer: shortText,
  framework: shortText,
  boundary: shortText,
  evidenceIds: strArray,
  required: fc.boolean(),
  preferredChannels: fc.array(fc.constantFrom('N.body', 'Cref', 'H', 'N.title'), { maxLength: 3 }),
  enabled: fc.boolean(),
  locked: fc.boolean(),
});

const imageStructArb = fc.record({
  observedFacts: strArray,
  inferredSignals: strArray,
  unknowns: strArray,
  visibleText: strArray,
  roles: fc.array(fc.constantFrom('cover', 'evidence', 'other'), { maxLength: 3 }),
  safetyFlags: strArray,
  evidenceIds: strArray,
  source: fc.constantFrom('uploaded', 'knowledge', 'generated_reference', 'weird'),
  altText: shortText,
});

// 固定的图片素材行（结构由 data 承载；素材元数据保持恒定）。
const IMAGE_ASSET = {
  id: 'asset-1',
  filename: 'sample.png',
  media_type: 'image/png',
  width: 100,
  height: 80,
} as const;

// 每个被测函数：如何用（结构字段, 度量单元）构造输入并调用真实实现，以及如何投影出结构 / 预测子集。
interface Normalizer {
  readonly name: string;
  readonly metrics: readonly string[];
  normalize(struct: AnyRecord, cells: AnyRecord): AnyRecord;
  structural(out: AnyRecord): AnyRecord;
  predictive(out: AnyRecord): AnyRecord;
}

function opportunityStructuralProjection(out: AnyRecord): AnyRecord {
  const rankInputSources = (out.rankInputSources ?? {}) as AnyRecord;
  return {
    status: out.status,
    topic: out.topic,
    angle: out.angle,
    gapIds: out.gapIds,
    strategyId: out.strategyId,
    audienceStage: out.audienceStage,
    entry: out.entry,
    evidenceIds: out.evidenceIds,
    boundaries: out.boundaries,
    tags: out.tags,
    imageAssetIds: out.imageAssetIds,
    dependencySnapshot: out.dependencySnapshot,
    // 结构 provenance 不随度量取值变化。
    rankStatusProvenance: rankInputSources.status,
    rankTopicProvenance: rankInputSources.topic,
    rankGapIdsProvenance: rankInputSources.gapIds,
  };
}

// 预测轴：度量、metricStatus、unknownMetrics（不含 score —— score 依设计受资格状态门控）。
function opportunityPredictiveProjection(out: AnyRecord): AnyRecord {
  return {
    metrics: pick(out, OPPORTUNITY_METRICS),
    metricStatus: out.metricStatus,
    unknownMetrics: out.unknownMetrics,
    reviewRequired: out.reviewRequired,
  };
}

const NORMALIZERS: Record<string, Normalizer[]> = {
  opportunity: [
    {
      name: 'canonicalOpportunityData',
      metrics: OPPORTUNITY_METRICS,
      normalize: (struct, cells) =>
        canonicalOpportunityData(withMetrics(struct, OPPORTUNITY_METRICS, cells)),
      structural: opportunityStructuralProjection,
      predictive: opportunityPredictiveProjection,
    },
    {
      name: 'normalizeOpportunity',
      metrics: OPPORTUNITY_METRICS,
      normalize: (struct, cells) =>
        normalizeOpportunity({
          id: 'opp-1',
          title: struct.topic,
          angle: struct.angle,
          data_json: JSON.stringify(withMetrics(struct, OPPORTUNITY_METRICS, cells)),
        }),
      structural: (out) => ({ id: out.id, ...opportunityStructuralProjection(out) }),
      predictive: opportunityPredictiveProjection,
    },
  ],
  gap: [
    {
      name: 'normalizeGap',
      metrics: GAP_METRICS,
      normalize: (struct, cells) =>
        normalizeGap({
          id: 'gap-1',
          title: struct.question,
          data_json: JSON.stringify(withMetrics(struct, GAP_METRICS, cells)),
        }),
      structural: (out) => ({
        id: out.id,
        label: out.label,
        question: out.question,
        category: out.category,
        audienceStages: out.audienceStages,
        answer: out.answer,
        framework: out.framework,
        boundary: out.boundary,
        evidenceIds: out.evidenceIds,
        required: out.required,
        preferredChannels: out.preferredChannels,
        enabled: out.enabled,
        locked: out.locked,
      }),
      predictive: (out) => ({
        importance: out.importance,
        decisionLeverage: out.decisionLeverage,
        proofability: out.proofability,
        metricStatus: out.metricStatus,
        unknownMetrics: out.unknownMetrics,
        reviewRequired: out.reviewRequired,
      }),
    },
  ],
  image: [
    {
      name: 'normalizeImageAnalysis',
      metrics: IMAGE_METRICS,
      normalize: (struct, cells) => {
        const quality: AnyRecord = {};
        for (const field of IMAGE_METRICS) {
          if (cells[field] !== OMIT) quality[field] = cells[field];
        }
        return normalizeImageAnalysis(IMAGE_ASSET as never, {
          id: 'analysis-1',
          observation_json: JSON.stringify({ ...struct, quality }),
        });
      },
      structural: (out) => ({
        assetId: out.assetId,
        sourceAssetId: out.sourceAssetId,
        filename: out.filename,
        mimeType: out.mimeType,
        width: out.width,
        height: out.height,
        altText: out.altText,
        observedFacts: out.observedFacts,
        inferredSignals: out.inferredSignals,
        unknowns: out.unknowns,
        visibleText: out.visibleText,
        roles: out.roles,
        safetyFlags: out.safetyFlags,
        evidenceIds: out.evidenceIds,
        source: out.source,
      }),
      predictive: (out) => ({
        quality: out.quality,
        qualityStatus: out.qualityStatus,
        unknownQualityMetrics: out.unknownQualityMetrics,
        reviewRequired: out.reviewRequired,
      }),
    },
  ],
};

const resourceCaseArb = fc.oneof(
  fc.record({
    kind: fc.constant('opportunity'),
    structBase: opportunityStructArb,
    structAlt: opportunityStructArb,
    metricsA: metricsArb(OPPORTUNITY_METRICS),
    metricsB: metricsArb(OPPORTUNITY_METRICS),
    metricsFixed: metricsArb(OPPORTUNITY_METRICS),
  }),
  fc.record({
    kind: fc.constant('gap'),
    structBase: gapStructArb,
    structAlt: gapStructArb,
    metricsA: metricsArb(GAP_METRICS),
    metricsB: metricsArb(GAP_METRICS),
    metricsFixed: metricsArb(GAP_METRICS),
  }),
  fc.record({
    kind: fc.constant('image'),
    structBase: imageStructArb,
    structAlt: imageStructArb,
    metricsA: metricsArb(IMAGE_METRICS),
    metricsB: metricsArb(IMAGE_METRICS),
    metricsFixed: metricsArb(IMAGE_METRICS),
  }),
);

test('Property 1: structural validity and predicted performance fields are mutually independent', () => {
  fc.assert(
    fc.property(resourceCaseArb, (testCase) => {
      const normalizers = NORMALIZERS[testCase.kind as string]!;
      for (const normalizer of normalizers) {
        // Direction 1：改动预测字段（置未知 / 改合法值 / 删除），结构字段的输出逐字不变。
        const outPredictiveA = normalizer.normalize(testCase.structBase, testCase.metricsA);
        const outPredictiveB = normalizer.normalize(testCase.structBase, testCase.metricsB);
        assert.deepStrictEqual(
          normalizer.structural(outPredictiveA),
          normalizer.structural(outPredictiveB),
          `${normalizer.name}: 预测字段改动不应改变结构字段`,
        );

        // Direction 2：改动结构字段（含 eligibility 在 eligible/blocked/unknown 间切换），预测字段的输出不变。
        const outStructBase = normalizer.normalize(testCase.structBase, testCase.metricsFixed);
        const outStructAlt = normalizer.normalize(testCase.structAlt, testCase.metricsFixed);
        assert.deepStrictEqual(
          normalizer.predictive(outStructBase),
          normalizer.predictive(outStructAlt),
          `${normalizer.name}: 结构字段改动不应改变预测字段`,
        );
      }
    }),
    { numRuns: 300 },
  );
});
