import { describe, expect, it } from "vitest";

import {
  coverageSignatureDistance,
  createCoverageSignature,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  filterTopicOpportunities,
  OpportunityRankHeuristicV1,
  OpportunityRankHeuristicV1DefaultPolicy,
  planTopicOrchestrations,
  rankTopicOpportunities,
  structureDistance,
} from "../src/index.js";
import type { CommentGapCoverageLedger, InformationGap, PlanningRandomizationDimension, TopicOpportunity } from "../src/index.js";

const project = {
  id: "p1",
  name: "项目",
  domain: "健康信息",
  productPoints: ["资料确认的项目事实"],
  organizationPoints: [],
  cities: [],
  doctors: [],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.informationWindow.boundaries = ["个体适用性需要单独核验"];
  value.content.commentThreadMax = 3;
  return value;
}

const gaps: InformationGap[] = [
  {
    id: "fit",
    label: "适用条件",
    question: "哪些条件会改变适用性？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    boundary: "个体适用性需要单独核验",
    evidenceIds: ["evidence_d1"],
    required: true,
  },
  {
    id: "compare",
    label: "比较维度",
    question: "应该按哪些维度比较？",
    category: "comparison",
    audienceStages: ["comparing"],
    importance: 0.75,
    decisionLeverage: 0.65,
    proofability: 0.75,
    evidenceIds: ["evidence_d1"],
    required: false,
  },
];

const extendedGaps: InformationGap[] = [
  ...gaps,
  {
    id: "timeline",
    label: "时间安排",
    question: "时间安排会怎样改变选择？",
    category: "process",
    audienceStages: ["comparing"],
    importance: 0.7,
    decisionLeverage: 0.72,
    proofability: 0.65,
    evidenceIds: ["evidence_d1"],
    required: false,
  },
  {
    id: "personal_unknown",
    label: "个人未知条件",
    question: "还缺哪些个人条件才能判断？",
    category: "risk",
    audienceStages: ["comparing"],
    importance: 0.85,
    decisionLeverage: 0.88,
    proofability: 0.2,
    evidenceIds: [],
    required: true,
  },
];

function opportunity(id: string, topic = "方案选择"): TopicOpportunity {
  return {
    id,
    topic,
    angle: "先核验再比较",
    gapIds: ["fit", "compare"],
    audienceStage: "comparing",
    entry: "search",
    relevance: 0.9,
    importance: 0.8,
    proofability: 0.8,
    novelty: 0.6,
    decisionLeverage: 0.8,
    cognitiveCost: 0.3,
    risk: 0.2,
    evidenceIds: ["evidence_d1"],
    boundaries: ["个体适用性需要单独核验"],
    tags: ["比较方法"],
    imageAssetIds: ["img1"],
    status: "eligible",
  };
}

function tracedOpportunity(id: string, topic?: string): TopicOpportunity {
  const value = opportunity(id, topic);
  value.rankInputSources = {
    metrics: {
      relevance: { source: "user", sourceRef: "test.relevance" },
      importance: { source: "project", sourceRef: "test.importance" },
      proofability: { source: "observed", sourceRef: "test.proofability" },
      novelty: { source: "model_heuristic", sourceRef: "test.novelty" },
      decisionLeverage: { source: "user", sourceRef: "test.decisionLeverage" },
      cognitiveCost: { source: "model_heuristic", sourceRef: "test.cognitiveCost" },
      risk: { source: "project", sourceRef: "test.risk" },
    },
    status: { source: "user", sourceRef: "test.status" },
    topic: { source: "user", sourceRef: "test.topic" },
    gapIds: { source: "project", sourceRef: "test.gapIds" },
  };
  return value;
}

