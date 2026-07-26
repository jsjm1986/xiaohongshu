import { candidateDiffView } from '../../lib/candidate-diff';
import type { ReaderCandidate } from '../../types';

type Source = Pick<ReaderCandidate, 'id' | 'seed' | 'strategy' | 'validation'>;

/**
 * 预览区顶部的版本切换条。
 *
 * 标签一律来自 candidateDiffView:那里已经处理好「prototype 是唯一封闭枚举,可以映射成
 * 4 字中文;其余轴是开放词表,原样显示」。页面上另拼一套「第 N 版」会让同一组候选在两处
 * 显示不同的名字——预览那侧信息严格更少,用户会以为是两回事。
 *
 * 未通过校验的版本带一个提示点:选版本时就该看见,而不是切过去才发现导不出。
 */
export function CandidateSwitch({
  candidates,
  activeIndex,
  onPick,
}: {
  candidates: Source[];
  activeIndex: number;
  onPick: (index: number) => void;
}) {
  // 只有一版时没有「切换」可言,整条不占版面
  if (candidates.length < 2) return null;
  const { tabs } = candidateDiffView(candidates);

  return (
    <div className="xhs-switch">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          className={i === activeIndex ? 'active' : ''}
          // 选中态只靠类名的话读屏软件读不出「当前是哪一版」
          aria-pressed={i === activeIndex}
          title={tab.seed !== undefined ? `seed ${tab.seed}` : undefined}
          onClick={() => onPick(i)}
        >
          {tab.label}
          {!tab.publishable && <i className="quick-tab-dot" title="该版本未通过可发布校验" />}
        </button>
      ))}
    </div>
  );
}
