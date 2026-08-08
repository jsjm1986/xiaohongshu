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
const EV_REVIEW = "evidence_review";

const evidenceSources: Record<string, string> = {
  [EV_RECOVERY]: "根据店内记录,消肿一般7天左右,但每个人体质不同,也有人可能需要两三周。",
  [EV_GIFT]: "本月到店有赠送护理包,数量有限。",
  [EV_FOLLOWUP]: "恢复期以复诊记录为准,大多数人一到两周。",
  [EV_INFERRED]: "消肿一般7天左右。",
  [EV_REVIEW]: "根据店内记录（消肿一般7天左右）但每个人体质不同也有人可能需要两三周",
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
  evidenceReference(EV_REVIEW, "observed"),
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

const reviewContext = anchorContext({
  allowedEvidenceIds: [EV_REVIEW],
  evidenceSources: { [EV_REVIEW]: evidenceSources[EV_REVIEW]! },
  evidenceReferences: [evidenceReference(EV_REVIEW, "observed")],
});

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
function sensitiveClaimIssues(draft: GenerationDraft, context = reviewContext) {
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
  const draft = attachKnowledgeAnchors(makeDraft(body), reviewContext);
  expect(collectUnanchoredSensitiveClaims(draft, reviewContext)).toHaveLength(1);
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
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, { model: "test-model" });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({ schemaName: "claim_judge", model: "test-model" });
    expect(judged.claimJudgments).toEqual([
      { statement: "帮你安排恢复期的面诊。", classification: "service_offer" },
    ]);
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("限定语(以面诊为准)→ 放行", async () => {
    const draft = unanchoredDraft("先记录一下。具体恢复期以面诊为准。");
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "hedge", supported: null, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
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
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });

  it("事实断言且知识支持(换说法+真实引文)→ 放行", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    expect(sensitiveClaimIssues(draft)).toHaveLength(1);

    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, evidenceId: EV_REVIEW, quote: "消肿一般7天左右" }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(judged.claimJudgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: true },
    ]);
    expect(judged.reasoning).toContainEqual(expect.objectContaining({
      statement: "大部分人7天左右能消肿。",
      status: "fact",
      evidenceIds: [EV_REVIEW],
      sourceSpans: [{ evidenceId: EV_REVIEW, quote: "消肿一般7天左右" }],
    }));
    expect(sensitiveClaimIssues(judged)).toEqual([]);
  });


  it("群体体验和近绝对感受也进入证据判官，而不是作为普通文案漏过", async () => {
    for (const body of ["很多人聊着天就做完了。", "操作时基本无痛。", "刺痛就几秒。"] as const) {
      const draft = unanchoredDraft(body);
      expect(collectUnanchoredSensitiveClaims(draft, reviewContext), body).toHaveLength(1);
      expect(sensitiveClaimIssues(draft), body).toHaveLength(1);
    }
  });

  it("疼痛口径自然改写由 AI 语义裁决放行，越界比较仍由 AI 阻断", async () => {
    const evidenceId = "evidence_pain";
    const source = "打麻药的时候有短暂的进针刺痛感，之后操作无痛感，些许人会有酸胀、牵拉或压迫感；过程中可沟通并根据情况调整节奏。";
    const painContext = anchorContext({
      allowedEvidenceIds: [evidenceId],
      evidenceSources: { [evidenceId]: source },
      evidenceReferences: [{
        id: evidenceId, documentId: "doc_pain", path: "pain.md", quote: source,
        kind: "fact", evidenceStatus: "observed", scope: [], caveats: [],
      }],
      projectBlueprint: {
        ...projectBlueprint,
        claimPolicy: {
          ...projectBlueprint.claimPolicy,
          rules: projectBlueprint.claimPolicy.rules.map((rule) => ({
            ...rule, terms: ["疼", "刺痛", "酸胀", "牵拉", "抽血"],
          })),
        },
      },
    });

    const natural = attachKnowledgeAnchors(makeDraft("打麻药时会短暂刺痛，之后部分人会觉得酸胀或牵拉。"), painContext);
    expect(collectUnanchoredSensitiveClaims(natural, painContext)).toHaveLength(2);
    const supported = await judgeSensitiveClaimsWithModel(spyProvider(JSON.stringify({
      judgments: [
        {
          statementIndex: 0, classification: "factual_assertion", supported: true,
          evidenceId, quote: "打麻药的时候有短暂的进针刺痛感",
        },
        {
          statementIndex: 1, classification: "factual_assertion", supported: true,
          evidenceId, quote: "些许人会有酸胀、牵拉或压迫感",
        },
      ],
    })), natural, painContext, {});
    expect(supported.reasoning.filter((item) => item.semanticSupport === "ai_judged"), JSON.stringify(supported.reasoning, null, 2)).toHaveLength(2);
    expect(supported.reasoning).toEqual(expect.arrayContaining([
      expect.objectContaining({ statement: "打麻药时会短暂刺痛", evidenceIds: [evidenceId] }),
      expect.objectContaining({ statement: "之后部分人会觉得酸胀或牵拉。", evidenceIds: [evidenceId] }),
    ]));
    expect(sensitiveClaimIssues(supported, painContext)).toEqual([]);

    const comparison = attachKnowledgeAnchors(makeDraft("比抽血轻一点。"), painContext);
    const unsupported = await judgeSensitiveClaimsWithModel(spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: false, evidenceId: null, quote: null }],
    })), comparison, painContext, {});
    const issues = sensitiveClaimIssues(unsupported, painContext);
    expect(issues).toContainEqual(expect.objectContaining({
      code: "sensitive_claim_without_evidence", disposition: "review", origin: "agent",
      severity: "warning", overridePolicy: "human_reviewable",
    }));
  });

  it("事实断言 supported 但缺来源身份或引文 → 强制改判无据", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, evidenceId: null, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(judged.claimJudgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: false },
    ]);
    expect(judged.reasoning.some((item) => item.status === "fact")).toBe(false);
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  it("事实断言无据(编门口停车位,证据源没有)→ 保留复核提醒但不阻断", async () => {
    const draft = unanchoredDraft("先记录一下。店门口有8个停车位。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: false, quote: null }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(judged.claimJudgments).toEqual([
      { statement: "店门口有8个停车位。", classification: "factual_assertion", supported: false },
    ]);
    const issues = sensitiveClaimIssues(judged);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", disposition: "review", overridePolicy: "human_reviewable" });
    expect(issues[0]!.message).toContain("店门口有8个停车位。");
  });

  it("AI 附假引文(非源内连续片段)→ 机械校验拦下改判无据,error 照旧", async () => {
    const draft = unanchoredDraft("先记录一下。大部分人7天左右能消肿。");
    const provider = spyProvider(JSON.stringify({
      judgments: [{ statementIndex: 0, classification: "factual_assertion", supported: true, evidenceId: EV_RECOVERY, quote: "所有人一周保证消肿" }],
    }));
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
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
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(judged.claimJudgments).toBeUndefined();
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  it("模型调用抛错 → 无裁决,不炸", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const provider: ModelProvider = { async generate() { throw new Error("network down"); } };
    const judged = await judgeSensitiveClaimsWithModel(provider, draft, reviewContext, {});
    expect(judged.claimJudgments).toBeUndefined();
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  /**
   * 降级不再无声。判官整体失效时行为上只是"回退词面判定"(保守、不更坏),但没有
   * 任何信号:实测生产 174 个包 claimJudgments 全为 0、60 个包报出受控声明
   * error,无从判断是文案无据还是判官没跑。onFailure 把真因交给调用方。
   */
  it("判官失败时把真因交给 onFailure,降级行为不变", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const failures: unknown[] = [];
    const thrown = new Error("读取响应失败: error decoding response body");
    const judged = await judgeSensitiveClaimsWithModel(
      { async generate() { throw thrown; } },
      draft,
      reviewContext,
      { onFailure: (error) => failures.push(error) },
    );
    expect(failures).toEqual([thrown]);
    // 降级语义不变:仍无裁决、仍按词面报 error。
    expect(judged.claimJudgments).toBeUndefined();
    expect(sensitiveClaimIssues(judged)).toHaveLength(1);
  });

  it("解析失败(而非调用抛错)同样触发 onFailure", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const failures: unknown[] = [];
    await judgeSensitiveClaimsWithModel(spyProvider("这不是 JSON"), draft, reviewContext, {
      onFailure: (error) => failures.push(error),
    });
    expect(failures).toHaveLength(1);
  });

  it("判官成功时不触发 onFailure", async () => {
    const draft = unanchoredDraft("今天整理了大家常问的问题。想约的姐妹私聊我,帮你安排恢复期的面诊。");
    const failures: unknown[] = [];
    const judged = await judgeSensitiveClaimsWithModel(
      spyProvider(JSON.stringify({ judgments: [{ statementIndex: 0, classification: "service_offer" }] })),
      draft,
      reviewContext,
      { onFailure: (error) => failures.push(error) },
    );
    expect(failures).toEqual([]);
    expect(judged.claimJudgments).toHaveLength(1);
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
    { statement: "大部分人7天左右能消肿。", location: "N.body" as const, occurrence: { field: "body" as const } },
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
      { statementIndex: 0, classification: "factual_assertion", supported: true, evidenceId: EV_RECOVERY, quote: "消肿一般7天左右" },
      { statementIndex: 1, classification: "factual_assertion", supported: true, evidenceId: EV_RECOVERY, quote: "编造的一句话" },
      { statementIndex: 9, classification: "hedge" },
    ], pool);
    expect(judgments).toEqual([
      { statement: "大部分人7天左右能消肿。", classification: "factual_assertion", supported: true },
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
