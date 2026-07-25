import type { ReaderCandidate } from '../types';

/**
 * 按发布顺序复制。
 *
 * 现在标题/正文/标签/评论各有一个复制按钮,而「复制全部」给的是 Markdown(带 #
 * 标题、## 小节),贴到小红书要手工拆。发布时真正需要的是两块:
 * 正文区(标题+正文+标签,一次贴完)和评论区(逐条,发完帖再贴)。
 */

export interface PublishBlocks {
  /** 贴进正文编辑框的内容:标题、正文、标签 */
  post: string;
  /** 逐条评论;发帖后按顺序贴。第一条是自备首评(若有) */
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
  // 自备首评要排第一条:方法论要求它由可追责账号在发帖后立刻发。
  if (candidate.commentOwnedFirstComment) comments.push(candidate.commentOwnedFirstComment);
  for (const c of candidate.comments ?? []) {
    // 问答两行合成一条:提问是模拟读者视角的参考,回答才是发布账号要发的。
    // 两者都留着,让运营知道这条是回应什么问题。
    comments.push(`【问】${c.question}\n【答】${c.answer}`);
  }

  return { post: post.join('\n'), comments, imageBrief: candidate.imageBrief };
}

/**
 * Markdown 导出(本地拼装,不经后端,不受可发布门槛限制)。
 *
 * 与 publishOrderText 的分工:这个是给人存档/传阅的文档,带小节标题;
 * publishOrderText 是给运营直接粘贴到小红书的,不能带 Markdown 标记。
 */
export function readerCandidateToMarkdown(
  candidate: Source & Pick<ReaderCandidate, 'unknowns'>,
): string {
  const parts: string[] = [`# ${candidate.title}`, '', candidate.body];
  const tags = tagLine(candidate.tags ?? []);
  if (tags) parts.push('', tags);
  if (candidate.imageBrief) parts.push('', '## 配图说明', candidate.imageBrief);
  if (candidate.commentOwnedFirstComment) {
    parts.push('', '## 自备首评', candidate.commentOwnedFirstComment);
  }
  if ((candidate.comments ?? []).length) {
    parts.push('', '## 评论区参考');
    for (const c of candidate.comments) {
      parts.push('', `Q: ${c.question}`, `A: ${c.answer}`);
      if (c.boundary) parts.push(`边界: ${c.boundary}`);
      if (c.nextStep) parts.push(`下一步: ${c.nextStep}`);
      for (const f of c.followUps ?? []) {
        parts.push(`  · 追问: ${f.question}`, `    回应: ${f.answer}`);
      }
    }
  }
  if ((candidate.unknowns ?? []).length) {
    parts.push('', '## 仍然答不了的问题（被问到时不要代填）');
    for (const u of candidate.unknowns) parts.push(`- ${u.question}`);
  }
  return parts.join('\n');
}

/** 整份按发布顺序的纯文本:正文区 + 评论区,带分隔说明。 */
export function publishOrderText(candidate: Source): string {
  const blocks = publishBlocks(candidate);
  const parts = ['—— 正文区（直接粘贴）——', '', blocks.post];
  if (blocks.imageBrief) {
    parts.push('', '—— 配图说明（拍图/选图用，不要贴进正文）——', '', blocks.imageBrief);
  }
  if (blocks.comments.length) {
    parts.push('', `—— 评论区（发帖后按顺序贴，共 ${blocks.comments.length} 条）——`, '');
    blocks.comments.forEach((c, i) => {
      parts.push(`${i + 1}. ${c}`);
      parts.push('');
    });
    // 末尾多出的空行去掉
    if (parts.at(-1) === '') parts.pop();
  }
  return parts.join('\n');
}
