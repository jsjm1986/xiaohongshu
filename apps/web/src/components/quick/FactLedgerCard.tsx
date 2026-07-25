import { FileSearch } from 'lucide-react';
import { factLedgerView } from '../../lib/fact-ledger';
import type { ReaderCandidate } from '../../types';

/**
 * 事实标注:哪句话有证据,哪句只是假设。
 *
 * 对付费用户这是发布风险——把假设当事实发出去要担责。后端为每篇都算了句子级标注
 * (实测 8–35 条/篇),但旧接口不返回,界面也就无从说明「这段凭什么这么写」。
 *
 * 默认折叠:它是核对用的工具,不是每次都要读的东西;但结论那一行始终露在外面。
 */
export function FactLedgerCard({ candidate }: { candidate?: Pick<ReaderCandidate, 'reasoning'> }) {
  const view = factLedgerView(candidate);
  if (!view) return null;

  return (
    <details className="qc-facts">
      <summary className="qc-facts__head">
        <FileSearch size={13} />
        <strong>逐句依据</strong>
        <span className={view.groundedCount === 0 ? 'qc-facts__count qc-facts__count--warn' : 'qc-facts__count'}>
          {view.headline}
        </span>
      </summary>

      {view.groups.map((group) => (
        <div key={group.label} className="qc-facts__group">
          <h5>
            {group.label}
            <small>{group.groundedCount}/{group.total} 有证据</small>
          </h5>
          <ul>
            {group.items.map((item, i) => (
              <li key={`${item.statement}-${i}`} className={`qc-fact qc-fact--${item.tone}`}>
                <span className="qc-fact__status">{item.statusText}</span>
                <span className="qc-fact__text">{item.statement}</span>
                {item.evidenceIds.length > 0 && (
                  <small className="qc-fact__ev">证据 {item.evidenceIds.length} 条</small>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      <small className="qc-hint">
        「假设」不等于错，但发出去前要自己确认；标成事实却没有证据编号的，按未核实处理。
      </small>
    </details>
  );
}
