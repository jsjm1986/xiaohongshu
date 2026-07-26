import { Copy, Info } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { commentSectionView, gapNameMap } from '../../lib/comment-view';
import { avatarTone } from '../../lib/note-view';
import type { ReaderCandidate } from '../../types';

type Source = Pick<
  ReaderCandidate,
  'comments' | 'commentDisclaimer' | 'commentOwnedFirstComment' | 'gapCards' | 'gapLedger'
>;

export interface NoteCommentsProps {
  candidate: Source;
  /** 发布账号名,用于自备首评与机构答复的署名 */
  accountLabel: string;
}

/**
 * 仿真评论区。
 *
 * 与旧 CommentSection 的区别不只是样式:那版把每条都打上「模拟读者」「员工身份」
 * 徽标,并把 boundary/nextStep/承担缺口平铺在问答旁边——内部编排指令直接展示给
 * 用户,而且徽标密度高到看不出这是一条评论。
 *
 * 这里改成会话流:昵称用模型产出的真实 displayName(实测「打呼的小海豹」「酸梅汤
 * 加冰」这类),楼层缩进,追问跟在下面。口径收到一处:标题行一个 ⓘ 承载
 * 「情景演练参考,非真实用户发言」。这个 ⓘ 不能删——界面不声明就等于在断言这些是
 * 真实留言,而方法论明确禁止假冒消费者。编排信息移交工作区 CommentPlanCard。
 */
export function NoteComments({ candidate, accountLabel }: NoteCommentsProps) {
  const toast = useToast();
  const view = commentSectionView(
    candidate.comments,
    gapNameMap(candidate.gapCards, candidate.gapLedger?.entries),
  );
  if (!view) return null;

  const copyOne = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  const total = view.rows.length + (candidate.commentOwnedFirstComment ? 1 : 0);

  return (
    <section className="xhs-comments">
      <header className="xhs-comments__head">
        <span>共 {total} 条评论</span>
        {/* 声明挂在 ⓘ 的 title 上而不是常驻一行:预览区要沉浸,但这句必须可达。 */}
        <span
          className="xhs-comments__note"
          title={candidate.commentDisclaimer || '情景演练与答复参考，不代表真实用户发言。'}
          aria-label="关于这些评论"
        >
          <Info size={12} />
        </span>
      </header>

      {candidate.commentOwnedFirstComment && (
        <Row
          name={accountLabel}
          badge="作者"
          text={candidate.commentOwnedFirstComment}
          onCopy={() => void copyOne(candidate.commentOwnedFirstComment!)}
        />
      )}

      {view.rows.map((row, i) => (
        <Row
          key={row.id ?? `${row.question}-${i}`}
          name={row.displayName || '读者'}
          text={row.question}
          onCopy={() => void copyOne(row.question)}
          reply={
            row.answer?.trim()
              ? {
                  // answererLabel 已由 comment-view 按 threadKind 判定:只有 org_answer
                  // 才是可追责身份,reader_exchange 是模拟读者接话。这里据此决定署名和
                  // 「作者」标,不自己重判。
                  name: row.answererLabel === '模拟读者接话' ? (row.displayName ? '另一位读者' : '读者') : accountLabel,
                  badge: row.answererLabel && row.answererLabel !== '模拟读者接话' ? '作者' : undefined,
                  text: row.answer,
                  onCopy: () => void copyOne(row.answer),
                }
              : undefined
          }
          followUps={row.followUps.filter((f) => f.question?.trim())}
          onCopyFollow={(text) => void copyOne(text)}
          followReply={
            row.answererLabel && row.answererLabel !== '模拟读者接话'
              ? { name: accountLabel, badge: '作者' }
              : { name: '读者' }
          }
        />
      ))}
    </section>
  );
}

interface RowProps {
  name: string;
  badge?: string;
  text: string;
  onCopy: () => void;
  reply?: { name: string; badge?: string; text: string; onCopy: () => void };
  followUps?: Array<{ question: string; answer: string }>;
  onCopyFollow?: (text: string) => void;
  /** 追问答复的署名:与主答复同一套判定结果,org_answer 才带「作者」标 */
  followReply?: { name: string; badge?: string };
}

function Row({ name, badge, text, onCopy, reply, followUps = [], onCopyFollow, followReply }: RowProps) {
  const tone = avatarTone(name);
  return (
    <div className="xhs-comment">
      <span className="xhs-comment__avatar" style={{ background: tone.bg, color: tone.fg }}>{tone.initial}</span>
      <div className="xhs-comment__main">
        <div className="xhs-comment__name">
          {name}
          {badge && <em>{badge}</em>}
          <Button variant="ghost" icon={<Copy size={11} />} onClick={onCopy} aria-label="复制这条" />
        </div>
        <p className="xhs-comment__text">{text}</p>

        {reply && (
          <div className="xhs-comment__reply">
            <div className="xhs-comment__name">
              {reply.name}
              {reply.badge && <em>{reply.badge}</em>}
              <Button variant="ghost" icon={<Copy size={11} />} onClick={reply.onCopy} aria-label="复制答复" />
            </div>
            <p className="xhs-comment__text">{reply.text}</p>
          </div>
        )}

        {followUps.map((f, i) => (
          <div key={`${f.question}-${i}`} className="xhs-comment__reply">
            <div className="xhs-comment__name">
              读者
              {onCopyFollow && (
                <Button variant="ghost" icon={<Copy size={11} />} onClick={() => onCopyFollow(f.question)} aria-label="复制追问" />
              )}
            </div>
            <p className="xhs-comment__text">{f.question}</p>
            {/* organic_reaction 按设计没有机构答复,空答复不渲染出一行空白。
                追问答复(org_answer 线程是机构补充)要单独成署名块,不能吸进读者楼层。 */}
            {f.answer?.trim() && (
              <div className="xhs-comment__reply">
                <div className="xhs-comment__name">
                  {followReply?.name ?? '读者'}
                  {followReply?.badge && <em>{followReply.badge}</em>}
                  {onCopyFollow && (
                    <Button variant="ghost" icon={<Copy size={11} />} onClick={() => onCopyFollow(f.answer)} aria-label="复制追问答复" />
                  )}
                </div>
                <p className="xhs-comment__text">{f.answer}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
