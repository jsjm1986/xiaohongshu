import { candidateDiffView, type DiffSource } from '../../lib/candidate-diff';

/**
 * 候选差异说明。
 *
 * 后端确实给了不同的表达轴(正文角色、叙述方式、评论取向、语气…),只是接口不返回;
 * 不给出来,用户面对三个都叫「随机候选」的版本没有任何依据选。
 *
 * 切换按钮已移到预览区的 CandidateSwitch:同一页两组切同一个下标的按钮,而其中一组
 * 信息更少,会被读成两回事。这里只留差异表,当前选中的那一列高亮(activeIndex 的
 * 唯一用途),读的时候能对上上面选的是哪一版。
 *
 * 差异表只列真正不同的轴。开放词表的取值原样显示——bodyRole 实测有 70+ 种取值,
 * 含模型产出的中文自由文本,猜译只会失真。
 */
export function CandidateDiffBar({
  candidates,
  activeIndex,
}: {
  candidates: DiffSource[];
  activeIndex: number;
}) {
  if (candidates.length === 0) return null;
  const view = candidateDiffView(candidates);
  // 切换按钮搬到预览区之后,这个容器在「只有一版」时什么都不剩;留一个空 div
  // 会在工作区顶上白占一段 flex 间距。多候选而表达轴全同时仍要渲染——那条
  // 「表达设定相同」的提示本身就是结论。
  const identicalHint = candidates.length > 1 && view.identical;
  if (view.differingAxes.length === 0 && !identicalHint) return null;

  return (
    <div className="qc-cdiff">
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

      {identicalHint && (
        <small className="qc-hint">这几版的表达设定相同，差异来自随机种子。</small>
      )}
    </div>
  );
}
