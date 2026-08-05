import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { issueVerdict, type VerdictInput } from '../../lib/issue-verdict';

/**
 * 校验结论。
 *
 * 换掉原来在创作区与产出区各写一遍的那段——它按数组顺序取首条可识别 code 当结论,
 * 实测 129 个未通过候选里 110 个(85%)因此把 warning 当成了结论。用户照着改完,
 * 仍然不能导出。
 *
 * 这里把两类分开说:「须处理才能导出」与「可人工核对后使用」。
 */
export function ValidationVerdict({ validation, manuallyConfirmed = false }: { validation?: VerdictInput; manuallyConfirmed?: boolean }) {
  const verdict = issueVerdict(validation);

  return (
    <div className={`qc-verdict qc-verdict--${verdict.publishable ? 'ok' : 'blocked'}`}>
      <p className="qc-verdict__head">
        {verdict.publishable ? <ShieldCheck size={14} /> : <TriangleAlert size={14} />}
        <strong>{verdict.headline}</strong>
      </p>

      {verdict.blocking.length > 0 && (
        <div className="qc-verdict__group qc-verdict__group--blocking">
          <h5>{manuallyConfirmed ? '自动校验仍未通过' : '须核对后确认交付'} · {verdict.blocking.length} 项</h5>
          <ul>
            {verdict.blocking.map((item) => (
              <li key={item.code ?? item.label}>
                {item.label}
                {item.count > 1 && <b>×{item.count}</b>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {verdict.advisory.length > 0 && (
        // 提醒项收进折叠区:它们不阻塞导出,平铺会把须处理项挤下去
        <details className="qc-verdict__group qc-verdict__group--advisory">
          <summary>可人工核对后使用 · {verdict.advisory.length} 项</summary>
          <ul>
            {verdict.advisory.map((item) => (
              <li key={item.code ?? item.label}>
                {item.label}
                {item.count > 1 && <b>×{item.count}</b>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {verdict.publishable && verdict.advisory.length === 0 && (
        <small className="qc-hint">标题、正文、标签、证据引用与评论结构均已检查</small>
      )}
    </div>
  );
}
