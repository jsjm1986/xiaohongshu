import assert from 'node:assert/strict';
import test from 'node:test';
import { NON_OVERRIDABLE_CONTENT_ISSUE_CODES } from '@content-agent/agent-core/delivery-policy';
import { candidateDeliverable, deliveryReadiness, NON_OVERRIDABLE_DELIVERY_ISSUE_CODES } from '../src/lib/delivery-readiness.js';

// 浏览器端交付门禁与领域层白名单必须同源。这里曾是 29 个 code 的手抄副本,
// agent-core 新增硬门禁 code 时 web 不知道,被阻断内容就会从前端复制出口漏走。
test('web 交付门禁与 agent-core 硬门禁白名单是同一个对象,不是副本', () => {
  assert.equal(NON_OVERRIDABLE_DELIVERY_ISSUE_CODES, NON_OVERRIDABLE_CONTENT_ISSUE_CODES);
  assert.ok(NON_OVERRIDABLE_DELIVERY_ISSUE_CODES.has('restricted_source_content_visible'));
});

test('formal review findings are immediately deliverable and only mechanical gates block', () => {
  const passed = { valid: true, qualityStatus: 'passed' as const, repairAttempts: 0, issues: [] };
  const review = { valid: false, qualityStatus: 'needs_review' as const, repairAttempts: 0, issues: [
    { severity: 'warning' as const, disposition: 'review' as const, overridePolicy: 'human_reviewable' as const, message: 'review' },
  ] };
  const blocked = { valid: false, qualityStatus: 'blocked' as const, repairAttempts: 0, issues: [
    { code: 'title_required', severity: 'error' as const, disposition: 'block' as const, overridePolicy: 'non_overridable' as const, message: 'block' },
  ] };
  assert.equal(deliveryReadiness(passed), 'publishable');
  assert.equal(deliveryReadiness(review), 'publishable');
  assert.equal(deliveryReadiness(blocked), 'blocked');
  assert.equal(candidateDeliverable(review, false), true);
  assert.equal(candidateDeliverable(review, true), true);
  assert.equal(candidateDeliverable(blocked, true), false);
  assert.equal(deliveryReadiness(passed, { generationMode: 'deterministic_preview' }), 'blocked');
  assert.equal(candidateDeliverable(passed, true, { deliverability: 'non_deliverable' }), false);
});
