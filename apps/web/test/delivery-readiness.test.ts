import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateDeliverable, deliveryReadiness } from '../src/lib/delivery-readiness.js';

test('delivery readiness permits acknowledgement only for review-only candidates', () => {
  const passed = { valid: true, qualityStatus: 'passed' as const, repairAttempts: 0, issues: [] };
  const review = { valid: false, qualityStatus: 'needs_review' as const, repairAttempts: 0, issues: [
    { severity: 'warning' as const, disposition: 'review' as const, overridePolicy: 'human_reviewable' as const, message: 'review' },
  ] };
  const blocked = { valid: false, qualityStatus: 'blocked' as const, repairAttempts: 0, issues: [
    { severity: 'error' as const, disposition: 'block' as const, overridePolicy: 'non_overridable' as const, message: 'block' },
  ] };
  assert.equal(deliveryReadiness(passed), 'publishable');
  assert.equal(deliveryReadiness(review), 'human_reviewable');
  assert.equal(deliveryReadiness(blocked), 'blocked');
  assert.equal(candidateDeliverable(review, false), false);
  assert.equal(candidateDeliverable(review, true), true);
  assert.equal(candidateDeliverable(blocked, true), false);
  assert.equal(deliveryReadiness(passed, { generationMode: 'deterministic_preview' }), 'blocked');
  assert.equal(candidateDeliverable(passed, true, { deliverability: 'non_deliverable' }), false);
});
