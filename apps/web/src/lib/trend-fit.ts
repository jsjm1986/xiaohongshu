import type { FormulaCalculatorContract, FormulaVariableDefinition } from "../types";

export type TrendSourceType = "xiaohongshu_hotspot_rank" | "xiaohongshu_hot_discussion" | "other_explicit_source";

const trendSourceDefinitions: Array<{
  value: TrendSourceType;
  label: string;
  explanation: string;
}> = [
  {
    value: "xiaohongshu_hotspot_rank",
    label: "小红书“热点榜”条目",
    explanation: "只有明确记录来自官方热点榜页面或数据时才可选择；这里只记录用户声明，不联网核验官方身份，也不能由标题、标签或热词反推。",
  },
  {
    value: "xiaohongshu_hot_discussion",
    label: "小红书“热议话题”",
    explanation: "这是与官方热点榜不同的来源类型；只有明确来源记录时才可选择，页面不联网核验其平台身份。",
  },
  {
    value: "other_explicit_source",
    label: "其他明确来源",
    explanation: "必须填写具体来源对象；该类型不会被自动改写成小红书热点榜或热议话题，页面也不联网核验。",
  },
];

const canonicalTrendFitContract: FormulaCalculatorContract = {
  mode: "manual_scenario",
  outputMetric: "TrendFit",
  outputSemantics: "unvalidated_scenario_index",
  outputRange: [0, 1],
  consumedBy: { generation: false, planning: false, selection: false, validation: false },
  prohibitedUses: ["generation", "planning", "selection", "validation"],
  excludedResearchOutputs: [{
    metric: "qualifiedIncrementalReach",
    protocolId: "qualified_incremental_reach_protocol",
    status: "not_executed",
    outputProduced: false,
    notProducedByCalculator: true,
    reason: "TrendFit has no exposure counterfactual, qualified-audience outcome, or deduplicated incremental-reach observation.",
    requiredObservations: [
      "预先定义的合格触达结果与合格受众口径",
      "同一口径下无热点桥接基线、热点桥接处理及可解释反事实",
      "可比入口、投放位置、平台条件、曝光机会与预先约定的归因时间窗",
      "去重后的增量触达结果，以及风险、过期和混杂处理；不能用标签数量或榜单身份代替",
    ],
  }],
  boundaries: [
    "xiaohongshu_hotspot_rank 只表示用户声明在 sourceObservedAt 观察到一个具体小红书热点榜条目；系统只校验声明格式，不联网核验榜单身份、观察时间、持续热度或触达增量。",
    "xiaohongshu_hot_discussion 只表示用户声明了一个具体小红书热议对象；系统不联网核验其存在性，也不得把该声明冒充热点榜条目。",
    "other_explicit_source 必须由用户声明具体来源对象；系统不联网核验来源存在性，且不得把它改写成小红书热点榜或热议来源。",
    "relevance、bridgeClarity、timeliness 都是用户手工情景输入，未校准且不是平台观测值。",
    "标签与热点词只能表达内容关联，不能保证曝光、推荐、进入或合格触达。",
  ],
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const isTrendSourceType = (value: unknown): value is TrendSourceType =>
  trendSourceDefinitions.some((item) => item.value === value);

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value)) ?? "";
}

/** The reviewed FormulaDefinition is the source of selectable enum values. */
export function trendSourceOptionsFromAllowedValues(
  allowedValues: FormulaVariableDefinition["allowedValues"] | unknown,
): typeof trendSourceDefinitions {
  return Array.isArray(allowedValues)
    ? allowedValues
      .filter(isTrendSourceType)
      .map((value) => trendSourceDefinitions.find((item) => item.value === value)!)
    : [];
}

export interface TrendSourceView {
  type: TrendSourceType | "unknown";
  label: string;
  explanation: string;
  explicitClassification: boolean;
}

