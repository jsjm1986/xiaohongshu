import type {
  OpportunityRankComponent,
  OpportunitySelectionAudit,
  TopicOpportunity,
} from "../types";

export const OPPORTUNITY_RANK_HEURISTIC_ID = "OpportunityRankHeuristicV1";

const metricLabels: Record<string, string> = {
  relevance: "主题相关性",
  importance: "决策重要性",
  proofability: "可证实性",
  decisionLeverage: "决策推动力",
  novelty: "信息新颖度",
  cognitiveCost: "理解成本",
  risk: "表达风险",
};

const sourceKindLabels: Record<string, string> = {
  observed: "观测或已查询记录",
  user: "用户输入",
  project: "项目资源",
  model_heuristic: "模型启发式判断",
  system_heuristic: "系统启发式推导",
  default_policy: "默认排序策略",
  legacy_unspecified: "历史来源未记录",
  project_knowledge: "项目知识",
  approved_resource: "已批准资源",
  user_input: "用户输入",
  system_default: "系统默认",
  coverage_ledger: "历史覆盖账本",
  not_provided: "未提供",
  unknown: "unknown",
};

export interface OpportunityRankComponentView {
  metric: string;
  label: string;
  value: string;
  transformedValue: string;
  weight: string;
  contribution: string;
  source: string;
  unknown: boolean;
}

export interface OpportunityRankView {
  title: string;
  version?: string;
  sortable: boolean;
  valueLabel: string;
  rankLabel?: string;
  stateLabel: "可排序" | "待复核" | "历史数据";
  components: OpportunityRankComponentView[];
  unknownMetrics: string[];
  reviewReasons: string[];
  inputSources: Array<{ label: string; source: string }>;
  policy?: Array<{ label: string; value: string }>;
  recentCoverage: {
    status: "provided" | "unknown";
    value: string;
    source: string;
  };
  fixedWeights: boolean;
  weightsCalibrated: false;
  causal: false;
  notF28: true;
  historical: boolean;
  warning?: string;
}

