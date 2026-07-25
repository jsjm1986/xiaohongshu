import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaCell } from '../src/lib/quota-view.js';

const platform = (monthlyQuota: number, quotaUsed: number) => ({
  workspaceId: 'w1',
  providerMode: 'platform' as const,
  monthlyQuota,
  quotaUsed,
  remaining: Math.max(0, monthlyQuota - quotaUsed),
});

test('余量充足(>20%)用 ok 色', () => {
  const cell = quotaCell(platform(500, 138));
  assert.ok(cell);
  assert.equal(cell.tone, 'ok');
  assert.equal(cell.value, '362');
  assert.equal(cell.unit, '/ 500 次');
});

test('余量偏低(<=20%)用 warn 色并提示', () => {
  const cell = quotaCell(platform(500, 400));
  assert.ok(cell);
  assert.equal(cell.tone, 'warn');
  assert.equal(cell.value, '100');
  assert.match(cell.note ?? '', /不多/);
});

test('恰好 20% 归入偏低档(边界含等于)', () => {
  assert.equal(quotaCell(platform(100, 80))?.tone, 'warn');
  assert.equal(quotaCell(platform(100, 79))?.tone, 'ok');
});

test('余量为 0 用 error 色,提示与后端 403 说法一致', () => {
  const cell = quotaCell(platform(500, 500));
  assert.ok(cell);
  assert.equal(cell.tone, 'error');
  assert.equal(cell.value, '0');
  // 后端文案:「平台测试额度已用完,请联系管理员增加额度或配置 BYOK」
  assert.match(cell.note ?? '', /管理员|自有密钥/);
});

test('BYOK 不显示额度格:配额字段对自有密钥没有意义', () => {
  assert.equal(quotaCell({ workspaceId: 'w1', providerMode: 'byok', monthlyQuota: 100, quotaUsed: 1, remaining: 99 }), null);
});

test('拉取失败(null)不显示额度格,不阻塞总览其余读数', () => {
  assert.equal(quotaCell(null), null);
});

test('monthlyQuota 为 0 不做除零,视为额度未配置而不显示', () => {
  assert.equal(quotaCell(platform(0, 0)), null);
});

test('quotaUsed 超出配额时显示 0 而非负数', () => {
  const cell = quotaCell({ workspaceId: 'w1', providerMode: 'platform', monthlyQuota: 5, quotaUsed: 13, remaining: 0 });
  assert.ok(cell);
  assert.equal(cell.value, '0');
  assert.equal(cell.tone, 'error');
});
