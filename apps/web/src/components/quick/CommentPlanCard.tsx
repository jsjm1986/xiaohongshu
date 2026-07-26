import { ClipboardCheck } from 'lucide-react';
import { commentSectionView, gapNameMap } from '../../lib/comment-view';
import type { ReaderCandidate } from '../../types';

type Source = Pick<
  ReaderCandidate,
  'comments' | 'commentDisclaimer' | 'commentUncoveredGaps' | 'gapCards' | 'gapLedger'
>;

/**
 * 评论核对(工作区)。
 *
 * 预览区要沉浸,所以 boundary/nextStep/承担缺口/线程功能/读者阶段这些编排字段从
 * 评论区移到这里。它们是写给运营核对的计划字段,不是发布文案——旧版平铺在问答旁边,
 * 于是「不得夸大监督效果」这类内部指令直接展示给了用户。删掉也不行:核对时要用。
 */
export function CommentPlanCard({ candidate }: { candidate: Source }) {
  const view = commentSectionView(
    candidate.comments,
    gapNameMap(candidate.gapCards, candidate.gapLedger?.entries),
  );
  if (!view) return null;

  const rows = view.rows.filter(
    (row) => row.stageLabel || row.functionLabel || row.gapLabel || row.boundary || row.nextStep,
  );

  return (
    <section className="quick-card">
      <header>
        <h3><ClipboardCheck size={13} />评论核对</h3>
        {view.identitySummary.length > 0 && (
          <small className="qc-hint">答复身份：{view.identitySummary.join(' / ')}</small>
        )}
      </header>
      <div className="quick-card__body">
        {candidate.commentDisclaimer && <p className="qc-disclaimer">{candidate.commentDisclaimer}</p>}

        {rows.length > 0 && (
          <ol className="qc-planlist">
            {rows.map((row, i) => (
              <li key={row.id ?? `${row.question}-${i}`}>
                <p className="qc-planlist__q">{row.question}</p>
                <dl>
                  {row.stageLabel && <><dt>读者阶段</dt><dd>{row.stageLabel}</dd></>}
                  {row.functionLabel && <><dt>线程功能</dt><dd>{row.functionLabel}</dd></>}
                  {row.gapLabel && <><dt>承担缺口</dt><dd>{row.gapLabel}</dd></>}
                  {row.boundary && <><dt>边界要求</dt><dd>{row.boundary}</dd></>}
                  {row.nextStep && <><dt>下一步核验</dt><dd>{row.nextStep}</dd></>}
                </dl>
              </li>
            ))}
          </ol>
        )}

        {candidate.commentUncoveredGaps?.length ? (
          <small className="qc-uncovered">评论区未展开：{candidate.commentUncoveredGaps.join('、')}</small>
        ) : null}
      </div>
    </section>
  );
}
