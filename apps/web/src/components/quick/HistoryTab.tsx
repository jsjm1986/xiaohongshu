import { useEffect, useState } from 'react';
import { Clock, Copy, Download, Repeat, SearchX, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { QuickCandidateCards } from '../QuickResult';
import { api } from '../../lib/api';
import { approveOpportunitiesForBatch, quickCandidateFields, quickCandidateToMarkdown, type QuickCandidateView } from '../../lib/quick-generation';
import { allValidationIssueLabels, firstValidationIssueLabel } from '../../lib/validation-labels';
import { filterGenerationJobs, type GenerationStatusFilter } from '../../lib/quick-channel-state';
import { overviewDigest } from '../../lib/overview-digest';
import { failureDigest, planBatchRetry } from '../../lib/retry-plan';
import { buildBatchJobs } from '../../lib/quick-batch';
import { BatchBoard } from './BatchBoard';
import { DeploymentPlanCard } from './DeploymentPlanCard';
import type { GenerationJob, Project } from '../../types';

interface Props {
  project: Project | null;
  history: GenerationJob[];
  fail: (e: unknown, fallback: string) => void;
  setHistory: (h: GenerationJob[]) => void;
  /** 刚提交的批次:看板里高亮置顶 */
  activeBatchId?: string;
  /** 创作区停止等待后转交过来的任务:进入产出区直接展开它,免得用户在列表里自己找 */
  focusJobId?: string;
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

export function HistoryTab({ project, history, fail, setHistory, activeBatchId, focusJobId, onReuseRecipe }: Props) {
  const toast = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<GenerationStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  // list 接口不返回候选(后端 mapJob(row,false) 刻意轻量),展开时按需取详情并缓存
  const [details, setDetails] = useState<Record<string, GenerationJob['candidates']>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [candidateIdx, setCandidateIdx] = useState(0);
  // 本地加载态:以前这里置壳的 busy,但本组件并不读 busy,所以自己没有加载提示,
  // 只是让创作区残留「正在生成」进度条。改为自持状态,壳的 busy 不再被搭便车。
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [retryingAll, setRetryingAll] = useState(false);
  const projectId = project?.id;

  const visible = filterGenerationJobs(history, { status: statusFilter, keyword });
  const digest = overviewDigest(history);
  const failedJobs = history.filter((j) => j.status === 'failed');
  const failures = failureDigest(failedJobs);

  /**
   * 批量重试:把所有失败任务规划成「一次」批次提交。
   *
   * 逐条点单条重试是 N×4 个请求(实测 70 条失败 ≈ 280 个),而且同一配方会被重复
   * 提交、白烧额度。这里先 planBatchRetry 去重与筛掉孤儿任务,再一次性建批次。
   */
  const retryAllFailed = async () => {
    if (!project || failedJobs.length === 0) return;
    setRetryingAll(true);
    try {
      const [opps, presets] = await Promise.all([
        api.opportunities.list(project.id),
        api.presets.list(project.id),
      ]);
      const plan = planBatchRetry(failedJobs, opps.items, presets.items);
      if (plan.retryable.length === 0) {
        toast.push(plan.skipped.length > 0 ? '这些失败的原选题都已不在选题池，无法重试' : '没有可重试的任务', 'error');
        return;
      }

      // 审批链一次过:同一批次里的选题必须都已审批,否则建批次会被后端拒绝
      const approved = await approveOpportunitiesForBatch({
        project,
        opportunityIds: plan.retryable.map((t) => t.opportunityId),
      });

      // 每个目标各自带 overrides/预设,不能用一次 buildBatchJobs 笛卡尔积覆盖,
      // 否则会把 A 选题的覆盖项套到 B 选题上。
      const jobs = plan.retryable.flatMap((target) => {
        const opportunity = approved.find((o) => o.id === target.opportunityId);
        if (!opportunity) return [];
        return buildBatchJobs({
          project,
          opportunities: [opportunity],
          presets: presets.items.filter((p) => p.id === target.presetId),
          overrides: target.overrides,
          imageAssetIds: target.imageAssetIds,
        });
      });
      if (jobs.length === 0) throw new Error('原预设均已不存在，请回创作区重新配置');

      await api.generationBatches.create({
        projectId: project.id,
        name: `重试失败 · ${jobs.length} 篇`,
        jobs,
      });

      const notes = [`已提交 ${jobs.length} 篇重试`];
      if (plan.deduped > 0) notes.push(`合并重复配方 ${plan.deduped} 篇`);
      if (plan.skipped.length > 0) notes.push(`${plan.skipped.length} 篇因原选题已删除跳过`);
      toast.push(notes.join('，'));
      for (const w of plan.warnings) toast.push(w, 'info');

      if (projectId) setHistory((await api.generations.list(projectId)).items);
    } catch (e) { fail(e, '批量重试失败'); } finally { setRetryingAll(false); }
  };

  // 创作区把「还在后台跑」的任务交接过来时,直接展开那一条,别让用户在列表里自己找。
  // 状态筛选同时回到「全部」:兜底落点进来的任务多半是 running,若上次筛的是
  // 「已完成」,展开的那条会被筛掉,等于交接到一个空列表。
  useEffect(() => {
    if (!focusJobId) return;
    setExpanded(focusJobId);
    setCandidateIdx(0);
    setStatusFilter('all');
    setKeyword('');
  }, [focusJobId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingHistory(true);
    api.generations.list(projectId)
      .then((res) => { if (!cancelled) { setHistory(res.items); setLoadingHistory(false); } })
      .catch((e) => { if (!cancelled) { setLoadingHistory(false); fail(e, '加载历史失败'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 产出区是「生成耗时较长」的兜底落点(见 quick-generation.ts 的
  // GenerationStillRunningError):创作区停止等待后,用户被指到这里看进度。
  // 但列表原本只在挂载时拉一次,未完成任务会永远停在当时那个百分比,看起来像卡死。
  // 只要还有 queued/running,就按 3s 续拉;全部落地后自动停,空闲时不打接口。
  const hasInFlight = history.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!projectId || !hasInFlight) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api.generations.list(projectId)
        .then((res) => { if (!cancelled) setHistory(res.items); })
        .catch(() => { /* 静默:轮询失败不打扰,下一拍再试 */ });
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
    // setHistory 是壳的 useState setter,引用稳定,不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, hasInFlight]);

  // 展开中的任务跑完时补一次详情。候选只有 GET /api/generations/:id 才带,而原本
  // 只在点击展开的那一刻按 status==='completed' 取过一次;若用户在它还 running 时
  // 就展开(兜底落点的典型路径),轮询把状态刷成 completed 后没人再去取候选,卡片
  // 就一直停在「正在生成」。这里补上状态翻转这一路。
  const expandedStatus = history.find((j) => j.id === expanded)?.status;
  useEffect(() => {
    if (!expanded || expandedStatus !== 'completed' || details[expanded]) return;
    let cancelled = false;
    setLoadingId(expanded);
    api.generations.get(expanded)
      .then((full) => { if (!cancelled) setDetails((cur) => ({ ...cur, [full.id]: full.candidates ?? [] })); })
      .catch(() => { /* 静默:再次点击折叠/展开仍可重试 */ })
      .finally(() => { if (!cancelled) setLoadingId(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, expandedStatus]);

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('已复制'); }
    catch { toast.push('复制失败，请手动选择文本', 'error'); }
  };

  /**
   * 导出。markdown 走本地拼装(即时、不占额度、离线可用),docx/pdf/json 必须走后端
   * ——只有服务端能生成这几种二进制格式。
   *
   * 后端一直支持 markdown/json/docx/pdf 四种,完整版工作台四个按钮都给;极简创作
   * 此前只有一个本地 Markdown Blob,付费用户要交付用的 docx/pdf 拿不到。
   *
   * 门槛差异要紧:后端导出对未通过校验的候选一律 400
   * (export.service.ts:155「禁止导出」),实测 165 个候选里 129 个都过不了;
   * 而本地 Markdown 不经后端,不受此限。所以只门控后端三种格式,
   * 本地 Markdown 始终可用——待核对的稿子仍然要能拿出来给人看。
   */
  const exportAs = (job: GenerationJob, v: QuickCandidateView, format: 'markdown' | 'json' | 'docx' | 'pdf') => {
    if (format === 'markdown') {
      const blob = new Blob([quickCandidateToMarkdown(v)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${job.topic || '文案'}-${v.label || v.id}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    // 后端按 Content-Disposition 给文件名(含中文标题),这里直接跳转触发下载
    window.location.assign(api.generations.exportUrl(job.id, v.id, format));
  };

  // 候选加载交给上面那个 effect(它同时覆盖「展开时已完成」和「展开后才完成」两路),
  // 这里只管展开态,免得同一次点击发两个重复的详情请求。
  const toggle = (job: GenerationJob) => {
    if (expanded === job.id) { setExpanded(null); return; }
    setExpanded(job.id);
    setCandidateIdx(0);
  };

  // 看板子卡 → 展开下方列表里的同一任务。批次里刚完成的任务可能还不在 history
  // (轮询按 3s 走,看板可能先知道),所以先补一次列表再展开。
  // 候选同样交给上面那个 effect:补完列表后它就能拿到 status。这里不能自己去 get,
  // 否则任务还在 running 时会把空候选写进 details,反而把 effect 的重试条件堵死。
  const openJobFromBoard = async (jobId: string) => {
    setExpanded(jobId);
    setCandidateIdx(0);
    if (!history.some((j) => j.id === jobId) && projectId) {
      try { setHistory((await api.generations.list(projectId)).items); }
      catch { /* 静默:状态刷新失败,下一拍轮询会再补 */ }
    }
  };

  return (
    <div className="qc-step">
      {/* 概况条:70 条失败平铺在页面上时,用户第一眼只看到一墙红色,不知道
          「哪些能用、失败为什么、能不能一次修好」。这条先给结论。 */}
      {digest.total > 0 && (
        <div className="qc-history-summary">
          <div className="qc-history-summary__counts">
            <span className="qc-hs-stat"><b>{digest.publishable}</b>可直接发布</span>
            <span className="qc-hs-stat"><b>{digest.needsReview}</b>需人工核对</span>
            <span className="qc-hs-stat"><b>{digest.failed}</b>失败</span>
            {digest.inFlight > 0 && <span className="qc-hs-stat"><b>{digest.inFlight}</b>进行中</span>}
          </div>
          {digest.failed > 0 && (
            <div className="qc-history-summary__fix">
              <ul className="qc-fail-reasons">
                {failures.groups.slice(0, 3).map((g) => (
                  <li key={g.label} className={g.blocking ? 'is-blocking' : undefined}>
                    <b>{g.count}</b> {g.label}
                  </li>
                ))}
              </ul>
              <div className="qc-actions">
                <Button
                  variant="secondary"
                  loading={retryingAll}
                  disabled={retryingAll || !project}
                  onClick={() => void retryAllFailed()}
                >
                  重试全部失败 · {digest.failed} 篇
                </Button>
                {/* 明说重试要花额度:这是付费产品,一次点掉几十次额度必须先告知。
                    有 blocking 原因时更要劝阻——那些重试必然再失败,额度照扣。 */}
                {failures.blockingCount > 0 ? (
                  <small className="qc-warn-line">
                    其中 {failures.blockingCount} 篇因上述阻塞原因重试仍会失败，建议先解决再重试（每篇消耗 1 次额度）
                  </small>
                ) : (
                  <small className="qc-hint">每篇重试消耗 1 次额度</small>
                )}
              </div>
            </div>
          )}
        </div>
      )}

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
                    {/* 与创作区结果卡同一套结论行:通过要明说,未通过要给全部项 */}
                    {current.publishable ? (
                      <p className="qc-pass-line">
                        <ShieldCheck size={13} />
                        已通过可发布校验
                      </p>
                    ) : (() => {
                      const labels = allValidationIssueLabels(current.issueCodes);
                      return (
                        <div className="qc-issue-line">
                          <p>
                            <TriangleAlert size={13} />
                            {firstValidationIssueLabel(current.issueCodes) ?? '未通过校验,引用时请人工核对'}
                          </p>
                          {labels.length > 1 && (
                            <details className="qc-issue-more">
                              <summary>另有 {labels.length - 1} 项未通过</summary>
                              <ul>{labels.map((label) => <li key={label}>{label}</li>)}</ul>
                            </details>
                          )}
                        </div>
                      );
                    })()}
                    <QuickCandidateCards view={current} />
                    {/* 发布执行方案:摘要在正面,完整方案收进折叠区 */}
                    <DeploymentPlanCard candidate={details[job.id]?.find((c) => c.id === current.id)} />
                    <div className="quick-result__actions">
                      <Button variant="secondary" icon={<Copy size={15} />} onClick={() => void copy(quickCandidateToMarkdown(current))}>复制全部</Button>
                      {/* 四种格式都给:docx/pdf 走后端,markdown 本地即时 */}
                      <span className="qc-export-group">
                        <span className="qc-export-group__label"><Download size={13} />导出</span>
                        {(['markdown', 'docx', 'pdf', 'json'] as const).map((fmt) => {
                          // 后端三种格式对未通过校验的候选会 400,禁用并说明原因;
                          // 本地 Markdown 不经后端,始终可用。
                          const blocked = fmt !== 'markdown' && !current.publishable;
                          return (
                            <Button
                              key={fmt}
                              variant="ghost"
                              disabled={blocked}
                              title={blocked ? '未通过可发布校验的稿子不能导出为该格式，可先导出 Markdown 人工核对' : undefined}
                              onClick={() => exportAs(job, current, fmt)}
                            >
                              {fmt === 'markdown' ? 'Markdown' : fmt.toUpperCase()}
                            </Button>
                          );
                        })}
                        {!current.publishable && (
                          <small className="qc-hint">仅 Markdown 可导出（未通过校验）</small>
                        )}
                      </span>
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
          loadingHistory ? (
            <li className="qc-empty">
              <span className="qc-empty__icon"><Clock size={18} /></span>
              正在加载产出…
            </li>
          ) : history.length === 0 ? (
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
