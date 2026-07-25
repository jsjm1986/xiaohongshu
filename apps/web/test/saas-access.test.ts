import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbackPath, isSaasUser, loginLandingPath, passwordChangePath, saasPageAllowed } from '../src/lib/saas-access.js';

test('isSaasUser:userKind === "saas" 返回 true', () => {
  assert.equal(isSaasUser({ userKind: 'saas' }), true);
});

test('isSaasUser:research / 缺省 / null / undefined 返回 false', () => {
  assert.equal(isSaasUser({ userKind: 'research' }), false);
  assert.equal(isSaasUser({}), false);
  assert.equal(isSaasUser(null), false);
  assert.equal(isSaasUser(undefined), false);
});

test('saasPageAllowed:只放行 /quick 及其子路径', () => {
  assert.equal(saasPageAllowed('/quick'), true);
  assert.equal(saasPageAllowed('/quick/'), true);
  assert.equal(saasPageAllowed('/quick/abc'), true);
  assert.equal(saasPageAllowed('/quick/account'), true);
});

// 行为反转,专门锁死:/settings 曾在白名单里,导致 SaaS 用户被强制改密时
// 落进专家版壳(带整条 9 个入口的侧边栏)。它现在必须是 false。
test('saasPageAllowed:/settings 不再放行——那是专家壳的页面', () => {
  assert.equal(saasPageAllowed('/settings'), false);
  assert.equal(saasPageAllowed('/settings/x'), false);
});

test('saasPageAllowed:其余路径(含前缀陷阱)一律拦截', () => {
  assert.equal(saasPageAllowed('/'), false);
  assert.equal(saasPageAllowed('/generate'), false);
  assert.equal(saasPageAllowed('/projects'), false);
  assert.equal(saasPageAllowed('/research'), false);
  assert.equal(saasPageAllowed('/team'), false);
  assert.equal(saasPageAllowed('/quickly'), false);
  assert.equal(saasPageAllowed('/quick-account'), false);
  assert.equal(saasPageAllowed('/quickaccount'), false);
  assert.equal(saasPageAllowed('/settingsx'), false);
});

test('loginLandingPath:SaaS 去极简创作,专家去工作台首页', () => {
  assert.equal(loginLandingPath({ userKind: 'saas' }), '/quick');
  assert.equal(loginLandingPath({ userKind: 'research' }), '/');
  assert.equal(loginLandingPath({}), '/');
});

test('loginLandingPath:强制改密时 SaaS 去 /quick/account,不去专家 /settings', () => {
  // 这正是实测缺陷所在:改前所有 SaaS 用户首次登录都落进专家壳
  assert.equal(loginLandingPath({ userKind: 'saas', mustChangePassword: true }), '/quick/account');
  assert.equal(loginLandingPath({ userKind: 'research', mustChangePassword: true }), '/settings');
});

test('loginLandingPath:没有用户时去登录页', () => {
  assert.equal(loginLandingPath(null), '/login');
  assert.equal(loginLandingPath(undefined), '/login');
});

test('passwordChangePath / fallbackPath 按用户类型分叉', () => {
  assert.equal(passwordChangePath({ userKind: 'saas' }), '/quick/account');
  assert.equal(passwordChangePath({ userKind: 'research' }), '/settings');
  assert.equal(fallbackPath({ userKind: 'saas' }), '/quick');
  assert.equal(fallbackPath({ userKind: 'research' }), '/');
  // 缺省(拿不到 userKind)按专家处理:弹回 / 后专家路由自己再判权限,
  // 而把专家误判成 SaaS 会把人锁在 /quick 里出不来。
  assert.equal(fallbackPath(null), '/');
});
