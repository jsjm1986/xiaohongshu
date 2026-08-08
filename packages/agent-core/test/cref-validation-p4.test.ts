import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  channelsForIssues,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  mergeCrefPatchById,
  parseGenerationDraft,
  parseGenerationPatch,
  validateGenerationDraft,
} from "../src/index.js";
import type {
  CommentSurfaceRoleCard,
  ContentPackageContent,
  GenerationDraft,
  ModelGenerationRequest,
  ModelProvider,
} from "../src/index.js";

const project = { id: "p1", name: "测试项目", domain: "信息服务", productPoints: [], organizationPoints: [], cities: [], doctors: [] };

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

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    question: "这个要怎么判断？",
    answer: "先按手头的说法核实条件。",
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

function validate(draft: GenerationDraft, config = validationConfig(), extras: Record<string, unknown> = {}) {
  return validateGenerationDraft({
    draft,
    config,
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: [],
    ...extras,
  });
}

const codes = (issues: ReturnType<typeof validateGenerationDraft>) => issues.map((issue) => issue.code);
const plainBody = "先看自己的情况，别急着下结论，多问一句再定。";
/** Intent/undecided host voice: intent markers, no completed first-person action. */
const intentBody = "我还在纠结要不要行动，打算先把条件问清楚。";
/** Host already reports completion: the intent-state check must stay inactive. */
const completionBody = "我上个月已经把功课做完了，这次来补个记录。";

function surfaceRole(displayRole: string): CommentSurfaceRoleCard {
  return {
    displayRole,
    relationToHost: "处境相近",
    identityCue: displayRole,
    situationCue: "带着一个现实限制",
    motive: "确认一个条件",
    knowledgePosition: "只知道公开信息",
    speechPattern: "短句",
    lexicalCues: [],
    interactionHook: "补一个条件",
    permittedContribution: "一个窄问题",
    utteranceMode: "direct_question",
    targetChars: [4, 30],
    replyDisplayRole: "发布者",
  };
}

/** Minimal orchestration fixture exposing personaScenePlan.commentNetwork only. */
function commentNetworkPlan(threadCount: number, multiTurnTarget: [number, number], visibleLinesMax = 12) {
  return {
    effectiveThreadCount: threadCount,
    targetThreadCount: threadCount,
    selectedGapIds: [],
    gapCoverageLedger: {
      entries: [],
      uncoveredGapIds: [],
      ledgerCompleteness: 1,
      closureRate: 1,
      targetThreadCount: threadCount,
      effectiveThreadCount: threadCount,
    },
    dialogueThreads: [],
    personaScenePlan: {
      scenarioFamilyId: "f1",
      prototype: "option_comparison",
      commentCast: [],
      commentNetwork: {
        platformRegister: "plain",
        platformLanguageRule: "",
        multiTurnTarget,
        branchMoves: [],
        organicMoves: [],
        antiScriptRules: [],
      },
      surfaceTargets: {
        titleChars: [1, 40],
        bodyChars: [1, 800],
        bodyParagraphs: [1, 5],
        visibleCommentLines: [6, visibleLinesMax],
        typicalCommentChars: [4, 40],
      },
      crossChannelRules: [],
      sampleBasis: "test",
    },
  } as any;
}

