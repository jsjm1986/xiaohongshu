import type {
  ContentPreset,
  GenerateInput,
  PlanningRandomizationDimension,
  Project,
  TopicOpportunity,
} from "../types";

export type SimpleSettingSource = "user" | "opportunity" | "preset" | "project" | "default";
export type CommentRichnessLevel = "restrained" | "balanced" | "dense";

export const COMMENT_RICHNESS_PROFILES: Record<CommentRichnessLevel, {
  label: string;
  description: string;
  values: Record<string, number>;
}> = {
  restrained: {
    label: "克制",
    description: "角色、平台语域和多轮分支更少，直接回复为主，适合正文已经较完整的内容。",
    values: { comment_role_diversity: 35, comment_constraint_density: 35, comment_gap_multiplexing: 30, comment_reply_increment: 45, question_compression: 35, comment_platform_register: 25, comment_conversation_rate: 20, comment_branching_strength: 30, comment_organic_variation: 25, comment_discovery_strength: 35, comment_inference_effort: 20, comment_self_verification: 45, comment_false_closure_guard: 95 },
  },
  balanced: {
    label: "均衡",
    description: "兼顾人物差异、自然口语、单轮与多轮分支，默认适合大多数选题。",
    values: { comment_role_diversity: 65, comment_constraint_density: 60, comment_gap_multiplexing: 55, comment_reply_increment: 70, question_compression: 60, comment_platform_register: 68, comment_conversation_rate: 48, comment_branching_strength: 62, comment_organic_variation: 58, comment_discovery_strength: 65, comment_inference_effort: 35, comment_self_verification: 70, comment_false_closure_guard: 95 },
  },
  dense: {
    label: "高密度",
    description: "增加角色、圈内语域、多轮接话和相邻信息延展；仍保持一条主线且不制造虚假口碑。",
    values: { comment_role_diversity: 90, comment_constraint_density: 85, comment_gap_multiplexing: 80, comment_reply_increment: 88, question_compression: 80, comment_platform_register: 82, comment_conversation_rate: 70, comment_branching_strength: 80, comment_organic_variation: 82, comment_discovery_strength: 80, comment_inference_effort: 45, comment_self_verification: 85, comment_false_closure_guard: 98 },
  },
};

export interface SimpleSetting<T> {
  value: T;
  source: SimpleSettingSource;
}

export interface SimpleSettingOverrides {
  audienceStage?: string;
  entryPoint?: string;
  city?: string;
  doctor?: string;
  mustInclude?: string;
  forbidden?: string;
  commentRichness?: CommentRichnessLevel;
}

export interface ResolvedSimpleSettings {
  audienceStage: SimpleSetting<string>;
  entryPoint: SimpleSetting<string>;
  city: SimpleSetting<string>;
  doctor: SimpleSetting<string>;
  mustInclude: SimpleSetting<string>;
  forbidden: SimpleSetting<string>;
  commentRichness: SimpleSetting<CommentRichnessLevel>;
}

interface ResolveSimpleSettingsInput {
  overrides?: SimpleSettingOverrides;
  opportunity?: TopicOpportunity;
  preset?: ContentPreset;
  project?: Project;
}

