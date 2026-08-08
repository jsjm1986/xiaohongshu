import type { CandidateValidation, CandidateValidationIssue } from '../types';

export type DeliveryReadiness = 'publishable' | 'human_reviewable' | 'blocked';

/** Keep this browser boundary aligned with agent-core's mechanical hard-gate
 * allowlist. Everything else, including stale `non_overridable` metadata, is a
 * visible review note and never disables a formal model artifact. */
export const NON_OVERRIDABLE_DELIVERY_ISSUE_CODES = new Set([
  'model_not_invoked', 'deterministic_preview_non_deliverable',
  'title_required', 'body_required',
  'restricted_source_content_visible', 'internal_audit_artifact_visible',
  'frontstage_instruction_leak', 'comment_context_meta_leak',
  'comment_source_language_surface_leak', 'comment_plan_language_surface_leak',
  'unknown_evidence', 'evidence_quote_empty', 'evidence_quote_not_exact',
  'evidence_source_unavailable', 'evidence_reference_metadata_missing',
  'evidence_role_cannot_support_fact', 'package_evidence_ledger_mismatch',
  'fact_source_id_mismatch', 'author_fact_reference_invalid',
  'author_fact_confirmation_mismatch', 'author_fact_project_evidence_mixed',
  'unaccountable_answer_identity', 'comment_identity_violation',
  'host_reply_identity_violation', 'host_reply_unconfirmed_author',
  'org_answer_identity_violation', 'comment_answer_identity_mismatch',
  'publisher_narrative_identity_alias', 'reply_identity_plan_drift',
  'reply_display_role_plan_drift',
]);

export function issueOverridePolicy(issue: CandidateValidationIssue): 'not_required' | 'human_reviewable' | 'non_overridable' {
  if (issue.code && NON_OVERRIDABLE_DELIVERY_ISSUE_CODES.has(issue.code)) return 'non_overridable';
  if (issue.disposition === 'advisory' && issue.severity !== 'error') return 'not_required';
  return 'human_reviewable';
}

export function deliveryReadiness(
  validation?: CandidateValidation,
  realization?: { generationMode?: string; deliverability?: string },
): DeliveryReadiness {
  if (realization?.generationMode === 'deterministic_preview' || realization?.deliverability === 'non_deliverable') return 'blocked';
  // Missing validation is a damaged/unfinished payload, not a historical review finding.
  if (!validation) return 'blocked';
  const issues = validation.issues ?? [];
  if (issues.some((issue) => issueOverridePolicy(issue) === 'non_overridable')) return 'blocked';
  // A formal model artifact is immediately deliverable. Review findings remain
  // visible but no longer require an acknowledgement click to unlock output.
  return 'publishable';
}

export function candidateDeliverable(
  validation: CandidateValidation | undefined,
  _manuallyConfirmed: boolean,
  realization?: { generationMode?: string; deliverability?: string },
): boolean {
  return deliveryReadiness(validation, realization) === 'publishable';
}
