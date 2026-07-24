import { describe, expect, it } from "vitest";

import {
  attachKnowledgeAnchors,
  buildClaimJudgePrompt,
  buildKnowledgeLedger,
  CLAIM_JUDGE_JSON_SCHEMA,
  collectUnanchoredSensitiveClaims,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  judgeSensitiveClaimsWithModel,
  normalizeProjectCreativeBlueprint,
  parseClaimJudgeVerdicts,
  parseGenerationDraft,
  resolveClaimJudgments,
  validateGenerationDraft,
  type EvidenceReference,
  type GenerationDraft,
  type KnowledgeAnchorContext,
  type ModelGenerationRequest,
  type ModelProvider,
  type ProjectBlueprintModuleKey,
} from "../src/index.js";

const project = { id: "p1", name: "测试项目", domain: "信息服务", productPoints: [], organizationPoints: [], cities: [], doctors: [] };

const EV_RECOVERY = "evidence_recovery";
const EV_GIFT = "evidence_gift";
const EV_FOLLOWUP = "evidence_followup";
const EV_INFERRED = "evidence_inferred";

const evidenceSources: Record<string, string> = {
  [EV_RECOVERY]: "根据店内记录,消肿一般7天左右,但每个人体质不同,也有人可能需要两三周。",
  [EV_GIFT]: "本月到店有赠送护理包,数量有限。",
  [EV_FOLLOWUP]: "恢复期以复诊记录为准,大多数人一到两周。",
  [EV_INFERRED]: "消肿一般7天左右。",
};

function evidenceReference(id: string, evidenceStatus: EvidenceReference["evidenceStatus"]): EvidenceReference {
  return {
    id,
    documentId: `doc_${id}`,
    path: `facts/${id}.md`,
    quote: evidenceSources[id],
    kind: "fact",
    evidenceStatus,
    scope: [],
    caveats: [],
  };
}

const evidenceReferences = [
  evidenceReference(EV_RECOVERY, "observed"),
  evidenceReference(EV_GIFT, "user_supplied"),
  evidenceReference(EV_FOLLOWUP, "observed"),
  evidenceReference(EV_INFERRED, "inferred"),
];

// 受控声明规则:词面命中"恢复期"即要求证据。与 knowledge-anchor.test.ts 同一蓝图。
const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

const projectBlueprint = normalizeProjectCreativeBlueprint({
  projectId: "p1",
  sourceFingerprint: "judge-test",
  moduleRevisions: blueprintRevisions,
  modules: {
    knowledge_map: { entries: [] },
    domain_model: {
      projectNoun: "护理项目",
      industry: "信息服务",
      domain: "信息服务",
      objects: ["护理项目"],
      actions: ["比较", "核验"],
      concepts: ["恢复期"],
      decisionTasks: ["核验适用条件"],
      vocabulary: ["恢复期"],
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
        actionConditions: ["关键边界可核验"],
        source: { status: "inference", evidenceIds: [] },
      }],
    },
    scenario_model: {
      families: [{
        id: "scene",
        label: "项目场景",
        prototype: "option_comparison",
        applicableStages: ["comparing"],
        hostIdentityCues: ["做功课的人"],
        lifeContexts: ["午休时继续查"],
        timeAnchors: ["今天午休"],
        settings: ["线上"],
        triggers: ["两种说法对不上"],
        observableActions: ["把差异记进备忘录"],
        frictions: ["只能再问一个问题"],
        emotionalAftertastes: ["有点纠结"],
        imageMoments: ["手机备忘录"],
        prohibitedUnsupportedHistories: [],
        source: { status: "hypothesis", evidenceIds: [] },
      }],
    },
    role_model: {
      hostVoiceTraits: ["克制", "具体"],
      hostSpeechMarkers: ["短句"],
      roles: [{
        id: "peer",
        displayRole: "同路人",
        relationToHost: "处境相近",
        identityCues: ["同路人"],
        situationCues: ["也在比较"],
        motives: ["确认一个边界"],
        knowledgePosition: "只知道公开信息",
        speechPatterns: ["先说处境"],
        lexicalCues: [],
        interactionHooks: ["追问适用条件"],
        permittedContributions: ["提出条件化问题"],
        utteranceModes: ["direct_question"],
        replyDisplayRoles: ["发布者"],
        targetChars: [6, 30],
        accountable: false,
        source: { status: "hypothesis", evidenceIds: [] },
      }],
    },
    claim_policy: {
      rules: [{
        id: "rule_recovery",
        label: "恢复期口径",
        claimType: "outcome",
        terms: ["恢复期"],
        requiresEvidence: true,
        allowedEvidenceStatuses: ["supplied_fact"],
        dynamic: false,
        handling: "verify",
        source: { status: "inference", evidenceIds: [] },
      }],
      prohibitedClaims: [],
      dynamicInformation: [],
      unknownHandling: ["保持未知并给核验路径"],
    },
    surface_language: {
      registerDescription: "自然、具体",
      preferredTerms: ["恢复期"],
      optionalColloquialisms: [],
      prohibitedCliches: [],
      antiCopyRules: [],
    },
  },
});

