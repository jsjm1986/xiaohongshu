import { Bookmark, Copy, Heart, MessageCircle } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { commentTotal, NoteComments } from './NoteComments';
import { accountName, avatarTone, noteDate } from '../../lib/note-view';
import type { NoteCommentsSource } from './NoteComments';
import type { ReaderCandidate, ReaderJob } from '../../types';

/**
 * 按结构最小面收参,而不是要求一个完整的 ReaderCandidate。
 *
 * 阅读页给的是阅读投影,创作区生成完手里只有 QuickCandidateView(字段更少)。两处
 * 要看的是同一件事「这篇发出去长什么样」,所以本组件只声明自己真正读的字段,
 * 让两条数据源都能喂进来——否则创作区就得另写一套预览,那正是这次要消除的分裂。
 */
export type NoteCardSource = Pick<ReaderCandidate, 'title' | 'body' | 'tags' | 'imageBrief'> &
  NoteCommentsSource;

interface Props {
  candidate: NoteCardSource;
  job: Pick<ReaderJob, 'completedAt' | 'createdAt'>;
  projectName?: string;
  /** 自动校验未通过时，需人工确认后才开放任何复制入口。 */
  copyEnabled?: boolean;
}

/**
 * 仿真笔记预览。
 *
 * 只做一件事:把这一版成品渲染成「发出去会长什么样」。它不知道校验、导出、改稿的
 * 存在——那些在下方工作区。
 *
 * 两处刻意的不仿真:
 * - 点赞/收藏只有图标,不带数字。系统没有平台数据,编一个「129 赞」一旦出现在界面
 *   上,用户截图给老板时它就成了业绩证据,与「研究数据不是平台表现数据」这条红线
 *   直接冲突。图标不构成断言,数字构成。
 * - 配图位是虚线框 + 配图说明文字。系统只产出拍摄要求,没有真图;放一张占位图会让
 *   人以为配图已经有了。
 */
export function NoteCard({ candidate, job, projectName, copyEnabled = true }: Props) {
  const toast = useToast();
  const account = accountName(projectName);
  const tone = avatarTone(account);
  const date = noteDate(job);
  const comments = commentTotal(candidate);

  const copy = async (text: string, label = '已复制') => {
    if (!copyEnabled) { toast.push('该候选未通过可发布校验，不能复制或导出', 'error'); return; }
    try { await navigator.clipboard.writeText(text); toast.push(label); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  // 「复制全文」= 能原样粘进小红书发布框的东西,只有 title/body/tags。
  // imageBrief 刻意不在其中,它是给摄影/选图的拍摄指令,不是发布内容——混进去会被误发。
  // 配图说明有自己的复制按钮(见下方 xhs-note__cover),不要为了「补全」把它拼到这里。
  const fullText = [candidate.title, candidate.body, candidate.tags.join(' ')]
    .filter((part) => part && part.trim())
    .join('\n\n');

  return (
    <article className="xhs-note">
      <header className="xhs-note__head">
        <span className="xhs-note__avatar" style={{ background: tone.bg, color: tone.fg }}>{tone.initial}</span>
        <span className="xhs-note__account">{account}</span>
        {/* 装饰,不可点:这是预览,没有真实的关注关系可建立 */}
        <span className="xhs-note__follow" aria-hidden="true">关注</span>
        <Button variant="ghost" icon={<Copy size={13} />} disabled={!copyEnabled} onClick={() => void copy(fullText, '已复制全文')}>
          复制全文
        </Button>
      </header>

      {candidate.imageBrief && (
        <div className="xhs-note__cover">
          {/* 配图说明是要被复制走交给摄影/选图的,所以它需要自己的复制入口:
              「复制全文」按设计不含它。按钮与说明标签同一行,不挤压虚线框里的正文。 */}
          <div className="xhs-note__unit">
            <p>{candidate.imageBrief}</p>
            <Button variant="ghost" icon={<Copy size={12} />} disabled={!copyEnabled} onClick={() => void copy(candidate.imageBrief!, '已复制配图说明')} aria-label="复制配图说明" />
          </div>
          <small>配图说明 · 按此拍摄或选图</small>
        </div>
      )}

      <div className="xhs-note__body">
        {candidate.title && (
          <div className="xhs-note__unit">
            <h2 className="xhs-note__title">{candidate.title}</h2>
            <Button variant="ghost" icon={<Copy size={12} />} disabled={!copyEnabled} onClick={() => void copy(candidate.title, '已复制标题')} aria-label="复制标题" />
          </div>
        )}
        {candidate.body?.trim()
          ? (
            <div className="xhs-note__unit">
              <p className="xhs-note__text">{candidate.body}</p>
              <Button variant="ghost" icon={<Copy size={12} />} disabled={!copyEnabled} onClick={() => void copy(candidate.body, '已复制正文')} aria-label="复制正文" />
            </div>
          )
          : <p className="xhs-note__text xhs-note__text--empty">本次未产出正文</p>}

        {candidate.tags.length > 0 && (
          <div className="xhs-note__unit">
            <div className="xhs-note__tags">
              {candidate.tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
            <Button variant="ghost" icon={<Copy size={12} />} disabled={!copyEnabled} onClick={() => void copy(candidate.tags.join(' '), '已复制话题')} aria-label="复制话题" />
          </div>
        )}

        {date && <div className="xhs-note__date">{date}</div>}
      </div>

      {/* 无数字:见组件头注释。唯一的例外是评论数——它是本产品声称如实的数字,
          且必须与下方评论区标题同源(commentTotal),否则同一张卡上两个数字打架。 */}
      <div className="xhs-note__bar">
        <span><Heart size={15} />点赞</span>
        <span><Bookmark size={15} />收藏</span>
        <span><MessageCircle size={15} />评论{comments > 0 ? ` ${comments}` : ''}</span>
      </div>

      <NoteComments candidate={candidate} accountLabel={account} copyEnabled={copyEnabled} />
    </article>
  );
}
