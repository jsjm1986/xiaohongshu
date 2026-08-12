import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Download, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { Button, useToast } from '../Ui';
import { api } from '../../lib/api';
import { mergeJobUpdates, pendingJobIds } from '../../lib/batch-polling';
import { batchProgressText, batchStatusLabel, liveBatchStatus } from '../../lib/quick-batch';
import { quickCandidateFields, quickCandidateToMarkdown } from '../../lib/quick-generation';
import { retryJobOnce } from '../../lib/single-retry';
import { planBatchExport, type ExportFormat } from '../../lib/batch-export';
import type { GenerationBatch, GenerationJob, Project } from '../../types';

interface Props {
  project: Project;
  /** 刚提交的批次:高亮置顶,并触发一次刷新 */
  activeBatchId?: string;
  fail: (e: unknown, fallback: string) => void;
  /** 点子卡:回到产出列表里展开该任务 */
  onOpenJob?: (jobId: string) => void;
  /** 「再来一篇同款」:把该任务的配方回灌创作区(Task 11 接入) */
  onReuseRecipe?: (job: GenerationJob) => void;
}

const POLL_INTERVAL_MS = 2000;

export function BatchBoard({ project, activeBatchId, fail, onOpenJob, onReuseRecipe }: Props) {
  const [batches, setBatches] = useState<GenerationBatch[]>([]);
  const [jobsByBatch, setJobsByBatch] = useState<Record<string, GenerationJob[]>>({});
  const toast = useToast();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  // 用户手动展开过的全失败批次
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((cur) => { const next = new Set(cur); next.has(id) ? next.delete(id) : next.add(id); return next; });

  /**
   * 批量导出一个批次。
   *
   * 一个批次实测有 24–27 个候选,逐个点开导出不可接受。
   *
   * 几处不得不这么做的地方:
   * - 批次接口不返回 candidates(轻量投影),所以先并发取详情拿候选 id。
   * - 下载必须串行 + 间隔:浏览器对连续多次 location/anchor 下载有节流,
   *   一口气触发 20 多个只会成功前几个。
   * - 后端导出对未通过校验的候选一律 400(实测 165 个里 129 个过不了),
   *   所以 planBatchExport 先筛,再如实报告跳过多少,而不是让用户收到一堆失败。
   */
  const exportBatch = async (batch: GenerationBatch, format: ExportFormat) => {
    setExporting(batch.id);
    try {
      const jobs = jobsByBatch[batch.id] ?? [];
      const completed = jobs.filter((j) => j.status === 'completed');
      /*
       * 批次任务不含候选,逐个取详情。走 reader 投影而不是 get():
       * 实测 get() 单条 1024 KB、reader 35 KB(差 29 倍),而整批导出要并发拉 N 条
       * ——24 篇就是 24 MB 对 0.8 MB。
       *
       * planBatchExport 只读 id / topic / status / candidates[].{id,validation},
       * 这些 reader 投影全都有(它反而额外带了 reasoning/gapLedger)。
       */
      const detailed = await Promise.all(
        completed.map((j) => api.generations.reader(j.id).catch(() => null)),
      );
      const usable = detailed.filter((j): j is NonNullable<typeof j> => Boolean(j)) as unknown as GenerationJob[];
      const plan = planBatchExport(usable, format);

      if (plan.total === 0) {
        const why = plan.skippedUnpublishable > 0
          ? `${plan.skippedUnpublishable} 篇未通过可发布校验，无法导出为 ${format.toUpperCase()}；可改用 Markdown`
          : '这个批次还没有可导出的产出';
        toast.push(why, 'error');
        return;
      }

      for (const [index, item] of plan.items.entries()) {
        if (format === 'markdown') {
          const job = usable.find((j) => j.id === item.jobId);
          const candidate = job?.candidates?.find((c) => c.id === item.candidateId);
          if (!candidate) continue;
          const blob = new Blob([quickCandidateToMarkdown(quickCandidateFields(candidate))], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = item.filename;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          const a = document.createElement('a');
          a.href = api.generations.exportUrl(item.jobId, item.candidateId, format);
          a.download = item.filename;
          a.click();
        }
        // 节流:连续触发会被浏览器拦掉,最后一个不必等
        if (index < plan.items.length - 1) await new Promise((r) => setTimeout(r, 350));
      }

      const notes = [`已导出 ${plan.total} 篇`];
      if (plan.skippedUnpublishable > 0) notes.push(`${plan.skippedUnpublishable} 篇未通过校验已跳过`);
      if (plan.draftWatermarked > 0) notes.push(`${plan.draftWatermarked} 篇未过校验，已带「仅供核对」水印`);
      if (plan.skippedUnfinished > 0) notes.push(`${plan.skippedUnfinished} 篇未完成已跳过`);
      toast.push(notes.join('，'));
    } catch (e) { fail(e, '批量导出失败'); } finally { setExporting(null); }
  };

  const loadBatches = useCallback(async () => {
    try {
      // api.generationBatches.list 返回裸数组(已含 jobs),不是 ApiList,故无 .items
      const list = await api.generationBatches.list(project.id);
      setBatches(list);
      setJobsByBatch(Object.fromEntries(list.map((b) => [b.id, b.jobs ?? []])));
    } catch (e) { fail(e, '加载批次失败'); }
  }, [project.id, fail]);

  useEffect(() => { void loadBatches(); }, [loadBatches, activeBatchId]);

  // 并发轮询:所有批次里仍在 queued/running 的任务,每 2s 拉一轮,全部终态后自动停
  useEffect(() => {
    const pending = pendingJobIds(Object.values(jobsByBatch).flat());
    if (pending.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      /*
       * 轮询走批次列表接口重取,而不是逐个 api.generations.get()。
       *
       * 实测 get() 单条 1024 KB(reader 投影 35 KB,差 29 倍),而这里每 2 秒一拍、
       * 批量常提 24 篇——一拍 24 MB。轮询只用到 status/progress/queuePosition,
       * 那些重字段(trace、参数影响报告、编排快照)一个都不读。
       *
       * 批次列表接口本身带 jobs 且走列表投影,一个请求换掉 N 个重请求。
       */
      const list = await api.generationBatches.list(project.id).catch(() => null);
      if (cancelled || !list) return;
      const updated = list.flatMap((b) => b.jobs ?? []).filter((j) => pending.includes(j.id));
      setJobsByBatch((cur) => mergeJobUpdates(cur, updated));
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
    // project.id 进依赖:换项目后不能继续拿旧项目的批次去合并
  }, [jobsByBatch, project.id]);

  // 重试:按原任务的配方(选题+预设+覆盖项)重投一个单任务批次,失败卡不改写、结果并入看板。
  // 配方回填那段抽到 lib/single-retry,与产出区列表里的单篇重试共用同一份实现——
  // 原来只有看板有这个能力,列表里的失败条目没有入口。
  const retry = async (job: GenerationJob) => {
    setRetrying(job.id);
    try {
      await retryJobOnce({
        project,
        job,
        deps: { opportunities: api.opportunities, presets: api.presets, generationBatches: api.generationBatches },
      });
      await loadBatches();
    } catch (e) { fail(e, '重试失败'); } finally { setRetrying(null); }
  };

  if (batches.length === 0) return null;

  return (
    <div className="qc-batch-board">
      {batches.map((batch) => {
        const jobs = jobsByBatch[batch.id] ?? [];
        const allFailed = jobs.length > 0 && jobs.every((j) => j.status === 'failed');
        return (
          <div key={batch.id} className={`qc-batch-card${batch.id === activeBatchId ? ' qc-batch-card--active' : ''}`}>
            <div className="qc-batch-card__head">
              <strong>{batch.name || `批次 ${batch.createdAt?.slice(0, 10) ?? ''}`}</strong>
              <span className="qc-batch-card__meta">
                <span className="qc-batch-card__status">{batchStatusLabel(liveBatchStatus(batch.status, jobs))}</span>
                {jobs.length > 0 && <span className="qc-batch-card__count">{batchProgressText(jobs)}</span>}
              </span>
            </div>
            {/* 批量导出:一个批次实测 24–27 个候选,逐个点开导出不可接受。
                只在有已完成任务时出现——全失败的批次没东西可导。 */}
            {jobs.some((j) => j.status === 'completed') && (
              <div className="qc-batch-card__export">
                <span className="qc-batch-card__export-label"><Download size={12} />整批导出</span>
                {(['markdown', 'docx', 'pdf'] as const).map((fmt) => (
                  <Button
                    key={fmt}
                    variant="ghost"
                    loading={exporting === batch.id}
                    disabled={exporting !== null}
                    onClick={() => void exportBatch(batch, fmt)}
                  >
                    {fmt === 'markdown' ? 'Markdown' : fmt.toUpperCase()}
                  </Button>
                ))}
              </div>
            )}
            {/* 全失败的批次默认折叠:实测三个批次全是 0/10,展开后就是一墙红色卡片,
                把还能用的产出挤到屏幕外。折叠后仍可点开逐条重试。 */}
            {allFailed && !expanded.has(batch.id) ? (
              <button type="button" className="qc-batch-card__collapsed" onClick={() => toggleExpanded(batch.id)}>
                展开查看 {jobs.length} 篇失败任务
              </button>
            ) : (
            <div className="qc-batch-card__grid">
              {jobs.map((job) => (
                <div key={job.id} className={`qc-jobcell qc-jobcell--${job.status}`}>
                  <button
                    type="button"
                    className="qc-jobcell__topic"
                    disabled={job.status !== 'completed'}
                    onClick={() => onOpenJob?.(job.id)}
                  >
                    {job.topic || '选题'}
                  </button>
                  {job.status === 'completed' && (
                    <span className="qc-jobcell__badge">
                      <CheckCircle2 size={13} />
                      {job.qualityStatus === 'passed' ? '可发布' : '待核查'}
                      {onReuseRecipe && (
                        <Button variant="ghost" onClick={() => onReuseRecipe(job)}>再来一篇同款</Button>
                      )}
                    </span>
                  )}
                  {job.status === 'running' && (
                    <span className="qc-jobcell__badge">
                      <RefreshCw size={13} className="spin" />
                      {job.progress ?? 0}%
                    </span>
                  )}
                  {job.status === 'queued' && (
                    // 并发上限 2、批量常提 24 篇:光写「排队中」等于 24 格全一样,
                    // 带上位次用户才知道自己是第 3 个还是第 20 个。
                    <span className="qc-jobcell__badge">
                      <Clock size={13} />
                      {job.queuePosition ? `排队 第 ${job.queuePosition} 位` : '排队中'}
                    </span>
                  )}
                  {job.status === 'failed' && (
                    <span className="qc-jobcell__badge qc-jobcell__badge--fail">
                      <XCircle size={13} />失败
                      <Button
                        variant="ghost"
                        icon={<RotateCcw size={13} />}
                        loading={retrying === job.id}
                        disabled={retrying !== null}
                        onClick={() => void retry(job)}
                      >
                        重试
                      </Button>
                    </span>
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
