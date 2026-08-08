// Feature: content-methodology-self-consistency, Task 7.6 — M7 required-mechanism regression.
//
// Validates: Requirements 7.7 (design 组件 E · E1 / E3 / E4).
//
// M7 (需求 7) converges comment-orchestration complexity, but requirement 7.7 is a
// GUARD: "IF making a comment mechanism non-required would invalidate a
// pre-convergence valid output OR break the pipeline, THEN keep it required."
// Tasks 7.1–7.3 already downgraded discoveryPlan / densityProxy / multi-turn growth
// to non-essential (proven non-breaking by comment-convergence.property.test.ts and
// content-prompt-revision.test.ts). This suite proves the CONVERSE: the mechanisms
// M7 deliberately KEPT required (design 组件 E · E1 判定表 rows marked "必需保留")
// are genuinely load-bearing — omitting / weakening them raises an `error`-level
// hard gate, so downgrading them would let invalid output slip through.
//
// It is an example / regression suite (NOT a property test) and intentionally does
// NOT re-assert the non-essential mechanisms — that would duplicate 7.1–7.3 / 7.5.
// Fixtures reuse the recipe in content-prompt-revision.test.ts (JSON + parseGenerationDraft,
// real plans from planTopicOrchestrations) to keep cost low.
//
// Required mechanisms exercised here:
//   1. gapCoverageLedger  — required缺口静默丢失 is an `error` (comment_gap_missing_primary /
//      comment_gap_silently_dropped). Removing the ledger (no orchestrationPlan) downgrades
//      the very same defect to a mere `warning`, i.e. a dropped required gap would slip
//      through → the ledger MUST stay required (7.7).
//   2. persona-scene role grounding (角色接地) — an undisclosed / fabricated role constraint
//      is an `error` (comment_role_constraint_ungrounded); the same constraint is accepted
//      only once it is disclosed. Downgrading this would let simulated roles assert
//      ungrounded facts → it MUST stay required (7.7).

import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  parseGenerationDraft,
  planTopicOrchestrations,
  validateGenerationDraft,
} from "../src/index.js";
import type { DialogueThreadPlan, InformationGap, TopicOpportunity } from "../src/index.js";

const project = {
  id: "p76",
  name: "测试项目",
  domain: "决策信息",
  productPoints: [] as string[],
  organizationPoints: [] as string[],
  cities: [] as string[],
  doctors: [] as { name: string; points: string[] }[],
};

type Issue = ReturnType<typeof validateGenerationDraft>[number];
const errorCodesOf = (issues: Issue[]): string[] =>
  issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);

// ---------------------------------------------------------------------------
// 1. gapCoverageLedger is a required structural-validity mechanism.
// ---------------------------------------------------------------------------

function gapLedgerConfig() {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "先核实再决定";
  config.content.bodyMinChars = 5;
  config.content.bodyMaxChars = 800;
  config.content.hashtagMin = 0;
  config.content.hashtagMax = 10;
  config.content.commentThreadMin = 1;
  config.content.commentThreadMax = 3;
  return config;
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
    answer: "先核实适用条件",
    boundary: "个体差异需单独核验",
    evidenceIds: ["evidence_d1"],
    required: true,
    preferredChannels: ["Cref"],
  },
  {
    id: "cost",
    label: "成本范围",
    question: "成本大致区间与影响因素？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.8,
    decisionLeverage: 0.8,
    proofability: 0.7,
    answer: "先确认成本范围",
    boundary: "价格随方案变化",
    evidenceIds: ["evidence_d1"],
    required: true,
    preferredChannels: ["Cref"],
  },
];

const opportunity: TopicOpportunity = {
  id: "topic-required-mechanisms",
  topic: "先核实再决定",
  angle: "核验路径",
  gapIds: ["fit", "cost"],
  audienceStage: "comparing",
  entry: "search",
  relevance: 0.9,
  importance: 0.9,
  proofability: 0.8,
  novelty: 0.5,
  decisionLeverage: 0.9,
  cognitiveCost: 0.2,
  risk: 0.2,
  evidenceIds: ["evidence_d1"],
  boundaries: ["个体差异需单独核验"],
  tags: [],
  imageAssetIds: [],
  status: "eligible",
};

