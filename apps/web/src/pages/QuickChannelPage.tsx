import { useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { useToast } from '../components/Ui';
import { QuickHome } from '../components/quick/QuickHome';
import { OverviewTab } from '../components/quick/OverviewTab';
import { ProjectKnowledgeTab } from '../components/quick/ProjectKnowledgeTab';
import { CreateTab } from '../components/quick/CreateTab';
import { HistoryTab } from '../components/quick/HistoryTab';
import { type QuickCandidateView } from '../lib/quick-generation';
import { clearDownstreamOfProject, clearResults, type QuickTab } from '../lib/quick-channel-state';
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

  // 归档/删除选题后调用:若它是当前选中项,级联清选中与结果(同 onPickTopic 的清法)
  const onOpportunityGone = (id: string) => {
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
          />
        )}
        {activeTab === 'history' && (
          <HistoryTab
            project={project} history={history} busy={busy} setBusy={setBusy} fail={fail} setHistory={setHistory}
          />
        )}
      </div>
    </div>
  );
}