function anchorContext(overrides: Partial<KnowledgeAnchorContext> = {}): KnowledgeAnchorContext {
  return {
    allowedEvidenceIds: [EV_RECOVERY, EV_GIFT, EV_FOLLOWUP, EV_INFERRED],
    evidenceSources,
    evidenceReferences,
    projectBlueprint,
    ...overrides,
  };
}

function makeDraft(body: string): GenerationDraft {
  return parseGenerationDraft(JSON.stringify({
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads: [] },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  }));
}

function validationConfig() {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "测试";
  config.content.bodyMinChars = 2;
  config.content.bodyMaxChars = 800;
  config.content.hashtagMin = 1;
  config.content.commentThreadMin = 0;
  config.content.commentThreadMax = 6;
  return config;
}

/** 敏感声明校验结果:只取 error 级 sensitive_claim_without_evidence。 */
function sensitiveClaimIssues(draft: GenerationDraft) {
  const context = anchorContext();
  return validateGenerationDraft({
    draft,
    config: validationConfig(),
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: context.allowedEvidenceIds,
    evidenceSources: context.evidenceSources,
    evidenceReferences: context.evidenceReferences,
    projectBlueprint: context.projectBlueprint,
  }).filter((issue) => issue.code === "sensitive_claim_without_evidence");
}

function spyProvider(text: string): ModelProvider & { requests: ModelGenerationRequest[] } {
  const requests: ModelGenerationRequest[] = [];
  return {
    requests,
    async generate(request: ModelGenerationRequest) {
      requests.push(request);
      return { text, raw: {} };
    },
  };
}

/** 机械锚定后的 draft:句面命中词表但锚不到证据,正是判官的输入。 */
function unanchoredDraft(body: string): GenerationDraft {
  const draft = attachKnowledgeAnchors(makeDraft(body), anchorContext());
  expect(collectUnanchoredSensitiveClaims(draft, anchorContext())).toHaveLength(1);
  return draft;
}

describe("judgeSensitiveClaimsWithModel 四类句子裁决", () => {
  it("服务邀约(私聊/帮你安排)→ 放行,旧逻辑下本会误报", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    // 基线:无裁决时旧逻辑对该句报 error(词表命中即敏感)。
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "service_offer", supported: null, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), { model: "test-model" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ schemaName: "claim_judge", model: "test-model" });
    expect(judged.claimJudgments).toEqual([
      { statement: "想约的姐妹私聊我,帮你安排恢复期的面诊。", classification: "service_offer" },
    ]);
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("限定语(以面诊为准)→ 放行", async () => {
    const draft = unanchoredDraft("先记录一下。具体恢复期以面诊为准。");
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "hedge", supported: null, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toEqual([
      { statement: "具体恢复期以面诊为准。", classification: "hedge" },
    ]);
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("疑问/搁置结论(不以问号结尾)→ 放行", async () => {
    const draft = unanchoredDraft("先记录一下。谁说恢复期只要三天呢。");
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "question", supported: null, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("事实断言且知识支持(换说法+真实引文)→ 放行", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, quote: "消肿一般7天左右" }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: true },
    ]);
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("事实断言 supported 但不附引文 → 放行(引文可选)", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: true },
    ]);
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("事实断言无据(编门口停车位,证据源没有)→ error 照旧", async () => {
    const draft = unanchoredDraft("先记录一下。店门口有8个停车位。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: false, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toEqual([
      { statement: "店门口有8个停车位。", classification: "factual_assertion", supported: false },
    ]);
    const issues = sensitiveClaimIssues(judged);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("error");
    expect(issues[0]!.message).toContain("店门口有8个停车位。");
  });

  it("AI 附假引文(非源内连续片段)→ 机械校验拦下改判无据,error 照旧", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, quote: "所有人一周保证消肿" }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: false },
    ]);
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });
});

