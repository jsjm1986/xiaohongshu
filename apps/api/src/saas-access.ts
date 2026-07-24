// SaaS 用户(极简创作产品)API 白名单。命中外一律拒绝。
// path 只按 pathname 判定(不含 query);前缀匹配按路径段边界:exact 或 startsWith(prefix + '/')。
export function isSaasApiAllowed(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const pathname = path.split('?')[0] || '/';

  const inScope = (prefix: string): boolean =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);

  if (inScope('/api/auth')) return true;

  if (inScope('/api/workspaces')) {
    return verb === 'GET' && pathname === '/api/workspaces';
  }

  if (inScope('/api/projects')) {
    // 禁止优先:research 子路径一律拒绝
    if (pathname.startsWith('/api/projects/') && pathname.includes('/research/')) return false;
    return true;
  }

  if (inScope('/api/knowledge')) return true;
  if (inScope('/api/generations')) return true;
  if (inScope('/api/generation-batches')) return true;
  if (verb === 'GET' && pathname === '/api/generation-parameters/schema') return true;

  return false;
}
