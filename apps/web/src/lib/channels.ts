import {
  BookOpenText,
  Boxes,
  FileClock,
  FlaskConical,
  LayoutDashboard,
  Microscope,
  ScrollText,
  Settings,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { GroupableNavItem, NavGroupId } from './nav-groups';

/**
 * 频道表:侧边栏导航与页面 hero 的共同真源。
 *
 * 这张表原来住在 AppShell 里。hero 需要「当前频道的图标和名字」之后,若从
 * AppShell 导出会让 V2.tsx → AppShell.tsx 形成组件层的反向依赖(AppShell 是
 * 壳,V2 是它内部页面用的原语),所以下沉到 lib。
 *
 * 「极简创作」不在这张表里:它是**版本**,不是频道。放进导航会和知识库、公式
 * 版本这些资产入口并列,暗示它是工作台的一个页面;实际点进去是换了整套壳。
 * 版本切换在顶栏 <EditionSwitch />,两个壳同一位置、双向对称。
 */
export interface Channel extends GroupableNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** NavLink 的 end：只有根路径需要精确匹配 */
  end?: boolean;
  adminOnly?: boolean;
}

export const CHANNELS: readonly Channel[] = [
  { to: '/', label: '概览', icon: LayoutDashboard, group: 'workspace', end: true },
  { to: '/generate', label: '内容生成', icon: Sparkles, group: 'workspace' },
  // 生成历史是工作台的产出物——「我做过什么」,和概览、内容生成同一组。
  { to: '/history', label: '生成历史', icon: FileClock, group: 'workspace' },
  { to: '/projects', label: '项目管理', icon: Boxes, group: 'assets' },
  { to: '/knowledge', label: '知识库', icon: BookOpenText, group: 'assets' },
  { to: '/formulas', label: '公式版本', icon: FlaskConical, group: 'assets' },
  { to: '/research', label: '研究与证据', icon: Microscope, group: 'assets' },
  { to: '/team', label: '团队权限', icon: UsersRound, group: 'admin', adminOnly: true },
  // /audit 一直存在(App.tsx 有路由、后端有 audit.read 校验),但此前全站没有任何
  // 入口指向它,只能手敲 URL。归到管理组补上入口。
  { to: '/audit', label: '操作审计', icon: ScrollText, group: 'admin', adminOnly: true },
] as const;

/**
 * 设置不在 CHANNELS 里(它固定在侧边栏底部,不属于任何分组),但 hero 仍需要
 * 它的图标与名字,所以单列一条。
 */
export const SETTINGS_CHANNEL: Channel = {
  to: '/settings',
  label: '模型与设置',
  icon: Settings,
  group: 'admin',
};

/** hero 查找频道时用的全集:分组频道 + 设置。 */
export const ALL_CHANNELS: readonly Channel[] = [...CHANNELS, SETTINGS_CHANNEL] as const;
