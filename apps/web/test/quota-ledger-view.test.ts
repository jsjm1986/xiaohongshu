import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerItemView, ledgerReasonLabel, preLedgerNote } from '../src/lib/quota-ledger-view';

test('reason 已登记的给中文,未登记的降级显示原文而不是消失', () => {
  assert.equal(ledgerReasonLabel('generation_enqueue'), '内容生成');
  assert.equal(ledgerReasonLabel('provider_outage_refund'), '服务中断退回');
  assert.equal(ledgerReasonLabel('future_new_reason'), 'future_new_reason');
});

test('流水行:扣款显示 -N,退回显示 +N 且标记 refund', () => {
  const charge = ledgerItemView({ id: 1, delta: 1, balanceAfter: 3, reason: 'generation_enqueue', entityType: 'generation_job', entityId: 'j1', createdAt: '2026-08-13T10:00:00.000Z' });
  assert.equal(charge.amount, '-1');
  assert.equal(charge.isRefund, false);
  assert.equal(charge.date, '2026-08-13 10:00');

  const refund = ledgerItemView({ id: 2, delta: -1, balanceAfter: 2, reason: 'generation_settle_refund', entityType: 'generation_job', entityId: 'j1', createdAt: '2026-08-13T11:30:00.000Z' });
  assert.equal(refund.amount, '+1');
  assert.equal(refund.isRefund, true);
});

test('流水上线前的历史用量差额必须明说;完全对账时不打扰;倒挂按异常提示', () => {
  // 生产实况:quota_used=3 但流水 0 行(v29 之前的用量)
  assert.match(preLedgerNote(3, 0)!, /3 次发生在用量流水上线（2026-08-13）之前/u);
  assert.equal(preLedgerNote(5, 5), null);
  assert.match(preLedgerNote(1, 4)!, /请联系管理员核对/u);
});
