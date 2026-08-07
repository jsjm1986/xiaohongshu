import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Ui';
import { CreateTab } from '../../components/quick/CreateTab';
import { useQuickWorkspace } from '../../components/quick/QuickWorkspaceContext';
import { api } from '../../lib/api';
import { buildBatchJobs } from '../../lib/quick-batch';
import { pruneCheckedIds } from '../../lib/quick-channel-state';
import { approveOpportunitiesForBatch, GenerationStillRunningError, type QuickCandidateView } from '../../lib/quick-generation';
import { areaPath, type QuickArea } from '../../lib/quick-routes';
import type { ContentPreset, TopicOpportunity } from '../../types';

/**
 * 创作区。四个区里唯一有"在途状态"的:选中的选题、预设、覆盖项、批量勾选、
 * 刚生成的结果——全部存在 QuickWorkspaceProvider 里,所以去产出区看一眼再回来,
 * 勾选和配置都还在。
 */
export function QuickCreatePage() {
  const w = useQuickWorkspace();
  const { project } = w;
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // busy = 「有操作在跑」(禁用按钮防并发);generating = 「真的在生成文案」。
  // 两者必须分开:合成一个的话,点一下收藏/归档右栏就会闪出「正在生成」进度条。
  const [generating, setGenerating] = useState(false);

  const fail = (e: unknown, fallback: string) => {
    // 「前端不等了」不是「任务失败了」。后端 process() 独立在跑,任务还在产出区,
    // 所以既不报红也不劝重试(重试会派出第二个任务),直接把用户送去产出区看进度。
    if (e instanceof GenerationStillRunningError) {
      toast.push(e.message, 'info');
      setBusy(false);
      setGenerating(false);
      navigate(areaPath(project.id, 'history'), { state: { focusJobId: e.jobId } });
      return;
    }
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
    // 生成失败也要收掉进度条,否则报错后「正在生成」会一直挂着
    setGenerating(false);
  };

  // 选题池就在左栏:选中只更新下游状态,不跳区(换选题清结果的级联保留)
  const onPickTopic = (id: string, loadedPresets: ContentPreset[]) => {
    w.setPublishing({});
    w.setOpportunityId(id);
    w.setResults([]);
    w.setJobId(undefined);
    w.setPresets(loadedPresets);
    w.setPresetId(loadedPresets.find((p) => p.isDefault)?.id ?? loadedPresets[0]?.id);
  };

  // 归档/删除选题:先收敛批量勾选(勾了但没选中的也得剔,否则批量会打到幽灵选题),
  // 再看它是否是当前选中项,级联清选中与结果
  const onOpportunityGone = (id: string) => {
    w.setCheckedIds((cur) => pruneCheckedIds(cur, id));
    if (id !== w.opportunityId) return;
    w.setOpportunityId('');
    w.setPublishing({});
    w.setResults([]);
    w.setJobId(undefined);
  };

  const onAnalyzed = (opps: TopicOpportunity[]) => {
    w.setPublishing({});
    w.setOpportunities(opps);
    w.setOpportunityId('');
    w.setResults([]);
    w.setJobId(undefined);
  };

  const onGenerated = (r: QuickCandidateView[], id: string) => {
    w.setResults(r);
    w.setJobId(id);
  };

  // 进入批量态:预设可能还没加载过(单篇路径是选题时才拉),按需补一次
  const onConfigBatch = async () => {
    // A normal batch is a fresh creative action, never a replay of one author's truth.
    w.setPublishing({});
    let list = w.presets;
    if (list.length === 0) {
      setBusy(true);
      try {
        list = (await api.presets.list(project.id)).items;
        w.setPresets(list);
        setBusy(false);
      } catch (e) { fail(e, '读取预设失败'); return; }
    }
    w.setBatchMode(true);
    w.setBatchPresetIds(list.filter((p) => p.isDefault).map((p) => p.id));
  };

  const onSubmitBatch = async () => {
    if (w.checkedIds.length === 0 || w.batchPresetIds.length === 0) return;
    setBusy(true);
    try {
      // 后端 selectOpportunity 要求选题及其依赖已审批,批量与单篇共用同一审批段
      const approved = await approveOpportunitiesForBatch({ project, opportunityIds: w.checkedIds });
      const jobs = buildBatchJobs({
        project,
        opportunities: approved,
        presets: w.presets.filter((p) => w.batchPresetIds.includes(p.id)),
        overrides: w.overrides,
        imageAssetIds: w.imageAssetIds,
        publishing: w.publishing,
      });
      const batch = await api.generationBatches.create({ projectId: project.id, jobs });
      setBusy(false);
      w.setBatchMode(false);
      w.setBatchPresetIds([]);
      w.setCheckedIds([]);
      w.setActiveBatchId(batch.id);
      navigate(areaPath(project.id, 'history'));
      toast.push(`已提交 ${jobs.length} 篇，正在后台生成`);
    } catch (e) { fail(e, '批量生成提交失败'); }
  };

  return (
    <CreateTab
      project={project}
      opportunities={w.opportunities}
      opportunityId={w.opportunityId}
      presets={w.presets}
      presetId={w.presetId}
      overrides={w.overrides}
      imageAssetIds={w.imageAssetIds}
      publishing={w.publishing}
      jobId={w.jobId}
      results={w.results}
      busy={busy}
      setBusy={setBusy}
      generating={generating}
      setGenerating={setGenerating}
      fail={fail}
      onPickTopic={onPickTopic}
      onAnalyzed={onAnalyzed}
      setOpportunities={w.setOpportunities}
      onOpportunityGone={onOpportunityGone}
      setPresetId={w.setPresetId}
      setPresets={w.setPresets}
      setOverrides={w.setOverrides}
      setImageAssetIds={w.setImageAssetIds}
      onGenerated={onGenerated}
      goTo={(area: QuickArea) => navigate(areaPath(project.id, area))}
      checkedIds={w.checkedIds}
      onToggleCheck={(id) => w.setCheckedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
      onConfigBatch={() => void onConfigBatch()}
      batchMode={w.batchMode}
      batchPresetIds={w.batchPresetIds}
      onToggleBatchPreset={(id) => w.setBatchPresetIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
      onSubmitBatch={() => void onSubmitBatch()}
      onCancelBatch={() => { w.setBatchMode(false); w.setBatchPresetIds([]); }}
    />
  );
}
