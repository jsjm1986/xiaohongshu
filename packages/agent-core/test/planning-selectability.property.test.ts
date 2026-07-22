// Feature: content-methodology-self-consistency, Property 7: 候选可选择性在排序下守恒
//
// Validates: Requirements 5.2, 5.3, 5.4
//
// Property 7 — candidate selectability is conserved under ranking:
// For ANY candidate topic-opportunity set (with unknown metrics, extreme
// high/low scores, and arbitrary minProofability/maxRisk threshold configs),
// the *selectable* set produced by the planning engine's ranking/filtering is
// exactly a permutation of the *structurally selectable* opportunities in the
// input — those that are not `blocked`, have a non-empty topic, and reference
// at least one information gap. Ranking may only reorder (and add prompts); it
// must never drop a structurally selectable candidate because of a score, a
// metric value (high / low / missing / unknown), or a policy threshold.
//
// Design mapping: this is design §"Correctness Properties · Property 7" and
// component C (M3). The oracle below (`isStructurallySelectable`) is derived
// independently from requirements 5.3/5.4 + design C1 — it references ONLY
// structural attributes and deliberately ignores every prediction signal, so
// matching it proves selectability does not depend on the advisory heuristic.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { filterTopicOpportunities, rankTopicOpportunities } from "../src/index.js";
import type { PlanningOptions, RankedTopicOpportunity, TopicOpportunity } from "../src/index.js";

/**
 * Independent structural-selectability oracle (design C1, req 5.3/5.4).
 * A candidate is structurally selectable iff it is not blocked, has a
 * non-empty topic, and references at least one gap. It never consults metrics,
 * scores, or thresholds.
 */
const isStructurallySelectable = (opportunity: TopicOpportunity): boolean =>
  opportunity.status !== "blocked"
  && opportunity.topic.trim().length > 0
  && opportunity.gapIds.length > 0;

const sortedTopicIds = (opportunities: TopicOpportunity[]): string[] =>
  opportunities.map((opportunity) => opportunity.id).sort();

const sortedRankedIds = (ranked: RankedTopicOpportunity[]): string[] =>
  ranked.map((entry) => entry.opportunity.id).sort();

// A metric draw spanning the whole prediction space: unknown (omitted / NaN /
// out-of-range, all folded to "unknown"), extreme-but-valid (0 and 1), and
// ordinary in-range values.
const metricArb: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constant(Number.NaN),
  fc.constant(-1),
  fc.constant(2),
  fc.constant(0),
  fc.constant(1),
  fc.double({ min: 0, max: 1, noNaN: true }),
);

// Topics that are non-empty, empty, or whitespace-only (structurally invalid).
const topicArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("方案选择"),
  fc.string({ minLength: 1, maxLength: 10 }),
);

// Gap references, including the empty array (structurally invalid).
const gapIdsArb: fc.Arbitrary<string[]> = fc.array(fc.string({ minLength: 1, maxLength: 5 }), { maxLength: 4 });

const statusArb: fc.Arbitrary<TopicOpportunity["status"]> = fc.constantFrom("eligible", "blocked", "unknown");
const audienceStageArb: fc.Arbitrary<TopicOpportunity["audienceStage"]> = fc.constantFrom(
  "discovering",
  "collecting",
  "comparing",
  "hesitating",
  "ready",
);
const entryArb: fc.Arbitrary<TopicOpportunity["entry"]> = fc.constantFrom(
  "search",
  "recommendation",
  "profile",
  "return_visit",
);

// The deprecated `score` field: include extreme magnitudes to prove it is
// never consulted when deciding selectability.
const scoreArb: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constant(0),
  fc.constant(1),
  fc.constant(1000),
  fc.constant(-1000),
  fc.double({ min: -100, max: 100, noNaN: true }),
);

interface OpportunitySpec {
  topic: string;
  gapIds: string[];
  status: TopicOpportunity["status"];
  audienceStage: TopicOpportunity["audienceStage"];
  entry: TopicOpportunity["entry"];
  relevance: number | undefined;
  importance: number | undefined;
  proofability: number | undefined;
  novelty: number | undefined;
  decisionLeverage: number | undefined;
  cognitiveCost: number | undefined;
  risk: number | undefined;
  score: number | undefined;
}