describe("P4 comment identity and host-state validators", () => {
  it("flags unaccountable posting identities and accepts publisher-side ones", () => {
    const config = validationConfig();
    const byIdentity = (postingIdentity: string) => validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ postingIdentity })]))),
      config,
    );
    // 只有 reader_question_template(提问模板)不是可追责答复身份。
    const templateIssues = byIdentity("reader_question_template");
    expect(codes(templateIssues)).toEqual(expect.arrayContaining(["comment_identity_violation", "unaccountable_answer_identity"]));
    expect(templateIssues.find((issue) => issue.code === "comment_identity_violation")?.severity).toBe("error");
    // 方法论 §1744 的四档 postingIdentity(author/brand/staff/expert)全部可追责,
    // publisher 是本实现的发布账号档。此前 author 被判违规,而一次性生成 schema
    // (GENERATION_DRAFT_JSON_SCHEMA)恰恰要求模型输出 author——同一个值被同时
    // 要求和禁止,遵守 schema 的输出必然吃 comment_identity_violation。
    for (const accountable of ["author", "brand", "staff", "expert", "publisher"]) {
      expect(codes(byIdentity(accountable)), `${accountable} 应为可追责答复身份`).not.toContain("comment_identity_violation");
    }
  });

  it("解析后仍硬拦机构 publisher 冒充楼主（真实问题原句回归）", () => {
    const dirty = thread({
      postingIdentity: "publisher",
      question: "我周日做完第二天能开会吗？",
      answer: "我们是门诊，先发照片过来评估。",
      surfaceRoleCard: { ...surfaceRole("怕恢复期影响社交的上班族"), replyDisplayRole: "楼主" },
    });
    const parsed = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [dirty])));
    // 这里同时守 parseGenerationDraft：若解析器再次丢 surfaceRoleCard，门禁会被绕过。
    expect(parsed.content.Cref.threads[0]?.surfaceRoleCard?.replyDisplayRole).toBe("楼主");
    expect(validate(parsed)).toContainEqual(expect.objectContaining({
      code: "publisher_narrative_identity_alias", severity: "error", channel: "Cref",
    }));

    const explicit = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({
        postingIdentity: "publisher",
        answer: "这里由项目方按已核验口径说明。",
        surfaceRoleCard: { ...surfaceRole("谨慎比较者"), replyDisplayRole: "项目发布账号" },
      }),
    ])));
    expect(codes(validate(explicit))).not.toContain("publisher_narrative_identity_alias");
  });

  it("成稿身份和展示角色必须与生成前冻结计划完全一致", () => {
    const frozenRole = { ...surfaceRole("咨询中的读者"), replyDisplayRole: "项目助理" };
    const plan = commentNetworkPlan(1, [0, 0]);
    plan.dialogueThreads = [{
      id: "t1",
      postingIdentity: "staff",
      surfaceRoleCard: frozenRole,
    }];

    const clean = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({
      postingIdentity: "staff",
      surfaceRoleCard: frozenRole,
    })])));
    expect(codes(validate(clean, validationConfig(), { orchestrationPlan: plan })))
      .not.toEqual(expect.arrayContaining(["reply_identity_plan_drift", "reply_display_role_plan_drift"]));

    const identityDrift = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({
      postingIdentity: "expert",
      surfaceRoleCard: frozenRole,
    })])));
    expect(validate(identityDrift, validationConfig(), { orchestrationPlan: plan })).toContainEqual(expect.objectContaining({
      code: "reply_identity_plan_drift", severity: "error", channel: "Cref",
    }));

    const roleDrift = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({
      postingIdentity: "staff",
      surfaceRoleCard: { ...frozenRole, replyDisplayRole: "机构 IP" },
    })])));
    expect(validate(roleDrift, validationConfig(), { orchestrationPlan: plan })).toContainEqual(expect.objectContaining({
      code: "reply_display_role_plan_drift", severity: "error", channel: "Cref",
    }));
  });

  it("硬拦最终问题偏离规划期主 gap，即使身份和展示角色字段没有漂移", () => {
    const plannedSurface = { ...surfaceRole("到院信息核实者"), replyDisplayRole: "项目助理" };
    const plan = {
      ...commentNetworkPlan(1, [0, 0]),
      gapPlanningCards: [{ gapId: "location_gap", label: "到院信息", question: "具体位置和预约方式是什么？", category: "location" }],
      dialogueThreads: [{
        id: "t1", primaryGapId: "location_gap", postingIdentity: "staff",
        surfaceRoleCard: plannedSurface,
      }],
    } as any;
    const drifted = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({
      id: "t1", postingIdentity: "staff", question: "做的时候疼不疼？",
      surfaceRoleCard: plannedSurface,
    })])));
    const issues = validate(drifted, validationConfig(), { orchestrationPlan: plan });
    expect(issues).toContainEqual(expect.objectContaining({
      code: "reply_question_plan_drift", severity: "warning", disposition: "review", channel: "Cref",
    }));
    expect(codes(issues)).not.toContain("reply_identity_plan_drift");
    expect(codes(issues)).not.toContain("reply_display_role_plan_drift");
  });

  it("flags a completed first-person publisher answer while the body only declares intent", () => {
    const config = validationConfig();
    const completionAnswer = "我之前已经问过了，按当期口径看。";
    const intentIssues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ answer: completionAnswer })]))),
      config,
    );
    expect(intentIssues).toContainEqual(expect.objectContaining({ code: "comment_host_state_inconsistency", severity: "warning", disposition: "review", channel: "Cref" }));

    // A body that itself reports completion (e.g. a follow-up prototype) deactivates the check.
    const completionIssues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(completionBody, [thread({ answer: completionAnswer })]))),
      config,
    );
    expect(codes(completionIssues)).not.toContain("comment_host_state_inconsistency");

    // Negated / forward-looking first-person lines are not completion claims.
    const negatedIssues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ answer: "我还没问清，等确定了再回你。" })]))),
      config,
    );
    expect(codes(negatedIssues)).not.toContain("comment_host_state_inconsistency");

    // Brand/staff answers speak for the organization: a different claim class.
    const staffIssues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ postingIdentity: "staff", answer: completionAnswer })]))),
      config,
    );
    expect(codes(staffIssues)).not.toContain("comment_host_state_inconsistency");
  });

  it("放行发布账号的组织第一人称复数(我们/我方),只拦顾客口吻的第一人称完成", () => {
    // publisher 语义翻转后它代表发布账号,"我们"是它的正常人称。此前
    // claimsFirstPersonCompletion 用 /我(...)（已经|...)/ 匹配,"我们"的"我"同样
    // 命中,把正当的组织侧陈述判成顾客亲历——分词错误,不是语义放宽。
    const config = validationConfig();
    for (const answer of [
      "我们上周已经把当期价目更新了，以当期确认为准。",
      "我们的档期已经排到下月了。",
      "我方已经确认过这个口径。",
    ]) {
      const issues = validate(
        parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ postingIdentity: "publisher", answer })]))),
        config,
      );
      expect(codes(issues), `组织第一人称复数不应被拦: ${answer}`)
        .not.toContain("comment_host_state_inconsistency");
    }
    // 顾客口吻的单数第一人称完成仍是 error。
    const consumerVoice = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ postingIdentity: "publisher", answer: "我上周已经去看过一次了。" })]))),
      config,
    );
    expect(consumerVoice).toContainEqual(expect.objectContaining({
      code: "comment_host_state_inconsistency", severity: "warning", disposition: "review",
    }));
  });

  it("allows labelled simulated-reader experience and testimonial scenes without treating them as project evidence", () => {
    // 方法论 §1594:「职业、城市、经历等创作细节可以作为明确的拟人情境」——模糊
    // 的第一人称经历本身不违规,禁的是把它冒充项目事实、消费者证词或独立口碑。
    // 逐角色的「禁止代替的证据」由读者侧提示词按 personaRole 承担(标注制),
    // 校验层只守证词形态这条硬门槛,不再按「经历位」名额判定第一人称完成时。
    const config = validationConfig();
    const vague = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ question: "我之前试过一次，想问问大家？" })]))),
      config,
    );
    expect(codes(vague)).not.toContain("fabricated_operational_experience");
    expect(codes(vague)).not.toContain("comment_host_state_inconsistency");

    // 已标注的模拟读者可以承载消费者体验与效果感受，但只能保留为创作参考。
    const testimonial = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ question: "我做过一次，效果真的不错，你们呢？" })]))),
      config,
    );
    expect(codes(testimonial)).not.toContain("fabricated_operational_experience");
    expect(codes(testimonial)).toContain("creative_persona_experience");

    // A question side that only voices uncertainty stays clean.
    const cautious = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ question: "我也在查这个，还没弄明白，怎么问？" })]))),
      config,
    );
    expect(codes(cautious)).not.toContain("fabricated_operational_experience");
  });

  it("warns when an answer overlaps disclosed knowledge without a fact ledger entry", () => {
    const config = validationConfig();
    config.diagnostics.requireEvidenceReferences = false;
    const evidenceReferences = [{
      id: "ev_k1",
      documentId: "d1",
      path: "k.md",
      kind: "fact",
      evidenceStatus: "user_supplied",
      scope: [],
      caveats: [],
      quote: "价格以当期确认为准，一般在五千到八千之间浮动",
    }];
    const overlapping = "价格一般五千到八千，以当期为准，别按旧截图算。";
    const unrecorded = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: overlapping })]))),
      config,
      { allowedEvidenceIds: ["ev_k1"], evidenceReferences },
    );
    expect(unrecorded).toContainEqual(expect.objectContaining({ code: "knowledge_backed_claim_unrecorded", severity: "warning", channel: "Cref" }));

    // A fact ledger entry covering the segment silences the reminder.
    const recorded = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: overlapping })], {
        evidenceIds: ["ev_k1"],
        reasoning: [{ statement: overlapping, status: "fact", evidenceIds: ["ev_k1"] }],
      }))),
      config,
      { allowedEvidenceIds: ["ev_k1"], evidenceReferences },
    );
    expect(codes(recorded)).not.toContain("knowledge_backed_claim_unrecorded");

    // Question-side text is not a claim and is never scanned.
    const questionSide = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ question: "价格一般五千到八千吗？", answer: overlapping })]))),
      config,
      { allowedEvidenceIds: ["ev_k1"], evidenceReferences },
    );
    expect(codes(questionSide).filter((code) => code === "knowledge_backed_claim_unrecorded")).toHaveLength(1);

    const noOverlap = validate(
      parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ answer: "这个先别急着定，多问问再说。" })]))),
      config,
      { allowedEvidenceIds: ["ev_k1"], evidenceReferences },
    );
    expect(codes(noOverlap)).not.toContain("knowledge_backed_claim_unrecorded");
  });
});