interface BuildSimpleInputArgs {
  projectId: string;
  opportunity: TopicOpportunity;
  settings: ResolvedSimpleSettings;
  imageAssetIds: string[];
  lockedGapIds: string[];
  lockedStrategyId?: string;
  presetId?: string;
  localFieldsEnabled: boolean;
  overrides?: Record<string, unknown>;
  randomizationDimensions: PlanningRandomizationDimension[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const firstDefined = <T>(candidates: Array<[T | undefined, SimpleSettingSource]>): SimpleSetting<T> => {
  for (const [value, source] of candidates) {
    if (value !== undefined) return { value, source };
  }
  throw new Error("A default simple setting is required");
};

const textValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join("\n");
  return undefined;
};

const presetValues = (preset?: ContentPreset) => {
  if (!preset) return {} as Record<string, unknown>;
  return isRecord(preset.values.parameters) ? preset.values.parameters : preset.values;
};

const presetText = (preset: ContentPreset | undefined, ...keys: string[]) => {
  const valueSets = [presetValues(preset), preset?.values || {}];
  for (const values of valueSets) {
    for (const key of keys) {
      const value = textValue(values[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
};

const presetNumber = (preset: ContentPreset | undefined, key: string) => {
  const valueSets = [presetValues(preset), preset?.values || {}];
  for (const values of valueSets) {
    if (typeof values[key] === "number") return values[key];
  }
  return undefined;
};

const richnessFromPreset = (preset?: ContentPreset): CommentRichnessLevel | undefined => {
  const parameterIds = Object.keys(COMMENT_RICHNESS_PROFILES.balanced.values);
  const observed = Object.fromEntries(parameterIds.flatMap((id) => {
    const value = presetNumber(preset, id);
    return value === undefined ? [] : [[id, value]];
  })) as Record<string, number>;
  if (!Object.keys(observed).length) return undefined;
  return (Object.keys(COMMENT_RICHNESS_PROFILES) as CommentRichnessLevel[])
    .map((level) => ({
      level,
      distance: Object.entries(observed).reduce((total, [id, value]) => total + Math.abs(value - COMMENT_RICHNESS_PROFILES[level].values[id]!), 0),
    }))
    .sort((left, right) => left.distance - right.distance)[0]!.level;
};

const opportunityText = (value?: string | string[]) => textValue(value);

/** Resolve visible simple-mode settings without leaking hidden engineering parameters. */
export function resolveSimpleGenerationSettings({
  overrides = {},
  opportunity,
  preset,
  project,
}: ResolveSimpleSettingsInput): ResolvedSimpleSettings {
  const projectDefaults = project?.generationDefaults;
  const projectCity = projectDefaults?.city ?? (project?.cities?.length === 1 ? project.cities[0] : undefined);
  const projectDoctor = projectDefaults?.doctor ?? (project?.doctors?.length === 1 ? project.doctors[0]?.name : undefined);

  return {
    audienceStage: firstDefined([
      [overrides.audienceStage, "user"],
      [opportunity?.readerStages?.[0], "opportunity"],
      [presetText(preset, "audience_stage", "audienceStage", "task.audienceStage"), "preset"],
      [projectDefaults?.audienceStage, "project"],
      ["collecting", "default"],
    ]),
    entryPoint: firstDefined([
      [overrides.entryPoint, "user"],
      [opportunity?.recommendedEntryPoint ?? opportunity?.entryPoint, "opportunity"],
      [presetText(preset, "entry_route", "entryPoint", "task.entry"), "preset"],
      [projectDefaults?.entryPoint, "project"],
      ["search", "default"],
    ]),
    city: firstDefined([
      [overrides.city, "user"],
      [opportunity?.city, "opportunity"],
      [presetText(preset, "city", "task.city"), "preset"],
      [projectCity, "project"],
      ["", "default"],
    ]),
    doctor: firstDefined([
      [overrides.doctor, "user"],
      [opportunity?.doctor, "opportunity"],
      [presetText(preset, "doctor", "person", "task.doctor"), "preset"],
      [projectDoctor, "project"],
      ["", "default"],
    ]),
    mustInclude: firstDefined([
      [overrides.mustInclude, "user"],
      [opportunityText(opportunity?.mustInclude), "opportunity"],
      [presetText(preset, "mustInclude", "mustMention", "must_mention", "task.mustMention"), "preset"],
      [opportunityText(projectDefaults?.mustInclude), "project"],
      ["", "default"],
    ]),
    forbidden: firstDefined([
      [overrides.forbidden, "user"],
      [opportunityText(opportunity?.forbidden), "opportunity"],
      [presetText(preset, "forbidden", "forbidden_content", "task.forbidden"), "preset"],
      [opportunityText(projectDefaults?.forbidden), "project"],
      ["", "default"],
    ]),
    commentRichness: firstDefined([
      [overrides.commentRichness, "user"],
      [richnessFromPreset(preset), "preset"],
      ["balanced", "default"],
    ]),
  };
}

export function shouldShowSimpleLocalFields(audienceStage: string, presetId?: string) {
  return audienceStage === "ready" || presetId === "local_choice";
}

const cleanText = (value: string) => value.trim();

export function mergeCommentRichnessOverrides(existing: Record<string, unknown> = {}, level: CommentRichnessLevel) {
  return { ...existing, ...COMMENT_RICHNESS_PROFILES[level].values };
}

/** Map exactly what simple mode displays into the generation request. */
export function buildSimpleGenerateInput({
  projectId,
  opportunity,
  settings,
  imageAssetIds,
  lockedGapIds,
  lockedStrategyId,
  presetId,
  localFieldsEnabled,
  overrides,
  randomizationDimensions,
}: BuildSimpleInputArgs): GenerateInput {
  const requestOverrides = settings.commentRichness.source === "user"
    ? mergeCommentRichnessOverrides(overrides, settings.commentRichness.value)
    : overrides;
  const city = cleanText(settings.city.value);
  const doctor = cleanText(settings.doctor.value);
  const effectiveStrategyId = opportunity.strategyId || lockedStrategyId;
  return {
    projectId,
    mode: "simple",
    opportunityId: opportunity.id,
    topic: opportunity.title,
    goal: opportunity.whyValuable,
    audienceStage: settings.audienceStage.value,
    entryPoint: settings.entryPoint.value,
    // Read-only contextual values still affect generation. Hiding their editor
    // must not silently discard a non-empty project/preset/opportunity value.
    city: localFieldsEnabled || city ? city : undefined,
    doctor: localFieldsEnabled || doctor ? doctor : undefined,
    mustInclude: cleanText(settings.mustInclude.value),
    forbidden: cleanText(settings.forbidden.value),
    imageAssetIds,
    lockedGapIds,
    lockedStrategyId: effectiveStrategyId,
    locks: { gapIds: lockedGapIds, strategyId: effectiveStrategyId },
    randomizationDimensions,
    presetId,
    ...(requestOverrides && Object.keys(requestOverrides).length ? { overrides: requestOverrides } : {}),
    randomization: {
      dimensions: randomizationDimensions,
      randomizationDimensions,
      variationStrength: 0.72,
      reuseCooldown: 8,
    },
  };
}
