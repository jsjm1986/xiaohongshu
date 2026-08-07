import { describe, expect, it } from "vitest";

import {
  buildGenerationPrompt,
  buildKnowledgeLedger,
  buildOrgThreadScope,
  buildRepairPrompt,
  buildStagedCommentGrowthPrompt,
  buildStagedCommentEditorPrompt,
  buildStagedCommentReadersCorrectionPrompt,
  buildStagedCommentReadersPrompt,
  buildStagedCommentReadersRegenerationPrompt,
  buildStagedCoreIdentityRepairPrompt,
  buildStagedCorePrompt,
  buildStagedHostAnswersPrompt,
  buildStagedOrgAnswersPrompt,
  buildStagedOrgFollowUpAnswersPrompt,
  commentStageInstructions,
  compileGenerationParameters,
  GENERATION_PARAMETER_REGISTRY,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  parseStagedCommentReaders,
  parseStagedOrgAnswers,
  planTopicOrchestrations,
  selectKnowledgeContext,
  STAGED_COMMENT_DISCLAIMER,
  STAGED_COMMENT_READERS_JSON_SCHEMA,
} from "../src/index.js";
import type {
  DialogueThreadPlan,
  EvidenceReference,
  GenerationPromptInput,
  InformationGap,
  ModelGenerationRequest,
  ModelProvider,
  OrchestrationPlan,
  ProjectBlueprintModuleKey,
  PromptBundle,
  TopicOpportunity,
} from "../src/index.js";

const project = {
  id: "p1",
  name: "测试项目",
  domain: "健康信息",
  productPoints: [],
  organizationPoints: [],
  cities: ["上海"],
  doctors: [],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.task.city = "上海";
  value.content.commentThreadMax = 3;
  return value;
}

