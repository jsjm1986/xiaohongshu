import { describe, expect, it } from "vitest";

import {
  attachKnowledgeAnchors,
  attachKnowledgeAnchorSelections,
  buildKnowledgeLedger,
  collectUnanchoredSensitiveClaims,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  validateGenerationDraft,
  type EvidenceReference,
  type GenerationDraft,
  type KnowledgeAnchorContext,
  type ProjectBlueprintModuleKey,
} from "../src/index.js";

const project = { id: "p1", name: "测试项目", domain: "信息服务", productPoints: [], organizationPoints: [], cities: [], doctors: [] };

const EV_RECOVERY = "evidence_recovery";
const EV_GIFT = "evidence_gift";
const EV_FOLLOWUP = "evidence_followup";
const EV_INFERRED = "evidence_inferred";
const EV_REVIEW = "evidence_review";
const EV_ORGANIZATION = "evidence_organization";

const evidenceSources: Record<string, string> = {
  // 单句内含"可能",整句过不了保守支持门;其中"消肿一般7天左右"是可用于 AI 复核的子片段。
  [EV_RECOVERY]: "根据店内记录,消肿一般7天左右,但每个人体质不同,也有人可能需要两三周。",
  [EV_GIFT]: "本月到店有赠送护理包,数量有限。",
  [EV_FOLLOWUP]: "恢复期以复诊记录为准,大多数人一到两周。",
  [EV_INFERRED]: "消肿一般7天左右。",
  // No sentence/comma boundary around the useful exact substring: deterministic
  // candidate extraction stays conservative, while the judge may point to the
  // exact contiguous quote and the server still verifies it mechanically.
  [EV_REVIEW]: "根据店内记录（消肿一般7天左右）但每个人体质不同也有人可能需要两三周",
  [EV_ORGANIZATION]: [
    "| 机构定位 | 专注眼周年轻化，尤其擅长眼袋；机构类型为门诊 |",
    "| 地址 | 成都锦江区，锦华万达附近 |",
  ].join("\n"),
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
  evidenceReference(EV_ORGANIZATION, "observed"),
];

// 受控声明规则:词面命中"恢复期"即要求证据。完整蓝图走 normalize,与校验层同构。
const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

