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
