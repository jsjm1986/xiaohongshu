import { Copy, MessagesSquare } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { commentSectionView, gapNameMap } from '../../lib/comment-view';
import type { ReaderCandidate } from '../../types';

type Source = Pick<
  ReaderCandidate,
  'comments' | 'commentDisclaimer' | 'commentOwnedFirstComment' | 'commentUncoveredGaps' | 'gapCards' | 'gapLedger'
>;

/**
 * 评论区。
 *
 * 原来渲染成一列 Q/A,看不出谁在说。但这个区分有实质后果:方法论要求答复只能由
 * 可追责身份发布、提问方必须标为模拟读者。实测 834 条线程全都带着 postingIdentity
 * 与 function,界面此前全丢了。
 *
 * 追问只有 42/834 条有,所以有才渲染,不留空壳。
 */
export function CommentSection({ candidate }: { candidate: Source }) {
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

  return (
    <section className="quick-card qc-comments">
      <header>
        <h3><MessagesSquare size={13} />评论区参考</h3>
        {view.identitySummary.length > 0 && (
          <small className="qc-hint">答复身份：{view.identitySummary.join(' / ')}</small>
        )}
      </header>

      <div className="quick-card__body">
        {candidate.commentDisclaimer && <p className="qc-disclaimer">{candidate.commentDisclaimer}</p>}

        {candidate.commentOwnedFirstComment && (
          <div className="qc-comment qc-comment--owned">
            <div className="qc-comment__meta">
              <span className="qc-badge qc-badge--ok">自备首评</span>
              <span className="qc-hint">发帖后立刻由发布账号发</span>
              <Button variant="ghost" icon={<Copy size={12} />} onClick={() => void copyOne(candidate.commentOwnedFirstComment!)}>复制</Button>
            </div>
            <p>{candidate.commentOwnedFirstComment}</p>
          </div>
        )}

        <ol className="qc-comments__list">
          {view.rows.map((row, i) => (
            <li key={row.id ?? `${row.question}-${i}`} className="qc-comment">
              <div className="qc-comment__meta">
                <span className="qc-badge qc-badge--muted">{row.askerLabel}</span>
                {row.stageLabel && <span className="qc-hint">{row.stageLabel}</span>}
                {row.functionLabel && <span className="qc-comment__fn">{row.functionLabel}</span>}
                {row.gapLabel && <span className="qc-comment__gap">补「{row.gapLabel}」</span>}
                <Button
                  variant="ghost"
                  icon={<Copy size={12} />}
                  onClick={() => void copyOne(row.answer)}
                >
                  复制答复
                </Button>
              </div>

              <p className="qc-comment__q">{row.question}</p>
              <div className="qc-comment__a">
                {row.answererLabel && <span className="qc-badge qc-badge--ok">{row.answererLabel}</span>}
                <p>{row.answer}</p>
              </div>

              {row.boundary && <small className="qc-comment__side">边界：{row.boundary}</small>}
              {row.nextStep && <small className="qc-comment__side">下一步：{row.nextStep}</small>}

              {row.followUps.length > 0 && (
                <ul className="qc-comment__follow">
                  {row.followUps.map((f, j) => (
                    <li key={`${f.question}-${j}`}>
                      <span>追问：{f.question}</span>
                      <span>回应：{f.answer}</span>
                      {f.boundary && <small>边界：{f.boundary}</small>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>

        {candidate.commentUncoveredGaps?.length ? (
          <small className="qc-uncovered">评论区未展开：{candidate.commentUncoveredGaps.join('、')}</small>
        ) : null}
      </div>
    </section>
  );
}
