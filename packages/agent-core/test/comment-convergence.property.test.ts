// Feature: content-methodology-self-consistency, Property 9: 评论编排收敛保持有效输出与管线可运行
//
// Validates: Requirements 7.3, 7.4, 7.5
//
// Property 9 — comment-orchestration convergence preserves valid output and a
// runnable pipeline. For ANY planning input that could successfully produce a
// valid output before convergence, after the (already-applied) M7 convergence:
//   (7.3) the content-generation pipeline still completes without an error
//         termination;
//   (7.4) that pre-convergence valid output still satisfies structural-validity
//         validation (no error-severity issues);
//   (7.5) when formal generation omits the mechanisms that were downgraded to
//         non-essential (discoveryPlan streamlined to boundary-only /
//         densityProxy not produced / multi-turn growth off by default), it
//         still completes and yields a structurally-valid output.
//
// Design mapping: design §"Correctness Properties · Property 9" and component E
// (M7). Two faithful mechanisms, each mirroring a pattern the existing tests
// already proved feasible, are combined inside the single property:
//
//   Mechanism 1 — the deterministic generation pipeline. `ContentGenerationAgent`
//   with NO model provider runs the real staged pipeline (planning ->
//   deterministic draft -> validateGenerationDraft) and reports per-package
//   validity (see config-engine.test.ts). This proves (7.3)+(7.4). Crucially the
//   deterministic path NEVER invokes the multi-turn growth pass (stage 2B is
//   provider-only), so a valid output produced here is a valid output produced
//   with the growth mechanism omitted — directly proving growth is non-essential
//   (7.5, growth). We randomize the convergence-relevant knobs (followUpDepth,
//   commentConversationRate, the commentMultiTurnGrowthEnabled switch, gap count)
//   over a valid envelope.
//
//   Mechanism 2 — validateGenerationDraft directly (see content-prompt-revision
//   .test.ts). For a valid comment structure carrying full discoveryPlan +
//   densityProxy, omitting those two downgraded mechanisms (discoveryPlan ->
//   boundary-only, densityProxy removed) introduces NO error-severity issue and,
//   specifically, none of the discovery/density hard-gate codes — proving those
//   two mechanisms are non-essential to structural validity (7.5,
//   discoveryPlan/densityProxy). The retained safety checks stay correct on the
//   streamlined form.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildKnowledgeLedger,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  parseGenerationDraft,
  validateGenerationDraft,
} from "../src/index.js";
import type { GenerationDraft, ResolvedGenerationConfig } from "../src/index.js";

const project = {
  id: "p9",
  name: "测试项目",
  domain: "决策信息",
  productPoints: ["资料中确认了产品要点"],
  organizationPoints: ["资料中确认了服务边界"],
  cities: ["上海"],
  doctors: [{ name: "张医生", points: ["资料中列出的专业方向"] }],
};

