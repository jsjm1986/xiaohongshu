import { Fragment } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { commentSectionView, gapNameMap } from '../../lib/comment-view';
import { uncoveredGapLabels } from '../../lib/comment-cref';
import type { ReaderCandidate, ReaderComment } from '../../types';

/**
 * gapCards / gapLedger 可选:它们只用于把 gap id 换成人能读的名称。创作区刚生成的
 * 候选没有这两项,缺了就退回显示 id(uncoveredGapLabels 的既有回落),
 * 编排字段本身照常核对。followUps 同样收成可选,理由见 comment-view。
 */
type Source = {
  comments: Array<Omit<ReaderComment, 'followUps'> & { followUps?: ReaderComment['followUps'] }>;
  commentDisclaimer?: string;
  commentUncoveredGaps?: string[];
} & Partial<Pick<ReaderCandidate, 'gapCards' | 'gapLedger'>>;

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

  // 追问的 boundary 也算「有可核对内容」:一条线程可能主线程五字段全空、只有追问带边界,
  // 漏掉它就等于新增的追问边界分支永远进不去。
  const rows = view.rows.filter(
    (row) =>
      row.stageLabel ||
      row.functionLabel ||
      row.gapLabel ||
      row.boundary ||
      row.nextStep ||
      row.followUps.some((f) => f.boundary?.trim()),
  );

  // 未展开缺口存的是 gap id(gap_1、gap_aftercare 这类),同一张卡上 gapLabel 走了名称映射,
  // 这里再摆原始 id 就自相矛盾;查不到的 id 由 uncoveredGapLabels 原样透传,不编名称。
  const uncovered = uncoveredGapLabels(candidate.commentUncoveredGaps, candidate.gapCards);

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
                  {/* 追问自带的边界要求。字段端到端是通的(生成侧 → reader 视图 → comment-view),
                      只是当前库里 168 条追问无一填写;不在这里列出,它就随旧 CommentSection
                      一起从阅读页消失,而这张卡的职责就是内部核对字段一个不丢。 */}
                  {row.followUps.map((f, j) =>
                    f.boundary?.trim() ? (
                      <Fragment key={`fu-${j}`}>
                        <dt>追问 {j + 1} 边界要求</dt>
                        <dd>{f.boundary}</dd>
                      </Fragment>
                    ) : null,
                  )}
                </dl>
              </li>
            ))}
          </ol>
        )}

        {uncovered.length > 0 && (
          <small className="qc-uncovered">评论区未展开：{uncovered.join('、')}</small>
        )}
      </div>
    </section>
  );
}
