import type { User } from '../types';

/** SaaS 用户(极简创作):userKind === 'saas';缺省/科研用户一律 false。 */
export function isSaasUser(user: Pick<User, 'userKind'> | null | undefined): boolean {
  return user?.userKind === 'saas';
}

/**
 * SaaS 用户可访问的页面白名单:只有 /quick 及其子路径。
 * /login 是壳外路由,不归这里管。
 *
 * /settings 已从白名单移出:那是专家版工作台的页面,渲染在 AppShell 里,
 * 带整条专家侧边栏(9 个入口)与内部技术状态。SaaS 用户的账户页改到
 * /quick/account,渲染在极简创作壳里。
 */
export function saasPageAllowed(pathname: string): boolean {
  return pathname === '/quick' || pathname.startsWith('/quick/');
}

/** SaaS 用户的账户页(极简创作壳内);专家用户的是 /settings。 */
export const SAAS_ACCOUNT_PATH = '/quick/account';
export const SAAS_HOME_PATH = '/quick';
export const EXPERT_ACCOUNT_PATH = '/settings';
export const EXPERT_HOME_PATH = '/';

/**
 * 登录后的落地页。
 *
 * 实测缺陷:SaaS 用户首次登录必然落进**专家版壳**——因为 mustChangePassword
 * 的强制跳转硬编码了 /settings,而 /settings 当时又在 SaaS 白名单里。付费客户
 * 第一眼看到的是 9 个专家入口的侧边栏。所以跳转目标必须按用户类型分叉。
 */
export function loginLandingPath(
  user: Pick<User, 'userKind' | 'mustChangePassword'> | null | undefined,
): string {
  if (!user) return '/login';
  if (user.mustChangePassword) return passwordChangePath(user);
  return isSaasUser(user) ? SAAS_HOME_PATH : EXPERT_HOME_PATH;
}

/** 强制改密时该去哪个账户页。 */
export function passwordChangePath(user: Pick<User, 'userKind'> | null | undefined): string {
  return isSaasUser(user) ? SAAS_ACCOUNT_PATH : EXPERT_ACCOUNT_PATH;
}

/** 越权访问 / 404 兜底时该弹回哪里。 */
export function fallbackPath(user: Pick<User, 'userKind'> | null | undefined): string {
  return isSaasUser(user) ? SAAS_HOME_PATH : EXPERT_HOME_PATH;
}
