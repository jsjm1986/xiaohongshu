import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  planTopicOrchestrations,
  routeReplyPostingIdentity,
  validateGenerationDraft,
} from "../src/index.js";
import type {
  GenerationDraft,
  InformationGap,
  ProjectBlueprintModuleKey,
  TopicOpportunity,
} from "../src/index.js";

const project = {
  id: "p1",
  name: "测试项目",
  domain: "健康信息",
  productPoints: [],
  organizationPoints: [],
  cities: [],
  doctors: [],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.content.commentThreadMax = 3;
  return value;
}

describe("routeReplyPostingIdentity (双号运营答复分流)", () => {
  it("routes professional topics to the publishing IP (publisher)", () => {
    expect(routeReplyPostingIdentity({ label: "适用条件", question: "哪些条件会改变适用性？" })).toBe("publisher");
    expect(routeReplyPostingIdentity({ label: "比较维度", question: "应该按哪些维度比较？" })).toBe("publisher");
    expect(routeReplyPostingIdentity({ label: "恢复过程", question: "恢复大概要多久？" })).toBe("publisher");
  });

  it("routes marketing topic terms to the assistant (staff)", () => {
    expect(routeReplyPostingIdentity({ label: "价格", question: "做这个多少钱？" })).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "门店位置", question: "你们店在哪？" })).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "预约方式", question: "怎么预约报名？" })).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "优惠", question: "最近有什么优惠活动？" })).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "门店地址", question: "地址发一下？" })).toBe("staff");
  });

  it("routes marketing claimType rule hits to the assistant (staff)", () => {
    const rules = [
      { claimType: "price" as const, terms: ["费用"] },
      { claimType: "location" as const, terms: ["门店"] },
      { claimType: "schedule" as const, terms: ["档期"] },
      { claimType: "credential" as const, terms: ["资质"] },
    ];
    expect(routeReplyPostingIdentity({ label: "费用构成", question: "费用怎么算？" }, rules)).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "门店环境", question: "门店好找吗？" }, rules)).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "档期", question: "档期一般要等多久？" }, rules)).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "操作资质", question: "资质怎么看？" }, rules)).toBe("staff");
  });

  it("keeps non-marketing claimType hits on the publishing IP", () => {
    const rules = [{ claimType: "outcome" as const, terms: ["效果"] }];
    expect(routeReplyPostingIdentity({ label: "效果维持", question: "效果能维持多久？" }, rules)).toBe("publisher");
    // Rule terms that do not match the topic never route.
    expect(routeReplyPostingIdentity({ label: "适用条件", question: "哪些条件会改变适用性？" }, rules)).toBe("publisher");
  });
});

const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