describe("P4 deterministic validation boundary", () => {
  it("does not infer comment quality from growth quotas, punctuation, length symmetry or repeated openings", () => {
    const config = validationConfig();
    config.content.commentMultiTurnGrowthEnabled = true;
    const draft = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？", answer: "对啊，先看情况。" }),
      thread({ id: "t2", question: "第二项怎么选？", answer: "对啊，先别急。" }),
      thread({ id: "t3", question: "第三项怎么选？", answer: "对啊，先问清。" }),
      thread({ id: "t4", question: "第四项怎么选？", answer: "对啊，再想想。" }),
    ])));
    const issueCodes = codes(validate(draft, config, { orchestrationPlan: commentNetworkPlan(4, [2, 3]) }));
    expect(issueCodes).not.toEqual(expect.arrayContaining([
      "comment_network_under_grown",
      "comment_network_all_questions",
      "comment_reply_voice_repetition",
      "comment_network_symmetric_shape",
    ]));
  });

  it("does not turn role-count parameters into a deterministic quality floor", () => {
    const validateAt = (roleDiversity: number) => {
      const config = validationConfig();
      config.parameters!.commentRoleDiversity = roleDiversity;
      const roles = ["谨慎比较者", "谨慎比较者", "谨慎比较者", "谨慎比较者"];
      const draft = parseGenerationDraft(JSON.stringify(draftJson(plainBody,
        roles.map((role, index) => thread({ id: `t${index + 1}`, question: `第${index + 1}项怎么选？` })),
      )));
      draft.content.Cref.threads.forEach((item, index) => { item.surfaceRoleCard = surfaceRole(roles[index]!); });
      return codes(validate(draft, config, { orchestrationPlan: commentNetworkPlan(4, [0, 0], 8) }));
    };
    expect(validateAt(50)).not.toContain("comment_surface_roles_flat");
    expect(validateAt(95)).not.toContain("comment_surface_roles_flat");
  });

  /** Internal markers are deterministic frontstage leaks, not style judgments. */
  it("可见文案出现「待核实维度：」等内部标记时判 error", () => {
    const config = validationConfig();
    const draft = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "这个怎么算？", answer: "会更换班组，不加收费用。；待核实维度：方案适配条件。" }),
      thread({ id: "t2", question: "谁来认定？" }),
    ])));
    expect(codes(validate(draft, config))).toContain("internal_audit_artifact_visible");
  });
});

