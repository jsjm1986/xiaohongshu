import { CheckCircle2, ChevronDown, Clock3, Eye, FileClock, Filter, RefreshCcw, Search, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, EmptyState, Skeleton } from '../components/Ui';
import { V2Hero, V2Instrument, V2InstrumentCell } from '../components/V2';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate } from '../lib/utils';
import type { GenerationJob, GenerationStatus } from '../types';

const statusLabel: Record<GenerationStatus, string> = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败' };

export function HistoryPage() {
  const { projects, projectId } = useProjects();
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | GenerationStatus>('all');
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const loadSequence = useRef(0);
  const navigate = useNavigate();

  const load = () => {
    const sequence = ++loadSequence.current;
    const requestedProjectId = projectId;
    const requestedScope = scope;
    if (requestedScope === 'current' && !requestedProjectId) {
      setJobs([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    api.generations.list(requestedScope === 'current' ? requestedProjectId : undefined)
      .then((result) => {
        if (sequence === loadSequence.current) setJobs(result.items);
      })
      .catch((error) => {
        if (sequence !== loadSequence.current) return;
        setLoadError(errorMessage(error, '生成记录加载失败'));
      })
      .finally(() => {
        if (sequence === loadSequence.current) setLoading(false);
      });
  };
  useEffect(() => {
    load();
    return () => { loadSequence.current += 1; };
  }, [projectId, scope]);

  const visible = useMemo(() => jobs.filter((job) => (status === 'all' || job.status === status) && (!search || `${job.topic}${job.goal || ''}${job.projectName || ''}`.toLowerCase().includes(search.toLowerCase()))), [jobs, search, status]);
  const totals = useMemo(() => ({ completed: jobs.filter((job) => job.status === 'completed').length, running: jobs.filter((job) => ['queued', 'running'].includes(job.status)).length, failed: jobs.filter((job) => job.status === 'failed').length }), [jobs]);

  return <div className="page history-page">
    <V2Hero
      status={<>{scope === 'current' ? '当前项目' : '全部项目'} · {loading ? '正在读取' : loadError ? '加载失败' : `共 ${jobs.length} 次运行`}</>}
      title="生成历史"
      description="每次运行都保存知识、公式、配置与随机种子快照。"
      actions={<Button icon={<Sparkles size={17} />} onClick={() => navigate('/generate')}>新建生成</Button>}
    />
    {!loading && !loadError && <V2Instrument columns={3}>
      <V2InstrumentCell
        tone="ok"
        icon={<CheckCircle2 size={15} />}
        label="已完成"
        value={totals.completed}
        unit="次"
        note="内容包已生成，可查看与导出"
      />
      <V2InstrumentCell
        tone="blue"
        icon={<Clock3 size={15} />}
        label="正在运行"
        value={totals.running}
        unit="次"
        note="排队或生成中，可查看进度"
      />
      <V2InstrumentCell
        tone="error"
        icon={<TriangleAlert size={15} />}
        label="未完成"
        value={totals.failed}
        unit="次"
        note="失败任务保留快照，可重试"
      />
    </V2Instrument>}
    <section className="panel history-panel"><div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索主题、目标或项目" />{search && <button type="button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div><label className="filter-select"><Filter size={16} /><select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="completed">已完成</option><option value="running">生成中</option><option value="failed">失败</option></select><ChevronDown size={13} /></label><Button variant="ghost" icon={<RefreshCcw size={15} />} onClick={load}>刷新</Button><div className="history-summary__scope"><span>查看范围</span><div><button type="button" className={scope === 'current' ? 'active' : ''} onClick={() => setScope('current')}>当前项目</button><button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>全部项目</button></div></div></div>
      {loading ? <div className="table-loading"><Skeleton lines={6} /></div> : loadError ? <EmptyState icon={<TriangleAlert size={24} />} title="生成记录加载失败" description={loadError} action={<Button variant="secondary" icon={<RefreshCcw size={15} />} onClick={load}>重试</Button>} /> : visible.length ? <div className="data-table history-table"><div className="data-table__head"><span>编号</span><span>任务</span><span>项目 / 模式</span><span>公式 / 种子</span><span>状态</span><span>时间</span><span /></div>{visible.map((job, jobIndex) => <div className="data-table__row" key={job.id}><span className="v2-lab-id">EXP-{String(visible.length - jobIndex).padStart(3, '0')}</span><span className="history-topic"><i className={`history-topic__icon history-topic__icon--${job.status}`}><FileClock size={17} /></i><span><strong>{job.topic}</strong><small>{job.goal || '未设置生成目标'}</small></span></span><span className="history-project"><strong>{job.projectName || projects.find((project) => project.id === job.projectId)?.name || job.projectId}</strong><small>{job.mode === 'simple' ? '简单模式' : '设置模式'}</small></span><span className="history-snapshot"><strong>{job.formulaVersion || '—'}</strong><small>Seed {job.seed || '—'}</small></span><span><Badge tone={job.qualityStatus === 'needs_review' ? 'warning' : job.status === 'completed' ? 'positive' : job.status === 'failed' ? 'danger' : 'blue'}>{job.status === 'running' && <span className="live-dot" />}{job.qualityStatus === 'needs_review' ? '生成完成 · 需复核' : statusLabel[job.status]}</Badge>{job.status === 'running' && <small className="status-progress">{job.progress || 0}%</small>}</span><span className="history-date"><strong>{formatDate(job.createdAt, true)}</strong><small>{job.completedAt ? `完成 ${formatDate(job.completedAt, true)}` : '—'}</small></span><span className="row-actions">{job.status === 'completed' || job.status === 'running' || job.status === 'queued' ? <button type="button" className="table-action" onClick={() => navigate(`/generations/${job.id}`)}><Eye size={15} />{job.status === 'completed' ? '查看' : '进度'}</button> : <button type="button" className="table-action" onClick={() => navigate('/generate')}><RefreshCcw size={14} />重试</button>}</span></div>)}</div> : <EmptyState icon={<FileClock size={24} />} title="没有匹配的生成记录" description="调整搜索和状态条件，或发起一次新任务。" />}
    </section>
  </div>;
}
