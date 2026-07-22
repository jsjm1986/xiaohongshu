// Feature: content-methodology-self-consistency, Property 5: 前端留空即未知、填值即原样、绝不注入默认
// Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
//
// Property 5: for any "blank subset" of metric fields, the submission payload
// the creation UI builds carries no numeric value for a blank field (it is
// submitted as an unknown metric — gap/opportunity omit the key, image quality
// sends an explicit null), while every field the user explicitly set to a value
// in 0..1 appears in the payload verbatim, never replaced by a default or by
// "unknown".
//
// Implemented as a single fast-check property over the real payload builders
// that api.ts / IntelligentSimpleFlow.tsx use (gapMetricsInput + gapPayload for
// the gap save path, opportunityPayload for the opportunity save, and
// imageQualityPayload for the image-quality save), exercising gap (3 metrics),
// opportunity (7 metrics) and image quality (3 metrics) together.

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type { InformationGap, TopicOpportunity } from "../src/types";
import {
  gapMetricsInput,
  gapPayload,
  imageQualityPayload,
  opportunityPayload,
} from "../src/lib/metric-payload";

const GAP_METRIC_KEYS = ["importance", "decisionLeverage", "proofability"] as const;
const OPPORTUNITY_METRIC_KEYS = [
  "relevance",
  "importance",
  "proofability",
  "novelty",
  "decisionLeverage",
  "cognitiveCost",
  "risk",
] as const;
const IMAGE_QUALITY_KEYS = ["clarity", "relevance", "textLegibility"] as const;

type Assignment = { set: false } | { set: true; value: number };

// A metric the user explicitly entered: a canonical value in 0..1 (0 and 1
// included). -0 is normalized to +0 so strict-equality assertions are stable.
const setValueArb = fc.double({ min: 0, max: 1, noNaN: true }).map((value) => (value === 0 ? 0 : value));

// Each metric field is independently either left blank or set to a 0..1 value,
// so the property ranges over every possible "blank subset".
const assignmentArb: fc.Arbitrary<Assignment> = fc.oneof(
  fc.constant<Assignment>({ set: false }),
  setValueArb.map((value): Assignment => ({ set: true, value })),
);

const assignmentsArb = (keys: readonly string[]): fc.Arbitrary<Record<string, Assignment>> =>
  fc.record(Object.fromEntries(keys.map((key) => [key, assignmentArb] as [string, fc.Arbitrary<Assignment>])));

// Build the editor draft the way the tri-state metric control does: a set metric
// holds its 0..1 number; a blank metric holds the blank sentinel — undefined for
// the gap/opportunity edit state, null for the image-quality draft.
const draftFrom = (
  assignments: Record<string, Assignment>,
  keys: readonly string[],
  blank: undefined | null,
): Record<string, unknown> => {
  const draft: Record<string, unknown> = {};
  for (const key of keys) {
    const assignment = assignments[key];
    draft[key] = assignment.set ? assignment.value : blank;
  }
  return draft;
};

// Gap and opportunity express "unknown" by omitting the key from the submitted
// `data`; a set value must be present and equal to the user's input.
const assertOmittedOrVerbatim = (
  assignments: Record<string, Assignment>,
  keys: readonly string[],
  data: Record<string, unknown>,
  label: string,
): void => {
  for (const key of keys) {
    const assignment = assignments[key];
    if (assignment.set) {
      assert.ok(key in data, `${label}.${key}: an explicitly set metric must be submitted, not dropped`);
      assert.strictEqual(
        data[key],
        assignment.value,
        `${label}.${key}: a user value in 0..1 must pass through verbatim`,
      );
    } else {
      assert.ok(
        !(key in data),
        `${label}.${key}: a blank metric must be submitted as unknown (key omitted), never a default`,
      );
    }
  }
};

test("Property 5: blank metrics submit as unknown, set metrics pass through verbatim, no default injection", () => {
  fc.assert(
    fc.property(
      fc.record({
        gap: assignmentsArb(GAP_METRIC_KEYS),
        opportunity: assignmentsArb(OPPORTUNITY_METRIC_KEYS),
        image: assignmentsArb(IMAGE_QUALITY_KEYS),
      }),
      ({ gap, opportunity, image }) => {
        // Gap: the real saveGap path — gate blank metrics out, then build the body.
        const gapDraft = draftFrom(gap, GAP_METRIC_KEYS, undefined) as Partial<InformationGap>;
        const gapBody = gapPayload(gapMetricsInput(gapDraft));
        assertOmittedOrVerbatim(gap, GAP_METRIC_KEYS, gapBody.data as Record<string, unknown>, "gap");

        // Opportunity: opportunityPayload omits any non-finite (blank) metric.
        const opportunityDraft = draftFrom(opportunity, OPPORTUNITY_METRIC_KEYS, undefined) as Partial<TopicOpportunity>;
        const opportunityBody = opportunityPayload(opportunityDraft);
        assertOmittedOrVerbatim(
          opportunity,
          OPPORTUNITY_METRIC_KEYS,
          opportunityBody.data as Record<string, unknown>,
          "opportunity",
        );

        // Image quality: an unknown metric is submitted as an explicit null (never
        // a default); a user value passes through verbatim.
        const imageDraft = draftFrom(image, IMAGE_QUALITY_KEYS, null);
        const imageBody = imageQualityPayload(imageDraft) as Record<string, unknown>;
        for (const key of IMAGE_QUALITY_KEYS) {
          const assignment = image[key];
          if (assignment.set) {
            assert.strictEqual(
              imageBody[key],
              assignment.value,
              `image.${key}: a user value in 0..1 must pass through verbatim`,
            );
          } else {
            assert.strictEqual(
              imageBody[key],
              null,
              `image.${key}: a blank metric must be submitted as explicit null (unknown), never a default`,
            );
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});
