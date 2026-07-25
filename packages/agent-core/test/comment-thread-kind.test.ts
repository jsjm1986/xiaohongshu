import { describe, expect, it } from "vitest";

import {
  assignCommentThreadKind,
  buildKnowledgeLedger,
  COMMENT_NICKNAME_POOL,
  commentThreadKindOf,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  planTopicOrchestrations,
  validateGenerationDraft,
} from "../src/index.js";
import type {
  GenerationDraft,
  InformationGap,
  TopicOpportunity,
} from "../src/index.js";

const project = {
  id: "p1",
  name: "测试项目",
  domain: "决策信息",
  productPoints: ["资料中确认了产品要点"],
  organizationPoints: ["资料中确认了服务边界"],
  cities: ["上海"],
  doctors: [],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.task.city = "上海";
  value.informationWindow.gaps = ["适合谁", "如何比较", "哪些未知"];
  value.informationWindow.boundaries = ["不能保证个体结果"];
  value.content.bodyMinChars = 120;
  value.content.bodyMaxChars = 800;
  value.content.hashtagMin = 3;
  value.content.hashtagMax = 6;
  value.content.commentThreadMin = 3;
  value.content.commentThreadMax = 5;
  value.content.followUpDepth = 2;
  value.content.commentMultiTurnGrowthEnabled = true;
  value.knowledge.maxInputTokens = 20_000;
  value.knowledge.outputReserveTokens = 1_000;
  value.knowledge.safetyMarginTokens = 100;
  return value;
}