describe("non-vector orchestration planning", () => {
  it("publishes a traceable non-causal V1 heuristic contract and preserves every contribution", () => {
    const candidate = tracedOpportunity("traceable");
    candidate.score = 0.99;
    const result = rankTopicOpportunities({
      opportunities: [candidate],
      recentCoverage: [],
      recentCoverageSource: { source: "observed", sourceRef: "coverage_records" },
    })[0]!;
    expect(OpportunityRankHeuristicV1).toMatchObject({
      id: "OpportunityRankHeuristicV1",
      version: "1.0.0",
      weightsCalibrated: false,
      causal: false,
      notF28: true,
      scoreSemantics: "ordinal_noncausal_heuristic",
    });
    // Under M3 `minProofability` is an advisory ranking signal, not a gate (req 5.4),
    // so its exact value carries no gating semantics. Assert the real source default
    // (0.2) rather than a stale expectation; the number only shapes ranking hints.
    expect(OpportunityRankHeuristicV1DefaultPolicy).toEqual({
      minProofability: 0.2,
      maxRisk: 0.7,
      recentPenaltyWeight: 0.35,
      reuseCooldown: 12,
    });
    expect(result).toMatchObject({
      rank: 1,
      effectiveEligibility: "eligible",
      reviewRequired: false,
      unknownMetrics: [],
      unboundedBaseScore: expect.closeTo(0.758, 8),
      baseScore: expect.closeTo(0.758, 8),
      recentPenalty: 0,
      finalScore: expect.closeTo(0.758, 8),
      scoreSemantics: "ordinal_noncausal_heuristic",
      // Advisory-only threshold (see note above): mirrors the source default minProofability (0.2).
      policy: { minProofability: 0.2, maxRisk: 0.7, recentPenaltyWeight: 0.35, reuseCooldown: 12 },
      recentCoverage: { status: "provided", count: 0, similarity: 0 },
      legacyInputScore: { value: 0.99, used: false, semantics: "legacy_heuristic" },
    });
    expect(result.components).toHaveLength(7);
    expect(result.components.find((item) => item.metric === "cognitiveCost")).toMatchObject({
      rawValue: 0.3,
      transformedValue: 0.7,
      transformation: "one_minus",
      weight: 0.08,
      contribution: expect.closeTo(0.056, 8),
      source: { source: "model_heuristic", sourceRef: "test.cognitiveCost" },
    });
    expect(result.components.find((item) => item.metric === "risk")).toMatchObject({
      rawValue: 0.2,
      weight: -0.18,
      contribution: expect.closeTo(-0.036, 8),
    });
  });

  it("keeps missing or invalid critical metrics unknown instead of substituting zero", () => {
    const candidate = tracedOpportunity("missing");
    candidate.cognitiveCost = undefined;
    candidate.risk = Number.NaN;
    const result = rankTopicOpportunities({
      opportunities: [candidate],
      recentCoverage: [],
      recentCoverageSource: { source: "observed", sourceRef: "coverage_records" },
    })[0]!;
    expect(result.unknownMetrics).toEqual(expect.arrayContaining(["cognitiveCost", "risk"]));
    expect(result).toMatchObject({
      rank: null,
      effectiveEligibility: "review_required",
      reviewRequired: true,
      unboundedBaseScore: null,
      baseScore: null,
      finalScore: null,
    });
    expect(result.components.find((item) => item.metric === "cognitiveCost")).toMatchObject({
      rawValue: null,
      transformedValue: null,
      contribution: null,
    });
    expect(result.opportunity.cognitiveCost).toBeUndefined();
    expect(result.opportunity.risk).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result)).unknownMetrics).toEqual(expect.arrayContaining(["cognitiveCost", "risk"]));
    // Unknown metrics are advisory only; structural selectability no longer excludes them (req 5.3/5.4).
    expect(filterTopicOpportunities([candidate])).toEqual([candidate]);
  });

  it("marks a numeric legacy preview for review when its metric sources are untraceable", () => {
    const candidate = opportunity("legacy");
    candidate.score = 0.91;
    const result = rankTopicOpportunities({
      opportunities: [candidate],
      recentCoverage: [],
      recentCoverageSource: { source: "observed", sourceRef: "coverage_records" },
    })[0]!;
    expect(result.finalScore).toBeCloseTo(0.758, 8);
    expect(result.rank).toBeNull();
    expect(result.effectiveEligibility).toBe("review_required");
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons).toContain("untraceable metric sources: relevance, importance, proofability, decisionLeverage, novelty, cognitiveCost, risk");
    expect(result.inputSources.metrics.risk.source).toBe("legacy_unspecified");
    expect(result.legacyInputScore).toEqual({ value: 0.91, used: false, semantics: "legacy_heuristic" });
  });

  it("does not treat absent recent history as zero overlap", () => {
    const result = rankTopicOpportunities({ opportunities: [tracedOpportunity("unknown-history")] })[0]!;
    expect(result.baseScore).toBeCloseTo(0.758, 8);
    expect(result.recentPenalty).toBeNull();
    expect(result.finalScore).toBeNull();
    expect(result.unknownMetrics).toContain("recentOverlap");
    expect(result.recentCoverage).toMatchObject({ status: "unknown", count: null, similarity: null, source: { source: "unknown" } });
    expect(result.effectiveEligibility).toBe("review_required");
  });

  it("requires provenance when caller-supplied ranking policy changes the result", () => {
    const result = rankTopicOpportunities({
      opportunities: [tracedOpportunity("custom-policy")],
      recentCoverage: [],
      recentCoverageSource: { source: "observed", sourceRef: "coverage_records" },
      options: { recentPenaltyWeight: 0.2 },
    })[0]!;
    expect(result.finalScore).not.toBeNull();
    expect(result.inputSources.options.source).toBe("legacy_unspecified");
    expect(result.reviewReasons).toContain("ranking options source is untraceable");
    expect(result.effectiveEligibility).toBe("review_required");
  });

  it("filters only structurally invalid opportunities and keeps weak or risky ones selectable", () => {
    // Structural exclusions (req 5.3/5.4): blocked status, empty topic, no gap references.
    const blocked = { ...opportunity("blocked"), status: "blocked" as const };
    const emptyTopic = { ...opportunity("empty-topic"), topic: "   " };
    const noGap = { ...opportunity("no-gap"), gapIds: [] };
    // Advisory-only signals must NOT gate selectability: low proofability / high risk stay in.
    const weak = { ...opportunity("weak"), proofability: 0.1 };
    const risky = { ...opportunity("risky"), risk: 0.95 };
    expect(
      filterTopicOpportunities([blocked, emptyTopic, noGap, weak, risky, opportunity("ok")]).map((item) => item.id),
    ).toEqual(["weak", "risky", "ok"]);
  });

  it("creates three complete structures for the same topic and keeps critical boundaries in the body allocation", () => {
    const plans = planTopicOrchestrations({
      opportunity: opportunity("topic1"),
      gaps,
      config: config(),
      seeds: [11, 22, 33],
      imageAnalyses: [{
        assetId: "img1",
        imageUrl: "https://example.test/image.png",
        altText: "咨询场景",
        observedFacts: ["画面中有一张信息清单"],
        inferredSignals: ["可能用于咨询"],
        unknowns: ["拍摄时间未知"],
        visibleText: ["核验清单"],
        roles: ["scene", "evidence"],
        quality: { clarity: 0.9, relevance: 0.9, textLegibility: 0.8 },
        safetyFlags: [],
        evidenceIds: ["evidence_d1"],
        source: "uploaded",
      }],
    });
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((plan) => plan.topicOpportunityId))).toEqual(new Set(["topic1"]));
    expect(new Set(plans.map((plan) => plan.strategy.id)).size).toBe(3);
    expect(new Set(plans.map((plan) => plan.imagePlan.role)).size).toBeGreaterThan(1);
    expect(plans.every((plan) => plan.imagePlan.sourceAssetId === "img1" && plan.imagePlan.primaryAssetId === "img1")).toBe(true);
    expect(plans.every((plan) => plan.channelAllocation["N.body"].includes("boundary:个体适用性需要单独核验"))).toBe(true);
    expect(plans.every((plan) => plan.gapPlanningCards?.[0]?.priority === "required" && plan.gapPlanningCards?.[0]?.gapId === "fit")).toBe(true);
    expect(plans.every((plan) => plan.gapCoverageLedger.ledgerCompleteness === 1
      && plan.gapCoverageLedger.realizationStatus === "not_evaluated"
      && plan.gapCoverageLedger.realizedResolvedRate === null
      && plan.gapCoverageLedger.resolvedRate === 0)).toBe(true);
    for (const plan of plans) {
      for (const card of plan.gapPlanningCards ?? []) {
        for (const channel of ["N.body", "Cref"] as const) {
          expect(plan.channelAllocation[channel].includes(`gap:${card.gapId}`)).toBe(card.plannedPlacements.includes(channel));
        }
      }
    }
    const dialogueThreads = plans.flatMap((plan) => plan.dialogueThreads);
    expect(dialogueThreads.every((thread) => thread.simulated && thread.speakerType === "simulated_reader" && thread.postingIdentity === "publisher")).toBe(true);
    expect(new Set(dialogueThreads.map((thread) => thread.personaRole)).size).toBeGreaterThan(1);
    // P3-15: function derives from the gap card content, not positional rotation —
    // every Cref thread here anchors the required, unanswered "fit" gap → next_step.
    expect(plans[0].dialogueThreads.length).toBeGreaterThan(0);
    expect(plans[0].dialogueThreads.every((thread) => thread.function === "next_step")).toBe(true);
    expect(dialogueThreads.every((thread) => thread.replyTo === null && thread.threadDepth === 0 && Boolean(thread.claimStatus))).toBe(true);
    expect(dialogueThreads.every((thread) => thread.stage === thread.roleCard.stage && thread.primaryGapId === thread.gapId)).toBe(true);
    expect(dialogueThreads.every((thread) => thread.densityProxy.primaryGapCount === 1 && thread.densityProxy.expectedReplyComponents === 5)).toBe(true);
    expect(dialogueThreads.every((thread) => thread.auxiliaryGapIds.length <= 1 && thread.densityProxy.auxiliaryDimensionCount === thread.auxiliaryGapIds.length)).toBe(true);
    expect(dialogueThreads.every((thread) => Object.values(thread.replyPlan).every(Boolean))).toBe(true);
    expect(dialogueThreads.flatMap((thread) => thread.roleCard.constraints).every((item) => item === "个体适用性需要单独核验" || item.startsWith("待核实维度："))).toBe(true);
    for (let left = 0; left < plans.length; left += 1) {
      for (let right = left + 1; right < plans.length; right += 1) {
        expect(structureDistance(plans[left]!, plans[right]!)).toBeGreaterThanOrEqual(0.45);
      }
    }
  });

  it("keeps project evidence separate from user-supplied pre-contact reader knowledge", () => {
    const defaultScenario = config();
    const projectIntelligence = {
      projectId: "p1",
      industry: "健康信息",
      domain: "方案选择",
      projectSummary: "项目资料",
      verifiedFacts: ["项目证据事实A", "项目证据事实B"],
      differentiators: [],
      audienceStates: ["comparing"],
      hardBoundaries: ["项目边界不是读者约束"],
      prohibitedClaims: [],
      dynamicUnknowns: [],
      evidenceIds: ["evidence_d1"],
    };
    const unknownHistoryPlans = planTopicOrchestrations({
      opportunity: opportunity("state-default"),
      gaps,
      config: defaultScenario,
      projectIntelligence,
      seeds: [11, 22, 33],
    });
    for (const plan of unknownHistoryPlans) {
      expect(plan.stateSeed.preContactKnown).toEqual([]);
      expect(plan.stateSeed.availableEvidence).toEqual(["项目证据事实A", "项目证据事实B"]);
      expect(plan.stateSeed.availableBoundaries).toContain("项目边界不是读者约束");
      expect(plan.stateSeed.readerConstraints).toEqual([]);
      expect(plan.stateSeed.history).toEqual({ status: "unknown", items: [] });
      expect(plan.stateSeed.calibrationStatus).toBe("unvalidated");
      expect((plan.stateSeed as unknown as Record<string, unknown>).known).toBeUndefined();
      expect((plan.stateSeed as unknown as Record<string, unknown>).skepticism).toBeUndefined();
      for (const hypothesis of Object.values(plan.stateSeed.stateHypotheses)) {
        expect(hypothesis.level).toMatch(/^(low|medium|high)$/u);
        expect(hypothesis.range).toHaveLength(2);
        expect(hypothesis.calibrated).toBe(false);
        expect(hypothesis.source).toBe("stage_heuristic");
        expect(hypothesis.basis).toMatch(/不是/u);
      }
      expect(plan.dialogueThreads.every((thread) => !thread.roleCard.knowledge.includes("项目证据事实A"))).toBe(true);
    }

    const supplied = config();
    supplied.task.preContactKnown = ["用户明确说读者已看过基础介绍"];
    supplied.task.readerHistory = ["用户明确提供：此前看过比较清单"];
    supplied.task.readerConstraints = ["用户明确提供：只能周末安排"];
    const suppliedPlans = planTopicOrchestrations({
      opportunity: opportunity("state-supplied"),
      gaps,
      config: supplied,
      projectIntelligence,
      seeds: [11, 22, 33],
    });
    for (const plan of suppliedPlans) {
      expect(plan.stateSeed.preContactKnown).toEqual(["用户明确说读者已看过基础介绍"]);
      expect(plan.stateSeed.history).toEqual({ status: "provided", items: ["用户明确提供：此前看过比较清单"] });
      expect(plan.stateSeed.readerConstraints).toEqual(["用户明确提供：只能周末安排"]);
      expect(plan.dialogueThreads.every((thread) => thread.roleCard.knowledge.every((item) => supplied.task.preContactKnown.includes(item)))).toBe(true);
    }
  });

  it("uses comment parameters to bound role constraints and auxiliary gaps without inventing personal facts", () => {
    const low = config();
    low.parameters!.commentRoleDiversity = 0;
    low.parameters!.commentConstraintDensity = 0;
    low.parameters!.commentGapMultiplexing = 0;
    low.parameters!.commentReplyIncrement = 0;
    const high = config();
    high.parameters!.commentRoleDiversity = 100;
    high.parameters!.commentConstraintDensity = 100;
    high.parameters!.commentGapMultiplexing = 100;
    high.parameters!.commentReplyIncrement = 100;
    const lowThreads = planTopicOrchestrations({ opportunity: opportunity("low"), gaps, config: low, seeds: [11, 22, 33] }).flatMap((plan) => plan.dialogueThreads);
    const highThreads = planTopicOrchestrations({ opportunity: opportunity("high"), gaps, config: high, seeds: [11, 22, 33] }).flatMap((plan) => plan.dialogueThreads);
    expect(lowThreads.every((thread) => thread.roleCard.constraints.length === 0 && thread.auxiliaryGapIds.length === 0)).toBe(true);
    expect(new Set(lowThreads.map((thread) => thread.roleCard.stage))).toEqual(new Set(["comparing"]));
    expect(highThreads.some((thread) => thread.roleCard.constraints.length === 2)).toBe(true);
    expect(highThreads.some((thread) => thread.auxiliaryGapIds.length === 1)).toBe(true);
    expect(highThreads.some((thread, index) => thread.replyPlan.directAnswer.length > (lowThreads[index]?.replyPlan.directAnswer.length ?? 0))).toBe(true);
    expect(JSON.stringify(highThreads)).not.toMatch(/\d+\s*(?:元|天|公里|岁)/u);
  });

  it("differentiates replyPlan phrasing across thread functions and stays seed-deterministic", () => {
    const scenario = config();
    scenario.content.commentThreadMin = 4;
    scenario.content.commentThreadMax = 4;
    // 评论区线程全部锚定排序第一的 required 主缺口，因此用两组输入分别制造
    // 两种 function：A 组主缺口 required 且无答案 → 全部 next_step（对应真实
    // 样本里 15 线程同措辞的场景）；B 组主缺口 required 且有答案+证据 → 全部
    // verification（真实答案应原样透传，不参与措辞分化）。
    const unansweredGaps: InformationGap[] = [
      {
        id: "fit", label: "适用条件", question: "哪些条件会改变适用性？", category: "decision",
        audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
        boundary: "个体适用性需要单独核验", evidenceIds: ["evidence_d1"], required: true,
      },
      {
        id: "personal_unknown", label: "个人未知条件", question: "还缺哪些个人条件才能判断？", category: "risk",
        audienceStages: ["comparing"], importance: 0.85, decisionLeverage: 0.88, proofability: 0.2,
        evidenceIds: [], required: true,
      },
    ];
    const groundedGaps: InformationGap[] = [
      {
        id: "grounded", label: "核验路径", question: "核验路径是什么？", category: "process",
        audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
        answer: "按资料给出的两步核验", evidenceIds: ["evidence_d1"], required: true,
      },
      {
        id: "open", label: "个人条件", question: "哪些个人条件会改变结论？", category: "risk",
        audienceStages: ["comparing"], importance: 0.85, decisionLeverage: 0.85, proofability: 0.3,
        evidenceIds: [], required: true,
      },
    ];
    const planWith = (gaps: InformationGap[], id: string) => planTopicOrchestrations({
      opportunity: { ...opportunity(id), gapIds: gaps.map((gap) => gap.id) },
      gaps,
      config: scenario,
      seed: 4242,
    }).flatMap((plan) => plan.dialogueThreads);
    const nextStepThreads = planWith(unansweredGaps, "reply-next-step");
    const nextStepThreadsAgain = planWith(unansweredGaps, "reply-next-step");
    const verificationThreads = planWith(groundedGaps, "reply-verification");
    expect(nextStepThreads.length).toBeGreaterThanOrEqual(4);
    expect(verificationThreads.length).toBeGreaterThanOrEqual(4);
    expect(new Set(nextStepThreads.map((thread) => thread.function))).toEqual(new Set(["next_step"]));
    expect(new Set(verificationThreads.map((thread) => thread.function))).toEqual(new Set(["verification"]));
    // 同种子确定性：同输入同输出。
    expect(JSON.stringify(nextStepThreadsAgain.map((thread) => thread.replyPlan)))
      .toBe(JSON.stringify(nextStepThreads.map((thread) => thread.replyPlan)));
    // 同一 function、同一缺口的多条线程：directAnswer / unknown 不再全员同一字面。
    expect(new Set(nextStepThreads.map((thread) => thread.replyPlan.directAnswer)).size).toBeGreaterThan(1);
    expect(new Set(nextStepThreads.map((thread) => thread.replyPlan.unknown)).size).toBeGreaterThan(1);
    expect(new Set(verificationThreads.map((thread) => thread.replyPlan.unknown)).size).toBeGreaterThan(1);
    // 不同 function 的未知路径措辞分化：next_step 至少有一种说法是 verification 组不用的。
    const verificationUnknowns = new Set(verificationThreads.map((thread) => thread.replyPlan.unknown));
    expect(nextStepThreads.some((thread) => !verificationUnknowns.has(thread.replyPlan.unknown))).toBe(true);
    // 有真实答案时 directAnswer 原样透传，不被模板分化改写。
    expect(verificationThreads.every((thread) => thread.replyPlan.directAnswer === "按资料给出的两步核验"
      || thread.replyPlan.directAnswer.startsWith("按资料给出的两步核验；"))).toBe(true);
    // 结构不变：五字段仍然齐全且非空。
    expect([...nextStepThreads, ...verificationThreads]
      .every((thread) => Object.values(thread.replyPlan).every(Boolean))).toBe(true);
  });

  it("honors the configured comment minimum with same-topic non-factual seats", () => {
    const focusedConfig = config();
    focusedConfig.content.commentThreadMin = 3;
    focusedConfig.content.commentThreadMax = 5;
    focusedConfig.content.commentMultiTurnGrowthEnabled = true;
    focusedConfig.content.followUpDepth = 2;
    const painGap: InformationGap = {
      id: "pain_only", label: "疼痛体验", question: "过程中不舒服时如何沟通？", category: "outcome",
      audienceStages: ["hesitating"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
      answer: "过程中可沟通并调整节奏。", evidenceIds: ["evidence_pain"], required: true,
      preferredChannels: ["N.body", "Cref"],
    };
    const plans = planTopicOrchestrations({
      opportunity: {
        ...opportunity("focused-minimum", "疼痛沟通"), gapIds: [painGap.id], audienceStage: "hesitating",
        boundaries: ["不得承诺完全无痛"],
      },
      gaps: [painGap], config: focusedConfig, seeds: [21, 22, 23], expressionStrategies: [{
        id: "pain_strategy", label: "疼痛沟通说明", openingMode: "怕疼先问", narrativeMode: "疼痛反馈",
        bodyRole: "说明沟通节奏", imageRole: "cover", commentMode: "同题追问", voice: "克制",
        sequence: ["疼痛", "沟通"], targetChannels: ["N.body", "Cref"],
        applicability: { gapIds: [painGap.id], audienceStages: ["hesitating"] },
      }],
    });
    for (const plan of plans) {
      expect(plan.focusContract?.mode).toBe("focused");
      expect(plan.dialogueThreads).toHaveLength(3);
      expect(plan.dialogueThreads.filter((thread) => thread.coverageRole === "primary_gap")).toHaveLength(1);
      expect(plan.dialogueThreads.filter((thread) => thread.coverageRole === "topic_anchor")).toHaveLength(2);
      expect(plan.dialogueThreads.slice(1).every((thread) => thread.evidenceIds.length === 0)).toBe(true);
      expect(plan.dialogueThreads.every((thread) => thread.auxiliaryGapIds.length === 0)).toBe(true);
      expect(plan.dialogueThreads.every((thread) => thread.conversationPlan?.targetFollowUps === 0)).toBe(true);
      expect(plan.gapCoverageLedger.effectiveThreadCount).toBe(3);
    }
  });

  it("does not allocate comment gaps or threads when comments are disabled", () => {
    const withoutComments = config();
    withoutComments.expressionWindow.channels = withoutComments.expressionWindow.channels.filter((channel) => channel !== "comments");
    withoutComments.content.commentThreadMin = 0;
    withoutComments.content.commentThreadMax = 0;
    const plans = planTopicOrchestrations({ opportunity: opportunity("body-only"), gaps, config: withoutComments, seed: 15 });

    for (const plan of plans) {
      expect(plan.channelAllocation.Cref).toEqual([]);
      expect(plan.dialogueThreads).toEqual([]);
      expect(plan.effectiveThreadCount).toBe(0);
      expect(plan.gapPlanningCards?.every((card) => !card.plannedPlacements.includes("Cref"))).toBe(true);
      expect(plan.gapPlanningCards?.every((card) => card.plannedPlacements.includes("N.body"))).toBe(true);
    }
  });

  it("caps one post to a focused gap set and records every actually selected gap", () => {
    const constrained = config();
    constrained.content.commentThreadMin = 1;
    constrained.content.commentThreadMax = 1;
    constrained.parameters!.commentGapMultiplexing = 100;
    const selected = { ...opportunity("capacity"), gapIds: extendedGaps.map((gap) => gap.id) };

    const plans = planTopicOrchestrations({ opportunity: selected, gaps: extendedGaps, config: constrained, seed: 90210 });
    for (const plan of plans) {
      const coverage: CommentGapCoverageLedger = plan.gapCoverageLedger;
      expect(coverage).toBeDefined();
      expect(plan.selectedGapIds.length).toBeGreaterThanOrEqual(2);
      expect(plan.selectedGapIds.length).toBeLessThanOrEqual(4);
      expect(coverage.entries.map((entry) => entry.gapId).sort()).toEqual(plan.selectedGapIds.slice().sort());
      expect(coverage.uncoveredGapIds).toEqual([]);
      expect(coverage.effectiveThreadCount).toBe(plan.dialogueThreads.length);
      expect(coverage.targetThreadCount).toBe(1);
      if (coverage.effectiveThreadCount > coverage.targetThreadCount) expect(coverage.capacityWarning).toEqual(expect.any(String));
      const commentOwned = coverage.entries.filter((entry) => entry.commentAllocated).map((entry) => entry.gapId);
      expect(new Set(plan.dialogueThreads.map((thread) => thread.primaryGapId))).toEqual(new Set(commentOwned));
    }
  });

  it("never treats an auxiliary appearance as resolution and never falsely closes an evidence-free gap", () => {
    const expanded = config();
    expanded.parameters!.commentGapMultiplexing = 100;
    const selected = { ...opportunity("ledger"), gapIds: extendedGaps.map((gap) => gap.id) };
    const plans = planTopicOrchestrations({ opportunity: selected, gaps: extendedGaps, config: expanded, seed: 73 });

    for (const plan of plans) {
      const coverage: CommentGapCoverageLedger = plan.gapCoverageLedger;
      for (const entry of coverage.entries) {
        // An auxiliary appearance may enrich a social node, but cannot close
        // the gap by itself or force another FAQ-shaped root thread.
        if (entry.auxiliaryThreadIds.length > 0 && entry.primaryThreadIds.length === 0) {
          expect(entry.status).not.toMatch(/resolved/u);
        }
      }
      const unknown = coverage.entries.find((entry) => entry.gapId === "personal_unknown")!;
      expect(unknown.primaryThreadIds).toHaveLength(0);
      expect(unknown.bodyAllocated).toBe(true);
      expect(unknown.status).toMatch(/^(awaiting_user_input|unknown_with_verification|explicitly_deferred)$/u);
      expect(unknown.status).not.toMatch(/resolved/u);
      expect(unknown.reason).toEqual(expect.any(String));
    }
  });

  it("keeps discovery auditable while rendering a distinct visible person and speech mode", () => {
    const selected = { ...opportunity("discovery"), gapIds: extendedGaps.map((gap) => gap.id) };
    const plans = planTopicOrchestrations({ opportunity: selected, gaps: extendedGaps, config: config(), seed: 1818 });
    for (const thread of plans.flatMap((plan) => plan.dialogueThreads)) {
      const discovery = thread.discoveryPlan;
      expect(discovery).toMatchObject({
        revealTiming: "same_thread",
        difficulty: expect.stringMatching(/^(low|moderate)$/u),
      });
      for (const field of ["cue", "inferencePrompt", "reveal", "selfCheck", "boundary"] as const) {
        expect(discovery[field], `${thread.id}.${field}`).toEqual(expect.any(String));
        expect(discovery[field].trim().length, `${thread.id}.${field}`).toBeGreaterThan(0);
      }
      expect(thread.surfaceRoleCard).toMatchObject({
        displayRole: expect.any(String),
        identityCue: expect.any(String),
        situationCue: expect.any(String),
        speechPattern: expect.any(String),
        lexicalCues: expect.any(Array),
        interactionHook: expect.any(String),
        targetChars: [expect.any(Number), expect.any(Number)],
      });
      expect(thread.conversationPlan).toMatchObject({
        topology: expect.stringMatching(/^(single_exchange|two_turn|three_person_branch|reaction_then_reply|reader_exchange|organic_reaction)$/u),
        targetFollowUps: expect.any(Number),
        openingMove: expect.any(String),
        replyMove: expect.any(String),
        extensionMove: expect.any(String),
      });
      expect(thread.questionIntent.trim().length).toBeGreaterThan(0);
      expect(thread.questionIntent).not.toContain("DirectAnswer");
    }
    for (const plan of plans) {
      expect(new Set(plan.dialogueThreads.map((thread) => thread.surfaceRoleCard?.displayRole)).size)
        .toBeGreaterThanOrEqual(Math.min(3, plan.dialogueThreads.length));
      const plannedFollowUps = plan.dialogueThreads.reduce((total, thread) => total + (thread.conversationPlan?.targetFollowUps ?? 0), 0);
      const lineCapacity = Math.max(0, Math.floor((plan.personaScenePlan.surfaceTargets.visibleCommentLines[1] - plan.dialogueThreads.length * 2) / 2));
      expect(plannedFollowUps).toBeLessThanOrEqual(lineCapacity);
      expect(plan.personaScenePlan.commentNetwork.antiScriptRules.join("\n")).toContain("销售漏斗");
    }
  });

  it("builds stable coverage signatures that change when the structure changes", () => {
    const plans = planTopicOrchestrations({ opportunity: opportunity("topic1"), gaps, config: config(), seeds: [1, 2, 3] });
    const first = createCoverageSignature(plans[0], "方案选择");
    expect(createCoverageSignature(structuredClone(plans[0]), "方案选择")).toEqual(first);
    const second = createCoverageSignature(plans[1], "方案选择");
    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(coverageSignatureDistance(first, second)).toBeGreaterThan(0);
  });

  it("downranks an otherwise equal opportunity when recent content covers the same topic and gaps", () => {
    const covered = opportunity("covered", "已经覆盖的主题");
    const fresh = opportunity("fresh", "新的主题");
    const plan = planTopicOrchestrations({ opportunity: covered, gaps, config: config(), seeds: [1, 2, 3] })[0];
    const recent = createCoverageSignature(plan, covered.topic);
    const ranked = rankTopicOpportunities({ opportunities: [covered, fresh], recentCoverage: [recent] });
    expect(ranked[0]?.opportunity.id).toBe("fresh");
    expect(ranked.find((item) => item.opportunity.id === "covered")?.recentPenalty).toBeGreaterThan(0);
  });

  it("cross-samples independent axes deterministically and yields more than three signatures across seeds", () => {
    const fingerprints = new Set<string>();
    for (let seed = 1; seed <= 8; seed += 1) {
      const first = planTopicOrchestrations({ opportunity: opportunity("topic1"), gaps, config: config(), seed });
      const second = planTopicOrchestrations({ opportunity: opportunity("topic1"), gaps, config: config(), seed });
      expect(second).toEqual(first);
      first.forEach((plan) => fingerprints.add(createCoverageSignature(plan, "方案选择").fingerprint));
    }
    expect(fingerprints.size).toBeGreaterThan(3);
  });

  it("uses editable expression strategies and normalized lock controls in real plans", () => {
    const custom = {
      id: "project_editor_strategy",
      label: "项目编辑策略",
      openingMode: "project_specific_opening",
      narrativeMode: "project_specific_sequence",
      bodyRole: "project_specific_density",
      imageRole: "cover" as const,
      commentMode: "project_specific_topology",
      voice: "project_specific_voice",
      sequence: ["project", "evidence", "boundary"],
      targetChannels: ["N.title", "N.body", "Cref", "N.imageBrief", "H"] as const,
      selectionWeight: 5,
      enabled: true,
    };
    const plans = planTopicOrchestrations({
      opportunity: { ...opportunity("topic1"), gapIds: ["fit"] },
      gaps,
      config: config(),
      seed: 99,
      expressionStrategies: [{ ...custom, targetChannels: [...custom.targetChannels] }],
      options: {
        lockedStrategyId: custom.id,
        lockedGapIds: ["compare"],
        randomizationDimensions: ["opening", "state_seed", "narrative_sequence", "channel_allocation", "body_role", "comment_topology", "voice", "image_role", "gap_order"],
        variationStrength: 0.9,
      },
    });
    expect(plans.every((plan) => plan.strategy.id.startsWith(custom.id))).toBe(true);
    expect(plans.every((plan) => plan.selectedGapIds[0] === "compare")).toBe(true);
    expect(plans.every((plan) => plan.strategy.openingMode === custom.openingMode)).toBe(true);
    expect(plans.every((plan) => plan.strategy.narrativeMode === custom.narrativeMode)).toBe(true);
    expect(plans.every((plan) => plan.strategy.bodyRole === custom.bodyRole)).toBe(true);
    expect(plans.every((plan) => plan.strategy.commentMode === custom.commentMode)).toBe(true);
    expect(plans.every((plan) => plan.strategy.voice === custom.voice)).toBe(true);
    expect(plans.every((plan) => plan.strategy.imageRole === custom.imageRole)).toBe(true);
    expect(plans.every((plan) => JSON.stringify(plan.strategy.targetChannels) === JSON.stringify(custom.targetChannels))).toBe(true);
  });

  it("samples only from the approved project strategy pool when it is present", () => {
    const projectStrategies = [
      {
        id: "approved_a", label: "A", openingMode: "approved_open_a", narrativeMode: "approved_narrative_a",
        bodyRole: "approved_body_a", imageRole: "cover" as const, commentMode: "approved_comment_a", voice: "approved_voice_a",
        sequence: ["a1", "a2"], targetChannels: ["N.title", "N.body", "Cref", "N.imageBrief", "H"] as const,
      },
      {
        id: "approved_b", label: "B", openingMode: "approved_open_b", narrativeMode: "approved_narrative_b",
        bodyRole: "approved_body_b", imageRole: "scene" as const, commentMode: "approved_comment_b", voice: "approved_voice_b",
        sequence: ["b1", "b2", "b3"], targetChannels: ["Cref", "N.body", "H", "N.title", "N.imageBrief"] as const,
      },
      {
        id: "approved_c", label: "C", openingMode: "approved_open_c", narrativeMode: "approved_narrative_c",
        bodyRole: "approved_body_c", imageRole: "evidence" as const, commentMode: "approved_comment_c", voice: "approved_voice_c",
        sequence: ["c1", "c2", "c3", "c4"], targetChannels: ["N.imageBrief", "H", "N.body", "Cref", "N.title"] as const,
      },
    ];
    const plans = planTopicOrchestrations({
      opportunity: opportunity("topic1"),
      gaps,
      config: config(),
      seed: 321,
      expressionStrategies: projectStrategies.map((strategy) => ({ ...strategy, targetChannels: [...strategy.targetChannels] })),
    });
    const openings = new Set(projectStrategies.map((strategy) => strategy.openingMode));
    const narratives = new Set(projectStrategies.map((strategy) => strategy.narrativeMode));
    const bodies = new Set(projectStrategies.map((strategy) => strategy.bodyRole));
    const comments = new Set(projectStrategies.map((strategy) => strategy.commentMode));
    const voices = new Set(projectStrategies.map((strategy) => strategy.voice));
    expect(plans).toHaveLength(3);
    expect(plans.every((plan) => plan.strategy.id.startsWith("approved_"))).toBe(true);
    expect(plans.every((plan) => openings.has(plan.strategy.openingMode))).toBe(true);
    expect(plans.every((plan) => narratives.has(plan.strategy.narrativeMode))).toBe(true);
    expect(plans.every((plan) => bodies.has(plan.strategy.bodyRole))).toBe(true);
    expect(plans.every((plan) => comments.has(plan.strategy.commentMode))).toBe(true);
    expect(plans.every((plan) => voices.has(plan.strategy.voice))).toBe(true);
  });



  it("filters incompatible project strategies and focuses a two-gap organization-information topic", () => {
    const locationGaps: InformationGap[] = [
      {
        id: "org_info", label: "机构信息", question: "机构有哪些可公开信息？", category: "identity",
        audienceStages: ["ready"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.9,
        answer: "机构类型为门诊，地址在锦华万达附近。", evidenceIds: ["evidence_org"], required: true,
        preferredChannels: ["N.body", "Cref"],
      },
      {
        id: "arrival", label: "到院信息", question: "具体位置、预约和交通怎么确认？", category: "location",
        audienceStages: ["ready"], importance: 0.7, decisionLeverage: 0.8, proofability: 0.3,
        answer: "地址在锦华万达附近。", evidenceIds: ["evidence_org"], required: false,
        preferredChannels: ["N.body", "Cref"],
      },
    ];
    const selected: TopicOpportunity = {
      ...opportunity("arrival-focus", "锦华万达附近面诊前确认"),
      angle: "以第一视角走一遍真实到店体验",
      gapIds: locationGaps.map((gap) => gap.id),
      audienceStage: "ready",
      entry: "profile",
      boundaries: ["不能虚构具体客户体验", "地址只公开到锦华万达附近"],
    };
    const strategies = [
      {
        id: "location_only", label: "到院信息核验", prototype: "narrow_request" as const,
        openingMode: "直接问位置", narrativeMode: "地址范围与未知交通", bodyRole: "到院信息说明",
        imageRole: "cover" as const, commentMode: "位置与预约问答", voice: "清楚克制",
        sequence: ["地址范围", "预约未知", "交通未知"], targetChannels: ["N.title", "N.body", "Cref"] as const,
      },
      {
        id: "recovery_sales", label: "第二天上班", prototype: "process_log" as const,
        openingMode: "第二天能否见人", narrativeMode: "恢复时间线", bodyRole: "恢复效果说明",
        imageRole: "before_after" as const, commentMode: "复发保障与恢复追问", voice: "营销自信",
        sequence: ["不红不肿", "一周自然", "满意后付款"], targetChannels: ["N.title", "N.body", "Cref"] as const,
      },
      {
        id: "price_sales", label: "价格透明", prototype: "narrow_request" as const,
        openingMode: "多少钱", narrativeMode: "价格与优惠", bodyRole: "报价和团购",
        imageRole: "cover" as const, commentMode: "价格加项", voice: "转化",
        sequence: ["价格", "优惠", "预约"], targetChannels: ["N.title", "N.body", "Cref"] as const,
      },
    ];
    for (const topology of ["creative_scenario", "institution_owned"] as const) {
      const selectedConfig = config();
      selectedConfig.task.publishingTopology = topology;
      selectedConfig.task.audienceStage = "ready";
      selectedConfig.task.entry = "profile";
      selectedConfig.content.commentMultiTurnGrowthEnabled = true;
      selectedConfig.content.followUpDepth = 2;
      selectedConfig.parameters!.commentConversationRate = 75;
      selectedConfig.parameters!.commentBranchingStrength = 80;
      const plans = planTopicOrchestrations({
        opportunity: selected, gaps: locationGaps, config: selectedConfig, seeds: [1, 2, 3],
        expressionStrategies: strategies.map((strategy) => ({ ...strategy, targetChannels: [...strategy.targetChannels] })),
      });
      for (const plan of plans) {
        expect(plan.focusContract).toMatchObject({
          mode: "focused", allowSocialThreads: false, allowCrossGapBranching: false, allowMultiTurnGrowth: false,
          strategySelection: { mode: "compatible_pool", compatibleStrategyIds: ["location_only"] },
        });
        expect(plan.strategy.id).toBe("location_only");
        expect(plan.focusContract?.strategySelection.rejectedStrategyIds).toEqual(expect.arrayContaining(["recovery_sales", "price_sales"]));
        expect(plan.dialogueThreads).toHaveLength(selectedConfig.content.commentThreadMin);
        expect(plan.dialogueThreads.filter((thread) => thread.coverageRole === "primary_gap")).toHaveLength(2);
        expect(plan.dialogueThreads.filter((thread) => thread.coverageRole === "topic_anchor")).toHaveLength(selectedConfig.content.commentThreadMin - 2);
        expect(plan.dialogueThreads.every((thread) => thread.auxiliaryGapIds.length === 0)).toBe(true);
        expect(plan.dialogueThreads.every((thread) => thread.conversationPlan?.targetFollowUps === 0)).toBe(true);
        const primaryThreads = plan.dialogueThreads.filter((thread) => thread.coverageRole === "primary_gap");
        expect(primaryThreads.every((thread) => Boolean(
          thread.questionContext?.personaLabel
          && thread.questionContext.currentAction
          && thread.questionContext.practicalConstraint
          && thread.questionContext.askingTrigger,
        ))).toBe(true);
        expect(JSON.stringify(plan.dialogueThreads.map((thread) => thread.surfaceRoleCard))).not.toMatch(/价格|多少钱|加项|团购|优惠|效果|恢复/u);
        expect(plan.personaScenePlan?.commentNetwork.multiTurnTarget).toEqual([0, 0]);
        expect(plan.focusContract?.effectiveAngle).not.toContain("真实到店体验");
        if (topology === "institution_owned") expect(plan.focusContract?.effectiveAngle).toContain("明确机构身份");
        else expect(plan.focusContract?.effectiveAngle).toContain("不虚构已经到店");
      }
    }
  });

  it("gives a focused unresolved organization gap one comment owner and a neutral gap-specific role", () => {
    const focusedConfig = config();
    focusedConfig.task.publishingTopology = "institution_owned";
    focusedConfig.content.commentMultiTurnGrowthEnabled = true;
    focusedConfig.content.followUpDepth = 2;
    const selectedGaps: InformationGap[] = [
      {
        id: "org_info", label: "机构信息", question: "机构有哪些可公开、可核验的信息？", category: "boundary",
        audienceStages: ["ready"], importance: 0.9, decisionLeverage: 0.8, proofability: 0,
        evidenceIds: [], required: true, preferredChannels: ["N.body", "Cref"],
      },
      {
        id: "arrival", label: "到院信息", question: "具体位置和预约方式怎么确认？", category: "location",
        audienceStages: ["ready"], importance: 0.8, decisionLeverage: 0.7, proofability: 0.8,
        answer: "地址在锦华万达附近。", evidenceIds: ["evidence_location"], required: false,
        preferredChannels: ["N.body", "Cref"],
      },
    ];
    const plans = planTopicOrchestrations({
      opportunity: {
        ...opportunity("focused-owner"), topic: "面诊前确认机构和到院信息", angle: "先核实再出发",
        gapIds: selectedGaps.map((gap) => gap.id), audienceStage: "ready", entry: "profile",
        boundaries: ["不得公开机构全称", "不得虚构顾客体验"],
      },
      gaps: selectedGaps, config: focusedConfig, seeds: [31, 32, 33],
    });
    for (const plan of plans) {
      const unknown = plan.gapPlanningCards?.find((card) => card.gapId === "org_info");
      expect(unknown?.plannedPlacements).toEqual(["Cref"]);
      expect(unknown?.obligation).toBe("network_required");
      expect(plan.contentIntent?.bodyMustEstablish).not.toContain("org_info");
      const thread = plan.dialogueThreads.find((item) => item.primaryGapId === "org_info")!;
      expect(thread.surfaceRoleCard).toMatchObject({ lexicalCues: [] });
      expect(thread.questionContext).toMatchObject({
        askingTrigger: "机构信息",
        personaLabel: expect.any(String),
        situation: expect.any(String),
        currentAction: expect.any(String),
        practicalConstraint: expect.any(String),
      });
      expect(thread.roleCard.constraints).toEqual([]);
      expect(JSON.stringify(thread.surfaceRoleCard)).not.toMatch(/价格|费用|优惠|效果|恢复/u);
      expect(thread.auxiliaryGapIds).toEqual([]);
      expect(thread.conversationPlan?.targetFollowUps).toBe(0);
    }
  });

  it("does not treat audience-stage-only applicability as topical compatibility", () => {
    const painGap: InformationGap = {
      id: "pain", label: "疼痛体验", question: "过程中不舒服时如何沟通？", category: "outcome",
      audienceStages: ["hesitating"], importance: 0.8, decisionLeverage: 0.8, proofability: 0.8,
      answer: "过程中可沟通并调整节奏。", evidenceIds: ["evidence_pain"], required: true,
    };
    const painStrategy = {
      id: "pain_explainer", label: "疼痛沟通说明", openingMode: "怕疼时先问什么",
      narrativeMode: "疼痛反馈与沟通节奏", bodyRole: "说明疼痛边界", imageRole: "cover" as const,
      commentMode: "疼痛反馈问答", voice: "克制", sequence: ["疼痛", "沟通", "边界"],
      targetChannels: ["N.body", "Cref"] as const,
      applicability: { audienceStages: ["hesitating"] as const },
    };
    const priceStrategy = {
      id: "price_sales", label: "价格优惠", openingMode: "多少钱",
      narrativeMode: "两档价格与团购优惠", bodyRole: "报价转化", imageRole: "cover" as const,
      commentMode: "私信领优惠", voice: "促销", sequence: ["价格", "团购", "付款"],
      targetChannels: ["N.body", "Cref"] as const,
      applicability: { audienceStages: ["hesitating"] as const },
    };
    const selected = { ...opportunity("pain-topic", "术中疼痛沟通"), angle: "不舒服时可以沟通调整节奏", gapIds: [painGap.id], audienceStage: "hesitating" as const };
    const plans = planTopicOrchestrations({
      opportunity: selected, gaps: [painGap], config: config(), seeds: [1, 2, 3],
      expressionStrategies: [painStrategy, priceStrategy].map((strategy) => ({ ...strategy, targetChannels: [...strategy.targetChannels], applicability: { audienceStages: [...strategy.applicability.audienceStages] } })),
    });
    expect(plans.every((plan) => plan.focusContract?.strategySelection.compatibleStrategyIds.includes("pain_explainer"))).toBe(true);
    expect(plans.every((plan) => plan.focusContract?.strategySelection.rejectedStrategyIds.includes("price_sales"))).toBe(true);
    expect(plans.every((plan) => !JSON.stringify(plan.strategy).match(/价格|团购|付款|优惠/u))).toBe(true);
  });

  it("uses a neutral focused strategy when every historical strategy introduces another topic", () => {
    const selectedGap: InformationGap = {
      id: "arrival_only", label: "到院信息", question: "位置和交通如何确认？", category: "location",
      audienceStages: ["ready"], importance: 0.8, decisionLeverage: 0.8, proofability: 0.4,
      evidenceIds: [], required: true, preferredChannels: ["Cref"],
    };
    const incompatible = {
      id: "only_recovery", label: "术后恢复", prototype: "process_log" as const,
      openingMode: "第二天上班", narrativeMode: "恢复时间线", bodyRole: "恢复效果",
      imageRole: "before_after" as const, commentMode: "复发保障", voice: "营销",
      sequence: ["恢复", "效果"], targetChannels: ["N.body", "Cref"] as const,
    };
    const plans = planTopicOrchestrations({
      opportunity: { ...opportunity("neutral-arrival"), topic: "到院位置", angle: "确认路线", gapIds: [selectedGap.id], audienceStage: "ready" },
      gaps: [selectedGap], config: config(), seeds: [4, 5, 6],
      expressionStrategies: [{ ...incompatible, targetChannels: [...incompatible.targetChannels] }],
    });
    expect(plans.every((plan) => plan.focusContract?.strategySelection.mode === "neutral_fallback")).toBe(true);
    expect(plans.every((plan) => plan.focusContract?.mode === "focused")).toBe(true);
    expect(plans.every((plan) => plan.strategy.id.startsWith("neutral_focus_"))).toBe(true);
    expect(plans.every((plan) => !JSON.stringify(plan.strategy).match(/恢复|复发/u))).toBe(true);
    expect(plans.every((plan) => /到院信息/.test(JSON.stringify({
      host: plan.personaScenePlan?.host,
      event: plan.personaScenePlan?.event,
    })))).toBe(true);
    expect(plans.every((plan) => !JSON.stringify({
      host: plan.personaScenePlan?.host,
      event: plan.personaScenePlan?.event,
    }).match(/恢复|复发|价格|优惠|效果/u))).toBe(true);
  });

  it("uses the same compatibility gate outside healthcare without a domain keyword taxonomy", () => {
    const courseGap: InformationGap = {
      id: "campus_route", label: "上课地点", question: "校区在哪里，地铁怎么走？", category: "location",
      audienceStages: ["ready"], importance: 0.8, decisionLeverage: 0.8, proofability: 0.6,
      answer: "校区在大学城附近。", evidenceIds: ["evidence_campus"], required: true,
      preferredChannels: ["N.body", "Cref"],
    };
    const routeStrategy = {
      id: "course_route", label: "校区路线核验", openingMode: "直接问校区位置",
      narrativeMode: "地点与交通说明", bodyRole: "上课地点说明", imageRole: "cover" as const,
      commentMode: "地铁路线问答", voice: "清楚", sequence: ["校区", "地铁", "路线"],
      targetChannels: ["N.title", "N.body", "Cref"] as const,
    };
    const priceStrategy = {
      id: "course_price", label: "课程价格优惠", openingMode: "学费多少钱",
      narrativeMode: "报价与早鸟优惠", bodyRole: "价格转化", imageRole: "cover" as const,
      commentMode: "费用问答", voice: "促销", sequence: ["学费", "优惠", "付款"],
      targetChannels: ["N.title", "N.body", "Cref"] as const,
    };
    const plans = planTopicOrchestrations({
      opportunity: {
        ...opportunity("course-route", "大学城校区怎么走"), angle: "确认上课地点和地铁路线",
        gapIds: [courseGap.id], audienceStage: "ready", entry: "profile",
      },
      gaps: [courseGap], config: config(), seeds: [71, 72, 73],
      expressionStrategies: [routeStrategy, priceStrategy].map((strategy) => ({
        ...strategy, targetChannels: [...strategy.targetChannels],
      })),
    });
    expect(plans.every((plan) => plan.strategy.id === routeStrategy.id)).toBe(true);
    expect(plans.every((plan) => plan.focusContract?.strategySelection.rejectedStrategyIds.includes(priceStrategy.id))).toBe(true);
  });

  it("always returns three deterministic plans for an explicit exact lock across many seeds", () => {
    const locked = {
      id: "exact_locked_policy",
      label: "精确锁定策略",
      openingMode: "locked_opening",
      narrativeMode: "locked_narrative",
      bodyRole: "locked_body_density",
      imageRole: "diagram" as const,
      commentMode: "locked_comment_topology",
      voice: "locked_voice",
      sequence: ["locked_1", "locked_2"],
      targetChannels: ["N.body", "Cref", "N.title", "N.imageBrief", "H"] as const,
      enabled: true,
    };
    for (let seed = 1; seed <= 24; seed += 1) {
      const request = {
        opportunity: { ...opportunity("topic1"), gapIds: ["fit"] },
        gaps,
        config: config(),
        seed,
        expressionStrategies: [{ ...locked, targetChannels: [...locked.targetChannels] }],
        options: {
          lockedStrategyId: locked.id,
          minStructureDistance: 1,
          randomizationDimensions: ["state_seed"] as PlanningRandomizationDimension[],
          variationStrength: 1,
        },
      };
      const first = planTopicOrchestrations(request);
      const second = planTopicOrchestrations(request);
      expect(first).toHaveLength(3);
      expect(second).toEqual(first);
      expect(first.every((plan) => plan.strategy.id === locked.id)).toBe(true);
      expect(first.every((plan) => plan.strategy.openingMode === locked.openingMode)).toBe(true);
      expect(first.every((plan) => plan.strategy.narrativeMode === locked.narrativeMode)).toBe(true);
      expect(first.every((plan) => plan.strategy.bodyRole === locked.bodyRole)).toBe(true);
      expect(first.every((plan) => plan.strategy.commentMode === locked.commentMode)).toBe(true);
      expect(first.every((plan) => plan.strategy.voice === locked.voice)).toBe(true);
      expect(first.every((plan) => plan.strategy.imageRole === locked.imageRole)).toBe(true);
      expect(first.every((plan) => JSON.stringify(plan.strategy.sequence) === JSON.stringify(locked.sequence))).toBe(true);
      expect(first.every((plan) => JSON.stringify(plan.strategy.targetChannels) === JSON.stringify(locked.targetChannels))).toBe(true);
    }
  });
});

