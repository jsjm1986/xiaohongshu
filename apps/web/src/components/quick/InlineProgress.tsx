import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { progressStageText } from '../../lib/quick-progress';
import { formatDuration, LONG_WAIT_SECONDS, SINGLE_ETA_SECONDS } from '../../lib/wait-status';

interface Props {
  /** 是否在等待中;从 false 翻到 true 时重新起表 */
  active: boolean;
  progress?: number;
  /** 「正在生成」/「正在修改」 */
  label?: string;
  /**
   * 阶段文案生成器。默认用首次生成那套(progressStageText);修改任务传
   * revisionStageText——它的阶段完全不同,套用会说谎。
   */
  stageText?: (progress?: number) => string;
  /**
   * 是否显示「通常 X–Y 分钟」。默认 true(既有调用方行为不变)。
   *
   * 修改任务传 false:那个区间来自线上 55 篇首次生成实测,而 revise 目前只有 2 个
   * 样本,不足以定区间。编一个比不给更糟——等库里积累够样本再补。
   */
  showEta?: boolean;
}

/**
 * 创作区的行内等待条。
 *
 * 换掉原来那句「请勿离开或重复点击」:前半句是错的(任务在服务端跑,关页面不影响),
 * 后半句该说清代价(重复点会多扣一次额度)。实测单篇平均 15 分钟、progress 只有
 * 5 个离散值,所以补一个自己走秒的已等待时长和经验区间,让"没动"可被解释。
 */
export function InlineProgress({ active, progress, label = '正在生成', stageText = progressStageText, showEta = true }: Props) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) { setStartedAt(null); return; }
    const begin = Date.now();
    setStartedAt(begin);
    setNow(begin);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const elapsedSeconds = startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
  const [low, high] = SINGLE_ETA_SECONDS;
  return (
    <div className="qc-progress" role="status">
      <RefreshCw size={15} className="spin" />
      <span>{label}：{stageText(progress)}…</span>
      <small>
        {progress !== undefined ? `${progress}% · ` : ''}
        已等待 {formatDuration(elapsedSeconds)}
        {showEta ? ` · 通常 ${Math.round(low / 60)}–${Math.round(high / 60)} 分钟` : ''}
      </small>
      <i className="qc-progress__track"><b style={{ width: `${progress ?? 0}%`, animation: 'none' }} /></i>
      {elapsedSeconds >= LONG_WAIT_SECONDS && (
        <p className="qc-progress__note">
          任务在服务端后台继续跑，可以关掉页面或去做别的，回「产出」区就能看到进度和结果。别重复点生成，那会多扣一次额度。
        </p>
      )}
    </div>
  );
}
