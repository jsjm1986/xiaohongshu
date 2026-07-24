import { useEffect, useMemo, useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { useToast } from '../components/Ui';
import { V2Hero } from '../components/V2';
import { api } from '../lib/api';
import { ProjectKnowledgeTab } from '../components/quick/ProjectKnowledgeTab';
import { TopicTab } from '../components/quick/TopicTab';
import { ConfigTab } from '../components/quick/ConfigTab';
import { ResultTab } from '../components/quick/ResultTab';
import { HistoryTab } from '../components/quick/HistoryTab';
import { type QuickCandidateView } from '../lib/quick-generation';
import {
  initialZone, zoneReachable, createStepReachable, createStepStatus,
  clearDownstreamOfProject, clearResults,
  type QuickZone, type CreateStep,
} from '../lib/quick-channel-state';
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from '../types';
import type { SimpleSettingOverrides } from '../lib/simple-generation';

const ZONE_LABELS: Record<QuickZone, string> = { prepare: '准备', create: '创作', history: '历史' };
const ZONE_ORDER: QuickZone[] = ['prepare', 'create', 'history'];
const STEP_LABELS: Record<CreateStep, string> = { topic: '选题', config: '配置', result: '结果' };
const STEP_ORDER: CreateStep[] = ['topic', 'config', 'result'];

export function QuickChannelPage() {
  const { projects, currentProject, setProjectId } = useProjects();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [presets, setPresets] = useState<ContentPreset[]>([]);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<SimpleSettingOverrides>({});
  const [results, setResults] = useState<QuickCandidateView[]>([]);
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [zone, setZone] = useState<QuickZone>('prepare');
  const [step, setStep] = useState<CreateStep>('topic');
  const [busy, setBusy] = useState(false);

  const zones = useMemo(
    () => zoneReachable({ hasProject: Boolean(project), opportunityCount: opportunities.length }),
    [project, opportunities.length],
  );
  const stepReach = useMemo(
    () => createStepReachable({ opportunityCount: opportunities.length, hasOpportunity: Boolean(opportunityId), resultCount: results.length }),
    [opportunities.length, opportunityId, results.length],
  );
  const steps = useMemo(
    () => createStepStatus({ activeStep: step, opportunityCount: opportunities.length, hasOpportunity: Boolean(opportunityId), resultCount: results.length }),
    [step, opportunities.length, opportunityId, results.length],
  );

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  const resetDownstream = (p: Project) => {
    setProject(p);
    const cleared = clearDownstreamOfProject();
    setOpportunities(cleared.opportunities);
    setOpportunityId(cleared.opportunityId);
    setResults(cleared.results);
    setPresetId(undefined);
    setOverrides({});
  };

  const switchProject = async (p: Project) => {
    resetDownstream(p);
    setProjectId(p.id);
    setStep('topic');
    try {
      const opps = await api.opportunities.list(p.id);
      if (opps.items.length > 0) {
        setOpportunities(opps.items);
        setZone(initialZone({ opportunityCount: opps.items.length }));
      } else {
        setZone('prepare');
      }
    } catch {
      setZone('prepare');
    }
  };

  useEffect(() => {
    if (!project && currentProject) void switchProject(currentProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject]);

  const onProjectChosen = (p: Project) => { resetDownstream(p); setProjectId(p.id); };

  const onAnalyzed = (opps: TopicOpportunity[]) => {
    setOpportunities(opps);
    setOpportunityId('');
    setResults(clearResults().results);
    setZone('create');
    setStep('topic');
  };

  const onPickTopic = (id: string, loadedPresets: ContentPreset[]) => {
    setOpportunityId(id);
    setResults(clearResults().results);
    setPresets(loadedPresets);
    setPresetId(loadedPresets.find((p) => p.isDefault)?.id ?? loadedPresets[0]?.id);
    setStep('config');
  };

  const onGenerated = (r: QuickCandidateView[]) => { setResults(r); setStep('result'); };

  const goToZone = (z: QuickZone) => { if (zones[z]) setZone(z); };
  const goToStep = (s: CreateStep) => { if (stepReach[s]) setStep(s); };

  return (
    <div className="page qc-page">
      <V2Hero index="Q" status={<>极简创作 · 完整频道</>} title="极简创作" />

      <div className="qc-topbar">
        <select
          className="qc-switcher"
          value={project?.id ?? ''}
          onChange={(e) => {
            const p = projects.find((x) => x.id === e.target.value);
            if (p) void switchProject(p);
          }}
        >
          <option value="" disabled>选择项目…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <nav className="qc-zones">
          {ZONE_ORDER.map((z) => (
            <button
              key={z}
              type="button"
              className={`qc-zone${z === zone ? ' active' : ''}`}
              disabled={!zones[z]}
              onClick={() => goToZone(z)}
            >
              {ZONE_LABELS[z]}
            </button>
          ))}
        </nav>
      </div>

      <div className="qc-panel">
        {zone === 'prepare' && (
          <ProjectKnowledgeTab
            project={project} projects={projects} busy={busy} setBusy={setBusy} fail={fail}
            onProjectChosen={onProjectChosen} onAnalyzed={onAnalyzed}
          />
        )}

        {zone === 'create' && (
          <>
            <nav className="qc-steps">
              {STEP_ORDER.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  className={`qc-step-chip qc-step-chip--${steps[s]}`}
                  disabled={!stepReach[s]}
                  onClick={() => goToStep(s)}
                >
                  <span className="qc-step-chip__dot">{steps[s] === 'done' ? '✓' : i + 1}</span>
                  {STEP_LABELS[s]}
                </button>
              ))}
            </nav>

            {step === 'topic' && (
              <TopicTab
                project={project} opportunities={opportunities} opportunityId={opportunityId}
                busy={busy} setBusy={setBusy} fail={fail} onPickTopic={onPickTopic} onAnalyzed={onAnalyzed}
              />
            )}
            {step === 'config' && (
              <ConfigTab
                project={project} opportunityId={opportunityId} presets={presets} presetId={presetId}
                overrides={overrides} busy={busy} setBusy={setBusy} fail={fail}
                setPresetId={setPresetId} setOverrides={setOverrides} onGenerated={onGenerated}
              />
            )}
            {step === 'result' && (
              <ResultTab
                project={project} opportunityId={opportunityId} presetId={presetId} overrides={overrides}
                results={results} setBusy={setBusy} fail={fail} onGenerated={onGenerated} goToTopic={() => goToStep('topic')}
              />
            )}
          </>
        )}

        {zone === 'history' && (
          <HistoryTab
            project={project} history={history} busy={busy} setBusy={setBusy} fail={fail} setHistory={setHistory}
          />
        )}
      </div>
    </div>
  );
}
