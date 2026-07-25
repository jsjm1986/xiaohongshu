import type { ContentPreset, GenerationJob, TopicOpportunity } from "../types";
import type { CommentRichnessLevel, SimpleSettingOverrides } from "./simple-generation";

export interface QuickRecipe {
  opportunityId?: string;
  presetId?: string;
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// 后端 ResolvedGenerationConfig.task 把必含/禁用词存成 string[]（preset.service 的
// lines() 按 \n , ， 、 ; ； 拆分），而创作区的 overrides 是单个字符串。回灌时用
// 顿号拼回可读的一行；历史上若已是字符串则原样返回。
const words = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    const joined = value.map(String).map((item) => item.trim()).filter(Boolean).join("、");
    return joined || undefined;
  }
  return str(value);
};

/** 从历史 job 快照抽出可回灌的配方：选题 + 预设 + 高级参数覆盖 + 源素材图。 */
export function extractRecipe(job: GenerationJob): QuickRecipe {
  // opportunityId / imageContext 由后端 mapJob 返回，但未声明在 GenerationJob 类型上。
  const raw = job as unknown as Record<string, unknown>;
  const config = record(job.resolvedConfig);
  const task = record(config.task);
  const overrides: SimpleSettingOverrides = {};

  const audienceStage = str(task.audienceStage);
  // 后端字段名是 task.entry；entryPoint 只是请求侧的入参名，两者都兜。
  const entryPoint = str(task.entry ?? task.entryPoint);
  const city = str(task.city);
  const doctor = str(task.doctor);
  const mustInclude = words(task.mustMention ?? task.mustInclude);
  const forbidden = words(task.forbidden);
  const richness = str(task.commentRichness) as CommentRichnessLevel | undefined;
  if (audienceStage) overrides.audienceStage = audienceStage;
  if (entryPoint) overrides.entryPoint = entryPoint;
  if (city) overrides.city = city;
  if (doctor) overrides.doctor = doctor;
  if (mustInclude) overrides.mustInclude = mustInclude;
  if (forbidden) overrides.forbidden = forbidden;
  if (richness) overrides.commentRichness = richness;

  const snapshot = record(job.opportunitySnapshot);
  const opportunityId = str(raw.opportunityId) ?? str(snapshot.id) ?? str(snapshot.opportunityId);

  const imageContext = Array.isArray(raw.imageContext) ? raw.imageContext : [];
  const imageAssetIds = imageContext
    .map((entry) => str(record(entry).assetId) ?? str(record(entry).id))
    .filter((id): id is string => Boolean(id));

  return { opportunityId, presetId: job.presetId, overrides, imageAssetIds };
}

export interface ResolvedRecipeTargets {
  opportunityId: string;
  presetId: string | undefined;
  overrides: SimpleSettingOverrides;
  imageAssetIds: string[];
  warnings: string[];
}

/** 回灌前校验选题/预设是否仍存在；失效则回落并给出中文提示。 */
export function resolveRecipeTargets(
  recipe: QuickRecipe,
  opportunities: TopicOpportunity[],
  presets: ContentPreset[],
): ResolvedRecipeTargets {
  const warnings: string[] = [];

  const oppExists = Boolean(recipe.opportunityId) && opportunities.some((item) => item.id === recipe.opportunityId);
  const opportunityId = oppExists ? recipe.opportunityId! : "";
  if (recipe.opportunityId && !oppExists) {
    warnings.push("原选题已不在选题池，请挑一个新选题套用这套配置。");
  }

  let presetId = recipe.presetId;
  const presetExists = Boolean(presetId) && presets.some((item) => item.id === presetId);
  if (presetId && !presetExists) {
    presetId = presets.find((item) => item.isDefault)?.id ?? presets[0]?.id;
    warnings.push("原预设已删除，已回落到默认预设。");
  }

  return { opportunityId, presetId, overrides: recipe.overrides, imageAssetIds: recipe.imageAssetIds, warnings };
}
