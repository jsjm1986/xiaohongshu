/**
 * 极简创作的频道路由。
 *
 * 四个区原来是 `useState<QuickTab>` 切渲染,地址栏全程停在 /quick。那不是"还没做
 * 路由",而是在手写一个路由器:为了让阅读页能返回原处,得往 sessionStorage 存
 * 一份 {projectId, tab},再配一个恢复 effect——地址栏本来就该干这件事。
 *
 * 改成真频道之后:刷新停在原处、链接可分享、浏览器前进后退在四区之间走,
 * 那份 sessionStorage 记忆整段删掉。
 */

export type QuickArea = 'overview' | 'knowledge' | 'create' | 'history';

export const AREA_ORDER: readonly QuickArea[] = ['overview', 'knowledge', 'create', 'history'] as const;

export const AREA_LABELS: Record<QuickArea, string> = {
  overview: '总览',
  knowledge: '知识库',
  create: '创作',
  history: '产出',
};

/** 默认区:进项目先看总览。 */
export const DEFAULT_AREA: QuickArea = 'overview';

/** 卡墙(项目列表)。 */
export const QUICK_HOME_PATH = '/quick';

/**
 * 某项目某区的地址。
 *
 * projectId 来自后端 randomUUID,但地址是要被收藏和分享的,不假设它永远无需转义。
 */
export function areaPath(projectId: string, area: QuickArea = DEFAULT_AREA): string {
  return `/quick/${encodeURIComponent(projectId)}/${area}`;
}

/**
 * /quick 下的固定段。
 *
 * `:projectId` 是动态段,而 read/account 是静态段,两者都能匹配 /quick/:x。
 * React Router 的 rank 规则让静态段胜出,但那是隐式的——这张表把它写下来供测试
 * 断言,也提醒后来加固定段的人:新名字不能和项目 id 的位置打架。
 */
export const QUICK_RESERVED_SEGMENTS: readonly string[] = ['read', 'account'] as const;
