import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '../Ui';
import { api } from '../../lib/api';
import { mergeJobUpdates, pendingJobIds } from '../../lib/batch-polling';
import { batchProgressText, batchStatusLabel, buildBatchJobs } from '../../lib/quick-batch';
import { extractRecipe, resolveRecipeTargets } from '../../lib/quick-recipe';
import { approveOpportunitiesForBatch } from '../../lib/quick-generation';
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
  const [retrying, setRetrying] = useState<string | null>(null);

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
      const updated = await Promise.all(pending.map((id) => api.generations.get(id).catch(() => null)));
      if (cancelled) return;
      setJobsByBatch((cur) => mergeJobUpdates(cur, updated));
    }, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobsByBatch]);

  // 重试:按原任务的配方(选题+预设+覆盖项)重投一个单任务批次,失败卡不改写、结果并入看板
  const retry = async (job: GenerationJob) => {
    setRetrying(job.id);
    try {
      const [opps, presets] = await Promise.all([
        api.opportunities.list(project.id),
        api.presets.list(project.id),
      ]);
      const targets = resolveRecipeTargets(extractRecipe(job), opps.items, presets.items);
      if (!targets.opportunityId) throw new Error(targets.warnings[0] ?? '原选题已不在选题池，无法重试');
      const approved = await approveOpportunitiesForBatch({ project, opportunityIds: [targets.opportunityId] });
      const jobs = buildBatchJobs({
        project,
        opportunities: approved,
        presets: presets.items.filter((p) => p.id === targets.presetId),
        overrides: targets.overrides,
        imageAssetIds: targets.imageAssetIds,
      });
      if (jobs.length === 0) throw new Error('原预设已不存在，请回创作区重新配置');
      await api.generationBatches.create({ projectId: project.id, name: `重试 · ${job.topic || '选题'}`, jobs });
      await loadBatches();
    } catch (e) { fail(e, '重试失败'); } finally { setRetrying(null); }
  };

  if (batches.length === 0) return null;

  return (
    <div className="qc-batch-board">
      {batches.map((batch) => {
        const jobs = jobsByBatch[batch.id] ?? [];
        return (
          <div key={batch.id} className={`qc-batch-card${batch.id === activeBatchId ? ' qc-batch-card--active' : ''}`}>
            <div className="qc-batch-card__head">
              <strong>{batch.name || `批次 ${batch.createdAt?.slice(0, 10) ?? ''}`}</strong>
              <span className="qc-batch-card__meta">
                <span className="qc-batch-card__status">{batchStatusLabel(batch.status)}</span>
                {jobs.length > 0 && <span className="qc-batch-card__count">{batchProgressText(jobs)}</span>}
              </span>
            </div>
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
                    <span className="qc-jobcell__badge"><Clock size={13} />排队中</span>
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
          </div>
        );
      })}
    </div>
  );
}