/** Exact-enum only: wording such as “热门”“热议” never classifies a source. */
export function resolveTrendSourceView(value: unknown): TrendSourceView {
  const option = trendSourceDefinitions.find((item) => item.value === value);
  if (option) return {
    type: option.value,
    label: option.label,
    explanation: option.explanation,
    explicitClassification: true,
  };
  return {
    type: "unknown",
    label: "unknown（未声明来源类型）",
    explanation: "没有明确来源枚举时保持 unknown；系统不会根据话题名称、标签或热度措辞自动归类。",
    explicitClassification: false,
  };
}

export interface TrendSourceBadgeView {
  label: "unknown" | "显式声明 / 格式待服务端校验" | "格式通过但未联网核验";
  formatAccepted: boolean;
}

export function resolveTrendSourceBadge(
  source: TrendSourceView,
  calculationResult?: unknown,
): TrendSourceBadgeView {
  if (!source.explicitClassification) return { label: "unknown", formatAccepted: false };
  return hasConsistentTrendFitCalculationResult(calculationResult)
    && asRecord(calculationResult)?.status === "computed"
    ? { label: "格式通过但未联网核验", formatAccepted: true }
    : { label: "显式声明 / 格式待服务端校验", formatAccepted: false };
}

export const TREND_FIT_NON_CONSUMPTION_COPY =
  "TrendFit 只接受显式手工情景输入，不读取标签数量、入口参数或平台实时数据；结果不参与生成、规划、验证、选稿或触达预测。";

export const TREND_FIT_SETTINGS_BOUNDARY_COPY =
  "可视化生成参数不把标签或入口换算成 TrendFit。F30 公式页是引导式计算入口；高级 JSON 也可显式提供同一六项输入，但只生成 impactReport 审计快照，不参与生成、规划、验证、选稿或触达预测。";

export const TREND_FIT_SIMPLE_BOUNDARY_COPY =
  "“推荐流情景”只描述可能的进入路径；当前没有明确热点来源就保持 unknown，不会自动归类为小红书热点榜或热议话题。标签用于表达主题关联，不保证曝光、推荐或合格触达，TrendFit 不参与生成排序。";

export function f30ParameterLinkWarning(formulaIds: string[]): string | undefined {
  return formulaIds.includes("F30")
    ? "该 F30 关联仅用于解释相邻概念，不代表这个生成参数会成为 TrendFit 输入。标签数量、路由具体度和新颖度不会自动计算 TrendFit，也不保证触达。"
    : undefined;
}

/** Exact R12 contract: contradictory or future-unreviewed variants fail closed. */
export function hasCanonicalTrendFitContractShape(value: unknown): value is FormulaCalculatorContract {
  return Boolean(asRecord(value)) && stableJson(value) === stableJson(canonicalTrendFitContract);
}

export function hasCanonicalTrendFitVariableContract(variables: unknown): variables is FormulaVariableDefinition[] {
  if (!Array.isArray(variables) || variables.length !== 6) return false;
  const records = variables.map(asRecord);
  if (records.some((variable) => !variable)) return false;
  const byPath = new Map(records.map((variable) => [variable!.path, variable!]));
  const kind = byPath.get("trendSourceKind");
  const expectedAllowed: TrendSourceType[] = ["xiaohongshu_hotspot_rank", "xiaohongshu_hot_discussion", "other_explicit_source"];
  const allowed = kind?.allowedValues;
  const sourceFieldsValid = kind?.valueType === "string"
    && kind.required === true
    && Array.isArray(allowed)
    && allowed.length === expectedAllowed.length
    && allowed.every((value, index) => value === expectedAllowed[index])
    && ["trendSourceRef", "sourceObservedAt"].every((path) => {
      const variable = byPath.get(path);
      const expectedFormat = path === "trendSourceRef" ? "trend_source_ref" : "rfc3339_timestamp";
      return variable?.valueType === "string"
        && variable.required === true
        && variable.nonEmpty === true
        && variable.format === expectedFormat;
    });
  const numericFieldsValid = ["relevance", "bridgeClarity", "timeliness"].every((path) => {
    const variable = byPath.get(path);
    return variable?.valueType === "number"
      && variable.required === true
      && variable.minimum === 0
      && variable.maximum === 1;
  });
  return byPath.size === 6 && sourceFieldsValid && numericFieldsValid;
}

