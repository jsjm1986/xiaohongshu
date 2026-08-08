import { describe, expect, it } from 'vitest';
import {
  candidateQualityStatus,
  issueDisposition,
  issueOverridePolicy,
  normalizeContentValidationIssue,
  type ContentValidationIssue,
} from '../src/index.js';

const issue = (code: string): ContentValidationIssue => ({
  code, severity: 'error', channel: 'package', message: code,
  repairable: false, disposition: 'block', overridePolicy: 'non_overridable',
});

describe('permissive publication governance', () => {
  it('treats unknown and future rules as review-only despite stale block metadata', () => {
    const normalized = normalizeContentValidationIssue(issue('future_semantic_rule'));
    expect(normalized).toMatchObject({ severity: 'warning', disposition: 'review', overridePolicy: 'human_reviewable' });
    expect(candidateQualityStatus({ valid: false, issues: [normalized] })).toBe('needs_review');
  });

  it('keeps only explicit mechanical allowlist codes non-overridable', () => {
    const normalized = normalizeContentValidationIssue(issue('evidence_quote_not_exact'));
    expect(issueDisposition(normalized)).toBe('block');
    expect(issueOverridePolicy(normalized)).toBe('non_overridable');
    expect(candidateQualityStatus({ issues: [normalized] })).toBe('blocked');
  });
});
