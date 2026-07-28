import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAV_GROUPS,
  canSeeAdminNav,
  groupNavItems,
  navItemForPath,
  visibleNavItems,
  type GroupableNavItem,
} from '../src/lib/nav-groups';

/* 用一份最小夹具,而不是导入 AppShell 的真表——分组算法和具体频道清单该各测各的。 */
const ITEMS: GroupableNavItem[] = [
  { to: '/', group: 'workspace' },
  { to: '/generate', group: 'workspace' },
  { to: '/history', group: 'workspace' },
  { to: '/projects', group: 'assets' },
  { to: '/team', group: 'admin', adminOnly: true },
  { to: '/audit', group: 'admin', adminOnly: true },
];

test('管理员看到三组,顺序与 NAV_GROUPS 一致', () => {
  const sections = groupNavItems(ITEMS, '系统管理员');
  assert.deepEqual(
    sections.map((section) => section.group.id),
    ['workspace', 'assets', 'admin'],
  );
  assert.deepEqual(
    sections.map((section) => section.group.label),
    NAV_GROUPS.map((group) => group.label),
  );
});

test('生成历史归工作台,不再和项目管理同组', () => {
  const sections = groupNavItems(ITEMS, '系统管理员');
  const workspace = sections.find((section) => section.group.id === 'workspace');
  assert.ok(workspace);
  assert.deepEqual(workspace.items.map((item) => item.to), ['/', '/generate', '/history']);
  const assets = sections.find((section) => section.group.id === 'assets');
  assert.deepEqual(assets?.items.map((item) => item.to), ['/projects']);
});

test('非管理员整组隐藏时不留下空的组标题', () => {
  const sections = groupNavItems(ITEMS, '编辑');
  assert.deepEqual(
    sections.map((section) => section.group.id),
    ['workspace', 'assets'],
  );
  // 反向对照:换成管理员,同一份输入必须多出 admin 组,否则上面的断言可能是恒真的。
  assert.ok(groupNavItems(ITEMS, 'Owner').some((section) => section.group.id === 'admin'));
});

test('操作审计只对管理员可见', () => {
  assert.ok(!visibleNavItems(ITEMS, '编辑').some((item) => item.to === '/audit'));
  assert.ok(visibleNavItems(ITEMS, 'Admin').some((item) => item.to === '/audit'));
});

test('canSeeAdminNav 覆盖三种管理角色,其余为否', () => {
  for (const role of ['系统管理员', 'Owner', 'Admin']) assert.equal(canSeeAdminNav(role), true);
  for (const role of ['编辑', '内容编导', '', null, undefined]) assert.equal(canSeeAdminNav(role), false);
});

test('分组不丢频道:每个可见项恰好落在一组里', () => {
  for (const role of ['系统管理员', '编辑']) {
    const visible = visibleNavItems(ITEMS, role);
    const grouped = groupNavItems(ITEMS, role).flatMap((section) => section.items);
    assert.equal(grouped.length, visible.length, `${role} 分组前后数量不一致`);
    assert.deepEqual(new Set(grouped.map((item) => item.to)), new Set(visible.map((item) => item.to)));
  }
});

test('navItemForPath 取最长前缀,根路径不吞掉其他页面', () => {
  // '/' 是所有路径的前缀,按顺序取首个匹配会让每个页面都命中「概览」
  assert.equal(navItemForPath(ITEMS, '/')?.to, '/');
  assert.equal(navItemForPath(ITEMS, '/projects')?.to, '/projects');
  assert.equal(navItemForPath(ITEMS, '/history')?.to, '/history');
});

test('navItemForPath 认子路径,但不认前缀相同的兄弟路径', () => {
  assert.equal(navItemForPath(ITEMS, '/projects/abc123')?.to, '/projects');
  // '/generate' 不该匹配到 '/generations/:id'——那是详情页,不是频道
  assert.equal(navItemForPath(ITEMS, '/generations/abc')?.to, undefined);
  assert.equal(navItemForPath(ITEMS, '/nowhere')?.to, undefined);
});

test('navItemForPath 在候选重叠时取更具体的那条', () => {
  const nested = [
    { to: '/research', group: 'assets' as const },
    { to: '/research/claims', group: 'assets' as const },
  ];
  assert.equal(navItemForPath(nested, '/research/claims')?.to, '/research/claims');
  assert.equal(navItemForPath(nested, '/research')?.to, '/research');
  // 反向对照:表序颠倒不影响结果,证明靠的是长度而非顺序
  assert.equal(navItemForPath([...nested].reverse(), '/research/claims')?.to, '/research/claims');
});