describe("P4 unknown-path naming", () => {
  function unknownPathPlan() {
    const card = {
      gapId: "g1",
      label: "恢复时间与节奏",
      question: "恢复时间到底怎么安排？",
      category: "decision",
      audienceStages: ["comparing"],
      importance: 0.8,
      decisionLeverage: 0.8,
      proofability: 0.5,
      evidenceIds: [],
      required: false,
      plannedPlacements: ["N.body"],
    };
    return {
      effectiveThreadCount: 1,
      targetThreadCount: 1,
      selectedGapIds: ["g1"],
      gapPlanningCards: [card],
      dialogueThreads: [],
      gapCoverageLedger: {
        entries: [{
          gapId: "g1",
          label: card.label,
          status: "unknown_with_verification",
          required: false,
          commentAllocated: false,
          bodyAllocated: true,
          plannedPlacements: ["N.body"],
          primaryThreadIds: [],
          auxiliaryThreadIds: [],
          verificationPath: "当面核实",
          actualRealizations: [],
        }],
        uncoveredGapIds: [],
        ledgerCompleteness: 1,
        closureRate: 1,
        targetThreadCount: 1,
        effectiveThreadCount: 1,
      },
    } as any;
  }

  it("accepts an organization-bound unknown thread that preserves uncertainty and points to a public verification channel", () => {
    const config = validationConfig();
    const card = {
      gapId: "org_info", label: "机构信息", question: "机构有哪些可公开、可核验的信息？",
      category: "boundary", audienceStages: ["ready"], importance: 0.8, decisionLeverage: 0.7,
      proofability: 0, evidenceIds: [], required: true, obligation: "network_required",
      disclosureScope: "organization_only", plannedPlacements: ["Cref"],
    };
    const plan = {
      effectiveThreadCount: 1, targetThreadCount: 1, selectedGapIds: [card.gapId],
      gapPlanningCards: [card],
      dialogueThreads: [{
        id: "t1", primaryGapId: card.gapId, auxiliaryGapIds: [], threadKind: "org_answer", postingIdentity: "publisher",
        replyPlan: {
          directAnswer: "机构可查性目前不能确认",
          condition: "",
          boundary: "",
          unknown: "机构全称和卫健委可查性目前还不能确认",
          nextQuestion: "到卫健委官网查询",
        },
      }],
      gapCoverageLedger: {
        entries: [{
          gapId: card.gapId, label: card.label, status: "unknown_with_verification", required: true,
          commentAllocated: true, bodyAllocated: false, plannedPlacements: ["Cref"],
          primaryThreadIds: ["t1"], auxiliaryThreadIds: [], verificationPath: "通过卫健委官网核验",
          actualRealizations: [],
        }],
        uncoveredGapIds: [], ledgerCompleteness: 1, closureRate: 1,
        targetThreadCount: 1, effectiveThreadCount: 1,
      },
    } as any;
    const output = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({
      id: "t1", gap: card.gapId, primaryGapId: card.gapId,
      question: "预约前怎么核实机构信息？",
      answer: "机构全称和卫健委可查性目前还不能确认，可以按正式名称到卫健委官网核验。",
      nextStep: "到卫健委官网查询",
      postingIdentity: "publisher", answerIdentity: "publisher", claimStatus: "unknown",
    })])));
    const issues = validate(output, config, { orchestrationPlan: plan });
    expect(issues).not.toContainEqual(expect.objectContaining({ code: "allocated_unknown_path_not_visible", channel: "Cref" }));
  });

  it("accepts a contiguous 4+ character paraphrase of the gap label", () => {
    const config = validationConfig();
    const named = validate(
      parseGenerationDraft(JSON.stringify(draftJson("恢复时间还拿不准，建议先补充资料再确认具体情况。", [thread()]))),
      config,
      { orchestrationPlan: unknownPathPlan() },
    );
    expect(codes(named)).not.toContain("allocated_unknown_path_not_visible");

    // A two-character echo is not naming the gap.
    const tooShort = validate(
      parseGenerationDraft(JSON.stringify(draftJson("恢复情况还拿不准，建议先补充资料再确认具体情况。", [thread()]))),
      config,
      { orchestrationPlan: unknownPathPlan() },
    );
    expect(tooShort).toContainEqual(expect.objectContaining({ code: "allocated_unknown_path_not_visible", severity: "warning" }));

    // An unrelated phrasing still fires.
    const unnamed = validate(
      parseGenerationDraft(JSON.stringify(draftJson("具体周期还拿不准，建议先补充资料再确认具体情况。", [thread()]))),
      config,
      { orchestrationPlan: unknownPathPlan() },
    );
    expect(codes(unnamed)).toContain("allocated_unknown_path_not_visible");
  });
});