// Faithfully render a planned thread into a final visible thread that stays bound to
// its planned primary gap (mirrors content-prompt-revision.test.ts). parseGenerationDraft
// preserves the explicit string id, so coverage matching against the plan works.
function threadJson(planned: DialogueThreadPlan) {
  return {
    id: planned.id,
    stage: planned.stage,
    gap: planned.gapId,
    function: planned.function,
    nextStep: planned.nextStep,
    question: planned.questionIntent,
    answer: [planned.replyPlan.directAnswer, planned.replyPlan.condition, planned.replyPlan.boundary]
      .filter(Boolean)
      .join("；"),
    followUps: [],
    postingIdentity: planned.postingIdentity,
    sourceClusterIds: planned.sourceClusterIds,
    evidenceIds: [],
    personaRole: planned.personaRole,
    speakerType: planned.speakerType,
    claimStatus: "bounded",
    replyTo: null,
    threadDepth: 0,
    simulated: true,
    simulationLabel: planned.simulationLabel,
    roleCard: planned.roleCard,
    primaryGapId: planned.primaryGapId,
    auxiliaryGapIds: planned.auxiliaryGapIds,
    densityProxy: planned.densityProxy,
    replyPlan: planned.replyPlan,
    discoveryPlan: planned.discoveryPlan,
  };
}

function draftJson(threads: ReturnType<typeof threadJson>[]) {
  return {
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: {
        imageBrief: "清单式封面",
        title: "先核实再决定",
        body: "这段正文先区分已知与未知，再自行判断是否适用，并保留个体差异的边界，避免过度外推。",
      },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  };
}

describe("M7 required-mechanism regression: gapCoverageLedger stays required (需求 7.7)", () => {
  it("raises an error when a required gap is dropped, but only a warning once the ledger mechanism is removed", () => {
    const config = gapLedgerConfig();
    const ledger = buildKnowledgeLedger([]);
    const allowedEvidenceIds = ["evidence_d1"];
    const plan = planTopicOrchestrations({ opportunity, gaps, config, seed: 21 })[0];

    // A required gap that actually owns a comment thread (so it is comment-allocated).
    const droppedGapId = plan.dialogueThreads[0]!.primaryGapId;

    // Baseline: every selected gap is covered by its planned primary thread → the
    // gap-coverage mechanism is satisfied (no drop error).
    const baselineDraft = parseGenerationDraft(JSON.stringify(draftJson(plan.dialogueThreads.map(threadJson))));
    const baselineErrors = errorCodesOf(
      validateGenerationDraft({ draft: baselineDraft, config, ledger, allowedEvidenceIds, orchestrationPlan: plan }),
    );
    expect(baselineErrors).not.toContain("comment_gap_silently_dropped");
    expect(baselineErrors).not.toContain("comment_gap_missing_primary");

    // (a) Draft-side silent drop: omit the visible thread for a required, comment-owned
    // gap. The ledger catches it as an ERROR — proving it does required work.
    const omissionDraft = parseGenerationDraft(
      JSON.stringify(draftJson(plan.dialogueThreads.filter((t) => t.primaryGapId !== droppedGapId).map(threadJson))),
    );
    const omissionIssues = validateGenerationDraft({
      draft: omissionDraft,
      config,
      ledger,
      allowedEvidenceIds,
      orchestrationPlan: plan,
    });
    expect(omissionIssues).toContainEqual(
      expect.objectContaining({ code: "comment_gap_missing_primary", severity: "warning", disposition: "review" }),
    );

    // (b) Ledger-level silent drop: the required gap is dropped from the coverage ledger
    // itself while still selected → comment_gap_silently_dropped (the exact code the
    // mechanism exists to raise).
    const tamperedPlan = structuredClone(plan);
    tamperedPlan.gapCoverageLedger.entries = tamperedPlan.gapCoverageLedger.entries.filter(
      (entry) => entry.gapId !== droppedGapId,
    );
    const tamperedIssues = validateGenerationDraft({
      draft: baselineDraft,
      config,
      ledger,
      allowedEvidenceIds,
      orchestrationPlan: tamperedPlan,
    });
    expect(tamperedIssues).toContainEqual(
      expect.objectContaining({ code: "comment_gap_silently_dropped", severity: "warning", disposition: "review" }),
    );

    // Necessity per 7.7: if the ledger mechanism were made non-required (no orchestration
    // plan is supplied), the SAME silent gap loss is only a `warning` and NONE of the
    // above errors fire — invalid output would pass. Hence the ledger must stay required.
    const withoutLedger = validateGenerationDraft({ draft: omissionDraft, config, ledger, allowedEvidenceIds });
    expect(withoutLedger).toContainEqual(
      expect.objectContaining({ code: "comment_gap_coverage_ledger_missing", severity: "warning" }),
    );
    const withoutLedgerErrors = errorCodesOf(withoutLedger);
    expect(withoutLedgerErrors).not.toContain("comment_gap_missing_primary");
    expect(withoutLedgerErrors).not.toContain("comment_gap_silently_dropped");
  });
});

