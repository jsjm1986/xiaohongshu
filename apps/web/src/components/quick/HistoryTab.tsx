import { useEffect, useState } from 'react';
import { BookOpen, Clock, Repeat, RotateCcw, SearchX, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, useToast } from '../Ui';
import { api } from '../../lib/api';
import { approveOpportunitiesForBatch } from '../../lib/quick-generation';
import { filterGenerationJobs, type GenerationStatusFilter } from '../../lib/quick-channel-state';
import { overviewDigest } from '../../lib/overview-digest';
import { readerPath } from '../../lib/quick-nav';
import { failureDigest, planBatchRetry } from '../../lib/retry-plan';
import { retryJobOnce } from '../../lib/single-retry';
import { waitStatus } from '../../lib/wait-status';
import { buildBatchJobs } from '../../lib/quick-batch';
import { BatchBoard } from './BatchBoard';
import { WaitCard } from './WaitCard';
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
  /** 空态里的「去创作」出路;未接通时该按钮不显示 */
  onGoCreate?: () => void;
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

export function HistoryTab({ project, history, fail, setHistory, activeBatchId, focusJobId, onReuseRecipe, onGoCreate }: Props) {
  const toast = useToast();
  const navigate = useNavigate();
  /**
   * 未完成任务在行内展开进度(轻量、就该留在列表里);已完成的「阅读」走独立页
   * /quick/read/:jobId,不再在列表里挂两千像素的手风琴。
   */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<GenerationStatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  // 创作区把「还在后台跑」的任务交接过来时,直接展开那一条的进度,别让用户自己找。
  // 状态筛选同时回到「全部」:兜底落点进来的任务多半是 running,若上次筛的是
  // 「已完成」,展开的那条会被筛掉,等于交接到一个空列表。
  useEffect(() => {
    if (!focusJobId) return;
    setExpanded(focusJobId);
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

  // 「已等待 N 分钟」要自己走秒,不能只在轮询返回时更新(接口 3s 一拍但可能失败,
  // 而且等待卡在批次看板里也要走)。一个 tick 驱动所有等待卡,不各自 setInterval。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasInFlight) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasInFlight]);

  // 跑完的任务自动进阅读页?不做。用户可能正在读别的东西,页面被抢走比多点一下更糟。
  // 完成后行内展开的进度卡自己收掉(waitStatus 返回 settled),行上出现「阅读」。

  /** 单篇重试:与批次看板共用同一段配方回填逻辑(lib/single-retry)。 */
  const retryOne = async (job: GenerationJob) => {
    if (!project) return;
    setRetryingId(job.id);
    try {
      const result = await retryJobOnce({
        project,
        job,
        deps: { opportunities: api.opportunities, presets: api.presets, generationBatches: api.generationBatches },
      });
      for (const w of result.warnings) toast.push(w, 'info');
      toast.push('已按同款重新提交，消耗 1 次额度');
      if (projectId) setHistory((await api.generations.list(projectId)).items);
    } catch (e) { fail(e, '重试失败'); } finally { setRetryingId(null); }
  };

  /**
   * 删除一条产出(软删,可撤销)。
   *
   * 本地先摘掉再打接口?不。删除是写操作,失败了要能把行放回去;先等接口回来再改
   * 列表,状态永远和服务端一致,代价只是一次点击后的短暂 loading。
   */
  const removeJob = async (job: GenerationJob) => {
    if (deletingId) return;
    setDeletingId(job.id);
    try {
      await api.generations.remove(job.id);
      setHistory(history.filter((j) => j.id !== job.id));
      if (expanded === job.id) setExpanded(null);
      toast.push(`已删除「${job.topic || '未命名选题'}」`, 'info', {
        label: '撤销',
        run: () => {
          void api.generations.restore(job.id)
            .then(async () => {
              // 重新拉列表而不是把本地那条塞回去:期间可能有别的任务完成,
              // 塞回去会让顺序和状态与服务端不一致。
              if (projectId) setHistory((await api.generations.list(projectId)).items);
              toast.push('已恢复');
            })
            .catch((e) => fail(e, '撤销失败'));
        },
      });
    } catch (e) { fail(e, '删除失败'); } finally { setDeletingId(null); }
  };

  /** 已完成 → 去独立阅读页;未完成 → 行内展开进度(收起再点即折叠)。 */
  const open = (job: GenerationJob) => {
    if (job.status === 'completed') { navigate(readerPath(job.id)); return; }
    setExpanded((cur) => (cur === job.id ? null : job.id));
  };

  // 看板子卡「查看」只对已完成的任务开放(BatchBoard 里 disabled),直接进阅读页。
  const openJobFromBoard = (jobId: string) => navigate(readerPath(jobId));

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
          onOpenJob={openJobFromBoard}
          onReuseRecipe={onReuseRecipe}
        />
      )}

      <div className="qc-history-filters">
        <div className="chip-group">
          {STATUS_CHIPS.map((c) => (
            <button key={c.key} type="button" className={`chip${statusFilter === c.key ? ' chip--active' : ''}`} onClick={() => setStatusFilter(c.key)}>{c.label}</button>
          ))}
        </div>
        {/* placeholder 不是可访问名:读屏软件在输入后就读不到它了,补 aria-label */}
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索标题关键词"
          aria-label="搜索产出标题"
        />
      </div>

      <ul className="qc-history-list">
        {visible.map((job) => {
          const isOpen = expanded === job.id;
          const running = job.status === 'running' || job.status === 'queued';
          const done = job.status === 'completed';
          return (
            <li key={job.id} className="qc-history-item">
              <div className="qc-project-row">
                <strong>{job.topic || '未命名选题'}</strong>
                {(() => { const s = STATUS_LABEL[job.status] ?? { text: job.status, tone: 'muted' as const }; return <span className={`qc-badge qc-badge--${s.tone}`}>{s.text}</span>; })()}
                {/* 未完成任务在收起状态也报位次/耗时,不用展开才知道自己排在哪 */}
                {running && (() => {
                  const s = waitStatus(job, now);
                  return <small className="qc-hint">{s.headline}{s.elapsedLabel ? ` · ${s.elapsedLabel}` : ''}</small>;
                })()}
                <small className="qc-hint">{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}</small>
                {/* 已完成走独立阅读页(主动作,给实心按钮);未完成只展开进度 */}
                {done ? (
                  <Button variant="secondary" icon={<BookOpen size={13} />} onClick={() => open(job)}>阅读</Button>
                ) : (
                  <Button variant="ghost" onClick={() => open(job)}>
                    {isOpen ? '收起' : job.status === 'failed' ? '看原因' : '看进度'}
                  </Button>
                )}
                {onReuseRecipe && (
                  <Button variant="ghost" icon={<Repeat size={13} />} onClick={() => onReuseRecipe(job)}>再来一篇同款</Button>
                )}
                {/*
                  删除:产出区原来只增不减,单个项目跑到 33 条之后失败的、试错的、
                  重复的全堆在一起,用户没法整理自己的工作区。软删 + 提示里撤销:
                  逐条弹确认弹窗在"连删几条"时太重,而删完无声无息又让人不敢下手。
                */}
                <Button
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  title="从列表中删除（可撤销）"
                  loading={deletingId === job.id}
                  disabled={deletingId !== null}
                  onClick={() => void removeJob(job)}
                >
                  删除
                </Button>
              </div>
              {isOpen && running && <WaitCard job={job} now={now} />}
              {isOpen && job.status === 'failed' && (
                <div className="qc-history-detail">
                  <p className="qc-hint">生成失败：{job.error || '未知错误'}</p>
                  {/* 失败条目原本只能去批次看板重试;这里直接给入口 */}
                  <div className="qc-actions">
                    <Button
                      variant="secondary"
                      icon={<RotateCcw size={13} />}
                      loading={retryingId === job.id}
                      disabled={retryingId !== null || !project}
                      onClick={() => void retryOne(job)}
                    >
                      按同款重试
                    </Button>
                    <small className="qc-hint">重试消耗 1 次额度</small>
                  </div>
                </div>
              )}
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
            // 空态要给出路。原来只有一句「还没有产出」——用户站在一个空列表前,
            // 下一步在别的区,而这里一个字都没说。
            <li className="qc-empty">
              <span className="qc-empty__icon"><Clock size={18} /></span>
              还没有产出。去创作区选个选题,生成第一篇。
              {onGoCreate && (
                <Button variant="secondary" onClick={onGoCreate}>去创作</Button>
              )}
            </li>
          ) : (
            // 筛出空同理:用户可能忘了自己还挂着筛选条件,给一键清除
            <li className="qc-empty">
              <span className="qc-empty__icon"><SearchX size={18} /></span>
              没有符合筛选条件的产出（共 {history.length} 篇）。
              <Button
                variant="ghost"
                onClick={() => { setStatusFilter('all'); setKeyword(''); }}
              >
                清除筛选
              </Button>
            </li>
          )
        )}
      </ul>
    </div>
  );
}
