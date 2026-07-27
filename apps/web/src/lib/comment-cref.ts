import type { DeploymentPlan, InformationGapPlanningCard } from "../types";

/**
 * Pure display helpers for the Cref contract v1.1 fields (thread kind /
 * answerKind / boundary, Cref-level ownedFirstComment / uncoveredGaps, and the
 * structured aC deployment rules). Every helper tolerates absent fields so
 * historical packages render exactly as before — never "undefined".
 */

/** Dialogic node kind → Chinese badge label; unknown values pass through raw. */
export const commentNodeKindLabel = (value?: string): string => {
  const labels: Record<string, string> = {
    question: "问题",
    answer: "回答",
    follow_up: "追问",
    clarification: "澄清",
  };
  return value ? labels[value] || value : "未标注";
};

/**
 * 线程级互动形态(读者互动层)归一化:缺省或不可识别的值一律按
 * org_answer(T1 机构问答)处理——历史包没有 threadKind 字段,界面与
 * 复制markdown 都按 T1 渲染,不出错。
 */
export const commentThreadKindOf = (thread: { threadKind?: string }): "org_answer" | "reader_exchange" | "organic_reaction" =>
  thread.threadKind === "reader_exchange" || thread.threadKind === "organic_reaction"
    ? thread.threadKind
    : "org_answer";

/** 线程级互动形态 → 中文徽标;未知值原样透传。 */
export const commentThreadKindLabel = (value?: string): string => {
  const labels: Record<string, string> = {
    org_answer: "机构问答",
    reader_exchange: "读者互聊",
    organic_reaction: "漂浮短反应",
  };
  return value ? labels[value] || value : "机构问答";
};

/**
 * Accountable posting identity for display. `publisher` (v1.1) is the
 * publishing account itself; historical enum/raw values pass through.
 */
export const postingIdentityText = (value?: string): string => {
  if (!value) return "";
  return value === "publisher" ? "发布账号（publisher）" : value;
};

/**
 * 审计附录里「这条 answer 由谁发出」的一行。返回 {label, identity}:
 * label 是答复块的前缀,identity 是身份行的值。
 *
 * 存在的理由是**一处实现**。正文区早就按 threadKind 分路了(reader_exchange 写
 * 「读者接话」并署 replyDisplayName),但审计附录两处漏了,于是同一份 markdown 里
 * 同一句读者接话在正文标读者、在附录标机构——实测 198 条线程受影响,横跨 8 个项目。
 * 附录那句「答复身份：staff」会被读成机构助理在说「同问，这个很关键」,等于把消费者
 * 的话挂到自有账号名下,正是方法论《ROLE 04》禁止的反向踩线。
 *
 * reader_exchange 的 answer 是另一位模拟读者接话,数据里 replyDisplayName 就带着
 * 正确昵称(如「芒果糯米饭」);postingIdentity 是规划层按线程统一赋的**答复方预留
 * 身份**,不表示谁在说话——这一点 comment-view.answererLabelFor 与
 * NoteComments.replyIdentity 的注释都写过,附录只是没跟上。
 *
 * organic_reaction 的 answer 按设计恒空,走不到这里;threadKind 缺失的历史包按
 * org_answer 兜底,与其余判定同一套口径。
 */
export const auditAnswerAttribution = (
  thread: { threadKind?: string; postingIdentity?: string; replyDisplayName?: string },
): { label: string; identity: string } => {
  if (commentThreadKindOf(thread) === "reader_exchange") {
    return {
      label: thread.replyDisplayName?.trim()
        ? `模拟读者接话（${thread.replyDisplayName.trim()}）`
        : "模拟读者接话",
      // 不写「未标注」:这条 answer 本就不该有可追责身份,空缺不是数据缺失。
      identity: "不适用（读者互聊，非机构发言）",
    };
  }
  return {
    label: "楼主/可追责身份回复",
    identity: postingIdentityText(thread.postingIdentity) || "可追责发布者",
  };
};

/**
 * 答复徽标:org_answer 线程按 postingIdentity 分路。三者都是方法论里的
 * accountable_responder(可追责答复方),差别只在承接什么话头——
 * publisher 发布账号本人(直接回答＋条件＋边界＋下一步)、staff 营销承接
 * (价格/预约/地址)、expert 专业解答。publisher 不是顾客人设:方法论
 * 《ROLE 04 · 发布账号》「自有账号不能冒充独立消费者」。历史/其他 postingIdentity
 * (author/brand/reader_question_template)返回 undefined,由调用方走
 * identityLabel 兜底,不裸露也不误标。
 */
export const orgAnswerIdentityBadge = (
  postingIdentity?: string,
): { text: string; tone: "blue" | "positive" | "neutral" } | undefined => {
  switch (postingIdentity) {
    case "staff": return { text: "机构助理 · 营销承接", tone: "blue" };
    case "expert": return { text: "机构 IP · 专业解答", tone: "positive" };
    case "publisher": return { text: "发布账号 · 可追责答复", tone: "neutral" };
    default: return undefined;
  }
};

type LiveRoutingEntry = NonNullable<DeploymentPlan["liveRouting"]>[number];

/**
 * Render one liveRouting entry as a display line. Handles the v1.1 structured
 * {route,condition,action} rule, the legacy {intent,target,reason} object and
 * the historical plain-string form. Non-usable entries are dropped.
 */
export const liveRoutingLine = (item: LiveRoutingEntry): string => {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const structured = item as { route?: string; condition?: string; action?: string };
  if (structured.route || structured.condition || structured.action) {
    const head = [structured.route, structured.condition].filter(Boolean).join("（") + (structured.route && structured.condition ? "）" : "");
    return [head, structured.action].filter(Boolean).join(" → ");
  }
  const legacy = item as { intent?: string; target?: string; reason?: string };
  if (legacy.intent || legacy.target) {
    return `${legacy.intent || "未命名意图"} → ${legacy.target || "未命名去向"}${legacy.reason ? `：${legacy.reason}` : ""}`;
  }
  return "";
};

export const liveRoutingLines = (value: DeploymentPlan["liveRouting"]): string[] =>
  (Array.isArray(value) ? value : []).map(liveRoutingLine).filter(Boolean);

/** SLA display value: current `sla` wins; the deprecated historical alias stays readable. */
export const deploymentSla = (plan: DeploymentPlan): string | undefined =>
  plan.sla || plan.responseSla || undefined;

/**
 * Resolve Cref-level uncovered gap ids to human labels via the orchestration
 * gap planning cards; unresolved ids pass through raw (they are honest ids,
 * not fabricated labels).
 */
export const uncoveredGapLabels = (
  ids: string[] | undefined,
  // 只用到 gapId/label,所以按结构最小面收参:阅读页的 ReaderCandidate.gapCards 是
  // InformationGapPlanningCard 的窄化投影(没有 category/importance 等),原签名会把它挡在外面。
  cards?: Array<Pick<InformationGapPlanningCard, "gapId" | "label">>,
): string[] =>
  (ids || []).map((id) => cards?.find((card) => card.gapId === id)?.label || id);
