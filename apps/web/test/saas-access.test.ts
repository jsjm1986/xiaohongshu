import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSaasUser, saasPageAllowed } from '../src/lib/saas-access.js';

test('isSaasUser:userKind === "saas" 返回 true', () => {
  assert.equal(isSaasUser({ userKind: 'saas' }), true);
});

test('isSaasUser:research / 缺省 / null / undefined 返回 false', () => {
  assert.equal(isSaasUser({ userKind: 'research' }), false);
  assert.equal(isSaasUser({}), false);
  assert.equal(isSaasUser(null), false);
  assert.equal(isSaasUser(undefined), false);
});

test('saasPageAllowed:/quick 与 /settings 及其子路径放行', () => {
  assert.equal(saasPageAllowed('/quick'), true);
  assert.equal(saasPageAllowed('/quick/'), true);
  assert.equal(saasPageAllowed('/quick/abc'), true);
  assert.equal(saasPageAllowed('/settings'), true);
  assert.equal(saasPageAllowed('/settings/x'), true);
});

test('saasPageAllowed:其余路径(含前缀陷阱)一律拦截', () => {
  assert.equal(saasPageAllowed('/'), false);
  assert.equal(saasPageAllowed('/generate'), false);
  assert.equal(saasPageAllowed('/projects'), false);
  assert.equal(saasPageAllowed('/research'), false);
  assert.equal(saasPageAllowed('/team'), false);
  assert.equal(saasPageAllowed('/quickly'), false);
  assert.equal(saasPageAllowed('/settingsx'), false);
});
