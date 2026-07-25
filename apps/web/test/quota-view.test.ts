import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaAbsenceNote, quotaCell } from '../src/lib/quota-view.js';

const platform = (monthlyQuota: number, quotaUsed: number) => ({
  workspaceId: 'w1',
  providerMode: 'platform' as const,
  monthlyQuota,
  quotaUsed,
  remaining: Math.max(0, monthlyQuota - quotaUsed),
});

const byok = () => ({
  workspaceId: 'w1',
  providerMode: 'byok' as const,
  monthlyQuota: 100,
  quotaUsed: 1,
  remaining: 99,
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

test('余量为 0 用 error 色,并给出 SaaS 用户真能走的那条出路', () => {
  const cell = quotaCell(platform(500, 500));
  assert.ok(cell);
  assert.equal(cell.tone, 'error');
  assert.equal(cell.value, '0');
  // 这里刻意不再沿用后端 403 的原话「请联系管理员增加额度或配置 BYOK」:
  // SaaS 用户既看不到管理员是谁,也没权限配 BYOK(PATCH /api/settings 对他 403),
  // 那句话的两条路他都走不通。必须给可复制的客服联系方式。
  assert.match(cell.note ?? '', /客服微信/);
  assert.equal(/联系管理员|配置 BYOK/.test(cell.note ?? ''), false);
});

test('额度不显示时给出原因,不留一片空白', () => {
  // BYOK:实测最常见的一种,用户看到空白分不清是没配额度还是坏了
  assert.equal(quotaCell(byok()), null);
  assert.match(quotaAbsenceNote(byok()) ?? '', /自有密钥/);
  // 未配额度
  assert.equal(quotaCell(platform(0, 0)), null);
  assert.match(quotaAbsenceNote(platform(0, 0)) ?? '', /尚未配置/);
  // 拉取失败:静默,不拿技术故障打扰用户
  assert.equal(quotaAbsenceNote(null), null);
  assert.equal(quotaAbsenceNote(undefined), null);
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
