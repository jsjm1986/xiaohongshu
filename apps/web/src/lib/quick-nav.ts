/**
 * 阅读页地址。
 *
 * 这个模块原来还带一份 sessionStorage 的「工作区记忆」({projectId, tab}),用来让
 * 阅读页返回时能回到原处——因为四个区那时是 useState 切渲染,地址栏帮不上忙。
 * 四区改成真路由(见 quick-routes.ts)之后,地址本身就是记忆,那段整体删掉了。
 */

export function readerPath(jobId: string): string {
  return `/quick/read/${encodeURIComponent(jobId)}`;
}
