import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  planTopicOrchestrations,
  guardedReplyIdentitiesForQuestion,
  questionMatchesPlannedGap,
  resolvePlannedReplyRoute,
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

describe("routeReplyPostingIdentity (三身份生态:合规护栏 + 确定性兜底表)", () => {
  it("forces staff for price/location/schedule claimType guardrail hits", () => {
    const rules = [
      { claimType: "price" as const, terms: ["费用"] },
      { claimType: "location" as const, terms: ["门店"] },
      { claimType: "schedule" as const, terms: ["档期"] },
    ];
    expect(routeReplyPostingIdentity({ label: "费用构成", question: "费用怎么算？" }, rules)).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "门店环境", question: "门店好找吗？" }, rules)).toBe("staff");
    expect(routeReplyPostingIdentity({ label: "档期", question: "档期一般要等多久？" }, rules)).toBe("staff");
    // 命中护栏集合之外的 claimType → 不强制 staff。
    expect(routeReplyPostingIdentity({ label: "操作资质", question: "资质怎么看？" }, rules)).not.toBe("staff");
  });

  it("falls back to expert for professional claimTypes (credential/outcome/suitability/causality/identity)", () => {
    const rules = [
      { claimType: "credential" as const, terms: ["资质"] },
      { claimType: "outcome" as const, terms: ["效果"] },
      { claimType: "suitability" as const, terms: ["适合"] },
      { claimType: "causality" as const, terms: ["导致"] },
      { claimType: "identity" as const, terms: ["本人"] },
    ];
    expect(routeReplyPostingIdentity({ label: "操作资质", question: "资质怎么看？" }, rules)).toBe("expert");
    expect(routeReplyPostingIdentity({ label: "效果维持", question: "效果能维持多久？" }, rules)).toBe("expert");
    expect(routeReplyPostingIdentity({ label: "适配人群", question: "适合哪些人？" }, rules)).toBe("expert");
    expect(routeReplyPostingIdentity({ label: "副作用", question: "会导致什么问题？" }, rules)).toBe("expert");
    expect(routeReplyPostingIdentity({ label: "本人操作", question: "是本人做吗？" }, rules)).toBe("expert");
  });

  it("falls back to an explicit project publisher otherwise, with no keyword hard routing", () => {
    expect(routeReplyPostingIdentity({ label: "适用条件", question: "哪些条件会改变适用性？" })).toBe("publisher");
    expect(routeReplyPostingIdentity({ label: "比较维度", question: "应该按哪些维度比较？" })).toBe("publisher");
    expect(routeReplyPostingIdentity({ label: "恢复过程", question: "恢复大概要多久？" })).toBe("publisher");
    // 关键词硬路由已删除:没有 claimRules 时,价格话头同样先落 publisher(等引擎 AI 分配)。
    expect(routeReplyPostingIdentity({ label: "价格", question: "做这个多少钱？" })).toBe("publisher");
    expect(routeReplyPostingIdentity({ label: "预约方式", question: "怎么预约报名？" })).toBe("publisher");
    // 命中规则术语但 claimType 不在护栏/专业集合 → 仍 publisher。
    expect(routeReplyPostingIdentity({ label: "效果维持", question: "效果能维持多久？" }, [{ claimType: "other" as const, terms: ["效果"] }])).toBe("publisher");
  });
});

const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