// ---------------------------------------------------------------------------
// 2. persona-scene role grounding is a required structural/safety mechanism.
// ---------------------------------------------------------------------------

function roleConfig(boundaries: string[]) {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "角色接地";
  config.content.bodyMinChars = 5;
  config.content.bodyMaxChars = 500;
  config.content.hashtagMin = 2;
  config.content.hashtagMax = 6;
  config.content.commentThreadMin = 1;
  config.content.commentThreadMax = 1;
  config.informationWindow.boundaries = boundaries;
  return config;
}

// One valid one-primary-gap thread (roleCard + primaryGapId + replyPlan) whose only
// variable is a single role constraint. The persona-scene role card is part of the
// (a)+(b) required backbone (design 组件 E · E1), so a simulated role may only assert
// constraints that were disclosed or explicitly marked for verification.
function roleGroundingDraft(constraint: string) {
  return parseGenerationDraft(
    JSON.stringify({
      content: {
        H: { hashtags: ["信息", "选择"] },
        N: {
          imageBrief: "清单式封面",
          title: "先核实再决定",
          body: "这段正文先区分已知与未知，再自行判断是否适用，并保留个体差异的边界。",
        },
        Cref: {
          disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。",
          threads: [
            {
              id: "t1",
              stage: "collecting",
              gap: "fit",
              function: "clarify",
              nextStep: "继续核实适用条件",
              question: "适用条件应该怎么核实？",
              answer: "先按现有资料判断适用条件；个人情况仍然未知，需要自己确认。",
              followUps: [],
              postingIdentity: "author",
              sourceClusterIds: ["d1"],
              evidenceIds: [],
              personaRole: "information_collector",
              speakerType: "simulated_reader",
              claimStatus: "bounded",
              replyTo: null,
              threadDepth: 0,
              simulated: true,
              simulationLabel: "模拟潜在读者情景",
              roleCard: {
                stage: "collecting",
                knowledge: ["已看到可核验资料"],
                constraints: [constraint],
                decisionTask: "判断适用性",
                evidenceStance: "verification_seeking",
              },
              primaryGapId: "fit",
              auxiliaryGapIds: [],
              replyPlan: {
                directAnswer: "先核实适用条件",
                condition: "只在已知条件内",
                boundary: "不代填个人情况",
                unknown: "个人情况仍然未知",
                nextQuestion: "还有哪项会改变判断",
              },
            },
          ],
        },
      },
      evidenceIds: [],
      reasoning: [],
      unknowns: [],
    }),
  );
}

describe("M7 required-mechanism regression: persona-scene role grounding stays required (需求 7.7)", () => {
  it("rejects an ungrounded role constraint as an error but accepts the same constraint once disclosed", () => {
    const ledger = buildKnowledgeLedger([]);

    // Undisclosed fabricated constraint ("预算是5000元") → error hard gate fires.
    const ungrounded = validateGenerationDraft({
      draft: roleGroundingDraft("预算是5000元"),
      config: roleConfig(["不能保证个体结果"]),
      ledger,
      allowedEvidenceIds: [],
    });
    expect(ungrounded).toContainEqual(
      expect.objectContaining({ code: "comment_role_constraint_ungrounded", severity: "warning", disposition: "review" }),
    );

    // Control: the SAME constraint is grounded once disclosed in the information window,
    // so the hard gate no longer fires — confirming the check is specifically about
    // grounding, not incidental. Because this mechanism is an error-level gate, making it
    // non-required would let a simulated role assert ungrounded facts → it stays required.
    const grounded = validateGenerationDraft({
      draft: roleGroundingDraft("预算是5000元"),
      config: roleConfig(["不能保证个体结果", "预算是5000元"]),
      ledger,
      allowedEvidenceIds: [],
    });
    expect(errorCodesOf(grounded)).not.toContain("comment_role_constraint_ungrounded");
  });
});
