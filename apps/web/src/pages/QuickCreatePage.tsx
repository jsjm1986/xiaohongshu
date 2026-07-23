import { ArrowRight, Sparkles, Upload } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { Button, Field, Skeleton, useToast } from '../components/Ui';
import { V2Hero } from '../components/V2';
import { QuickResult } from '../components/QuickResult';
import { api } from '../lib/api';
import { autoApproveAndGenerate, quickCandidateFields, type QuickCandidateView } from '../lib/quick-generation';
import type { ContentPreset, Project, TopicOpportunity } from '../types';

type Step = 'create' | 'upload' | 'analyzing' | 'pick-topic' | 'configure' | 'generating' | 'result';

export function QuickCreatePage() {
  const { addProject } = useProjects();
  const toast = useToast();
  const [step, setStep] = useState<Step>('create');
  const [name, setName] = useState('');
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [presets, setPresets] = useState<ContentPreset[]>([]);
  const [presetId, setPresetId] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<QuickCandidateView[]>([]);

  const fail = (e: unknown, fallback: string) => { toast.push(e instanceof Error ? e.message : fallback, 'error'); setBusy(false); };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await addProject({ name: name.trim() });
      setProject(created);
      setStep('upload');
      setBusy(false);
    } catch (e) { fail(e, '创建项目失败'); }
  };

  const analyze = async () => {
    if (!project) return;
    setBusy(true);
    try {
      for (const file of files) {
        await api.knowledge.upload(project.id, file, '未分类', '已知事实');
      }
      setStep('analyzing');
      await api.intelligence.analyze(project.id, true);
      const opps = await api.opportunities.list(project.id);
      setOpportunities(opps.items);
      setStep('pick-topic');
      setBusy(false);
    } catch (e) { setStep('upload'); fail(e, '分析知识库失败'); }
  };

  const pickTopic = async (id: string) => {
    if (!project) return;
    setOpportunityId(id);
    setBusy(true);
    try {
      const list = await api.presets.list(project.id);
      setPresets(list.items);
      setPresetId(list.items.find((p) => p.isDefault)?.id ?? list.items[0]?.id);
      setStep('configure');
      setBusy(false);
    } catch (e) { fail(e, '读取预设失败'); }
  };

  const generate = async () => {
    if (!project) return;
    setStep('generating');
    setBusy(true);
    try {
      const job = await autoApproveAndGenerate({ project, opportunityId, presetId });
      setResults((job.candidates ?? []).map(quickCandidateFields));
      setStep('result');
      setBusy(false);
    } catch (e) { setStep('configure'); fail(e, '生成失败'); }
  };

  const refreshTopics = async () => {
    if (!project) return;
    setStep('analyzing');
    setBusy(true);
    try {
      const opps = await api.opportunities.refresh(project.id);
      setOpportunities(opps.items);
      setStep('pick-topic');
      setBusy(false);
    } catch (e) { setStep('pick-topic'); fail(e, '换选题失败'); }
  };

  return (
    <div className="page quick-page">
      <V2Hero index="Q" status={<>极简创作 · 快速生成</>} title="极简创作" description="建项目、传资料、挑选题，直接拿可用文案。" />

      {step === 'create' && (
        <form className="quick-step" onSubmit={createProject}>
          <Field label="项目名称"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：去眼袋项目" required /></Field>
          <Button type="submit" loading={busy} icon={<ArrowRight size={16} />}>下一步</Button>
        </form>
      )}

      {step === 'upload' && (
        <div className="quick-step">
          <Field label="上传知识文件（.md / .txt，可多选）">
            <input type="file" accept=".md,.txt" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </Field>
          {files.length > 0 && <p className="quick-hint">{files.length} 个文件待分析</p>}
          <Button loading={busy} disabled={files.length === 0} icon={<Upload size={16} />} onClick={() => void analyze()}>分析知识库</Button>
        </div>
      )}

      {(step === 'analyzing' || step === 'generating') && (
        <div className="quick-step quick-loading">
          <span className="spinner" />
          <p>{step === 'analyzing' ? '正在分析知识库…' : '正在生成文案…'}</p>
          <Skeleton lines={4} />
        </div>
      )}

      {step === 'pick-topic' && (
        <div className="quick-step">
          <h2>挑一个选题</h2>
          <div className="quick-topic-list">
            {opportunities.map((o) => (
              <button key={o.id} type="button" className="quick-topic" onClick={() => void pickTopic(o.id)}>{o.title}</button>
            ))}
          </div>
          {opportunities.length === 0 && <p className="quick-hint">没有可用选题，试试换一批。</p>}
          <Button variant="ghost" onClick={() => void refreshTopics()}>换一批选题</Button>
        </div>
      )}

      {step === 'configure' && (
        <div className="quick-step">
          <Field label="快速配置（预设）">
            <select value={presetId ?? ''} onChange={(e) => setPresetId(e.target.value || undefined)}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isDefault ? '（默认）' : ''}</option>)}
            </select>
          </Field>
          <Button loading={busy} icon={<Sparkles size={16} />} onClick={() => void generate()}>生成文案</Button>
        </div>
      )}

      {step === 'result' && (
        <QuickResult
          candidates={results}
          onRegenerate={() => void generate()}
          onPickAnotherTopic={() => setStep('pick-topic')}
        />
      )}
    </div>
  );
}
