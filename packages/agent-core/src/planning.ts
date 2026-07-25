import { createHash } from "node:crypto";

import type {
  CommentSurfaceRoleCard,
  CommentThreadKind,
  ContentChannel,
  CoverageSignature,
  DialogueThreadPlan,
  ExpressionStrategy,
  ImageAssetAnalysis,
  ImageAssetRole,
  ImagePlan,
  InformationGap,
  InformationGapPlanningCard,
  OrchestrationPlan,
  PlanningOptions,
  PlanningRandomizationDimension,
  PersonaScenePlan,
  ProjectClaimRule,
  ProjectCreativeBlueprint,
  ProjectIntelligence,
  ResolvedGenerationConfig,
  OpportunityRankComponent,
  OpportunityRankEffectiveEligibility,
  OpportunityRankHeuristicDescriptor,
  OpportunityRankInputProvenance,
  OpportunityRankInputSourceKind,
  OpportunityRankMetric,
  OpportunityRankPolicySnapshot,
  OpportunityRankResultInputSources,
  OpportunityRankRecentCoverageTrace,
  OpportunityRankUnknownMetric,
  OpportunitySelectionAudit,
  RankedTopicOpportunity,
  TopicOpportunity,
} from "./types.js";

const CHANNELS: ContentChannel[] = ["H", "N.imageBrief", "N.title", "N.body", "Cref"];
interface ResolvedPlanningOptions {
  minProofability: number;
  maxRisk: number;
  recentPenaltyWeight: number;
  minStructureDistance: number;
  lockedGapIds: string[];
  lockedStrategyId?: string;
  randomizationDimensions: PlanningRandomizationDimension[];
  variationStrength: number;
  reuseCooldown: number;
}

/** Shared defaults for every caller that asks V1 to rank or gate candidates. */
export const OpportunityRankHeuristicV1DefaultPolicy: Readonly<OpportunityRankPolicySnapshot> = Object.freeze({
  minProofability: 0.2,
  maxRisk: 0.7,
  recentPenaltyWeight: 0.35,
  reuseCooldown: 12,
});

const DEFAULT_OPTIONS: ResolvedPlanningOptions = {
  minProofability: OpportunityRankHeuristicV1DefaultPolicy.minProofability,
  maxRisk: OpportunityRankHeuristicV1DefaultPolicy.maxRisk,
  recentPenaltyWeight: OpportunityRankHeuristicV1DefaultPolicy.recentPenaltyWeight,
  minStructureDistance: 0.45,
  lockedGapIds: [],
  randomizationDimensions: [
    "strategy",
    "opening",
    "state_seed",
    "narrative_sequence",
    "channel_allocation",
    "body_role",
    "comment_topology",
    "voice",
    "image_role",
    "gap_order",
  ],
  variationStrength: 0.8,
  reuseCooldown: OpportunityRankHeuristicV1DefaultPolicy.reuseCooldown,
};

const OPPORTUNITY_RANK_METRICS: OpportunityRankMetric[] = [
  "relevance",
  "importance",
  "proofability",
  "decisionLeverage",
  "novelty",
  "cognitiveCost",
  "risk",
];

/**
 * A deterministic ordering aid, not a fitted model, causal estimate, or an
 * implementation of formula F28. Keep this descriptor with persisted results.
 */
export const OpportunityRankHeuristicV1: OpportunityRankHeuristicDescriptor = Object.freeze({
  id: "OpportunityRankHeuristicV1",
  version: "1.0.0",
  weights: Object.freeze({
    relevance: 0.22,
    importance: 0.2,
    proofability: 0.22,
    decisionLeverage: 0.18,
    novelty: 0.1,
    cognitiveCost: 0.08,
    risk: -0.18,
  }),
  criticalMetrics: Object.freeze([...OPPORTUNITY_RANK_METRICS]),
  weightsCalibrated: false,
  causal: false,
  notF28: true,
  scoreSemantics: "ordinal_noncausal_heuristic",
  scoreRange: Object.freeze([0, 1] as [0, 1]),
});

export interface RankTopicOpportunitiesInput {
  opportunities: TopicOpportunity[];
  recentCoverage?: CoverageSignature[];
  recentCoverageSource?: OpportunityRankInputProvenance;
  options?: PlanningOptions;
  optionsSource?: OpportunityRankInputProvenance;
}