function dualIdentityBlueprint(serviceModel?: string, prohibitedUnsupportedHistories: string[] = []) {
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
          prohibitedUnsupportedHistories,
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
  it("assigns staff to guardrail threads and an explicit project publisher to the rest", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      projectBlueprint: dualIdentityBlueprint("recurring"),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      // 正文叙事人物不能继承 role_model 的机构运营口吻；机构话术只进入答复身份卡。
      expect(plan.personaScenePlan.host.voiceTraits).not.toContain("克制");
      expect(plan.personaScenePlan.host.speechMarkers).not.toContain("短句");
      const priceThread = plan.dialogueThreads.find((thread) => thread.gapId === "price_gap");
      const fitThread = plan.dialogueThreads.find((thread) => thread.gapId === "fit_gap");
      // 合规护栏:命中 price claimType → staff,replyDisplayRole 强制指向助理。
      expect(priceThread?.postingIdentity).toBe("staff");
      expect(priceThread?.surfaceRoleCard?.replyDisplayRole).toBe("知肤研究所助理");
      expect(priceThread?.routingReason).toContain("护栏");
      // 未命中营销/专业护栏时采用角色库的预分配；本蓝图把该读者角色交给专业账号。
      expect(fitThread?.postingIdentity).toBe("expert");
      expect(fitThread?.surfaceRoleCard?.replyDisplayRole).toBe("知肤研究所");
      expect(fitThread?.routingReason).toContain("角色库指定");
    }
  });

  it("在生成之初冻结答复身份：专业/营销护栏高于角色库偏好", () => {
    const blueprint = dualIdentityBlueprint("recurring");
    const cast = planTopicOrchestrations({
      opportunity: marketingOpportunity(), gaps: marketingGaps, config: config(),
      projectBlueprint: blueprint, seeds: [11, 22, 33],
    })[0]!.personaScenePlan.commentCast;
    const rules = [
      { id: "pain", label: "疼痛体验需如实描述并允许个体差异", claimType: "outcome" as const, terms: ["酸胀"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: false, handling: "qualify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "recovery", label: "恢复期效果不承诺绝对", claimType: "outcome" as const, terms: ["一周左右自然"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: false, handling: "qualify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "recurrence", label: "复发保障表述必须有依据且不虚构条款", claimType: "causality" as const, terms: ["复发免费处理"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: true, handling: "qualify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "price", label: "价格区间必须以确认口径为准", claimType: "price" as const, terms: ["费用"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: true, handling: "verify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "location", label: "地址范围", claimType: "location" as const, terms: ["门店"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: true, handling: "verify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "duration", label: "操作时长统一口径", claimType: "schedule" as const, terms: ["操作时长"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: true, handling: "qualify" as const, source: { status: "inference" as const, evidenceIds: [] } },
    ];

    for (const label of ["疼痛体验", "恢复期", "复发保障"]) {
      const route = resolvePlannedReplyRoute(
        { label, question: `${label}怎么判断？` } as any,
        rules,
        "知肤研究所助理", // 即便角色库偏好助理，专业护栏仍优先。
        blueprint,
        cast,
      );
      expect(route.identity, label).toBe("expert");
      expect(route.replyDisplayRole, label).toBe("知肤研究所");
      expect(route.reason, label).toContain("规划期专业护栏");
    }

    for (const item of [
      { label: "价格", question: "费用怎么确认？" },
      { label: "到院地址", question: "门店在哪里？" },
      { label: "操作时长", question: "操作时长多久？" },
    ]) {
      const route = resolvePlannedReplyRoute(item as any, rules, "知肤研究所", blueprint, cast);
      expect(route.identity, item.label).toBe("staff");
      expect(route.replyDisplayRole, item.label).toBe("知肤研究所助理");
      expect(route.reason, item.label).toContain("规划期营销护栏");
    }
  });

  it("结构化 location category 在生成之初冻结为助理，不依赖地址词面命中", () => {
    const blueprint = dualIdentityBlueprint("recurring");
    const route = resolvePlannedReplyRoute(
      { label: "到院信息", question: "具体怎么过去？", category: "location" },
      blueprint.claimPolicy.rules,
      "知肤研究所",
      blueprint,
      [],
    );
    expect(route.identity).toBe("staff");
    expect(route.replyDisplayRole).toBe("知肤研究所助理");
    expect(route.reason).toContain("规划期营销护栏");
  });

  it("冻结主问题判据阻止地址线程被改写成疼痛或价格问题", () => {
    const locationGap = { label: "到院信息", question: "具体位置、预约和交通方式是什么？", category: "location" };
    expect(questionMatchesPlannedGap("具体位置在哪里，怎么预约？", locationGap)).toBe(true);
    expect(questionMatchesPlannedGap("做的时候疼不疼？", locationGap)).toBe(false);
    const rules = [
      { id: "price", label: "价格口径", claimType: "price" as const, terms: ["价格"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: true, handling: "verify" as const, source: { status: "inference" as const, evidenceIds: [] } },
      { id: "pain", label: "疼痛体验", claimType: "outcome" as const, terms: ["疼"], requiresEvidence: true, allowedEvidenceStatuses: ["supplied_fact" as const], dynamic: false, handling: "qualify" as const, source: { status: "inference" as const, evidenceIds: [] } },
    ];
    expect([...guardedReplyIdentitiesForQuestion("另外价格多少？", rules)]).toContain("staff");
    expect([...guardedReplyIdentitiesForQuestion("做的时候疼不疼？", rules)]).toContain("expert");
  });

  it("falls back to an explicit project publisher for every thread when no blueprint is supplied", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      // 无蓝图即无 claimRules:规划期直接冻结为明确项目发布账号，后续不再重分配。
      for (const thread of plan.dialogueThreads) {
        expect(thread.postingIdentity).toBe("publisher");
        expect(thread.surfaceRoleCard?.replyDisplayRole).toBe("项目发布账号");
      }
    }
  });
});

describe("经历约束走标注制 + 开口人物去重 (方法论 §1594/§1745)", () => {
  // 方法论没有"经历位"名额制:禁的是把创作情景当成独立证据,不是"出现几条"。
  // 规划层因此不再指派 experienceCarrier;经历约束改由读者侧提示词逐角色承担。
  it("规划层不再指派经历位名额", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      projectBlueprint: dualIdentityBlueprint("recurring"),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      expect(plan.dialogueThreads.every((thread) =>
        !("experienceCarrier" in thread))).toBe(true);
    }
  });

  it("keeps opener displayRoles unique per plan while the reader pool lasts, marking repeats otherwise", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      projectBlueprint: dualIdentityBlueprint("recurring"),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      // 规划器现在会在现有角色与主 gap/答复职责不匹配时创建中性 gap 读者卡，
      // 因此不能再假设整篇只有一个角色。personaRepeated 必须精确反映同名角色
      // 是否已经在更早线程开口，新增中性角色不应被误标为重复。
      const seen = new Set<string>();
      for (const thread of plan.dialogueThreads) {
        const role = thread.surfaceRoleCard?.displayRole ?? "";
        expect(thread.personaRepeated === true, role).toBe(seen.has(role));
        seen.add(role);
      }
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
          occurrence: { field: "answer", threadId: "t1" },
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

/**
 * 方法论 §1594/1738:经历表述走标注制,不走名额制。禁的是"把创作情景当成独立
 * 口碑/项目事实"(证词形态),不是"提到自己"或"出现几条"。逐角色的"禁止代替的
 * 证据"由读者侧角色卡在提示词里承担(见 prompt.ts READER_ROLE_EVIDENCE_
 * PROHIBITIONS),不在校验层按配额拦。
 */
describe("consumer experience labelling (消费者亲历允许，机构冒充消费者仍阻断)", () => {
  /** 经历类禁语的真源是蓝图:同一句话在不同行业结论相反,由这里参数化。 */
  const blueprintWithProhibitedHistories = (terms: string[]) =>
    dualIdentityBlueprint("recurring", terms);

  it("放行模糊的第一人称处境:提到自己不违规,任何线程都不按配额拦", () => {
    for (const id of ["t1", "t2"]) {
      const issues = validate(
        parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id, question: "我前天做的，现在还有点肿，想问下能不能化妆？" })]))),
      );
      expect(codes(issues), `线程 ${id} 的模糊亲历不应被拦`).not.toContain("fabricated_operational_experience");
    }
  });

  it("多句第一人称处境同样放行:句数不是违规依据", () => {
    const issues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "我前天做的，现在还有点肿。我已经约了下周复查，想问下注意啥？" })]))),
    );
    expect(codes(issues)).not.toContain("fabricated_operational_experience");
  });

  it("已标注模拟消费者可以讲完成经历与主观效果，但只作为创作参考", () => {
    const issues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "我做过了，效果真的很好，姐妹们可以冲。" })]))),
    );
    expect(codes(issues)).not.toContain("fabricated_operational_experience");
    expect(issues).toContainEqual(expect.objectContaining({ code: "creative_persona_experience", severity: "warning" }));
  });

  it("经历类禁语按蓝图真源拦,不按跨行业词表:同一句话在两个行业结论相反", () => {
    // "老用户/回购"算不算不当声明取决于行业与服务模型:recurring(医美)里它是
    // 需要证据支撑的身份声明;one_time / 中性语境里它不该被拦。校验层不自带
    // 词表,只读蓝图 prohibitedUnsupportedHistories 与 historical_action rule。
    const question = "我是老用户了，想问下这次还一样吗？";
    const draft = () => parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question })])));

    // (a) 蓝图把“老用户”列为风险提示，也不能覆盖产品级的“消费者亲历允许”合同。
    const declared = validate(draft(), {
      projectBlueprint: blueprintWithProhibitedHistories(["老用户", "回购"]),
    });
    expect(codes(declared), "模拟消费者身份经历只能作为创作参考，不应被当作造假硬拦")
      .not.toContain("fabricated_operational_experience");

    // (b) 蓝图没列(中性语境) → 不拦,也不该由校验层猜。
    const undeclared = validate(draft(), {
      projectBlueprint: blueprintWithProhibitedHistories(["自行车通勤两年"]),
    });
    expect(codes(undeclared), "蓝图没列就不该跨行业硬拦").not.toContain("fabricated_operational_experience");
  });

  it("蓝图两处禁语皆空时报配置缺失 warning,不静默失效", () => {
    const issues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "想问下适用条件？" })]))),
      { projectBlueprint: blueprintWithProhibitedHistories([]) },
    );
    expect(issues).toContainEqual(expect.objectContaining({
      code: "blueprint_prohibited_history_unspecified", severity: "warning",
    }));
    // 列了内容就不再报。
    expect(codes(validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "想问下适用条件？" })]))),
      { projectBlueprint: blueprintWithProhibitedHistories(["老用户"]) },
    ))).not.toContain("blueprint_prohibited_history_unspecified");
  });

  it("否定式不误伤(证词形态)", () => {
    const negated = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "我没做过，所以想问问到底咋回事？" })]))),
    );
    expect(codes(negated)).not.toContain("fabricated_operational_experience");
  });

  it("否定式不误伤(蓝图禁语):照实转述'没有续费或复购'的服务边界不是声称经历", () => {
    // 线上真实误报:one_time 项目的蓝图把"续费/复购"列为禁止声称,而助理照资料
    // 转述"服务是一次性的，没有续费或复购"——这是**否定**该经历,恰恰是正确口径,
    // 却被裸子串匹配判成 fabricated_operational_experience。
    const blueprint = blueprintWithProhibitedHistories(["二次签约", "续费", "回购", "复购"]);
    for (const sentence of [
      "这个服务是一次性的，一个周期结束就完结，没有续费或复购。",
      // 否定词与禁语之间可以隔着好几个字("不会有后续费用或续费"),定长窗口拦不住;
      // 且"后续费用"本身跨词含有"续费"二字,更要按整个小句判否定作用域。
      "是的，一个周期结束就结清，不会有后续费用或续费。",
      "不涉及回购，做完这次就结束了。",
      "后面无需二次签约，按当期口径来就行。",
      "我们这边未开放复购，具体以当期确认为准。",
    ]) {
      const issues = validate(
        parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", answer: sentence })]))),
        { projectBlueprint: blueprint },
      );
      expect(codes(issues), `否定禁语的转述不应被拦:${sentence}`).not.toContain("fabricated_operational_experience");
    }
  });

  it("模拟消费者真实声称经历也只作为创作参考，不因肯定或否定句式改变", () => {
    const blueprint = blueprintWithProhibitedHistories(["续费", "复购"]);
    for (const sentence of [
      "我复购过两次了，想问下这次还一样吗？",
      // 前半句否定了另一个词,不能豁免后半句真实声称的那个。
      "我没续费，但复购过一回，想问下有区别吗？",
    ]) {
      const issues = validate(
        parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: sentence })]))),
        { projectBlueprint: blueprint },
      );
      expect(codes(issues), `已标注消费者亲历应允许:${sentence}`).not.toContain("fabricated_operational_experience");
    }
  });

  it("可追责答复侧同样不得冒充独立消费者(staff/expert 不只 publisher)", () => {
    // comment_host_state_inconsistency 只覆盖 publisher 一档;证词形态与身份声明
    // 必须对全部可追责身份的答复生效,否则机构号可以自称老用户讲效果。
    for (const postingIdentity of ["staff", "expert", "publisher"]) {
      const issues = validate(
        parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
          thread({ id: "t1", postingIdentity, answer: "我做过一次，效果真的不错，放心。" }),
        ]))),
      );
      expect(issues, `${postingIdentity} 答复侧证词形态应拦`).toContainEqual(
        expect.objectContaining({ code: "fabricated_operational_experience", severity: "warning", disposition: "review" }));
    }
  });
});
