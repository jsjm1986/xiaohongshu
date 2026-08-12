import type { ReaderCandidate } from '../types';
import {
  ACCOUNTABLE_ANSWER_COPY_LABEL,
  SIMULATED_COMMENT_COPY_NOTICE,
  SIMULATED_QUESTION_COPY_LABEL,
  SIMULATED_REACTION_COPY_LABEL,
  SIMULATED_REPLY_COPY_LABEL,
} from './simulation-notice';

/**
 * 按发布顺序复制。
 *
 * 正文区（标题+正文+标签）是真正可直接粘贴发布的内容；评论区不是——
 * 它是「模拟情景话术参考」：模拟提问与读者接话没有任何真人为其负责，
 * 由任何账号代发都是伪造真实用户发言。所以评论条目必须逐条携带角色标注，
 * 段落自带用途声明；只有自备首评与可追责答复标明「本账号」用途。
 */

export interface PublishBlocks {
  /** 贴进正文编辑框的内容:标题、正文、标签 */
  post: string;
  /**
   * 评论区话术参考（模拟情景）:逐条带角色标注。
   * 只有「自备首评」与「本账号答复参考」允许本账号使用;
   * 标注「勿代发」的条目不得由任何账号发布。
   */
  comments: string[];
  /** 图片简报:拍图/选图时用,不进正文 */
  imageBrief?: string;
}

type Source = Pick<
  ReaderCandidate,
  'title' | 'body' | 'tags' | 'imageBrief' | 'comments' | 'commentOwnedFirstComment'
>;

/** 标签统一带 #,不重复加。 */
function tagLine(tags: string[]): string {
  return tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
}

export function publishBlocks(candidate: Source): PublishBlocks {
  const post = [candidate.title, '', candidate.body];
  const tags = tagLine(candidate.tags ?? []);
  if (tags) {
    post.push('');
    post.push(tags);
  }

  const comments: string[] = [];
  // 自备首评是方法论要求由可追责账号在发帖后立刻发布的那条,标注其归属。
  if (candidate.commentOwnedFirstComment) {
    comments.push(`【自备首评 · 本账号发布】\n${candidate.commentOwnedFirstComment}`);
  }
  for (const c of candidate.comments ?? []) {
    const kind = c.threadKind ?? 'org_answer';
    // 漂浮短反应整条只有一个模拟读者的话,没有答复。
    if (kind === 'organic_reaction') {
      comments.push(`${SIMULATED_REACTION_COPY_LABEL}\n${c.question}`);
      continue;
    }
    // 读者互聊:提问与接话都是模拟读者,两侧都不得代发。
    if (kind === 'reader_exchange') {
      comments.push(`${SIMULATED_QUESTION_COPY_LABEL}\n${c.question}\n${SIMULATED_REPLY_COPY_LABEL}\n${c.answer}`);
      continue;
    }
    // org_answer / host_reply:提问是模拟读者视角的预判,答复出自可追责账号,
    // 供本账号在收到真实提问后参考使用。
    comments.push(`${SIMULATED_QUESTION_COPY_LABEL}\n${c.question}\n${ACCOUNTABLE_ANSWER_COPY_LABEL}\n${c.answer}`);
  }

  return { post: post.join('\n'), comments, imageBrief: candidate.imageBrief };
}

/**
 * Markdown 导出(本地拼装,给人存档/传阅的文档,带小节标题)。
 * 评论段与 publishOrderText 同一套角色标注与段落声明。
 */
export function readerCandidateToMarkdown(
  candidate: Source & Pick<ReaderCandidate, 'unknowns'>,
): string {
  const parts: string[] = [`# ${candidate.title}`, '', candidate.body];
  const tags = tagLine(candidate.tags ?? []);
  if (tags) parts.push('', tags);
  if (candidate.imageBrief) parts.push('', '## 配图说明', candidate.imageBrief);
  if (candidate.commentOwnedFirstComment) {
    parts.push('', '## 自备首评（本账号发布）', candidate.commentOwnedFirstComment);
  }
  if ((candidate.comments ?? []).length) {
    parts.push('', '## 评论区话术参考（模拟情景 · 非真实评论）', `> ${SIMULATED_COMMENT_COPY_NOTICE}`);
    for (const c of candidate.comments) {
      const kind = c.threadKind ?? 'org_answer';
      parts.push('');
      if (kind === 'organic_reaction') {
        parts.push(`模拟读者短反应（勿代发）: ${c.question}`);
        continue;
      }
      parts.push(`模拟提问（勿代发）: ${c.question}`);
      parts.push(kind === 'reader_exchange'
        ? `模拟读者接话（勿代发）: ${c.answer}`
        : `本账号答复参考: ${c.answer}`);
      if (c.boundary) parts.push(`边界: ${c.boundary}`);
      if (c.nextStep) parts.push(`下一步: ${c.nextStep}`);
      for (const f of c.followUps ?? []) {
        parts.push(`  · 模拟追问（勿代发）: ${f.question}`);
        parts.push(kind === 'reader_exchange'
          ? `    模拟读者接话（勿代发）: ${f.answer}`
          : `    本账号答复参考: ${f.answer}`);
      }
    }
  }
  if ((candidate.unknowns ?? []).length) {
    parts.push('', '## 仍然答不了的问题（被问到时不要代填）');
    for (const u of candidate.unknowns) parts.push(`- ${u.question}`);
  }
  return parts.join('\n');
}

/** 整份按发布顺序的纯文本:正文区（可直接粘贴） + 评论区话术参考（模拟情景）。 */
export function publishOrderText(candidate: Source): string {
  const blocks = publishBlocks(candidate);
  const parts = ['—— 正文区（直接粘贴）——', '', blocks.post];
  if (blocks.imageBrief) {
    parts.push('', '—— 配图说明（拍图/选图用，不要贴进正文）——', '', blocks.imageBrief);
  }
  if (blocks.comments.length) {
    parts.push(
      '',
      `—— 评论区话术参考（模拟情景 · 共 ${blocks.comments.length} 条）——`,
      SIMULATED_COMMENT_COPY_NOTICE,
      '',
    );
    blocks.comments.forEach((c, i) => {
      parts.push(`${i + 1}. ${c}`);
      parts.push('');
    });
    // 末尾多出的空行去掉
    if (parts.at(-1) === '') parts.pop();
  }
  return parts.join('\n');
}