const knowledge = [
  indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

const gaps: InformationGap[] = [
  {
    id: "fit_gap",
    label: "适用条件",
    question: "哪些条件会改变适用性？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    evidenceIds: ["evidence_d2"],
    required: true,
    preferredChannels: ["Cref"],
  },
  {
    id: "compare_gap",
    label: "比较维度",
    question: "应该按哪些维度比较？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.8,
    decisionLeverage: 0.85,
    proofability: 0.8,
    evidenceIds: ["evidence_d2"],
    required: false,
    preferredChannels: ["Cref"],
  },
  {
    id: "price_gap",
    label: "价格区间多少钱",
    question: "整体大概多少钱，怎么预约？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.7,
    decisionLeverage: 0.75,
    proofability: 0.6,
    evidenceIds: ["evidence_d2"],
    required: false,
    preferredChannels: ["Cref"],
  },
];

function opportunity(id = "topic-kind"): TopicOpportunity {
  return {
    id,
    topic: "方案选择",
    angle: "先核验再比较",
    gapIds: gaps.map((gap) => gap.id),
    audienceStage: "comparing",
    entry: "search",
    relevance: 0.9,
    importance: 0.8,
    proofability: 0.8,
    novelty: 0.6,
    decisionLeverage: 0.8,
    cognitiveCost: 0.3,
    risk: 0.2,
    evidenceIds: ["evidence_d2"],
    boundaries: ["个体适用性需要单独核验"],
    tags: ["比较方法"],
    imageAssetIds: [],
    status: "eligible",
  };
}

const THREAD_KINDS = new Set(["org_answer", "reader_exchange", "organic_reaction"]);

describe("assignCommentThreadKind (互动形态确定性抽取)", () => {
  it("is deterministic for the same seed + salt and only emits legal kinds", () => {
    for (const marketing of [false, true]) {
      const first = assignCommentThreadKind(42, "thread-kind:t1", marketing);
      expect(assignCommentThreadKind(42, "thread-kind:t1", marketing)).toBe(first);
      expect(THREAD_KINDS).toContain(first);
    }
    const draws = new Set(Array.from({ length: 24 }, (_, index) =>
      assignCommentThreadKind(7, `thread-kind:t${index}`, false)));
    expect(draws.size).toBeGreaterThan(1);
  });

  it("营销话头线程的 org_answer 概率自然偏高(不设死比例)", () => {
    const sweep = Array.from({ length: 200 }, (_, index) => `sweep:${index}`);
    const marketingOrg = sweep.filter((salt) => assignCommentThreadKind(99, salt, true) === "org_answer").length;
    const plainOrg = sweep.filter((salt) => assignCommentThreadKind(99, salt, false) === "org_answer").length;
    expect(marketingOrg).toBeGreaterThan(plainOrg);
    // 非营销线程三种形态都能出现(类型许可放开)。
    const plainKinds = new Set(sweep.map((salt) => assignCommentThreadKind(99, salt, false)));
    expect(plainKinds).toEqual(new Set(["org_answer", "reader_exchange", "organic_reaction"]));
  });
});

describe("dialoguePlans threadKind assignment", () => {
  const build = () => planTopicOrchestrations({
    opportunity: opportunity(),
    gaps,
    config: config(),
    seeds: [11, 22, 33],
  });

  it("assigns deterministic, legal kinds; replay with the same seeds is identical", () => {
    const plans = build();
    const rerun = build();
    plans.forEach((plan, planIndex) => {
      const kinds = plan.dialogueThreads.map((thread) => thread.threadKind ?? "org_answer");
      for (const kind of kinds) expect(THREAD_KINDS).toContain(kind);
      expect(rerun[planIndex]!.dialogueThreads.map((thread) => thread.threadKind)).toEqual(
        plan.dialogueThreads.map((thread) => thread.threadKind),
      );
      expect(kinds.length).toBeGreaterThan(0);
    });
  });

  it("T2 线程:speakerA/B 不同 displayRole 且不同昵称,B 接话范围限 permittedContribution", () => {
    const exchanges = build().flatMap((plan) =>
      plan.dialogueThreads.filter((thread) => thread.threadKind === "reader_exchange"));
    expect(exchanges.length).toBeGreaterThan(0);
    for (const thread of exchanges) {
      expect(thread.replySurfaceRoleCard).toBeDefined();
      expect(thread.replySurfaceRoleCard!.displayRole).not.toBe(thread.surfaceRoleCard?.displayRole);
      expect(thread.replyDisplayName).toBeDefined();
      expect(thread.replyDisplayName).not.toBe(thread.displayName);
      expect(COMMENT_NICKNAME_POOL).toContain(thread.replyDisplayName);
      // B 的接话范围写进 conversationPlan.replyMove(限 permittedContribution)。
      expect(thread.conversationPlan?.replyMove).toContain(thread.replySurfaceRoleCard!.permittedContribution);
      expect(thread.conversationPlan?.topology).toBe("reader_exchange");
      // T2 的发言方是模拟读者,声明状态一律 hypothetical。
      expect(thread.claimStatus).toBe("hypothetical");
    }
  });

  it("T3 线程:1-3 条漂浮短反应,不生长、answer 无回答需求", () => {
    for (const plan of build()) {
      const organics = plan.dialogueThreads.filter((thread) => thread.threadKind === "organic_reaction");
      // targetCount>=3 时 T3 为 1-3 条。
      if (plan.dialogueThreads.length >= 3) {
        expect(organics.length).toBeGreaterThanOrEqual(1);
        expect(organics.length).toBeLessThanOrEqual(3);
      }
      for (const thread of organics) {
        expect(thread.conversationPlan?.topology).toBe("organic_reaction");
        expect(thread.conversationPlan?.targetFollowUps).toBe(0);
        expect(thread.surfaceRoleCard?.targetChars).toEqual([4, 20]);
        expect(thread.claimStatus).toBe("hypothetical");
      }
    }
  });

  it("营销话头 gap(命中 price 护栏)的线程 T1 概率自然偏高", () => {
    // 三身份生态:营销 T1 偏置由 claimRules 护栏命中驱动(关键词硬路由已删除),
    // 测试显式提供 price 规则使 price_gap 命中护栏。
    const plans = planTopicOrchestrations({
      opportunity: opportunity("topic-kind-marketing"),
      gaps,
      config: config(),
      projectBlueprint: normalizeProjectCreativeBlueprint({
        projectId: "p1",
        sourceFingerprint: "thread-kind-guard",
        moduleRevisions: {},
        modules: {
          claim_policy: {
            rules: [{
              id: "price_rule",
              label: "价格声明",
              claimType: "price",
              terms: ["价格", "多少钱"],
              requiresEvidence: true,
              allowedEvidenceStatuses: ["user_supplied"],
              dynamic: true,
              handling: "verify",
              source: { status: "inference", evidenceIds: [] },
            }],
          },
        },
      }),
      seeds: [11, 22, 33],
    });
    const marketingThreads = plans.flatMap((plan) =>
      plan.dialogueThreads.filter((thread) => thread.gapId === "price_gap"));
    expect(marketingThreads.length).toBeGreaterThan(0);
    const orgCount = marketingThreads.filter((thread) => (thread.threadKind ?? "org_answer") === "org_answer").length;
    expect(orgCount / marketingThreads.length).toBeGreaterThan(0.5);
  });
});

describe("engine binding carries threadKind into the final package", () => {
  it("binds kind + T2 B 昵称,与计划侧一致且包内昵称不重复", async () => {
    const generate = () => new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "thread-kind-e2e", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const [first, second] = [await generate(), await generate()];
    expect(first.packages).toHaveLength(3);
    first.packages.forEach((pkg, pkgIndex) => {
      const plannedById = new Map((pkg.dialogueThreads ?? []).map((thread) => [thread.id, thread]));
      const names: string[] = [];
      for (const thread of pkg.content.Cref.threads) {
        expect(thread.threadKind).toBeDefined();
        expect(THREAD_KINDS).toContain(thread.threadKind);
        expect(thread.threadKind).toBe(plannedById.get(thread.id)?.threadKind ?? "org_answer");
        names.push(thread.displayName!);
        if (thread.threadKind === "reader_exchange") {
          expect(thread.replyDisplayName).toBeDefined();
          expect(thread.replyDisplayName).not.toBe(thread.displayName);
          names.push(thread.replyDisplayName!);
          // T2 读者互聊:answer 是读者 B 的接话,不再是机构答复模板。
          expect(thread.answer.length).toBeGreaterThan(0);
        }
        if (thread.threadKind === "organic_reaction") {
          // T3 漂浮短反应:无回答需求、不生长。
          expect(thread.answer).toBe("");
          expect(thread.followUps).toHaveLength(0);
        }
        for (const followUp of thread.followUps) names.push(followUp.displayName!);
      }
      expect(new Set(names).size, "包内所有发言昵称(含 B 与接话人)不得重复").toBe(names.length);
      const rerunThreads = second.packages[pkgIndex]!.content.Cref.threads;
      expect(rerunThreads.map((thread) => thread.threadKind)).toEqual(
        pkg.content.Cref.threads.map((thread) => thread.threadKind),
      );
      expect(rerunThreads.map((thread) => thread.replyDisplayName)).toEqual(
        pkg.content.Cref.threads.map((thread) => thread.replyDisplayName),
      );
    });
  });
});

function draftWithKind(threadKind: string | undefined, question: string, answer: string): GenerationDraft {
  const draft = parseGenerationDraft(JSON.stringify({
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body: "先看自己的情况，别急着下结论，多问一句再定。" },
      Cref: {
        disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。",
        threads: [{
          id: "t1",
          question,
          answer,
          followUps: [],
          postingIdentity: "publisher",
          sourceClusterIds: [],
          evidenceIds: [],
          personaRole: "information_collector",
          speakerType: "simulated_reader",
          claimStatus: "hypothetical",
          replyTo: null,
          threadDepth: 0,
          simulated: true,
          simulationLabel: "模拟潜在读者情景",
        }],
      },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  }));
  // threadKind / replyDisplayName 是引擎绑定的展示元数据,不经模型解析,直接附上再校验。
  if (threadKind) draft.content.Cref.threads[0]!.threadKind = threadKind as "reader_exchange";
  return draft;
}

