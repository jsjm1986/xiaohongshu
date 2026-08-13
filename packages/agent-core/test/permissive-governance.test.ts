import { describe, expect, it } from 'vitest';
import {
  candidateQualityStatus,
  candidateQualityStatusLabel,
  issueDisposition,
  issueOverridePolicy,
  normalizeContentValidationIssue,
  resolveCandidateQualityStatus,
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

  it('uses persisted qualityStatus first and falls back to valid only for historical payloads', () => {
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: 'needs_review',
      issues: [],
    })).toBe('needs_review');
    expect(resolveCandidateQualityStatus({
      valid: false,
      qualityStatus: 'passed',
      issues: [],
    })).toBe('passed');
    expect(resolveCandidateQualityStatus({ valid: true, issues: [] })).toBe('passed');
    expect(resolveCandidateQualityStatus({ valid: false, issues: [] })).toBe('needs_review');
  });

  it('fails closed for null, unknown or malformed qualityStatus and only missing fields fall back to valid', () => {
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: 'future_status',
      issues: [],
    })).toBe('blocked');
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: '',
      issues: [],
    })).toBe('blocked');
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: null,
      issues: [],
    })).toBe('blocked');
  });

  it('fails closed for persisted blocked and current hard-gate issues', () => {
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: 'blocked',
      issues: [],
    })).toBe('blocked');
    expect(resolveCandidateQualityStatus({
      valid: true,
      qualityStatus: 'passed',
      issues: [issue('title_required')],
    })).toBe('blocked');
    expect(resolveCandidateQualityStatus(undefined)).toBe('blocked');
  });

  it('provides the single human-readable quality status labels used outside the UI', () => {
    expect(candidateQualityStatusLabel('passed')).toBe('校验通过');
    expect(candidateQualityStatusLabel('needs_review')).toBe('建议复核（可复制导出）');
    expect(candidateQualityStatusLabel('blocked')).toBe('硬阻断（不可交付）');
  });
});