export function isReviewedTrendFitCalculatorContract(
  value: unknown,
  runtime: {
    state?: string;
    compatibilityStatus?: string;
    reviewStatus?: string;
    handlerState?: string;
    effectiveHandlersEnabled?: boolean;
    effectiveHandlers?: Array<{ kind: string; handlers: string[] }>;
  },
  variables: unknown,
): value is FormulaCalculatorContract {
  return runtime.state === "handlers_enabled"
    && runtime.effectiveHandlersEnabled === true
    && runtime.compatibilityStatus === "reviewed"
    && (runtime.reviewStatus === undefined || runtime.reviewStatus === "reviewed" || runtime.reviewStatus === "approved")
    && runtime.handlerState === "enabled"
    && Boolean(runtime.effectiveHandlers?.some((item) => item.kind === "calculator" && item.handlers.includes("calculator:F30")))
    && hasCanonicalTrendFitContractShape(value)
    && hasCanonicalTrendFitVariableContract(variables);
}

const issueRecords = (value: unknown): Array<Record<string, unknown>> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const records = value.map(asRecord);
  return records.every(Boolean) ? records as Array<Record<string, unknown>> : undefined;
};

export function hasConsistentTrendFitCalculationResult(value: unknown): boolean {
  const result = asRecord(value);
  if (!result || result.formulaId !== "F30" || result.unit !== null) return false;
  const unknownPaths = Array.isArray(result.unknownPaths) && result.unknownPaths.every((path) => typeof path === "string")
    ? result.unknownPaths as string[]
    : undefined;
  const issues = issueRecords(result.issues);
  if (!unknownPaths || !issues) return false;
  if (result.status === "computed") {
    return typeof result.value === "number"
      && Number.isFinite(result.value)
      && result.value >= 0
      && result.value <= 1
      && unknownPaths.length === 0
      && issues.length === 0;
  }
  if (result.value !== null) return false;
  if (result.status === "unknown") {
    const missingPaths = issues
      .filter((issue) => issue.code === "required_input_missing" && typeof issue.path === "string")
      .map((issue) => issue.path as string);
    return unknownPaths.length > 0
      && issues.length === missingPaths.length
      && unknownPaths.every((path) => missingPaths.includes(path));
  }
  return result.status === "invalid"
    && issues.some((issue) => issue.code !== "required_input_missing");
}

export function sameTrendFitContract(definition: unknown, result: unknown): boolean {
  return hasCanonicalTrendFitContractShape(definition)
    && hasCanonicalTrendFitContractShape(result)
    && stableJson(definition) === stableJson(result);
}

export interface HistoricalTrendFitSnapshotView {
  displayValue: number | null;
  contractSnapshot?: FormulaCalculatorContract;
  summary: string;
  detail: string;
}

export function resolveHistoricalTrendFitSnapshot(
  value: unknown,
  contract: unknown,
): HistoricalTrendFitSnapshotView {
  if (!hasCanonicalTrendFitContractShape(contract)) {
    return {
      displayValue: null,
      summary: "历史记录缺少规范 calculatorContract；原始数值不展示，语义保持 unknown。",
      detail: "无法仅凭 F30 编号判断它是否来自手工情景、当时处理器是否已复核，或下游是否读取过该值。",
    };
  }
  const displayValue = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
  return {
    displayValue,
    contractSnapshot: contract,
    summary: "该历史项携带规范 calculatorContract 结构；合同声明它是手工未标定情景，并禁止用于生成、规划、验证和选稿。",
    detail: `${displayValue === null ? "数值缺失或越界，显示为 unknown。" : "显示的是未验证历史快照值。"} 页面未持有当时 runtime 复核与实际消费审计，不能据此断言当时处理器已复核或所有下游实际未读取。`,
  };
}