export interface PlanTopicOrchestrationsInput {
  opportunity: TopicOpportunity;
  opportunitySelectionAudit?: OpportunitySelectionAudit;
  gaps: InformationGap[];
  imageAnalyses?: ImageAssetAnalysis[];
  projectIntelligence?: ProjectIntelligence;
  projectBlueprint?: ProjectCreativeBlueprint;
  config: ResolvedGenerationConfig;
  seed?: number;
  seeds?: [number, number, number];
  recentCoverage?: CoverageSignature[];
  options?: PlanningOptions;
  expressionStrategies?: ExpressionStrategy[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function metricValue(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function source(source: OpportunityRankInputSourceKind, note?: string): OpportunityRankInputProvenance {
  return note ? { source, note } : { source };
}

function assertedOrLegacySource(
  asserted: OpportunityRankInputProvenance | undefined,
  hasUsableValue: boolean,
): OpportunityRankInputProvenance {
  return asserted ?? source(hasUsableValue ? "legacy_unspecified" : "unknown");
}

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function normalizedSet(values: string[]): string[] {
  return [...new Set(values.map(normalizedText).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function jaccard(left: string[], right: string[]): number {
  const a = new Set(normalizedSet(left));
  const b = new Set(normalizedSet(right));
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function resolvedOptions(options?: PlanningOptions): ResolvedPlanningOptions {
  return {
    minProofability: clamp01(options?.minProofability ?? DEFAULT_OPTIONS.minProofability),
    maxRisk: clamp01(options?.maxRisk ?? DEFAULT_OPTIONS.maxRisk),
    recentPenaltyWeight: clamp01(options?.recentPenaltyWeight ?? DEFAULT_OPTIONS.recentPenaltyWeight),
    minStructureDistance: clamp01(options?.minStructureDistance ?? DEFAULT_OPTIONS.minStructureDistance),
    lockedGapIds: [...new Set(options?.lockedGapIds ?? DEFAULT_OPTIONS.lockedGapIds)],
    lockedStrategyId: options?.lockedStrategyId,
    randomizationDimensions: [...new Set(options?.randomizationDimensions ?? DEFAULT_OPTIONS.randomizationDimensions)],
    variationStrength: clamp01(options?.variationStrength ?? DEFAULT_OPTIONS.variationStrength),
    reuseCooldown: Math.max(0, Math.floor(options?.reuseCooldown ?? DEFAULT_OPTIONS.reuseCooldown)),
  };
}

/**
 * Structural selectability filter (formerly the F39 feasibility gate).
 *
 * Per requirement 5.3/5.4 the uncalibrated `OpportunityRankHeuristicV1` and its
 * `minProofability`/`maxRisk` thresholds are advisory signals, not gates: they
 * must not decide whether a candidate is selectable. This filter therefore
 * keeps only the *structural* conditions — the topic is not `blocked`, has a
 * non-empty subject, and references at least one information gap. Prediction
 * metrics (including unknown metrics, i.e. `undefined` proofability/risk) never
 * remove a candidate here.
 *
 * The `options` parameter is retained for signature stability (callers still
 * pass planning options) but no longer influences selectability.
 */
export function filterTopicOpportunities(
  opportunities: TopicOpportunity[],
  options?: PlanningOptions,
): TopicOpportunity[] {
  void options;
  return opportunities.filter(
    (opportunity) =>
      opportunity.status !== "blocked"
      && opportunity.topic.trim().length > 0
      && opportunity.gapIds.length > 0,
  );
}

function opportunityCoverageSimilarity(opportunity: TopicOpportunity, coverage: CoverageSignature): number {
  const topic = normalizedText(opportunity.topic) === normalizedText(coverage.topicKey) ? 1 : 0;
  const gaps = jaccard(opportunity.gapIds, coverage.gapIds);
  const state = Number(opportunity.audienceStage === coverage.audienceStage);
  const entry = Number(opportunity.entry === coverage.entry);
  return 0.45 * topic + 0.35 * gaps + 0.12 * state + 0.08 * entry;
}

function metricSource(opportunity: TopicOpportunity, metric: OpportunityRankMetric): OpportunityRankInputProvenance {
  return assertedOrLegacySource(opportunity.rankInputSources?.metrics?.[metric], metricValue(opportunity[metric]) !== undefined);
}

function evaluateOpportunity(
  opportunity: TopicOpportunity,
  input: RankTopicOpportunitiesInput,
  options: ResolvedPlanningOptions,
): Omit<RankedTopicOpportunity, "rank"> {
  const values = Object.fromEntries(
    OPPORTUNITY_RANK_METRICS.map((metric) => [metric, metricValue(opportunity[metric])]),
  ) as Record<OpportunityRankMetric, number | undefined>;
  const metricSources = Object.fromEntries(
    OPPORTUNITY_RANK_METRICS.map((metric) => [metric, metricSource(opportunity, metric)]),
  ) as Record<OpportunityRankMetric, OpportunityRankInputProvenance>;
  const unknownMetrics: OpportunityRankUnknownMetric[] = OPPORTUNITY_RANK_METRICS.filter(
    (metric) => values[metric] === undefined,
  );
  const components: OpportunityRankComponent[] = OPPORTUNITY_RANK_METRICS.map((metric) => {
    const rawValue = values[metric];
    const transformation = metric === "cognitiveCost" ? "one_minus" as const : "identity" as const;
    const transformedValue = rawValue === undefined
      ? null
      : transformation === "one_minus" ? 1 - rawValue : rawValue;
    const weight = OpportunityRankHeuristicV1.weights[metric];
    return {
      metric,
      rawValue: rawValue ?? null,
      transformedValue,
      transformation,
      weight,
      contribution: transformedValue === null ? null : transformedValue * weight,
      source: metricSources[metric],
    };
  });
  const hasAllCriticalMetrics = unknownMetrics.length === 0;
  const unboundedBaseScore = hasAllCriticalMetrics
    ? components.reduce((total, component) => total + (component.contribution as number), 0)
    : null;
  const baseScore = unboundedBaseScore === null ? null : clamp01(unboundedBaseScore);

  const recent = Array.isArray(input.recentCoverage)
    ? input.recentCoverage.slice(0, options.reuseCooldown)
    : undefined;
  const recentCoverageProvided = recent !== undefined;
  const recentCoverageSource = assertedOrLegacySource(input.recentCoverageSource, recentCoverageProvided);
  const recentSimilarity = recent === undefined
    ? null
    : recent.length > 0
      ? Math.max(...recent.map((coverage) => opportunityCoverageSimilarity(opportunity, coverage)))
      : 0;
  if (recentSimilarity === null) unknownMetrics.push("recentOverlap");
  const recentPenalty = recentSimilarity === null
    ? null
    : clamp01(recentSimilarity * options.recentPenaltyWeight);
  const finalScore = baseScore === null || recentPenalty === null
    ? null
    : Math.max(0, baseScore - recentPenalty);

  const proofability = values.proofability;
  const risk = values.risk;
  const optionsProvided = input.options !== undefined;
  const optionsSource = input.optionsSource
    ?? source(optionsProvided ? "legacy_unspecified" : "default_policy");
  // Hard reasons are STRUCTURAL only (req 5.2/5.4, design C2): a blocked status,
  // an empty topic, or no gap references. These are the sole triggers for
  // `ineligible`. The uncalibrated policy thresholds (minProofability/maxRisk)
  // are advisory ranking signals — never gates — so a low proofability or high
  // risk must NOT push a hard reason nor make a candidate ineligible here.
  const hardReasons: string[] = [];
  if (opportunity.status === "blocked") hardReasons.push("opportunity.status=blocked");
  if (!opportunity.topic.trim()) hardReasons.push("topic is empty");
  if (opportunity.gapIds.length === 0) hardReasons.push("gapIds is empty");
  // Advisory-only threshold hints: recorded as ranking/prompt inputs and surfaced
  // in `reasons`, but kept out of `hardReasons` so they never gate selectability
  // (req 5.4). `policy` still carries the raw thresholds as a sorting input.
  const advisoryNotes: string[] = [];
  if (proofability !== undefined && proofability < options.minProofability) {
    advisoryNotes.push(
      `proofability ${proofability.toFixed(2)} is below the advisory minProofability threshold (${options.minProofability.toFixed(2)}); ranking hint only, not a gate`,
    );
  }
  if (risk !== undefined && risk > options.maxRisk) {
    advisoryNotes.push(
      `risk ${risk.toFixed(2)} is above the advisory maxRisk threshold (${options.maxRisk.toFixed(2)}); ranking hint only, not a gate`,
    );
  }
  const reviewReasons: string[] = [];
  if (opportunity.status === "unknown") reviewReasons.push("opportunity.status is unknown");
  if (unknownMetrics.length > 0) reviewReasons.push(`unknown ranking inputs: ${unknownMetrics.join(", ")}`);
  const untraceableMetricSources = OPPORTUNITY_RANK_METRICS.filter((metric) =>
    metricSources[metric].source === "legacy_unspecified" || metricSources[metric].source === "unknown",
  );
  if (untraceableMetricSources.length > 0) {
    reviewReasons.push(`untraceable metric sources: ${untraceableMetricSources.join(", ")}`);
  }
  if (recentCoverageSource.source === "legacy_unspecified" || recentCoverageSource.source === "unknown") {
    reviewReasons.push("recentCoverage source is untraceable");
  }
  if (optionsSource.source === "legacy_unspecified" || optionsSource.source === "unknown") {
    reviewReasons.push("ranking options source is untraceable");
  }
  const effectiveEligibility: OpportunityRankEffectiveEligibility = hardReasons.length > 0
    ? "ineligible"
    : reviewReasons.length > 0
      ? "review_required"
      : "eligible";

  const persistedOpportunity = structuredClone(opportunity);
  for (const metric of OPPORTUNITY_RANK_METRICS) {
    if (values[metric] === undefined) delete persistedOpportunity[metric];
  }
  if (persistedOpportunity.score !== undefined && !Number.isFinite(persistedOpportunity.score)) {
    delete persistedOpportunity.score;
  }
  const policy: OpportunityRankPolicySnapshot = {
    minProofability: options.minProofability,
    maxRisk: options.maxRisk,
    recentPenaltyWeight: options.recentPenaltyWeight,
    reuseCooldown: options.reuseCooldown,
  };
  const result: Omit<RankedTopicOpportunity, "rank"> = {
    opportunity: persistedOpportunity,
    heuristic: OpportunityRankHeuristicV1,
    components,
    inputSources: {
      metrics: metricSources,
      status: assertedOrLegacySource(opportunity.rankInputSources?.status, true),
      topic: assertedOrLegacySource(opportunity.rankInputSources?.topic, opportunity.topic.trim().length > 0),
      gapIds: assertedOrLegacySource(opportunity.rankInputSources?.gapIds, opportunity.gapIds.length > 0),
      recentCoverage: recentCoverageSource,
      options: optionsSource,
    },
    unknownMetrics,
    reviewRequired: effectiveEligibility === "review_required",
    reviewReasons,
    effectiveEligibility,
    advisoryNotes,
    unboundedBaseScore,
    baseScore,
    recentPenalty,
    finalScore,
    scoreSemantics: "ordinal_noncausal_heuristic",
    policy,
    recentCoverage: {
      status: recentCoverageProvided ? "provided" : "unknown",
      count: recent ? recent.length : null,
      similarity: recentSimilarity,
      source: recentCoverageSource,
    },
    reasons: [
      ...hardReasons,
      ...reviewReasons,
      ...advisoryNotes,
      ...(proofability === undefined ? [] : [`proofability=${proofability.toFixed(2)}`]),
      ...(values.decisionLeverage === undefined ? [] : [`decisionLeverage=${values.decisionLeverage.toFixed(2)}`]),
      ...(recentSimilarity === null ? [] : [`recentOverlap=${recentSimilarity.toFixed(2)}`]),
    ],
  };
  if (typeof opportunity.score === "number" && Number.isFinite(opportunity.score)) {
    result.legacyInputScore = { value: opportunity.score, used: false, semantics: "legacy_heuristic" };
  }
  return result;
}

/** Rank with OpportunityRankHeuristicV1; never substitutes numeric values for unknown inputs. */
export function rankTopicOpportunities(input: RankTopicOpportunitiesInput): RankedTopicOpportunity[] {
  const options = resolvedOptions(input.options);
  const eligibilityOrder: Record<OpportunityRankEffectiveEligibility, number> = {
    eligible: 0,
    review_required: 1,
    ineligible: 2,
  };
  const evaluated = input.opportunities
    .map((opportunity) => evaluateOpportunity(opportunity, input, options))
    .sort((left, right) => {
      const eligibilityDifference = eligibilityOrder[left.effectiveEligibility] - eligibilityOrder[right.effectiveEligibility];
      if (eligibilityDifference !== 0) return eligibilityDifference;
      if (left.finalScore !== null && right.finalScore !== null && left.finalScore !== right.finalScore) {
        return right.finalScore - left.finalScore;
      }
      return left.opportunity.id.localeCompare(right.opportunity.id);
    });
  let eligibleRank = 0;
  return evaluated.map((result) => ({
    ...result,
    rank: result.effectiveEligibility === "eligible" ? ++eligibleRank : null,
  }));
}

const STRATEGIES: ExpressionStrategy[] = [
  {
    id: "narrow_request",
    label: "极简求助卡",
    prototype: "narrow_request",
    openingMode: "one_specific_question",
    narrativeMode: "identity_constraint_open_question",
    bodyRole: "用一个身份线索、一个现实限制和一个窄问题建立入口，不在正文写答案清单",
    imageRole: "cover",
    commentMode: "mixed_short_social_threads",
    voice: "像临时发问，短、急但不表演",
    sequence: ["identity_cue", "immediate_constraint", "narrow_question", "short_comment_branches"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "live_moment",
    label: "现场/途中随手记",
    prototype: "live_moment",
    openingMode: "ordinary_moment",
    narrativeMode: "time_place_micro_action_open_loop",
    bodyRole: "记录一个刚发生的小事、现场摩擦和下一步，不总结方法论",
    imageRole: "scene",
    commentMode: "location_identity_process_chat",
    voice: "现场碎碎念",
    sequence: ["time_anchor", "place", "micro_action", "friction", "open_loop"],
    targetChannels: ["N.title", "N.body", "N.imageBrief", "Cref", "H"],
  },
  {
    id: "expectation_reversal",
    label: "预期反转/重新考虑",
    prototype: "expectation_reversal",
    openingMode: "unexpected_result",
    narrativeMode: "expectation_event_reversal_aftertaste",
    bodyRole: "先写原本预期，再写现场发生的反转和离开后的真实余味",
    imageRole: "scene",
    commentMode: "identity_trust_reason_followup",
    voice: "意外、半信半疑、带一点松口气",
    sequence: ["expectation", "ordinary_event", "reversal", "aftertaste", "unanswered_detail"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "process_log",
    label: "过程小日记",
    prototype: "process_log",
    openingMode: "today_observation",
    narrativeMode: "day_marker_small_observation_daily_friction",
    bodyRole: "只记录今天看见或遇到的过程细节，不把有限观察外推为普遍结论",
    imageRole: "evidence",
    commentMode: "timeline_variance_practical_chat",
    voice: "具体、有限观察、不过度总结",
    sequence: ["day_marker", "visible_observation", "daily_friction", "small_action", "what_next"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "outcome_observation",
    label: "生活验证打卡",
    prototype: "outcome_observation",
    openingMode: "small_life_feedback",
    narrativeMode: "ordinary_scene_observed_change_understatement",
    bodyRole: "用一个项目适配的普通生活动作或熟人一句话承载变化，不写项目说明书",
    imageRole: "scene",
    commentMode: "recognition_identity_route_social_reaction",
    voice: "轻松、后知后觉、少下结论",
    sequence: ["ordinary_scene", "noticed_change", "small_reaction", "understatement"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "retrospective_update",
    label: "长期反馈",
    prototype: "retrospective_update",
    openingMode: "time_elapsed",
    narrativeMode: "time_elapsed_trigger_limited_observation_remaining_issue",
    bodyRole: "交代时间跨度、为何今天想起、有限观察和仍有的普通状态",
    imageRole: "evidence",
    commentMode: "duration_doubt_identity_route_counterexample",
    voice: "回头看、克制、不写完美结局",
    sequence: ["time_elapsed", "today_trigger", "observable_change", "remaining_normality", "open_question"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "relationship_moment",
    label: "身份与生活变化",
    prototype: "relationship_moment",
    openingMode: "relationship_moment",
    narrativeMode: "identity_old_friction_relationship_feedback_new_action",
    bodyRole: "用带娃、工作、运动、旅行或合照中的一个关系瞬间承载情绪变化",
    imageRole: "scene",
    commentMode: "empathy_identity_route_practical_question",
    voice: "生活化、有情绪但不写金句",
    sequence: ["identity", "old_friction", "relationship_moment", "new_action", "quiet_aftertaste"],
    targetChannels: ["N.imageBrief", "N.title", "N.body", "Cref", "H"],
  },
  {
    id: "option_comparison",
    label: "选择中的真实纠结",
    prototype: "option_comparison",
    openingMode: "two_options_one_concern",
    narrativeMode: "what_seen_where_stuck_one_question",
    bodyRole: "只说已经比较到哪里、卡在哪个差异和想听什么真实反馈",
    imageRole: "cover",
    commentMode: "different_experiences_identity_route_caution",
    voice: "做过功课但没有定论",
    sequence: ["what_seen", "difference", "personal_priority", "one_question"],
    targetChannels: ["N.imageBrief", "N.body", "N.title", "Cref", "H"],
  },
];

function hashUnit(seed: number, salt: string): number {
  return Number.parseInt(stableHash(`${seed}:${salt}`).slice(0, 8), 16) / 0xffffffff;
}

/**
 * 评论区展示昵称词库(纯展示元数据):小红书风的食物系/动物系/心情系/状态系
 * 昵称,让读者能在界面与导出里分清"谁是谁"。只作后台展示标签——不投给
 * 模型,评论文字也不要求互相称呼。禁止机构感词(见 content.ts
 * INSTITUTIONAL_NICKNAME_TERMS)与真人感名字(姓氏、小X、阿X),避免与
 * 可追责身份混淆。
 */
export const COMMENT_NICKNAME_POOL: readonly string[] = [
  // 食物系
  "桃子气泡水", "半糖去冰", "橘子和海", "芝士乌龙", "一颗奶糖", "冰美式续杯",
  "芒果糯米饭", "盐焗开心果", "桂花酒酿圆子", "西瓜中间那勺", "焦糖布丁", "柠檬养乐多",
  "抹茶大福", "椰椰西米露", "红豆双皮奶", "葡萄冻冻", "奶茶三分甜", "烤红薯趁热",
  "草莓果酱", "酸梅汤加冰", "豆乳盒子", "海盐小饼干", "菠萝咕咾肉", "芝麻糊不糊",
  // 动物系
  "熬夜的猫", "散步的柴犬", "打盹的树懒", "圆滚滚的刺猬", "偷鱼的橘猫", "慢半拍的企鹅",
  "爱晒太阳的猫", "蹦蹦的兔子", "发呆的水豚", "捡松果的松鼠", "迷路的麋鹿", "打呼的小海豹",
  "早起的布谷鸟", "怕冷的树袋熊", "追尾巴的狗勾", "揣手手的猫", "窗台上的麻雀", "翻肚皮的猫",
  "等投喂的仓鼠", "夜跑的狐狸", "晒太阳的乌龟", "摇尾巴的柯基",
  // 心情系
  "今天也想躺平", "有点小开心", "困困的日常", "元气半格电", "心情放晴中", "偷偷期待一下",
  "纠结到打滚", "先开心了再说", "心里亮堂堂", "有点小紧张", "慢慢不焦虑", "偷着乐一会儿",
  "揣着小心愿", "脑袋放空中", "莫名很踏实", "小小的雀跃", "困并快乐着", "心里有点甜",
  "暗自鼓劲中", "松一口气了",
  // 状态系
  "蹲一个答案", "在做功课中", "攒钱买快乐", "摸鱼刷手机", "通勤路上刷到", "周末睡到自然醒",
  "下班就想躺", "咖啡续命中", "努力早睡中", "笔记记了一页", "收藏了又忘了", "正在货比三家",
  "半夜刷到的我", "洗完澡躺床上", "午休偷偷看", "排队等位中", "边吃瓜边看", "刚发工资的我",
  "备忘录记下来", "拉着闺蜜一起看", "躲在被窝里刷", "做完功课再定",
];

/**
 * 确定性昵称分配:hashUnit(seed, salt) 定位词库起点,used 内去重、命中即顺延;
 * 同种子同盐必同结果。词库耗尽(昵称需求超过词库大小)时追加序号兜底,仍确定。
 * 线程盐为 `nickname:${threadId}`,追问接话人盐为 `nickname:${threadId}:fu:${index}`,
 * 因此同一接话人在同一线程内昵称固定。
 */
export function assignCommentDisplayName(seed: number, salt: string, used: ReadonlySet<string>): string {
  const start = Math.floor(hashUnit(seed, salt) * COMMENT_NICKNAME_POOL.length) % COMMENT_NICKNAME_POOL.length;
  for (let offset = 0; offset < COMMENT_NICKNAME_POOL.length; offset += 1) {
    const candidate = COMMENT_NICKNAME_POOL[(start + offset) % COMMENT_NICKNAME_POOL.length]!;
    if (!used.has(candidate)) return candidate;
  }
  return `${COMMENT_NICKNAME_POOL[start]!}·${used.size + 1}`;
}

/**
 * 线程级互动形态(读者互动层)的确定性分配:hashUnit(seed, salt) 一次抽取,
 * 同种子同盐必同结果。不设死比例——每线程独立抽取,包内配比自然涌现;
 * 营销话头 gap(marketingTopic=true,即答复分流为助理 staff 的话题)的线程
 * org_answer 概率自然偏高,因为价格/预约等动态信息必须由可追责身份承接。
 */
export function assignCommentThreadKind(seed: number, salt: string, marketingTopic: boolean): CommentThreadKind {
  const unit = hashUnit(seed, salt);
  if (marketingTopic) return unit < 0.8 ? "org_answer" : unit < 0.97 ? "reader_exchange" : "organic_reaction";
  return unit < 0.55 ? "org_answer" : unit < 0.85 ? "reader_exchange" : "organic_reaction";
}

function strategyWeight(strategy: ExpressionStrategy, recent: CoverageSignature[], cooldown: number): number {
  const base = Math.max(0.01, strategy.selectionWeight ?? strategy.randomization?.weight ?? 1);
  const recentCount = recent.slice(0, cooldown).filter((signature) => signature.strategyId === strategy.id).length;
  return base / (1 + recentCount);
}

function weightedStrategy(
  pool: ExpressionStrategy[],
  seed: number,
  salt: string,
  recent: CoverageSignature[],
  cooldown: number,
): ExpressionStrategy {
  const weights = pool.map((strategy) => strategyWeight(strategy, recent, cooldown));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = hashUnit(seed, salt) * total;
  for (let index = 0; index < pool.length; index += 1) {
    cursor -= weights[index] ?? 0;
    if (cursor <= 0) return pool[index]!;
  }
  return pool[pool.length - 1]!;
}

function sampleExpressionStrategy(
  input: PlanTopicOrchestrationsInput,
  options: ResolvedPlanningOptions,
  candidateIndex: number,
  attempt: number,
  recent: CoverageSignature[],
): ExpressionStrategy {
  const custom = (input.expressionStrategies ?? []).filter((strategy) => strategy.enabled !== false);
  // Project-approved strategies are the complete visible pool. Built-ins are
  // defaults only, never hidden competitors once a project pool exists.
  const pool = custom.length ? custom : STRATEGIES;
  const locked = options.lockedStrategyId
    ? pool.find((strategy) => strategy.id === options.lockedStrategyId)
    : pool.find((strategy) => strategy.locked);
  if (options.lockedStrategyId && !locked) throw new Error(`Locked expression strategy does not exist: ${options.lockedStrategyId}`);
  const preferredBase = pool;
  const defaultBase = preferredBase[candidateIndex % preferredBase.length] ?? pool[0]!;
  const strategyRandomized = options.randomizationDimensions.includes("strategy") && options.variationStrength > 0;
  const base = locked ?? (strategyRandomized
    ? weightedStrategy(preferredBase, input.seeds?.[candidateIndex as 0 | 1 | 2] ?? input.seed ?? 0, `base:${attempt}`, recent, options.reuseCooldown)
    : defaultBase);
  if (locked) {
    return {
      ...locked,
      sequence: [...locked.sequence],
      targetChannels: [...locked.targetChannels],
      ...(locked.randomization ? { randomization: { ...locked.randomization } } : {}),
    };
  }
  const seed = input.seeds?.[candidateIndex as 0 | 1 | 2] ?? seedFor(input.seed ?? 0, candidateIndex);
  const sourceFor = (dimension: PlanningRandomizationDimension, salt: string): ExpressionStrategy => {
    if (!options.randomizationDimensions.includes(dimension) || options.variationStrength === 0) return base;
    if (hashUnit(seed, `gate:${dimension}:${attempt}`) > options.variationStrength) return base;
    const randomizable = pool.filter((strategy) => strategy.randomization?.enabled !== false);
    return weightedStrategy(randomizable.length ? randomizable : pool, seed, `${salt}:${attempt}`, recent, options.reuseCooldown);
  };
  const opening = sourceFor("opening", "opening");
  const narrative = sourceFor("narrative_sequence", "narrative");
  const channel = sourceFor("channel_allocation", "channel");
  const body = sourceFor("body_role", "body");
  const comments = sourceFor("comment_topology", "comments");
  const voice = sourceFor("voice", "voice");
  const image = sourceFor("image_role", "image");
  const components = [base.id, opening.id, narrative.id, channel.id, body.id, comments.id, voice.id, image.id];
  const mixed = new Set(components).size > 1;
  return {
    ...base,
    id: mixed ? `${base.id}__mix_${stableHash(components).slice(0, 8)}` : base.id,
    label: mixed ? `${base.label}（受控交叉编排）` : base.label,
    openingMode: opening.openingMode,
    narrativeMode: narrative.narrativeMode,
    sequence: [...narrative.sequence],
    targetChannels: [...channel.targetChannels],
    bodyRole: body.bodyRole,
    commentMode: comments.commentMode,
    voice: voice.voice,
    imageRole: image.imageRole,
    prototype: narrative.prototype ?? base.prototype,
  };
}

function seedFor(baseSeed: number, candidateIndex: number): number {
  return Number.parseInt(stableHash(`${baseSeed}:${candidateIndex}`).slice(0, 8), 16) & 0x7fffffff;
}

function stateSeed(
  input: PlanTopicOrchestrationsInput,
  seed: number,
  candidateIndex: number,
  options: ResolvedPlanningOptions,
): OrchestrationPlan["stateSeed"] {
  const intelligence = input.projectIntelligence;
  const varied = options.randomizationDimensions.includes("state_seed") ? options.variationStrength : 0;
  const levels = ["low", "medium", "high"] as const;
  const rangeByLevel = {
    low: [0, 0.33],
    medium: [0.34, 0.66],
    high: [0.67, 1],
  } as const;
  const variedLevel = (base: typeof levels[number], salt: string): typeof levels[number] => {
    if (varied <= 0) return base;
    const draw = hashUnit(seed, `${salt}:${candidateIndex}`);
    const shift = draw < varied * 0.25 ? -1 : draw > 1 - varied * 0.25 ? 1 : 0;
    return levels[Math.max(0, Math.min(levels.length - 1, levels.indexOf(base) + shift))]!;
  };
  const hypothesis = (base: typeof levels[number], salt: string, basis: string) => {
    const level = variedLevel(base, salt);
    return {
      level,
      range: [...rangeByLevel[level]] as [number, number],
      calibrated: false as const,
      source: "stage_heuristic" as const,
      basis,
    };
  };
  const skepticism = input.opportunity.audienceStage === "hesitating" ? "high" : input.opportunity.audienceStage === "comparing" ? "medium" : "low";
  const fatigue = input.opportunity.audienceStage === "collecting" ? "medium" : "low";
  const closureNeed = input.opportunity.audienceStage === "ready" ? "high" : "medium";
  const readerHistory = input.config.task.readerHistory;
  return {
    entry: input.opportunity.entry,
    stage: input.opportunity.audienceStage,
    preContactKnown: [...new Set(input.config.task.preContactKnown ?? [])],
    availableEvidence: intelligence?.verifiedFacts.slice(0, 5) ?? [],
    hypothesizedGaps: input.gaps.filter((gap) => input.opportunity.gapIds.includes(gap.id)).map((gap) => gap.question),
    readerConstraints: [...new Set(input.config.task.readerConstraints ?? [])],
    availableBoundaries: [...new Set([
      ...(intelligence?.hardBoundaries ?? []),
      ...input.opportunity.boundaries,
    ])],
    history: {
      status: readerHistory === undefined ? "unknown" : "provided",
      items: readerHistory === undefined ? [] : [...new Set(readerHistory)],
    },
    stateHypotheses: {
      skepticism: hypothesis(skepticism, "skepticism", `仅按已选择阶段“${input.opportunity.audienceStage}”形成的写作情景，不是心理测量。`),
      fatigue: hypothesis(fatigue, "fatigue", `仅按已选择阶段“${input.opportunity.audienceStage}”形成的写作情景，不是疲劳观测。`),
      closureNeed: hypothesis(closureNeed, "closure", `仅按已选择阶段“${input.opportunity.audienceStage}”形成的写作情景，不是人群统计。`),
    },
    status: "hypothesis",
    calibrationStatus: "unvalidated",
  };
}

const PROTOTYPE_FALLBACKS: PersonaScenePlan["prototype"][] = [
  "narrow_request", "live_moment", "expectation_reversal", "process_log",
  "outcome_observation", "retrospective_update", "relationship_moment", "option_comparison",
];

function inferPrototype(strategy: ExpressionStrategy, config: ResolvedGenerationConfig, seed: number): PersonaScenePlan["prototype"] {
  // A sampled built-in strategy is already the visible product contract. Stage
  // heuristics may classify custom/legacy strategies, but must not collapse
  // deliberately different candidates back into one prototype.
  if (strategy.prototype) return strategy.prototype;
  const text = `${strategy.id} ${strategy.label} ${strategy.openingMode} ${strategy.narrativeMode} ${strategy.bodyRole}`;
  if (/极简|求助|临时|narrow|request/iu.test(text)) return "narrow_request";
  if (/现场|途中|此刻|live|moment/iu.test(text)) return "live_moment";
  if (/反转|误区|反例|reversal|counterexample|misconception/iu.test(text)) return "expectation_reversal";
  if (/过程|记录|日记|process|log|diary/iu.test(text)) return "process_log";
  if (/长期|回访|回看|long|retrospective/iu.test(text)) return "retrospective_update";
  if (/关系|生活|状态|情绪|relationship|life/iu.test(text)) return "relationship_moment";
  if (/比较|选择|理性|清单|comparison|checklist/iu.test(text)) return "option_comparison";
  if (/验证|结果|观察|evidence|verification|result/iu.test(text)) return "outcome_observation";
  const compatibleByStage: Record<ResolvedGenerationConfig["task"]["audienceStage"], PersonaScenePlan["prototype"][]> = {
    discovering: ["narrow_request", "relationship_moment", "outcome_observation"],
    collecting: ["narrow_request", "option_comparison", "live_moment"],
    comparing: ["option_comparison", "expectation_reversal", "narrow_request"],
    hesitating: ["expectation_reversal", "narrow_request", "option_comparison"],
    ready: ["live_moment", "option_comparison", "expectation_reversal"],
  };
  const compatible = compatibleByStage[config.task.audienceStage] ?? PROTOTYPE_FALLBACKS;
  return compatible[Math.floor(hashUnit(seed, "prototype-fallback") * compatible.length)]!;
}

function surfaceTargets(prototype: PersonaScenePlan["prototype"]): PersonaScenePlan["surfaceTargets"] {
  const targets: Record<PersonaScenePlan["prototype"], PersonaScenePlan["surfaceTargets"]> = {
    narrow_request: { titleChars: [4, 14], bodyChars: [25, 70], bodyParagraphs: [1, 2], visibleCommentLines: [7, 13], typicalCommentChars: [4, 24] },
    live_moment: { titleChars: [1, 12], bodyChars: [25, 105], bodyParagraphs: [1, 3], visibleCommentLines: [6, 13], typicalCommentChars: [4, 26] },
    expectation_reversal: { titleChars: [6, 18], bodyChars: [60, 155], bodyParagraphs: [1, 3], visibleCommentLines: [6, 12], typicalCommentChars: [4, 28] },
    process_log: { titleChars: [1, 14], bodyChars: [45, 145], bodyParagraphs: [1, 4], visibleCommentLines: [7, 15], typicalCommentChars: [4, 30] },
    outcome_observation: { titleChars: [1, 14], bodyChars: [15, 95], bodyParagraphs: [1, 3], visibleCommentLines: [6, 13], typicalCommentChars: [3, 24] },
    retrospective_update: { titleChars: [1, 16], bodyChars: [80, 220], bodyParagraphs: [2, 5], visibleCommentLines: [7, 15], typicalCommentChars: [4, 30] },
    relationship_moment: { titleChars: [6, 18], bodyChars: [90, 220], bodyParagraphs: [2, 5], visibleCommentLines: [6, 14], typicalCommentChars: [4, 28] },
    option_comparison: { titleChars: [5, 18], bodyChars: [45, 145], bodyParagraphs: [1, 4], visibleCommentLines: [6, 12], typicalCommentChars: [4, 30] },
  };
  return targets[prototype];
}

/**
 * Persona-scene plan (commentCast / commentNetwork / surfaceTargets / crossChannelRules).
 *
 * M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: classification = 部分(a) + (b) →
 * REQUIRED (必需保留), NOT downgraded by tasks 7.1–7.3.
 *  - (a) traceable evidence: commentCast/commentNetwork are derived from the *approved*
 *    projectBlueprint (role_model / scenario_model / surface_language), so they are partly
 *    evidence-backed rather than invented.
 *  - (b) documented creative value: cross-channel consistency, the anti-sales-script rules,
 *    and role grounding ("a role only says what its social position could know") each have a
 *    recorded rationale.
 * 需求 7.7 guard: this is a load-bearing mechanism. Its commentCast/commentNetwork/
 * surfaceTargets are fed straight into the staged comment prompt (see prompt.ts) and anchor
 * structural-validity/safety checks in content.ts (role grounding, cross-channel identity,
 * surface-shape targets). Making it non-required would break valid output and the pipeline,
 * so it stays mandatory in formal generation.
 */
function buildPersonaScenePlan(
  strategy: ExpressionStrategy,
  opportunity: TopicOpportunity,
  config: ResolvedGenerationConfig,
  seed: number,
  blueprint?: ProjectCreativeBlueprint,
): PersonaScenePlan {
  const prototype = inferPrototype(strategy, config, seed);
  const constraints = config.task.readerConstraints ?? [];
  const stageText: Record<TopicOpportunity["audienceStage"], string> = {
    discovering: "刚发现问题，第一次认真看相关内容",
    collecting: "已经刷过一些内容，正在收集真实细节",
    comparing: "手里有两三个选择，正卡在具体差异",
    hesitating: "已经有倾向，但仍担心风险或选错",
    ready: "准备采取下一步行动，问题已经很具体",
  };
  const identityByPrototype: Record<PersonaScenePlan["prototype"], string[]> = {
    narrow_request: ["第一次认真做功课的人", "现实安排有限、想先问清楚的人"],
    live_moment: ["正在经历当前流程的人", "刚遇到一个现场小插曲的人"],
    expectation_reversal: ["原本做好行动准备的人", "预期刚被新信息改变的人"],
    process_log: ["正在记录过程的人", "同时要兼顾日常安排的人"],
    outcome_observation: ["在普通生活中注意到变化的人", "顺手记录有限观察的人"],
    retrospective_update: ["隔了一段时间回头看的人", "长期观察后才愿意更新的人"],
    relationship_moment: ["在关系场景里重新注意到这件事的人", "生活安排占据大部分时间的人"],
    option_comparison: ["已经看过不少资料的人", "在多个选择之间犹豫的人"],
  };
  const lifeByPrototype: Record<PersonaScenePlan["prototype"], string> = {
    narrow_request: "临近安排让一个问题突然变得紧迫",
    live_moment: "等待、移动或现场时间构成这一条记录",
    expectation_reversal: "原计划与新得到的信息发生反差",
    process_log: "当前过程与日常安排互相牵扯",
    outcome_observation: "变化在一个普通生活瞬间被看见",
    retrospective_update: "时间过去后从旧记录或普通一天回头看",
    relationship_moment: "变化通过关系、生活安排或自己的新动作被感知",
    option_comparison: "功课已经做了一部分，但一个关键差异仍没想清",
  };
  const eventByPrototype: Record<PersonaScenePlan["prototype"], Omit<PersonaScenePlan["event"], "openLoop">> = {
    narrow_request: { timeAnchor: "最近", setting: "查看信息或安排下一步时", trigger: "发现现实时间或条件不够", observableAction: "停下来发一个具体问题", friction: "担心影响日常安排", emotionalAftertaste: "有点急，也怕听到夸张答案", imageMoment: "与当前困扰直接相关的求助素材" },
    live_moment: { timeAnchor: "刚刚或正在发生", setting: "当前流程或移动途中", trigger: "现场发生一个计划外的小插曲", observableAction: "拍下眼前信息或顺手记一句", friction: "等待、迟到或时间被占用", emotionalAftertaste: "紧张里带一点吐槽或期待", imageMoment: "能证明当前场景的现场素材" },
    expectation_reversal: { timeAnchor: "刚得到新信息后", setting: "当前流程结束后的空档", trigger: "得到与预期不同的判断", observableAction: "回想一句话或一个细节", friction: "原计划被打断", emotionalAftertaste: "意外或重新犹豫", imageMoment: "与这次反差直接相关的现场素材" },
    process_log: { timeAnchor: "过程中的某一天", setting: "处理日常事务时", trigger: "今天出现一个具体变化", observableAction: "记录可见信息或一个动作", friction: "部分生活安排暂时不方便", emotionalAftertaste: "只说今天，不推断长期结果", imageMoment: "同一时间条件下的过程记录" },
    outcome_observation: { timeAnchor: "最近一次普通生活瞬间", setting: "工作、通勤、休闲或社交时", trigger: "自己或熟人无意间注意到变化", observableAction: "顺手补一条记录", friction: "过去在相同场景里有过顾虑", emotionalAftertaste: "后知后觉，不上价值", imageMoment: "与观察发生时一致的生活素材" },
    retrospective_update: { timeAnchor: "一段时间后", setting: "翻旧记录或被人问起时", trigger: "发现时间已经过去一段", observableAction: "补一条当前状态", friction: "仍存在普通波动或未解决问题", emotionalAftertaste: "不把个人观察说成所有人结论", imageMoment: "当前记录与旧记录分开呈现" },
    relationship_moment: { timeAnchor: "一个普通关系瞬间", setting: "工作、家庭、运动、出行或社交时", trigger: "别人一句话或自己一个新动作", observableAction: "改变一个过去反复回避的动作", friction: "过去在同一情境下反复犹豫", emotionalAftertaste: "有一点被理解或松动的感觉", imageMoment: "关系和生活场景先于项目信息" },
    option_comparison: { timeAnchor: "最近集中做功课时", setting: "看资料、问人或安排下一步", trigger: "不同说法在一个关键点上对不上", observableAction: "把选择压成一个具体问题", friction: "信息多但判断口径不一致", emotionalAftertaste: "不是完全小白，也还没准备下结论", imageMoment: "候选记录或与问题直接相关的素材" },
  };
  const compatibleFamilies = (blueprint?.scenarioModel.families ?? []).filter((family) =>
    family.applicableStages.includes(opportunity.audienceStage));
  const matchingFamilies = compatibleFamilies.filter((family) => family.prototype === prototype);
  const familyPool = matchingFamilies.length ? matchingFamilies : compatibleFamilies;
  const selectedFamily = familyPool[Math.floor(hashUnit(seed, "scenario-family") * Math.max(1, familyPool.length))];
  const pick = (values: string[] | undefined, salt: string, fallback: string): string => {
    if (!values?.length) return fallback;
    return values[Math.floor(hashUnit(seed, salt) * values.length)] ?? fallback;
  };
  const identityPool = selectedFamily?.hostIdentityCues.length ? selectedFamily.hostIdentityCues : identityByPrototype[prototype];
  const identityCue = identityPool[Math.floor(hashUnit(seed, "host-identity") * identityPool.length)]!;
  const relationships = blueprint?.roleModel.roles.map((role) => role.relationToHost).filter(Boolean).length
    ? blueprint.roleModel.roles.map((role) => role.relationToHost).filter(Boolean)
    : ["与处境相近的读者", "熟悉自己的关系对象", "正在比较的其他人"];
  const relationshipAnchor = relationships[Math.floor(hashUnit(seed, "host-relation") * relationships.length)]!;
  const fallbackEvent = eventByPrototype[prototype];
  const event: Omit<PersonaScenePlan["event"], "openLoop"> = {
    timeAnchor: pick(selectedFamily?.timeAnchors, "event-time", fallbackEvent.timeAnchor),
    setting: pick(selectedFamily?.settings, "event-setting", fallbackEvent.setting),
    trigger: pick(selectedFamily?.triggers, "event-trigger", fallbackEvent.trigger),
    observableAction: pick(selectedFamily?.observableActions, "event-action", fallbackEvent.observableAction),
    friction: pick(selectedFamily?.frictions, "event-friction", fallbackEvent.friction),
    emotionalAftertaste: pick(selectedFamily?.emotionalAftertastes, "event-affect", fallbackEvent.emotionalAftertaste),
    imageMoment: pick(selectedFamily?.imageMoments, "event-image", fallbackEvent.imageMoment),
  };
  const topicQuestion = opportunity.angle || opportunity.topic;
  const registerStrength = config.parameters?.commentPlatformRegister ?? 68;
  const conversationRate = config.parameters?.commentConversationRate ?? 48;
  const branchingStrength = config.parameters?.commentBranchingStrength ?? 62;
  const organicVariation = config.parameters?.commentOrganicVariation ?? 58;
  const platformRegister: PersonaScenePlan["commentNetwork"]["platformRegister"] = registerStrength >= 72
    ? "sample_rich" : registerStrength >= 35 ? "light_platform" : "plain";
  const estimatedThreads = Math.max(1, config.content.commentThreadMax);
  // P2-11: the multi-turn target only exists when the growth pass (stage 2B) is
  // actually enabled. With the switch off the engine never grows follow-ups, so a
  // non-zero target would make comment_network_under_grown a guaranteed false
  // positive; the honest target is [0, 0].
  const growthEnabled = config.content.commentMultiTurnGrowthEnabled === true;
  const multiTurnCount = growthEnabled
    ? Math.min(
      estimatedThreads,
      config.content.followUpDepth > 0 ? Math.round(estimatedThreads * conversationRate / 100) : 0,
    )
    : 0;
  const commentNetwork: PersonaScenePlan["commentNetwork"] = {
    platformRegister,
    platformLanguageRule: platformRegister === "sample_rich"
      ? `每个角色最多自然带一处项目语言模块提供的可选语域线索；不能全员同款，也不用故意错字。可选线索：${(blueprint?.surfaceLanguage.optionalColloquialisms ?? []).join("、") || "无，保持普通口语"}。`
      : platformRegister === "light_platform"
        ? "少数角色可用一个自然称呼、语气词或行动短语，其他人保持普通口语。"
        : "使用普通互联网口语，不为制造网感强塞圈内词。",
    multiTurnTarget: growthEnabled
      ? [Math.max(0, multiTurnCount - 1), Math.min(estimatedThreads, multiTurnCount + 1)]
      : [0, 0],
    branchMoves: branchingStrength >= 70
      ? ["上一句的现实限制→安排问题", "可见细节→相邻追问", "对象线索→核验路径", "不同选择→适用条件"]
      : ["围绕原问题补一个条件", "从回答中的一个词继续追问"],
    organicMoves: organicVariation >= 70
      ? ["几个字的共鸣", "不完全同意楼上", "看图后才注意到的细节", "轻微岔开的生活反应", "暂时没被回答的短问"]
      : ["一条自然共鸣", "一条不同意见"],
    antiScriptRules: [
      "不能按提问—背书—给路由—催促行动的整齐顺序排成销售漏斗。",
      "不能让所有人同向夸赞、使用同一称呼或拥有相同知识水平。",
      "流行词只负责暴露身份和关系，不能代替信息，也不能每句都出现。",
      "专业信息由可追责身份回答；普通角色只能说其位置能知道的部分。",
      "允许公开助理身份（机构名+助理）直接承接价格、预约、地址、活动类问题；其中价格、数字与承诺类表述必须能锚定知识库，锚定不到就说明需人工确认，不编具体数字。",
    ],
  };
  const fallbackCommentCast: PersonaScenePlan["commentCast"] = [
    { displayRole: "处境相近者", relationToHost: "从正文认出相似处境", identityCue: "处在相近阶段", situationCue: "带着一个现实限制", motive: "确认最卡的一点", knowledgePosition: "只知道正文公开的信息", speechPattern: "短句，处境和问题连在一起", lexicalCues: [], interactionHook: "补一个会改变答案的条件", permittedContribution: "一个窄问题或同款担心", utteranceMode: "shared_concern", targetChars: [4, 26], replyDisplayRole: "发布者" },
    { displayRole: "谨慎比较者", relationToHost: "选择标准与发布者不同", identityCue: "仍在比较", situationCue: "对统一答案保持怀疑", motive: "补充反例或条件", knowledgePosition: "不声称未提供的经历或结果", speechPattern: "先说不同意见，再落到自己的条件", lexicalCues: [], interactionHook: "让上一位补充适用条件", permittedContribution: "一个反例或不同优先级", utteranceMode: "counterexample", targetChars: [6, 32], replyDisplayRole: "发布者/前一位" },
    { displayRole: "可追责信息提供者", relationToHost: "在必要时解释已核验信息", identityCue: "公开透明的项目身份", situationCue: "把一个条件翻译成日常语言", motive: "纠正误解而非催促行动", knowledgePosition: "只使用已核验项目知识，未知保持未知", speechPattern: "一句直接说明加一个必要条件", lexicalCues: [], interactionHook: "条件差异允许其他人继续补充", permittedContribution: "已核验说明或必要澄清", utteranceMode: "knowledge_translation", targetChars: [8, 40], replyDisplayRole: "项目账号" },
  ];
  const projectRoles = blueprint?.roleModel.roles ?? [];
  const commentCast: PersonaScenePlan["commentCast"] = projectRoles.length ? projectRoles.map((role) => ({
    displayRole: role.displayRole,
    relationToHost: role.relationToHost,
    identityCue: pick(role.identityCues, `role-identity:${role.id}`, role.displayRole),
    situationCue: pick(role.situationCues, `role-situation:${role.id}`, "围绕当前话题开口"),
    motive: pick(role.motives, `role-motive:${role.id}`, "补充一个真实信息需求"),
    knowledgePosition: role.knowledgePosition,
    speechPattern: pick(role.speechPatterns, `role-speech:${role.id}`, "自然短句，不复述后台字段"),
    lexicalCues: [...role.lexicalCues],
    interactionHook: pick(role.interactionHooks, `role-hook:${role.id}`, "留下一个可自然接话的具体词"),
    permittedContribution: pick(role.permittedContributions, `role-contribution:${role.id}`, "只贡献其社会位置能够知道的信息"),
    utteranceMode: role.utteranceModes[Math.floor(hashUnit(seed, `role-mode:${role.id}`) * Math.max(1, role.utteranceModes.length))] ?? "direct_question",
    targetChars: role.targetChars,
    replyDisplayRole: pick(role.replyDisplayRoles, `role-reply:${role.id}`, "发布者"),
    // 机构侧角色(accountable:机构 IP / 公开助理)标记后只能答复,不能坐读者席。
    ...(role.accountable ? { orgSide: true } : {}),
  })) : fallbackCommentCast;
  return {
    scenarioFamilyId: selectedFamily?.id ?? `generic_${prototype}`,
    prototype,
    host: {
      identityCue,
      lifeContext: pick(selectedFamily?.lifeContexts, "life-context", lifeByPrototype[prototype]),
      localityCue: config.task.city ? `地点线索只使用已提供的${config.task.city}` : "没有地点输入时不硬编地点",
      currentStage: stageText[opportunity.audienceStage],
      immediateConstraint: constraints[0] ?? event.friction,
      relationshipAnchor,
      affect: event.emotionalAftertaste,
      motive: `围绕“${topicQuestion}”只推进一步`,
      voiceTraits: [strategy.voice, ...(blueprint?.roleModel.hostVoiceTraits ?? []), "像手机上顺手发的", "允许半句话和自然停顿", "不写论文式总结"],
      speechMarkers: [...(blueprint?.roleModel.hostSpeechMarkers ?? []), "具体时间或动作", "一个现实摩擦", "有限观察", "未完问题"],
      knowledgeBoundary: blueprint?.audienceModel.states.find((state) => state.stages.includes(opportunity.audienceStage))?.knowledgeState
        ?? "叙述者只知道当前场景与项目资料允许的内容，不突然变成全知讲解者",
      status: "creative_scenario",
    },
    event: { ...event, openLoop: `把“${topicQuestion}”留下一个可以在评论里自然接住的窄分支` },
    commentCast,
    commentNetwork,
    surfaceTargets: surfaceTargets(prototype),
    crossChannelRules: [
      "图片、标题、正文和楼主回复必须是同一个人、同一个时间阶段和同一件事。",
      "内部Stage/Gap/Evidence标签不得出现在可见文字里。",
      "评论角色只说其位置能够知道的部分，不把每个人都写成完整专家。",
      "允许短反应、未回复评论和条件冲突；不要把所有线程写成对称FAQ。",
      "项目事实来自知识库；生活场景是创作载体，不能反过来充当项目证据。",
    ],
    sampleBasis: blueprint
      ? `项目创作模型 ${blueprint.sourceFingerprint.slice(0, 12)} 的已审核场景、角色与语言模块。`
      : "行业中立的测试降级结构；正式生成要求已审核项目创作模型。",
  };
}

function chooseImage(
  role: ImageAssetRole,
  opportunity: TopicOpportunity,
  analyses: ImageAssetAnalysis[],
): ImageAssetAnalysis | undefined {
  const eligible = analyses.filter((analysis) =>
    analysis.safetyFlags.length === 0
    && (opportunity.imageAssetIds.length === 0 || opportunity.imageAssetIds.includes(analysis.assetId)),
  );
  return [...eligible].sort((left, right) => {
    const leftRole = left.roles.includes(role) ? 1 : 0;
    const rightRole = right.roles.includes(role) ? 1 : 0;
    const leftQuality = clamp01(left.quality.relevance) + clamp01(left.quality.clarity);
    const rightQuality = clamp01(right.quality.relevance) + clamp01(right.quality.clarity);
    return rightRole - leftRole || rightQuality - leftQuality || left.assetId.localeCompare(right.assetId);
  })[0];
}

function buildImagePlan(
  strategy: ExpressionStrategy,
  opportunity: TopicOpportunity,
  analyses: ImageAssetAnalysis[],
  personaScenePlan: PersonaScenePlan,
): ImagePlan {
  const asset = chooseImage(strategy.imageRole, opportunity, analyses);
  const frameByPrototype: Record<PersonaScenePlan["prototype"], string[]> = {
    narrow_request: ["与窄问题直接相关的求助素材", "画面只交代困扰与现实限制"],
    live_moment: ["当前流程或现场素材", "一个能说明正在发生什么的细节"],
    expectation_reversal: ["与预期变化直接相关的素材", "反转只由正文交代，不伪造结论画面"],
    process_log: ["同一时间条件下的自然记录", "保留普通生活背景"],
    outcome_observation: ["观察发生时的生活素材", "让变化从场景里被看见"],
    retrospective_update: ["当前自然记录", "必要时单独附旧记录，不做夸张拼接"],
    relationship_moment: ["能体现关系与生活身份的素材", "关系和动作比项目字样更重要"],
    option_comparison: ["候选记录或真实素材", "只放一个核心纠结，不堆检查清单"],
  };
  return {
    sourceAssetId: asset?.assetId,
    primaryAssetId: asset?.assetId,
    role: strategy.imageRole,
    coverText: personaScenePlan.prototype === "narrow_request" || personaScenePlan.prototype === "option_comparison"
      ? opportunity.topic
      : undefined,
    frames: frameByPrototype[personaScenePlan.prototype],
    composition: asset
      ? `以素材 ${asset.assetId} 为主视觉，只把 observedFacts 当作可见事实。`
      : `${personaScenePlan.event.imageMoment}。保持手机随手记录感、普通光线和生活环境；不要自动排成信息海报、行业示意图或夸张前后对比。`,
    altText: asset?.altText ?? `${opportunity.topic}：${strategy.label}`,
    evidenceIds: [...new Set([...(asset?.evidenceIds ?? []), ...opportunity.evidenceIds])],
    boundaries: [...new Set([...opportunity.boundaries, ...(asset?.unknowns ?? []), ...(asset?.safetyFlags ?? [])])],
  };
}

function gapPriority(gap: InformationGap): InformationGapPlanningCard["priority"] {
  if (gap.required) return "required";
  if (Boolean(gap.boundary) || gap.decisionLeverage >= 0.7 || gap.importance >= 0.8) return "high";
  return "standard";
}

function orderGaps(gaps: InformationGap[]): InformationGap[] {
  return [...gaps].sort((left, right) =>
    Number(right.required) - Number(left.required)
    || right.decisionLeverage - left.decisionLeverage
    || right.importance - left.importance
    || left.id.localeCompare(right.id),
  );
}

/** Build the single canonical gap/placement object used by every planning stage. */
function makeGapPlanningCards(
  opportunity: TopicOpportunity,
  gaps: InformationGap[],
  strategy: ExpressionStrategy,
  commentsEnabled: boolean,
): InformationGapPlanningCard[] {
  const relevant = orderGaps(gaps.filter((gap) => opportunity.gapIds.includes(gap.id)));
  const critical = relevant.filter((gap) => gap.required);
  const residual = relevant.filter((gap) => !critical.some((item) => item.id === gap.id));
  const bodyIds = new Set(critical.map((gap) => gap.id));
  const bodyResidual = commentsEnabled ? residual.slice(0, 1) : residual;
  const commentResidual = commentsEnabled ? residual.slice(1) : [];
  bodyResidual.forEach((gap) => bodyIds.add(gap.id));
  if (relevant[0]) bodyIds.add(relevant[0].id);
  if (!commentsEnabled) relevant.forEach((gap) => bodyIds.add(gap.id));
  const commentIds = new Set(commentsEnabled ? commentResidual.map((gap) => gap.id) : []);
  if (commentsEnabled) {
    // A required unresolved gap may be stated once in the body as the post's
    // open loop. Do not duplicate every unknown into comments; comments own
    // only their residual gaps or an explicitly preferred channel.
    for (const gap of relevant) {
      if (gap.preferredChannels?.includes("N.body")) bodyIds.add(gap.id);
      if (gap.preferredChannels?.includes("Cref")) commentIds.add(gap.id);
    }
    // If comments are enabled and requested, keep at least one thread anchored
    // to a real gap instead of generating a topology-only comment.
    if (commentIds.size === 0 && relevant[0]) commentIds.add(relevant[0].id);
  }
  return relevant.map((gap) => ({
    gapId: gap.id,
    label: gap.label,
    question: gap.question,
    category: gap.category,
    audienceStages: [...gap.audienceStages],
    importance: gap.importance,
    decisionLeverage: gap.decisionLeverage,
    proofability: gap.proofability,
    required: gap.required,
    priority: gapPriority(gap),
    ...(gap.answer ? { answer: gap.answer } : {}),
    ...(gap.framework ? { framework: gap.framework } : {}),
    ...(gap.boundary ? { boundary: gap.boundary } : {}),
    evidenceIds: [...gap.evidenceIds],
    plannedPlacements: CHANNELS.filter((channel) =>
      (channel === "N.body" && bodyIds.has(gap.id))
      || (channel === "Cref" && commentIds.has(gap.id)),
    ),
  }));
}

/** Render legacy channel tokens from the canonical cards. Never assign gaps here. */
function renderChannelAllocation(
  opportunity: TopicOpportunity,
  cards: InformationGapPlanningCard[],
  strategy: ExpressionStrategy,
  commentsEnabled: boolean,
): Record<ContentChannel, string[]> {
  const strategyBody = [
    `prototype:${strategy.prototype ?? "derived"}`,
    "structure:human-carrier",
    "structure:ordinary-event",
    "structure:one-narrow-open-loop",
  ];
  return {
    H: [`topic:${opportunity.topic}`, ...opportunity.tags.map((tag) => `tag:${tag}`)],
    "N.imageBrief": [`image-role:${strategy.imageRole}`, `angle:${opportunity.angle}`],
    "N.title": [`opening:${strategy.openingMode}`, `topic:${opportunity.topic}`],
    "N.body": [...new Set([
      ...cards.filter((card) => card.plannedPlacements.includes("N.body")).map((card) => `gap:${card.gapId}`),
      ...cards.filter((card) => card.plannedPlacements.includes("N.body") && card.boundary).map((card) => `boundary:${card.boundary}`),
      ...opportunity.boundaries.map((boundary) => `boundary:${boundary}`),
      ...strategyBody,
      `body-role:${strategy.bodyRole}`,
    ])],
    Cref: commentsEnabled
      ? [...new Set([
        ...cards.filter((card) => card.plannedPlacements.includes("Cref")).map((card) => `gap:${card.gapId}`),
        `topology:${strategy.commentMode}`,
      ])]
      : [],
  };
}

/**
 * dialoguePlans / dialogueThreads (thread structure, primaryGapId, auxiliaryGapIds, replyPlan,
 * and the now-optional discoveryPlan/densityProxy/conversationPlan sub-fields).
 *
 * M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: classification = 部分(a) + (b) →
 * REQUIRED (必需保留), NOT downgraded by tasks 7.1–7.3.
 *  - (a) traceable evidence: each thread's gaps come from approved information gaps.
 *  - (b) documented creative value: threads route gaps into the gapCoverageLedger so required
 *    gaps are not silently dropped.
 * 需求 7.7 guard: the thread *structure* is load-bearing — it produces the comment surface and
 * feeds buildGapCoverageLedger; without it the coverage ledger and the comment network
 * collapse, so it stays required. Per-field rulings for the optional sub-fields (replyPlan =
 * (b)/warning, discoveryPlan = (c)→optional, densityProxy = (c)→optional audit, conversationPlan
 * = derived/non-required) are recorded inline at their construction sites below.
 */
/**
 * P3-15: fallback dialogic function of a thread, derived from the gap card's
 * content instead of the old positional `functionCycle` rotation. The card's
 * answer state decides what the exchange is *for*:
 * - grounded answer (answer/framework plus evidence) → "verification"（核验适用条件）
 * - required card without an answer → "next_step"（必须指向一个核验动作）
 * - anything else → "clarify"
 * When the strategy's commentMode allows a counterexample, exactly one thread per
 * plan (the first "clarify" slot) is promoted to "counterexample", so the mode is
 * represented without re-introducing positional rotation. A model-stated function
 * from the staged schema overrides this fallback at bind time when it is a legal
 * enum value; illegal values silently fall back to this derivation.
 */
function deriveThreadFunction(
  gap: InformationGapPlanningCard,
  counterexampleAvailable: boolean,
): DialogueThreadPlan["function"] {
  const grounded = Boolean((gap.answer ?? gap.framework) && gap.evidenceIds.length > 0);
  const derived: DialogueThreadPlan["function"] = grounded
    ? "verification"
    : gap.required ? "next_step" : "clarify";
  return counterexampleAvailable && derived === "clarify" ? "counterexample" : derived;
}

/**
 * P3-17: per-thread nextStep derived from the gap card, replacing the old binary
 * constant. Three branches: grounded answer + evidence → verify against the
 * sources; no answer but a verifiable subject (question/label, optionally a
 * boundary) → a concrete "verify X with the accountable channel" step phrased in
 * natural language (never raw field names); no usable information at all → the
 * conservative "supply sources first" fallback.
 */
function deriveThreadNextStep(gap: InformationGapPlanningCard): string {
  const grounded = Boolean((gap.answer ?? gap.framework) && gap.evidenceIds.length > 0);
  if (grounded) return "按证据来源核验自己的适用条件";
  const subject = (gap.question || gap.label).trim();
  if (subject) {
    const base = `向项目方可追责渠道核实“${subject}”`;
    return gap.boundary?.trim() ? `${base}，尤其确认${gap.boundary.trim()}` : base;
  }
  return "先补充可信来源，再形成结论";
}

/**
 * 三身份生态合规护栏(强制,不给 AI 自由):gap 命中这些 claimType 的受控声明
 * 规则时,答复身份必须是公开助理(staff)——价格/地点/档期类动态营销信息只
 * 允许助理按口径承接。
 */
export const STAFF_GUARD_CLAIM_TYPES: ReadonlySet<ProjectClaimRule["claimType"]> = new Set([
  "price", "location", "schedule",
]);

/**
 * AI 身份分配失败/非法时的确定性兜底表:命中这些 claimType 的话头属专业解
 * 答(资质/效果/适用/因果/身份),兜底给机构 IP(expert);其余兜底给发布账号
 * (publisher,方法论 ROLE 04 的可追责答复方)。
 */
export const EXPERT_FALLBACK_CLAIM_TYPES: ReadonlySet<ProjectClaimRule["claimType"]> = new Set([
  "credential", "outcome", "suitability", "causality", "identity",
]);

/** gap 文本(label+question)是否命中指定 claimType 集合的规则术语。 */
function gapHitsClaimTypes(
  gap: Pick<InformationGapPlanningCard, "label" | "question">,
  claimRules: Pick<ProjectClaimRule, "claimType" | "terms">[],
  claimTypes: ReadonlySet<ProjectClaimRule["claimType"]>,
): boolean {
  const topic = `${gap.label}\n${gap.question}`;
  return claimRules.some((rule) =>
    claimTypes.has(rule.claimType)
    && rule.terms.some((term) => term && topic.includes(term)));
}

/** 合规护栏:命中 price/location/schedule 的 gap 必须 staff(营销承接)。 */
export function isStaffGuardedGap(
  gap: Pick<InformationGapPlanningCard, "label" | "question">,
  claimRules: Pick<ProjectClaimRule, "claimType" | "terms">[] = [],
): boolean {
  return gapHitsClaimTypes(gap, claimRules, STAFF_GUARD_CLAIM_TYPES);
}

/**
 * 三身份生态答复身份的确定性兜底表(规划层先按它生成计划,引擎阶段 2 再用
 * AI 分配结果覆盖——护栏线程除外):护栏命中 → staff;专业类 claimType 命中
 * → expert(机构 IP 专业解答);其余 → publisher(发布账号本人作答)。不再做
 * 关键词硬匹配路由(身份理解交给 AI,确定性只做护栏与兜底)。纯函数。
 */
export function routeReplyPostingIdentity(
  gap: Pick<InformationGapPlanningCard, "label" | "question">,
  claimRules: Pick<ProjectClaimRule, "claimType" | "terms">[] = [],
): "publisher" | "staff" | "expert" {
  if (isStaffGuardedGap(gap, claimRules)) return "staff";
  if (gapHitsClaimTypes(gap, claimRules, EXPERT_FALLBACK_CLAIM_TYPES)) return "expert";
  return "publisher";
}

/** 三身份生态的答复身份(楼主/机构助理/机构 IP)。 */
export type ReplyPostingIdentity = ReturnType<typeof routeReplyPostingIdentity>;

/**
 * replyDisplayRole 逐身份强制(根治 host_account/assistant_account/发布者 内部
 * id 直出):staff→resolveAssistantReplyDisplayRole(缺省角色池 service_answer,
 * 最后兜"项目助理");expert→resolveIpDisplayRole(缺省"机构 IP");publisher→"楼主"。
 */
export function forcedReplyDisplayRole(
  identity: ReplyPostingIdentity,
  blueprint?: ProjectCreativeBlueprint,
  cast: CommentSurfaceRoleCard[] = [],
): string {
  if (identity === "staff") {
    return resolveAssistantReplyDisplayRole(blueprint)
      ?? cast.find((role) => role.utteranceMode === "service_answer")?.displayRole
      ?? "项目助理";
  }
  if (identity === "expert") return resolveIpDisplayRole(blueprint) ?? "机构 IP";
  return "楼主";
}

/** AI 答复身份分配的输出 schema(轻量自定义 JSON;不纳入 prompt contract digest)。 */
export const REPLY_IDENTITY_ASSIGNMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "identity", "reason"],
        properties: {
          id: { type: "string" },
          identity: { enum: ["publisher", "staff", "expert"] },
          reason: { type: "string" },
        },
      },
    },
  },
};

/** AI 答复身份分配的输入数据(装配:线程清单 + claimType 命中 + 口径有无 + 护栏标记)。 */
export interface ReplyIdentityAssignmentBrief {
  三身份职责: Record<"publisher" | "staff" | "expert", string>;
  分布要求: string[];
  线程清单: Array<{
    id: string;
    threadKind: CommentThreadKind;
    gap标签: string;
    gap问题: string;
    claimType命中: string[];
    口径: "有证据口径" | "无证据口径";
    护栏: "必须助理(staff)" | null;
  }>;
}

/** 装配 AI 答复身份分配的输入(纯函数;模型调用由引擎发起)。 */
export function buildReplyIdentityAssignmentBrief(
  dialogueThreads: DialogueThreadPlan[],
  gapCards: InformationGapPlanningCard[],
  claimRules: ProjectClaimRule[],
): ReplyIdentityAssignmentBrief {
  const gapCardById = new Map(gapCards.map((card) => [card.gapId, card]));
  return {
    三身份职责: {
      publisher: "发布账号本人(方法论 ROLE 04,可追责答复方):以真实发布身份给直接回答、适用条件、反例和下一步;延续帖子语气,但不冒充独立消费者、不讲亲历效果。正文细节类与需要发布方给结论的话头归此路。",
      staff: "机构工作人员:营销承接——价格、地址、预约、优惠、档期类动态信息与到店动作;按口径承接,没有口径转专人确认。",
      expert: "机构专业人员:专业解答——疼痛、恢复、适用、风险、资质、效果类问题;引用口径并带限定,不营销、不催促、不报价。",
    },
    分布要求: [
      "专业解答类话头给 expert,营销承接类话头给 staff,需要发布方给结论或延续正文的话头给 publisher",
      "三个身份尽量齐备,同一身份不得包揽全部线程",
      "护栏标记为“必须工作人员(staff)”的线程不可改派",
      "任何身份答项目事实都必须落在该线程口径上;落不上就保留未知并给核验方式,不得由任何身份编造",
    ],
    线程清单: dialogueThreads.map((thread) => {
      const gap = gapCardById.get(thread.primaryGapId);
      const topic = `${gap?.label ?? ""}\n${gap?.question ?? ""}`;
      return {
        id: thread.id,
        threadKind: thread.threadKind ?? "org_answer",
        gap标签: gap?.label ?? thread.primaryGapId,
        gap问题: gap?.question ?? "",
        claimType命中: [...new Set(claimRules
          .filter((rule) => rule.terms.some((term) => term && topic.includes(term)))
          .map((rule) => rule.claimType))],
        口径: (gap?.evidenceIds.length ?? 0) > 0 ? "有证据口径" as const : "无证据口径" as const,
        护栏: isStaffGuardedGap({ label: gap?.label ?? "", question: gap?.question ?? "" }, claimRules) ? "必须助理(staff)" as const : null,
      };
    }),
  };
}

export interface ReplyIdentityAssignment {
  id: string;
  identity: ReplyPostingIdentity;
  reason: string;
}

/** 解析 AI 答复身份分配输出;拿不到合法 assignments 结构时抛错(调用方整体回落兜底表)。 */
export function parseReplyIdentityAssignments(text: string): ReplyIdentityAssignment[] {
  const candidates = text.match(/\{[\s\S]*\}/gu) ?? [];
  for (const candidate of [...candidates].sort((left, right) => right.length - left.length)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || !Array.isArray((value as { assignments?: unknown }).assignments)) continue;
    return (value as { assignments: unknown[] }).assignments.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`Invalid reply identity assignment at index ${index}.`);
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.identity !== "string") {
        throw new Error(`Invalid reply identity assignment at index ${index}.`);
      }
      return {
        id: record.id,
        identity: record.identity as ReplyPostingIdentity,
        reason: typeof record.reason === "string" ? record.reason : "",
      };
    });
  }
  throw new Error("Reply identity assignment output did not contain a valid assignments object.");
}

/**
 * AI 答复身份分配的护栏校验与合并(纯函数):护栏线程(price/location/
 * schedule)强制 staff,AI 不可改派;缺线程/非法值的线程回落兜底表。返回
 * 合并后的线程(写回 postingIdentity/routingReason,并逐身份强制
 * replyDisplayRole)与逐条 warning(引擎记进 stageIssues)。
 */
export function applyReplyIdentityAssignments(
  dialogueThreads: DialogueThreadPlan[],
  gapCards: InformationGapPlanningCard[],
  assignments: ReplyIdentityAssignment[],
  claimRules: ProjectClaimRule[],
  blueprint?: ProjectCreativeBlueprint,
  cast: CommentSurfaceRoleCard[] = [],
): { threads: DialogueThreadPlan[]; warnings: string[] } {
  const warnings: string[] = [];
  const gapCardById = new Map(gapCards.map((card) => [card.gapId, card]));
  const byId = new Map(assignments.map((item) => [item.id, item]));
  const threads = dialogueThreads.map((thread) => {
    const gapCard = gapCardById.get(thread.primaryGapId);
    const gap = { label: gapCard?.label ?? "", question: gapCard?.question ?? "" };
    const assigned = byId.get(thread.id);
    const guarded = isStaffGuardedGap(gap, claimRules);
    let identity: ReplyPostingIdentity;
    let routingReason: string;
    if (guarded) {
      identity = "staff";
      if (assigned && assigned.identity !== "staff") {
        routingReason = `合规护栏:命中 price/location/schedule,AI 分配(${assigned.identity})被覆盖,强制 staff`;
        warnings.push(`线程 ${thread.id} 命中营销护栏(price/location/schedule),AI 分配的 ${assigned.identity} 被覆盖为 staff。`);
      } else {
        routingReason = "合规护栏:命中 price/location/schedule,强制 staff";
      }
    } else if (assigned && (["publisher", "staff", "expert"] as const).includes(assigned.identity)) {
      identity = assigned.identity;
      routingReason = assigned.reason.trim() || "AI 按话头分配";
    } else {
      identity = routeReplyPostingIdentity(gap, claimRules);
      routingReason = assigned
        ? `AI 分配身份非法(${String(assigned.identity)}),回落兜底表`
        : "AI 分配未覆盖该线程,回落兜底表";
      warnings.push(`线程 ${thread.id} 身份${assigned ? "分配非法" : "未被 AI 分配覆盖"},已按兜底表回落为 ${identity}。`);
    }
    return {
      ...thread,
      postingIdentity: identity,
      routingReason,
      surfaceRoleCard: thread.surfaceRoleCard
        ? { ...thread.surfaceRoleCard, replyDisplayRole: forcedReplyDisplayRole(identity, blueprint, cast) }
        : thread.surfaceRoleCard,
    };
  });
  return { threads, warnings };
}

/**
 * 三身份生态的机构 IP(专业解答,expert)角色:蓝图中 accountable 且带专业翻译口吻
 * (knowledge_translation)的角色;缺省取第一个 accountable 角色。
 * 注意:同一角色(机构 IP 本人)常同时带 service_answer 口吻,不能用它反推助理。
 */
export function resolveIpDisplayRole(blueprint?: ProjectCreativeBlueprint): string | undefined {
  const roles = blueprint?.roleModel.roles ?? [];
  return roles.find((role) => role.accountable && role.utteranceModes.includes("knowledge_translation"))?.displayRole
    ?? roles.find((role) => role.accountable)?.displayRole;
}

/**
 * 三身份生态的公开助理(营销承接,staff)角色:accountable + service_answer 中**不是
 * IP 的那一个**。此前直接 find(accountable+service_answer),当 IP 本人也
 * 带 service_answer 口吻时助理会被错解析成 IP——staff 线程挂 IP 名、
 * 答复以 IP 身份第三人称提到"助理/客服"。
 */
export function resolveAssistantReplyDisplayRole(blueprint?: ProjectCreativeBlueprint): string | undefined {
  const roles = blueprint?.roleModel.roles ?? [];
  const ip = resolveIpDisplayRole(blueprint);
  return roles.find((role) =>
    role.accountable && role.utteranceModes.includes("service_answer") && role.displayRole !== ip)?.displayRole;
}

function dialoguePlans(
  opportunity: TopicOpportunity,
  gapCards: InformationGapPlanningCard[],
  strategy: ExpressionStrategy,
  effectiveThreadCount: number,
  primaryGapIds: string[],
  config: ResolvedGenerationConfig,
  seed: number,
  personaScenePlan: PersonaScenePlan,
  replyRouting: { claimRules: ProjectClaimRule[]; projectBlueprint?: ProjectCreativeBlueprint } = { claimRules: [] },
): DialogueThreadPlan[] {
  const relevant = gapCards.filter((gap) => opportunity.gapIds.includes(gap.gapId));
  const ordered = [...relevant].sort((left, right) =>
    Number(right.required) - Number(left.required)
    || right.decisionLeverage - left.decisionLeverage
    || left.gapId.localeCompare(right.gapId),
  );
  const personasByStage: Record<TopicOpportunity["audienceStage"], DialogueThreadPlan["personaRole"][]> = {
    discovering: ["first_time_researcher", "risk_concerned", "information_collector"],
    collecting: ["information_collector", "first_time_researcher", "risk_concerned"],
    comparing: ["comparison_decider", "skeptical_returning_reader", "risk_concerned"],
    hesitating: ["risk_concerned", "skeptical_returning_reader", "comparison_decider"],
    ready: ["local_action_seeker", "comparison_decider", "risk_concerned"],
  };
  const personas = personasByStage[opportunity.audienceStage];
  const method = config.parameters;
  const roleDiversity = method?.commentRoleDiversity ?? 65;
  const constraintDensity = method?.commentConstraintDensity ?? 60;
  const gapMultiplexing = method?.commentGapMultiplexing ?? 55;
  const replyIncrement = method?.commentReplyIncrement ?? 70;
  const discoveryStrength = method?.commentDiscoveryStrength ?? 65;
  const inferenceEffort = method?.commentInferenceEffort ?? 35;
  const selfVerification = method?.commentSelfVerification ?? 70;
  const falseClosureGuard = method?.commentFalseClosureGuard ?? 95;
  const questionCompression = method?.questionCompression ?? 60;
  const platformRegister = method?.commentPlatformRegister ?? 68;
  const conversationRate = method?.commentConversationRate ?? 48;
  const branchingStrength = method?.commentBranchingStrength ?? 62;
  const organicVariation = method?.commentOrganicVariation ?? 58;
  const stages: TopicOpportunity["audienceStage"][] = ["discovering", "collecting", "comparing", "hesitating", "ready"];
  const stageIndex = stages.indexOf(opportunity.audienceStage);
  const stageRadius = roleDiversity >= 75 ? 2 : roleDiversity >= 40 ? 1 : 0;
  const roleStages = stages.filter((_, index) => Math.abs(index - stageIndex) <= stageRadius);
  const evidenceStances: DialogueThreadPlan["roleCard"]["evidenceStance"][] = [
    "evidence_first", "verification_seeking", "boundary_sensitive", "unknown_aware",
  ];
  const availableDecisionBoundaries = [...new Set([
    ...config.informationWindow.boundaries,
    ...opportunity.boundaries,
    ...relevant.map((gap) => gap.boundary).filter((item): item is string => Boolean(item)),
  ])];
  // These are unresolved decision dimensions, not claims about a person's life.
  const unresolvedConstraintDimensions = [
    "待核实维度：时间与工作可见性",
    config.task.city ? `已披露地点范围：${config.task.city}` : "待核实维度：距离与城市",
    "待核实维度：风险容忍范围",
    "待核实维度：方案适配条件",
    "待核实维度：成本边界",
    "待核实维度：来源可信度",
    "待核实维度：服务方能力与责任边界",
    "待核实维度：下一步行动条件",
  ];
  const constraintPool = [...new Set([
    ...(config.task.readerConstraints ?? []),
    ...unresolvedConstraintDimensions,
  ])];
  const constraintCount = constraintDensity < 35 ? 0 : constraintDensity < 70 ? 1 : 2;
  const auxiliaryLimit = gapMultiplexing <= 35 ? 0 : gapMultiplexing <= 70 ? 1 : 2;
  const questionTargetChars = Math.max(16, Math.round(34 - questionCompression * 0.18));
  const primaryOrdered = [
    ...primaryGapIds.map((id) => ordered.find((gap) => gap.gapId === id)).filter((gap): gap is InformationGapPlanningCard => Boolean(gap)),
  ];
  const targetCount = primaryOrdered.length ? Math.max(0, effectiveThreadCount) : 0;
  const visibleLineCapacity = Math.max(0, Math.floor((personaScenePlan.surfaceTargets.visibleCommentLines[1] - targetCount * 2) / 2));
  // P2-11: only plan multi-turn threads when the growth pass (stage 2B) is
  // enabled; otherwise every thread stays a single exchange, matching what the
  // engine will actually produce (2A followUps are emptied, 2B is skipped).
  const multiTurnCount = config.content.commentMultiTurnGrowthEnabled === true && config.content.followUpDepth > 0
    ? Math.min(targetCount, visibleLineCapacity, Math.round(targetCount * conversationRate / 100))
    : 0;
  // P3-15: at most one counterexample thread per plan, and only when the
  // strategy's commentMode carries one (see deriveThreadFunction).
  const counterexampleAllowed = strategy.commentMode.includes("counterexample");
  let counterexampleAssigned = false;
  // 读者互动层:线程级互动形态(org_answer 机构问答 / reader_exchange 读者互聊 /
  // organic_reaction 漂浮短反应)按种子确定性预分配——每线程独立抽取,不设死
  // 比例;营销话头 gap(答复分流为 staff)的线程 T1 概率自然偏高。
  const rawThreadKinds = Array.from({ length: targetCount }, (_, index) => {
    const gap = primaryOrdered[index % primaryOrdered.length]!;
    const marketingTopic = routeReplyPostingIdentity(gap, replyRouting.claimRules) === "staff";
    return assignCommentThreadKind(seed, `thread-kind:${strategy.id}_thread_${index + 1}`, marketingTopic);
  });
  // T2 可行性:读者互聊需要两个不同 displayRole 的**读者侧**可见角色(机构
  // 角色只能答复不能坐读者席),读者角色池不足时确定性退化为 T1 机构问答。
  const readerExchangeFeasible = new Set(personaScenePlan.commentCast.filter((role) => !role.orgSide).map((role) => role.displayRole)).size >= 2;
  const threadKinds: CommentThreadKind[] = rawThreadKinds.map((kind) =>
    kind === "reader_exchange" && !readerExchangeFeasible ? "org_answer" : kind);
  // T3 规划为 1-3 条:超过 3 条按确定性顺序降级多余条;targetCount>=3 且一条
  // 都没抽到时,从 T2 线程里确定性提拔一条(不挤占 T1 机构问答)。
  const organicIndexes = threadKinds
    .map((kind, index) => (kind === "organic_reaction" ? index : -1))
    .filter((index) => index >= 0)
    .sort((left, right) => hashUnit(seed, `organic-order:${left}`) - hashUnit(seed, `organic-order:${right}`));
  for (const dropped of organicIndexes.slice(3)) {
    threadKinds[dropped] = readerExchangeFeasible ? "reader_exchange" : "org_answer";
  }
  if (organicIndexes.length === 0 && targetCount >= 3) {
    const promotable = threadKinds
      .map((kind, index) => (kind === "reader_exchange" ? index : -1))
      .filter((index) => index >= 0)
      .sort((left, right) => hashUnit(seed, `organic-promote:${left}`) - hashUnit(seed, `organic-promote:${right}`));
    if (promotable[0] !== undefined) threadKinds[promotable[0]] = "organic_reaction";
  }
  // T3 漂浮短反应不生长(见 conversationPlan),多轮/深轮候选池只从非 T3 线程
  // 抽取,保证 commentNetwork.multiTurnTarget 的生长下限不会落在不生长的线程上。
  const growableIndexes = Array.from({ length: targetCount }, (_, index) => index)
    .filter((index) => threadKinds[index] !== "organic_reaction");
  const multiTurnIndexes = new Set(
    growableIndexes
      .sort((left, right) => hashUnit(seed, `multi-turn:${left}`) - hashUnit(seed, `multi-turn:${right}`))
      .slice(0, multiTurnCount),
  );
  const deepTurnIndexes = new Set(
    [...multiTurnIndexes]
      .sort((left, right) => hashUnit(seed, `deep-turn:${left}`) - hashUnit(seed, `deep-turn:${right}`))
      .slice(0, branchingStrength >= 75 ? Math.max(0, visibleLineCapacity - multiTurnCount) : 0),
  );
  // 读者席角色序:机构侧(orgSide)角色只答复、不坐读者席,开口者 A 与接话
  // 读者 B 都从读者侧卡池抽取;池为空(退化蓝图)时回退全量,保证不崩。
  const readerRoleIndexes = personaScenePlan.commentCast
    .map((role, roleIndex) => ({ role, roleIndex }))
    .filter(({ role }) => !role.orgSide)
    .map(({ roleIndex }) => roleIndex);
  const seatIndexes = readerRoleIndexes.length
    ? readerRoleIndexes
    : personaScenePlan.commentCast.map((_, roleIndex) => roleIndex);
  const roleOrder = [...seatIndexes].sort((left, right) =>
    hashUnit(seed, `role-order:${opportunity.audienceStage}:${left}`)
      - hashUnit(seed, `role-order:${opportunity.audienceStage}:${right}`));
  const usedQuestionIntents = new Set<string>();
  // 展示昵称(纯展示元数据):包内去重,种子确定性;开口者盐 `nickname:${threadId}`,
  // 追问接话人的昵称在引擎绑定时按 `nickname:${threadId}:fu:${index}` 同样分配。
  const usedDisplayNames = new Set<string>();
  // 开口人物去重(三身份生态):同一 displayRole 每篇至多开口一次,池不足时允许
  // 重复并在该线程标记 personaRepeated。
  const usedOpenerDisplayRoles = new Set<string>();
  const constraintStart = constraintPool.length
    ? Math.floor(hashUnit(seed, "constraint-start") * constraintPool.length)
    : 0;
  const threads: DialogueThreadPlan[] = Array.from({ length: targetCount }, (_, index) => {
    const threadId = `${strategy.id}_thread_${index + 1}`;
    const threadKind = threadKinds[index]!;
    const gap = primaryOrdered[index % primaryOrdered.length]!;
    const displayName = assignCommentDisplayName(seed, `nickname:${threadId}`, usedDisplayNames);
    usedDisplayNames.add(displayName);
    const roleStage = roleStages[Math.floor(hashUnit(seed, `role-stage:${index}`) * roleStages.length)] ?? opportunity.audienceStage;
    const stagePersonas = personasByStage[roleStage];
    const personaOffset = roleDiversity >= 40 ? Math.floor(hashUnit(seed, `persona:${index}`) * stagePersonas.length) : 0;
    const stancePool = roleDiversity >= 70 ? evidenceStances : evidenceStances.slice(0, roleDiversity >= 35 ? 2 : 1);
    const evidenceStance = stancePool[Math.floor(hashUnit(seed, `stance:${index}`) * stancePool.length)]!;
    const constraints = Array.from({ length: Math.min(constraintCount, constraintPool.length) }, (_, offset) =>
      constraintPool[(constraintStart + index + offset * Math.max(1, targetCount)) % constraintPool.length]!,
    ).filter((item, itemIndex, all) => all.indexOf(item) === itemIndex);
    const auxiliaryGapIds = ordered
      .filter((candidate) => candidate.gapId !== gap.gapId)
      .sort((left, right) => hashUnit(seed, `aux:${index}:${left.gapId}`) - hashUnit(seed, `aux:${index}:${right.gapId}`))
      .slice(0, auxiliaryLimit)
      .map((candidate) => candidate.gapId);
    const auxiliaryQuestions = auxiliaryGapIds
      .map((id) => ordered.find((candidate) => candidate.gapId === id))
      .filter((candidate): candidate is InformationGapPlanningCard => Boolean(candidate))
      .map((candidate) => candidate.question || candidate.label);
    const knowledge = [...new Set(config.task.preContactKnown ?? [])].slice(0, 4);
    // replyPlan 去同质化：线程 function 在此提前推导，措辞模板按
    // function / utteranceMode / personaRole 与种子确定性分化（hashUnit 选取，
    // 每字段 2-3 套变体，同输入必同输出）；真实内容（gap.answer/framework/
    // boundary 与已声明边界）保持原样，只替换模板兜底字面。
    const threadFunction = deriveThreadFunction(gap, counterexampleAllowed && !counterexampleAssigned);
    if (threadFunction === "counterexample") counterexampleAssigned = true;
    // 开口人物去重(三身份生态分布控制):同一 displayRole 每篇至多开口一次,
    // T3 的 social_reaction 偏好位同样参与去重;读者池小于线程数时允许重复,
    // 并在该线程标记 personaRepeated(提示词规格里提示换说法)。
    const seatRoles = roleOrder.map((roleIndex) => personaScenePlan.commentCast[roleIndex]!);
    const unusedSeatRoles = seatRoles.filter((role) => !usedOpenerDisplayRoles.has(role.displayRole));
    const openerPool = threadKind === "organic_reaction"
      ? [
          ...unusedSeatRoles.filter((role) => role.utteranceMode === "social_reaction"),
          ...unusedSeatRoles.filter((role) => role.utteranceMode !== "social_reaction"),
        ]
      : unusedSeatRoles;
    const openerCard = openerPool[0]
      ?? (threadKind === "organic_reaction"
        ? (seatRoles.find((role) => role.utteranceMode === "social_reaction") ?? seatRoles[index % seatRoles.length]!)
        : seatRoles[index % seatRoles.length]!);
    const personaRepeated = usedOpenerDisplayRoles.has(openerCard.displayRole);
    usedOpenerDisplayRoles.add(openerCard.displayRole);
    // T3 漂浮短反应来自围观共鸣型角色,公开长度软目标收敛到 4-20 字。
    const surfaceRoleCard = threadKind === "organic_reaction"
      ? { ...openerCard, targetChars: [4, 20] as [number, number] }
      : openerCard;
    // T2 读者互聊:接话读者 B 必须与开口者 A 不同 displayRole(readerExchangeFeasible
    // 已保证找得到)、不同昵称(类型分配先于昵称分配);B 接话范围限其
    // permittedContribution,在 conversationPlan.replyMove 与 2A 提示词中生效。
    const replySurfaceRoleCard = threadKind === "reader_exchange"
      ? roleOrder
        .map((roleIndex) => personaScenePlan.commentCast[roleIndex]!)
        .find((role) => role.displayRole !== surfaceRoleCard.displayRole)
      : undefined;
    const replyDisplayName = threadKind === "reader_exchange"
      ? assignCommentDisplayName(seed, `nickname:${threadId}:reader:b`, usedDisplayNames)
      : undefined;
    if (replyDisplayName) usedDisplayNames.add(replyDisplayName);
    const personaRole = stagePersonas[personaOffset] ?? personas[index % personas.length]!;
    const variantSalt = `${index}:${threadFunction}:${surfaceRoleCard.utteranceMode}:${personaRole}`;
    const pickVariant = (pool: readonly string[], field: string) =>
      pool[Math.floor(hashUnit(seed, `reply-variant:${field}:${variantSalt}`) * pool.length)]!;
    const boundary = gap.boundary ?? availableDecisionBoundaries[0] ?? pickVariant([
      "未披露的个体条件不得代填",
      "资料没覆盖的个人情况不替对方假设",
      "个体差异部分只标明边界、不代为判断",
    ], "boundary");
    // 未知路径同样去同质化：按线程 function 分化措辞，不再全员共用
    // “需要核实、不能下结论、资料未覆盖”这一套字面。
    const unknownPools: Partial<Record<DialogueThreadPlan["function"], readonly string[]>> = {
      next_step: [
        "当前资料不足以形成确定答案",
        `“${gap.label}”缺可追责来源，结论保持未知`,
        "这部分资料没有覆盖，保持未知、不代填",
      ],
      clarify: [
        "资料未覆盖的个体差异仍保持未知",
        "超出已披露口径的个体情况保持未知",
        "个人条件部分缺少依据，结论保留为未知",
      ],
      counterexample: [
        "反例之外的一般适用性仍属未知",
        "具体不适用的范围资料不足，保持未知",
      ],
      verification: [
        "资料未覆盖的个体差异仍保持未知",
        "证据之外的个体适用差异仍是未知",
      ],
    };
    const unknown = pickVariant(
      unknownPools[threadFunction] ?? ["当前资料不足以形成确定答案", "资料未覆盖部分保持未知"],
      "unknown",
    );
    const threadFocus = (constraintPool[index % Math.max(1, constraintPool.length)] ?? "会改变结论的个人条件")
      .replace(/^(?:待核实维度|已披露地点范围)[：:]/u, "");
    const nextQuestionBase = auxiliaryQuestions.length
      ? `下一问只核实辅助维度：${auxiliaryQuestions.join("、")}`
      : "下一问核实会改变结论的个人条件";
    const nextQuestion = `${nextQuestionBase}；本线程再核实：${threadFocus}`;
    const roleCard: DialogueThreadPlan["roleCard"] = {
      stage: roleStage,
      knowledge,
      constraints,
      decisionTask: gap.question,
      evidenceStance,
    };
    const directAnswerFallbackPools: Partial<Record<DialogueThreadPlan["function"], readonly string[]>> = {
      next_step: [
        `“${gap.label}”目前没有可下结论的资料，先给出可执行的核验动作`,
        `关于“${gap.label}”还不能直接下结论，先指明向谁核实、带上什么信息`,
        `“${gap.label}”缺直接答案，这里只给一条可追责的核实路径`,
      ],
      clarify: [
        `“${gap.label}”不能一概而论，先校准一个容易偏高或偏低的预期`,
        `关于“${gap.label}”只能先把话说稳：讲得清的讲清，讲不清的保留`,
        `“${gap.label}”没有统一答案，先点明一个常被忽略的前提`,
      ],
      counterexample: [
        `“${gap.label}”不能照搬一般结论，先提一个谨慎反例`,
        `关于“${gap.label}”存在不按常规走的情况，先看不适用的情形`,
      ],
    };
    const baseDirectAnswer = gap.answer ?? gap.framework
      ?? pickVariant(
        directAnswerFallbackPools[threadFunction] ?? ["当前不能直接下结论，先给出可执行核验路径", "这里不能直接给结论，先给一条能落地的核实路径"],
        "directAnswer",
      );
    // M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: replyPlan = (b) → RETAINED but
    // already NON-blocking. Evidence support is weak (a), but the answer-requirement template
    // (directAnswer / condition / boundary / unknown / nextQuestion) carries recorded creative
    // and safety value (b) — boundary + unknown declarations. A missing replyPlan is only a
    // `warning` in content.ts (comment_reply_plan_missing), never a hard gate; kept as-is.
    const replyPlan: DialogueThreadPlan["replyPlan"] = {
      directAnswer: replyIncrement >= 70 && gap.evidenceIds.length
        ? `${baseDirectAnswer}${pickVariant([
          "；核验时只采用本线程列出的证据来源",
          "；适用性核对以本条所列证据来源为准",
          "；下结论前回到本线程挂出的来源逐项核对",
        ], "evidenceSuffix")}`
        : baseDirectAnswer,
      condition: replyIncrement >= 70 && constraints.length > 1
        ? constraints.join("；")
        : constraints[0] ?? pickVariant([
          "仅在已披露条件内回答",
          "只在对方已说清的条件范围内回应",
          "未披露的个人条件不作为回答依据",
        ], "condition"),
      boundary,
      unknown,
      nextQuestion: replyIncrement >= 70 ? nextQuestion : pickVariant([
        "核实一个会改变结论的条件",
        "补问一项足以改变判断的输入",
        "确认一个还没说清、且会改变结论的条件",
      ], "nextQuestion"),
    };
    const cueSource = gap.answer ?? gap.framework
      ?? (gap.evidenceIds.length ? "已有可核验来源，但答案仍需核实" : "当前资料未给出确定答案");
    const cueCore = [...cueSource.replace(/[。；;！？!?]+$/u, "")].slice(0, discoveryStrength >= 70 ? 20 : 14).join("");
    const discoveryQuestion = evidenceStance === "evidence_first"
      ? `看到“${cueCore}”，${gap.label}该先核哪项？`
      : evidenceStance === "verification_seeking"
        ? `“${cueCore}”能直接说明${gap.label}吗？`
        : evidenceStance === "boundary_sensitive"
          ? `有“${cueCore}”，${gap.label}就能定吗？`
          : `只知道“${cueCore}”，判断${gap.label}还缺什么？`;
    // 三身份生态:答复身份规划层先按兜底表(publisher 楼主/staff 助理/expert
    // 机构 IP)落位,引擎阶段 2 的 AI 分配再覆盖(护栏线程除外);replyDisplayRole
    // 逐身份强制,根治内部 id 直出。routingReason 先记兜底原因,AI 覆盖时改写。
    const postingIdentity = routeReplyPostingIdentity(gap, replyRouting.claimRules);
    const routingReason = postingIdentity === "staff"
      ? "合规护栏:命中 price/location/schedule,兜底 staff"
      : postingIdentity === "expert"
        ? "兜底表:命中专业类 claimType,兜底 expert"
        : "兜底表:未命中护栏与专业类,兜底 publisher(发布账号)";
    const threadSurfaceRoleCard: DialogueThreadPlan["surfaceRoleCard"] = {
      ...surfaceRoleCard,
      replyDisplayRole: forcedReplyDisplayRole(postingIdentity, replyRouting.projectBlueprint, personaScenePlan.commentCast),
    };
    const surfaceIntent: Record<typeof surfaceRoleCard.utteranceMode, string> = {
      direct_question: `像${surfaceRoleCard.displayRole}一样，只问“${gap.question}”里最现实的一点`,
      shared_concern: `先用一句同款担心接住正文，再自然带出“${gap.label}”`,
      experience_fragment: `只补一个与“${gap.label}”有关的搜索、询问、比较或安排动作，不写未经提供的使用结果和完成时长`,
      counterexample: `用一句不同选择、不同问法或不同现实安排提醒“${gap.label}”不能照搬`,
      social_reaction: `只回应正文里的生活画面或情绪，不承担完整答题`,
      detail_spotter: `先指出图片或正文里一个真实可见的细节，再顺势问“${gap.label}”的一小点`,
      knowledge_translation: `把“${gap.label}”翻成一句人话；只用已核验知识，先结论再补一个条件`,
      identity_route: `从正文自然追问对象、地点、账号、时间安排或下一步中的一项`,
      service_answer: `以公开服务身份承接一个动态问题，不冒充普通用户`,
    };
    const baseQuestionIntent = surfaceIntent[surfaceRoleCard.utteranceMode]
      ?? (discoveryStrength >= 50 ? discoveryQuestion : gap.question);
    let questionIntent = baseQuestionIntent;
    const comparableQuestion = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, "");
    if (usedQuestionIntents.has(comparableQuestion(questionIntent))) {
      questionIntent = `${baseQuestionIntent.replace(/[？?]+$/u, "")}，还要核实“${threadFocus}”吗？`;
    }
    if (usedQuestionIntents.has(comparableQuestion(questionIntent))) {
      questionIntent = `${baseQuestionIntent.replace(/[？?]+$/u, "")}，从${roleStage}阶段还缺哪项输入？`;
    }
    usedQuestionIntents.add(comparableQuestion(questionIntent));
    // T3 漂浮短反应:开口意图是一条 4-20 字短共鸣,不提问、不答题、不需要机构回复。
    if (threadKind === "organic_reaction") {
      questionIntent = `只留一句4-20字的短共鸣（如“蹲一个”“码住”“姐妹我也是”），围绕“${gap.label}”同款处境，不提问、不答题、不需要机构回复`;
    }
    // M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: discoveryPlan STRUCTURE = (c)
    // no traceable evidence → DOWNGRADED to optional (task 7.1). Its derived *safety* checks
    // (不扣留信息 / 不伪闭合 / 发现感≠证据) carry (b) value and are RETAINED at `error` level in
    // content.ts. So the scaffolding is optional while the safety guarantees stay mandatory.
    //
    // M7 convergence (design 组件 E · E1/E2): discoveryPlan is now an OPTIONAL,
    // streamlined-capable contract — only `boundary` is required, the rest of the
    // scaffolding (cue/inferencePrompt/reveal/selfCheck/revealTiming/difficulty) is
    // optional. dialoguePlans is therefore no longer forced to emit a complete plan.
    // We still emit the full form here so pre-convergence valid output stays valid and
    // the pipeline keeps running (需求 7.3/7.4); a streamlined `{ boundary }` plan is
    // equally accepted by content.ts, where the three safety checks remain `error`-level.
    const discoveryPlan: DialogueThreadPlan["discoveryPlan"] = {
      cue: `资料中已经披露：“${cueCore}”`,
      inferencePrompt: constraints[0]
        ? `只做一步判断：${constraints[0]}会不会改变“${gap.label}”的答案？`
        : `只做一步判断：这条线索能否直接回答“${gap.label}”？`,
      reveal: replyPlan.directAnswer,
      selfCheck: selfVerification >= 70
        ? gap.evidenceIds.length ? `回到证据 ${gap.evidenceIds.join("、")} 核对适用条件，并检查是否仍有反例或缺失输入` : "检查是否把未知、个人条件或一般推断误写成事实"
        : "检查这一步是否仍缺证据或个人条件",
      boundary: falseClosureGuard >= 70
        ? `${replyPlan.boundary}；发现感、猜中答案和推断过程都不是证据`
        : replyPlan.boundary,
      revealTiming: "same_thread",
      difficulty: inferenceEffort >= 40 ? "moderate" : "low",
    };
    const wantsFollowUp = multiTurnIndexes.has(index);
    const plannedFollowUps = (!wantsFollowUp || config.content.followUpDepth === 0)
      ? 0
      : Math.min(2, config.content.followUpDepth, deepTurnIndexes.has(index) ? 2 : 1) as 1 | 2;
    // 读者互动层:T3 漂浮短反应不生长;T2 读者互聊最多再接一轮(读者对读者
    // 或机构按 postingIdentity 插话一次);T1 机构问答维持原多轮逻辑。
    const targetFollowUps = threadKind === "organic_reaction"
      ? 0 as const
      : threadKind === "reader_exchange"
        ? Math.min(1, plannedFollowUps) as 0 | 1
        : plannedFollowUps;
    const extensionGapId = threadKind === "org_answer" && branchingStrength >= 45 ? auxiliaryGapIds[0] : undefined;
    const topology: NonNullable<DialogueThreadPlan["conversationPlan"]>["topology"] = threadKind === "organic_reaction"
      ? "organic_reaction"
      : threadKind === "reader_exchange"
        ? "reader_exchange"
        : targetFollowUps === 0
          ? (surfaceRoleCard.utteranceMode === "social_reaction" ? "reaction_then_reply" : "single_exchange")
          : targetFollowUps === 2 ? "three_person_branch" : "two_turn";
    // M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: conversationPlan = derived,
    // NON-required. Evidence is (c)/weak, but it is cheap and *derived* from the already-decided
    // followUp count (targetFollowUps) rather than an extra input or LLM call, and no `error`-level
    // check depends on it. Kept at current status — no further convergence action needed.
    const conversationPlan: NonNullable<DialogueThreadPlan["conversationPlan"]> = {
      topology,
      targetFollowUps,
      openingMove: threadKind === "organic_reaction"
        ? `${surfaceRoleCard.displayRole}留一条4-20字短共鸣（如“蹲一个”“码住”），不提问、不答题`
        : `${surfaceRoleCard.displayRole}以“${surfaceRoleCard.interactionHook}”开口；${surfaceRoleCard.lexicalCues.length ? `可择一参考语域：${surfaceRoleCard.lexicalCues.join("、")}` : "使用普通口语"}`,
      replyMove: threadKind === "organic_reaction"
        ? "无回答需求，机构不出现"
        : threadKind === "reader_exchange"
          ? `${replySurfaceRoleCard?.displayRole ?? "另一位读者"}以模拟读者身份接话，只说自己的处境、感受、疑问或轻反应，范围限「${replySurfaceRoleCard?.permittedContribution ?? "自身处境与感受"}」；不讲项目事实、价格数字、效果证词或机构信息`
          : surfaceRoleCard.utteranceMode === "knowledge_translation"
            ? "可追责身份先用人话回答，再留一个会改变答案的条件"
            : "发布账号接住对方真正关心的一点：有口径就给直接回答＋一个会改变答案的条件，没口径就保留未知并指出核验方式；延续正文语气，不做完整讲座，也不讲自己的亲历效果",
      extensionMove: threadKind === "organic_reaction"
        ? "本支为漂浮短反应，不生长"
        : threadKind === "reader_exchange"
          ? (targetFollowUps > 0
            ? "读者对读者继续接话，或机构按 postingIdentity 插话一次；读者发言仍只谈处境与感受"
            : "读者互聊一轮自然停住，机构可不出现")
          : targetFollowUps === 0
            ? (organicVariation >= 70 ? "允许这一支停在自然反应，不强行收口" : "本支一次回复结束")
            : extensionGapId
              ? `下一人必须抓住上句中的一个具体词，再自然带出相邻缺口 ${extensionGapId}`
              : "下一人只围绕上句新出现的条件继续问，不得凭空换题",
      ...(extensionGapId ? { extensionGapId } : {}),
    };
    return {
      id: threadId,
      displayName,
      threadKind,
      ...(replyDisplayName ? { replyDisplayName } : {}),
      gapId: gap.gapId,
      stage: roleStage,
      function: threadFunction,
      questionIntent,
      answerRequirements: [
        `DirectAnswer：${replyPlan.directAnswer}`,
        `Condition：${replyPlan.condition}`,
        `Boundary：${replyPlan.boundary}`,
        `Unknown：${replyPlan.unknown}`,
        `NextQuestion：${replyPlan.nextQuestion}`,
      ],
      followUpIntent: `${strategy.commentMode}；${conversationPlan.extensionMove}`,
      nextStep: deriveThreadNextStep(gap),
      // 三身份生态:答复身份规划层先按兜底表落位(护栏命中→staff,专业类→
      // expert,其余→publisher 楼主),引擎阶段 2 的 AI 分配再覆盖(护栏除外,
      // 见 routeReplyPostingIdentity);提问侧仍是 simulated_reader。
      postingIdentity,
      routingReason,
      ...(personaRepeated ? { personaRepeated: true } : {}),
      sourceClusterIds: gap.evidenceIds.map((sourceId) => sourceId.replace(/^evidence_/u, "")),
      evidenceIds: [...gap.evidenceIds],
      boundaryRequired: Boolean(gap.boundary),
      personaRole,
      speakerType: "simulated_reader",
      // T2/T3 的发言方是模拟读者,声明状态一律 hypothetical(创作参考,
      // 不算证据);T1 机构问答维持证据驱动的 verified/bounded/unknown。
      claimStatus: threadKind !== "org_answer"
        ? "hypothetical"
        : gap.answer && gap.evidenceIds.length
          ? "verified"
          : gap.answer || gap.framework ? "bounded" : gap.evidenceIds.length ? "bounded" : "unknown",
      replyTo: null,
      threadDepth: 0,
      simulated: true,
      simulationLabel: "模拟潜在读者情景",
      roleCard,
      primaryGapId: gap.gapId,
      auxiliaryGapIds,
      // M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: densityProxy = (c) no traceable
      // evidence (constants like expectedReplyComponents=5) → DOWNGRADED to an optional audit
      // field (task 7.2). The real structural constraint (缺口多路复用上限) is carried by
      // comment_gap_multiplexing_exceeded, which is RETAINED at `error` level.
      //
      // M7 convergence (design 组件 E · E1/E2, densityProxy row): densityProxy is now an
      // OPTIONAL audit field. content.ts anchors the density contract on roleCard +
      // primaryGapId and only audits densityProxy consistency when present (a missing
      // densityProxy no longer triggers comment_density_metadata_incomplete). The planner
      // still emits the full proxy here so pre-convergence valid output stays valid and the
      // pipeline keeps running (需求 7.3/7.4); the real structural constraint remains
      // comment_gap_multiplexing_exceeded.
      densityProxy: {
        primaryGapCount: 1,
        auxiliaryDimensionCount: auxiliaryGapIds.length,
        roleDimensionCount: 4 + Number(constraints.length > 0),
        constraintCount: constraints.length,
        expectedReplyComponents: 5,
        questionTargetChars,
      },
      replyPlan,
      discoveryPlan,
      conversationPlan,
      surfaceRoleCard: threadSurfaceRoleCard,
      ...(replySurfaceRoleCard ? { replySurfaceRoleCard } : {}),
    };
  });
  // 方法论《后台状态不是人物》:经历表述走标注制,不设"经历位"名额——逐角色的"禁止代替的
  // 证据"由读者侧角色卡在提示词里承担,规划层不再指派唯一亲历线程。
  return threads;
}

/**
 * gapCoverageLedger — required-gap routing audit.
 *
 * M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: classification = (a) + (b) →
 * REQUIRED as Structural_Validity, NOT downgraded by tasks 7.1–7.3.
 *  - (a) traceable evidence: gap routing is derived from approved information gaps.
 *  - (b) documented creative value: it guarantees required gaps are never silently dropped.
 * 需求 7.7 guard: content.ts enforces `comment_gap_silently_dropped` (and the required-gap
 * checks) at `error` level, so an incomplete ledger blocks generation. Making this
 * non-required would let required gaps disappear silently — invalid output — so it stays
 * mandatory in formal generation.
 */
function buildGapCoverageLedger(
  gapCards: InformationGapPlanningCard[],
  threads: DialogueThreadPlan[],
  targetThreadCount: number,
  capacityWarning?: string,
): OrchestrationPlan["gapCoverageLedger"] {
  const entries = gapCards.map((gap) => {
    const primaryThreadIds = threads.filter((thread) => thread.primaryGapId === gap.gapId).map((thread) => thread.id);
    const auxiliaryThreadIds = threads.filter((thread) => thread.auxiliaryGapIds.includes(gap.gapId)).map((thread) => thread.id);
    const groundedAnswer = Boolean((gap.answer || gap.framework) && gap.evidenceIds.length);
    const bodyAllocated = gap.plannedPlacements.includes("N.body");
    const commentAllocated = gap.plannedPlacements.includes("Cref");
    let status: OrchestrationPlan["gapCoverageLedger"]["entries"][number]["status"];
    let reason: string;
    let requiredInput: string | undefined;
    let verificationPath: string | undefined;
    if (groundedAnswer && commentAllocated && primaryThreadIds.length) {
      status = "planned_for_thread";
      reason = "该缺口计划在独立主线程中给出有证据的答案；生成后仍须核验可见文本、边界和来源。";
    } else if (groundedAnswer && bodyAllocated) {
      status = "planned_for_body";
      reason = "该缺口计划在正文中给出有证据的答案；生成后仍须核验可见文本、边界和来源。";
    } else if (/personal|individual|个人|适用|risk/iu.test(`${gap.gapId} ${gap.label} ${gap.category}`) && !groundedAnswer) {
      status = "awaiting_user_input";
      requiredInput = `补充会改变“${gap.label}”判断的个人条件；不需要提供无关隐私。`;
      reason = `当前缺少个体输入；${requiredInput}`;
    } else if (!groundedAnswer && (primaryThreadIds.length || bodyAllocated || commentAllocated || gap.required)) {
      status = "unknown_with_verification";
      verificationPath = gap.evidenceIds.length
        ? `回到 ${gap.evidenceIds.join("、")} 核对其是否直接回答“${gap.label}”，未直接回答就继续保持unknown。`
        : `为“${gap.label}”补充可追溯来源、适用范围和可核验条件后再形成结论。`;
      reason = `已有明确核验路径但尚不能结案；${verificationPath}`;
    } else {
      status = "explicitly_deferred";
      reason = "该非关键缺口未进入本轮正文或主线程，已明确延后，不能计为解决。";
    }
    // Auxiliary appearances are routing aids only and never change status to resolved.
    return {
      gapId: gap.gapId,
      label: gap.label,
      status,
      required: gap.required,
      bodyAllocated,
      commentAllocated,
      plannedPlacements: [...gap.plannedPlacements],
      actualRealizations: [],
      primaryThreadIds,
      auxiliaryThreadIds,
      reason,
      ...(requiredInput ? { requiredInput } : {}),
      ...(verificationPath ? { verificationPath } : {}),
    };
  });
  const selectedIds = new Set(gapCards.map((gap) => gap.gapId));
  const coveredIds = new Set(entries.map((entry) => entry.gapId));
  const uncoveredGapIds = [...selectedIds].filter((id) => !coveredIds.has(id));
  const ledgerCompleteness = gapCards.length ? entries.length / gapCards.length : 1;
  return {
    entries,
    uncoveredGapIds,
    ledgerCompleteness,
    closureRate: ledgerCompleteness,
    resolvedRate: 0,
    realizedResolvedRate: null,
    realizationStatus: "not_evaluated",
    targetThreadCount,
    effectiveThreadCount: threads.length,
    ...(capacityWarning ? { capacityWarning } : {}),
  };
}

function structureSimilarityToRecent(plan: OrchestrationPlan, recent: CoverageSignature[], topic: string): number {
  if (recent.length === 0) return 0;
  const signature = createCoverageSignature(plan, topic);
  return Math.max(...recent.map((item) => 1 - coverageSignatureDistance(signature, item)));
}

/** F42: return exactly three structurally distinct plans for one selected topic. */
export function planTopicOrchestrations(input: PlanTopicOrchestrationsInput): [OrchestrationPlan, OrchestrationPlan, OrchestrationPlan] {
  const options = resolvedOptions(input.options);
  const recent = (input.recentCoverage ?? []).slice(0, options.reuseCooldown);
  const sourceIds = [...new Set([
    ...input.opportunity.evidenceIds,
    ...(input.projectIntelligence?.evidenceIds ?? []),
  ])];
  const gapById = new Map(input.gaps.map((gap) => [gap.id, gap]));
  const unknownLockedGap = options.lockedGapIds.find((id) => !gapById.has(id));
  if (unknownLockedGap) throw new Error(`Locked information gap does not exist: ${unknownLockedGap}`);
  const enabledProjectStrategies = (input.expressionStrategies ?? []).filter((strategy) => strategy.enabled !== false);
  const explicitPolicyLock = Boolean(
    options.lockedStrategyId
    || enabledProjectStrategies.find((strategy) => strategy.locked),
  );
  const expressionPolicyFixed = explicitPolicyLock || enabledProjectStrategies.length === 1;
  // When the expression policy is intentionally fixed, distance is measured
  // only over the still-independent state/gap axes, whose attainable range is smaller.
  // An explicit lock prioritizes exact policy fidelity over a distance target and
  // must never make the mandatory three-plan contract impossible.
  const requiredDistance = explicitPolicyLock
    ? 0
    : expressionPolicyFixed ? Math.min(options.minStructureDistance, 0.1) : options.minStructureDistance;

  const buildPlan = (candidateIndex: 0 | 1 | 2, attempt: number): OrchestrationPlan => {
    const seed = input.seeds?.[candidateIndex] ?? seedFor(input.seed ?? 0, candidateIndex);
    const strategy = sampleExpressionStrategy(input, options, candidateIndex, attempt, recent);
    const unlockedGapIds = input.opportunity.gapIds.filter((id) => !options.lockedGapIds.includes(id));
    const gapOrderRandomized = options.randomizationDimensions.includes("gap_order") && options.variationStrength > 0;
    const orderedUnlocked = gapOrderRandomized
      ? [...unlockedGapIds].sort((left, right) => {
        const leftIndex = unlockedGapIds.indexOf(left) / Math.max(1, unlockedGapIds.length);
        const rightIndex = unlockedGapIds.indexOf(right) / Math.max(1, unlockedGapIds.length);
        const leftScore = (1 - options.variationStrength) * leftIndex + options.variationStrength * hashUnit(seed, `gap:${attempt}:${left}`);
        const rightScore = (1 - options.variationStrength) * rightIndex + options.variationStrength * hashUnit(seed, `gap:${attempt}:${right}`);
        return leftScore - rightScore || left.localeCompare(right);
      })
      : unlockedGapIds;
    const requiredGapIds = input.gaps
      .filter((gap) => gap.required && input.opportunity.gapIds.includes(gap.id))
      .map((gap) => gap.id);
    // The knowledge atlas may be exhaustive; one post is not. Sample-shaped
    // output advances one narrow task and at most a few adjacent gaps.
    const breadth = input.config.parameters?.informationBreadth ?? 65;
    const perPostGapLimit = breadth >= 85 ? 4 : breadth >= 50 ? 3 : 2;
    const fixedGapIds = [...new Set([...options.lockedGapIds, ...requiredGapIds])];
    const rotatingStart = orderedUnlocked.length
      ? Math.floor(hashUnit(seed, `gap-window:${attempt}`) * orderedUnlocked.length)
      : 0;
    const rotatedUnlocked = [...orderedUnlocked.slice(rotatingStart), ...orderedUnlocked.slice(0, rotatingStart)];
    const selectedGapIds = [...new Set([
      ...fixedGapIds,
      ...rotatedUnlocked.filter((id) => !fixedGapIds.includes(id)).slice(0, Math.max(0, perPostGapLimit - fixedGapIds.length)),
    ])];
    const opportunity = { ...input.opportunity, gapIds: selectedGapIds };
    const gaps = selectedGapIds
      .map((id) => gapById.get(id))
      .filter((gap): gap is InformationGap => Boolean(gap))
      .map((gap) => options.lockedGapIds.includes(gap.id) ? { ...gap, required: true } : gap);
    const commentsEnabled = input.config.expressionWindow.channels.includes("comments") && input.config.content.commentThreadMax > 0;
    const gapPlanningCards = makeGapPlanningCards(opportunity, gaps, strategy, commentsEnabled);
    const channelAllocation = renderChannelAllocation(opportunity, gapPlanningCards, strategy, commentsEnabled);
    const personaScenePlan = buildPersonaScenePlan(strategy, opportunity, input.config, seed + attempt, input.projectBlueprint);
    const imagePlan = buildImagePlan(strategy, opportunity, input.imageAnalyses ?? [], personaScenePlan);
    const primaryGapIds = gapPlanningCards
      .filter((card) => card.plannedPlacements.includes("Cref"))
      .map((card) => card.gapId);
    const commentSpan = Math.max(0, input.config.content.commentThreadMax - input.config.content.commentThreadMin);
    const desiredThreadCount = commentsEnabled
      ? Math.min(5, input.config.content.commentThreadMin + Math.round(commentSpan * (input.config.parameters?.commentExpansion ?? 70) / 100))
      : 0;
    const effectiveThreadTarget = Math.max(desiredThreadCount, primaryGapIds.length);
    const capacityWarning = effectiveThreadTarget > input.config.content.commentThreadMax
      ? `为让 ${primaryGapIds.length} 个主缺口不静默消失，实际线程数 ${effectiveThreadTarget} 超出可读性目标 ${input.config.content.commentThreadMax}；建议分批发布或合并正文，但不得把辅助提及算作解决。`
      : undefined;
    const dialogueThreads = dialoguePlans(
      opportunity,
      gapPlanningCards,
      strategy,
      effectiveThreadTarget,
      primaryGapIds,
      input.config,
      seed,
      personaScenePlan,
      {
        claimRules: input.projectBlueprint?.claimPolicy.rules ?? [],
        projectBlueprint: input.projectBlueprint,
      },
    );
    const gapCoverageLedger = buildGapCoverageLedger(
      gapPlanningCards,
      dialogueThreads,
      input.config.content.commentThreadMax,
      capacityWarning,
    );
    return {
      id: `orch_${stableHash(`${opportunity.id}:${strategy.id}:${seed}:${attempt}:${selectedGapIds.join(",")}`).slice(0, 16)}`,
      topicOpportunityId: opportunity.id,
      opportunitySelectionAudit: input.opportunitySelectionAudit
        ? structuredClone(input.opportunitySelectionAudit)
        : {
          selectedOpportunityId: opportunity.id,
          selectionMode: "default_policy",
          rankStatus: "not_applied",
          rankNotAppliedReason: "No selection audit was supplied to the standalone planner.",
        },
      candidateIndex,
      seed,
      strategy,
      stateSeed: stateSeed({ ...input, opportunity }, seed, candidateIndex + attempt * 3, options),
      personaScenePlan,
      selectedGapIds,
      gapPlanningCards,
      channelAllocation,
      imagePlan,
      dialogueThreads,
      gapCoverageLedger,
      targetThreadCount: input.config.content.commentThreadMax,
      effectiveThreadCount: dialogueThreads.length,
      ...(capacityWarning ? { capacityWarning } : {}),
      // P3-16: aC operations plan — static template, strictly separated from the
      // Cref reference content (F03): these are operating rules for the account,
      // never text to be published as comments.
      deploymentPlan: {
        postingIdentity: "publisher",
        ownedFirstComment: true,
        // P3-15: pinPriority must only contain legal thread-function values
        // ("boundary" was never one); stays linked to the strategy commentMode.
        pinPriority: strategy.commentMode.includes("verification") ? ["verification", "next_step"] : ["verification", "clarify"],
        sla: "工作日 24h 内答复真实评论；需要个体结论的问题不承诺即时答复",
        liveRouting: [
          { route: "项目事实类问题", condition: "知识库已有已批准口径", action: "由发布账号引用已批准口径答复，并保留适用边界" },
          { route: "个体结论类问题", condition: "需要个人条件或未披露信息才能判断", action: "转专业/人工渠道处理，禁止代填个体结论" },
          { route: "已批准口径之外的新问题", condition: "知识库无可用口径", action: "记录进入更新队列，未知保持未知，禁止代填" },
        ],
        updateTriggers: ["知识库证据变化", "适用边界变化"],
        updatePolicy: ["真实评论中反复出现且当前口径未覆盖的问题进入更新队列，经 draft→approve 补充口径后才可答复"],
        stopRules: ["无法核验时不代填答案", "不得伪装消费者或第三方口碑", "用户真实评论与参考模板分开保存"],
      },
      rationale: [
        `同一选题采用 ${strategy.label}，并沿独立表达轴做受控交叉编排。`,
        `可见成品采用 ${personaScenePlan.prototype} 原型；人物、事件和评论关系网跨通道保持一致。`,
        `随机化维度：${options.randomizationDimensions.join("、") || "无"}；强度 ${options.variationStrength.toFixed(2)}。`,
        "每篇只推进一个窄任务；正文建立人物事件，评论用短互动逐步补足相邻信息。",
        `信息台账完整度 ${gapCoverageLedger.ledgerCompleteness.toFixed(2)}；最终正文与评论尚未生成，真实解决率待生成后核验。`,
      ],
      evidenceIds: sourceIds,
      boundaries: [...new Set([
        ...input.opportunity.boundaries,
        ...(input.projectIntelligence?.hardBoundaries ?? []),
      ])],
    };
  };

  const selected: OrchestrationPlan[] = [];
  for (let rawIndex = 0; rawIndex < 3; rawIndex += 1) {
    const candidateIndex = rawIndex as 0 | 1 | 2;
    const candidates = Array.from({ length: 48 }, (_, attempt) => buildPlan(candidateIndex, attempt));
    const allScored = candidates.map((plan) => {
      const minDistance = selected.length ? Math.min(...selected.map((previous) => structureDistance(plan, previous))) : 1;
      const recentOverlap = structureSimilarityToRecent(plan, recent, input.opportunity.topic);
      const prototypeNovelty = selected.some((previous) => previous.personaScenePlan?.prototype === plan.personaScenePlan?.prototype) ? 0 : 0.35;
      return { plan, minDistance, score: minDistance + prototypeNovelty - recentOverlap * options.recentPenaltyWeight };
    });
    const scored = allScored.filter((item) => item.minDistance >= requiredDistance);
    const byScore = (left: typeof allScored[number], right: typeof allScored[number]) =>
      right.score - left.score || left.plan.id.localeCompare(right.plan.id);
    scored.sort(byScore);
    allScored.sort(byScore);
    const chosen = scored[0] ?? allScored[0]!;
    selected.push(chosen.minDistance >= requiredDistance
      ? chosen.plan
      : {
          ...chosen.plan,
          rationale: [
            ...chosen.plan.rationale,
            `当前可用策略的最小结构距离为 ${chosen.minDistance.toFixed(2)}，未达到目标 ${requiredDistance.toFixed(2)}；为保证生产不中断，已采用可用方案中差异最大的一项。`,
          ],
        });
  }
  return selected as [OrchestrationPlan, OrchestrationPlan, OrchestrationPlan];
}

/** Weighted categorical/set distance. This is deterministic feature comparison, not an embedding. */
export function structureDistance(left: OrchestrationPlan, right: OrchestrationPlan): number {
  const strategy = Number(left.strategy.id !== right.strategy.id);
  const opening = Number(left.strategy.openingMode !== right.strategy.openingMode);
  const narrative = Number(left.strategy.narrativeMode !== right.strategy.narrativeMode);
  const image = Number(left.imagePlan.role !== right.imagePlan.role);
  const comments = Number(left.strategy.commentMode !== right.strategy.commentMode);
  const bodyRole = Number(left.strategy.bodyRole !== right.strategy.bodyRole);
  const voice = Number(left.strategy.voice !== right.strategy.voice);
  const channelOrder = Number(left.strategy.targetChannels.join("|") !== right.strategy.targetChannels.join("|"));
  const sequence = 1 - jaccard(left.strategy.sequence, right.strategy.sequence);
  const bodyAllocation = 1 - jaccard(left.channelAllocation["N.body"], right.channelAllocation["N.body"]);
  const commentAllocation = 1 - jaccard(left.channelAllocation.Cref, right.channelAllocation.Cref);
  const levelValue = (level: "low" | "medium" | "high"): number => level === "low" ? 0 : level === "medium" ? 1 : 2;
  const state = (
    Math.abs(levelValue(left.stateSeed.stateHypotheses.skepticism.level) - levelValue(right.stateSeed.stateHypotheses.skepticism.level))
    + Math.abs(levelValue(left.stateSeed.stateHypotheses.fatigue.level) - levelValue(right.stateSeed.stateHypotheses.fatigue.level))
    + Math.abs(levelValue(left.stateSeed.stateHypotheses.closureNeed.level) - levelValue(right.stateSeed.stateHypotheses.closureNeed.level))
  ) / 6;
  const gapOrder = Number(left.selectedGapIds.join("|") !== right.selectedGapIds.join("|"));
  return clamp01(
    0.08 * strategy
    + 0.06 * opening
    + 0.08 * narrative
    + 0.06 * image
    + 0.06 * comments
    + 0.06 * sequence
    + 0.06 * bodyRole
    + 0.04 * voice
    + 0.06 * channelOrder
    + 0.05 * bodyAllocation
    + 0.04 * commentAllocation
    + 0.1 * gapOrder
    + 0.25 * state,
  );
}

export function createCoverageSignature(plan: OrchestrationPlan, topicKey = plan.topicOpportunityId): CoverageSignature {
  const channelFeatures = Object.fromEntries(CHANNELS.map((channel) => [
    channel,
    normalizedSet(plan.channelAllocation[channel] ?? []),
  ])) as Record<ContentChannel, string[]>;
  const unsigned = {
    version: "1.0" as const,
    topicKey: normalizedText(topicKey),
    gapIds: normalizedSet(plan.selectedGapIds),
    strategyId: plan.strategy.id,
    imageRole: plan.imagePlan.role,
    audienceStage: plan.stateSeed.stage,
    entry: plan.stateSeed.entry,
    channelFeatures,
    tokens: normalizedSet([
      `opening:${plan.strategy.openingMode}`,
      `narrative:${plan.strategy.narrativeMode}`,
      `body:${plan.strategy.bodyRole}`,
      `comments:${plan.strategy.commentMode}`,
      `voice:${plan.strategy.voice}`,
      `gap-order:${plan.selectedGapIds.join(">")}`,
      `state:${plan.stateSeed.stateHypotheses.skepticism.level}:${plan.stateSeed.stateHypotheses.fatigue.level}:${plan.stateSeed.stateHypotheses.closureNeed.level}`,
      ...plan.strategy.sequence.map((item, index) => `sequence:${index}:${item}`),
    ]),
  };
  return { ...unsigned, fingerprint: stableHash(unsigned) };
}

export function coverageSignatureDistance(left: CoverageSignature, right: CoverageSignature): number {
  const topic = Number(normalizedText(left.topicKey) !== normalizedText(right.topicKey));
  const gaps = 1 - jaccard(left.gapIds, right.gapIds);
  const strategy = Number(left.strategyId !== right.strategyId);
  const image = Number(left.imageRole !== right.imageRole);
  const state = Number(left.audienceStage !== right.audienceStage || left.entry !== right.entry);
  const tokens = 1 - jaccard(left.tokens, right.tokens);
  const channels = CHANNELS.reduce((sum, channel) =>
    sum + (1 - jaccard(left.channelFeatures[channel] ?? [], right.channelFeatures[channel] ?? [])), 0) / CHANNELS.length;
  return clamp01(0.22 * topic + 0.18 * gaps + 0.18 * strategy + 0.1 * image + 0.1 * state + 0.1 * tokens + 0.12 * channels);
}

export function downrankRecentCoverage(
  signature: CoverageSignature,
  recentCoverage: CoverageSignature[],
  penaltyWeight = DEFAULT_OPTIONS.recentPenaltyWeight,
): number {
  if (recentCoverage.length === 0) return 0;
  const similarity = Math.max(...recentCoverage.map((recent) => 1 - coverageSignatureDistance(signature, recent)));
  return clamp01(similarity * clamp01(penaltyWeight));
}
