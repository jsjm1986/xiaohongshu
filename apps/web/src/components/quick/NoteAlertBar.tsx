import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { issueVerdict } from '../../lib/issue-verdict';
import type { VerdictInput } from '../../lib/issue-verdict';

interface Props {
  validation?: VerdictInput;
  /** 点「看详情」滚到下方工作区的校验全文 */
  onSeeDetail: () => void;
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
 */
export function NoteAlertBar({ validation, onSeeDetail }: Props) {
  const verdict = issueVerdict(validation);

  if (verdict.publishable && verdict.advisory.length === 0) {
    return (
      <div className="xhs-alert xhs-alert--ok">
        <CheckCircle2 size={13} />
        <span>可直接发布</span>
      </div>
    );
  }

  const blocking = verdict.blocking.length;
  const advisory = verdict.advisory.length;
  const tone = blocking > 0 ? 'error' : 'warn';

  return (
    <div className={`xhs-alert xhs-alert--${tone}`}>
      {blocking > 0 ? <AlertTriangle size={13} /> : <Info size={13} />}
      <span>
        {blocking > 0
          ? `${blocking} 项需核对才能导出`
          : `${advisory} 项建议核对`}
        {blocking > 0 && advisory > 0 && `，另有 ${advisory} 项建议核对`}
      </span>
      <button type="button" className="xhs-alert__link" onClick={onSeeDetail}>看详情</button>
    </div>
  );
}
