import type { ExpressionStrategy, InformationGap, TopicOpportunity } from "../types";

export interface OpportunityApprovalDependencies {
  missingGapIds: string[];
  unapprovedGaps: InformationGap[];
  missingStrategyIds: string[];
  unapprovedStrategies: ExpressionStrategy[];
}

/** Unknown/partially scored opportunities must be reviewed before any dependency is approved. */
export function opportunityRequiresReview(opportunity: TopicOpportunity | undefined): boolean {
  return Boolean(
    opportunity
    && (
      opportunity.reviewRequired === true
      || opportunity.eligibilityStatus === "unknown"
      || (opportunity.effectiveEligibility !== undefined && opportunity.effectiveEligibility !== "eligible")
      || (opportunity.unknownMetrics?.length ?? 0) > 0
    )
  );
}

/**
 * Resolve only resources explicitly referenced by an opportunity. Compatible
 * strategies are suggestions and must not be approved merely because they are
 * compatible.
 */
export function inspectOpportunityApprovalDependencies(
  opportunity: TopicOpportunity | undefined,
  gaps: InformationGap[],
  strategies: ExpressionStrategy[],
): OpportunityApprovalDependencies {
  if (!opportunity) {
    return { missingGapIds: [], unapprovedGaps: [], missingStrategyIds: [], unapprovedStrategies: [] };
  }

  const referencedGapIds = [...new Set(opportunity.gapIds.filter(Boolean))];
  const gapsById = new Map(gaps.map((gap) => [gap.id, gap]));
  const referencedStrategyIds = opportunity.strategyId ? [opportunity.strategyId] : [];
  const strategiesById = new Map(strategies.map((strategy) => [strategy.id, strategy]));

  return {
    missingGapIds: referencedGapIds.filter((id) => !gapsById.has(id)),
    unapprovedGaps: referencedGapIds
      .map((id) => gapsById.get(id))
      .filter((gap): gap is InformationGap => Boolean(gap && gap.status !== "approved")),
    missingStrategyIds: referencedStrategyIds.filter((id) => !strategiesById.has(id)),
    unapprovedStrategies: referencedStrategyIds
      .map((id) => strategiesById.get(id))
      .filter((strategy): strategy is ExpressionStrategy => Boolean(strategy && strategy.status !== "approved")),
  };
}
