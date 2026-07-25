import { Sparkles } from 'lucide-react';
import { TopicTab } from './TopicTab';
import { ConfigTab } from './ConfigTab';
import { ResultTab } from './ResultTab';
import type { QuickCandidateView } from '../../lib/quick-generation';
import type { QuickTab } from '../../lib/quick-channel-state';
import type { SimpleSettingOverrides } from '../../lib/simple-generation';
import type { ContentPreset, Project, TopicOpportunity } from '../../types';

// 布局容器:现 TopicTab + ConfigTab + ResultTab 的 props 并集(壳传下),零业务逻辑重写
interface Props {
  project: Project | null;
  opportunities: TopicOpportunity[];
  opportunityId: string;
  presets: ContentPreset[];
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
  jobId: string | undefined;
  results: QuickCandidateView[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** 仅「正在生成文案」为真;收藏/归档等普通操作只动 busy,不能触发生成进度条与结果区 */
  generating: boolean;
  setGenerating: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onPickTopic: (id: string, presets: ContentPreset[]) => void;
  onAnalyzed: (opps: TopicOpportunity[]) => void;
  setOpportunities: (opps: TopicOpportunity[]) => void;
  onOpportunityGone: (id: string) => void;
  setPresetId: (id: string | undefined) => void;
  setPresets: (presets: ContentPreset[]) => void;
  setOverrides: (o: SimpleSettingOverrides) => void;
  setImageAssetIds: (ids: string[]) => void;
  onGenerated: (results: QuickCandidateView[], jobId: string) => void;
  goTo: (tab: QuickTab) => void;
  /** 批量:左栏勾选 + 右栏批量配置态(壳持有状态,这里只透传) */
  checkedIds: string[];
  onToggleCheck: (id: string) => void;
  onConfigBatch: () => void;
  batchMode: boolean;
  batchPresetIds: string[];
  onToggleBatchPreset: (id: string) => void;
  onSubmitBatch: () => void;
  onCancelBatch: () => void;
}

export function CreateTab(props: Props) {
  const {
    project, opportunities, opportunityId, presets, presetId, overrides, imageAssetIds, jobId, results,
    busy, setBusy, generating, setGenerating, fail,
    onPickTopic, onAnalyzed, setOpportunities, onOpportunityGone,
    setPresetId, setPresets, setOverrides, setImageAssetIds, onGenerated, goTo,
    checkedIds, onToggleCheck, onConfigBatch,
    batchMode, batchPresetIds, onToggleBatchPreset, onSubmitBatch, onCancelBatch,
  } = props;

  return (
    <div className="qc-create">
      <div className="qc-create__pool">
        <TopicTab
          project={project} opportunities={opportunities} opportunityId={opportunityId}
          busy={busy} setBusy={setBusy} fail={fail} onPickTopic={onPickTopic} onAnalyzed={onAnalyzed}
          setOpportunities={setOpportunities} onOpportunityGone={onOpportunityGone}
          checkedIds={checkedIds} onToggleCheck={onToggleCheck} onConfigBatch={onConfigBatch}
          onGoKnowledge={() => goTo('knowledge')}
        />
      </div>
      <div className="qc-create__main">
        <ConfigTab
          project={project} opportunityId={opportunityId} presets={presets} presetId={presetId}
          overrides={overrides} imageAssetIds={imageAssetIds} busy={busy} setBusy={setBusy}
          generating={generating} setGenerating={setGenerating} fail={fail}
          setPresetId={setPresetId} setPresets={setPresets} setOverrides={setOverrides}
          setImageAssetIds={setImageAssetIds} onGenerated={onGenerated}
          batchMode={batchMode} batchPresetIds={batchPresetIds} onToggleBatchPreset={onToggleBatchPreset}
          batchTopicCount={checkedIds.length} onSubmitBatch={onSubmitBatch} onCancelBatch={onCancelBatch}
        />
        {/* 结果区只在「真的在生成」或已有结果时出现;以前用 busy,于是点一下收藏
            也会把「选好选题,点生成文案」换成空的结果面板。 */}
        {batchMode ? null : generating || results.length > 0 ? (
          <ResultTab
            project={project} opportunityId={opportunityId} presetId={presetId} overrides={overrides}
            imageAssetIds={imageAssetIds} jobId={jobId}
            results={results} busy={busy} setBusy={setBusy}
            generating={generating} setGenerating={setGenerating} fail={fail} onGenerated={onGenerated}
          />
        ) : (
          <div className="qc-empty">
            <span className="qc-empty__icon"><Sparkles size={18} /></span>
            选好选题,点「生成文案」
          </div>
        )}
      </div>
    </div>
  );
}
