/**
 * 模拟情景标注 —— 合规红线的「出口层」兜底。
 *
 * 生成层（agent-core 的 SI02 硬安全不变量）保证参考评论在系统内部永远带着模拟
 * 身份；但文本一旦被复制或导出就离开了系统，界面上的 ⓘ 声明跟不出去。
 * 所以任何携带模拟读者发言的复制物与导出物，都必须自带不可剥离的标注：
 *
 * - 模拟提问 / 读者接话 / 漂浮短反应：这些话没有任何真人为其负责，任何账号
 *   把它们发出去都是伪造真实用户发言 —— 一律带「勿代发」标注；
 * - 机构 / 楼主答复：是可追责账号自己的话。本账号在收到真实提问后引用它是
 *   合法用途，所以答复原文可复制；成段导出时由段落级声明说明用途边界。
 */

/** 段落级声明：出现在「按发布顺序复制」与 Markdown 导出的评论区段落头部。 */
export const SIMULATED_COMMENT_COPY_NOTICE =
  '评论区话术为模拟情景参考，不代表真实用户发言：模拟提问、读者接话与短反应不得由任何账号代发；答复仅供本账号在收到真实提问后参考使用。';

export const SIMULATED_QUESTION_COPY_LABEL = '【模拟读者提问 · 勿代发】';
export const SIMULATED_REPLY_COPY_LABEL = '【模拟读者接话 · 勿代发】';
export const SIMULATED_REACTION_COPY_LABEL = '【模拟读者短反应 · 勿代发】';
export const ACCOUNTABLE_ANSWER_COPY_LABEL = '【本账号答复参考 · 回应真实提问时使用】';

/** 未通过可发布校验的稿件，在本地导出文档顶部必须携带的水印。 */
export const DRAFT_EXPORT_WATERMARK = '⚠ 本稿未通过可发布校验，仅供人工核对，不得直接发布。';

export type CommentCopyNode = 'question' | 'answer' | 'follow_up_question' | 'follow_up_answer';

/**
 * 可追责答复线程的白名单：只有这两类的 answer 出自可追责账号，允许原文复制。
 *
 * 判定用白名单而不是排除法（fail-closed）：将来新增一种模拟读者线程类型时，
 * 未升级的这段代码会把它的答复当模拟发言标注（多标无害），而不是当可追责
 * 发言原文放行（漏标即合规事故）。threadKind 缺失的历史包按 org_answer 处理，
 * 与 NoteComments.replyIdentity 的兜底一致。
 */
const ACCOUNTABLE_ANSWER_THREAD_KINDS = new Set(['org_answer', 'host_reply']);

/**
 * 单条评论节点的复制载荷。
 *
 * 判定只由 threadKind 与节点位置决定（与 NoteComments.replyIdentity 同一原则：
 * 身份归属不挂在展示文案上）：
 * - 一切提问侧节点都是模拟读者发言 → 带「勿代发」标注；
 * - organic_reaction 整条只有一个模拟读者短反应；
 * - 白名单内（org_answer / host_reply）的答复出自可追责账号 → 原文返回，
 *   允许该账号在回应真实提问时直接使用；
 * - 其余（reader_exchange 与任何未知形态）的答复按模拟读者接话标注。
 */
export function labeledCommentCopy(
  threadKind: string | undefined,
  node: CommentCopyNode,
  text: string,
): string {
  const kind = threadKind ?? 'org_answer';
  if (kind === 'organic_reaction') return `${SIMULATED_REACTION_COPY_LABEL}\n${text}`;
  if (node === 'question' || node === 'follow_up_question') {
    return `${SIMULATED_QUESTION_COPY_LABEL}\n${text}`;
  }
  if (ACCOUNTABLE_ANSWER_THREAD_KINDS.has(kind)) return text;
  return `${SIMULATED_REPLY_COPY_LABEL}\n${text}`;
}
