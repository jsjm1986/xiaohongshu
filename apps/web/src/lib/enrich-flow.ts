import type { DraftItem, EnrichConfidence, EnrichDraft, EnrichMergeItem } from './enrich-types';

/**
 * 状态机放在这里而不是组件里,因为 apps/web 的测试是 node:test 跑纯逻辑
 * (没有 vitest / testing-library)。留在组件里就等于没测试。
 */

/** 后端返回的草稿转成前端编辑态。初始一律 pending:没审过就不算确认。 */
export function toDraftItems(drafts: EnrichDraft[]): DraftItem[] {
  return drafts.map((draft) => ({ ...draft, status: 'pending' }));
}

/** 当前生效的正文:改过就用用户的,没改就用 AI 的。 */
export function effectiveContent(item: DraftItem): string {
  return item.userContent?.trim() ? item.userContent : item.aiDraft;
}

/**
 * 组装 merge 请求。
 *
 * 只发用户明确确认或修改过的条目。pending 不能因为点击「生成合并版」就被隐式
 * 升级成事实；editing 也还没有完成修改。正常 UI 会由 canMerge 挡住这两种状态。
 */
export function toMergeItems(items: DraftItem[]): EnrichMergeItem[] {
  return items
    .filter((item): item is DraftItem & { status: 'confirmed' | 'edited' } =>
      item.status === 'confirmed' || item.status === 'edited')
    .map((item) => ({
      gapId: item.gapId,
      status: item.status,
      content: effectiveContent(item),
    }));
}

/** 有没有改动没提交。关闭前的二次确认靠它。 */
export function hasUnsavedEdits(items: DraftItem[]): boolean {
  return items.some((item) => item.status === 'editing' || item.status === 'edited');
}

/** 至少留一条，且每条都已由用户确认/修改并有正文，才能合并为已知事实。 */
export function canMerge(items: DraftItem[]): boolean {
  const active = items.filter((item) => item.status !== 'deleted');
  return active.length > 0 && active.every(
    (item) => (item.status === 'confirmed' || item.status === 'edited')
      && isResolvedKnowledge(effectiveContent(item)),
  );
}

const UNRESOLVED = /(?:待确认|资料未提及|尚未提供|信息缺失|不清楚|不知道|目前未知|暂不确定)/u;

export function isResolvedKnowledge(content: string): boolean {
  const text = content.trim();
  return text.length >= 10 && !UNRESOLVED.test(text) && !/[?？]\s*$/u.test(text);
}

/** 替换一条(按 gapId),其余不动。 */
export function applyDraftChange(items: DraftItem[], updated: DraftItem): DraftItem[] {
  return items.map((item) => (item.gapId === updated.gapId ? updated : item));
}

export function beginEdit(item: DraftItem): DraftItem {
  return { ...item, status: 'editing' };
}

export function confirmDraft(item: DraftItem): DraftItem {
  return { ...item, status: 'confirmed' };
}

/** 提交编辑。改回和 AI 原稿一致时退回 pending——没有实际改动就别标成「已修改」。 */
export function commitEdit(item: DraftItem, content: string): DraftItem {
  const text = content.trim();
  if (text === item.aiDraft.trim()) return { ...item, status: 'pending', userContent: undefined };
  return { ...item, status: 'edited', userContent: content };
}

/** 放弃编辑。之前改过的保留 edited,没改过的回到 pending。 */
export function cancelEdit(item: DraftItem): DraftItem {
  return { ...item, status: item.userContent ? 'edited' : 'pending' };
}

export function deleteDraft(item: DraftItem): DraftItem {
  return { ...item, status: 'deleted' };
}

/** 恢复。改过的回到 edited,保住用户的文字——回到 pending 会让编辑白做。 */
export function restoreDraft(item: DraftItem): DraftItem {
  return { ...item, status: item.userContent ? 'edited' : 'pending' };
}

const CONFIDENCE_LABELS: Record<EnrichConfidence, { text: string; tone: 'positive' | 'warning' | 'danger' }> = {
  high: { text: '资料中有明确依据', tone: 'positive' },
  medium: { text: '资料依据需重点核对', tone: 'warning' },
  low: { text: '资料依据较弱,需核对', tone: 'danger' },
};

/**
 * 把把握程度说成「依据强弱」而不是「高/中/低把握」。
 *
 * 「高把握」听起来像质量评分,用户会当成「这条更可信,不用细看」;而这三档说的
 * 其实是「依据来自哪里」。逐条审查是这个功能成立的前提,文案不能反过来劝人别审。
 */
export function confidenceLabel(confidence: EnrichConfidence) {
  return CONFIDENCE_LABELS[confidence];
}
