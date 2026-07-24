import { useEffect, useState } from 'react';
import { ArrowRight, FileText, Layers, Lightbulb, Map, Trash2 } from 'lucide-react';
import { useProjects } from '../ProjectContext';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import {
  deriveNextAction,
  parseCities,
  parseDoctors,
  formatCities,
  formatDoctors,
  type AnalysisState,
  type QuickTab,
} from '../../lib/quick-channel-state';
import { V2Instrument, V2InstrumentCell, type V2InstrumentTone } from '../V2';
import type { GenerationJob, Project, ProjectIntelligence, TopicOpportunity } from '../../types';

interface Props {
  project: Project;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  goTo: (tab: QuickTab) => void;
  onProjectUpdated: (p: Project) => void;
  onProjectDeleted: () => void;
}

// 内容地图仪表格:tone 与文案按分析态给(V2InstrumentTone 无 muted,未分析用 blue 灰蓝表达「未知」)
const MAP_CELL: Record<AnalysisState, { tone: V2InstrumentTone; value: string }> = {
  none: { tone: 'blue', value: '未分析' },
  draft: { tone: 'ai', value: '待确认' },
  stale: { tone: 'warn', value: '需更新' },
  ready: { tone: 'ok', value: '已就绪' },
  failed: { tone: 'error', value: '分析失败' },
};

