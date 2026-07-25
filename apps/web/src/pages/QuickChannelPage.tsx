import { useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { useToast } from '../components/Ui';
import { QuickHome } from '../components/quick/QuickHome';
import { OverviewTab } from '../components/quick/OverviewTab';
import { ProjectKnowledgeTab } from '../components/quick/ProjectKnowledgeTab';
import { CreateTab } from '../components/quick/CreateTab';
import { HistoryTab } from '../components/quick/HistoryTab';
import { approveOpportunitiesForBatch, type QuickCandidateView } from '../lib/quick-generation';
import { api } from '../lib/api';
import { buildBatchJobs } from '../lib/quick-batch';
import { extractRecipe, resolveRecipeTargets } from '../lib/quick-recipe';
import { clearDownstreamOfProject, clearResults, pruneCheckedIds, type QuickTab } from '../lib/quick-channel-state';
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from '../types';
import type { SimpleSettingOverrides } from '../lib/simple-generation';

const TAB_LABELS: Record<QuickTab, string> = {
  overview: '总览',
  knowledge: '知识库',
  create: '创作',
  history: '产出',
};

const TAB_ORDER: QuickTab[] = ['overview', 'knowledge', 'create', 'history'];

export function QuickChannelPage() {
  const { projects, loading } = useProjects();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [presets, setPresets] = useState<ContentPreset[]>([]);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<SimpleSettingOverrides>({});
  const [results, setResults] = useState<QuickCandidateView[]>([]);
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [imageAssetIds, setImageAssetIds] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<QuickTab>('overview');
  const [busy, setBusy] = useState(false);
  // 批量:左栏勾选的选题 + 右栏批量态 + 批量预设多选 + 提交后要高亮的批次
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [batchPresetIds, setBatchPresetIds] = useState<string[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | undefined>(undefined);

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  // 四区导航常开,goTo 不再门控
  const goTo = (tab: QuickTab) => setActiveTab(tab);

  const onProjectChosen = (p: Project) => {
    setProject(p);
    const cleared = clearDownstreamOfProject();
    setOpportunities(cleared.opportunities);
    setOpportunityId(cleared.opportunityId);
    setResults(cleared.results);
    setPresetId(undefined);
    setOverrides({});
    setImageAssetIds([]);
    setJobId(undefined);
    setCheckedIds([]);
    setBatchMode(false);
    setBatchPresetIds([]);
    setActiveBatchId(undefined);
    setActiveTab('overview');
  };

  // 重命名/保存设置:只更新项目本身,不动下游选题/配置/结果
  const onProjectUpdated = (p: Project) => {
    setProject(p);
  };

  // 回首页/删项目共用:清空项目与全部下游状态,回到「总览」标签
  const clearWorkspace = () => {
    setProject(null);
    const cleared = clearDownstreamOfProject();
    setOpportunities(cleared.opportunities);
    setOpportunityId(cleared.opportunityId);
    setResults(cleared.results);
    setPresetId(undefined);
    setOverrides({});
    setImageAssetIds([]);
    setJobId(undefined);
    setCheckedIds([]);
    setBatchMode(false);
    setBatchPresetIds([]);
    setActiveBatchId(undefined);
    setActiveTab('overview');
  };

  // 删除项目:清空后回首页
  const onProjectDeleted = () => clearWorkspace();

  // 面包屑「‹ 全部项目」:放弃当前项目回首页(与删项目同一清法)
  const onBackToHome = () => clearWorkspace();

  const onAnalyzed = (opps: TopicOpportunity[]) => {
    setOpportunities(opps);
    setOpportunityId('');
    setResults(clearResults().results);
    setJobId(undefined);
    setActiveTab('create');
  };

  // 选题池就在生成区左侧:选中只更新下游状态,不跳标签(换选题清结果的级联保留)
  const onPickTopic = (id: string, loadedPresets: ContentPreset[]) => {
    setOpportunityId(id);
    setResults(clearResults().results);
    setJobId(undefined);
    setPresets(loadedPresets);
    setPresetId(loadedPresets.find((p) => p.isDefault)?.id ?? loadedPresets[0]?.id);
  };

  // 归档/删除选题后调用:先收敛批量勾选(勾了但没选中的也得剔,否则批量提交会打到幽灵选题),
  // 再看它是否是当前选中项,级联清选中与结果(同 onPickTopic 的清法)
  const onOpportunityGone = (id: string) => {
    setCheckedIds((cur) => pruneCheckedIds(cur, id));
    if (id !== opportunityId) return;
    setOpportunityId('');
    setResults(clearResults().results);
    setJobId(undefined);
  };

  // 结果就地出现在创作区右栏,不再跳标签
  const onGenerated = (r: QuickCandidateView[], id: string) => {
    setResults(r);
    setJobId(id);
  };

  const onToggleCheck = (id: string) =>
    setCheckedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const onToggleBatchPreset = (id: string) =>
    setBatchPresetIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // 进入批量态:预设可能还没加载过(单篇路径是选题时才拉),这里按需补一次
  const onConfigBatch = async () => {
    let list = presets;
    if (list.length === 0) {
      setBusy(true);
      try {
        list = (await api.presets.list(project!.id)).items;
        setPresets(list);
        setBusy(false);
      } catch (e) { fail(e, '读取预设失败'); return; }
    }
    setBatchMode(true);
    setBatchPresetIds(list.filter((p) => p.isDefault).map((p) => p.id));
  };

  const onCancelBatch = () => {
    setBatchMode(false);
    setBatchPresetIds([]);
  };

  const onSubmitBatch = async () => {
    if (!project || checkedIds.length === 0 || batchPresetIds.length === 0) return;
    setBusy(true);
    try {
      // 后端 selectOpportunity 要求选题及其依赖已审批,批量与单篇共用同一审批段
      const approved = await approveOpportunitiesForBatch({ project, opportunityIds: checkedIds });
      const jobs = buildBatchJobs({
        project,
        opportunities: approved,
        presets: presets.filter((p) => batchPresetIds.includes(p.id)),
        overrides,
        imageAssetIds,
      });
      const batch = await api.generationBatches.create({ projectId: project.id, jobs });
      setBusy(false);
      setBatchMode(false);
      setBatchPresetIds([]);
      setCheckedIds([]);
      setActiveBatchId(batch.id);
      setActiveTab('history');
      toast.push(`已提交 ${jobs.length} 篇，正在后台生成`);
    } catch (e) { fail(e, '批量生成提交失败'); }
  };

  // 「再来一篇同款」:把历史任务的配方回灌创作区(不直接生成,留一步给人改)
  const onReuseRecipe = async (job: GenerationJob) => {
    if (!project) return;
    setBusy(true);
    try {
      // 选题池/预设可能还没在本次会话加载过,按需各拉一次再校验失效
      const [oppList, presetList] = await Promise.all([
        opportunities.length > 0 ? Promise.resolve({ items: opportunities }) : api.opportunities.list(project.id),
        api.presets.list(project.id),
      ]);
      setOpportunities(oppList.items);
      setPresets(presetList.items);
      const targets = resolveRecipeTargets(extractRecipe(job), oppList.items, presetList.items);
      setOpportunityId(targets.opportunityId);
      setPresetId(targets.presetId);
      setOverrides(targets.overrides);
      setImageAssetIds(targets.imageAssetIds);
      setResults(clearResults().results);
      setJobId(undefined);
      setBatchMode(false);
      setBatchPresetIds([]);
      setActiveTab('create');
      setBusy(false);
      for (const warning of targets.warnings) toast.push(warning, 'info');
      if (targets.warnings.length === 0) toast.push('已回填这篇的配置，确认后点「生成文案」');
    } catch (e) { fail(e, '回填配方失败'); }
  };

  // Home 态:未选项目 → 产品首页(卡墙选项目/内联新建)
  if (!project) {
    return (
      <div className="page qc-page">
        <QuickHome
          projects={projects} loading={loading} busy={busy} setBusy={setBusy} fail={fail}
          onProjectChosen={onProjectChosen}
        />
      </div>
    );
  }

  // 工作区态:已选项目 → 四区结构(总览/知识库/创作/产出),标签全常开
  return (
    <div className="page qc-page">
      <div className="qc-crumb">
        <button type="button" className="qc-crumb__back" onClick={onBackToHome}>‹ 全部项目</button>
        <h1>{project.name}</h1>
        {project.domain && <small>{project.domain}</small>}
      </div>

      <nav className="qc-tabs">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`qc-tab${tab === activeTab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>

      <div className={activeTab === 'create' ? 'qc-panel qc-panel--wide' : 'qc-panel'} key={activeTab}>
        {activeTab === 'overview' && (
          <OverviewTab
            project={project} busy={busy} setBusy={setBusy} fail={fail} goTo={goTo}
            onProjectUpdated={onProjectUpdated} onProjectDeleted={onProjectDeleted}
          />
        )}
        {activeTab === 'knowledge' && (
          <ProjectKnowledgeTab
            project={project} busy={busy} setBusy={setBusy} fail={fail} onAnalyzed={onAnalyzed}
          />
        )}
        {activeTab === 'create' && (
          <CreateTab
            project={project} opportunities={opportunities} opportunityId={opportunityId}
            presets={presets} presetId={presetId} overrides={overrides} imageAssetIds={imageAssetIds}
            jobId={jobId} results={results} busy={busy} setBusy={setBusy} fail={fail}
            onPickTopic={onPickTopic} onAnalyzed={onAnalyzed} setOpportunities={setOpportunities}
            onOpportunityGone={onOpportunityGone} setPresetId={setPresetId} setPresets={setPresets}
            setOverrides={setOverrides} setImageAssetIds={setImageAssetIds} onGenerated={onGenerated}
            goTo={goTo}
            checkedIds={checkedIds} onToggleCheck={onToggleCheck} onConfigBatch={() => void onConfigBatch()}
            batchMode={batchMode} batchPresetIds={batchPresetIds} onToggleBatchPreset={onToggleBatchPreset}
            onSubmitBatch={() => void onSubmitBatch()} onCancelBatch={onCancelBatch}
          />
        )}
        {activeTab === 'history' && (
          <HistoryTab
            project={project} history={history} busy={busy} setBusy={setBusy} fail={fail} setHistory={setHistory}
            activeBatchId={activeBatchId} onReuseRecipe={(job) => void onReuseRecipe(job)}
          />
        )}
      </div>
    </div>
  );
}
