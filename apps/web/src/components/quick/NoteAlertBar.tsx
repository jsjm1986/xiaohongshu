import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { issueVerdict } from '../../lib/issue-verdict';
import type { VerdictInput } from '../../lib/issue-verdict';

interface Props {
  validation?: VerdictInput;
  /** 点「看详情」滚到下方工作区的校验全文 */
  onSeeDetail: () => void;
  /** 统一交付门禁：false 仅表示命中不可覆盖的硬门禁。 */
  deliverable: boolean;
}

/**
 * 预览上方一条细横条。
 *
 * 为什么不是卡片:这页第一屏要给成品。但也不能只靠禁用导出按钮来表达——实测该项目
 * 21 篇产出里 11 篇是「需人工核对」,不是罕见路径,用户会先复制正文再发现导不出。
 * 细条是两者的折中:一行,不抢版面,但跑不掉。
 *
 * 分级直接用 issueVerdict:它已经处理了「按数组顺序取首条会把 warning 当结论」
 * 这个实测过的坑(129 个未通过候选里 110 个首条是 warning)。
 *
 * 三态而不是两态:能不能导出看 publishable,不看 warning 数。实测 229 个候选里 46 个
 * 是 valid=true 且带 warning——这些可以直接发,拿黄条写「N 项建议核对」会被读成没过校验。
 */
export function NoteAlertBar({ validation, onSeeDetail, deliverable }: Props) {
  // 交付硬门禁优先于序列化的 valid/qualityStatus；两者矛盾时必须失败关闭。
  if (!deliverable) {
    return (
      <div className="xhs-alert xhs-alert--error">
        <AlertTriangle size={13} />
        <span>存在硬门禁 · 须修复后重新生成</span>
        <button type="button" className="xhs-alert__link" onClick={onSeeDetail}>看详情</button>
      </div>
    );
  }

  const verdict = issueVerdict(validation);
  const advisory = verdict.advisory.length;

  // 一态:干净通过。
  if (verdict.publishable && advisory === 0) {
    return (
      <div className="xhs-alert xhs-alert--ok">
        <CheckCircle2 size={13} />
        <span>可直接发布</span>
      </div>
    );
  }

  // 二态:通过了但有建议项。先说结论(可发布),再说还有什么可看,配中性信息色。
  if (verdict.publishable) {
    return (
      <div className="xhs-alert xhs-alert--info">
        <Info size={13} />
        <span>{`可直接发布 · ${advisory} 项建议核对`}</span>
        <button type="button" className="xhs-alert__link" onClick={onSeeDetail}>看详情</button>
      </div>
    );
  }

  // 三态:自动校验有复核项，但未命中不可覆盖的硬门禁。
  return (
    <div className="xhs-alert xhs-alert--warn">
      <Info size={13} />
      <span>{verdict.headline}</span>
      <button type="button" className="xhs-alert__link" onClick={onSeeDetail}>看详情</button>
    </div>
  );
}