describe("P3 comment orchestration contract", () => {
  /** One gap per derivation branch: grounded answer / required-unknown / optional-unknown. */
  const branchGaps: InformationGap[] = [
    {
      id: "answered", label: "恢复时间", question: "恢复大概要多久？", category: "process",
      audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
      answer: "资料中确认的标准恢复口径", evidenceIds: ["evidence_d1"], required: false,
      preferredChannels: ["Cref"],
    },
    {
      id: "required_unknown", label: "适用条件", question: "哪些条件会改变适用性？", category: "decision",
      audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.7,
      boundary: "个体适用性需要单独核验", evidenceIds: [], required: true,
      preferredChannels: ["Cref"],
    },
    {
      id: "optional_unknown", label: "比较维度", question: "应该按哪些维度比较？", category: "comparison",
      audienceStages: ["comparing"], importance: 0.7, decisionLeverage: 0.6, proofability: 0.6,
      evidenceIds: [], required: false,
      preferredChannels: ["Cref"],
    },
  ];

  /** A locked neutral strategy: no counterexample in the commentMode, so tests are sampling-independent. */
  const neutralStrategy = {
    id: "neutral_qa_strategy", label: "中性问答策略", openingMode: "neutral_opening", narrativeMode: "neutral_narrative",
    bodyRole: "neutral_body", imageRole: "cover" as const, commentMode: "plain_verification_threads",
    voice: "neutral_voice", sequence: ["neutral"], targetChannels: ["N.title", "N.body", "Cref"] as const,
    selectionWeight: 1, enabled: true,
  };
  const neutralOptions = { lockedStrategyId: neutralStrategy.id };
  const neutralStrategies = () => [{ ...neutralStrategy, targetChannels: [...neutralStrategy.targetChannels] }];

  function branchPlans(seeds: [number, number, number] = [7, 8, 9]) {
    return planTopicOrchestrations({
      opportunity: { ...opportunity("p3-branch"), gapIds: ["answered", "required_unknown", "optional_unknown"] },
      gaps: branchGaps,
      config: config(),
      seeds,
      expressionStrategies: neutralStrategies(),
      options: neutralOptions,
    });
  }

  it("derives each thread function from its gap card content instead of rotating by position", () => {
    for (const plan of branchPlans()) {
      const byGap = new Map(plan.dialogueThreads.map((thread) => [thread.gapId, thread.function]));
      // grounded answer + evidence → verification; required without answer → next_step; else clarify.
      expect(byGap.get("answered")).toBe("verification");
      expect(byGap.get("required_unknown")).toBe("next_step");
      expect(byGap.get("optional_unknown")).toBe("clarify");
      // The locked neutral strategy carries no counterexample mode, so none is assigned.
      expect(plan.dialogueThreads.every((thread) => thread.function !== "counterexample")).toBe(true);
    }
  });

  it("assigns exactly one counterexample thread, and only when the strategy commentMode carries one", () => {
    const counterexampleStrategy = {
      id: "cx_strategy", label: "反例策略", openingMode: "cx_opening", narrativeMode: "cx_narrative",
      bodyRole: "cx_body", imageRole: "cover" as const, commentMode: "identity_route_counterexample",
      voice: "cx_voice", sequence: ["cx"], targetChannels: ["N.title", "N.body", "Cref"] as const,
      selectionWeight: 1, enabled: true,
    };
    const plans = planTopicOrchestrations({
      opportunity: { ...opportunity("p3-cx"), gapIds: ["answered", "required_unknown", "optional_unknown"] },
      gaps: branchGaps,
      config: config(),
      seeds: [7, 8, 9],
      expressionStrategies: [{ ...counterexampleStrategy, targetChannels: [...counterexampleStrategy.targetChannels] }],
      options: { lockedStrategyId: counterexampleStrategy.id },
    });
    for (const plan of plans) {
      expect(plan.strategy.commentMode).toContain("counterexample");
      // The single promotion lands on the only clarify slot; grounded/required
      // semantics are never overridden by the mode.
      expect(plan.dialogueThreads.filter((thread) => thread.function === "counterexample")).toHaveLength(1);
      expect(plan.dialogueThreads.find((thread) => thread.gapId === "optional_unknown")?.function).toBe("counterexample");
      expect(plan.dialogueThreads.find((thread) => thread.gapId === "answered")?.function).toBe("verification");
      expect(plan.dialogueThreads.find((thread) => thread.gapId === "required_unknown")?.function).toBe("next_step");
    }
  });

  it("derives nextStep per thread across the grounded / routed / empty branches", () => {
    const blankGap: InformationGap = {
      id: "blank", label: "", question: "", category: "decision",
      audienceStages: ["comparing"], importance: 0.5, decisionLeverage: 0.5, proofability: 0.5,
      evidenceIds: [], required: false, preferredChannels: ["Cref"],
    };
    const wideConfig = config();
    // Breadth 85 lifts the per-post gap limit to 4 so every branch gap is selected.
    wideConfig.parameters!.informationBreadth = 85;
    const plans = planTopicOrchestrations({
      opportunity: { ...opportunity("p3-next"), gapIds: ["answered", "required_unknown", "optional_unknown", "blank"] },
      gaps: [...branchGaps, blankGap],
      config: wideConfig,
      seeds: [7, 8, 9],
      expressionStrategies: neutralStrategies(),
      options: neutralOptions,
    });
    for (const plan of plans) {
      expect(plan.selectedGapIds).toHaveLength(4);
      const byGap = new Map(plan.dialogueThreads.map((thread) => [thread.gapId, thread.nextStep]));
      // Grounded: verify own applicability against the evidence sources.
      expect(byGap.get("answered")).toBe("核实自己的适用条件");
      // Unanswered but verifiable: a concrete "verify what with whom" sentence in
      // natural language built from the card — never raw field names.
      const routed = byGap.get("required_unknown")!;
      expect(routed).toContain("核实");
      expect(routed).toContain("哪些条件会改变适用性？");
      expect(routed).toContain("个体适用性需要单独核验");
      expect(routed).not.toMatch(/boundary|label|question/iu);
      // No usable information at all: the conservative fallback.
      expect(byGap.get("blank")).toBe("先补充可信来源，再形成结论");
    }
  });

  it("gates the multi-turn target and per-thread growth plan on the growth switch (P2-11)", () => {
    const growthOff = config();
    const growthOn = config();
    growthOn.content.commentMultiTurnGrowthEnabled = true;
    const input = { opportunity: opportunity("p3-growth"), gaps, seeds: [11, 22, 33] as [number, number, number] };
    const offPlans = planTopicOrchestrations({ ...input, config: growthOff });
    const onPlans = planTopicOrchestrations({ ...input, config: growthOn });
    for (const plan of offPlans) {
      // Switch off: the honest target is zero, so comment_network_under_grown
      // cannot false-positive, and no thread plans follow-ups the engine would skip.
      expect(plan.personaScenePlan?.commentNetwork.multiTurnTarget).toEqual([0, 0]);
      expect(plan.dialogueThreads.every((thread) => (thread.conversationPlan?.targetFollowUps ?? 0) === 0)).toBe(true);
    }
    for (const plan of onPlans) {
      expect(plan.personaScenePlan!.commentNetwork.multiTurnTarget[1]).toBeGreaterThan(0);
      expect(plan.dialogueThreads.some((thread) => (thread.conversationPlan?.targetFollowUps ?? 0) > 0)).toBe(true);
    }
  });

  it("emits a publisher-owned deployment plan with legal pinPriority values and structured aC fields", () => {
    const legalFunctions = new Set(["surface_gap", "answer", "clarify", "counterexample", "verification", "next_step"]);
    const plans = planTopicOrchestrations({ opportunity: opportunity("p3-ac"), gaps, config: config(), seeds: [11, 22, 33] });
    for (const plan of plans) {
      const deployment = plan.deploymentPlan;
      expect(deployment.postingIdentity).toBe("publisher");
      // "boundary" was never a legal thread function; every entry must be in the enum.
      expect(deployment.pinPriority.length).toBeGreaterThan(0);
      expect(deployment.pinPriority.every((item) => legalFunctions.has(item))).toBe(true);
      expect(typeof deployment.sla).toBe("string");
      expect(deployment.sla!.length).toBeGreaterThan(0);
      // Structured live routing: every rule names route / condition / action.
      expect(deployment.liveRouting.length).toBeGreaterThan(0);
      for (const rule of deployment.liveRouting) {
        if (typeof rule === "string") throw new Error("liveRouting must be structured {route, condition, action} entries");
        expect(rule.route).toBeTruthy();
        expect(rule.condition).toBeTruthy();
        expect(rule.action).toBeTruthy();
      }
      expect(deployment.updatePolicy?.every((item) => item.length > 0)).toBe(true);
      // F03: aC operating rules stay on the deployment plan and never leak into Cref copy.
      expect(plan.dialogueThreads.every((thread) => !thread.questionIntent.includes("工作日 24h"))).toBe(true);
    }
  });
});

