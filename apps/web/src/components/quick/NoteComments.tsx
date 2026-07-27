import { useState } from 'react';
import { Copy, Info } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { commentSectionView, gapNameMap } from '../../lib/comment-view';
import { avatarTone } from '../../lib/note-view';
import type { ReaderCandidate, ReaderComment } from '../../types';

/**
 * 本组件真正读的字段。gapCards / gapLedger 只用于把 gap id 换成名称,可选——
 * 创作区的候选没有这两项,缺了就不显示缺口名,不影响评论本身的渲染。
 */
export type NoteCommentsSource = {
  /**
   * followUps 声明为可选:阅读投影里它必有(空数组),而创作区的 QuickComment 是可选的。
   * commentSectionView 内部本来就 `c.followUps ?? []`,运行时早已容错,只有类型偏严。
   */
  comments: Array<Omit<ReaderComment, 'followUps'> & { followUps?: ReaderComment['followUps'] }>;
  commentDisclaimer?: string;
  commentOwnedFirstComment?: string;
} & Partial<Pick<ReaderCandidate, 'gapCards' | 'gapLedger'>>;

/** @deprecated 保留旧名以免外部引用断裂;新代码用 NoteCommentsSource。 */
type Source = NoteCommentsSource;

export interface NoteCommentsProps {
  candidate: Source;
  /** 发布账号名,用于自备首评与机构答复的署名 */
  accountLabel: string;
}

/** 默认免责声明:候选没带 commentDisclaimer 时兜底,声明本身不允许缺席。 */
export const COMMENT_DISCLAIMER_FALLBACK = '情景演练与答复参考，不代表真实用户发言。';

/**
 * 答复(主答复与追问答复共用)的署名由所属线程的 threadKind 决定。
 *
 * 只有 reader_exchange 的 answer 是另一位模拟读者接话,署名机构就是假冒机构表态;
 * 其余线程的 answer 都是机构发言,必须带可追责身份:
 * - org_answer:机构答复与补充口径(「只要是教练私下额外收费…一样是换教练、全额退」)。
 * - organic_reaction:实测库内 6 条线程的 answer 全是机构口径(如「不承诺录取结果、
 *   不承诺奖学金、不承诺签证通过」,postingIdentity=publisher),恰恰是在声明合规边界,
 *   缺了「作者」标等于把担责的那句话摘掉署名。
 * - threadKind 缺失的历史包按 org_answer 处理,与 comment-view 的 answererLabelFor 同一套兜底。
 *
 * 刻意不看 answererLabel:那是给人看的中文标签,按它比字符串会让「改个措辞」变成
 * 「改身份归属」。抽成纯函数是为了让这个判定可被测试覆盖——它是本组件唯一有真假之分
 * 的分支,其余都是排版。displayName 只影响读者侧的称呼,与是否机构无关。
 */
export function replyIdentity(
  threadKind: string | undefined,
  accountLabel: string,
  displayName?: string,
): { name: string; badge?: string } {
  if ((threadKind ?? 'org_answer') === 'reader_exchange') {
    // 提问者已用 displayName 署名,答复者是「另一位」才说得通;没昵称时只能说「读者」。
    return { name: displayName ? '另一位读者' : '读者' };
  }
  return { name: accountLabel, badge: '作者' };
}

/**
 * 评论总数:自备首评是运营真的要贴上去的一条评论,所以它算数。
 *
 * 互动条的「评论 N」与评论区标题的「共 N 条评论」必须同源——同一张卡上两个数字打架时,
 * 用户没法判断哪个是真的,而条数是本产品唯一声称如实的数字。
 */
export function commentTotal(candidate: Pick<Source, 'comments' | 'commentOwnedFirstComment'>): number {
  return (candidate.comments?.length ?? 0) + (candidate.commentOwnedFirstComment ? 1 : 0);
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
  const [noteOpen, setNoteOpen] = useState(false);
  const view = commentSectionView(
    candidate.comments,
    gapNameMap(candidate.gapCards, candidate.gapLedger?.entries),
  );
  if (!view) return null;

  const copyOne = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  const total = commentTotal(candidate);
  const disclaimer = candidate.commentDisclaimer || COMMENT_DISCLAIMER_FALLBACK;

  return (
    <section className="xhs-comments">
      <header className="xhs-comments__head">
        <span>共 {total} 条评论</span>
        {/* 声明挂在 ⓘ 上而不是常驻一行:预览区要沉浸,但这句必须可达。
            必须是真 button,不是带 aria-label 的 span:span 的隐含角色是 generic,
            author-supplied name 在规范里是禁止的,读屏软件可以直接丢掉 aria-label;
            而 title 在触屏(本产品主场景)根本不出 tooltip。button 上 aria-label 合法,
            且点一下就能把声明原文摊开——触屏也能读到。
            aria-label 放声明全文而非「关于这些评论」——后者会把声明从无障碍树里盖掉。 */}
        <button
          type="button"
          className="xhs-comments__note"
          title={disclaimer}
          aria-label={disclaimer}
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((open) => !open)}
        >
          <Info size={12} />
        </button>
      </header>
      {noteOpen && <p className="xhs-comments__disclaimer">{disclaimer}</p>}

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
                  // 主答复与追问答复走同一个 replyIdentity:身份归属只能由 threadKind 决定。
                  // 曾经这里比对 answererLabel === '模拟读者接话',把合规判定绑在一句中文
                  // 文案上——改个措辞就会把读者接话集体署名成机构。
                  ...replyIdentity(row.threadKind, accountLabel, row.displayName),
                  text: row.answer,
                  onCopy: () => void copyOne(row.answer),
                }
              : undefined
          }
          followUps={row.followUps.filter((f) => f.question?.trim())}
          onCopyFollow={(text) => void copyOne(text)}
          followReply={replyIdentity(row.threadKind, accountLabel, row.displayName)}
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
  /** 追问答复的署名:与主答复同一套判定结果(replyIdentity),只有 reader_exchange 不带「作者」标 */
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
