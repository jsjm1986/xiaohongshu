import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGap } from '../src/intelligence.service.js';

/**
 * sourceStatus 的透传。
 *
 * 此前 normalizeGap 回传 14 个字段但不含 sourceStatus,而前端 gapStats /
 * isGapPending 的判据都读它,拿到的恒为 undefined——两处注释声称「与后端
 * pendingGaps 同一判据」,实际不一致。这条测试守住透传。
 */
function row(data: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'g1', title: '缺口', status: 'approved', data_json: JSON.stringify(data), ...overrides };
}

test('normalizeGap 透传 sourceStatus', () => {
  assert.equal(normalizeGap(row({ sourceStatus: 'user_supplied' })).sourceStatus, 'user_supplied');
  assert.equal(normalizeGap(row({ sourceStatus: 'supplied_fact' })).sourceStatus, 'supplied_fact');
});

test('没有 sourceStatus 时回 undefined,不编造默认值', () => {
  // 编造 'unknown' 会让「分析没标」和「分析标了未知」混同
  assert.equal(normalizeGap(row({})).sourceStatus, undefined);
});

test('认不出的取值不透传,避免污染下游联合类型', () => {
  assert.equal(normalizeGap(row({ sourceStatus: 'made_up' })).sourceStatus, undefined);
  assert.equal(normalizeGap(row({ sourceStatus: 123 })).sourceStatus, undefined);
});


test('normalizeGap 只为真实批准的人工答案注入确认元数据', () => {
  const confirmed = normalizeGap(row(
    { answer: '项目负责人确认的多行答案\n第二行', sourceStatus: 'user_supplied' },
    { approved_by: 'owner-1', approved_at: '2026-08-01T10:00:00.000Z' },
  ));
  assert.deepEqual(confirmed.humanConfirmation, {
    confirmedBy: 'owner-1',
    confirmedAt: '2026-08-01T10:00:00.000Z',
  });

  assert.equal(normalizeGap(row({ answer: '只有标签', sourceStatus: 'user_supplied' })).humanConfirmation, undefined);
  assert.equal(normalizeGap(row(
    { answer: '尚未批准', sourceStatus: 'user_supplied' },
    { status: 'draft', approved_by: 'owner-1', approved_at: '2026-08-01T10:00:00.000Z' },
  )).humanConfirmation, undefined);
});