describe("speaker disclosure routing", () => {
  it("keeps public organization facts for accountable comments but removes them from a consumer body allocation", () => {
    const organizationGap: InformationGap = {
      id: "org_public_info",
      label: "机构信息",
      question: "机构全称是否可以对外公开？",
      category: "location",
      audienceStages: ["comparing"],
      importance: 0.9,
      decisionLeverage: 0.8,
      proofability: 0.9,
      answer: "机构类型为门诊，地址在锦华万达附近；机构全称不对外公开。",
      boundary: "不得公开机构全称，可公开地址和门诊类型。",
      evidenceIds: ["evidence_org"],
      required: true,
      preferredChannels: ["N.body", "Cref"],
    };
    const selected = {
      ...opportunity("organization-disclosure"),
      gapIds: [organizationGap.id],
      evidenceIds: ["evidence_org"],
    };
    const consumerConfig = config();
    const institutionConfig = config();
    institutionConfig.task.publishingTopology = "institution_owned";
    const consumerPlans = planTopicOrchestrations({
      opportunity: selected,
      gaps: [organizationGap],
      config: consumerConfig,
      seeds: [101, 202, 303],
    });
    const institutionPlans = planTopicOrchestrations({
      opportunity: selected,
      gaps: [organizationGap],
      config: institutionConfig,
      seeds: [101, 202, 303],
    });

    expect(consumerPlans).toHaveLength(3);
    expect(institutionPlans).toHaveLength(3);
    for (const [plans, bodyAllowed] of [[consumerPlans, false], [institutionPlans, true]] as const) {
      for (const plan of plans) {
        const card = plan.gapPlanningCards?.find((item) => item.gapId === organizationGap.id);
        expect(card?.disclosureScope).toBe("organization_only");
        expect(card?.plannedPlacements).toContain("Cref");
        if (bodyAllowed) expect(card?.plannedPlacements).toContain("N.body");
        else expect(card?.plannedPlacements).not.toContain("N.body");
        expect(card?.answer).toContain("锦华万达附近");
        expect(card?.answer).not.toContain("不对外公开");
        expect(card?.question).not.toMatch(/全称.*公开/u);
        expect(card?.boundary ?? "").not.toContain("不得公开机构全称");
      }
    }
  });
});
