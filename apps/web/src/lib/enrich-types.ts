import type { InformationGap } from '../types';

/** AI 整理现有资料时对证据明确程度的自评。 */
export type EnrichConfidence = 'low' | 'medium' | 'high';

/** 一条草稿在用户手里的处置状态。editing 是纯 UI 态,不会发给后端。 */
export type DraftStatus = 'pending' | 'confirmed' | 'editing' | 'edited' | 'deleted';

export type ModalStep = 'drafting' | 'editing' | 'merging' | 'preview' | 'saving';

/** 后端 /enrich/draft 返回的单条草稿。 */
export interface EnrichDraft {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: EnrichConfidence;
  knowledgeAction: 'organize_existing' | 'ask_user';
  knowledgeReason: string;
  sources: Array<{ evidenceId: string; filename: string; heading: string; excerpt: string }>;
}

/** 前端在 EnrichDraft 上叠加的编辑态。 */
export interface DraftItem extends EnrichDraft {
  status: DraftStatus;
  /** 用户改过的正文。为空表示沿用 aiDraft。 */
  userContent?: string;
}

export interface EnrichDraftResponse {
  gaps: EnrichDraft[];
  /** 待补充缺口总数(未截断)。和 limit 比较就知道这次有没有起草完。 */
  totalPending: number;
  /** 单次起草上限。 */
  limit: number;
  /** 正文读不出来的知识文件名。模型少看了这些资料。 */
  unreadableFiles: string[];
}

export interface EnrichMergeItem {
  gapId: string;
  status: 'confirmed' | 'edited' | 'deleted';
  content?: string;
}

export interface EnrichMergeRequest {
  items: EnrichMergeItem[];
  targetFile?: string;
}

export interface EnrichMergeResponse {
  preview: string;
  targetFile: string;
  /** 合并时读取的目标版本；null 表示当时文件不存在。保存时用于并发校验。 */
  baseFileId: string | null;
  isNewFile: boolean;
  /** 兼容旧响应的保留字段；确定性合并下恒为 0。 */
  hedgeLossCount: number;
  appendedCount: number;
}

export interface EnrichSaveRequest {
  content: string;
  targetFile: string;
  baseFileId: string | null;
}

/** 缺口统计。入口只使用分析器明确给出的知识完善动作。 */
export interface GapStats {
  total: number;
  supplied: number;
  inferred: number;
  unknown: number;
  organize: number;
  askUser: number;
}

/** 三档来源统计用于诊断展示；知识完善入口另按 knowledgeAction 统计。 */
export function gapStats(gaps: InformationGap[]): GapStats {
  let supplied = 0;
  let inferred = 0;
  let unknown = 0;
  let organize = 0;
  let askUser = 0;
  for (const gap of gaps) {
    if (gap.knowledgeAction === 'organize_existing') organize += 1;
    if (gap.knowledgeAction === 'ask_user') askUser += 1;
    const answered = Boolean(gap.answer?.trim());
    const status = gap.sourceStatus;
    // 顺序要紧:没有答案的一律算空白档,即使 sourceStatus 写着 supplied_fact。
    // 那是数据矛盾,按更保守的一档计。
    if (!answered || status === 'unknown') unknown += 1;
    else if (status === 'inference' || status === 'hypothesis') inferred += 1;
    else supplied += 1;
  }
  return { total: gaps.length, supplied, inferred, unknown, organize, askUser };
}

/** 待完善 = 可整理的现有事实 + 必须由用户回答的项目事实。 */
export function pendingCount(stats: GapStats): number {
  return stats.organize + stats.askUser;
}

/**
 * 入口按钮文案。三个入口共用一个函数,不各自拼字符串。
 *
 * 原先三处分别写,括号还不一致:专业版用全角「（1 项）」,快捷版和缺口池用半角
 * 「(11 项)」。同一个按钮在不同页面长得不一样,用户会怀疑是两个功能。
 * 全角是中文排版里括号的正常写法,也是本仓界面文案里的多数写法,所以统一取全角。
 */
export function enrichButtonLabel(pending: number, stats?: Pick<GapStats, 'organize' | 'askUser'>): string {
  if (stats && pending > 0) return `完善知识（整理 ${stats.organize} · 回答 ${stats.askUser}）`;
  return `完善知识（${pending} 项）`;
}

/**
 * 起草结果和请求量对不上时的说明,没有落差就返回 null。
 *
 * 分两种落差,措辞不同:
 * - 超出单次上限:必然发生,再跑一轮就能补完,要给出还剩多少。
 * - 模型漏答:不该发生,重试通常就好,不说「还剩」免得用户以为要再跑一轮才对。
 */
export function draftShortfallNote(result: {
  gaps: unknown[];
  totalPending: number;
  limit: number;
}): string | null {
  const drafted = result.gaps.length;
  if (result.totalPending > result.limit) {
    const remaining = result.totalPending - drafted;
    return `本次起草了 ${drafted} 条。单次最多 ${result.limit} 条，还有 ${remaining} 条没起草，保存后可以再点一次补完。`;
  }
  if (drafted < result.totalPending) {
    const missing = result.totalPending - drafted;
    return `有 ${missing} 条缺口模型这次没能给出可用内容，保存后可以再试一次。`;
  }
  return null;
}

/**
 * 补充保存成功后的提示。
 *
 * 用户已在弹窗中逐条确认或修改，保存后的版本属于人工确认的已知事实。
 * 资料变化会让现有分析失效，所以提示下一步重新分析，让知识地图和缺口同步更新。
 */
export function enrichSavedHint(): string {
  return '已按人工确认保存为「已知事实」。请重新分析知识库，更新知识地图和信息缺口。';
}

/**
 * 「保存到」可选的文件名。
 *
 * 两个入口传进来的列表语义不同:专业版传的是折叠到最新版的 currentFiles,
 * 快捷版传的是 knowledge.list 原样返回的行——后端 SQL 不按 filename 去重,
 * 同名文件每个版本一行。不去重的话快捷版会出现重复选项和重复的 React key。
 * 历史版本不是可选的保存目标:保存总是产生新版本,选"哪一份"只看文件名。
 * reference-corpus 是对标风格样本,不能承载项目事实补全；按同名文件的最新版判断，
 * 避免旧版本的普通分类把已改成参考语料的最新版重新放回选项。
 */
export function enrichTargetOptions(
  files: ReadonlyArray<{ name: string; category?: string; version?: number }>,
): string[] {
  const latest = new Map<string, { category?: string; version: number }>();
  for (const file of files) {
    const name = file.name.trim();
    if (!name) continue;
    const version = Number.isFinite(file.version) ? Number(file.version) : 1;
    const previous = latest.get(name);
    if (!previous || version >= previous.version) latest.set(name, { category: file.category, version });
  }
  return [...latest]
    .filter(([, file]) => file.category !== 'reference-corpus')
    .map(([name]) => name);
}
