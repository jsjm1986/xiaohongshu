import { useEffect, useState } from 'react';
import { Clock, Copy, Repeat, SearchX } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { QuickCandidateCards } from '../QuickResult';
import { api } from '../../lib/api';
import { quickCandidateFields, quickCandidateToMarkdown, type QuickCandidateView } from '../../lib/quick-generation';
import { firstValidationIssueLabel } from '../../lib/validation-labels';
import { filterGenerationJobs, type GenerationStatusFilter } from '../../lib/quick-channel-state';
import { BatchBoard } from './BatchBoard';
import type { GenerationJob, Project } from '../../types';

interface Props {
  project: Project | null;
  history: GenerationJob[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  setHistory: (h: GenerationJob[]) => void;
  /** 刚提交的批次:看板里高亮置顶 */
  activeBatchId?: string;
  /** 「再来一篇同款」:把该任务的配方回灌创作区 */
  onReuseRecipe?: (job: GenerationJob) => void;
}

const STATUS_LABEL: Record<string, { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' }> = {
  ready: { text: '已完成', tone: 'ok' },
  completed: { text: '已完成', tone: 'ok' },
  draft: { text: '草稿', tone: 'muted' },
  pending: { text: '进行中', tone: 'warn' },
  queued: { text: '排队中', tone: 'muted' },
  running: { text: '进行中', tone: 'warn' },
  failed: { text: '失败', tone: 'error' },
};

const STATUS_CHIPS: Array<{ key: GenerationStatusFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'completed', label: '已完成' },
  { key: 'running', label: '进行中' },
  { key: 'failed', label: '失败' },
];

export function HistoryTab({ project, history, setBusy, fail, setHistory, activeBatchId, onReuseRecipe }: Props) {
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<GenerationStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  // list 接口不返回候选(后端 mapJob(row,false) 刻意轻量),展开时按需取详情并缓存
  const [details, setDetails] = useState<Record<string, GenerationJob['candidates']>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [candidateIdx, setCandidateIdx] = useState(0);
  const projectId = project?.id;

  const visible = filterGenerationJobs(history, { status: statusFilter, keyword });

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setBusy(true);
    api.generations.list(projectId)
      .then((res) => { if (!cancelled) { setHistory(res.items); setBusy(false); } })
      .catch((e) => { if (!cancelled) fail(e, '加载历史失败'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  const exportMarkdown = (job: GenerationJob, v: QuickCandidateView) => {
    const blob = new Blob([quickCandidateToMarkdown(v)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.topic || '文案'}-${v.label || v.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // list 不含候选,首次展开时拉一次详情并缓存
  const loadJobDetail = async (jobId: string) => {
    if (details[jobId]) return;
    setLoadingId(jobId);
    try {
      const full = await api.generations.get(jobId);
      setDetails((cur) => ({ ...cur, [jobId]: full.candidates ?? [] }));
    } catch (e) { fail(e, '加载候选失败'); } finally { setLoadingId(null); }
  };

  const toggle = async (job: GenerationJob) => {
    if (expanded === job.id) { setExpanded(null); return; }
    setExpanded(job.id);
    setCandidateIdx(0);
    // 只有已完成任务有候选
    if (job.status === 'completed') await loadJobDetail(job.id);
  };

  // 看板子卡 → 展开下方列表里的同一任务。批次里刚完成的任务可能还不在 history
  // (history 只在挂载时拉过一次),所以先补一次列表再展开。
  const openJobFromBoard = async (jobId: string) => {
    setExpanded(jobId);
    setCandidateIdx(0);
    if (!history.some((j) => j.id === jobId) && projectId) {
      try { setHistory((await api.generations.list(projectId)).items); }
      catch { /* 静默:详情仍可单独加载 */ }
    }
    await loadJobDetail(jobId);
  };

  return (
    <div className="qc-step">
      {project && (
        <BatchBoard
          project={project} activeBatchId={activeBatchId} fail={fail}
          onOpenJob={(id) => void openJobFromBoard(id)}
          onReuseRecipe={onReuseRecipe}
        />
      )}

      <div className="qc-history-filters">
        <div className="chip-group">
          {STATUS_CHIPS.map((c) => (
            <button key={c.key} type="button" className={`chip${statusFilter === c.key ? ' chip--active' : ''}`} onClick={() => setStatusFilter(c.key)}>{c.label}</button>
          ))}
        </div>
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索标题关键词" />
      </div>

      <ul className="qc-history-list">
        {visible.map((job) => {
          const open = expanded === job.id;
          const running = job.status === 'running' || job.status === 'queued';
          const views = open && job.status === 'completed'
            ? (details[job.id] ?? []).map(quickCandidateFields)
            : [];
          return (
            <li key={job.id} className="qc-history-item">
              <div className="qc-project-row">
                <strong>{job.topic || '未命名选题'}</strong>
                {(() => { const s = STATUS_LABEL[job.status] ?? { text: job.status, tone: 'muted' as const }; return <span className={`qc-badge qc-badge--${s.tone}`}>{s.text}</span>; })()}
                <small className="qc-hint">{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}</small>
                <Button variant="ghost" onClick={() => void toggle(job)}>{open ? '收起' : '查看'}</Button>
                {onReuseRecipe && (
                  <Button variant="ghost" icon={<Repeat size={13} />} onClick={() => onReuseRecipe(job)}>再来一篇同款</Button>
                )}
              </div>
              {open && loadingId === job.id && <p className="qc-hint">正在加载候选…</p>}
              {open && job.status === 'completed' && loadingId !== job.id && views.length > 0 && (() => {
                const current = views[Math.min(candidateIdx, views.length - 1)];
                return (
                  <div className="qc-history-detail">
                    {views.length > 1 && (
                      <div className="quick-tabs">
                        {views.map((v, i) => (
                          <button key={v.id} type="button" className={i === candidateIdx ? 'active' : ''} onClick={() => setCandidateIdx(i)}>
                            {v.label || `版本${i + 1}`}
                            {!v.publishable && <i className="quick-tab-dot" title="该版本未通过可发布校验" />}
                          </button>
                        ))}
                      </div>
                    )}
                    {!current.publishable && (
                      <p className="qc-issue-line">
                        {firstValidationIssueLabel(current.issueCodes) ?? '未通过校验,引用时请人工核对'}
                      </p>
                    )}
                    <QuickCandidateCards view={current} />
                    <div className="quick-result__actions">
                      <Button variant="secondary" icon={<Copy size={15} />} onClick={() => void copy(quickCandidateToMarkdown(current))}>复制全部</Button>
                      <Button variant="ghost" onClick={() => exportMarkdown(job, current)}>导出 Markdown</Button>
                    </div>
                  </div>
                );
              })()}
              {open && job.status === 'completed' && loadingId !== job.id && views.length === 0 && <p className="qc-hint">该次生成没有可展示的候选。</p>}
              {open && running && <p className="qc-hint">正在生成({job.progress ?? 0}%),完成后可查看候选。</p>}
              {open && job.status === 'failed' && <p className="qc-hint">生成失败:{job.error || '未知错误'}</p>}
            </li>
          );
        })}
        {visible.length === 0 && (
          history.length === 0 ? (
            <li className="qc-empty">
              <span className="qc-empty__icon"><Clock size={18} /></span>
              还没有产出
            </li>
          ) : (
            <li className="qc-empty">
              <span className="qc-empty__icon"><SearchX size={18} /></span>
              没有符合筛选条件的历史
            </li>
          )
        )}
      </ul>
    </div>
  );
}
