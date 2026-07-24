import { useMemo, useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { useToast } from '../components/Ui';
import { V2Hero } from '../components/V2';
import { ProjectKnowledgeTab } from '../components/quick/ProjectKnowledgeTab';
import { TopicTab } from '../components/quick/TopicTab';
import { ConfigTab } from '../components/quick/ConfigTab';
import { ResultTab } from '../components/quick/ResultTab';
import { HistoryTab } from '../components/quick/HistoryTab';
import { type QuickCandidateView } from '../lib/quick-generation';
import { tabReachable, clearDownstreamOfProject, clearResults, type QuickTab } from '../lib/quick-channel-state';
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from '../types';
import type { SimpleSettingOverrides } from '../lib/simple-generation';

const TAB_LABELS: Record<QuickTab, string> = {
  project: '项目 & 知识',
  topic: '选题',
  config: '配置',
  result: '结果',
  history: '历史',
};

const TAB_ORDER: QuickTab[] = ['project', 'topic', 'config', 'result', 'history'];

const TAB_HINT: Record<QuickTab, string> = {
  project: '',
  topic: '先分析知识库生成选题',
  config: '先选择一个选题',
  result: '先生成文案',
  history: '先选择或新建项目',
};

export function QuickChannelPage() {
  const { projects } = useProjects();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [presets, setPresets] = useState<ContentPreset[]>([]);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<SimpleSettingOverrides>({});
  const [results, setResults] = useState<QuickCandidateView[]>([]);
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [activeTab, setActiveTab] = useState<QuickTab>('project');
  const [busy, setBusy] = useState(false);

  const reachable = useMemo(
    () => tabReachable({
      hasProject: Boolean(project),
      opportunityCount: opportunities.length,
      hasOpportunity: Boolean(opportunityId),
      resultCount: results.length,
    }),
    [project, opportunities.length, opportunityId, results.length],
  );

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  const goTo = (tab: QuickTab) => { if (reachable[tab]) setActiveTab(tab); };

  const onProjectChosen = (p: Project) => {
    setProject(p);
    const cleared = clearDownstreamOfProject();
    setOpportunities(cleared.opportunities);
    setOpportunityId(cleared.opportunityId);
    setResults(cleared.results);
    setPresetId(undefined);
    setOverrides({});
  };

  const onAnalyzed = (opps: TopicOpportunity[]) => {
    setOpportunities(opps);
    setOpportunityId('');
    setResults(clearResults().results);
    setActiveTab('topic');
  };

  const onPickTopic = (id: string, loadedPresets: ContentPreset[]) => {
    setOpportunityId(id);
    setResults(clearResults().results);
    setPresets(loadedPresets);
    setPresetId(loadedPresets.find((p) => p.isDefault)?.id ?? loadedPresets[0]?.id);
    setActiveTab('config');
  };

  const onGenerated = (r: QuickCandidateView[]) => {
    setResults(r);
    setActiveTab('result');
  };

  return (
    <div className="page qc-page">
      <V2Hero index="Q" status={<>极简创作 · 完整频道</>} title="极简创作" description="一个页面完成建项目、传资料、选题、配置、生成、看历史。" />

      <nav className="qc-tabs">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            className={tab === activeTab ? 'active' : ''}
            disabled={!reachable[tab]}
            title={reachable[tab] ? '' : TAB_HINT[tab]}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>

      <div className="qc-panel">
        {activeTab === 'project' && (
          <ProjectKnowledgeTab
            project={project} projects={projects} busy={busy} setBusy={setBusy} fail={fail}
            onProjectChosen={onProjectChosen} onAnalyzed={onAnalyzed}
          />
        )}
        {activeTab === 'topic' && (
          <TopicTab
            project={project} opportunities={opportunities} opportunityId={opportunityId}
            busy={busy} setBusy={setBusy} fail={fail} onPickTopic={onPickTopic} onAnalyzed={onAnalyzed}
          />
        )}
        {activeTab === 'config' && (
          <ConfigTab
            project={project} opportunityId={opportunityId} presets={presets} presetId={presetId}
            overrides={overrides} busy={busy} setBusy={setBusy} fail={fail}
            setPresetId={setPresetId} setOverrides={setOverrides} onGenerated={onGenerated}
          />
        )}
        {activeTab === 'result' && (
          <ResultTab
            project={project} opportunityId={opportunityId} presetId={presetId} overrides={overrides}
            results={results} setBusy={setBusy} fail={fail} onGenerated={onGenerated} goTo={goTo}
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
