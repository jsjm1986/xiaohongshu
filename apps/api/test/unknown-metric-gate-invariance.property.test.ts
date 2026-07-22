// Feature: content-methodology-self-consistency, Property 3: 未知度量不改变硬门禁结论
//
// Property 3 (Validates: Requirements 1.3, 1.6, 2.3, 2.4, 2.5, 2.7, 3.9):
// 对任意资源，将其任意一组预测表现度量由已知置为未知（或反之），审批与生成的硬门禁判定结果
// （阻断 / 放行，及命中的门禁集合）保持不变：
//   · 当资源除度量未知外满足全部硬门禁（结构轴 status=eligible 且 effectiveEligibility≠ineligible）时
//     恒被放行（需求 2.3 / 2.4 / 2.7）；
//   · 当资源违反某硬门禁（status=blocked / 非 eligible，或 effectiveEligibility=ineligible）时，
//     附加未知度量不使其获得豁免（需求 3.9）。
//
// 被测入口为设计 "Testing Strategy · 属性→实现位置映射(P3)" 指向的审批 / 生成门禁路径。选题的资格
// 门禁在真实代码中恰由以下两个纯函数承担，二者仅读取结构有效性字段（status / effectiveEligibility /
// reasons），绝不读取任何预测表现度量（relevance / importance / proofability / decisionLeverage /
// novelty / cognitiveCost / risk）或其派生的 metricStatus / unknownMetrics：
//   - assertOpportunityReviewFields —— 审批授权门禁（selectOpportunity）与生成门禁
//     （prepareGeneration → assertOpportunityReviewFields，intelligence.service.ts）；仅读 status。
//   - assertOpportunitySelectable —— 选择 / 审批门禁；经 assertOpportunityReviewFields 读 status，
//     再读排序审计的结构字段 effectiveEligibility / reasons（task 5.2 后 ineligible 仅由结构原因触发）。
//
// 说明（忠实性）：以两组"结构字段逐字相同、仅七项预测表现度量的已知/未知配置不同"的输入驱动真实
// 门禁函数，断言 (1) 两组门禁结论完全一致（阻断布尔 + 命中门禁的原因串）；(2) 结论恰由结构字段决定
// （与度量取值 / 已知 / 未知无关）——从而同时覆盖"满足结构则恒放行"与"违反结构则不因未知度量获得
// 豁免"。未知度量以 null / undefined / 省略键三种真实表示覆盖。单一属性测试，numRuns=300（≥100）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  assertOpportunityReviewFields,
  assertOpportunitySelectable,
} from '../src/intelligence.service.js';

type AnyRecord = Record<string, unknown>;

// 门禁结论：是否阻断 + 命中门禁的原因（错误消息即门禁身份）。放行时 reason 为 null。
interface GateOutcome {
  readonly blocked: boolean;
  readonly reason: string | null;
}

