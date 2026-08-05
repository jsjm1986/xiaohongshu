import { useState } from 'react';
import { Copy, Download, RotateCcw } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { CandidateDiffBar } from './CandidateDiffBar';
import { CommentPlanCard } from './CommentPlanCard';
import { DeploymentPlanCard } from './DeploymentPlanCard';
import { FactLedgerCard } from './FactLedgerCard';
import { GapCoverageCard } from './GapCoverageCard';
import { ValidationVerdict } from './ValidationVerdict';
import { issueVerdict } from '../../lib/issue-verdict';
import { clampCandidateIndex } from '../../lib/note-view';
import { publishOrderText } from '../../lib/publish-copy';
import type { ReaderCandidate, ReaderJob } from '../../types';

/**
 * 「查看」的工作区。
 *
 * 成品展示(标题/正文/标签/配图/评论)已交给预览区的 NoteCard,这里只留要动手的部分:
 * 校验结论 → 判断依据(凭什么这么写、哪些没答上、评论核对) → 发布方案 → 导出/改稿。
 */

const EXPORT_FORMATS = ['markdown', 'docx', 'pdf', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

interface Props {
  job: ReaderJob;
  /** 四种导出统一走后端，以保留人工确认与原始校验审计。 */
  onExport: (candidate: ReaderCandidate, format: ExportFormat) => void;
  /** 按意见修改;未接通时不显示该区块 */
  onRevise?: (candidate: ReaderCandidate, instruction: string) => Promise<void>;
  revisingId?: string | null;
  /** 重新生成一批(重试) */
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * 当前候选下标。原为内部 useState,现在预览区与工作区共用同一个下标,提升到页面层。
   * 这里只读不写:切版本的按钮在预览区(CandidateSwitch),所以没有配套的 onPick。
   */
  activeIndex: number;
  /** 自动通过或当前用户已人工确认当前候选。 */
  deliverable: boolean;
}

export function ReaderDetail({ job, onExport, onRevise, revisingId, onRetry, retrying, activeIndex, deliverable }: Props) {
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const candidates = job.candidates;
  if (candidates.length === 0) return null;
  // 与预览区共用同一个夹法,见 clampCandidateIndex 的注释
  const current = candidates[clampCandidateIndex(activeIndex, candidates.length)]!;
  const verdict = issueVerdict(current.validation);

  const copyText = async (text: string) => {
    if (!deliverable) { toast.push('请先完成人工交付确认', 'error'); return; }
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  const submitRevise = () => {
    if (!onRevise) return;
    const text = instruction.trim();
    if (!text) return;
    void onRevise(current, text).then(() => setInstruction('')).catch(() => undefined);
  };

  return (
    <div className="qc-reader">
      {/* 切版本在上面的预览区,这里只读差异 */}
      <CandidateDiffBar candidates={candidates} activeIndex={activeIndex} />

      <ValidationVerdict validation={current.validation} manuallyConfirmed={!verdict.publishable && deliverable} />

      {/* 第二段:判断依据。(原第一段「成品」已移交预览区 NoteCard,不是漏了;
          编号沿用旧序号,方便与计划文档对照) */}
      <div className="qc-reader__section">
        <h4 className="qc-reader__label">判断依据</h4>
        <GapCoverageCard candidate={current} />
        <FactLedgerCard candidate={current} />
        <CommentPlanCard candidate={current} />
        {current.sources.length > 0 && (
          <details className="qc-sources">
            <summary>本次用到的来源（{current.sources.length}）</summary>
            <ul>
              {current.sources.map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  {s.name}
                  {s.section && <small>{s.section}</small>}
                  {s.evidenceStatus && <small>{s.evidenceStatus}</small>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* 第三段:发布方案 */}
      <div className="qc-reader__section">
        <h4 className="qc-reader__label">发布与执行</h4>
        <DeploymentPlanCard candidate={{ deploymentPlan: current.deploymentPlan, unknowns: current.unknowns.map((u) => u.question) }} />
      </div>

      {/* 动作 */}
      <div className="qc-reader__actions">
        <Button variant="secondary" icon={<Copy size={15} />} disabled={!deliverable} onClick={() => void copyText(publishOrderText(current))}>
          按发布顺序复制
        </Button>
        <span className="qc-export-group">
          <span className="qc-export-group__label"><Download size={13} />导出</span>
          {EXPORT_FORMATS.map((fmt) => {
            // 自动校验通过，或当前用户已对当前候选完成人工交付确认，才可导出。
            const blocked = !deliverable;
            return (
              <Button
                key={fmt}
                variant="ghost"
                disabled={blocked}
                title={blocked ? '人工确认后可复制与导出' : undefined}
                onClick={() => onExport(current, fmt)}
              >
                {fmt === 'markdown' ? 'Markdown' : fmt.toUpperCase()}
              </Button>
            );
          })}
          {!verdict.publishable && <small className="qc-hint">{deliverable ? '已人工确认，可导出；自动校验结论仍保留' : '人工确认后可复制与导出'}</small>}
        </span>
        {onRetry && (
          <Button variant="ghost" icon={<RotateCcw size={13} />} loading={retrying} disabled={retrying} onClick={onRetry}>
            按同款重新生成
          </Button>
        )}
      </div>

      {onRevise && (
        <details className="qc-revise">
          <summary>按意见修改这一版</summary>
          <textarea
            rows={3}
            value={instruction}
            placeholder={verdict.blocking.length > 0
              ? `例：补上「${verdict.blocking[0]?.label}」涉及的依据，没有依据就改成不确定的说法`
              : '例：标题再口语化一点'}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="qc-actions">
            <Button
              variant="secondary"
              loading={revisingId === current.id}
              disabled={!instruction.trim() || Boolean(revisingId)}
              onClick={submitRevise}
            >
              {revisingId === current.id ? '修改中…' : '提交修改'}
            </Button>
            {/* 付费产品:动模型就要花钱,先说清 */}
            <small className="qc-hint">修改会重跑写作与校验，消耗 1 次额度</small>
          </div>
        </details>
      )}
    </div>
  );
}
