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

  it("falls back to publisher (楼主) otherwise, with no keyword hard routing", () => {
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
  it("assigns staff to guardrail threads and publisher to the rest, forcing replyDisplayRole per identity", () => {
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
      // 合规护栏:命中 price claimType → staff,replyDisplayRole 强制指向助理。
      expect(priceThread?.postingIdentity).toBe("staff");
      expect(priceThread?.surfaceRoleCard?.replyDisplayRole).toBe("知肤研究所助理");
      expect(priceThread?.routingReason).toContain("护栏");
      // 未命中护栏与专业类的线程兜底 publisher(楼主),replyDisplayRole 强制"楼主"。
      expect(fitThread?.postingIdentity).toBe("publisher");
      expect(fitThread?.surfaceRoleCard?.replyDisplayRole).toBe("楼主");
      expect(fitThread?.routingReason).toContain("兜底");
    }
  });

  it("falls back to publisher (楼主) for every thread when no blueprint is supplied", () => {
    const plans = planTopicOrchestrations({
      opportunity: marketingOpportunity(),
      gaps: marketingGaps,
      config: config(),
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      // 无蓝图即无 claimRules:护栏不命中,关键词硬路由已删除,营销话头同样
      // 先落 publisher(楼主),等引擎阶段 2 的 AI 分配再覆盖。
      for (const thread of plan.dialogueThreads) {
        expect(thread.postingIdentity).toBe("publisher");
        expect(thread.surfaceRoleCard?.replyDisplayRole).toBe("楼主");
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
      // 双号蓝图读者席只有 1 个非机构角色(谨慎比较者),线程数必然超过池容量:
      // 1 条线程占用,其余重复开口的线程必须标 personaRepeated。
      const marked = plan.dialogueThreads.filter((thread) => thread.personaRepeated === true);
      const unmarked = plan.dialogueThreads.filter((thread) => thread.personaRepeated !== true);
      expect(marked.length).toBe(plan.dialogueThreads.length - 1);
      expect(unmarked.length).toBe(1);
      // 开口人物同篇不重复:未标记者之间 displayRole 不得重复(本夹具池=1,恒成立)。
      const unmarkedRoles = unmarked.map((thread) => thread.surfaceRoleCard?.displayRole);
      expect(new Set(unmarkedRoles).size).toBe(unmarkedRoles.length);
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

/**
 * 方法论 §1594/1738:经历表述走标注制,不走名额制。禁的是"把创作情景当成独立
 * 口碑/项目事实"(证词形态),不是"提到自己"或"出现几条"。逐角色的"禁止代替的
 * 证据"由读者侧角色卡在提示词里承担(见 prompt.ts READER_ROLE_EVIDENCE_
 * PROHIBITIONS),不在校验层按配额拦。
 */
describe("fabricated_operational_experience (标注制:只拦证词形态与蓝图禁令)", () => {
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

  it("证词形态(第一人称完成＋效果背书)仍是 error——那是独立口碑不是处境", () => {
    const issues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "我做过了，效果真的很好，姐妹们可以冲。" })]))),
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: "fabricated_operational_experience", severity: "error" }));
  });

  it("经历类禁语按蓝图真源拦,不按跨行业词表:同一句话在两个行业结论相反", () => {
    // "老用户/回购"算不算不当声明取决于行业与服务模型:recurring(医美)里它是
    // 需要证据支撑的身份声明;one_time / 中性语境里它不该被拦。校验层不自带
    // 词表,只读蓝图 prohibitedUnsupportedHistories 与 historical_action rule。
    const question = "我是老用户了，想问下这次还一样吗？";
    const draft = () => parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question })])));

    // (a) 蓝图把"老用户"列为禁止声称 → error。
    const declared = validate(draft(), {
      projectBlueprint: blueprintWithProhibitedHistories(["老用户", "回购"]),
    });
    expect(declared, "蓝图列了禁语就该拦").toContainEqual(
      expect.objectContaining({ code: "fabricated_operational_experience", severity: "error" }));

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

  it("否定式不误伤", () => {
    const negated = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ id: "t1", question: "我没做过，所以想问问到底咋回事？" })]))),
    );
    expect(codes(negated)).not.toContain("fabricated_operational_experience");
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
        expect.objectContaining({ code: "fabricated_operational_experience", severity: "error" }));
    }
  });
});
