// Feature: content-methodology-self-consistency, Property 4: 排序分数不作为门禁依据
//
// Property 4 (Validates: Requirements 1.4, 5.7):
// 对任意选题，改变或移除其机会排序启发式分数（finalScore / baseScore / components，以及同族的
// unboundedBaseScore / recentPenalty），其审批授权与生成门禁的结论（阻断 / 放行，及命中的门禁）
// 保持不变。
//
// 被测入口为设计 "Testing Strategy · 属性→实现位置映射(P4)" 指向的审批/生成门禁路径。选题资格
// 门禁在真实代码中恰由以下两个纯函数承担，二者均只读取结构有效性字段、绝不读取排序分数：
//   - assertOpportunityReviewFields —— 审批授权门禁（selectOpportunity）与生成门禁
//     （prepareGeneration → assertOpportunityReviewFields，intelligence.service.ts）对选题资格的
//     判定同时经由它；仅读取 status。
//   - assertOpportunitySelectable —— 选择/审批门禁；经由 assertOpportunityReviewFields 读 status，
//     再读排序审计的结构字段 effectiveEligibility / reasons（task 5.2 后 ineligible 仅由结构原因触发）。
//
// 说明（忠实性）：更黑盒地经由服务方法驱动会在内部由选题数据"确定性派生"排序分数，无法独立地
// "改变或移除分数"，因而无法真正检验本属性；故直接以两组"仅分数字段不同、其余结构字段逐字相同"的
// 输入驱动真实门禁函数，断言两组门禁结论完全一致。单一属性测试，numRuns=300（≥100）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  assertOpportunityReviewFields,
  assertOpportunitySelectable,
} from '../src/intelligence.service.js';

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

// 机会排序启发式分数（预测轴）。覆盖 null（因未知度量无法打分）、0、区间内、越界与正负极端值；
// 两组分数独立生成以最大化差异，从而尽力暴露"任何读取分数的门禁回归"。
const scoreNumber = fc.oneof(
  fc.constant(null),
  fc.constant(0),
  fc.constant(1),
  fc.double({ min: -1000, max: 1000, noNaN: true }),
);

const componentsArb = fc.array(
  fc.record({
    metric: fc.string({ maxLength: 12 }),
    weight: fc.double({ min: -5, max: 5, noNaN: true }),
    contribution: fc.double({ min: -5, max: 5, noNaN: true }),
  }),
  { maxLength: 6 },
);

// 一组机会排序启发式分数字段（finalScore / baseScore / components 及同族 unboundedBaseScore /
// recentPenalty）。缺省即"移除该分数"由 scoreNumber 的 null 分支覆盖。
const scoreFieldsArb = fc.record({
  finalScore: scoreNumber,
  baseScore: scoreNumber,
  unboundedBaseScore: scoreNumber,
  recentPenalty: scoreNumber,
  components: componentsArb,
});

// 结构字段（门禁实际读取项，两组恒等）。
// status 覆盖 eligible（放行）/ blocked（阻断）/ 非 eligible（阻断）等分支。
const statusArb = fc.constantFrom('eligible', 'blocked', 'unknown', 'rejected', 'draft', undefined);
// effectiveEligibility 覆盖 ineligible（selectable 的结构阻断分支）与其余（放行）。
const effectiveEligibilityArb = fc.constantFrom('eligible', 'ineligible', 'review_required');
const reasonsArb = fc.array(fc.string({ maxLength: 24 }), { maxLength: 4 });

type AnyRecord = Record<string, unknown>;

test('Property 4: opportunity rank heuristic scores are never a gate basis', () => {
  fc.assert(
    fc.property(
      statusArb,
      effectiveEligibilityArb,
      reasonsArb,
      scoreFieldsArb,
      scoreFieldsArb,
      (status, effectiveEligibility, reasons, scoresA, scoresB) => {
        // 两个选题对象：结构字段（status）逐字相同，仅机会排序启发式分数不同。
        // 分数字段直接注入选题对象本身——即便分数泄漏到选题上，门禁也应忽略之。
        const opportunityA: AnyRecord = { id: 'opp', status, score: scoresA.finalScore, ...scoresA };
        const opportunityB: AnyRecord = { id: 'opp', status, score: scoresB.finalScore, ...scoresB };

        // 两个排序审计对象：结构字段（effectiveEligibility / reasons）逐字相同，仅分数字段不同。
        const rankedA: AnyRecord = { effectiveEligibility, reasons, ...scoresA };
        const rankedB: AnyRecord = { effectiveEligibility, reasons, ...scoresB };

        // 审批授权 + 生成门禁对选题资格的判定（assertOpportunityReviewFields）：结论与分数无关。
        assert.deepStrictEqual(
          runGate(() => assertOpportunityReviewFields(opportunityA)),
          runGate(() => assertOpportunityReviewFields(opportunityB)),
          'assertOpportunityReviewFields 的门禁结论不应随排序分数变化',
        );

        // 选择/审批门禁（assertOpportunitySelectable）：结论与分数无关。
        assert.deepStrictEqual(
          runGate(() => assertOpportunitySelectable(opportunityA, rankedA as never)),
          runGate(() => assertOpportunitySelectable(opportunityB, rankedB as never)),
          'assertOpportunitySelectable 的门禁结论不应随排序分数变化',
        );
      },
    ),
    { numRuns: 300 },
  );
});