const knowledge = [
  indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

/** 双号蓝图:IP(知肤研究所)+ 助理(知肤研究所助理)都是 accountable,会进入全量 commentCast。 */
function isolationBlueprint() {
  return normalizeProjectCreativeBlueprint({
    projectId: "p1",
    sourceFingerprint: "comment-role-isolation-test",
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
          prohibitedUnsupportedHistories: ["购买过本项目服务"],
          source: { status: "hypothesis", evidenceIds: [] },
        }],
      },
      role_model: {
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
          allowedEvidenceStatuses: ["user_supplied"],
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

/** 三个 required gap:价格/地址(staff 路由)+ 适用条件(publisher 路由),保证两角色都有线程。
 *  preferredChannels 钉到 Cref:只有规划进 Cref 渠道的缺口卡才会成为线程主缺口。 */
const isolationGaps: InformationGap[] = [
  {
    id: "price_gap", label: "价格", question: "做这个多少钱？", category: "decision",
    audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
    evidenceIds: ["evidence_d1"], required: true, preferredChannels: ["Cref"],
  },
  {
    id: "address_gap", label: "门店地址", question: "你们店在哪？", category: "decision",
    audienceStages: ["comparing"], importance: 0.85, decisionLeverage: 0.85, proofability: 0.8,
    evidenceIds: [], required: true, preferredChannels: ["Cref"],
  },
  {
    id: "fit_gap", label: "适用条件", question: "哪些条件会改变适用性？", category: "decision",
    audienceStages: ["comparing"], importance: 0.8, decisionLeverage: 0.85, proofability: 0.8,
    evidenceIds: [], required: true, preferredChannels: ["Cref"],
  },
];

function isolationOpportunity(): TopicOpportunity {
  return {
    id: "topic-isolation",
    topic: "方案选择",
    angle: "先核验再比较",
    gapIds: ["price_gap", "address_gap", "fit_gap"],
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

const evidenceReferences: EvidenceReference[] = [{
  id: "evidence_d1",
  documentId: "d1",
  path: "facts.md",
  section: "价格口径",
  quote: "单次体验 680 起，以当期确认为准",
  kind: "fact",
  evidenceStatus: "user_supplied",
  scope: [],
  caveats: ["以当期确认为准"],
}];

function isolationPlan(): OrchestrationPlan {
  return planTopicOrchestrations({
    opportunity: isolationOpportunity(),
    gaps: isolationGaps,
    config: config(),
    projectBlueprint: isolationBlueprint(),
    seeds: [11, 22, 33],
  })[0]!;
}

function promptInput(plan: OrchestrationPlan): GenerationPromptInput {
  return {
    config: config(),
    formulaVersion: DEFAULT_FORMULA_VERSION,
    knowledge: selectKnowledgeContext({
      documents: knowledge,
      query: "资料",
      budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    }),
    ledger: buildKnowledgeLedger([]),
    candidateIndex: 0,
    seed: 1,
    variation: { opening: "问题", pacing: "短句", structure: "问答", phrasing: "克制" },
    orchestrationPlan: plan,
    projectBlueprint: isolationBlueprint(),
    evidenceReferences,
  };
}

/** 带编译参数的提示词输入:滑杆值真正参与生成的前提是 impactReport 到位。 */
function promptInputWithParameters(
  plan: OrchestrationPlan,
  selection: Parameters<typeof compileGenerationParameters>[2],
): GenerationPromptInput {
  const compiled = compileGenerationParameters(config(), DEFAULT_FORMULA_VERSION, selection);
  return { ...promptInput(plan), config: compiled.config, impactReport: compiled.impactReport };
}

const core = {
  H: { hashtags: ["方案选择"] },
  N: { imageBrief: "", title: "先核实信息", body: "正文。" },
};

function promptFullText(bundle: PromptBundle): string {
  return bundle.messages.map((message) => {
    const content = message.content;
    return Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : content;
  }).join("\n");
}

function requestText(request: ModelGenerationRequest): string {
  return request.messages.map((message) => {
    const content = message.content;
    return Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : content;
  }).join("\n");
}

/** 按侧+按角色隔离后,提示词不再有 task_data;线程 id 从提示词全文的规格/清单/根评论 JSON 中提取。 */
function stagedThreadIds(request: ModelGenerationRequest): string[] {
  return [...new Set([...requestText(request).matchAll(/"id"\s*:\s*"([^"]*_thread_\d+)"/gu)].map((match) => match[1]!))];
}

describe("公开文案 Prompt 防泄漏合同覆盖", () => {
  it("所有传统生成与改稿入口都携带前台语言合同", () => {
    const plan = isolationPlan();
    const input = promptInput(plan);
    const planned = plan.dialogueThreads[0]!;
    const thread = { planned, question: "这个要怎么判断？" };
    const roots = {
      disclaimer: STAGED_COMMENT_DISCLAIMER,
      threads: plan.dialogueThreads.map((item) => ({
        id: item.id,
        question: "这个要怎么判断？",
        answer: "先把条件问清楚。",
        followUps: [],
      })),
    };
    const readerPrompt = buildStagedCommentReadersPrompt(input, core);
    const draft = parseGenerationDraft(JSON.stringify({
      content: {
        ...core,
        Cref: {
          disclaimer: STAGED_COMMENT_DISCLAIMER,
          threads: [{
            id: planned.id,
            question: "这个要怎么判断？",
            answer: "先把条件问清楚。",
            followUps: [],
            postingIdentity: "publisher",
            sourceClusterIds: [],
            evidenceIds: [],
            personaRole: "information_collector",
            speakerType: "simulated_reader",
            claimStatus: "bounded",
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
    const repair = buildRepairPrompt({
      current: draft,
      issues: [{
        code: "comment_context_meta_leak",
        severity: "error",
        channel: "Cref",
        message: "评论暴露图文上下文",
        repairable: true,
      }],
      channels: ["Cref"],
      config: input.config,
      knowledge: input.knowledge,
      seed: 1,
      attempt: 1,
      orchestrationPlan: plan,
      evidenceReferences: input.evidenceReferences,
    });
    const builders: Array<[string, PromptBundle]> = [
      ["兼容完整生成", buildGenerationPrompt(input)],
      ["正文生成", buildStagedCorePrompt(input)],
      ["正文身份修复", buildStagedCoreIdentityRepairPrompt(input, core, [{
        code: "publishing_topology_voice_mismatch",
        severity: "error",
        channel: "N.body",
        message: "发布身份不匹配",
        repairable: true,
      }])],
      ["读者生成", readerPrompt],
      ["读者编辑", buildStagedCommentEditorPrompt(input, core, roots)],
      ["读者空响应重试", buildStagedCommentReadersRegenerationPrompt(readerPrompt)],
      ["读者结构校正", buildStagedCommentReadersCorrectionPrompt(
        '{"threads":[]}',
        [{ id: planned.id, threadKind: planned.threadKind ?? "org_answer" }],
        "线程缺失",
      )],
      ["真实作者答复", buildStagedHostAnswersPrompt(input, core, [thread])],
      ["机构答复", buildStagedOrgAnswersPrompt(input, core, "staff", [thread])],
      ["评论生长", buildStagedCommentGrowthPrompt(input, core, roots)],
      ["机构追问补答", buildStagedOrgFollowUpAnswersPrompt(input, core, "staff", [{
        planned,
        rootQuestion: "这个要怎么判断？",
        rootAnswer: "先把条件问清楚。",
        followUpId: `${planned.id}:fu:0`,
        question: "那我先问哪一点？",
      }])],
      ["通用修复与按意见修改", repair],
    ];

    for (const [name, prompt] of builders) {
      const system = prompt.messages.find((message) => message.role === "system");
      expect(typeof system?.content, `${name} 缺少 system prompt`).toBe("string");
      expect(String(system?.content), `${name} 缺少公开文案合同`).toContain("用户可见文案规则");
      expect(String(system?.content), `${name} 未禁止模型自曝`).toContain("模型身份");
      expect(String(system?.content), `${name} 未禁止泛化来源腔`).toContain("根据资料");
    }
  });
});

describe("评论参数分侧注入(滑杆真正参与生成)", () => {
  // 归属表的单元级断言:reader 侧拿到 reader+both,answer 侧拿到 answer+both,
  // 两侧互不串。用高档位保证 explicitBehavior 产出可断言的确定文本。
  const highDensity = {
    overrides: {
      comment_constraint_density: 85,
      comment_gap_multiplexing: 85,
      comment_conditionality: 85,
      comment_reply_increment: 85,
    },
  } as const;

  it("commentStageInstructions 按 commentStage 分侧,both 两侧都给,另一侧的不给", () => {
    const compiled = compileGenerationParameters(config(), DEFAULT_FORMULA_VERSION, highDensity);
    const reader = commentStageInstructions(compiled.impactReport, "reader").join("\n");
    const answer = commentStageInstructions(compiled.impactReport, "answer").join("\n");
    // reader 侧:提问侧参数到位,答复侧参数缺席。
    expect(reader).toContain("每个问题优先带入一至两个已披露且会改变答案的现实约束");
    expect(reader).toContain("Gap=1×PrimaryGap");
    expect(reader).not.toContain("单条回复只承担一个主要增量");
    expect(reader).not.toContain("先问澄清条件");
    // answer 侧:答复侧参数到位,提问侧参数缺席。
    expect(answer).toContain("单条回复只承担一个主要增量");
    expect(answer).toContain("先问澄清条件");
    expect(answer).not.toContain("每个问题优先带入一至两个已披露且会改变答案的现实约束");
    // both:假闭合硬约束两侧都必须在(方法论 §1726 独立硬约束,任何档位不降低)。
    expect(reader).toContain("假闭合硬约束：发现感≠证据");
    expect(answer).toContain("假闭合硬约束：发现感≠证据");
  });

  it("2A-R 读者侧提示词带上读者侧参数指令,不带答复侧指令", () => {
    const plan = isolationPlan();
    const text = promptFullText(buildStagedCommentReadersPrompt(promptInputWithParameters(plan, highDensity), core));
    expect(text).toContain("参数行为指令");
    expect(text).toContain("每个问题优先带入一至两个已披露且会改变答案的现实约束");
    expect(text).not.toContain("单条回复只承担一个主要增量");
  });

  it("2A-O 答复侧提示词带上答复侧参数指令,不带提问侧指令", () => {
    const plan = isolationPlan();
    const staffThreads = plan.dialogueThreads.filter((thread) => thread.postingIdentity === "staff");
    const text = promptFullText(buildStagedOrgAnswersPrompt(
      promptInputWithParameters(plan, highDensity), core, "staff",
      staffThreads.map((planned) => ({ planned, question: "这个多少钱？" })),
    ));
    expect(text).toContain("答复侧写作行为参数");
    expect(text).toContain("单条回复只承担一个主要增量");
    expect(text).not.toContain("每个问题优先带入一至两个已披露且会改变答案的现实约束");
  });

  it("只注入 trace 级指令:preset/style 散文不下放,不把另一侧角色概念漏进单一身份调用", () => {
    // search_decision 预设散文含“避免单个楼主回复包办全部信息”——它是整篇作文
    // 的编排口径,天然跨身份;漏进 staff 调用就是旧串台根因。
    const plan = isolationPlan();
    const input = promptInputWithParameters(plan, { presetId: "search_decision" });
    expect(input.impactReport!.behaviorInstructions.join("\n")).toContain("楼主");
    const staffThreads = plan.dialogueThreads.filter((thread) => thread.postingIdentity === "staff");
    const staffText = promptFullText(buildStagedOrgAnswersPrompt(
      input, core, "staff", staffThreads.map((planned) => ({ planned, question: "这个多少钱？" })),
    ));
    expect(staffText).not.toContain("避免单个楼主回复包办全部信息");
    expect(staffText).not.toContain("楼主");
    // 读者侧同理:机构概念整体不出现。
    const readerText = promptFullText(buildStagedCommentReadersPrompt(input, core));
    expect(readerText).not.toContain("避免单个楼主回复包办全部信息");
    expect(readerText).not.toContain("助理");
  });

  it("无 impactReport 时不注入,提示词形状不变(向后兼容)", () => {
    const plan = isolationPlan();
    const text = promptFullText(buildStagedCommentReadersPrompt(promptInput(plan), core));
    expect(text).not.toContain("参数行为指令");
  });

  it("展示型诊断参数只排序不注入:trace 的 behaviorInstructions 恒空,且不归任何评论侧", () => {
    // 直接钉机制本身:诊断参数既没有可注入文本,也没有 commentStage 归属。
    // 只断言提示词里没有 "comment_diagnostic_" 是空转的——那串字面量在全部
    // 参数指令语料里压根不存在,过滤逻辑整个删掉测试照样绿。
    const diagnosticIds = GENERATION_PARAMETER_REGISTRY
      .filter((definition) => definition.id.startsWith("comment_diagnostic_")
        || definition.id.startsWith("body_diagnostic_"))
      .map((definition) => definition.id);
    expect(diagnosticIds.length).toBeGreaterThan(0);
    for (const id of diagnosticIds) {
      expect(GENERATION_PARAMETER_REGISTRY.find((item) => item.id === id)!.commentStage,
        `${id} 不应归属任何评论侧`).toBeUndefined();
    }
    const compiled = compileGenerationParameters(config(), DEFAULT_FORMULA_VERSION, {
      overrides: Object.fromEntries(diagnosticIds.map((id) => [id, 100])) as never,
    });
    // 诊断参数即使拉满也没有可注入文本:这是"只排序不生成"的机制保证。
    for (const id of diagnosticIds) {
      const trace = compiled.impactReport.parameterTraces.find((item) => item.parameterId === id);
      expect(trace?.behaviorInstructions ?? [], `${id} 不应产出可注入指令`).toEqual([]);
    }
  });

  it("用户自定义禁词(task.forbidden)必须到达两侧评论阶段——校验层按全文拦 error", () => {
    // forbidden_phrase 校验 fullText(含 Cref)且是 error 级;禁词只注入 stage1/3
    // 时,评论侧模型看不见却要吃 error,白烧修复轮次。
    const plan = isolationPlan();
    const withForbidden = () => {
      const value = config();
      value.task.forbidden = ["无痛", "包好"];
      return value;
    };
    const input = { ...promptInput(plan), config: withForbidden() };
    const readerText = promptFullText(buildStagedCommentReadersPrompt(input, core));
    expect(readerText).toContain("无痛");
    expect(readerText).toContain("包好");
    const staffThreads = plan.dialogueThreads.filter((thread) => thread.postingIdentity === "staff");
    const staffText = promptFullText(buildStagedOrgAnswersPrompt(
      input, core, "staff", staffThreads.map((planned) => ({ planned, question: "这个多少钱？" })),
    ));
    expect(staffText).toContain("无痛");
    expect(staffText).toContain("包好");
  });

  it("读者生成与评论编辑都禁止把正文上下文写成元叙事", () => {
    const plan = isolationPlan();
    const input = promptInput(plan);
    const readerText = promptFullText(buildStagedCommentReadersPrompt(input, core));
    expect(readerText).toContain("正文说/文中提到");
    expect(readerText).toContain("元叙事");
    const editorText = promptFullText(buildStagedCommentEditorPrompt(input, core, {
      threads: plan.dialogueThreads.map((thread) => ({ id: thread.id, question: "正文说了什么？", answer: "" })),
    }));
    expect(editorText).toContain("必须删除或自然改写");
    expect(editorText).toContain("正文说/文中提到");
  });

  it("参数指令注入评论阶段时脱敏内部字段名:计划语言不下放给模型照抄", () => {
    // state_information_strength / question_compression 等指令原文含
    // personaScenePlan / surfaceRoleCard;它们正是 comment_plan_language_surface_
    // leak 与 internal_audit_artifact_visible 要拦的计划语言,不能进隔离调用。
    const compiled = compileGenerationParameters(config(), DEFAULT_FORMULA_VERSION, {
      overrides: { state_information_strength: 85, question_compression: 85, experience_information_strength: 85 },
    });
    // 前提:未脱敏的原始 trace 文本确实含内部字段名(否则本测试空转)。
    const rawTraceText = compiled.impactReport.parameterTraces
      .filter((trace) => ["state_information_strength", "question_compression", "experience_information_strength"].includes(trace.parameterId))
      .flatMap((trace) => trace.behaviorInstructions).join("\n");
    expect(rawTraceText).toMatch(/personaScenePlan|surfaceRoleCard/u);
    // 脱敏后:进评论阶段的指令不再含字段名,但语义词仍在。
    const readerInstructions = commentStageInstructions(compiled.impactReport, "reader").join("\n");
    expect(readerInstructions).not.toContain("personaScenePlan");
    expect(readerInstructions).not.toContain("surfaceRoleCard");
    expect(readerInstructions).toContain("人物");
    const plan = isolationPlan();
    const text = promptFullText(buildStagedCommentReadersPrompt(
      { ...promptInput(plan), impactReport: compiled.impactReport }, core));
    expect(text).not.toContain("personaScenePlan");
    expect(text).not.toContain("surfaceRoleCard");
  });
});

describe("buildOrgThreadScope (逐 gap 口径)", () => {
  const thread = {
    primaryGapId: "price_gap",
    replyPlan: { directAnswer: "单次 680 起", condition: "以当期为准", boundary: "不承诺效果", unknown: "个人差异未知", nextQuestion: "核实预算" },
  };
  const gapCard = { gapId: "price_gap", label: "价格", evidenceIds: ["evidence_d1"] };

  /**
   * 内部占位符不得随口径下发给模型。
   *
   * planning 的 unresolvedConstraintDimensions 用 `待核实维度：xxx` /
   * `已披露地点范围：xxx` 做**内部维度标记**(planning.ts 注释明说这不是对人的断
   * 言)。engine 的兜底渲染器在三处剥掉这个前缀,但分阶段提示词路径没有 —— 于是
   * 前缀原样进 replyPlan.condition,模型照抄进可见文案。实测产出:
   * 「…不向业主加收费用。；待核实维度：方案适配条件。」
   */
  it("口径里剥掉内部维度前缀,不把后台标记喂给模型", () => {
    const leaky = {
      primaryGapId: "price_gap",
      replyPlan: {
        directAnswer: "单次 680 起",
        condition: "待核实维度：成本边界",
        boundary: "已披露地点范围：上海",
        unknown: "待核实维度：来源可信度",
        nextQuestion: "核实预算",
      },
    };
    const scope = buildOrgThreadScope(leaky, gapCard, evidenceReferences);
    const text = JSON.stringify(scope.口径);
    expect(text).not.toContain("待核实维度");
    expect(text).not.toContain("已披露地点范围");
    // 剥前缀不等于丢信息:维度名本身仍要留给模型判断是否需要澄清。
    expect(text).toContain("成本边界");
    expect(text).toContain("上海");
  });

  /**
   * 上一条只覆盖了分阶段答复路径(buildOrgThreadScope)。orchestrationPlan 投影
   * 里的 contentAnchor 也原样携带 replyPlan.condition —— 而这个投影进的是**核心
   * 图文阶段**的写作上下文。生产实测(job 4ee471e2)三个候选的 contentAnchor 全
   * 部带着「待核实维度：时间与工作可见性」。两条路径都要剥。
   */
  it("orchestrationPlan 投影的 contentAnchor 也剥掉内部维度前缀", () => {
    const plan = isolationPlan();
    const leaked = plan.dialogueThreads.filter((thread) =>
      /待核实维度[：:]|已披露地点范围[：:]/u.test(JSON.stringify(thread.replyPlan)));
    // 前置断言:规划层确实会产出带前缀的口径,否则本测试是空跑。
    expect(leaked.length).toBeGreaterThan(0);
    const text = promptFullText(buildStagedCorePrompt(promptInput(plan)));
    const candidateTask = text.match(/<task_data scope="candidate">\n([\s\S]*?)\n<\/task_data>/u)?.[1] ?? "";
    expect(candidateTask).not.toContain("待核实维度");
    expect(candidateTask).not.toContain("已披露地点范围");
    expect(candidateTask).toContain("contentAnchor");
  });

  it("有证据的 gap 输出钉到该 gap 的 quote(id/section/quote/caveats),不带硬约束", () => {
    const scope = buildOrgThreadScope(thread, gapCard, evidenceReferences);
    expect(scope.gap标签).toBe("价格");
    expect(scope.口径).toEqual({ 直接回答: "单次 680 起", 适用条件: "以当期为准", 边界: "不承诺效果", 仍未知: "个人差异未知", 下一项核验: "核实预算" });
    expect(scope.证据原文).toEqual([{ id: "evidence_d1", section: "价格口径", quote: "单次体验 680 起，以当期确认为准", caveats: ["以当期确认为准"] }]);
    expect(scope.硬约束).toBeUndefined();
  });

  it("把历史 section_ 别名唯一归一到当前 evidence_section_ 证据", () => {
    const canonical = { ...evidenceReferences[0]!, id: "evidence_section_d1" };
    const scope = buildOrgThreadScope(
      thread,
      { ...gapCard, evidenceIds: ["section_d1"] },
      [canonical],
    );
    expect(scope.证据原文).toEqual([expect.objectContaining({ id: "evidence_section_d1" })]);
    expect(scope.硬约束).toBeUndefined();
  });

  it("机构主写作上下文不暴露消费者 host/event 亲历合同", () => {
    const plan = isolationPlan();
    const input = promptInput(plan);
    input.config.task.publishingTopology = "institution_owned";
    const text = promptFullText(buildStagedCorePrompt(input));
    const candidateTask = text.match(/<task_data scope="candidate">\n([\s\S]*?)\n<\/task_data>/u)?.[1] ?? "";
    const projected = JSON.parse(candidateTask) as { orchestrationPlan: { personaScenePlan: Record<string, unknown> } };
    expect(projected.orchestrationPlan.personaScenePlan).not.toHaveProperty("host");
    expect(projected.orchestrationPlan.personaScenePlan).not.toHaveProperty("event");
    expect(projected.orchestrationPlan.personaScenePlan).not.toHaveProperty("crossChannelRules");
    expect(projected.orchestrationPlan.personaScenePlan).toHaveProperty("commentCast");
  });

  it("无证据的 gap 输出显式硬约束", () => {
    const scope = buildOrgThreadScope({ ...thread, primaryGapId: "fit_gap" }, { gapId: "fit_gap", label: "适用条件", evidenceIds: [] }, evidenceReferences);
    expect(scope.证据原文).toHaveLength(0);
    expect(scope.硬约束).toContain("你手里没有适用条件的已核验证据，只能明确说当前无法确认");
    expect(scope.硬约束).toContain("不得承诺替对方确认、稍后回复、私信、预约、对接、安排或发送资料");
  });

  it("缺口卡缺失时标签回落 primaryGapId,无证据即硬约束", () => {
    const scope = buildOrgThreadScope(thread, undefined, evidenceReferences);
    expect(scope.gap标签).toBe("price_gap");
    expect(scope.硬约束).toContain("只能明确说当前无法确认");
    expect(scope.硬约束).toContain("不得承诺替对方确认");
  });

  it("只钉 gap 卡列出的证据,不夹带其他证据", () => {
    const scope = buildOrgThreadScope(thread, gapCard, [...evidenceReferences, { ...evidenceReferences[0]!, id: "evidence_other" }]);
    expect(scope.证据原文.map((quote) => quote.id)).toEqual(["evidence_d1"]);
  });
});

describe("受限机构名称的跨阶段写作投影", () => {
  it("完整生成、核心正文、读者评论和机构答复都不接收项目名或共享别名", () => {
    const plan = isolationPlan();
    plan.gapPlanningCards = (plan.gapPlanningCards ?? []).map((card) => ({
      ...card,
      publicationRestrictions: ["机构全称不得对外公开"],
    }));
    const input = promptInput(plan);
    input.config.project.name = "星零感眼袋（7.28）";
    input.config.project.productPoints = ["星零感微孔去眼袋"];
    input.config.task.goal = "说明公开信息；机构全称不得对外公开";
    input.evidenceReferences = [{
      id: "evidence_alias", documentId: "d-alias", path: "org.md", section: "公开信息",
      quote: "星零感微孔去眼袋位于锦华万达附近；机构全称不得对外公开。",
      kind: "fact", evidenceStatus: "user_supplied", scope: [], caveats: [],
      publicationRestrictions: ["机构全称不得对外公开"],
    }];
    const planned = plan.dialogueThreads[0]!;
    const bundles = [
      buildGenerationPrompt(input),
      buildStagedCorePrompt(input),
      buildStagedCommentReadersPrompt(input, core),
      buildStagedOrgAnswersPrompt(input, core, "publisher", [{ planned, question: "机构信息怎么核实？" }]),
    ];
    for (const bundle of bundles) {
      const text = promptFullText(bundle);
      expect(text).not.toContain("星零感眼袋（7.28）");
      expect(text).not.toContain("星零感微孔去眼袋");
      expect(text).not.toContain("星零感");
      expect(text).not.toContain("机构全称不得对外公开");
      expect(text).toContain("本机构");
    }
  });
});

describe("按侧+按角色隔离的评论提示词", () => {
  it("2A-R 读者侧:不含助理/机构/答复规则/证据原文/编排元信息", () => {
    const prompt = buildStagedCommentReadersPrompt(promptInput(isolationPlan()), core);
    const text = promptFullText(prompt);
    for (const banned of ["助理", "机构", "postingIdentity", "replyPlan", "contentAnchor", "usableEvidenceReferences", "orchestrationPlan", "楼主", "publisher", "staff", "host", "evidence_", "单次体验 680 起"]) {
      expect(text, `读者侧不应出现: ${banned}`).not.toContain(banned);
    }
    expect(text).toContain("已由规划分配");
    expect(text).toContain("模拟读者");
    // 禁讲清单来自 claimPolicy 的受控类型与术语(不含答复身份)。
    expect(text).toContain("价格");
    expect(text).toContain("费用");
    expect(text).toContain("购买过本项目服务");
    // 读者侧角色池剔除了机构身份角色(IP/助理),只留读者人物。
    expect(text).toContain("谨慎比较者");
    expect(text).not.toContain("知肤研究所");
    expect(prompt.responseSchema).toBe(STAGED_COMMENT_READERS_JSON_SCHEMA);
    const itemProperties = (STAGED_COMMENT_READERS_JSON_SCHEMA.properties as Record<string, any>).threads.items.properties;
    expect(itemProperties.roleIndex).toBeUndefined();
  });

  it("2A-O staff:只见助理身份卡与本角色线程口径,不见 IP/host 定义与其他线程", () => {
    const plan = isolationPlan();
    const staffThreads = plan.dialogueThreads.filter((thread) => thread.postingIdentity === "staff");
    const otherIdentityThreads = plan.dialogueThreads.filter((thread) => thread.postingIdentity !== "staff");
    expect(staffThreads.length).toBeGreaterThan(0);
    expect(otherIdentityThreads.length).toBeGreaterThan(0);
    const prompt = buildStagedOrgAnswersPrompt(promptInput(plan), core, "staff", staffThreads.map((planned) => ({ planned, question: "这个多少钱？" })));
    const text = promptFullText(prompt);
    expect(text).toContain("知肤研究所助理");
    expect(text).toContain("你只知道下方列出的口径");
    expect(text).toContain("没有证据的细节只能明确“当前无法确认”");
    expect(text).not.toContain("需要转人工时只说“我帮你跟专人确认”");
    expect(text).toContain("以当期确认为准");
    // 逐 gap 口径:有证据的 gap 钉 quote。护栏只认 price/location/schedule 三类
    // claimType,本蓝图仅有 price 规则,所以只有价格 gap 路由到 staff——地址/适用
    // 条件 gap 不在此调用里,不能断言它们的硬约束文本。
    expect(text).toContain("单次体验 680 起，以当期确认为准");
    // 无证据的 gap 一律走硬约束(此处按实际路由到 staff 的线程逐条核对)。
    for (const planned of staffThreads) {
      const card = plan.gapPlanningCards.find((item) => item.gapId === planned.primaryGapId);
      if ((card?.evidenceIds.length ?? 0) === 0) {
        expect(text).toContain(`你手里没有${card?.label ?? planned.primaryGapId}的已核验证据，只能明确说当前无法确认`);
      }
    }
    // 另一个角色(IP/楼主)的任何定义不出现。
    for (const banned of ["楼主", "发布者", "publisher", "host", "voiceTraits"]) {
      expect(text, `staff 调用不应出现: ${banned}`).not.toContain(banned);
    }
    for (const thread of otherIdentityThreads) expect(text).not.toContain(thread.id);
  });

  it("2A-O publisher:明确项目方身份且不继承 host 叙事人物,不见助理定义", () => {
    const plan = isolationPlan();
    const base = plan.dialogueThreads.find((thread) => thread.primaryGapId === "fit_gap")
      ?? plan.dialogueThreads.find((thread) => thread.postingIdentity !== "staff")!;
    // 该测试验证 publisher 单角色提示词隔离，不要求规划器为了凑身份产生 publisher。
    const publisherThread: DialogueThreadPlan = {
      ...base,
      postingIdentity: "publisher",
      routingReason: "测试夹具：规划期冻结 publisher",
      surfaceRoleCard: base.surfaceRoleCard
        ? { ...base.surfaceRoleCard, replyDisplayRole: "项目发布账号" }
        : base.surfaceRoleCard,
    };
    const otherThreads = plan.dialogueThreads.filter((thread) => thread.id !== publisherThread.id);
    const prompt = buildStagedOrgAnswersPrompt(promptInput(plan), core, "publisher", [{ planned: publisherThread, question: "哪些条件影响适用性？" }]);
    const text = promptFullText(prompt);
    // publisher 是明确署名的机构项目账号，不是正文叙事人物；host 的生活经历、
    // 语气卡与第一人称位置都不得进入这个机构答复阶段。
    expect(text).toContain("项目发布账号");
    expect(text).toContain("不是正文叙事人物");
    expect(text).toContain("不冒充独立消费者");
    expect(text).not.toContain("叙述声音");
    expect(text).not.toContain("voiceTraits");
    expect(text).toContain("你只知道下方列出的口径");
    // 无证据的适用条件 gap 走硬约束。
    expect(text).toContain("你手里没有适用条件的已核验证据，只能明确说当前无法确认");
    expect(text).toContain("不得承诺替对方确认、稍后回复、私信、预约、对接、安排或发送资料");
    for (const banned of ["助理", "staff"]) {
      expect(text, `publisher 调用不应出现: ${banned}`).not.toContain(banned);
    }
    for (const thread of otherThreads) expect(text).not.toContain(thread.id);
  });

  it("2B 生长:精简读者上下文,不含双号契约与机构概念", () => {
    const plan = isolationPlan();
    const roots = {
      disclaimer: STAGED_COMMENT_DISCLAIMER,
      threads: plan.dialogueThreads.map((thread, index) => ({ id: thread.id, question: `根评论${index + 1}`, answer: "根回复", followUps: [] })),
    };
    const prompt = buildStagedCommentGrowthPrompt(promptInput(plan), core, roots);
    const text = promptFullText(prompt);
    for (const banned of ["助理", "机构", "postingIdentity", "双号"]) {
      expect(text, `2B 读者侧不应出现: ${banned}`).not.toContain(banned);
    }
    // 需要项目方口径的追问留空、由能回答的一方后续补的规则保留。
    expect(text).toContain("空字符串");
    expect(text).toContain("followUpIntent");
  });

  it("2B-O 机构补答:同 2A-O 隔离规则,输入追问与所在线程上下文", () => {
    const plan = isolationPlan();
    const staffThread = plan.dialogueThreads.find((thread) => thread.postingIdentity === "staff")!;
    const prompt = buildStagedOrgFollowUpAnswersPrompt(promptInput(plan), core, "staff", [{
      planned: staffThread,
      rootQuestion: "这个多少钱？",
      rootAnswer: "单次 680 起，以当期为准。",
      followUpId: `${staffThread.id}:fu:0`,
      question: "能便宜点吗？",
    }]);
    const text = promptFullText(prompt);
    expect(text).toContain("待承接追问");
    expect(text).toContain("能便宜点吗？");
    expect(text).toContain("你手里的口径");
    expect(text).toContain("单次体验 680 起，以当期确认为准");
    expect(text).not.toContain("楼主");
    expect(text).not.toContain("publisher");
  });
});

describe("阶段化解析器(按侧拆分)", () => {
  it("parseStagedCommentReaders 只读可见文案,忽略 roleIndex 等漂移字段", () => {
    const parsed = parseStagedCommentReaders(JSON.stringify({
      disclaimer: "模型自编免责声明",
      threads: [{
        id: "t1",
        roleIndex: 3,
        postingIdentity: "staff",
        question: "怎么判断？",
        answer: "",
        kind: "question",
        function: "verification",
        followUps: [],
      }],
    }));
    expect(parsed.threads[0]).toMatchObject({ id: "t1", question: "怎么判断？", answer: "", function: "verification" });
    expect("roleIndex" in parsed.threads[0]!).toBe(false);
    expect("disclaimer" in parsed).toBe(false);
  });

  it("parseStagedOrgAnswers 读答复列表与可选首评", () => {
    const parsed = parseStagedOrgAnswers(JSON.stringify({
      answers: [{ id: "t1", answer: "按口径答。", answerKind: "answer", boundary: "边界" }, { id: "t2", answer: "转人工。" }],
      ownedFirstComment: "置顶：常见问题整理。",
    }));
    expect(parsed.answers).toHaveLength(2);
    expect(parsed.answers[0]).toMatchObject({ id: "t1", answer: "按口径答。", answerKind: "answer", boundary: "边界" });
    expect(parsed.answers[1]!.answerKind).toBeUndefined();
    expect(parsed.ownedFirstComment).toBe("置顶：常见问题整理。");
  });
});

describe("按侧+按角色隔离的引擎合并", () => {
  function engineConfig() {
    const value = config();
    value.content.bodyMinChars = 20;
    value.generation.maxRepairAttempts = 0;
    return value;
  }
  const planningContext = { informationGaps: isolationGaps, projectBlueprint: isolationBlueprint() };
  const coreResponse = () => JSON.stringify({
    content: {
      H: { hashtags: ["方案选择", "信息", "核验"] },
      N: { imageBrief: "信息清单封面", title: "先核实信息", body: "先核实适用边界，再决定下一步。细节仍在整理，确认后再补充。" },
      Cref: { disclaimer: "x", threads: [] },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  });

  function frozenReaderThreads(request: ModelGenerationRequest, edit = false) {
    const text = requestText(request);
    const specs = [...text.matchAll(/"id"\s*:\s*"([^"]+)"\s*,\s*"threadKind"\s*:\s*"([^"]+)"\s*,\s*"gap标签"\s*:\s*"([^"]+)"/gu)];
    return specs.map((match) => ({
      id: match[1]!,
      question: edit
        ? `我时间有限，${match[3]}最先要确认哪一项？`
        : `关于${match[3]}，具体怎么看？`,
      answer: match[2] === "reader_exchange" ? (edit ? "我也卡在这一步，先把条件问清楚。" : "我也在看这个。") : "",
    }));
  }

  function completeNetworkEditorResponse(request: ModelGenerationRequest, drift = false) {
    const current = [...request.messages].reverse().flatMap((message) =>
      typeof message.content === "string" ? [message.content] : [])
      .map((text) => {
        try { return JSON.parse(text) as { disclaimer?: string; threads?: Array<{ id: string; question: string; answer: string; followUps?: unknown[] }> }; }
        catch { return undefined; }
      })
      .find((value) => value?.disclaimer === STAGED_COMMENT_DISCLAIMER && Array.isArray(value.threads));
    if (!current?.threads) throw new Error("终编测试夹具没有读到完整评论网络。");
    const unknownVariants = [
      "这一项当前无法确认，先不下结论。",
      "这一项目前无法核实，先保留未知。",
      "目前还不能确定，先不下结论。",
    ];
    const seenQuestions = new Set<string>();
    return {
      disclaimer: current.disclaimer,
      threads: current.threads.map((thread, index) => {
        const duplicateQuestion = seenQuestions.has(thread.question);
        seenQuestions.add(thread.question);
        return {
          ...thread,
          question: drift
            ? "今天天气怎么样？"
            : duplicateQuestion
              ? `我也在看这项，${thread.question}`
              : thread.question,
          answer: thread.answer === "这一项当前无法确认，先不下结论。"
            ? unknownVariants[index % unknownVariants.length]
            : (thread.answer ?? ""),
          followUps: thread.followUps ?? [],
        };
      }),
      assessment: { status: "pass", reasons: [], summary: "已消除重复答复并保持冻结职责。" },
    };
  }

  it("完整评论终编仅在重复网络命中时调用，并持久化通过结论", async () => {
    let editorCalls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return { text: JSON.stringify({ threads: frozenReaderThreads(request) }), raw: {} };
        }
        if (purpose === "edit_comment_readers") {
          editorCalls += 1;
          return { text: JSON.stringify(completeNetworkEditorResponse(request)), raw: {} };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "需要结合对应条件确认。" })) }), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "comment-editor-pass", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });

    expect(result.packages).toHaveLength(3);
    expect(editorCalls).toBe(3);
    for (const pkg of result.packages) {
      expect(pkg.commentEditorialAssessment).toEqual({ status: "pass", reasons: [], summary: "已消除重复答复并保持冻结职责。" });
      const answers = pkg.content.Cref.threads.map((thread) => thread.answer).filter(Boolean);
      expect(new Set(answers).size).toBe(answers.length);
      expect(pkg.validation.issues.some((issue) => issue.code === "comment_editor_unavailable" || issue.code === "comment_editor_contract_rejected")).toBe(false);
    }
  });

  it("完整评论终编越过冻结 gap 时原子拒收并保留原始网络", async () => {
    let editorCalls = 0;
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return { text: JSON.stringify({ threads: frozenReaderThreads(request) }), raw: {} };
        }
        if (purpose === "edit_comment_readers") {
          editorCalls += 1;
          return { text: JSON.stringify(completeNetworkEditorResponse(request, true)), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "comment-editor-contract", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });

    expect(result.packages).toHaveLength(3);
    expect(editorCalls).toBe(3);
    expect(result.packages.every((pkg) => pkg.commentEditorialAssessment === undefined)).toBe(true);
    expect(result.packages.every((pkg) => pkg.validation.issues.some((issue) =>
      issue.code === "comment_editor_contract_rejected"
      && issue.disposition === "review"
      && issue.origin === "deterministic"))).toBe(true);
    expect(result.packages.flatMap((pkg) => pkg.content.Cref.threads).every((thread) => thread.question !== "今天天气怎么样？")).toBe(true);
  });

  it("模型输出携带漂移字段时,surfaceRoleCard/postingIdentity/线程形态仍以规划层为准", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          // 漂移字段:全部线程冒充同一 roleIndex、自称 staff、自写免责声明;
          // 这些字段在解析与合并层都不应生效。
          return {
            text: JSON.stringify({
              disclaimer: "模型自编免责声明",
              threads: stagedThreadIds(request).map((id, index) => ({
                id,
                roleIndex: 0,
                postingIdentity: "staff",
                question: `第${index + 1}项应该核实什么？`,
                answer: "姐妹我也蹲一个",
                followUps: [],
              })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_answers") {
          const answer = request.metadata?.identity === "staff" ? "这个我让专人跟你确认。" : "这个得看个人条件，我先不乱说。";
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer })) }), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "role-isolation-merge", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });
    expect(result.packages).toHaveLength(3);
    for (const pkg of result.packages) {
      const planned = pkg.dialogueThreads ?? [];
      const threads = pkg.content.Cref.threads;
      // 形状回归:线程数与规划一致,免责声明为确定性常量(模型自编文本不生效)。
      expect(threads.length).toBe(planned.length);
      expect(pkg.content.Cref.disclaimer).toBe(STAGED_COMMENT_DISCLAIMER);
      for (const [index, thread] of threads.entries()) {
        const plan = planned[index]!;
        const kind = plan.threadKind ?? "org_answer";
        expect(thread.threadKind ?? "org_answer").toBe(kind);
        // 身份与人物卡以规划层为准:漂移的 roleIndex/postingIdentity 不生效。
        expect(thread.postingIdentity).toBe(plan.postingIdentity);
        expect(thread.surfaceRoleCard).toEqual(plan.surfaceRoleCard);
        // 答复来源:T3 恒空;T2 来自读者侧;T1 来自对应角色的机构调用。
        if (kind === "organic_reaction") expect(thread.answer).toBe("");
        else if (kind === "reader_exchange") expect(thread.answer).toBe("姐妹我也蹲一个");
        else expect(thread.answer).toBe("这一项当前无法确认，先不下结论。");
      }
    }
  });

  it("个人作者拓扑走独立楼主调用，最终线程不携带项目答复元数据", async () => {
    const calls: ModelGenerationRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return {
            text: JSON.stringify({
              threads: stagedThreadIds(request).map((id, index) => ({
                id,
                question: `第${index + 1}条想确认一下？`,
                answer: "姐妹我也在看",
                followUps: [],
              })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_host_answers") {
          return {
            text: JSON.stringify({
              answers: stagedThreadIds(request).map((id) => ({ id, answer: "我目前还没决定" })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "这个需要按项目口径确认。" })) }), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const value = engineConfig();
    value.task.publishingTopology = "confirmed_individual_author";
    value.task.authorContext = {
      status: "confirmed",
      facts: [{
        id: "af1",
        statement: "我目前还没决定",
        category: "current_state",
        confirmedBy: "user-1",
        confirmedAt: "2026-08-04T12:00:00Z",
      }],
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "host-isolation", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });

    expect(calls.some((call) => call.metadata?.purpose === "generate_host_answers")).toBe(true);
    expect(result.packages).toHaveLength(3);
    expect(result.packages.every((pkg) => pkg.configSnapshot.task.publishingTopology === "confirmed_individual_author")).toBe(true);
    for (const pkg of result.packages) {
      const host = pkg.content.Cref.threads.find((thread) => thread.threadKind === "host_reply");
      expect(host).toBeDefined();
      expect(host).toMatchObject({
        postingIdentity: "author",
        answer: "我目前还没决定",
        evidenceIds: [],
        sourceClusterIds: [],
        authorFactIds: ["af1"],
        followUps: [],
      });
      expect(host?.primaryGapId).toBeUndefined();
      expect(host?.gap).toBeUndefined();
      expect(host?.replyPlan).toBeUndefined();
      expect(host?.discoveryPlan).toBeUndefined();
      expect(host?.nextStep).toBeUndefined();
    }
  });

  it("无事实证据的机构线程零调用并确定性保留未知", async () => {
    const calls: ModelGenerationRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return {
            text: JSON.stringify({
              threads: stagedThreadIds(request).map((id, index) => ({ id, question: `第${index + 1}项应该核实什么？`, answer: "姐妹我也蹲一个", followUps: [] })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_answers") throw new Error("无证据线程不应调用机构模型");
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "role-isolation-no-evidence", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });
    expect(result.packages).toHaveLength(3);
    expect(calls.filter((call) => call.metadata?.purpose === "generate_org_answers")).toHaveLength(0);
    for (const pkg of result.packages) {
      for (const thread of pkg.content.Cref.threads.filter((item) => item.threadKind === "org_answer")) {
        expect(thread.answer).toBe("这一项当前无法确认，先不下结论。");
        expect(thread.answer).not.toMatch(/(?:帮.*确认|稍后|私信|预约|对接|安排|发给)/u);
      }
    }
  });

  it("2B 后空答复的机构追问由 2B-O 补答;未覆盖的追问确定性丢弃并记 warning", async () => {
    const calls: ModelGenerationRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return {
            text: JSON.stringify({
              threads: stagedThreadIds(request).map((id, index) => ({ id, question: `第${index + 1}项应该核实什么？`, answer: "姐妹我也蹲一个", followUps: [] })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按口径回答。" })) }), raw: {} };
        }
        if (purpose === "generate_comment_growth") {
          // 每条线程长出一个 answer 为空的追问(机构承接类)。
          return {
            text: JSON.stringify({
              disclaimer: STAGED_COMMENT_DISCLAIMER,
              threads: stagedThreadIds(request).map((id, index) => ({
                id,
                question: `第${index + 1}项应该核实什么？`,
                answer: "按口径回答。",
                followUps: [{ question: "那这个适合我吗？", answer: "" }],
              })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_followup_answers") {
          // staff 的追问全部补答(追问 id 形如 thread:fu:N);publisher 的追问不覆盖(应确定性丢弃)。
          const followUpIds = [...new Set([...requestText(request).matchAll(/"id"\s*:\s*"([^"]*_thread_\d+:fu:\d+)"/gu)].map((match) => match[1]!))];
          if (request.metadata?.identity === "staff") {
            return { text: JSON.stringify({ answers: followUpIds.map((id) => ({ id, answer: "专人跟你确认。" })) }), raw: {} };
          }
          return { text: JSON.stringify({ answers: [] }), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const value = engineConfig();
    value.content.commentMultiTurnGrowthEnabled = true;
    value.content.followUpDepth = 2;
    // 线程上限放大,给 followUps 留足可见行数预算(否则合并层按预算确定性截空)。
    value.content.commentThreadMin = 2;
    value.content.commentThreadMax = 5;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "role-isolation-2bo", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });
    expect(result.packages).toHaveLength(3);
    const followUpAnswerCalls = calls.filter((call) => call.metadata?.purpose === "generate_org_followup_answers");
    // 该夹具没有可支撑机构事实的来源：追问同样零调用，不能让补答模型
    // 借追问编造“专人确认”等未来服务动作。
    expect(followUpAnswerCalls).toHaveLength(0);
    for (const pkg of result.packages) {
      const planned = pkg.dialogueThreads ?? [];
      for (const [index, thread] of pkg.content.Cref.threads.entries()) {
        const kind = planned[index]?.threadKind ?? "org_answer";
        if (kind === "organic_reaction") {
          expect(thread.followUps).toHaveLength(0);
          continue;
        }
        if (kind === "reader_exchange") continue;
        expect(thread.followUps.every((followUp) =>
          followUp.answer === "这一项当前无法确认，先不下结论。" &&
          !/(?:帮.*确认|稍后|私信|预约|对接|安排|发给)/u.test(followUp.answer))).toBe(true);
      }
    }
  });

  /**
   * 存量不合规 role_model 的可见性接线。线上 8 个项目的最新 role_model 里有 5 个
   * 属于这两种形态(只有 1 个 accountable / replyDisplayRoles 写内部 id),此前
   * 生成结果里完全没有信号,答复展示名静默回落到通用兜底名。
   */
  function plainProvider(): ModelProvider {
    return {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return {
            text: JSON.stringify({
              threads: stagedThreadIds(request).map((id, index) => ({ id, question: `第${index + 1}项应该核实什么？`, answer: "我也在确认这件事。", followUps: [] })),
            }),
            raw: {},
          };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "得看条件，我先不乱说。" })) }), raw: {} };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
  }

  async function issuesFor(blueprint: unknown, jobId: string) {
    const result = await new ContentGenerationAgent({ modelProvider: plainProvider(), now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({
        jobId,
        config: engineConfig(),
        formulaVersion: DEFAULT_FORMULA_VERSION,
        knowledge,
        planningContext: { informationGaps: isolationGaps, projectBlueprint: blueprint as never },
      });
    return result.packages.map((pkg) => pkg.validation.issues.filter((issue) => issue.code === "accountable_identity_incomplete"));
  }

  it("有人工确认事实时才调用机构模型，证据外官网/执照/预约动作仍确定性回退", async () => {
    const calls: ModelGenerationRequest[] = [];
    const confirmation = { confirmedBy: "owner-1", confirmedAt: "2026-08-05T00:00:00.000Z" };
    const groundedGaps: InformationGap[] = isolationGaps.map((gap) => ({
      ...gap,
      answer: gap.id === "price_gap"
        ? "单次体验 680 起，以当期确认为准"
        : gap.id === "address_gap"
          ? "当前只确认位于目标商圈附近，具体位置以当期确认为准"
          : "适用条件需要结合个人情况评估",
      sourceStatus: "user_supplied",
      humanConfirmation: confirmation,
    }));
    const groundedContext = { informationGaps: groundedGaps, projectBlueprint: isolationBlueprint() };
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return { text: JSON.stringify({ threads: frozenReaderThreads(request) }), raw: {} };
        }
        if (purpose === "edit_comment_readers") {
          return {
            text: JSON.stringify({
              threads: frozenReaderThreads(request),
              assessment: { status: "pass", reasons: [], summary: "保持原问题。" },
            }), raw: {},
          };
        }
        if (purpose === "generate_org_answers") {
          return {
            text: JSON.stringify({
              answers: stagedThreadIds(request).map((id) => ({
                id,
                answer: "官网暂时没有，营业执照在大厅公示，我稍后帮你预约。",
              })),
              ownedFirstComment: "资质都能在线查，我可以帮大家预约。",
            }),
            raw: {},
          };
        }
        if (purpose === "generate_ledger") return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        return { text: coreResponse(), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-08-05T00:00:00Z") })
      .generate({ jobId: "org-answer-evidence-boundary", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext: groundedContext });

    expect(calls.filter((call) => call.metadata?.purpose === "generate_org_answers").length).toBeGreaterThan(0);
    const visible = result.packages.flatMap((pkg) => [
      pkg.content.Cref.ownedFirstComment ?? "",
      ...pkg.content.Cref.threads.map((thread) => thread.answer),
    ]).join("\n");
    expect(visible).not.toMatch(/官网暂时没有|营业执照在大厅公示|稍后帮你预约|帮大家预约/u);
    expect(result.packages.some((pkg) => pkg.validation.issues.some((issue) =>
      issue.code === "model_org_answer_failed" && issue.origin === "deterministic"))).toBe(true);
  });

  it("合规蓝图不产生 accountable_identity_incomplete", async () => {
    const perCandidate = await issuesFor(isolationBlueprint(), "accountable-ok");
    expect(perCandidate.every((issues) => issues.length === 0)).toBe(true);
  });

  it("存量只有 1 个可追责身份 + replyDisplayRoles 写内部 id 时,每个候选都记 warning", async () => {
    // 复刻线上「毛毛驿站」形态:助理角色 accountable=false,读者路由指向内部 id。
    const drifted = isolationBlueprint();
    const roles = drifted.roleModel.roles.map((role) => {
      if (role.id === "assistant") return { ...role, accountable: false };
      if (role.id === "peer") return { ...role, replyDisplayRoles: ["host_account"] };
      return role;
    });
    const perCandidate = await issuesFor({ ...drifted, roleModel: { ...drifted.roleModel, roles } }, "accountable-drift");
    expect(perCandidate).toHaveLength(3);
    for (const issues of perCandidate) {
      expect(issues).toHaveLength(2);
      expect(issues.every((issue) => issue.severity === "warning" && issue.channel === "Cref")).toBe(true);
      expect(issues[0]!.message).toContain("只有 1 个可追责公开身份");
      expect(issues[1]!.message).toContain("host_account");
    }
    // warning 不阻断:候选照旧产出,不因体检失败而丢稿。
    expect(perCandidate.every((issues) => issues.length === 2)).toBe(true);
  });
});
