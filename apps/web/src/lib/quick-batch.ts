import { buildSimpleGenerateInput, resolveSimpleGenerationSettings, type SimpleSettingOverrides } from "./simple-generation";
import type { ContentPreset, GenerateInput, GenerationBatchStatus, GenerationJob, Project, TopicOpportunity } from "../types";
import type { RetryPublishingContract } from "./quick-recipe";

interface BuildBatchArgs {
  project: Project;
  opportunities: TopicOpportunity[];
  presets: ContentPreset[];
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
  /** Omitted for new batches; supplied only when replaying a frozen job recipe. */
  publishing?: RetryPublishingContract;
}

/** 二维批量展开:每个选题 × 每个预设 → 一个 GenerateInput(复用单篇构造逻辑,零重写)。 */
export function buildBatchJobs({ project, opportunities, presets, overrides, imageAssetIds, publishing }: BuildBatchArgs): GenerateInput[] {
  const jobs: GenerateInput[] = [];
  for (const opportunity of opportunities) {
    for (const preset of presets) {
      const settings = resolveSimpleGenerationSettings({ project, preset, opportunity, overrides });
      const input = buildSimpleGenerateInput({
        projectId: project.id,
        opportunity,
        settings,
        imageAssetIds,
        lockedGapIds: [],
        presetId: preset.id,
        localFieldsEnabled: false,
        overrides: overrides as Record<string, unknown>,
        randomizationDimensions: [],
      });
      jobs.push({ ...input, ...publishing });
    }
  }
  return jobs;
}

const STATUS_LABELS: Record<GenerationBatchStatus, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  partial: "部分完成",
  failed: "全部失败",
};

export function batchStatusLabel(status: GenerationBatchStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function batchProgressText(jobs: GenerationJob[]): string {
  // 失败不算「完成」：全失败批次显示 0/4 完成 · 4 失败，与「全部失败」徽章一致。
  const ok = jobs.filter((j) => j.status === "completed").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  return failed ? `${ok}/${jobs.length} 完成 · ${failed} 失败` : `${ok}/${jobs.length} 完成`;
}

/**
 * 看板徽章的实时状态：轮询只刷新任务，不会刷新批次行，所以徽章必须由当前任务聚合，
 * 否则任务跑完后徽章会一直停在「生成中」，与旁边的「N/N 完成」自相矛盾。
 * 规则与后端 computeBatchStatus 保持一致；jobs 还没加载时退回服务端状态，
 * 不把空数组当「已完成」（那会把排队中的批次显示成完成）。
 */
export function liveBatchStatus(serverStatus: GenerationBatchStatus, jobs: GenerationJob[]): GenerationBatchStatus {
  if (jobs.length === 0) return serverStatus;
  const statuses = jobs.map((job) => job.status);
  if (statuses.some((s) => s === "queued" || s === "running")) {
    return statuses.every((s) => s === "queued") ? "queued" : "running";
  }
  const ok = statuses.some((s) => s === "completed");
  const failed = statuses.some((s) => s === "failed");
  if (ok && failed) return "partial";
  if (failed) return "failed";
  return "completed";
}
