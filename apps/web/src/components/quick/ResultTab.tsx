import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { QuickResult } from '../QuickResult';
import { useToast } from '../Ui';
import { autoApproveAndGenerate, quickCandidateFields, reviseCandidate, type QuickCandidateView } from '../../lib/quick-generation';
import { progressStageText } from '../../lib/quick-progress';
import type { SimpleSettingOverrides } from '../../lib/simple-generation';
import type { Project } from '../../types';

interface Props {
  project: Project | null;
  opportunityId: string;
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
  jobId: string | undefined;
  results: QuickCandidateView[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onGenerated: (results: QuickCandidateView[], jobId: string) => void;
}

export function ResultTab({ project, opportunityId, presetId, overrides, imageAssetIds, jobId, results, busy, setBusy, fail, onGenerated }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [revisingId, setRevisingId] = useState<string | null>(null);

  const regenerate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    setProgress(undefined);
    try {
      const job = await autoApproveAndGenerate({
        project,
        opportunityId,
        presetId,
        overrides,
        imageAssetIds,
        onProgress: (j) => setProgress(j.progress),
      });
      onGenerated((job.candidates ?? []).map(quickCandidateFields), job.id);
      setBusy(false);
    } catch (e) { fail(e, '生成失败'); }
  };

  const revise = async (candidateId: string, instruction: string) => {
    if (!jobId) return;
    setRevisingId(candidateId);
    setProgress(undefined);
    try {
      const job = await reviseCandidate({ jobId, candidateId, instruction, onProgress: (j) => setProgress(j.progress) });
      // revise 后候选位置(candidate_index)不变;候选 id 目前也保持不变,但按
      // GenerationResultPage 的兜底思路兼容 id 变化:先按原位置取,再找没见过的 id
      const oldIndex = results.findIndex((r) => r.id === candidateId);
      const oldIds = new Set(results.map((r) => r.id));
      const candidates = job.candidates ?? [];
      const revised = (oldIndex >= 0 ? candidates[oldIndex] : undefined) ?? candidates.find((c) => !oldIds.has(c.id));
      if (oldIndex < 0 || !revised) throw new Error('修改结果为空，请重试');
      onGenerated(results.map((r, i) => (i === oldIndex ? quickCandidateFields(revised) : r)), job.id);
      toast.push('已按意见修改');
    } catch (e) {
      fail(e, '修改失败，请重试');
      throw e;
    } finally {
      setRevisingId(null);
    }
  };

  return (
    <div className="qc-step">
      {(busy || revisingId) && (
        <div className="qc-progress" role="status">
          <RefreshCw size={15} className="spin" />
          <span>{revisingId ? '正在修改' : '正在生成'}:{progressStageText(progress)}…</span>
          <small>{progress !== undefined ? `${progress}% · ` : ''}请勿离开或重复点击</small>
          <i className="qc-progress__track"><b style={{ width: `${progress ?? 0}%`, animation: 'none' }} /></i>
        </div>
      )}
      <QuickResult
        candidates={results}
        onRegenerate={() => void regenerate()}
        onRevise={jobId ? revise : undefined}
        revisingId={revisingId}
      />
    </div>
  );
}
