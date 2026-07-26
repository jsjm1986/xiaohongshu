import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  availableEditions,
  canSwitchEdition,
  editionById,
  editionOfPath,
  EDITIONS,
} from '../src/lib/edition.js';

test('两个版本,基础版落 /quick、科研版落 /', () => {
  assert.deepEqual(EDITIONS.map((e) => e.id), ['basic', 'research']);
  assert.equal(editionById('basic').path, '/quick');
  assert.equal(editionById('research').path, '/');
});

test('editionOfPath:/quick 及子路径算基础版', () => {
  assert.equal(editionOfPath('/quick'), 'basic');
  assert.equal(editionOfPath('/quick/'), 'basic');
  assert.equal(editionOfPath('/quick/account'), 'basic');
});

test('editionOfPath:专家壳的一切都算科研版', () => {
  assert.equal(editionOfPath('/'), 'research');
  assert.equal(editionOfPath('/generate'), 'research');
  assert.equal(editionOfPath('/settings'), 'research');
  assert.equal(editionOfPath('/generations/abc'), 'research');
});

// 前缀陷阱:/quickly 不是 /quick 的子路径,不能被当成基础版
test('editionOfPath:前缀相近的路径不算基础版', () => {
  assert.equal(editionOfPath('/quickly'), 'research');
  assert.equal(editionOfPath('/quick-account'), 'research');
  assert.equal(editionOfPath('/quickaccount'), 'research');
});

test('SaaS 用户只有基础版,不露出切换器', () => {
  const user = { userKind: 'saas' as const };
  assert.deepEqual(availableEditions(user).map((e) => e.id), ['basic']);
  assert.equal(canSwitchEdition(user), false);
});

test('科研用户两个版本都能用,露出切换器', () => {
  assert.deepEqual(availableEditions({ userKind: 'research' }).map((e) => e.id), ['basic', 'research']);
  assert.equal(canSwitchEdition({ userKind: 'research' }), true);
});

// 拿不到 userKind 时按科研处理(与 saas-access.fallbackPath 同一取向):
// 把专家误判成 SaaS 会让他们找不到切回完整工作台的入口。
test('缺省 / 无用户时按科研版处理', () => {
  assert.equal(canSwitchEdition({}), true);
  assert.equal(canSwitchEdition(null), true);
  assert.equal(canSwitchEdition(undefined), true);
});

test('editionById 对闭集外的值抛错,而不是静默返回 undefined', () => {
  assert.throws(() => editionById('nope' as never), /未知版本/);
});