function dualIdentityBlueprint(serviceModel?: string) {
  return normalizeProjectCreativeBlueprint({
    projectId: "p1",
    sourceFingerprint: "dual-identity-test",
    moduleRevisions: blueprintRevisions,
    modules: {
      knowledge_map: { entries: [] },
      domain_model: {
        projectNoun: "皮肤管理",
        industry: "医美",
        domain: "医美",
        objects: ["皮肤管理"],
        actions: ["比较", "核验"],
        concepts: ["适用条件"],
        decisionTasks: ["核验适用条件"],
        vocabulary: ["适用条件"],
      },
      audience_model: {
        states: [{
          id: "comparer",
          label: "正在比较的人",
          stages: ["comparing"],
          goals: ["减少选择成本"],
          constraints: ["时间有限"],
          knowledgeState: "知道基本名词",
          hesitationReasons: ["口径不一致"],
          actionConditions: ["边界可核验"],
          source: { status: "inference", evidenceIds: [] },
        }],
      },
      scenario_model: {
        families: [{
          id: "compare_scene",
          label: "比较场景",
          prototype: "option_comparison",
          applicableStages: ["comparing"],
          hostIdentityCues: ["手里已有两个选项的人"],
          lifeContexts: ["午休时继续做功课"],
          timeAnchors: ["今天午休"],
          settings: ["办公室"],
          triggers: ["两种说法对不上"],
          observableActions: ["把差异记进备忘录"],
          frictions: ["只能再问一个问题"],
          emotionalAftertastes: ["有点纠结"],
          imageMoments: ["备忘录里的比较项"],
          prohibitedUnsupportedHistories: [],
          source: { status: "hypothesis", evidenceIds: [] },
        }],
      },
      role_model: {
        ...(serviceModel ? { serviceModel } : {}),
        hostVoiceTraits: ["克制", "具体"],
        hostSpeechMarkers: ["短句"],
        roles: [
          {
            id: "ip",
            displayRole: "知肤研究所",
            relationToHost: "发布账号本人",
            identityCues: ["机构IP"],
            situationCues: ["回答专业问题"],
            motives: ["把条件讲清楚"],
            knowledgePosition: "只使用已核验项目知识",
            speechPatterns: ["一句结论一个条件"],
            lexicalCues: [],
            interactionHooks: ["留下适用条件"],
            permittedContributions: ["已核验说明"],
            utteranceModes: ["knowledge_translation", "direct_question"],
            replyDisplayRoles: ["知肤研究所"],
            targetChars: [8, 40],
            accountable: true,
            source: { status: "hypothesis", evidenceIds: [] },
          },
          {
            id: "assistant",
            displayRole: "知肤研究所助理",
            relationToHost: "机构公开助理",
            identityCues: ["机构助理"],
            situationCues: ["承接价格预约类问题"],
            motives: ["把营销问题接到人工"],
            knowledgePosition: "只引用知识库营销口径",
            speechPatterns: ["先答口径再确认"],
            lexicalCues: [],
            interactionHooks: ["引导留下联系方式"],
            permittedContributions: ["价格、预约、地址、活动承接"],
            utteranceModes: ["service_answer", "identity_route"],
            replyDisplayRoles: ["知肤研究所助理"],
            targetChars: [8, 40],
            accountable: true,
            source: { status: "hypothesis", evidenceIds: [] },
          },
          {
            id: "peer",
            displayRole: "谨慎比较者",
            relationToHost: "处境相近的读者",
            identityCues: ["也在比较"],
            situationCues: ["带着现实限制"],
            motives: ["确认一个边界"],
            knowledgePosition: "只知道公开信息",
            speechPatterns: ["先说处境再问"],
            lexicalCues: [],
            interactionHooks: ["追问适用条件"],
            permittedContributions: ["提出条件化问题"],
            utteranceModes: ["direct_question", "shared_concern", "counterexample"],
            replyDisplayRoles: ["知肤研究所"],
            targetChars: [6, 30],
            accountable: false,
            source: { status: "hypothesis", evidenceIds: [] },
          },
        ],
      },
      claim_policy: {
        rules: [{
          id: "price_rule",
          label: "价格声明",
          claimType: "price",
          terms: ["价格", "费用"],
          requiresEvidence: true,
          allowedEvidenceStatuses: ["supplied_fact"],
          dynamic: true,
          handling: "verify",
          source: { status: "inference", evidenceIds: [] },
        }],
        prohibitedClaims: [],
        dynamicInformation: ["价格以当期确认为准"],
        unknownHandling: ["保持未知并转人工"],
      },
      surface_language: {
        registerDescription: "自然、具体",
        preferredTerms: ["适用条件"],
        optionalColloquialisms: [],
        prohibitedCliches: ["闭眼入"],
        antiCopyRules: ["不复刻样本句子"],
      },
    },
  });
}

const marketingGaps: InformationGap[] = [
  {
    id: "price_gap",
    label: "价格",
    question: "做这个多少钱？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    evidenceIds: ["evidence_d1"],
    required: true,
    preferredChannels: ["Cref"],
  },
  {
    id: "fit_gap",
    label: "适用条件",
    question: "哪些条件会改变适用性？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.8,
    decisionLeverage: 0.85,
    proofability: 0.8,
    evidenceIds: ["evidence_d1"],
    required: false,
    preferredChannels: ["Cref"],
  },
];

function marketingOpportunity(): TopicOpportunity {
  return {
    id: "topic-marketing",
    topic: "方案选择",
    angle: "先核验再比较",
    gapIds: ["price_gap", "fit_gap"],
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
    imageAssetIds: [],
    status: "eligible",
  };
}

