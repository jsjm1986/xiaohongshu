import { describe, expect, it } from "vitest";

import {
  assignCommentThreadKind,
  attachConfirmedAuthorFactReasoning,
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
  validatePublishingTopologyCopy,
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

const THREAD_KINDS = new Set(["org_answer", "host_reply", "reader_exchange", "organic_reaction"]);

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


  it("项目缺口席位固定为 org_answer，社会线程不冒充 primary gap owner", () => {
    for (const plan of build()) {
      for (const entry of plan.gapCoverageLedger.entries) {
        for (const id of entry.primaryThreadIds) {
          const thread = plan.dialogueThreads.find((item) => item.id === id)!;
          expect(thread.threadKind).toBe("org_answer");
          expect(thread.coverageRole).toBe("primary_gap");
        }
      }
      for (const thread of plan.dialogueThreads.filter((item) => item.threadKind !== "org_answer")) {
        expect(thread.coverageRole).not.toBe("primary_gap");
        expect(plan.gapCoverageLedger.entries.flatMap((entry) => entry.primaryThreadIds)).not.toContain(thread.id);
      }
    }
  });

  it("个人作者拓扑预留一条 host_reply，且只引用人类确认事实", () => {
    const value = config();
    value.task.publishingTopology = "confirmed_individual_author";
    value.task.authorContext = {
      status: "confirmed",
      facts: [{ id: "af1", statement: "我目前还没决定", category: "current_state", confirmedBy: "u1", confirmedAt: "2026-08-04T12:00:00Z" }],
    };
    const plans = planTopicOrchestrations({ opportunity: opportunity("host"), gaps, config: value, seeds: [11, 22, 33] });
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      const hosts = plan.dialogueThreads.filter((thread) => thread.threadKind === "host_reply");
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({ postingIdentity: "author", coverageRole: "topic_anchor", evidenceIds: [], authorFactIds: ["af1"] });
      expect(hosts[0]!.hostReplyPlan?.allowedAuthorFactIds).toEqual(["af1"]);
      expect(hosts[0]!.conversationPlan?.targetFollowUps).toBe(0);
    }
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
      // 漂浮反应只来自额外社会席位；项目缺口席位不得为了凑 T3 被降级。
      expect(organics.length).toBeLessThanOrEqual(3);
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

  it("T2 已标注模拟读者可以讲消费者亲历，但只能作为创作参考", () => {
    const issues = validate(draftWithKind("reader_exchange", "纠结中", "这个我做过了，效果很好"));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "creative_persona_experience",
      severity: "warning",
      disposition: "advisory",
      channel: "Cref",
    }));
    expect(codes(issues)).not.toContain("fabricated_operational_experience");
  });

  it("T2 读者B必须承接同一话题，不能从机构透明度突然跳到另一份FAQ", () => {
    const drift = validate(draftWithKind(
      "reader_exchange",
      "机构全称为什么不能公开？我想先查资质。",
      "我连自己是什么情况都分不清，能先看看适不适合吗？",
    ));
    expect(drift).toContainEqual(expect.objectContaining({
      code: "comment_reply_topic_drift",
      disposition: "review",
      channel: "Cref",
    }));

    const coherent = validate(draftWithKind(
      "reader_exchange",
      "机构全称为什么不能公开？我想先查资质。",
      "我也是，名字都查不到的话会有点不敢约。",
    ));
    expect(codes(coherent)).not.toContain("comment_reply_topic_drift");

    const pureEcho = validate(draftWithKind(
      "reader_exchange",
      "同问，我也没想明白",
      "同感，我还没敢定。",
    ));
    expect(codes(pureEcho)).not.toContain("comment_reply_topic_drift");

    const waitEcho = validate(draftWithKind(
      "reader_exchange",
      "这个我也在纠结",
      "我也先等等看。",
    ));
    expect(codes(waitEcho)).not.toContain("comment_reply_topic_drift");

    const pivotDrift = validate(draftWithKind(
      "reader_exchange",
      "我泪沟挺深，面诊能一起给个方案吗？",
      "泪沟深我也怕，不过我最怕的还是麻药，你帮我问问怎么打行不？",
    ));
    expect(pivotDrift).toContainEqual(expect.objectContaining({
      code: "comment_reply_topic_drift",
      disposition: "review",
      channel: "Cref",
    }));
  });

  it("用户可以说自己约了面诊，但不能替机构陈述地址定位；机构也不能凭地址证据承诺后续服务", () => {
    const organizationGap: InformationGap = {
      id: "org_location",
      label: "机构位置",
      question: "机构全称是否可以公开？",
      category: "location",
      audienceStages: ["comparing"],
      importance: 0.9,
      decisionLeverage: 0.8,
      proofability: 0.9,
      answer: "机构类型为门诊，专注眼周年轻化，地址在锦华万达附近；机构全称不对外公开。",
      boundary: "不得公开机构全称，可公开地址和门诊类型。",
      evidenceIds: ["ev_org"],
      required: true,
      preferredChannels: ["N.body", "Cref"],
    };
    const selected: TopicOpportunity = {
      ...opportunity("organization-gate"),
      gapIds: [organizationGap.id],
      evidenceIds: ["ev_org"],
    };
    const validationConfig = config();
    validationConfig.content.bodyMinChars = 2;
    validationConfig.content.hashtagMin = 1;
    const plan = planTopicOrchestrations({
      opportunity: selected,
      gaps: [organizationGap],
      config: validationConfig,
      seeds: [101, 202, 303],
    })[0]!;
    const planned = plan.dialogueThreads.find((thread) => thread.threadKind === "org_answer")!;
    const candidate = draftWithKind(undefined, "具体位置在哪里？", "当前只能确认公开范围。");
    const actual = candidate.content.Cref.threads[0]!;
    Object.assign(actual, {
      id: planned.id,
      threadKind: "org_answer",
      primaryGapId: planned.primaryGapId,
      gap: planned.gapId,
      postingIdentity: planned.postingIdentity,
      answerIdentity: planned.postingIdentity,
      surfaceRoleCard: planned.surfaceRoleCard,
    });

    candidate.content.N.body = "我约了周末面诊，具体信息准备再问清楚。";
    let issues = validateGenerationDraft({
      draft: candidate,
      config: validationConfig,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: ["ev_org"],
      evidenceSources: { ev_org: "机构类型为门诊，专注眼周年轻化，地址在锦华万达附近。" },
      orchestrationPlan: plan,
    });
    expect(codes(issues)).not.toContain("consumer_body_organization_fact");

    candidate.content.N.body = "我约了锦华万达附近这家眼周门诊面诊。";
    issues = validateGenerationDraft({
      draft: candidate,
      config: validationConfig,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: ["ev_org"],
      evidenceSources: { ev_org: "机构类型为门诊，专注眼周年轻化，地址在锦华万达附近。" },
      orchestrationPlan: plan,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: "consumer_body_organization_fact",
      severity: "warning",
      disposition: "review",
      channel: "N.body",
    }));

    candidate.content.N.body = "我约了周末面诊，具体信息准备再问清楚。";
    actual.answer = "具体位置我帮您跟专人确认，确认好就回在这条评论下面；预约也可以一并帮您对接。";
    issues = validateGenerationDraft({
      draft: candidate,
      config: validationConfig,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: ["ev_org"],
      evidenceSources: { ev_org: "机构类型为门诊，专注眼周年轻化，地址在锦华万达附近。" },
      orchestrationPlan: plan,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: "ungrounded_organization_service_commitment",
      severity: "warning",
      disposition: "review",
      channel: "Cref",
    }));

    actual.answer = "具体位置目前无法确认，只能以当期信息为准。";
    issues = validateGenerationDraft({
      draft: candidate,
      config: validationConfig,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: ["ev_org"],
      evidenceSources: { ev_org: "机构类型为门诊，专注眼周年轻化，地址在锦华万达附近。" },
      orchestrationPlan: plan,
    });
    expect(codes(issues)).not.toContain("ungrounded_organization_service_commitment");
  });

  it("T2 读者互聊不承担机构问答的 Gap、Next、replyPlan 或 discoveryPlan", () => {
    const draft = draftWithKind("reader_exchange", "我也在纠结要不要去问问", "我更想先问疼不疼。");
    Object.assign(draft.content.Cref.threads[0]!, {
      stage: "comparing",
      function: "verification",
      gap: undefined,
      nextStep: undefined,
      replyPlan: undefined,
      discoveryPlan: undefined,
    });
    const issueCodes = codes(validate(draft));
    expect(issueCodes).not.toContain("thread_unit_incomplete");
    expect(issueCodes).not.toContain("comment_reply_plan_missing");
    expect(issueCodes).not.toContain("comment_discovery_plan_missing");
  });

  it("T3 漂浮短反应中的亲历保持创作标注；受控声明不触发机构事实错误", () => {
    const testimonial = validate(draftWithKind("organic_reaction", "亲测有效，效果很好", ""));
    expect(testimonial).toContainEqual(expect.objectContaining({
      code: "creative_persona_experience",
      severity: "warning",
      disposition: "advisory",
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


describe("publishing topology and host-reply hard gates", () => {
  const blueprint = normalizeProjectCreativeBlueprint({
    projectId: "p1",
    sourceFingerprint: "topology-gate",
    moduleRevisions: {},
    modules: {
      domain_model: { projectNoun: "服务", actions: ["面诊", "购买"] },
      scenario_model: {
        families: [{
          id: "current", label: "当前状态", prototype: "narrow_request",
          applicableStages: ["comparing"], prohibitedUnsupportedHistories: ["已经面诊", "已经购买"],
          source: { status: "inference", evidenceIds: [] },
        }],
      },
    },
  });

  it("机构拓扑拦截所有消费者第一人称，不再放行当前打算", () => {
    const value = config();
    value.task.publishingTopology = "institution_owned";
    for (const body of ["我昨天已经面诊了。", "我还没去，打算先把问题问清楚。", "我最近越看越纠结。"]) {
      expect(validatePublishingTopologyCopy({ N: { imageBrief: "", title: "记录", body } }, value, blueprint))
        .toContainEqual(expect.objectContaining({ code: "unsupported_narrative_history", channel: "N.body" }));
    }
    expect(validatePublishingTopologyCopy({ N: { imageBrief: "", title: "机构说明", body: "本次先说明适用条件，未知信息仍需核实。" } }, value, blueprint)).toEqual([]);
    expect(validatePublishingTopologyCopy({
      N: { imageBrief: "", title: "没被推销", body: "昨天去附近约了家门诊，价格分档讲明白，没被推销。" },
    }, value, blueprint)).toContainEqual(expect.objectContaining({ code: "unsupported_narrative_history" }));
  });

  it("自动用户情景允许消费者当前处境和已发生亲历，不要求作者事实确认", () => {
    const value = config();
    expect(value.task.publishingTopology).toBe("creative_scenario");
    expect(value.task.authorContext).toEqual({ status: "not_provided", facts: [] });
    for (const body of [
      "我还没去，最近越看越纠结，想先把问题问清楚。",
      "我昨天已经去面诊了，回来后把自己最在意的几项记了下来。",
    ]) {
      expect(validatePublishingTopologyCopy({
        N: { imageBrief: "", title: "我的记录", body },
      }, value, blueprint)).toEqual([]);
    }
  });

  it("准备面诊的创作任务不得被推进成已到店亲历", () => {
    const value = config();
    value.task.publishingTopology = "creative_scenario";
    value.task.theme = "第一次准备去面诊，我先把哪些问题问明白";
    value.task.goal = "写准备动作和想问的问题，不确定时先不下结论";
    value.task.readerHistory = undefined;

    const issues = validatePublishingTopologyCopy({
      N: {
        imageBrief: "问题清单",
        title: "先问清楚",
        body: "到院先填了情况登记表，拍了照片才进面诊室。医生让我拿镜子自己看。",
      },
    }, value, blueprint);
    expect(issues).toContainEqual(expect.objectContaining({
      code: "creative_scenario_timeline_drift",
      disposition: "block",
      channel: "N.body",
    }));

    expect(validatePublishingTopologyCopy({
      N: { imageBrief: "问题清单", title: "先问清楚", body: "我还没去，先把最在意的问题列下来，不确定时先不下结论。" },
    }, value, blueprint)).toEqual([]);
  });

  it("个人作者拓扑只允许人工确认事实范围内的已发生经历", () => {
    const value = config();
    value.task.publishingTopology = "confirmed_individual_author";
    value.task.authorContext = {
      status: "confirmed",
      facts: [{ id: "af1", statement: "我昨天已经面诊", category: "project_contact", confirmedBy: "u1", confirmedAt: "2026-08-04T12:00:00Z" }],
    };
    expect(validatePublishingTopologyCopy({ N: { imageBrief: "", title: "记录", body: "我昨天已经面诊。" } }, value, blueprint)).toEqual([]);
    expect(validatePublishingTopologyCopy({ N: { imageBrief: "", title: "记录", body: "我昨天已经购买了。" } }, value, blueprint))
      .toContainEqual(expect.objectContaining({ code: "author_fact_scope_exceeded" }));
    expect(validatePublishingTopologyCopy({ N: { imageBrief: "", title: "记录", body: "我昨天已经面诊，后来又去现场咨询了。" } }, value, blueprint))
      .toContainEqual(expect.objectContaining({ code: "author_fact_scope_exceeded" }));
  });

  it("系统确定性绑定作者事实台账，不混用项目证据或模型假设", () => {
    const value = config();
    value.task.publishingTopology = "confirmed_individual_author";
    value.task.authorContext = {
      status: "confirmed",
      facts: [{ id: "af1", statement: "我目前还没决定", category: "current_state", confirmedBy: "u1", confirmedAt: "2026-08-04T12:00:00Z", confirmationId: "confirmation-1" }],
    };
    const draft = draftWithKind("host_reply", "所以你还没定吗？", "我目前还没决定");
    draft.content.N.body = "我目前还没决定。";
    draft.reasoning = [{ statement: "我目前还没决定。", location: "N.body", occurrence: { field: "body" }, status: "hypothesis", evidenceIds: [], sourceSpans: [] }];
    draft.content.Cref.threads[0]!.postingIdentity = "author";
    const bound = attachConfirmedAuthorFactReasoning(draft, value);
    const authorRows = bound.reasoning.filter((item) => item.status === "human_confirmed_author_fact");
    expect(authorRows).toHaveLength(2);
    expect(authorRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorFactId: "af1", confirmationId: "confirmation-1", evidenceIds: [], sourceSpans: [] }),
    ]));
    expect(bound.reasoning).not.toContainEqual(expect.objectContaining({ statement: "我目前还没决定。", status: "hypothesis" }));
    const issues = validateGenerationDraft({ draft: bound, config: value, ledger: buildKnowledgeLedger([]), allowedEvidenceIds: [], evidenceSources: {}, projectBlueprint: blueprint });
    expect(codes(issues)).not.toContain("author_fact_reference_invalid");
    expect(codes(issues)).not.toContain("author_fact_confirmation_mismatch");
    expect(codes(issues)).not.toContain("author_fact_project_evidence_mixed");
  });

  it("host_reply 仅允许已确认作者、零项目证据且不承担项目缺口", () => {
    const value = config();
    value.content.bodyMinChars = 2;
    value.content.hashtagMin = 1;
    value.task.publishingTopology = "confirmed_individual_author";
    value.task.authorContext = {
      status: "confirmed",
      facts: [{ id: "af1", statement: "我目前还没决定", category: "current_state", confirmedBy: "u1", confirmedAt: "2026-08-04T12:00:00Z" }],
    };
    const draft = draftWithKind("host_reply", "所以你还没定吗？", "我目前还没决定");
    const host = draft.content.Cref.threads[0]!;
    host.postingIdentity = "author";
    host.authorFactIds = ["af1"];
    host.topicAnchorGapId = "fit_gap";
    host.primaryGapId = undefined;
    host.gap = undefined;
    host.nextStep = undefined;
    host.evidenceIds = [];
    const issues = validateGenerationDraft({ draft, config: value, ledger: buildKnowledgeLedger([]), allowedEvidenceIds: [], projectBlueprint: blueprint });
    expect(codes(issues)).not.toContain("host_reply_identity_violation");
    expect(codes(issues)).not.toContain("host_reply_evidence_violation");
    expect(codes(issues)).not.toContain("host_reply_author_fact_mismatch");

    host.postingIdentity = "publisher";
    host.evidenceIds = ["evidence_d2"];
    const broken = validateGenerationDraft({ draft, config: value, ledger: buildKnowledgeLedger([]), allowedEvidenceIds: ["evidence_d2"], projectBlueprint: blueprint });
    expect(codes(broken)).toContain("host_reply_identity_violation");
    expect(codes(broken)).toContain("host_reply_evidence_violation");
  });
});
