import { RefreshCw } from 'lucide-react';
import type { AnalysisTask } from '../../types';

export function QuickTaskProgress({ text, task }: { text: string; task: AnalysisTask | null }) {
  const active = task !== null && (task.status === 'running' || task.status === 'queued');
  const failed = task?.status === 'failed';
  return (
    <div className={`qc-progress${failed ? ' qc-progress--failed' : ''}`} role="status">
      {!failed && <RefreshCw size={15} className="spin" />}
      <span>{failed ? (task?.error || '分析失败,请重试') : text}</span>
      {!failed && <small>{active ? `后台进行中 · 第 ${task.attemptCount} 次尝试` : '后台进行中'}</small>}
      {!failed && <i className="qc-progress__track"><b /></i>}
    </div>
  );
}
