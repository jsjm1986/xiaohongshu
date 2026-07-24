import { QuickResult } from '../QuickResult';
import { autoApproveAndGenerate, quickCandidateFields, type QuickCandidateView } from '../../lib/quick-generation';
import type { SimpleSettingOverrides } from '../../lib/simple-generation';
import type { Project } from '../../types';

interface Props {
  project: Project | null;
  opportunityId: string;
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  results: QuickCandidateView[];
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onGenerated: (results: QuickCandidateView[]) => void;
  goToTopic: () => void;
}

export function ResultTab({ project, opportunityId, presetId, overrides, results, setBusy, fail, onGenerated, goToTopic }: Props) {
  const regenerate = async () => {
    if (!project || !opportunityId) return;
    setBusy(true);
    try {
      const job = await autoApproveAndGenerate({ project, opportunityId, presetId, overrides });
      onGenerated((job.candidates ?? []).map(quickCandidateFields));
      setBusy(false);
    } catch (e) { fail(e, '生成失败'); }
  };

  return (
    <div className="qc-step">
      <QuickResult
        candidates={results}
        onRegenerate={() => void regenerate()}
        onPickAnotherTopic={() => goToTopic()}
      />
    </div>
  );
}
