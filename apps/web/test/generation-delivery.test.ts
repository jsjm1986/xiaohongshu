import assert from 'node:assert/strict';
import test from 'node:test';
import { generationDeliveryState } from '../src/lib/generation-delivery';

test('全候选失败时进入纯诊断态', () => {
  assert.deepEqual(generationDeliveryState([
    { validation: { valid: false, issues: [{ severity: 'error' }] } },
    { validation: { valid: false, issues: [{ severity: 'warning' }] } },
    {},
  ]), {
    deliverableCount: 0,
    rejectedCount: 3,
    hasCandidates: true,
    allRejected: true,
  });
});

test('至少一个服务端明确通过时仍可展示交付结果', () => {
  const state = generationDeliveryState([
    { validation: { valid: false } },
    { validation: { valid: true } },
  ]);
  assert.equal(state.allRejected, false);
  assert.equal(state.deliverableCount, 1);
  assert.equal(state.rejectedCount, 1);
});

test('没有候选不是全失败，由空状态单独处理', () => {
  assert.equal(generationDeliveryState([]).allRejected, false);
  assert.equal(generationDeliveryState(undefined).hasCandidates, false);
});