describe("judgeSensitiveClaimsWithModel 安全降级", () => {
  it("模型输出不可解析 → 无裁决,回退词面旧行为(error 照旧,不更坏)", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const provider = spyProvider("这不是 JSON");
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toBeUndefined();
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  it("模型调用抛错 → 无裁决,不炸", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const provider: ModelProvider = { async generate() { throw new Error("network down"); } };
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(judged.claimJudgments).toBeUndefined();
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  it("无未锚定句时不发起模型调用(零成本),返回原引用", async () => {
    const draft = attachKnowledgeAnchors(makeDraft("消肿一般7天左右。"), anchorContext());
    expect(collectUnanchoredSensitiveClaims(draft, anchorContext())).toHaveLength(0);
    const provider = spyProvider("{}");
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, anchorContext(), {});
    expect(provider.requests).toHaveLength(0);
    expect(judged).toBe(draft);
  });

  it("过期裁决在无未锚定句时被清除(句面已变不留旧账)", async () => {
    const anchored = attachKnowledgeAnchors(makeDraft("消肿一般7天左右。"), anchorContext());
    const stale: GenerationDraft = {
      ...anchored,
      claimJudgments: [{ statement: "旧句。", classification: "service_offer" }],
    };
    const provider = spyProvider("{}");
    const judged = await judgeSensitiveClaimsWithModel(provider, stale, anchorContext(), {});
    expect(provider.requests).toHaveLength(0);
    expect(judged.claimJudgments).toBeUndefined();
  });
});

describe("parseClaimJudgeVerdicts / resolveClaimJudgments", () => {
  const claims = [
    { statement: "句甲。", location: "N.body" as const, occurrence: { field: "body" as const } },
    { statement: "句乙。", location: "N.body" as const, occurrence: { field: "body" as const } },
  ];
  const pool = [{ evidenceId: EV_RECOVERY, quote: evidenceSources[EV_RECOVERY]! }];

  it("异常形状、越界/重复编号、未知分类、事实断言缺 supported 一律丢弃", () => {
    expect(parseClaimJudgeVerdicts("garbage", 2)).toEqual([]);
    expect(parseClaimJudgeVerdicts({ judgments: "nope" }, 2)).toEqual([]);
    expect(parseClaimJudgeVerdicts({
      judgments: [
        { statementIndex: 7, classification: "hedge", supported: null, quote: null },
        { statementIndex: 0, classification: "unknown_kind", supported: null, quote: null },
        { statementIndex: 0, classification: "service_offer", supported: null, quote: null },
        { statementIndex: 0, classification: "hedge", supported: null, quote: null },
      ],
    }, 2)).toEqual([{ statementIndex: 0, classification: "service_offer" }]);
  });

  it("事实断言缺 supported 的条目丢弃;非事实断言忽略 supported/quote", () => {
    expect(parseClaimJudgeVerdicts({
      judgments: [
        { statementIndex: 0, classification: "factual_assertion", quote: null },
        { statementIndex: 1, classification: "hedge", supported: true, quote: "多余的字段" },
      ],
    }, 2)).toEqual([
      { statementIndex: 1, classification: "hedge" },
    ]);
  });

  it("resolve:引文是源内连续片段才保 supported,否则改判无据;编号越界跳过", () => {
    const judgments = resolveClaimJudgments(claims, [
      { statementIndex: 0, classification: "factual_assertion", supported: true, quote: "消肿一般7天左右" },
      { statementIndex: 1, classification: "factual_assertion", supported: true, quote: "编造的一句话" },
      { statementIndex: 9, classification: "hedge" },
    ], pool);
    expect(judgments).toEqual([
      { statement: "句甲。", classification: "factual_assertion", supported: true },
      { statement: "句乙。", classification: "factual_assertion", supported: false },
    ]);
  });
});

describe("buildClaimJudgePrompt", () => {
  it("提示词带句子编号与证据源全文,schema 锁定四类分类", () => {
    const prompt = buildClaimJudgePrompt({
      statements: ["想约的姐妹私聊我,帮你安排恢复期的面诊。", "店门口有8个停车位。"],
      evidenceSources: [{ evidenceId: EV_RECOVERY, quote: evidenceSources[EV_RECOVERY]! }],
    });
    const text = prompt.messages.map((message) => message.content).join("\n");
    expect(text).toContain("0. 想约的姐妹私聊我,帮你安排恢复期的面诊。");
    expect(text).toContain("1. 店门口有8个停车位。");
    expect(text).toContain(evidenceSources[EV_RECOVERY]!);
    expect(text).toContain("service_offer");
    expect(prompt.responseSchema).toBe(CLAIM_JUDGE_JSON_SCHEMA);
    expect(prompt.estimatedTokens).toBeGreaterThan(0);
  });
});
