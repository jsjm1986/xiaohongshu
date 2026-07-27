import { useState } from 'react';
import { QuickResult } from '../QuickResult';
import { useToast } from '../Ui';
import { autoApproveAndGenerate, quickCandidateFields, reviseCandidate, type QuickCandidateView } from '../../lib/quick-generation';
import { revisionStageText } from '../../lib/revision-progress';
import { InlineProgress } from './InlineProgress';
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
  /** 仅「正在生成文案」为真;普通操作只动 busy,不该显示生成进度条 */
  generating: boolean;
  setGenerating: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onGenerated: (results: QuickCandidateView[], jobId: string) => void;
}

export function ResultTab({ project, opportunityId, presetId, overrides, imageAssetIds, jobId, results, busy, setBusy, generating, setGenerating, fail, onGenerated }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [revisingId, setRevisingId] = useState<string | null>(null);


  const regenerate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    setGenerating(true);
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
      setGenerating(false);
      setBusy(false);
    } catch (e) { fail(e, '生成失败'); }
  };

  const revise = async (candidateId: string, instruction: string) => {
    if (!jobId) return;
    setRevisingId(candidateId);
    setProgress(undefined);
    try {
      // 进度取 activeRevision 而不是 job.progress:改稿期间后者恒为 100(job 本身
      // 早已 completed),照它画条会全程停在 100%,读起来像卡住了。
      const job = await reviseCandidate({
        jobId, candidateId, instruction,
        onProgress: (j) => setProgress(j.activeRevision?.progress),
      });
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
      {/* 修改中换成 revisionStageText 并关掉 ETA:首次生成那套阶段名与耗时区间
          对 revise 都不成立,套用会说谎(见 InlineProgress 的注释)。 */}
      <InlineProgress
        active={Boolean(generating || revisingId)}
        progress={progress}
        label={revisingId ? '正在修改' : '正在生成'}
        stageText={revisingId ? revisionStageText : undefined}
        showEta={!revisingId}
      />
      <QuickResult
        candidates={results}
        projectName={project?.name}
        onRegenerate={() => void regenerate()}
        onRevise={jobId ? revise : undefined}
        revisingId={revisingId}
      />
    </div>
  );
}
