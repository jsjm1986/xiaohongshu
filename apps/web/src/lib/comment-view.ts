import type { ReaderComment } from '../types';

/**
 * 评论区可读性:补上「谁在说、这条在补哪个缺口」。
 *
 * 现在评论渲染成一列 Q/A,看不出提问的是模拟读者、回答的是可追责账号。而这个区分
 * 是有实质后果的:方法论要求答复只能由可追责身份发布,提问方必须标为模拟读者。
 * 实测 834 条线程全都带着 postingIdentity(author/publisher/staff/expert 四种)
 * 与 function(六种),界面此前全丢了。
 */

/** 封闭枚举:发布身份。 */
const IDENTITY_LABEL: Record<string, string> = {
  author: '作者本人',
  publisher: '发布账号',
  staff: '员工身份',
  expert: '专业人士',
};

/** 封闭枚举:这条线程在补什么。 */
const FUNCTION_LABEL: Record<string, string> = {
  clarify: '澄清条件',
  verification: '要求核验',
  counterexample: '反例追问',
  surface_gap: '暴露缺口',
  next_step: '下一步动作',
  answer: '直接回答',
};

/** 封闭枚举:读者所处阶段。 */
const STAGE_LABEL: Record<string, string> = {
  unaware: '还没意识到',
  collecting: '正在收集信息',
  comparing: '正在比较',
  hesitating: '犹豫中',
  ready: '准备行动',
};

export function identityLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return IDENTITY_LABEL[value] ?? value;
}

/**
 * 回答方标签按线程形态决定。
 *
 * 规划层把 postingIdentity 统一赋给每个线程（含读者互聊与漂浮短反应），所以它
 * 不能单独作为「谁在答」的依据：reader_exchange 的 answer 是另一位模拟读者接话，
 * organic_reaction 按设计根本没有机构答复（answer 恒空）。无条件套 identityLabel
 * 会把读者说的「我也这么觉得」标成机构 IP 发言。
 */
export function answererLabelFor(comment: {
  threadKind?: string;
  postingIdentity?: string;
  answer?: string;
}): string | undefined {
  const kind = comment.threadKind ?? 'org_answer';
  if (kind === 'organic_reaction') return undefined;
  if (kind === 'reader_exchange') {
    return comment.answer?.trim() ? '模拟读者接话' : undefined;
  }
  return identityLabel(comment.postingIdentity);
}

export function commentFunctionLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return FUNCTION_LABEL[value] ?? value;
}

export function stageLabel(value?: string): string | undefined {
  if (!value) return undefined;
  return STAGE_LABEL[value] ?? value;
}

export interface CommentRow {
  id?: string;
  question: string;
  answer: string;
  /** 线程互动形态:决定 answererLabel 与 identitySummary 的口径。 */
  threadKind?: string;
  /** 提问方标签:模拟读者(全部线程实测 simulated=true) */
  askerLabel: string;
  /**
   * 回答方标签:仅 org_answer 线程才是可追责身份。reader_exchange/
   * organic_reaction 的 answer 是模拟读者接话,标成机构身份会把读者说的
   * 「我也这么觉得」「同好，我打算先打电话问问」渲染成员工发言。
   */
  answererLabel?: string;
  /** 开放文本,原样显示 */
  personaRole?: string;
  functionLabel?: string;
  stageLabel?: string;
  /** 这条承担的缺口名(需要外部传入 gap 名称表;拿不到时不显示裸 id) */
  gapLabel?: string;
  boundary?: string;
  nextStep?: string;
  displayName?: string;
  followUps: Array<{ question: string; answer: string; boundary?: string }>;
}

export interface CommentSectionView {
  rows: CommentRow[];
  /** 有多少条带追问(实测 42/834,所以大多数不显示追问区) */
  withFollowUps: number;
  /** 回答方身份的种类统计,用来说明「答复都由谁发」 */
  identitySummary: string[];
}

/**
 * gapNames: gapId → 缺口名。来自 reader 视图的 gapCards / gapLedger;
 * 查不到就不显示,而不是把 UUID 摆给用户看。
 */
export function commentSectionView(
  comments: ReaderComment[] | undefined,
  gapNames: Map<string, string> = new Map(),
): CommentSectionView | null {
  const list = comments ?? [];
  if (list.length === 0) return null;

  const rows: CommentRow[] = list.map((c) => ({
    id: c.id,
    question: c.question,
    answer: c.answer,
    threadKind: c.threadKind,
    // simulated 缺失的历史包不能默认成"真实读者"——那是更强的断言。
    askerLabel: c.simulated === false ? '未标记为模拟' : '模拟读者',
    // 只有 org_answer 的 answer 出自可追责身份。reader_exchange/organic_reaction
    // 的 answer 是模拟读者接话,却同样带着 postingIdentity(规划层按线程统一赋值),
    // 无条件打标签会把读者发言渲染成员工/机构发言——实测三篇 20/20 条全部错标。
    // threadKind 缺失的历史包按 org_answer 处理,保持旧行为。
    answererLabel: answererLabelFor(c),
    personaRole: c.personaRole,
    functionLabel: commentFunctionLabel(c.function),
    stageLabel: stageLabel(c.stage),
    gapLabel: c.gap ? gapNames.get(c.gap) : undefined,
    boundary: c.boundary,
    nextStep: c.nextStep,
    displayName: c.displayName,
    followUps: c.followUps ?? [],
  }));

  // identitySummary 回答的是「答复都由哪些可追责身份发」,所以只统计 org_answer
  // 线程的身份;把「模拟读者接话」混进去会让这份声明失真。
  const identities = [...new Set(
    rows
      .filter((row) => (row.threadKind ?? 'org_answer') === 'org_answer')
      .map((row) => row.answererLabel)
      .filter((value): value is string => Boolean(value)),
  )];
  return {
    rows,
    withFollowUps: rows.filter((r) => r.followUps.length > 0).length,
    identitySummary: identities,
  };
}

/** 缺口 id → 名称表。gapCards 优先(它带原始问题),台账兜底。 */
export function gapNameMap(
  gapCards?: Array<{ gapId: string; label: string }>,
  ledgerEntries?: Array<{ gapId: string; label: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of ledgerEntries ?? []) {
    if (entry.gapId && entry.label) map.set(entry.gapId, entry.label);
  }
  for (const card of gapCards ?? []) {
    if (card.gapId && card.label) map.set(card.gapId, card.label);
  }
  return map;
}
