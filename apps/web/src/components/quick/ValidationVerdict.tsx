import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { issueVerdict, type VerdictInput } from '../../lib/issue-verdict';

/**
 * 校验结论。
 *
 * 换掉原来在创作区与产出区各写一遍的那段——它按数组顺序取首条可识别 code 当结论,
 * 实测 129 个未通过候选里 110 个(85%)因此把 warning 当成了结论。用户照着改完,
 * 仍然不能导出。
 *
 * 这里把两类分开说:「不可覆盖的硬门禁」与「不阻塞交付的复核项」。
 */
export function ValidationVerdict({ validation, deliverable }: { validation?: VerdictInput; deliverable?: boolean }) {
  const deliveryBlocked = deliverable === false;
  const verdict = issueVerdict(validation);
  const displayPublishable = !deliveryBlocked && verdict.publishable;
  const headline = deliveryBlocked ? '存在硬门禁 · 须修复后重新生成' : verdict.headline;

  return (
    <div className={`qc-verdict qc-verdict--${deliveryBlocked ? 'blocked' : displayPublishable ? 'ok' : 'review'}`}>
      <p className="qc-verdict__head">
        {displayPublishable ? <ShieldCheck size={14} /> : <TriangleAlert size={14} />}
        <strong>{headline}</strong>
      </p>

      {verdict.blocking.length > 0 && (
        <details className="qc-verdict__group qc-verdict__group--blocking">
          <summary>{deliveryBlocked ? '硬门禁 · 须修复后重新生成' : '复核项（不阻塞复制与导出）'} · {verdict.blocking.length} 项</summary>
          <ul>
            {verdict.blocking.map((item) => (
              <li key={item.code ?? item.label}>
                {item.label}
                {item.count > 1 && <b>×{item.count}</b>}
              </li>
            ))}
          </ul>
        </details>
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

      {displayPublishable && verdict.advisory.length === 0 && (
        <small className="qc-hint">标题、正文、标签、证据引用与评论结构均已检查</small>
      )}
    </div>
  );
}