function runGate(invoke: () => void): GateOutcome {
  try {
    invoke();
    return { blocked: false, reason: null };
  } catch (error) {
    return { blocked: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

// 选题的七项预测表现度量（预测轴）。
const OPPORTUNITY_METRICS = [
  'relevance',
  'importance',
  'proofability',
  'decisionLeverage',
  'novelty',
  'cognitiveCost',
  'risk',
] as const;

// 度量单元：已知（落在 [0,1] 的显式数值）或未知（null / undefined / 省略键 三种真实表示）。
type MetricCell =
  | { readonly kind: 'known'; readonly value: number }
  | { readonly kind: 'unknown'; readonly rep: 'null' | 'undefined' | 'omit' };

// 已知输入：落在 [0,1] 的显式数值；规避 -0（避免与后续等值判断产生噪声）。
const knownRatio = fc.double({ min: 0, max: 1, noNaN: true }).map((value) => (Object.is(value, -0) ? 0 : value));

const metricCell: fc.Arbitrary<MetricCell> = fc.oneof(
  knownRatio.map((value): MetricCell => ({ kind: 'known', value })),
  fc
    .constantFrom<'null' | 'undefined' | 'omit'>('null', 'undefined', 'omit')
    .map((rep): MetricCell => ({ kind: 'unknown', rep })),
);

// 一组七项度量的已知 / 未知配置。
const metricsArb = fc.record(
  Object.fromEntries(OPPORTUNITY_METRICS.map((metric) => [metric, metricCell])),
) as fc.Arbitrary<Record<(typeof OPPORTUNITY_METRICS)[number], MetricCell>>;

// 结构字段（门禁实际读取项，两组变体恒等）。
// status 覆盖 eligible（放行）/ blocked（阻断）/ 非 eligible（阻断）等分支。
const statusArb = fc.constantFrom<string | undefined>('eligible', 'blocked', 'unknown', 'rejected', 'draft', undefined);
// effectiveEligibility 覆盖 ineligible（selectable 的结构阻断分支）与其余（放行）。
const effectiveEligibilityArb = fc.constantFrom('eligible', 'ineligible', 'review_required');
const reasonsArb = fc.array(fc.string({ maxLength: 24 }), { maxLength: 4 });

// 由结构字段构造选题：结构字段固定，七项度量按配置置为已知数值或未知（null / undefined / 省略键）。
// 同时铺入随度量变化的预测轴派生描述字段（metricStatus / unknownMetrics / score）——门禁不得读取它们。
function buildOpportunity(status: string | undefined, metrics: Record<string, MetricCell>): AnyRecord {
  const opportunity: AnyRecord = { id: 'opp', topic: 'gate-invariance-topic', gapIds: ['gap-1'], status };
  const unknownMetrics: string[] = [];
  for (const metric of OPPORTUNITY_METRICS) {
    const cell = metrics[metric]!;
    if (cell.kind === 'known') {
      opportunity[metric] = cell.value;
    } else {
      unknownMetrics.push(metric);
      if (cell.rep === 'null') opportunity[metric] = null;
      else if (cell.rep === 'undefined') opportunity[metric] = undefined;
      // 'omit' → 完全不写入该键（留空 = 未知）。
    }
  }
  // 预测轴派生字段（随度量已知/未知而变；未知不造分）。
  opportunity.metricStatus = unknownMetrics.length ? 'unknown' : 'complete';
  opportunity.unknownMetrics = unknownMetrics;
  opportunity.score = unknownMetrics.length ? null : 0.5;
  return opportunity;
}

// 由结构字段构造排序审计对象：门禁只读 effectiveEligibility / reasons（两组恒等），
// 其余预测轴派生字段（unknownMetrics / baseScore / finalScore）随度量变化以最大化差异。
function buildRanked(
  effectiveEligibility: string,
  reasons: readonly string[],
  metrics: Record<string, MetricCell>,
): AnyRecord {
  const unknownMetrics = OPPORTUNITY_METRICS.filter((metric) => metrics[metric]!.kind === 'unknown');
  return {
    effectiveEligibility,
    reasons,
    unknownMetrics,
    baseScore: unknownMetrics.length ? null : 0.5,
    finalScore: unknownMetrics.length ? null : 0.5,
  };
}

test('Property 3: unknown metrics never change hard-gate conclusions', () => {
  fc.assert(
    fc.property(
      statusArb,
      effectiveEligibilityArb,
      reasonsArb,
      metricsArb,
      metricsArb,
      (status, effectiveEligibility, reasons, metricsA, metricsB) => {
        // 两个选题：结构字段（status）逐字相同，仅七项度量的已知/未知配置不同。
        const opportunityA = buildOpportunity(status, metricsA);
        const opportunityB = buildOpportunity(status, metricsB);
        // 两个排序审计：结构字段（effectiveEligibility / reasons）逐字相同，仅度量派生字段不同。
        const rankedA = buildRanked(effectiveEligibility, reasons, metricsA);
        const rankedB = buildRanked(effectiveEligibility, reasons, metricsB);

        const reviewA = runGate(() => assertOpportunityReviewFields(opportunityA));
        const reviewB = runGate(() => assertOpportunityReviewFields(opportunityB));
        const selectableA = runGate(() => assertOpportunitySelectable(opportunityA, rankedA as never));
        const selectableB = runGate(() => assertOpportunitySelectable(opportunityB, rankedB as never));

        // (1) 不变性：仅度量已知/未知不同，门禁结论（阻断 + 命中门禁的原因）逐字一致。
        assert.deepStrictEqual(
          reviewA,
          reviewB,
          'assertOpportunityReviewFields 的门禁结论不应随度量已知/未知变化',
        );
        assert.deepStrictEqual(
          selectableA,
          selectableB,
          'assertOpportunitySelectable 的门禁结论不应随度量已知/未知变化',
        );

        // (2) 结论恰由结构轴决定（与度量取值/已知/未知无关）：
        //   · 满足结构（status=eligible 且 effectiveEligibility≠ineligible）→ 恒放行（需求 2.3/2.4/2.7）；
        //   · 违反结构（非 eligible 或 ineligible）→ 恒阻断，未知度量不使其获得豁免（需求 3.9）。
        const expectedReviewBlocked = status !== 'eligible';
        const expectedSelectableBlocked = status !== 'eligible' || effectiveEligibility === 'ineligible';
        assert.strictEqual(
          reviewA.blocked,
          expectedReviewBlocked,
          '审批门禁结论应仅由结构字段 status 决定，不因未知度量改变',
        );
        assert.strictEqual(
          selectableA.blocked,
          expectedSelectableBlocked,
          '选择门禁结论应仅由结构字段 status / effectiveEligibility 决定，不因未知度量改变',
        );
      },
    ),
    { numRuns: 300 },
  );
});
