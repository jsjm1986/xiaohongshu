import { Clock, Hourglass } from 'lucide-react';
import { waitStatus } from '../../lib/wait-status';
import type { GenerationJob } from '../../types';

interface Props {
  job: GenerationJob;
  /** 由父组件统一 tick 传入,多张卡片共享同一时刻,避免各自漂移 */
  now: number;
}

/**
 * 等待卡:queued/running 任务的进度替代品。
 *
 * 原来这里只有一条「正在生成(44%)」。progress 全程只有 5 个离散值,而实测批量
 * 任务平均 56 分钟、最长 2.7 小时,用户看到的就是一个几十分钟不动的数字。改成
 * 三行事实:排在第几 / 已等多久 / 同类任务通常多久,并在等待偏长时明确告诉用户
 * 可以关掉页面。
 */
export function WaitCard({ job, now }: Props) {
  const status = waitStatus(job, now);
  if (status.phase === 'settled') return null;
  const pct = status.phase === 'running' ? Math.max(4, Math.min(100, job.progress ?? 0)) : 0;
  return (
    <div className="qc-wait">
      <div className="qc-wait__head">
        <span className="qc-wait__icon">
          {status.phase === 'queued' ? <Hourglass size={14} /> : <Clock size={14} />}
        </span>
        <strong>{status.headline}</strong>
        {status.elapsedLabel && <small className="qc-hint">{status.elapsedLabel}</small>}
      </div>
      {/* 排队阶段不画进度条:0% 的条比没有条更容易被读成「卡在开头」 */}
      {status.phase === 'running' && (
        <div className="qc-wait__bar" role="progressbar" aria-valuenow={job.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="qc-wait__meta">{status.etaLabel}。进度按阶段跳变，长时间不动是正常的。</p>
      {status.longWait && (
        <p className="qc-wait__note">已经等了一会儿了。任务在服务端后台跑，关掉页面或去做别的都不影响，回来还在这里。</p>
      )}
    </div>
  );
}