export interface OpportunitySelectionAuditView {
  state: "explicit_locked" | "heuristic_ranked" | "default_policy" | "revision_inherited" | "not_applied" | "unknown";
  label: string;
  detail: string;
  rankApplied: boolean;
  rankView?: OpportunityRankView;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const valueLabel = (value: number | null | undefined): string =>
  finite(value) ? value.toFixed(2) : "unknown";

export function opportunityMetricLabel(metric: string): string {
  return metricLabels[metric] || metric;
}

export function opportunitySourceLabel(source: unknown): string {
  if (typeof source === "string") return sourceKindLabels[source] || source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return "unknown（未记录来源）";
  const data = source as Record<string, unknown>;
  const kind = typeof data.source === "string"
    ? data.source
    : typeof data.kind === "string"
      ? data.kind
      : typeof data.type === "string"
        ? data.type
        : "";
  const label = kind ? sourceKindLabels[kind] || kind : "来源未命名";
  const reference = typeof data.sourceRef === "string"
    ? data.sourceRef
    : typeof data.ref === "string"
      ? data.ref
    : typeof data.reference === "string"
      ? data.reference
      : typeof data.path === "string"
        ? data.path
        : "";
  const note = typeof data.note === "string" ? data.note : "";
  return [label, reference, note].filter(Boolean).join(" · ");
}

function componentView(component: OpportunityRankComponent): OpportunityRankComponentView {
  const unknown = !finite(component.rawValue)
    || !finite(component.transformedValue)
    || !finite(component.contribution);
  return {
    metric: component.metric,
    label: opportunityMetricLabel(component.metric),
    value: valueLabel(component.rawValue),
    transformedValue: valueLabel(component.transformedValue),
    weight: finite(component.weight) ? component.weight.toFixed(2) : "unknown",
    contribution: valueLabel(component.contribution),
    source: opportunitySourceLabel(component.source),
    unknown,
  };
}

/**
 * Build a conservative UI view. Missing or historical metadata never becomes
 * a zero, percentage, inferred score, or current ranking result.
 */
export function resolveOpportunityRankView(opportunity: Partial<TopicOpportunity>): OpportunityRankView {
  const current = opportunity.heuristic?.id === OPPORTUNITY_RANK_HEURISTIC_ID
    && opportunity.heuristic.weightsCalibrated === false
    && opportunity.heuristic.causal === false
    && opportunity.heuristic.notF28 === true
    && (opportunity.scoreSemantics || opportunity.heuristic.scoreSemantics) === "ordinal_noncausal_heuristic";
  const components = (opportunity.components || []).map(componentView);
  const unknownMetrics = [...new Set([
    ...(opportunity.unknownMetrics || []),
    ...components.filter((item) => item.unknown).map((item) => item.metric),
  ])];
  const reviewReasons = [...new Set(opportunity.reviewReasons || [])];
  const reviewRequired = opportunity.reviewRequired === true
    || opportunity.effectiveEligibility === "review_required"
    || opportunity.effectiveEligibility === "ineligible"
    || unknownMetrics.length > 0;
  const sortable = current
    && !reviewRequired
    && opportunity.effectiveEligibility === "eligible"
    && finite(opportunity.finalScore);
  const historical = !current;
  const recentStatus = opportunity.recentCoverage?.status === "provided" ? "provided" : "unknown";
  const recentSimilarity = recentStatus === "provided" && finite(opportunity.recentCoverage?.similarity)
    ? opportunity.recentCoverage.similarity.toFixed(2)
    : recentStatus === "provided" && opportunity.recentCoverage?.count === 0
      ? "0.00（明确无历史记录）"
      : "unknown";
  const sourceFields: Array<[string, unknown]> = [
    ["状态", opportunity.inputSources?.status],
    ["主题", opportunity.inputSources?.topic],
    ["信息缺口", opportunity.inputSources?.gapIds],
    ["历史覆盖", opportunity.inputSources?.recentCoverage],
    ["阈值选项", opportunity.inputSources?.options],
  ];
  const inputSources = sourceFields
    .filter(([, source]) => source !== undefined)
    .map(([label, source]) => ({ label, source: opportunitySourceLabel(source) }));
  const policy = opportunity.policy ? [
    { label: "最低可证实性", value: valueLabel(opportunity.policy.minProofability) },
    { label: "最高风险", value: valueLabel(opportunity.policy.maxRisk) },
    { label: "近期覆盖惩罚权重", value: valueLabel(opportunity.policy.recentPenaltyWeight) },
    { label: "复用冷却条数", value: String(opportunity.policy.reuseCooldown) },
  ] : undefined;

  return {
    title: current ? "机会排序启发式 V1" : "历史机会排序数据",
    version: opportunity.heuristic?.version,
    sortable,
    valueLabel: sortable ? opportunity.finalScore!.toFixed(3) : historical ? "历史值不参与当前排序" : "待复核",
    rankLabel: sortable && finite(opportunity.rank) ? `第 ${opportunity.rank} 位` : undefined,
    stateLabel: historical ? "历史数据" : sortable ? "可排序" : "待复核",
    components,
    unknownMetrics,
    reviewReasons,
    inputSources,
    policy,
    recentCoverage: {
      status: recentStatus,
      value: recentSimilarity,
      source: opportunitySourceLabel(opportunity.recentCoverage?.source),
    },
    fixedWeights: current,
    weightsCalibrated: false,
    causal: false,
    notF28: true,
    historical,
    warning: historical
      ? "该记录没有 OpportunityRankHeuristicV1 审计元数据；旧 score 仅作为历史启发式字段保留，当前页面不把它当作可比较分数。"
      : undefined,
  };
}

/** Render only a persisted server selection audit; never reconstruct a choice in the browser. */
export function resolveOpportunitySelectionAuditView(
  audit: OpportunitySelectionAudit | undefined,
): OpportunitySelectionAuditView {
  if (!audit) return {
    state: "unknown",
    label: "选择依据未记录",
    detail: "历史内容包没有选题选择审计，无法判断是否运行过机会排序；页面不会事后重算。",
    rankApplied: false,
  };
  if (audit.selectionMode === "explicit_locked" && audit.rankStatus === "not_applied") return {
    state: "explicit_locked",
    label: "用户锁定选题 · 未运行排序",
    detail: "本次使用已明确选择并批准的选题；OpportunityRankHeuristicV1 不是选择依据，也没有产生可展示的排序值。",
    rankApplied: false,
  };
  if (audit.selectionMode === "default_policy" && audit.rankStatus === "not_applied") return {
    state: "default_policy",
    label: "默认选题策略 · 未运行排序",
    detail: "本次没有可比较的候选机会集合，Core 按默认策略构造选题；OpportunityRankHeuristicV1 没有运行，也不是选择依据。",
    rankApplied: false,
  };
  if (audit.selectionMode === "revision_inherited" && audit.rankStatus === "not_applied") return {
    state: "revision_inherited",
    label: "沿用原选题 · 未重新排序",
    detail: "本次修订沿用原内容包的选题，没有重新运行 OpportunityRankHeuristicV1；页面不会把原排序状态伪装成本次选择依据。",
    rankApplied: false,
  };
  const selectedRank = audit.selectedOpportunityRank;
  if (audit.selectionMode === "heuristic_ranked" && audit.rankStatus === "applied" && selectedRank) {
    const { opportunity, ...auditFields } = selectedRank;
    return {
      state: "heuristic_ranked",
      label: "机会排序启发式已用于自动选择",
      detail: "以下内容来自生成时冻结的服务端审计；页面没有重新计算。它不是 F28，也不是因果效果预测。",
      rankApplied: true,
      rankView: resolveOpportunityRankView({ ...opportunity, ...auditFields }),
    };
  }
  if (audit.rankStatus === "not_applied") return {
    state: "not_applied",
    label: "本次未运行机会排序",
    detail: "服务端明确记录 rankStatus=not_applied，但选择方式不是用户锁定、默认策略或修订继承；页面只陈述未排序，不推断原因。",
    rankApplied: false,
  };
  return {
    state: "unknown",
    label: "选择审计不完整",
    detail: "服务端没有提供完整的已应用排序快照；当前结果保持 unknown，不显示推测分数。",
    rankApplied: false,
  };
}