describe("P4 repair protocol hardening", () => {
  it("parses fenced patches with full-width quotes, commas and colons", () => {
    const fenced = "好的，修复如下：\n```json\n{“N”：{“body”：“新正文内容”}，“evidenceIds”：[]}\n```\n请查收";
    const patch = parseGenerationPatch(fenced);
    expect(patch.N?.body).toBe("新正文内容");
    expect(patch.evidenceIds).toEqual([]);
  });

  it("keeps full-width punctuation inside legitimate string values untouched", () => {
    const patch = parseGenerationPatch(JSON.stringify({ N: { body: "他说：你好，“这样”没错，继续保持。" } }));
    expect(patch.N?.body).toBe("他说：你好，“这样”没错，继续保持。");
  });

  it("requires a restated disclaimer on Cref patches and rejects garbage", () => {
    expect(() => parseGenerationPatch(JSON.stringify({ Cref: { threads: [] } }))).toThrow(/disclaimer/iu);
    expect(() => parseGenerationPatch("这不是结构化内容")).toThrow();
  });

  it("merges Cref patches keyed by thread id: out-of-order, partial, metadata-preserving", () => {
    const draft = parseGenerationDraft(JSON.stringify({
      ...draftJson(plainBody, [
        thread({ id: "t1", question: "旧一问", answer: "旧一答", followUps: [{ question: "旧追问", answer: "旧追答", evidenceIds: [] }] }),
        thread({ id: "t2", question: "旧二问", answer: "旧二答" }),
      ]),
      content: {
        ...draftJson(plainBody, []).content,
        Cref: {
          disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。",
          ownedFirstComment: "置顶整理",
          threads: [
            thread({ id: "t1", question: "旧一问", answer: "旧一答", followUps: [{ question: "旧追问", answer: "旧追答", evidenceIds: [] }] }),
            thread({ id: "t2", question: "旧二问", answer: "旧二答" }),
          ],
        },
      },
    }));
    const current: ContentPackageContent["Cref"] = { ...draft.content.Cref, uncoveredGaps: ["g9"] };
    const patchCref = (threads: unknown[]): ContentPackageContent["Cref"] => ({
      disclaimer: "新模拟免责声明参考模板",
      threads: threads as ContentPackageContent["Cref"]["threads"],
    });

    // Out-of-order full patch lands in the original order; prose + disclaimer
    // are replaced while contract fields and thread metadata survive.
    const merged = mergeCrefPatchById(current, patchCref([
      thread({ id: "t2", question: "新二问", answer: "新二答" }),
      thread({ id: "t1", question: "新一问", answer: "新一答" }),
    ]));
    expect(merged.threads.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(merged.threads[0]).toMatchObject({ question: "新一问", answer: "新一答", personaRole: "information_collector" });
    expect(merged.threads[1]).toMatchObject({ question: "新二问", answer: "新二答" });
    expect(merged.disclaimer).toBe("新模拟免责声明参考模板");
    expect(merged.ownedFirstComment).toBe("置顶整理");
    expect(merged.uncoveredGaps).toEqual(["g9"]);
    // A patch thread without follow-ups keeps the current follow-ups.
    expect(merged.threads[0]!.followUps).toHaveLength(1);

    // Partial patch: unreturned threads keep their prose.
    const partial = mergeCrefPatchById(current, patchCref([thread({ id: "t2", question: "只改二问", answer: "只改二答" })]));
    expect(partial.threads[0]).toMatchObject({ question: "旧一问", answer: "旧一答" });
    expect(partial.threads[1]).toMatchObject({ question: "只改二问", answer: "只改二答" });

    // Unplanned ids fail.
    expect(() => mergeCrefPatchById(current, patchCref([thread({ id: "t9" })]))).toThrow(/unplanned/iu);
  });
});

describe("P4 repair loop end-to-end", () => {
  const knowledge = [
    indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
    indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
  ];

  function engineConfig() {
    const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
    value.task.theme = "方案选择";
    value.task.mustMention = ["适用边界"];
    value.informationWindow.gaps = ["适合谁", "如何比较"];
    value.informationWindow.boundaries = ["不能保证个体结果"];
    value.content.bodyMinChars = 20;
    value.content.bodyMaxChars = 800;
    value.content.hashtagMin = 3;
    value.content.hashtagMax = 6;
    // Final generic-repair tests isolate N.body. Cref id-merge semantics are
    // covered by the dedicated unit test above; unavailable accountable answers
    // are now terminal partial artifacts and must not be fabricated for this fixture.
    value.content.commentThreadMin = 0;
    value.content.commentThreadMax = 0;
    value.content.followUpDepth = 0;
    value.generation.maxRepairAttempts = 2;
    return value;
  }

  // Optional, non-required gaps keep unknown-path findings at warning level so
  // the only repairable error in these tests is the deliberate mustMention miss.
  const planningContext = {
    informationGaps: [
      { id: "g1", label: "适合谁", question: "哪些条件影响适用性？", category: "decision", audienceStages: ["comparing"], importance: 0.8, decisionLeverage: 0.8, proofability: 0.6, evidenceIds: [], required: false },
      { id: "g2", label: "如何比较", question: "不同做法按哪些点比较？", category: "comparison", audienceStages: ["comparing"], importance: 0.7, decisionLeverage: 0.7, proofability: 0.6, evidenceIds: [], required: false },
    ],
  };

  function requestText(request: ModelGenerationRequest): string {
    return request.messages.map((message) => {
      const content = message.content;
      return Array.isArray(content)
        ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
        : content;
    }).join("\n");
  }

  // 按侧+按角色隔离后,提示词不再有 task_data;线程 id 从提示词全文的规格/清单 JSON 提取。
  function stagedThreadIds(request: ModelGenerationRequest): string[] {
    return [...new Set([...requestText(request).matchAll(/"id"\s*:\s*"([^"]*_thread_\d+)"/gu)].map((match) => match[1]!))];
  }

  function stagedThreads(request: ModelGenerationRequest) {
    const questions = ["哪些条件影响适用性？", "不同做法按哪些点比较？"];
    return stagedThreadIds(request).map((id, index) => ({
      id,
      // Keep this fixture inside its frozen gap. These tests exercise the final
      // patch protocol, not the earlier reader-editor stage.
      question: questions[index] ?? "不同做法按哪些点比较？",
      answer: "先看自己的情况。",
      followUps: [] as Array<Record<string, unknown>>,
    }));
  }

  const coreResponse = (body: string) => JSON.stringify({
    content: {
      H: { hashtags: ["方案选择", "信息", "核验"] },
      N: { imageBrief: "信息清单封面", title: "先核实信息", body },
      Cref: { disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads: [] },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  });

  it("repairs via a fenced full-width patch and merges out-of-order threads by id", async () => {
    const brokenBody = "先核对手头的说法，再决定下一步。细节仍在整理，确认后再补充。";
    const fixedBody = "先核实适用边界，再决定下一步。细节仍在整理，确认后再补充。";
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return { text: JSON.stringify({ threads: stagedThreads(request) }), raw: {} };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "先看自己的情况。" })) }), raw: {} };
        }
        if (purpose === "generate_ledger") {
          return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        }
        if (purpose === "repair") {
          const rawPatch = [
            "修复结果：",
            "```json",
            `{“N”：{“body”：“${fixedBody}”}}`,
            "```",
          ].join("\n");
          return { text: rawPatch, raw: {} };
        }
        return { text: coreResponse(brokenBody), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "p4-repair-lenient", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });
    expect(result.packages).toHaveLength(3);
    for (const pkg of result.packages) {
      const finalCodes = pkg.validation.issues.map((issue) => issue.code);
      expect(finalCodes).not.toContain("repair_parse_failed");
      expect(finalCodes).not.toContain("missing_required_phrase");
      expect(pkg.content.N.body).toBe(fixedBody);
      expect(pkg.content.Cref.threads).toHaveLength(0);
      // With comments explicitly disabled, the focused body repair removes
      // the only blocker and the candidate is fully valid.
      expect(pkg.validation.issues.some((issue) => issue.disposition === "block" || issue.severity === "error")).toBe(false);
      expect(pkg.validation.qualityStatus).not.toBe("blocked");
      expect(pkg.validation.valid).toBe(true);
    }
  });

  it("keeps the candidate alive for review when repair fails terminally", async () => {
    const brokenBody = "先核对手头的说法，再决定下一步。细节仍在整理，确认后再补充。";
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_readers") {
          return { text: JSON.stringify({ threads: stagedThreads(request) }), raw: {} };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "先看自己的情况。" })) }), raw: {} };
        }
        if (purpose === "generate_ledger") {
          return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        }
        if (purpose === "repair") {
          return { text: "抱歉，我无法生成结构化修复内容。", raw: {} };
        }
        return { text: coreResponse(brokenBody), raw: {} };
      },
    };
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "p4-repair-terminal", config: engineConfig(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge, planningContext });
    // No throw: all three candidates survive and surface for human review.
    expect(result.packages).toHaveLength(3);
    for (const pkg of result.packages) {
      expect(pkg.validation.valid).toBe(true);
      expect(pkg.validation.qualityStatus).toBe("needs_review");
      // Exactly one terminal repair record (deduped across attempts). A failed
      // quality repair stays visible but cannot lock a formal model artifact.
      const repairIssues = pkg.validation.issues.filter((issue) => issue.code === "repair_parse_failed");
      expect(repairIssues).toHaveLength(1);
      expect(repairIssues[0]).toMatchObject({ severity: "warning", disposition: "review", repairable: false });
      expect(pkg.validation.issues.map((issue) => issue.code)).toContain("missing_required_phrase");
      expect(pkg.content.N.body).toBe(brokenBody);
    }
  });
});