function validate(draft: GenerationDraft) {
  const validationConfig = config();
  validationConfig.content.bodyMinChars = 2;
  validationConfig.content.hashtagMin = 1;
  return validateGenerationDraft({
    draft,
    config: validationConfig,
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: ["ev_k1"],
  });
}

const codes = (issues: ReturnType<typeof validateGenerationDraft>) => issues.map((issue) => issue.code);

describe("threadKind validation (读者互动层)", () => {
  it("T2 读者接话命中受控声明(价格数字)→ warning,不触发 error 级敏感声明", () => {
    const issues = validate(draftWithKind("reader_exchange", "我也在纠结要不要去问问", "听说全下来要3000元呢"));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "reader_exchange_controlled_claim",
      severity: "warning",
      channel: "Cref",
    }));
    expect(codes(issues)).not.toContain("sensitive_claim_without_evidence");
  });

  it("T2 读者接话出现证词形态(做过了/效果很好)→ error,复用 fabricated_operational_experience", () => {
    const issues = validate(draftWithKind("reader_exchange", "纠结中", "这个我做过了，效果很好"));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "fabricated_operational_experience",
      severity: "error",
      channel: "Cref",
    }));
  });

  it("T3 漂浮短反应只查证词形态:证词 → error;受控声明不触发 warning", () => {
    const testimonial = validate(draftWithKind("organic_reaction", "亲测有效，效果很好", ""));
    expect(testimonial).toContainEqual(expect.objectContaining({
      code: "fabricated_operational_experience",
      severity: "error",
    }));
    const claimOnly = validate(draftWithKind("organic_reaction", "听说要3000元", ""));
    expect(codes(claimOnly)).not.toContain("reader_exchange_controlled_claim");
    expect(codes(claimOnly)).not.toContain("sensitive_claim_without_evidence");
  });

  it("T3 answer 为空不算线程缺漏;旧包(无 threadKind)按 T1 校验不变", () => {
    const organicDraft = draftWithKind("organic_reaction", "蹲一个", "");
    // 补齐其余结构字段,只留 answer 为空、无下一步——T3 的正常形态。
    Object.assign(organicDraft.content.Cref.threads[0]!, {
      stage: "comparing", gap: "fit_gap", function: "surface_gap", nextStep: undefined,
    });
    const organic = validate(organicDraft);
    expect(codes(organic)).not.toContain("thread_unit_incomplete");
    // 旧包:没有 threadKind 字段,价格数字答复且无台账 → 仍按 error 级敏感声明拦截。
    const legacy = validate(draftWithKind(undefined, "这个怎么收费？", "全下来要3000元。"));
    expect(codes(legacy)).toContain("sensitive_claim_without_evidence");
    expect(codes(legacy)).not.toContain("reader_exchange_controlled_claim");
    expect(commentThreadKindOf({})).toBe("org_answer");
    expect(commentThreadKindOf({ threadKind: "未知形态" })).toBe("org_answer");
  });
});
