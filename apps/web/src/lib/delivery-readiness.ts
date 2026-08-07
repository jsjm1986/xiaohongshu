import type { CandidateValidation, CandidateValidationIssue } from '../types';

export type DeliveryReadiness = 'publishable' | 'human_reviewable' | 'blocked';

export function issueOverridePolicy(issue: CandidateValidationIssue): 'not_required' | 'human_reviewable' | 'non_overridable' {
  if (issue.overridePolicy) return issue.overridePolicy;
  if (issue.disposition === 'block' || (!issue.disposition && issue.severity === 'error')) return 'non_overridable';
  if (issue.disposition === 'review') return 'human_reviewable';
  return 'not_required';
}

export function deliveryReadiness(
  validation?: CandidateValidation,
  realization?: { generationMode?: string; deliverability?: string },
): DeliveryReadiness {
  if (realization?.generationMode === 'deterministic_preview' || realization?.deliverability === 'non_deliverable') return 'blocked';
  if (validation?.valid === true || validation?.qualityStatus === 'passed') return 'publishable';
  const issues = validation?.issues ?? [];
  if (validation?.qualityStatus === 'blocked' || issues.some((issue) => issueOverridePolicy(issue) === 'non_overridable')) return 'blocked';
  return issues.some((issue) => issueOverridePolicy(issue) === 'human_reviewable')
    ? 'human_reviewable'
    : 'blocked';
}

export function candidateDeliverable(
  validation: CandidateValidation | undefined,
  manuallyConfirmed: boolean,
  realization?: { generationMode?: string; deliverability?: string },
): boolean {
  const readiness = deliveryReadiness(validation, realization);
  return readiness === 'publishable' || (readiness === 'human_reviewable' && manuallyConfirmed);
}
