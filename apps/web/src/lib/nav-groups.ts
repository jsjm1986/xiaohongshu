/**
 * 侧边栏频道的分组归属。
 *
 * 原来分组是靠 `navigation.slice(0, 2)` / `.slice(2)` 按下标切的,有两个后果:
 * 一是往表中间插一项会静默切进错误的分组;二是实际归类已经不对了——「生成历史」
 * 是工作台的产出物却挂在「资产与规则」下,「团队权限」是管理动作也挂在那儿。
 *
 * 所以分组改成每项自报的 `group` 字段,组名如实描述组里的东西:
 *   workspace 我在做事 + 我做过什么
 *   assets    我拿什么做
 *   admin     谁能做、做了什么留痕
 */
export type NavGroupId = 'workspace' | 'assets' | 'admin';

export interface NavGroup {
  id: NavGroupId;
  /** 侧边栏上的组标题,含序号前缀。 */
  label: string;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'workspace', label: '01 · 工作台' },
  { id: 'assets', label: '02 · 资产与规则' },
  { id: 'admin', label: '03 · 管理' },
] as const;

/** 分组渲染所需的最小频道形状;图标等展示细节由调用方持有。 */
export interface GroupableNavItem {
  to: string;
  group: NavGroupId;
  adminOnly?: boolean;
}

/**
 * 页面 hero 上的频道标记(图标 + 频道名)取自哪一条导航。
 *
 * hero 原来显示 index="01".."10" 的幽影巨号,是十处硬编码字符串,靠人工和
 * 侧边栏顺序保持一致。改分组之后就对不上了——「生成历史」还是 07、「项目管理」
 * 还是 03,数字指向的位置已经不存在。所以 hero 的标记改为按路径回查导航定义,
 * 图标与频道名都来自 AppShell 的那一张表,导航改了 hero 自动跟着改。
 *
 * 这里只负责「按路径找到是哪条导航」;图标组件本身仍由 AppShell 持有,免得
 * 这个纯函数模块被迫依赖 react/lucide(测试就跑不起来了)。
 */
export function navItemForPath<T extends GroupableNavItem>(items: readonly T[], pathname: string): T | undefined {
  /*
    最长前缀优先。根路径 '/' 是所有路径的前缀,若按顺序取第一个匹配,任何页面
    都会命中「概览」;取最长匹配则只有 '/' 本身会命中它。
  */
  return items
    .filter((item) => (item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)
    .at(0);
}

/** 能看到管理组频道的角色。 */
const ADMIN_ROLES = ['系统管理员', 'Owner', 'Admin'];

export function canSeeAdminNav(role: string | null | undefined): boolean {
  return ADMIN_ROLES.includes(role || '');
}

/** 过滤掉该角色看不到的频道。 */
export function visibleNavItems<T extends GroupableNavItem>(items: readonly T[], role: string | null | undefined): T[] {
  const admin = canSeeAdminNav(role);
  return items.filter((item) => !item.adminOnly || admin);
}

/**
 * 按 NAV_GROUPS 的顺序分组,并丢掉空组。
 *
 * 丢空组是必要的:管理组整组都是 adminOnly,非管理员看到的组标题下面
 * 会一个频道都没有——渲染出一个孤立的「03 · 管理」标题。
 */
export function groupNavItems<T extends GroupableNavItem>(
  items: readonly T[],
  role: string | null | undefined,
): Array<{ group: NavGroup; items: T[] }> {
  const visible = visibleNavItems(items, role);
  return NAV_GROUPS.map((group) => ({ group, items: visible.filter((item) => item.group === group.id) })).filter(
    (section) => section.items.length > 0,
  );
}