describe("dual-identity reply routing in planned threads", () => {
  it("assigns staff to marketing threads and publisher to professional threads, syncing replyDisplayRole", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      projectBlueprint: dualIdentityBlueprint("recurring"),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      const priceThread = plan.dialogueThreads.find((thread) => thread.gapId === "price_gap");
      const fitThread = plan.dialogueThreads.find((thread) => thread.gapId === "fit_gap");
      expect(priceThread?.postingIdentity).toBe("staff");
      expect(priceThread?.surfaceRoleCard?.replyDisplayRole).toBe("知肤研究所助理");
      expect(fitThread?.postingIdentity).toBe("publisher");
    }
  });

  it("falls back to publisher for every thread when no blueprint is supplied", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      const priceThread = plan.dialogueThreads.find((thread) => thread.gapId === "price_gap");
      // Topic terms still route to staff even without a blueprint; the reply
      // display role then falls back to the generic 项目助理.
      expect(priceThread?.postingIdentity).toBe("staff");
      expect(priceThread?.surfaceRoleCard?.replyDisplayRole).toBe("项目助理");
      expect(plan.dialogueThreads.find((thread) => thread.gapId === "fit_gap")?.postingIdentity).toBe("publisher");
    }
  });
});

describe("role_model serviceModel normalization", () => {
  it("keeps a legal serviceModel, drops illegal values and treats a missing one as absent", () => {
    expect(dualIdentityBlueprint("one_time").roleModel.serviceModel).toBe("one_time");
    expect(dualIdentityBlueprint("recurring").roleModel.serviceModel).toBe("recurring");
    expect(dualIdentityBlueprint("mixed").roleModel.serviceModel).toBe("mixed");
    expect(dualIdentityBlueprint("subscription").roleModel.serviceModel).toBeUndefined();
    expect(dualIdentityBlueprint().roleModel.serviceModel).toBeUndefined();
  });
});

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    question: "这个要怎么判断？",
    answer: "先按手头的说法核实条件。",
    followUps: [] as unknown[],
    postingIdentity: "staff",
    sourceClusterIds: [] as string[],
    evidenceIds: [] as string[],
    personaRole: "information_collector",
    speakerType: "simulated_reader",
    claimStatus: "hypothetical",
    replyTo: null,
    threadDepth: 0,
    simulated: true,
    simulationLabel: "模拟潜在读者情景",
    ...overrides,
  };
}

function draftJson(body: string, threads: unknown[], extras: { reasoning?: unknown[]; evidenceIds?: string[] } = {}) {
  return {
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads },
    },
    evidenceIds: extras.evidenceIds ?? [],
    reasoning: extras.reasoning ?? [],
    unknowns: [],
  };
}

function validate(draft: GenerationDraft, extras: Record<string, unknown> = {}) {
  const validationConfig = config();
  validationConfig.content.bodyMinChars = 2;
  validationConfig.content.hashtagMin = 1;
  return validateGenerationDraft({
    draft,
    config: validationConfig,
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: ["ev_k1"],
    ...extras,
  });
}

const codes = (issues: ReturnType<typeof validateGenerationDraft>) => issues.map((issue) => issue.code);
const plainBody = "先看自己的情况，别急着下结论，多问一句再定。";

describe("marketing_claim_grounding (助理营销话术锚定复核)", () => {
  const priceAnswer = "价格一般5000到8000元，以当期确认为准。";

  it("passes when the staff price claim is anchored to a factual ledger entry", () => {
    const anchored = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: priceAnswer })], {
        evidenceIds: ["ev_k1"],
        reasoning: [{
          statement: priceAnswer,
          status: "fact",
          evidenceIds: ["ev_k1"],
          location: "Cref.thread",
          sourceSpans: [{ evidenceId: "ev_k1", quote: "价格一般5000到8000元，以当期确认为准。" }],
        }],
      }))),
    );
    expect(codes(anchored)).not.toContain("marketing_claim_grounding");
  });

  it("warns when the staff price claim cannot be anchored", () => {
    const unanchored = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: priceAnswer })]))),
    );
    expect(unanchored).toContainEqual(expect.objectContaining({
      code: "marketing_claim_grounding",
      severity: "warning",
      channel: "Cref",
    }));
  });

  it("warns on promise-style staff claims that carry no number at all", () => {
    const promiseAnswer = "现在预约有优惠，还能优先安排名额。";
    const unanchored = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: promiseAnswer })]))),
    );
    expect(codes(unanchored)).toContain("marketing_claim_grounding");
  });

  it("never fires for non-staff identities or non-marketing staff answers", () => {
    const publisherSide = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ postingIdentity: "publisher", answer: priceAnswer })]))),
    );
    expect(codes(publisherSide)).not.toContain("marketing_claim_grounding");

    const plainStaffAnswer = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: "这个得看你的具体情况，先别急着定。" })]))),
    );
    expect(codes(plainStaffAnswer)).not.toContain("marketing_claim_grounding");
  });
});
