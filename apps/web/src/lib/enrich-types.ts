import type { InformationGap } from '../types';

/** AI 对自己这条推断的把握程度。low 要在 UI 上显著标出。 */
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
  isNewFile: boolean;
  /** 合并吃掉了多少条不确定标记。>0 时提醒用户重点核对,不阻断保存。 */
  hedgeLossCount: number;
}

export interface EnrichSaveRequest {
  content: string;
  targetFile: string;
}

/** 缺口的三档统计。入口按钮用它决定要不要提示、提示什么。 */
export interface GapStats {
  total: number;
  supplied: number;
  inferred: number;
  unknown: number;
}

/**
 * 缺口的三档统计。
 *
 * 判据必须和后端 pendingGaps 一致(答案为空,或 sourceStatus 属于
 * unknown/inference/hypothesis),否则按钮上写「6 项」点进去出来 4 条。
 *
 * hypothesis 归到 inferred 而不是单开一档:对用户来说「推断」和「假设」是同一件
 * 事——没有资料支撑、需要你确认。分成两档只是增加认知负担。
 */
export function gapStats(gaps: InformationGap[]): GapStats {
  let supplied = 0;
  let inferred = 0;
  let unknown = 0;
  for (const gap of gaps) {
    const answered = Boolean(gap.answer?.trim());
    const status = gap.sourceStatus;
    // 顺序要紧:没有答案的一律算空白档,即使 sourceStatus 写着 supplied_fact。
    // 那是数据矛盾,按更保守的一档计。
    if (!answered || status === 'unknown') unknown += 1;
    else if (status === 'inference' || status === 'hypothesis') inferred += 1;
    else supplied += 1;
  }
  return { total: gaps.length, supplied, inferred, unknown };
}

/** 待补充 = 未知 + 推断。入口按钮上的数字。 */
export function pendingCount(stats: GapStats): number {
  return stats.unknown + stats.inferred;
}

/**
 * 入口按钮文案。三个入口共用一个函数,不各自拼字符串。
 *
 * 原先三处分别写,括号还不一致:专业版用全角「（1 项）」,快捷版和缺口池用半角
 * 「(11 项)」。同一个按钮在不同页面长得不一样,用户会怀疑是两个功能。
 * 全角是中文排版里括号的正常写法,也是本仓界面文案里的多数写法,所以统一取全角。
 */
export function enrichButtonLabel(pending: number): string {
  return `AI 帮我补充（${pending} 项）`;
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
 * 保存本身不关闭缺口——存进去的是模型推测(证据类型「猜想」),没有人背书过。
 * 但它不再是死路:认可的内容填进缺口答案并选「我确认过」,那一刻缺口才关闭,
 * 且生成端会给它人工背书证据。这句话要把这条路说出来。
 */
export function enrichSavedHint(): string {
  return '已保存为新版本。缺口不会因此关闭——把你认可的内容填进缺口答案并选「我确认过」,才算补上了。';
}

/**
 * 「保存到」可选的文件名。
 *
 * 两个入口传进来的列表语义不同:专业版传的是折叠到最新版的 currentFiles,
 * 快捷版传的是 knowledge.list 原样返回的行——后端 SQL 不按 filename 去重,
 * 同名文件每个版本一行。不去重的话快捷版会出现重复选项和重复的 React key。
 * 历史版本不是可选的保存目标:保存总是产生新版本,选"哪一份"只看文件名。
 */
export function enrichTargetOptions(files: ReadonlyArray<{ name: string }>): string[] {
  return [...new Set(files.map((file) => file.name).filter((name) => name.trim()))];
}
