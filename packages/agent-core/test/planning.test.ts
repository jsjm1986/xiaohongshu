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
    expect(OpportunityRankHeuristicV1DefaultPolicy).toEqual({
      minProofability: 0.35,
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
      policy: { minProofability: 0.35, maxRisk: 0.7, recentPenaltyWeight: 0.35, reuseCooldown: 12 },
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
    expect(filterTopicOpportunities([candidate])).toEqual([]);
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

  it("filters blocked, weakly proofable and high-risk opportunities", () => {
    const blocked = { ...opportunity("blocked"), status: "blocked" as const };
    const weak = { ...opportunity("weak"), proofability: 0.1 };
    const risky = { ...opportunity("risky"), risk: 0.95 };
    expect(filterTopicOpportunities([blocked, weak, risky, opportunity("ok")]).map((item) => item.id)).toEqual(["ok"]);
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
    expect(dialogueThreads.every((thread) => thread.simulated && thread.speakerType === "simulated_reader" && thread.postingIdentity !== "reader_question_template")).toBe(true);
    expect(new Set(dialogueThreads.map((thread) => thread.personaRole)).size).toBeGreaterThan(1);
    expect(new Set(plans[0].dialogueThreads.map((thread) => thread.function)).size).toBeGreaterThan(1);
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
        topology: expect.stringMatching(/^(single_exchange|two_turn|three_person_branch|reaction_then_reply)$/u),
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