export function OverviewTab({ project, busy, setBusy, fail, goTo, onProjectUpdated, onProjectDeleted }: Props) {
  const { updateProject, removeProject, refresh } = useProjects();
  const toast = useToast();
  const [intel, setIntel] = useState<ProjectIntelligence | null>(null);
  const [opps, setOpps] = useState<TopicOpportunity[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [renaming, setRenaming] = useState('');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [citiesInput, setCitiesInput] = useState('');
  const [doctorsInput, setDoctorsInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 挂载/换项目:三路并行自载,各自静默回落为空值(总览只做读数,不阻塞)
  useEffect(() => {
    let cancelled = false;
    setIntel(null);
    setOpps([]);
    setJobs([]);
    api.intelligence.get(project.id)
      .then((r) => { if (!cancelled && r.status !== 'missing') setIntel(r); })
      .catch(() => { /* 静默回落 */ });
    api.opportunities.list(project.id)
      .then((r) => { if (!cancelled) setOpps(r.items); })
      .catch(() => { if (!cancelled) setOpps([]); });
    api.generations.list(project.id)
      .then((r) => { if (!cancelled) setJobs(r.items); })
      .catch(() => { if (!cancelled) setJobs([]); });
    setRenaming(project.name);
    setDomain(project.domain ?? '');
    setDescription(project.description ?? '');
    setCitiesInput(formatCities(project.cities));
    setDoctorsInput(formatDoctors(project.doctors));
    return () => { cancelled = true; };
  }, [project]);

  // 分析态推导(组件侧):ready 带 staleReasons 与 status='stale' 同属「需更新」;analyzing/queued 视为 none
  const staleReasons = intel?.staleReasons ?? [];
  const analyzing = intel?.status === 'analyzing' || intel?.status === 'queued';
  const analysis: AnalysisState = !intel?.id
    ? 'none'
    : intel.status === 'ready' && staleReasons.length > 0
      ? 'stale'
      : intel.status === 'stale'
        ? 'stale'
        : intel.status === 'draft'
          ? 'draft'
          : intel.status === 'failed'
            ? 'failed'
            : intel.status === 'ready'
              ? 'ready'
              : 'none';

  const collectedCount = opps.filter((o) => o.collectionStatus === 'collected').length;
  const activeCount = opps.filter((o) => o.collectionStatus !== 'collected' && o.collectionStatus !== 'archived').length;

  const action = deriveNextAction({
    hasKnowledge: (project.knowledgeCount ?? 0) > 0,
    analysis,
    topicCount: opps.length,
    generationCount: jobs.length,
  });
  const actionNote = analyzing ? '分析进行中' : action.note;

  const recent = jobs.slice(0, 3);
  const mapCell = MAP_CELL[analysis];
  const mapNote = analysis === 'stale'
    ? staleReasons.join('；') || '资料有更新'
    : analysis === 'failed'
      ? intel?.error || undefined
      : analysis === 'draft'
        ? '生成时会自动确认,不阻塞使用'
        : undefined;

  const rename = async () => {
    if (!renaming.trim() || renaming.trim() === project.name) return;
    setBusy(true);
    try {
      const updated = await updateProject(project.id, { name: renaming.trim() });
      onProjectUpdated(updated);
      setBusy(false);
    } catch (e) { fail(e, '重命名失败'); }
  };

  const saveSettings = async () => {
    setBusy(true);
    try {
      const updated = await updateProject(project.id, {
        domain: domain.trim() || undefined,
        description: description.trim() || undefined,
        cities: parseCities(citiesInput),
        doctors: parseDoctors(doctorsInput),
      });
      toast.push('项目设置已保存');
      onProjectUpdated(updated);
      setBusy(false);
    } catch (e) { fail(e, '保存项目设置失败'); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await removeProject(project.id);
      await refresh();
      setConfirmDelete(false);
      setBusy(false);
      onProjectDeleted();
    } catch (e) { fail(e, '删除项目失败'); }
  };

  return (
    <div className="qc-step">
      <V2Instrument columns={4}>
        <V2InstrumentCell tone={mapCell.tone} icon={<Map size={14} />} label="内容地图" value={mapCell.value} note={mapNote} />
        <V2InstrumentCell tone="brand" icon={<FileText size={14} />} label="知识文件" value={project.knowledgeCount ?? 0} unit="个" />
        <V2InstrumentCell tone="ai" icon={<Lightbulb size={14} />} label="选题池" value={opps.length} unit="个" note={`未处理 ${activeCount} · 收藏 ${collectedCount}`} />
        <V2InstrumentCell tone="ok" icon={<Layers size={14} />} label="累计产出" value={jobs.length} unit="篇" />
      </V2Instrument>

      <div className="qc-overview-next">
        <Button icon={<ArrowRight size={16} />} disabled={analyzing || busy} onClick={() => goTo(action.tab)}>{action.label}</Button>
        {actionNote && <small className="qc-hint">{actionNote}</small>}
      </div>

      {recent.length > 0 && (
        <div className="qc-overview-recent">
          <span className="qc-overview-recent__label">最近产出</span>
          <ul>
            {recent.map((job) => (
              <li key={job.id}>
                <button type="button" onClick={() => goTo('history')}>
                  <strong>{job.topic || '未命名选题'}</strong>
                  <small>{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="qc-advanced">
        <summary>项目设置</summary>
        <div className="qc-advanced-grid">
          <Field label="重命名">
            <div className="qc-project-row">
              <input value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <Button variant="ghost" loading={busy} onClick={() => void rename()}>保存</Button>
            </div>
          </Field>
          <Field label="行业">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="如:医美" />
          </Field>
          <Field label="说明">
            <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder="项目背景、定位等" />
          </Field>
          <Field label="城市" hint="多个城市用逗号或顿号分隔">
            <input value={citiesInput} onChange={(e) => setCitiesInput(e.target.value)} placeholder="如:上海、杭州" />
          </Field>
          <Field label="医生" hint="每行一个名字">
            <textarea value={doctorsInput} rows={3} onChange={(e) => setDoctorsInput(e.target.value)} placeholder={'每行一个医生名字\n如:张三\n李四'} />
          </Field>
          <div className="qc-project-row">
            <Button variant="secondary" loading={busy} onClick={() => void saveSettings()}>保存设置</Button>
            <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>删除项目</Button>
          </div>
        </div>
      </details>

      <Modal open={confirmDelete} title="删除项目" description={`确定删除「${project.name}」？此操作不可撤销。`} onClose={() => setConfirmDelete(false)}
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button><Button loading={busy} onClick={() => void doDelete()}>确认删除</Button></>}>
        <p className="qc-hint">项目及其知识、选题、历史都将被移除。</p>
      </Modal>
    </div>
  );
}
