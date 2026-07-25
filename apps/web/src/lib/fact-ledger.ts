import type { ReaderCandidate, ReaderReasoningEntry } from '../types';

/**
 * 事实标注:这篇里哪句话是有证据的事实,哪句只是假设。
 *
 * 后端为每个候选都算了句子级 reasoning(实测 8–35 条/篇,168/168 都有),但旧接口
 * 压根不返回,界面也就无从说明「这段话凭什么这么写」。对付费用户来说这是发布风险:
 * 假设当事实发出去,是要担责的。
 *
 * 实测可行性:occurrence.field==='body' 的 498 条全部是正文的精确子串(100%);
 * 线程级 2371 条里 2252 条(95%)能匹配到对应线程文本。所以「点一条陈述,高亮它在
 * 正文里的位置」是可做的;匹配不到的只列文字、不高亮,不猜位置。
 */

/** 状态 → 人能读的说法 + 是否算「有据」。 */
const STATUS_META: Record<string, { text: string; tone: 'ok' | 'warn' | 'muted'; grounded: boolean }> = {
  fact: { text: '有证据的事实', tone: 'ok', grounded: true },
  sample: { text: '来自样本/范式', tone: 'muted', grounded: false },
  inference: { text: '推断', tone: 'warn', grounded: false },
  hypothesis: { text: '假设', tone: 'warn', grounded: false },
  unknown: { text: '未知', tone: 'warn', grounded: false },
};

/** 落点字段 → 通道名。用 field 而不是 location:field 才分得清 question 与 answer。 */
const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  body: '正文',
  imageBrief: '图片说明',
  hashtags: '标签',
  question: '评论提问',
  answer: '评论回答',
  nextStep: '下一步建议',
};

export interface FactLedgerItem {
  statement: string;
  statusText: string;
  tone: 'ok' | 'warn' | 'muted';
  grounded: boolean;
  evidenceIds: string[];
  /** 能在可见文案里定位时给出通道名,否则 undefined */
  fieldLabel?: string;
}

export interface FactLedgerGroup {
  /** 通道名(正文/评论回答/…);无法归类的进「其他」 */
  label: string;
  items: FactLedgerItem[];
  groundedCount: number;
  total: number;
}

export interface FactLedgerView {
  groups: FactLedgerGroup[];
  total: number;
  groundedCount: number;
  /** 一句话结论,如「17 句里 0 句有证据支撑」 */
  headline: string;
}

/** 分组顺序:先成品可见通道,再评论,最后其他。 */
const GROUP_ORDER = ['标题', '正文', '图片说明', '标签', '评论提问', '评论回答', '下一步建议', '其他'];

export function factLedgerView(candidate?: Pick<ReaderCandidate, 'reasoning'>): FactLedgerView | null {
  const entries: ReaderReasoningEntry[] = candidate?.reasoning ?? [];
  if (entries.length === 0) return null;

  const byGroup = new Map<string, FactLedgerItem[]>();
  for (const entry of entries) {
    const meta = STATUS_META[entry.status] ?? { text: entry.status, tone: 'muted' as const, grounded: false };
    const fieldLabel = entry.field ? FIELD_LABEL[entry.field] : undefined;
    const group = fieldLabel ?? '其他';
    const item: FactLedgerItem = {
      statement: entry.statement,
      statusText: meta.text,
      tone: meta.tone,
      // 标成 fact 但没有证据编号的,不算有据:这正是 ungrounded_fact 类校验项的由来。
      grounded: meta.grounded && (entry.evidenceIds ?? []).length > 0,
      evidenceIds: entry.evidenceIds ?? [],
      fieldLabel,
    };
    const list = byGroup.get(group);
    if (list) list.push(item);
    else byGroup.set(group, [item]);
  }

  const groups: FactLedgerGroup[] = [...byGroup.entries()]
    .map(([label, items]) => ({
      label,
      items,
      groundedCount: items.filter((i) => i.grounded).length,
      total: items.length,
    }))
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.label);
      const bi = GROUP_ORDER.indexOf(b.label);
      // 不在预设顺序里的排到末尾,同级按字面稳定排序
      return (ai === -1 ? GROUP_ORDER.length : ai) - (bi === -1 ? GROUP_ORDER.length : bi)
        || a.label.localeCompare(b.label);
    });

  const total = entries.length;
  const groundedCount = groups.reduce((sum, g) => sum + g.groundedCount, 0);
  return {
    groups,
    total,
    groundedCount,
    headline: groundedCount === 0
      ? `${total} 句陈述全部没有证据支撑，属于假设或推断`
      : `${total} 句陈述里 ${groundedCount} 句有证据支撑`,
  };
}

/**
 * 一条陈述在正文里的位置。找不到返回 null——不做模糊匹配,也不猜。
 * 实测正文级标注 100% 是精确子串,所以精确匹配足够。
 */
export function locateInText(text: string, statement: string): { start: number; end: number } | null {
  if (!text || !statement) return null;
  const start = text.indexOf(statement);
  if (start === -1) return null;
  return { start, end: start + statement.length };
}
