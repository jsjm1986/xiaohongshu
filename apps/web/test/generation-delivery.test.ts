import assert from 'node:assert/strict';
import test from 'node:test';
import { generationDeliveryState } from '../src/lib/generation-delivery';

test('旧 valid=false 不再误杀，只有机械硬门禁或缺失校验拒绝交付', () => {
  assert.deepEqual(generationDeliveryState([
    { validation: { valid: false, issues: [{ code: 'future_semantic_rule', severity: 'error' }] } },
    { validation: { valid: false, issues: [{ code: 'title_required', severity: 'error' }] } },
    {},
  ]), {
    deliverableCount: 1,
    rejectedCount: 2,
    hasCandidates: true,
    allRejected: false,
  });
});

test('正式校验对象即使旧 valid=false 也可展示交付结果', () => {
  const state = generationDeliveryState([
    { validation: { valid: false, issues: [] } },
    { validation: { valid: true, issues: [] } },
  ]);
  assert.equal(state.allRejected, false);
  assert.equal(state.deliverableCount, 2);
  assert.equal(state.rejectedCount, 0);
});

test('没有候选不是全失败，由空状态单独处理', () => {
  assert.equal(generationDeliveryState([]).allRejected, false);
  assert.equal(generationDeliveryState(undefined).hasCandidates, false);
});
