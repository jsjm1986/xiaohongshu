import type { QuickTab } from './quick-channel-state';

/**
 * 极简创作的路由与「回到原处」记忆。
 *
 * 阅读原来是产出列表里的手风琴:点「查看」在同一页展开一块两千多像素高的详情,
 * 上下都还挂着别的任务行。读一篇文案得在列表里滚,列表本身也被撑散——一屏里
 * 既有「第 37 条正在排队」又有正文全文,没有一个位置是稳定的。
 *
 * 改成独立阅读页 /quick/read/:jobId。代价是离开了工作区页,所以要记住原处:
 * 工作区的项目与所在分区存在 sessionStorage,返回时原样恢复,而不是掉回项目卡墙。
 */

export const READER_ROUTE_PATH = 'quick/read/:jobId';

export function readerPath(jobId: string): string {
  return `/quick/read/${encodeURIComponent(jobId)}`;
}

export interface QuickWorkspaceMemo {
  projectId: string;
  tab: QuickTab;
}

const MEMO_KEY = 'content-agent-quick-workspace';
const TABS: readonly QuickTab[] = ['overview', 'knowledge', 'create', 'history'];

export function serializeWorkspaceMemo(memo: QuickWorkspaceMemo): string {
  return JSON.stringify(memo);
}

/** 解析记忆;任何形状不对(手改过、版本变了)都当没有记忆,而不是抛错卡住整页。 */
export function parseWorkspaceMemo(raw: string | null | undefined): QuickWorkspaceMemo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { projectId, tab } = parsed as Record<string, unknown>;
    if (typeof projectId !== 'string' || projectId.length === 0) return null;
    if (typeof tab !== 'string' || !TABS.includes(tab as QuickTab)) return null;
    return { projectId, tab: tab as QuickTab };
  } catch {
    return null;
  }
}

/** sessionStorage 在 SSR / node 测试里不存在,读写一律先探再用。 */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function rememberWorkspace(memo: QuickWorkspaceMemo): void {
  storage()?.setItem(MEMO_KEY, serializeWorkspaceMemo(memo));
}

export function recallWorkspace(): QuickWorkspaceMemo | null {
  return parseWorkspaceMemo(storage()?.getItem(MEMO_KEY));
}

export function forgetWorkspace(): void {
  storage()?.removeItem(MEMO_KEY);
}
