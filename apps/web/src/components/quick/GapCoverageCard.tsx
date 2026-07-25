import { Target } from 'lucide-react';
import { gapLedgerView } from '../../lib/gap-ledger';
import type { ReaderCandidate } from '../../types';

/**
 * 缺口落地台账:这篇打算回答哪些问题,实际答到了没有。
 *
 * 实测 204 条台账里 168 条是 realization_failed——绝大多数稿子的计划没落地,而这
 * 恰恰是「不能直接发」最具体的原因。此前界面一个字都没说,用户只看到一句
 * 「敏感宣称缺证据」,不知道是哪个问题没答上。
 */
export function GapCoverageCard({ candidate }: { candidate?: Pick<ReaderCandidate, 'gapLedger' | 'gapCards'> }) {
  const view = gapLedgerView(candidate);
  if (!view) return null;

  return (
    <section className="qc-gaps">
      <header className="qc-gaps__head">
        <Target size={13} />
        <strong>要回答的问题</strong>
        <span className="qc-gaps__count">
          {view.evaluated
            ? `${view.resolved}/${view.total} 已落地`
            : `${view.total} 项（终稿尚未评估）`}
        </span>
      </header>

      <ul className="qc-gaps__list">
        {view.rows.map((row) => (
          <li key={row.gapId} className={`qc-gap qc-gap--${row.tone}`}>
            <div className="qc-gap__top">
              <strong>{row.label}</strong>
              {row.required && <span className="qc-badge qc-badge--warn">必答</span>}
              <span className={`qc-gap__status qc-gap__status--${row.tone}`}>{row.statusText}</span>
            </div>

            {row.question && <p className="qc-gap__q">读者在问：{row.question}</p>}

            {row.plannedLabels.length > 0 && (
              <p className="qc-gap__plan">计划由{row.plannedLabels.join(' 与 ')}回答</p>
            )}

            {/* 未落地时必须说清缺哪几项:这是用户能动手修的唯一线索 */}
            {row.failed && row.realizations.length > 0 && (
              <ul className="qc-gap__missing">
                {row.realizations.map((r, i) => (
                  <li key={`${r.channelText}-${i}`}>
                    {r.channelText}：
                    {r.missingLabels.length > 0 ? r.missingLabels.join('、') : r.resolved ? '已落地' : '未落地'}
                    {r.detail && <small>（{r.detail}）</small>}
                  </li>
                ))}
              </ul>
            )}

            {row.boundary && <p className="qc-gap__boundary">边界：{row.boundary}</p>}
            {row.verificationPath && <p className="qc-gap__path">核验路径：{row.verificationPath}</p>}
            {row.requiredInput && <p className="qc-gap__path">需要你补充：{row.requiredInput}</p>}
          </li>
        ))}
      </ul>

      {view.failedCount > 0 && (
        <small className="qc-warn-line">
          {view.failedCount} 项计划没落地。这通常就是校验不通过的来源——可以补齐知识库里对应的事实，或用「按意见修改」指名要补哪一项。
        </small>
      )}
    </section>
  );
}
