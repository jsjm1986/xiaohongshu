import type { InformationGap, TopicOpportunity } from "../types";

/**
 * Pure submission-payload builders for the creation UI's approval resources.
 *
 * Extracted from api.ts so they can be unit/property tested directly, without
 * loading the browser-only globals api.ts touches at module scope (document,
 * sessionStorage, fetch). Behaviour is unchanged: api.ts and
 * IntelligentSimpleFlow.tsx import these and call them exactly as before.
 *
 * Shared contract (methodology self-consistency, requirement 4): a metric the
 * user leaves blank is submitted as an unknown metric — never a fabricated
 * default (0 / 0.5 / 0.3 / median) — while a user-entered 0..1 value passes
 * through verbatim. Gap and opportunity payloads express "unknown" by omitting
 * the key (the backend reads a missing key as null); the image-quality payload
 * expresses it as an explicit null the backend folds to an unknown metric.
 */

/**
 * Select the gap metrics a save should submit. A metric is forwarded only when
 * it is a real number; a metric left blank (undefined) is dropped so it is
 * submitted as an unknown metric rather than fabricated into a default.
 * Mirrors what saveGap built inline and is reused by it. (Requirements 4.1, 4.2, 4.5)
 */
export const gapMetricsInput = (draft: Partial<InformationGap>): Partial<InformationGap> => {
  const { importance, decisionLeverage, proofability, ...rest } = draft;
  const withMetrics: Partial<InformationGap> = { ...rest };
  if (typeof importance === "number") withMetrics.importance = importance;
  if (typeof decisionLeverage === "number") withMetrics.decisionLeverage = decisionLeverage;
  if (typeof proofability === "number") withMetrics.proofability = proofability;
  return withMetrics;
};

export const gapPayload = (input: Partial<InformationGap>) => ({
  title: input.label || input.question,
  description: input.description,
  priority: input.priority,
  // importance/decisionLeverage/proofability flow through as canonical 0-1 values;
  // the backend optionalRatio accepts them as-is. metricStatus/unknownMetrics/
  // reviewRequired are server-derived and recomputed on write, so they are dropped.
  data: {
    ...input,
    id: undefined,
    projectId: undefined,
    status: undefined,
    approvalStatus: undefined,
    metricStatus: undefined,
    unknownMetrics: undefined,
    reviewRequired: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  },
});

/**
 * Build the PATCH body for a topic opportunity. Only fields the user may edit
 * are sent; the 20 server-derived ranking fields are never transmitted (the
 * server would strip them and sending them would falsely imply they are
 * editable). Metrics are canonical 0..1 here — the UI converts sliders at its
 * own boundary. Any of the seven metrics that is not a finite number is omitted
 * so a blank metric is submitted as an unknown metric, not a default.
 */
export const opportunityPayload = (input: Partial<TopicOpportunity>) => {
  const metric = (value: unknown): number | undefined => {
    const parsed = typeof value === "number" ? value : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const data: Record<string, unknown> = {
    relevance: metric(input.relevance),
    importance: metric(input.importance),
    proofability: metric(input.proofability),
    novelty: metric(input.novelty),
    decisionLeverage: metric(input.decisionLeverage),
    cognitiveCost: metric(input.cognitiveCost),
    risk: metric(input.risk),
    audienceStage: input.audienceStage,
    entry: input.entry,
    gapIds: input.gapIds,
    strategyId: input.strategyId,
    status: input.eligibilityStatus,
    boundaries: input.boundaries,
    tags: (input as { tags?: string[] }).tags,
    imageAssetIds: input.suggestedImageAssetIds,
    evidenceIds: input.evidenceIds,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key];
  }
  return {
    title: input.title,
    angle: input.angle ?? input.projectAngle,
    rationale: input.rationale ?? input.whyValuable,
    data,
  };
};

/**
 * Normalize the image-quality tri-state draft into the PATCH payload. Each of
 * the three quality metrics is sent explicitly: a user-set finite number passes
 * through verbatim, and an unset metric (null / undefined / non-finite) is sent
 * as an explicit null — which the backend folds to an unknown metric — never a
 * default. The image-analysis PATCH merges by key, so unset metrics must be sent
 * (as null), not omitted, to clear a prior value back to unknown.
 * (Requirements 4.1, 4.4, 4.5)
 */
export const imageQualityPayload = (draft: {
  clarity?: number | null;
  relevance?: number | null;
  textLegibility?: number | null;
}): { clarity: number | null; relevance: number | null; textLegibility: number | null } => {
  const metric = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    clarity: metric(draft.clarity),
    relevance: metric(draft.relevance),
    textLegibility: metric(draft.textLegibility),
  };
};
