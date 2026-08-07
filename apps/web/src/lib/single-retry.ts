import { approveOpportunitiesForBatch } from './quick-generation';
import { buildBatchJobs } from './quick-batch';
import { extractRecipe, resolveRecipeTargets } from './quick-recipe';
import type { ContentPreset, GenerateInput, GenerationJob, Project, TopicOpportunity } from '../types';

/**
 * 单篇重试:按原任务的配方重投一个单任务批次。
 *
 * 原来这段只长在 BatchBoard 里,于是产出区列表的失败条目没有重试入口——用户得先
 * 找到它属于哪个批次,再去看板里点。抽出来给两处共用。
 *
 * 不改写失败卡:重试是新任务、新记录,失败那条留着当证据。每次重试消耗 1 次额度
 * (后端 create 路径会 consumePlatformQuota),调用方必须先把这句话说给用户。
 */

interface RetryDeps {
  opportunities: { list: (projectId: string) => Promise<{ items: TopicOpportunity[] }> };
  presets: { list: (projectId: string) => Promise<{ items: ContentPreset[] }> };
  generationBatches: { create: (input: { projectId: string; name?: string; jobs: GenerateInput[] }) => Promise<{ id: string }> };
  /**
   * 审批段。缺省走真实实现;可注入是为了能在 node 测试里跑——
   * approveOpportunitiesForBatch 默认会 import('./api'),而那个模块在模块加载期
   * 就读 document.cookie,在测试环境里直接抛 ReferenceError。
   */
  approve?: (args: { project: Project; opportunityIds: string[] }) => Promise<TopicOpportunity[]>;
}

export interface SingleRetryResult {
  batchId: string;
  /** 回填过程中的降级提示(如覆盖项已失效),调用方按 info 提示 */
  warnings: string[];
}

export async function retryJobOnce(args: {
  project: Project;
  job: GenerationJob;
  deps: RetryDeps;
}): Promise<SingleRetryResult> {
  const { project, job, deps } = args;
  const [opps, presets] = await Promise.all([
    deps.opportunities.list(project.id),
    deps.presets.list(project.id),
  ]);
  const targets = resolveRecipeTargets(extractRecipe(job), opps.items, presets.items);
  // 选题可能已归档/删除:此时重试注定失败,提前说清而不是提交一个打向幽灵选题的任务。
  if (!targets.opportunityId) {
    throw new Error(targets.warnings[0] ?? '原选题已不在选题池，无法重试');
  }
  // 预设失效要在审批之前判:审批是一串写请求,没必要为一个注定失败的重试白跑一遍。
  const matchedPresets = presets.items.filter((p) => p.id === targets.presetId);
  if (matchedPresets.length === 0) throw new Error('原预设已不存在，请回创作区重新配置');

  const approve = deps.approve ?? approveOpportunitiesForBatch;
  const approved = await approve({ project, opportunityIds: [targets.opportunityId] });
  const jobs = buildBatchJobs({
    project,
    opportunities: approved,
    presets: matchedPresets,
    overrides: targets.overrides,
    imageAssetIds: targets.imageAssetIds,
    publishing: targets.publishing,
  });
  if (jobs.length === 0) throw new Error('无法按原配方重建任务，请回创作区重新配置');
  const batch = await deps.generationBatches.create({
    projectId: project.id,
    name: `重试 · ${job.topic || '选题'}`,
    jobs,
  });
  return { batchId: batch.id, warnings: targets.warnings };
}