const opportunitySpecArb: fc.Arbitrary<OpportunitySpec> = fc.record({
  topic: topicArb,
  gapIds: gapIdsArb,
  status: statusArb,
  audienceStage: audienceStageArb,
  entry: entryArb,
  relevance: metricArb,
  importance: metricArb,
  proofability: metricArb,
  novelty: metricArb,
  decisionLeverage: metricArb,
  cognitiveCost: metricArb,
  risk: metricArb,
  score: scoreArb,
});

const buildOpportunity = (spec: OpportunitySpec, index: number): TopicOpportunity => ({
  id: `op-${index}`,
  topic: spec.topic,
  angle: "先核验再比较",
  gapIds: [...spec.gapIds],
  audienceStage: spec.audienceStage,
  entry: spec.entry,
  relevance: spec.relevance,
  importance: spec.importance,
  proofability: spec.proofability,
  novelty: spec.novelty,
  decisionLeverage: spec.decisionLeverage,
  cognitiveCost: spec.cognitiveCost,
  risk: spec.risk,
  evidenceIds: [],
  boundaries: [],
  tags: [],
  imageAssetIds: [],
  status: spec.status,
  score: spec.score,
});

// Ids are assigned by position, so they are unique by construction — that lets
// "equal set of ids" stand in for "is a permutation".
const opportunitiesArb: fc.Arbitrary<TopicOpportunity[]> = fc
  .array(opportunitySpecArb, { maxLength: 8 })
  .map((specs) => specs.map(buildOpportunity));

// Arbitrary advisory thresholds across the whole valid range, plus the
// no-options case.
const thresholdsArb: fc.Arbitrary<PlanningOptions> = fc.record({
  minProofability: fc.double({ min: 0, max: 1, noNaN: true }),
  maxRisk: fc.double({ min: 0, max: 1, noNaN: true }),
});
const optionsArb: fc.Arbitrary<PlanningOptions | undefined> = fc.option(thresholdsArb, { nil: undefined });

describe("Property 7: candidate selectability is conserved under ranking", () => {
  it("keeps the selectable set equal to the structurally-selectable input regardless of scores, metrics, or thresholds", () => {
    fc.assert(
      fc.property(opportunitiesArb, optionsArb, optionsArb, (opportunities, optionsA, optionsB) => {
        const expectedSelectableIds = sortedTopicIds(opportunities.filter(isStructurallySelectable));
        const allIds = sortedTopicIds(opportunities);

        // filterTopicOpportunities is a pure structural filter: its result is
        // exactly the structurally-selectable candidates and is threshold-free.
        const filteredA = filterTopicOpportunities(opportunities, optionsA);
        const filteredB = filterTopicOpportunities(opportunities, optionsB);
        expect(sortedTopicIds(filteredA)).toEqual(expectedSelectableIds);
        expect(filteredA).toHaveLength(expectedSelectableIds.length);
        // req 5.4: swapping the advisory thresholds must not change the set.
        expect(sortedTopicIds(filteredB)).toEqual(expectedSelectableIds);

        // rankTopicOpportunities only reorders: every input must appear exactly
        // once in the output (no candidate is dropped or duplicated).
        const rankedA = rankTopicOpportunities({ opportunities, options: optionsA });
        const rankedB = rankTopicOpportunities({ opportunities, options: optionsB });
        expect(sortedRankedIds(rankedA)).toEqual(allIds);
        expect(sortedRankedIds(rankedB)).toEqual(allIds);

        // The selectable set = every ranked candidate that is not structurally
        // ineligible. A score/metric being high, low, missing, or unknown may
        // move a structural candidate between eligible and review_required, but
        // must never push it out of the selectable set (req 5.2/5.3).
        const selectableA = sortedRankedIds(rankedA.filter((entry) => entry.effectiveEligibility !== "ineligible"));
        const selectableB = sortedRankedIds(rankedB.filter((entry) => entry.effectiveEligibility !== "ineligible"));
        expect(selectableA).toEqual(expectedSelectableIds);
        // req 5.4: different thresholds, identical selectable set.
        expect(selectableB).toEqual(expectedSelectableIds);
      }),
      { numRuns: 300 },
    );
  });
});