// Small deterministic knowledge base, identical in spirit to the proven-good
// config-engine.test.ts fixture, so the no-provider deterministic pipeline
// reliably reaches valid output.
const knowledge = [
  indexKnowledgeSource({ projectId: "p9", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p9", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

const GAP_POOL = ["适合谁", "如何比较", "哪些未知", "要花多少"];

// The hard-gate codes that would (wrongly) fire if the downgraded discoveryPlan
// / densityProxy mechanisms were still required, or if omitting them broke
// structural validity. `comment_discovery_plan_missing` is intentionally NOT in
// this list: it is a warning, and a streamlined `{ boundary }` plan is still
// "present" so it never fires.
const DISCOVERY_DENSITY_ERROR_CODES = [
  "comment_density_metadata_incomplete",
  "comment_density_proxy_mismatch",
  "comment_discovery_withholding",
  "comment_discovery_false_closure",
  "comment_discovery_as_evidence",
];

// Mechanism 1: build a resolved config over the known-good envelope, varying only
// the comment-orchestration convergence knobs.
function buildPipelineConfig(input: {
  followUpDepth: number;
  conversationRate: number;
  growthEnabled: boolean;
  gapCount: number;
}): ResolvedGenerationConfig {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "方案选择";
  config.task.city = "上海";
  config.task.mustMention = ["适用边界"];
  config.informationWindow.gaps = GAP_POOL.slice(0, input.gapCount);
  config.informationWindow.boundaries = ["不能保证个体结果"];
  config.content.bodyMinChars = 120;
  config.content.bodyMaxChars = 800;
  config.content.hashtagMin = 3;
  config.content.hashtagMax = 6;
  config.content.commentThreadMin = 2;
  config.content.commentThreadMax = 4;
  config.content.followUpDepth = input.followUpDepth;
  // The multi-turn growth pass (stage 2B) is a conservative opt-in switch. In the
  // deterministic (no-provider) pipeline it is never invoked regardless of this
  // flag, so toggling it here demonstrates the pipeline stays valid with the
  // growth mechanism omitted.
  config.content.commentMultiTurnGrowthEnabled = input.growthEnabled;
  config.parameters!.commentConversationRate = input.conversationRate;
  config.knowledge.maxInputTokens = 20_000;
  config.knowledge.outputReserveTokens = 1_000;
  config.knowledge.safetyMarginTokens = 100;
  return config;
}

// Mechanism 2: distinct, benign comment structures carrying a full discoveryPlan
// and a self-consistent densityProxy. Each thread is a valid one-primary-gap
// unit (roleCard + primaryGapId + replyPlan), mirroring the proven recipe in
// content-prompt-revision.test.ts.
const QUESTION_POOL = [
  "适合谁来做这件事，应该怎么判断？",
  "不同做法之间，应该按哪些点来比较？",
  "还有哪些地方目前是未知、需要自己确认的？",
];
const ANSWER_POOL = [
  "先看现有资料能不能对上你的情况；对不上的先留着，别急着下结论。",
  "把几种做法的关键差别列出来，再挑对你最要紧的那一两点去比。",
  "没覆盖到的部分就先当成未知，记下来之后单独去确认。",
];

function buildCommentDraftJson(threadCount: number): unknown {
  const threads = Array.from({ length: threadCount }, (_, index) => ({
    id: `t${index + 1}`,
    stage: "collecting",
    gap: `fit${index}`,
    function: "clarify",
    nextStep: `继续确认第${index + 1}项条件`,
    question: QUESTION_POOL[index]!,
    answer: ANSWER_POOL[index]!,
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
    roleCard: { stage: "collecting", knowledge: [], constraints: [], decisionTask: "判断适用性", evidenceStance: "verification_seeking" },
    primaryGapId: `fit${index}`,
    auxiliaryGapIds: [],
    densityProxy: { primaryGapCount: 1, auxiliaryDimensionCount: 0, roleDimensionCount: 4, constraintCount: 0, expectedReplyComponents: 5, questionTargetChars: 22 },
    replyPlan: { directAnswer: "先按现有资料判断", condition: "只在已知条件内", boundary: "不代填个人情况", unknown: "个人情况仍然未知", nextQuestion: "还有哪项会改变判断" },
    discoveryPlan: { cue: "先看哪项条件更关键", inferencePrompt: "自己判断资料是否够用", reveal: "现有资料只能给出核对方向", selfCheck: "是否仍缺个人条件", boundary: "不能把未知个人条件当成事实", revealTiming: "same_thread", difficulty: "moderate" },
  }));
  return {
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先看清楚，再决定", body: "这是一段保留边界的说明，帮助读者把已知和未知分开，再自行判断是否适用于自己的情况。" },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  };
}

// Omit the two downgraded mechanisms: streamline every discoveryPlan to keep only
// its `boundary`, and drop densityProxy entirely.
function omitDowngradedMechanisms(draft: GenerationDraft): GenerationDraft {
  const next = structuredClone(draft);
  for (const thread of next.content.Cref.threads) {
    if (thread.discoveryPlan) thread.discoveryPlan = { boundary: thread.discoveryPlan.boundary };
    delete thread.densityProxy;
  }
  return next;
}

function commentValidationConfig(): ResolvedGenerationConfig {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "评论收敛";
  config.content.bodyMinChars = 5;
  config.content.bodyMaxChars = 500;
  config.content.hashtagMin = 2;
  config.content.hashtagMax = 6;
  config.content.commentThreadMin = 1;
  config.content.commentThreadMax = 5;
  return config;
}

const errorCodes = (issues: ReturnType<typeof validateGenerationDraft>): string[] =>
  issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);

const inputArb = fc.record({
  followUpDepth: fc.integer({ min: 0, max: 3 }),
  conversationRate: fc.integer({ min: 0, max: 100 }),
  growthEnabled: fc.boolean(),
  gapCount: fc.integer({ min: 2, max: 4 }),
  commentThreadCount: fc.integer({ min: 1, max: 3 }),
});

describe("Property 9: comment-orchestration convergence keeps output valid and the pipeline runnable", () => {
  it("completes the pipeline with structurally-valid output and keeps the downgraded mechanisms non-essential", async () => {
    await fc.assert(
      fc.asyncProperty(inputArb, async (input) => {
        // --- Mechanism 1: deterministic pipeline (7.3 + 7.4 + growth non-essential 7.5) ---
        const config = buildPipelineConfig(input);
        const result = await new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00.000Z") }).generate({
          jobId: "p9-job",
          config,
          formulaVersion: DEFAULT_FORMULA_VERSION,
          knowledge,
        });
        // (7.3) the pipeline completed without an error termination and produced
        // the full candidate set.
        expect(result.packages).toHaveLength(3);
        for (const pkg of result.packages) {
          const packageErrors = pkg.validation.issues.filter((issue) => issue.severity === "error");
          // (7.4)/(7.5-growth) every candidate is structurally valid even though the
          // deterministic path omits the multi-turn growth pass entirely.
          expect(packageErrors, JSON.stringify(packageErrors)).toHaveLength(0);
          expect(pkg.validation.valid).toBe(true);
        }

        // --- Mechanism 2: omitting discoveryPlan/densityProxy stays valid (7.5) ---
        const validationConfig = commentValidationConfig();
        const ledger = buildKnowledgeLedger([]);
        const allowedEvidenceIds = ["evidence_d1"];
        const baseline = parseGenerationDraft(JSON.stringify(buildCommentDraftJson(input.commentThreadCount)));
        const stripped = omitDowngradedMechanisms(baseline);

        const baselineIssues = validateGenerationDraft({ draft: baseline, config: validationConfig, ledger, allowedEvidenceIds });
        const strippedIssues = validateGenerationDraft({ draft: stripped, config: validationConfig, ledger, allowedEvidenceIds });
        const baselineErrors = new Set(errorCodes(baselineIssues));
        const strippedErrorCodes = errorCodes(strippedIssues);

        // With the mechanisms present the structure is valid on the discovery/density
        // axis, and omitting them keeps it valid on that axis.
        for (const code of DISCOVERY_DENSITY_ERROR_CODES) {
          expect(baselineErrors.has(code), `baseline unexpectedly raised ${code}`).toBe(false);
          expect(strippedErrorCodes, `omission unexpectedly raised ${code}`).not.toContain(code);
        }
        // Omitting the downgraded mechanisms introduces no NEW error-severity issue.
        for (const code of strippedErrorCodes) {
          expect(baselineErrors.has(code), `omission introduced a new error: ${code}`).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