const projectBlueprint = normalizeProjectCreativeBlueprint({
  projectId: "p1",
  sourceFingerprint: "anchor-test",
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

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    question: "这个恢复要多久？",
    answer: "先按医嘱观察。",
    followUps: [] as unknown[],
    postingIdentity: "publisher",
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

function followUp(overrides: Record<string, unknown> = {}) {
  return {
    question: "那复诊怎么算？",
    answer: "到时候再看。",
    evidenceIds: [] as string[],
    personaRole: "information_collector",
    speakerType: "simulated_reader",
    claimStatus: "hypothetical",
    replyTo: "t1",
    threadDepth: 1,
    simulated: true,
    simulationLabel: "模拟潜在读者追问",
    ...overrides,
  };
}

function makeDraft(body: string, threads: unknown[]): GenerationDraft {
  return parseGenerationDraft(JSON.stringify({
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads },
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

// 锚定台账必须通过的校验链:error 级证据/台账码一个都不能有。
const ANCHOR_GATE_CODES = [
  "sensitive_claim_without_evidence",
  "ungrounded_fact",
  "fact_source_span_missing",
  "fact_source_id_mismatch",
  "evidence_quote_empty",
  "evidence_quote_not_exact",
  "evidence_quote_not_supportive",
  "evidence_role_cannot_support_fact",
  "comment_reasoning_occurrence_missing",
  "package_evidence_ledger_mismatch",
  "thread_evidence_ledger_mismatch",
  "followup_evidence_ledger_mismatch",
  "unknown_evidence",
];

function gateIssues(draft: GenerationDraft) {
  const context = anchorContext();
  return validateGenerationDraft({
    draft,
    config: validationConfig(),
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: context.allowedEvidenceIds,
    evidenceSources: context.evidenceSources,
    evidenceReferences: context.evidenceReferences,
    projectBlueprint: context.projectBlueprint,
  }).filter((issue) => ANCHOR_GATE_CODES.includes(issue.code));
}

describe("attachKnowledgeAnchors 机械锚定", () => {
  it("敏感面命中句子自动挂 fact 台账并过全校验链", () => {
    const draft = makeDraft("今天把流程问清楚了。消肿一般7天左右。", [
      thread({
        answer: "到店有赠送护理包。最近有优惠吗？",
        followUps: [followUp({ answer: "恢复期以复诊记录为准。" })],
      }),
    ]);
    const anchored = attachKnowledgeAnchors(draft, anchorContext());

    // N.body 数字声明 → EV_RECOVERY;线程 answer 承诺词 → EV_GIFT;followUp 受控词 → EV_FOLLOWUP。
    // 问号结尾的"最近有优惠吗?"不锚定。
    const facts = anchored.reasoning.filter((item) => item.status === "fact");
    expect(facts).toHaveLength(3);
    const bodyFact = facts.find((item) => item.location === "N.body");
    expect(bodyFact).toMatchObject({
      statement: "消肿一般7天左右。",
      evidenceIds: [EV_RECOVERY],
      occurrence: { field: "body" },
      sourceSpans: [{ evidenceId: EV_RECOVERY, quote: "消肿一般7天左右" }],
    });
    const threadFact = facts.find((item) => item.location === "Cref.thread");
    expect(threadFact).toMatchObject({
      statement: "到店有赠送护理包。",
      occurrence: { field: "answer", threadId: "t1" },
      evidenceIds: [EV_GIFT],
    });
    const followUpFact = facts.find((item) => item.location === "Cref.followUp");
    expect(followUpFact).toMatchObject({
      statement: "恢复期以复诊记录为准。",
      occurrence: { field: "answer", threadId: "t1", followUpIndex: 0 },
      evidenceIds: [EV_FOLLOWUP],
    });

    // 台账一致性:thread/followUp/顶层 evidenceIds 同步。
    const t1 = anchored.content.Cref.threads[0]!;
    expect(t1.evidenceIds).toEqual([EV_GIFT]);
    expect(t1.followUps[0]!.evidenceIds).toEqual([EV_FOLLOWUP]);
    expect([...anchored.evidenceIds].sort()).toEqual([EV_FOLLOWUP, EV_GIFT, EV_RECOVERY].sort());

    expect(gateIssues(anchored)).toEqual([]);
  });

  it("角色不合规(inferred)的证据源不进锚定池", () => {
    const draft = makeDraft("今天把流程问清楚了。消肿一般7天左右。", []);
    const context = anchorContext({ allowedEvidenceIds: [EV_INFERRED] });
    const anchored = attachKnowledgeAnchors(draft, context);
    expect(anchored).toBe(draft);
    const issues = validateGenerationDraft({
      draft: anchored,
      config: validationConfig(),
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: context.allowedEvidenceIds,
      evidenceSources: context.evidenceSources,
      evidenceReferences: context.evidenceReferences,
      projectBlueprint: context.projectBlueprint,
    });
    expect(issues.some((issue) => issue.code === "sensitive_claim_without_evidence")).toBe(true);
  });

  it("读者互聊(reader_exchange)的 answer 不在敏感面内,不锚定", () => {
    // threadKind 由引擎 bind 阶段从计划带入,模型 JSON 解析不保留,这里解析后补回。
    const parsed = makeDraft("先记录一下。", [
      thread({ id: "t2", answer: "消肿一般7天左右。" }),
    ]);
    const draft: GenerationDraft = {
      ...parsed,
      content: {
        ...parsed.content,
        Cref: {
          ...parsed.content.Cref,
          threads: parsed.content.Cref.threads.map((item) => ({ ...item, threadKind: "reader_exchange" as const })),
        },
      },
    };
    const anchored = attachKnowledgeAnchors(draft, anchorContext());
    expect(anchored.reasoning.filter((item) => item.status === "fact")).toHaveLength(0);
  });

  it("幂等:重复执行返回原引用,已挂台账不重复、不覆盖", () => {
    const draft = makeDraft("消肿一般7天左右。", []);
    const anchored = attachKnowledgeAnchors(draft, anchorContext());
    expect(attachKnowledgeAnchors(anchored, anchorContext())).toBe(anchored);
    expect(anchored.reasoning).toHaveLength(1);
  });
});


describe("生产机构信息证据回归", () => {
  const organizationBlueprint = structuredClone(projectBlueprint);
  organizationBlueprint.claimPolicy.rules = [{
    ...organizationBlueprint.claimPolicy.rules[0]!,
    id: "rule_organization",
    label: "机构公开信息",
    claimType: "identity",
    terms: ["机构类型", "门诊", "专注眼周年轻化", "地址", "锦华万达", "门牌", "地铁站"],
  }];
  const context: KnowledgeAnchorContext = {
    allowedEvidenceIds: [EV_ORGANIZATION],
    evidenceSources: { [EV_ORGANIZATION]: evidenceSources[EV_ORGANIZATION]! },
    evidenceReferences: [evidenceReference(EV_ORGANIZATION, "observed")],
    projectBlueprint: organizationBlueprint,
  };
  const validate = (draft: GenerationDraft) => validateGenerationDraft({
    draft,
    config: validationConfig(),
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: context.allowedEvidenceIds,
    evidenceSources: context.evidenceSources,
    evidenceReferences: context.evidenceReferences,
    projectBlueprint: context.projectBlueprint,
  });

  it("anchors the production organization paraphrase from exact table rows", () => {
    const draft = attachKnowledgeAnchors(makeDraft(
      "机构类型是门诊，专注眼周年轻化，地址在成都锦江区锦华万达附近。",
      [],
    ), context);
    const facts = draft.reasoning.filter((item) => item.status === "fact");
    expect(facts.map((item) => item.statement)).toEqual([
      "机构类型是门诊",
      "专注眼周年轻化",
      "地址在成都锦江区锦华万达附近。",
    ]);
    expect(facts.every((item) => item.sourceSpans?.every((span) =>
      evidenceSources[EV_ORGANIZATION]!.includes(span.quote)))).toBe(true);
    expect(validate(draft).filter((issue) => issue.code === "sensitive_claim_without_evidence")).toEqual([]);
  });

  it("anchors production body relation forms without weakening their source requirements", () => {
    const draft = attachKnowledgeAnchors(makeDraft(
      "门诊在成都锦江区锦华万达附近，专注眼周年轻化。我们在成都锦江区锦华万达附近。",
      [],
    ), context);
    expect(draft.reasoning.map((item) => item.statement)).toEqual([
      "门诊在成都锦江区锦华万达附近",
      "专注眼周年轻化。",
      "我们在成都锦江区锦华万达附近。",
    ]);
    expect(validate(draft).filter((issue) => issue.code === "sensitive_claim_without_evidence")).toEqual([]);

    const addressOnlyContext: KnowledgeAnchorContext = {
      ...context,
      evidenceSources: { [EV_ORGANIZATION]: "| 地址 | 成都锦江区，锦华万达附近 |" },
      evidenceReferences: [{
        ...evidenceReference(EV_ORGANIZATION, "observed"),
        quote: "| 地址 | 成都锦江区，锦华万达附近 |",
      }],
    };
    const addressOnly = attachKnowledgeAnchors(makeDraft("门诊在成都锦江区锦华万达附近。", []), addressOnlyContext);
    expect(addressOnly.reasoning).toEqual([]);
  });

  it("anchors natural organization wording and still returns exact source quotes", () => {
    const draft = attachKnowledgeAnchors(makeDraft(
      "位置在成都锦江区锦华万达附近，我们是一家专注眼周年轻化的门诊。",
      [],
    ), context);
    expect(draft.reasoning.map((item) => item.statement)).toEqual([
      "位置在成都锦江区锦华万达附近",
      "我们是一家专注眼周年轻化的门诊。",
    ]);
    expect(draft.reasoning.every((item) => item.sourceSpans?.length)).toBe(true);
    expect(draft.reasoning.flatMap((item) => item.sourceSpans ?? []).every((span) =>
      evidenceSources[EV_ORGANIZATION]!.includes(span.quote))).toBe(true);
    expect(validate(draft).filter((issue) => issue.code === "sensitive_claim_without_evidence")).toEqual([]);
  });

  it("does not invent unknown navigation details while retaining the grounded public area", () => {
    const draft = attachKnowledgeAnchors(makeDraft(
      "具体门牌和地铁站还没有公开，地址在锦华万达附近；",
      [],
    ), context);
    expect(draft.reasoning.some((item) => item.statement.includes("具体门牌"))).toBe(false);
    expect(draft.reasoning.some((item) => item.statement.includes("地址在锦华万达附近"))).toBe(true);
    expect(validate(draft)).toContainEqual(expect.objectContaining({
      code: "sensitive_claim_without_evidence",
      severity: "warning",
      disposition: "review",
      overridePolicy: "human_reviewable",
      message: expect.stringContaining("具体门牌和地铁站还没有公开"),
    }));
  });

  it("routes an unsupported precise address to AI or human review when no AI verdict exists", () => {
    const draft = attachKnowledgeAnchors(makeDraft("地址在锦华万达A座12楼。", []), context);
    expect(draft.reasoning.filter((item) => item.status === "fact")).toHaveLength(0);
    expect(validate(draft)).toContainEqual(expect.objectContaining({
      code: "sensitive_claim_without_evidence",
      severity: "warning",
      disposition: "review",
      overridePolicy: "human_reviewable",
    }));
  });
});

describe("collectUnanchoredSensitiveClaims + 联合判官机械挂账", () => {
  // The useful quote is exact but embedded in a source line that also carries
  // uncertainty. Mechanical candidate extraction does not guess a substring;
  // the judge may select it, and the server verifies exact containment/support.
  const spacedBody = "先记录下恢复过程。消肿一般 7 天左右。";
  const reviewContext = anchorContext({
    allowedEvidenceIds: [EV_REVIEW],
    evidenceSources: { [EV_REVIEW]: evidenceSources[EV_REVIEW]! },
    evidenceReferences: [evidenceReference(EV_REVIEW, "observed")],
  });


  const reviewGateIssues = (draft: GenerationDraft) => validateGenerationDraft({
    draft,
    config: validationConfig(),
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: reviewContext.allowedEvidenceIds,
    evidenceSources: reviewContext.evidenceSources,
    evidenceReferences: reviewContext.evidenceReferences,
    projectBlueprint: reviewContext.projectBlueprint,
  }).filter((issue) => ANCHOR_GATE_CODES.includes(issue.code));

  it("机械未命中的句子进入复核清单", () => {
    const draft = attachKnowledgeAnchors(makeDraft(spacedBody, []), reviewContext);
    const claims = collectUnanchoredSensitiveClaims(draft, reviewContext);
    expect(claims).toEqual([{ statement: "消肿一般 7 天左右。", location: "N.body", occurrence: { field: "body" } }]);
  });

  it("AI 选中且机械校验通过 → 挂账并过全校验链", () => {
    const draft = attachKnowledgeAnchors(makeDraft(spacedBody, []), reviewContext);
    const context = reviewContext;
    const claims = collectUnanchoredSensitiveClaims(draft, context);
    const anchored = attachKnowledgeAnchorSelections(draft, context, claims, [
      { statementIndex: 0, evidenceId: EV_REVIEW, quote: "消肿一般7天左右" },
    ]);
    expect(anchored.reasoning.filter((item) => item.status === "fact")).toHaveLength(1);
    expect(anchored.evidenceIds).toEqual([EV_REVIEW]);
    expect(reviewGateIssues(anchored)).toEqual([]);
    // 幂等:同一选择再挂一次不重复。
    expect(attachKnowledgeAnchorSelections(anchored, context, claims, [
      { statementIndex: 0, evidenceId: EV_REVIEW, quote: "消肿一般7天左右" },
    ])).toBe(anchored);
  });

  it("AI 编造 quote(不是源内连续片段)→ 机械校验拦下,error 照旧", () => {
    const draft = attachKnowledgeAnchors(makeDraft(spacedBody, []), reviewContext);
    const context = reviewContext;
    const claims = collectUnanchoredSensitiveClaims(draft, context);
    const anchored = attachKnowledgeAnchorSelections(draft, context, claims, [
      { statementIndex: 0, evidenceId: EV_RECOVERY, quote: "消肿肯定7天能好" },
    ]);
    expect(anchored).toBe(draft);
    expect(reviewGateIssues(anchored).some((issue) => issue.code === "sensitive_claim_without_evidence")).toBe(true);
  });

  it("AI 选了角色不合规的源 → 拦下不挂", () => {
    const draft = attachKnowledgeAnchors(makeDraft(spacedBody, []), reviewContext);
    const context = reviewContext;
    const claims = collectUnanchoredSensitiveClaims(draft, context);
    const anchored = attachKnowledgeAnchorSelections(draft, context, claims, [
      { statementIndex: 0, evidenceId: EV_INFERRED, quote: "消肿一般7天左右" },
    ]);
    expect(anchored).toBe(draft);
  });

  it("AI 选 none → 不挂且 error 照旧", () => {
    const draft = attachKnowledgeAnchors(makeDraft(spacedBody, []), reviewContext);
    const context = reviewContext;
    const claims = collectUnanchoredSensitiveClaims(draft, context);
    const anchored = attachKnowledgeAnchorSelections(draft, context, claims, []);
    expect(anchored).toBe(draft);
    expect(reviewGateIssues(anchored).some((issue) => issue.code === "sensitive_claim_without_evidence")).toBe(true);
  });


});
