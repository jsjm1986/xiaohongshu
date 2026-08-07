// 四区结构:① 总览 ② 知识库 ③ 创作 ④ 产出
//
// 区的枚举与地址已经搬到 lib/quick-routes.ts(四区改成真频道路由)。这里的
// QuickTab 保留为它的别名,免得把四个 Tab 组件的 props 签名一起翻一遍——
// 它们只是"跳到某个区",不关心区是 tab 还是路由。
//
// clearDownstreamOfProject / clearResults 已删除:换项目时由
// QuickWorkspaceProvider 的 key 重挂整体清空,不再需要手工列举字段;
// 清结果就是 setResults([]),包一层函数只是让调用点更绕。
export type { QuickArea as QuickTab } from './quick-routes';

// ---------- 总览「下一步」推导 ----------

/** 内容地图分析态:由 ProjectIntelligence.status + staleReasons 在组件侧推导,纯函数只吃枚举。 */
export type AnalysisState = 'none' | 'draft' | 'stale' | 'ready' | 'failed';

export interface NextActionInput {
  hasKnowledge: boolean;
  analysis: AnalysisState;
  topicCount: number;
  generationCount: number;
}

/** 总览主按钮:按「知识 → 分析 → 选题 → 产出」链路找第一个缺口,指向对应区。 */
export function deriveNextAction(i: NextActionInput): { label: string; tab: 'knowledge' | 'create'; note?: string } {
  if (!i.hasKnowledge) return { label: '上传资料并分析', tab: 'knowledge' };
  if (i.analysis === 'none' || i.analysis === 'failed') return { label: '分析知识库', tab: 'knowledge' };
  if (i.analysis === 'stale') return { label: '重新分析', tab: 'knowledge', note: '资料有更新' };
  if (i.analysis === 'draft') return { label: '查看内容地图', tab: 'knowledge' };
  if (i.topicCount === 0) return { label: '去选题池换一批', tab: 'create' };
  if (i.generationCount === 0) return { label: '去创作第一篇', tab: 'create' };
  return { label: '继续创作', tab: 'create' };
}

// ---------- P1:项目设置输入转换 ----------

/** 解析城市输入:按中英文逗号、顿号、分号、空白分隔,trim、去空、去重(保序)。 */
export function parseCities(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(/[,、;;\s]+/)) {
    const city = part.trim();
    if (city) seen.add(city);
  }
  return [...seen];
}

/** 解析医生输入:每行一个名字,trim、去空行。 */
export function parseDoctors(input: string): Array<{ name: string }> {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

/** 城市数组 → 输入框文本(顿号连接)。 */
export function formatCities(cities?: string[]): string {
  return (cities ?? []).join('、');
}

/** 医生数组 → 输入框文本(每行一个名字,忽略 points)。 */
export function formatDoctors(doctors?: Array<{ name: string; points?: string[] }>): string {
  return (doctors ?? []).map((d) => d.name).join('\n');
}

// ---------- P1:选题 / 历史客户端筛选 ----------

export type OpportunityFilter = 'all' | 'collected' | 'archived';

export interface CreationOpportunityState {
  status?: string;
  approvalStatus?: string;
  eligibilityStatus?: string;
  effectiveEligibility?: string;
}

/** Historical rows remain readable, but they cannot enter a new generation. */
export function isOpportunityAvailableForCreation(item: CreationOpportunityState): boolean {
  const approvalStatus = item.approvalStatus ?? item.status;
  return approvalStatus !== 'stale'
    && item.status !== 'stale'
    && item.status !== 'blocked'
    && item.eligibilityStatus !== 'blocked'
    && item.effectiveEligibility !== 'ineligible';
}

/** 创作区筛选始终排除失效/阻断项；归档只控制当前集合视图。 */
export function filterOpportunities<T extends CreationOpportunityState & { collectionStatus?: string }>(items: T[], filter: OpportunityFilter): T[] {
  const current = items.filter(isOpportunityAvailableForCreation);
  if (filter === 'collected') return current.filter((item) => item.collectionStatus === 'collected');
  if (filter === 'archived') return current.filter((item) => item.collectionStatus === 'archived');
  return current.filter((item) => item.collectionStatus !== 'archived');
}

export type GenerationStatusFilter = 'all' | 'completed' | 'running' | 'failed';

/**
 * 历史筛选:状态('running' 含 queued+running)+ 标题关键词。
 * 关键词 trim 后转小写做包含匹配,空关键词不过滤。
 */
export function filterGenerationJobs<T extends { status: string; topic?: string }>(
  items: T[],
  filter: { status: GenerationStatusFilter; keyword?: string },
): T[] {
  const keyword = (filter.keyword ?? '').trim().toLowerCase();
  return items.filter((job) => {
    if (filter.status === 'completed' && job.status !== 'completed') return false;
    if (filter.status === 'failed' && job.status !== 'failed') return false;
    if (filter.status === 'running' && job.status !== 'queued' && job.status !== 'running') return false;
    if (keyword && !(job.topic ?? '').toLowerCase().includes(keyword)) return false;
    return true;
  });
}

/**
 * 选题被归档/删除后收敛批量勾选集：剔除该选题，其余保序。
 * 未勾选时原样返回同一引用，让调用方的 setState 不触发无意义重渲染。
 */
export function pruneCheckedIds(checkedIds: string[], goneId: string): string[] {
  return checkedIds.includes(goneId) ? checkedIds.filter((id) => id !== goneId) : checkedIds;
}
