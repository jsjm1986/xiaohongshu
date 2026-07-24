import type { User } from '../types';

/** SaaS 用户(极简创作):userKind === 'saas';缺省/科研用户一律 false。 */
export function isSaasUser(user: Pick<User, 'userKind'> | null | undefined): boolean {
  return user?.userKind === 'saas';
}

/**
 * SaaS 用户可访问的页面白名单:/quick(及子路径)与 /settings(及子路径)。
 * /login 是壳外路由,不归这里管。
 */
export function saasPageAllowed(pathname: string): boolean {
  return (
    pathname === '/quick' ||
    pathname.startsWith('/quick/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  );
}
