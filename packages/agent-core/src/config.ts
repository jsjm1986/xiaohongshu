import type { FormulaVersion, ResolvedGenerationConfig } from "./types.js";
import { DEFAULT_METHOD_PARAMETERS } from "./parameters.js";
import { GENERATION_OUTPUT_TOKENS } from "./output-budget.js";

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends Array<infer Item>
    ? Item[]
    : T[Key] extends object
      ? DeepPartial<T[Key]>
      : T[Key];
};

export interface GenerationConfigLayers {
  system?: DeepPartial<ResolvedGenerationConfig>;
  workspace?: DeepPartial<ResolvedGenerationConfig>;
  project?: DeepPartial<ResolvedGenerationConfig>;
  task?: DeepPartial<ResolvedGenerationConfig>;
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSafe(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (!isRecord(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key) || value === undefined) continue;
    if (Array.isArray(value)) target[key] = structuredClone(value);
    else if (isRecord(value)) target[key] = mergeSafe(isRecord(target[key]) ? structuredClone(target[key]) : {}, value);
    else target[key] = value;
  }
  return target;
}

export function createDefaultGenerationConfig(
  project: ResolvedGenerationConfig["project"],
  formulaVersion: Pick<FormulaVersion, "id" | "formulas">,
): ResolvedGenerationConfig {
  return {
    schemaVersion: "1.0",
    project: structuredClone(project),
    task: {
      theme: "",
      goal: "补全用户做决定所需的信息",
      audienceStage: "collecting",
      entry: "search",
      preContactKnown: [],
      readerConstraints: [],
      publishingTopology: "creative_scenario",
      authorContext: { status: "not_provided", facts: [] },
      mustMention: [],
      forbidden: [],
    },
    knowledge: {
      mode: "auto",
      selectedFileIds: [],
      excludedFileIds: [],
      maxInputTokens: 96_000,
      outputReserveTokens: GENERATION_OUTPUT_TOKENS,
      safetyMarginTokens: 1_000,
    },
    informationWindow: {
      gaps: [],
      answers: [],
      evidenceRequirements: [],
      reusableFrameworks: [],
      priorities: [],
      boundaries: [],
    },
    expressionWindow: {
      channels: ["hashtags", "image", "title", "body", "comments"],
      forms: ["求助卡", "生活切片", "随手日记", "评论关系网"],
      voice: "人物一致、生活口语、短而有现场",
      sequence: ["图片现场", "标题/正文建立人物事件", "评论区关系化补全"],
      threadStyle: "短问短答—经验差异—人物路由—自然接话",
    },
    content: {
      bodyMinChars: 20,
      bodyMaxChars: 220,
      hashtagMin: 2,
      hashtagMax: 6,
      commentThreadMin: 3,
      commentThreadMax: 5,
      followUpDepth: 2,
      imageBriefEnabled: true,
    },
    formula: {
      versionId: formulaVersion.id,
      enabledFormulaIds: formulaVersion.formulas.map((formula) => formula.id),
      variables: {},
    },
    model: {
      temperature: 0.8,
      maxOutputTokens: GENERATION_OUTPUT_TOKENS,
    },
    generation: {
      candidateCount: 3,
      baseSeed: 20_260_712,
      maxRepairAttempts: 1,
    },
    diagnostics: {
      requireEvidenceReferences: true,
      rejectUnknownAsFact: true,
      rejectProhibitedClaims: true,
      warnDuplicateInformation: true,
    },
    parameters: structuredClone(DEFAULT_METHOD_PARAMETERS),
  };
}

/** Resolves system → workspace → project → task. Arrays replace lower-precedence arrays. */
export function resolveGenerationConfig(
  defaults: ResolvedGenerationConfig,
  layers: GenerationConfigLayers,
): ResolvedGenerationConfig {
  const merged = structuredClone(defaults) as unknown as Record<string, unknown>;
  for (const layer of [layers.system, layers.workspace, layers.project, layers.task]) mergeSafe(merged, layer);
  const resolved = merged as unknown as ResolvedGenerationConfig;
  if (resolved.schemaVersion !== "1.0") throw new Error("Unsupported generation config schemaVersion.");
  if (!resolved.project.id || !resolved.project.name) throw new Error("Resolved config requires project.id and project.name.");
  if (!resolved.task.theme.trim()) throw new Error("Resolved config requires task.theme.");
  if (resolved.generation.candidateCount !== 3) throw new Error("Resolved config candidateCount must be exactly 3.");
  return resolved;
}
