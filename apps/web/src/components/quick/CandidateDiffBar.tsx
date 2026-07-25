import { candidateDiffView } from '../../lib/candidate-diff';
import type { ReaderCandidate } from '../../types';

type Source = Pick<ReaderCandidate, 'id' | 'seed' | 'strategy' | 'validation'>;

/**
 * 候选切换 + 差异说明。
 *
 * 替掉三个都叫「随机候选」的 tab。后端确实给了不同的表达轴(正文角色、叙述方式、
 * 评论取向、语气…),只是接口不返回;不给出来,用户没有任何依据选版本。
 *
 * 差异条只列真正不同的轴。开放词表的取值原样显示——bodyRole 实测有 70+ 种取值,
 * 含模型产出的中文自由文本,猜译只会失真。
 */
export function CandidateDiffBar({
  candidates,
  activeIndex,
  onPick,
}: {
  candidates: Source[];
  activeIndex: number;
  onPick: (index: number) => void;
}) {
  if (candidates.length === 0) return null;
  const view = candidateDiffView(candidates);

  return (
    <div className="qc-cdiff">
      <div className="quick-tabs">
        {view.tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            className={i === activeIndex ? 'active' : ''}
            onClick={() => onPick(i)}
            title={tab.seed !== undefined ? `seed ${tab.seed}` : undefined}
          >
            {tab.label}
            {!tab.publishable && <i className="quick-tab-dot" title="该版本未通过可发布校验" />}
          </button>
        ))}
      </div>

      {view.differingAxes.length > 0 && (
        <details className="qc-cdiff__axes">
          <summary>这几版差在哪（{view.differingAxes.length} 项）</summary>
          <table>
            <thead>
              <tr>
                <th />
                {view.tabs.map((tab, i) => (
                  <th key={tab.id} className={i === activeIndex ? 'is-active' : undefined}>
                    版本{i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.differingAxes.map((axis) => (
                <tr key={axis.label}>
                  <th scope="row">{axis.label}</th>
                  {axis.values.map((value, i) => (
                    <td key={`${axis.label}-${i}`} className={i === activeIndex ? 'is-active' : undefined}>
                      {value ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <small className="qc-hint">
            这些是同一选题下的表达差异（随机化维度），不是质量排序；哪一版更合适由你判断。
          </small>
        </details>
      )}

      {candidates.length > 1 && view.identical && (
        <small className="qc-hint">这几版的表达设定相同，差异来自随机种子。</small>
      )}
    </div>
  );
}
