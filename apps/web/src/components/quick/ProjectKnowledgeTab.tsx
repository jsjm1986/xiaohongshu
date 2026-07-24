import { useEffect, useState } from 'react';
import { Trash2, Upload, Sparkles, Building2, Lightbulb } from 'lucide-react';
import { useProjects } from '../ProjectContext';
import { Button, Field, Modal } from '../Ui';
import { api } from '../../lib/api';
import { V2Instrument, V2InstrumentCell } from '../V2';
import { QuickTaskProgress } from './QuickTaskProgress';
import type { AnalysisTask, KnowledgeFile, Project, ProjectIntelligence, TopicOpportunity } from '../../types';

const CATEGORIES = ['未分类', '知识地图', '项目与服务', '用户与场景', '案例样本', '方法论', '约束'];
const KINDS = ['已知事实', '案例样本', '用户观点', '方法论推理', '猜想', '信息不足', '禁止表达'];

interface Props {
  project: Project | null;
  projects: Project[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onProjectChosen: (p: Project) => void;
  onAnalyzed: (opps: TopicOpportunity[]) => void;
}

export function ProjectKnowledgeTab({ project, projects, busy, setBusy, fail, onProjectChosen, onAnalyzed }: Props) {
  const { addProject, updateProject, removeProject, refresh } = useProjects();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState('');
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [category, setCategory] = useState('未分类');
  const [kind, setKind] = useState('已知事实');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [intel, setIntel] = useState<ProjectIntelligence | null>(null);
  const [topicCount, setTopicCount] = useState(0);
  const [analysisTask, setAnalysisTask] = useState<AnalysisTask | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (!project) { setFiles([]); setIntel(null); setTopicCount(0); return; }
    let cancelled = false;
    setIntel(null);
    setTopicCount(0);
    api.knowledge.list(project.id).then((r) => { if (!cancelled) setFiles(r.items); }).catch(() => { if (!cancelled) setFiles([]); });
    api.intelligence.get(project.id).then((r) => { if (!cancelled && r.status !== 'missing') setIntel(r); }).catch(() => {});
    api.opportunities.list(project.id).then((r) => { if (!cancelled) setTopicCount(r.items.length); }).catch(() => {});
    setRenaming(project.name);
    return () => { cancelled = true; };
  }, [project]);

  const analyzed = Boolean(intel?.id);

  const refreshAnalysisTask = () => {
    if (!project) return Promise.resolve();
    return api.intelligence.tasks.list(project.id).then((tasks) => {
      const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setAnalysisTask(sorted.find((t) => t.kind === 'project') ?? null);
    }).catch(() => { /* 非致命 */ });
  };

  useEffect(() => {
    if (!analyzing) return;
    const timer = window.setInterval(() => { void refreshAnalysisTask(); }, 1800);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzing, project]);

  const createProject = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const created = await addProject({ name: newName.trim() });
      setNewName('');
      onProjectChosen(created);
      setBusy(false);
    } catch (e) { fail(e, '创建项目失败'); }
  };

  const rename = async () => {
    if (!project || !renaming.trim() || renaming.trim() === project.name) return;
    setBusy(true);
    try {
      const updated = await updateProject(project.id, { name: renaming.trim() });
      onProjectChosen(updated);
      setBusy(false);
    } catch (e) { fail(e, '重命名失败'); }
  };

  const doDelete = async () => {
    if (!project) return;
    setBusy(true);
    try {
      await removeProject(project.id);
      await refresh();
      setConfirmDelete(false);
      setBusy(false);
      window.location.reload();
    } catch (e) { fail(e, '删除项目失败'); }
  };

  const uploadFiles = async (picked: File[]) => {
    if (!project || picked.length === 0) return;
    setBusy(true);
    setPending(picked);
    try {
      for (const f of picked) await api.knowledge.upload(project.id, f, category, kind);
      const r = await api.knowledge.list(project.id);
      setFiles(r.items);
      setPending([]);
      setBusy(false);
    } catch (e) { setPending([]); fail(e, '上传失败'); }
  };

  const removeFile = async (id: string) => {
    if (!project) return;
    setBusy(true);
    try {
      await api.knowledge.remove(id);
      setFiles((cur) => cur.filter((f) => f.id !== id));
      setBusy(false);
    } catch (e) { fail(e, '删除文件失败'); }
  };

  const analyze = async () => {
    if (!project) return;
    setBusy(true);
    setAnalyzing(true);
    void refreshAnalysisTask();
    try {
      const result = await api.intelligence.analyze(project.id, true);
      setIntel(result.intelligence);
      const opps = await api.opportunities.list(project.id);
      setTopicCount(opps.items.length);
      setAnalyzing(false);
      setAnalysisTask(null);
      onAnalyzed(opps.items);
      setBusy(false);
    } catch (e) { setAnalyzing(false); fail(e, '分析知识库失败'); }
  };

  const goToTopics = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const opps = await api.opportunities.list(project.id);
      onAnalyzed(opps.items);
      setBusy(false);
    } catch (e) { fail(e, '读取选题失败'); }
  };

  return (
    <div className="qc-step">
      <Field label="项目">
        <div className="qc-project-row">
          <select value={project?.id ?? ''} onChange={(e) => {
            const p = projects.find((x) => x.id === e.target.value);
            if (p) onProjectChosen(p);
          }}>
            <option value="" disabled>选择已有项目…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </Field>

      <Field label="或新建项目">
        <div className="qc-project-row">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="项目名称" />
          <Button variant="secondary" loading={busy} disabled={!newName.trim()} onClick={() => void createProject()}>新建</Button>
        </div>
      </Field>

      {project && (
        <>
          <details className="qc-advanced">
            <summary>项目设置</summary>
            <div className="qc-advanced-grid">
              <Field label="重命名">
                <div className="qc-project-row">
                  <input value={renaming} onChange={(e) => setRenaming(e.target.value)} />
                  <Button variant="ghost" loading={busy} onClick={() => void rename()}>保存</Button>
                </div>
              </Field>
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>删除项目</Button>
            </div>
          </details>

          {analyzed ? (
            <V2Instrument columns={3}>
              <V2InstrumentCell tone="brand" icon={<Sparkles size={14} />} label="实体" value={intel?.entity || '已分析'} />
              <V2InstrumentCell tone="ai" icon={<Building2 size={14} />} label="行业" value={intel?.industry || '已建立内容地图'} />
              <V2InstrumentCell tone="ok" icon={<Lightbulb size={14} />} label="可用选题" value={topicCount} unit="个" />
            </V2Instrument>
          ) : (
            <V2Instrument columns={2}>
              <V2InstrumentCell tone="brand" icon={<Sparkles size={14} />} label="状态" value="尚未分析" />
              <V2InstrumentCell tone="ai" icon={<Lightbulb size={14} />} label="下一步" value="上传知识 → 分析" note="AI 会建立内容地图并生成选题" />
            </V2Instrument>
          )}

          {analyzing && (
            <QuickTaskProgress text="三段模型串联运行:蓝图 → 缺口与策略 → 选题。完成前请勿离开或重复触发。" task={analysisTask} />
          )}

          <Field label="知识文件">
            <ul className="qc-file-list">
              {files.map((f) => (
                <li key={f.id}>
                  <span className="qc-file-name">{f.name}<small className="qc-hint"> · {f.category ?? '未分类'}</small></span>
                  <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void removeFile(f.id)}>删除</Button>
                </li>
              ))}
              {files.length === 0 && <li className="qc-hint">还没有知识文件</li>}
            </ul>
          </Field>

          <Field label="上传知识文件（.md / .txt，可多选，选中即上传）">
            <input
              type="file"
              accept=".md,.txt"
              multiple
              disabled={busy}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (picked.length > 0) void uploadFiles(picked);
              }}
            />
            {busy && pending.length > 0 && <small className="qc-hint">正在上传 {pending.length} 个文件…</small>}
          </Field>
          <details className="qc-advanced">
            <summary>上传分类（默认：未分类 / 已知事实；改分类需删除后重传）</summary>
            <div className="qc-advanced-grid">
              <Field label="分类"><select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="证据类型"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            </div>
          </details>

          <div className="qc-project-row">
            {analyzed ? (
              <>
                {topicCount > 0 && <Button loading={busy} onClick={() => void goToTopics()}>去选题</Button>}
                <Button variant="ghost" loading={busy} disabled={busy || analyzing} onClick={() => void analyze()}>重新分析</Button>
              </>
            ) : (
              <Button loading={busy} disabled={busy || analyzing} onClick={() => void analyze()}>分析知识库</Button>
            )}
          </div>
        </>
      )}

      <Modal open={confirmDelete} title="删除项目" description={`确定删除「${project?.name}」？此操作不可撤销。`} onClose={() => setConfirmDelete(false)}
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button><Button loading={busy} onClick={() => void doDelete()}>确认删除</Button></>}>
        <p className="qc-hint">项目及其知识、选题、历史都将被移除。</p>
      </Modal>
    </div>
  );
}
