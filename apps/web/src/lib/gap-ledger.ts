import type { ReaderCandidate } from '../types';

/**
 * 缺口落地台账的展示视图。
 *
 * 这是「这篇为什么不能直接发」最直接的答案:每个选中缺口都有计划(由正文还是评论
 * 回答)和实际落地结果。实测 204 条台账里 168 条是 realization_failed——也就是
 * 绝大多数稿子的计划没落地,而界面此前一个字都没说。
 */

/** 台账状态 → 人能读的结论。实测出现过 4 种,其余按契约枚举补全。 */
const STATUS_LABEL: Record<string, { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' }> = {
  body_resolved: { text: '正文已回答', tone: 'ok' },
  thread_resolved: { text: '评论已回答', tone: 'ok' },
  realization_failed: { text: '计划未落地', tone: 'error' },
  unknown_with_verification: { text: '答不了，已给核验路径', tone: 'warn' },
  awaiting_user_input: { text: '等你补充信息', tone: 'warn' },
  explicitly_deferred: { text: '本篇明确不谈', tone: 'muted' },
  planned_for_body: { text: '计划由正文回答', tone: 'muted' },
  planned_for_thread: { text: '计划由评论回答', tone: 'muted' },
};

/** 缺哪一项 → 人能读的说法。 */
const MISSING_LABEL: Record<string, string> = {
  answer: '没给出答案',
  condition_or_boundary: '没写适用条件或边界',
  evidence: '没有证据支撑',
  findability: '读者找不到（藏得太深）',
};

/** 通道 → 中文。 */
const CHANNEL_LABEL: Record<string, string> = {
  'N.body': '正文',
  Cref: '评论区',
  'N.title': '标题',
  'N.imageBrief': '图片说明',
  H: '标签',
};

export function channelLabel(value: string): string {
  return CHANNEL_LABEL[value] ?? value;
}

export interface GapLedgerRow {
  gapId: string;
  /** 缺口名(台账里的 label) */
  label: string;
  /** 缺口的原始问题(来自 gapCards);历史包可能没有 */
  question?: string;
  boundary?: string;
  required: boolean;
  statusText: string;
  tone: 'ok' | 'warn' | 'error' | 'muted';
  /** true 表示这条是「计划没落地」,是可发布性问题的直接来源 */
  failed: boolean;
  plannedLabels: string[];
  /** 每个通道实际落地情况(同通道多线程已合并);计划未落地时用来说明缺哪几项 */
  realizations: Array<{ channelText: string; resolved: boolean; missingLabels: string[]; detail?: string }>;
  reason?: string;
  requiredInput?: string;
  verificationPath?: string;
}

/**
 * 按通道合并落地记录。
 *
 * 评论区每个线程都是一条 realization,实测一个缺口能有 5 条 Cref 记录,缺项还完全
 * 一样——平铺出来就是「评论区:没给出答案、…」重复五遍。合并成一行,并标出
 * 「5 条线程都缺」这个量,信息更准也更短。
 */
function mergeRealizations(
  raw: Array<{ channel: string; threadId?: string; resolved: boolean; missing: string[] }>,
): GapLedgerRow['realizations'] {
  const byChannel = new Map<string, { resolvedCount: number; total: number; missing: Set<string> }>();
  for (const item of raw) {
    const key = item.channel;
    const acc = byChannel.get(key) ?? { resolvedCount: 0, total: 0, missing: new Set<string>() };
    acc.total += 1;
    if (item.resolved) acc.resolvedCount += 1;
    // 未识别的 missing 值原样保留,不猜、不丢
    for (const m of item.missing ?? []) acc.missing.add(MISSING_LABEL[m] ?? m);
    byChannel.set(key, acc);
  }
  return [...byChannel.entries()].map(([channel, acc]) => ({
    channelText: channelLabel(channel),
    resolved: acc.resolvedCount > 0 && acc.resolvedCount === acc.total,
    missingLabels: [...acc.missing],
    // 只有多条(评论区多线程)时才提,单条不啰嗦
    detail: acc.total > 1 ? `${acc.total} 条线程中 ${acc.resolvedCount} 条落地` : undefined,
  }));
}

export interface GapLedgerView {
  rows: GapLedgerRow[];
  /** 已落地条数 / 总条数 */
  resolved: number;
  total: number;
  failedCount: number;
  /** 终稿还没评估时为 false:此时"未落地"只是未评估,不能说成失败 */
  evaluated: boolean;
}

export function gapLedgerView(candidate?: Pick<ReaderCandidate, 'gapLedger' | 'gapCards'>): GapLedgerView | null {
  const entries = candidate?.gapLedger?.entries ?? [];
  if (entries.length === 0) return null;
  const cards = candidate?.gapCards ?? [];
  const evaluated = candidate?.gapLedger?.realizationStatus === 'evaluated';

  const rows: GapLedgerRow[] = entries.map((entry) => {
    const card = cards.find((c) => c.gapId === entry.gapId);
    const status = STATUS_LABEL[entry.status] ?? { text: entry.status, tone: 'muted' as const };
    return {
      gapId: entry.gapId,
      label: entry.label || card?.label || entry.gapId,
      question: card?.question,
      boundary: card?.boundary,
      required: entry.required,
      statusText: status.text,
      tone: status.tone,
      failed: entry.status === 'realization_failed',
      plannedLabels: (entry.plannedPlacements ?? []).map(channelLabel),
      realizations: mergeRealizations(entry.realizations ?? []),
      reason: entry.reason,
      requiredInput: entry.requiredInput,
      verificationPath: entry.verificationPath,
    };
  });

  return {
    rows,
    resolved: rows.filter((r) => r.tone === 'ok').length,
    total: rows.length,
    failedCount: rows.filter((r) => r.failed).length,
    evaluated,
  };
}