/**
 * 追问层级(L1 补条件 → L2 反例/冲突 → L3 核验与下一步)与 stopWhen 的**结构**
 * 校验。方法论「追问层级不是越深越好」给的是层级语义与停止条件,不是深度配额:
 * 因此校验只判层级是否递进、停止声明是否落在末轮,不判「这条追问是不是真的在
 * 补条件」——那是语义判断,归模型(2B 提示词按层级下发),不归校验层词表。
 * 两条都是 warning:标注缺失或错序不该阻断可发布文案。
 */
describe("追问层级阶梯(结构校验,不做语义判断)", () => {
  const withFollowUps = (followUps: Array<Record<string, unknown>>) => validate(
    parseGenerationDraft(JSON.stringify(draftJson(plainBody, [thread({ followUps })]))),
    validationConfig(),
  );

  it("层级递进(L1→L2→L3)与全部缺省都不报", () => {
    const ascending = withFollowUps([
      { question: "那我这种情况呢？", answer: "看你的具体条件。", level: "L1" },
      { question: "可我听说有人不适合？", answer: "确实有例外。", level: "L2" },
      { question: "那我该先确认什么？", answer: "带上你的情况去核实。", level: "L3", stopReason: "answered" },
    ]);
    expect(codes(ascending)).not.toContain("comment_follow_up_level_not_ascending");
    expect(codes(ascending)).not.toContain("comment_follow_up_stop_not_final");

    // 历史包没有 level/stopReason:缺省即"未记录",不得因此报错。
    const legacy = withFollowUps([
      { question: "那我这种情况呢？", answer: "看你的具体条件。" },
      { question: "还要注意什么？", answer: "先确认这两项。" },
    ]);
    expect(codes(legacy)).not.toContain("comment_follow_up_level_not_ascending");
    expect(codes(legacy)).not.toContain("comment_follow_up_stop_not_final");
  });

  it("层级倒退或重复 → warning(不阻断)", () => {
    const descending = withFollowUps([
      { question: "有没有反例？", answer: "有。", level: "L2" },
      { question: "那我这种情况呢？", answer: "看条件。", level: "L1" },
    ]);
    expect(descending).toContainEqual(expect.objectContaining({
      code: "comment_follow_up_level_not_ascending", severity: "warning",
    }));
    // 同级重复同样不算递进。
    expect(withFollowUps([
      { question: "那我这种情况呢？", answer: "看条件。", level: "L1" },
      { question: "我朋友那种情况呢？", answer: "也看条件。", level: "L1" },
    ]).map((issue) => issue.code)).toContain("comment_follow_up_level_not_ascending");
  });

  it("停止声明出现在中途 → warning:声明停了却还在继续追问", () => {
    const earlyStop = withFollowUps([
      { question: "那我这种情况呢？", answer: "这个得让专人跟你确认。", level: "L1", stopReason: "route_to_professional" },
      { question: "那大概多久？", answer: "还是得看专人怎么说。", level: "L2" },
    ]);
    expect(earlyStop).toContainEqual(expect.objectContaining({
      code: "comment_follow_up_stop_not_final", severity: "warning",
    }));
    // 落在末轮就不报。
    expect(codes(withFollowUps([
      { question: "那我这种情况呢？", answer: "看条件。", level: "L1" },
      { question: "那我该先确认什么？", answer: "我帮你跟专人确认。", level: "L3", stopReason: "route_to_professional" },
    ]))).not.toContain("comment_follow_up_stop_not_final");
  });
});
