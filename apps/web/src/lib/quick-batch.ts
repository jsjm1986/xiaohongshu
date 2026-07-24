import { buildSimpleGenerateInput, resolveSimpleGenerationSettings, type SimpleSettingOverrides } from "./simple-generation";
import type { ContentPreset, GenerateInput, GenerationBatchStatus, GenerationJob, Project, TopicOpportunity } from "../types";

interface BuildBatchArgs {
  project: Project;
  opportunities: TopicOpportunity[];
  presets: ContentPreset[];
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
}

/** 二维批量展开:每个选题 × 每个预设 → 一个 GenerateInput(复用单篇构造逻辑,零重写)。 */
export function buildBatchJobs({ project, opportunities, presets, overrides, imageAssetIds }: BuildBatchArgs): GenerateInput[] {
  const jobs: GenerateInput[] = [];
  for (const opportunity of opportunities) {
    for (const preset of presets) {
      const settings = resolveSimpleGenerationSettings({ project, preset, opportunity, overrides });
      jobs.push(buildSimpleGenerateInput({
        projectId: project.id,
        opportunity,
        settings,
        imageAssetIds,
        lockedGapIds: [],
        presetId: preset.id,
        localFieldsEnabled: false,
        overrides: overrides as Record<string, unknown>,
        randomizationDimensions: [],
      }));
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
  const done = jobs.filter((j) => j.status === "completed" || j.status === "failed").length;
  return `${done}/${jobs.length} 完成`;
}
