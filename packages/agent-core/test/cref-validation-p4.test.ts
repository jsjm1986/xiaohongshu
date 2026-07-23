import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
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
    expect(codes(byIdentity("author"))).toContain("comment_identity_violation");
    expect(byIdentity("author").find((issue) => issue.code === "comment_identity_violation")?.severity).toBe("error");
    const templateIssues = byIdentity("reader_question_template");
    expect(codes(templateIssues)).toEqual(expect.arrayContaining(["comment_identity_violation", "unaccountable_answer_identity"]));
    for (const accountable of ["publisher", "brand", "staff", "expert"]) {
      expect(codes(byIdentity(accountable))).not.toContain("comment_identity_violation");
    }
  });

  it("flags a completed first-person publisher answer while the body only declares intent", () => {
    const config = validationConfig();
    const completionAnswer = "我之前已经问过了，按当期口径看。";
    const intentIssues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ answer: completionAnswer })]))),
      config,
    );
    expect(intentIssues).toContainEqual(expect.objectContaining({ code: "comment_host_state_inconsistency", severity: "error", channel: "Cref" }));

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

  it("routes question-side completion claims to fabricated_operational_experience, never double-firing", () => {
    const config = validationConfig();
    const issues = validate(
      parseGenerationDraft(JSON.stringify(draftJson(intentBody, [thread({ question: "我之前试过一次，想问问大家？" })]))),
      config,
    );
    expect(codes(issues)).toContain("fabricated_operational_experience");
    expect(codes(issues)).not.toContain("comment_host_state_inconsistency");

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

describe("P4 comment network shape and growth levels", () => {
  it("escalates under-grown to error only when the growth switch is on with a non-zero target", () => {
    const config = validationConfig();
    config.content.commentMultiTurnGrowthEnabled = true;
    const fourFlatThreads = [1, 2, 3, 4].map((index) => thread({ id: `t${index}`, question: `第${index}项怎么选？` }));
    const draft = parseGenerationDraft(JSON.stringify(draftJson(plainBody, fourFlatThreads)));
    const plan = commentNetworkPlan(4, [2, 3]);

    const escalated = validate(draft, config, { orchestrationPlan: plan });
    expect(escalated).toContainEqual(expect.objectContaining({ code: "comment_network_under_grown", severity: "error", repairable: true }));

    config.content.commentMultiTurnGrowthEnabled = false;
    const warningOnly = validate(draft, config, { orchestrationPlan: plan });
    expect(warningOnly).toContainEqual(expect.objectContaining({ code: "comment_network_under_grown", severity: "warning" }));

    // Switch off with a [0,0] target: never fires.
    const offTarget = validate(draft, config, { orchestrationPlan: commentNetworkPlan(4, [0, 0]) });
    expect(codes(offTarget)).not.toContain("comment_network_under_grown");

    // Switch on and the target satisfied by actual follow-ups: no issue.
    config.content.commentMultiTurnGrowthEnabled = true;
    const grown = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？", followUps: [{ question: "那第二点呢？", answer: "也一样先看情况。", evidenceIds: [] }] }),
      thread({ id: "t2", question: "第二项怎么选？", followUps: [{ question: "还有吗？", answer: "看完情况再定。", evidenceIds: [] }] }),
      thread({ id: "t3", question: "第三项怎么选？" }),
      thread({ id: "t4", question: "第四项怎么选？" }),
    ])));
    const satisfied = validate(grown, config, { orchestrationPlan: plan });
    expect(codes(satisfied)).not.toContain("comment_network_under_grown");

    // A target minimum above the sample-shape line capacity is clamped to the
    // achievable floor instead of producing an unsatisfiable error.
    const clamped = validate(grown, config, { orchestrationPlan: commentNetworkPlan(4, [3, 4]) });
    expect(codes(clamped)).not.toContain("comment_network_under_grown");
  });

  it("escalates heavy reply-voice repetition and symmetric shapes to error", () => {
    const config = validationConfig();
    const plan4 = commentNetworkPlan(4, [0, 0]);
    const repeated = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？", answer: "对啊，先看情况。" }),
      thread({ id: "t2", question: "第二项差别在哪？", answer: "对啊，先别急着定。" }),
      thread({ id: "t3", question: "第三项要问什么？", answer: "对啊，先问清楚。" }),
      thread({ id: "t4", question: "第四项看什么？", answer: "再想想也行。" }),
    ])));
    const severe = validate(repeated, config, { orchestrationPlan: plan4 });
    expect(severe).toContainEqual(expect.objectContaining({ code: "comment_reply_voice_repetition", severity: "error" }));

    const threeThreads = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？", answer: "对啊，先看情况。" }),
      thread({ id: "t2", question: "第二项差别在哪？", answer: "对啊，先别急着定。" }),
      thread({ id: "t3", question: "第三项要问什么？", answer: "对啊，先问清楚。" }),
    ])));
    const mild = validate(threeThreads, config, { orchestrationPlan: commentNetworkPlan(3, [0, 0], 8) });
    expect(mild).toContainEqual(expect.objectContaining({ code: "comment_reply_voice_repetition", severity: "warning" }));

    const symmetric = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "怎么选？", answer: "先看自己情况。" }),
      thread({ id: "t2", question: "选哪个？", answer: "先看具体条件。" }),
      thread({ id: "t3", question: "看啥呢？", answer: "先问清楚再说。" }),
      thread({ id: "t4", question: "能选吗？", answer: "先别想太多啦。" }),
    ])));
    const symmetricIssues = validate(symmetric, config, { orchestrationPlan: plan4 });
    expect(symmetricIssues).toContainEqual(expect.objectContaining({ code: "comment_network_symmetric_shape", severity: "error" }));

    const loose = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "怎么选？", answer: "先看情况。" }),
      thread({ id: "t2", question: "选哪个？", answer: "先看自己的条件。" }),
      thread({ id: "t3", question: "看啥呢？", answer: "先问清楚再决定吧。" }),
      thread({ id: "t4", question: "能选吗？", answer: "先别急着定。" }),
    ])));
    const looseIssues = validate(loose, config, { orchestrationPlan: plan4 });
    expect(looseIssues).toContainEqual(expect.objectContaining({ code: "comment_network_symmetric_shape", severity: "warning" }));
  });

  it("checks role coverage instead of a flat floor and flags adjacent repeats", () => {
    const config = validationConfig();
    const plan = (count: number) => commentNetworkPlan(count, [0, 0], Math.max(8, count * 2));
    const withRoles = (roles: string[]) => {
      const threads = roles.map((role, index) => thread({ id: `t${index + 1}`, question: `第${index + 1}项怎么选？` }));
      const draft = parseGenerationDraft(JSON.stringify(draftJson(plainBody, threads)));
      draft.content.Cref.threads.forEach((item, index) => {
        item.surfaceRoleCard = surfaceRole(roles[index]!);
      });
      return validate(draft, config, { orchestrationPlan: plan(roles.length) });
    };
    expect(codes(withRoles(["谨慎比较者", "首次功课者", "谨慎比较者", "同城行动者"]))).toContain("comment_surface_roles_flat");
    expect(codes(withRoles(["谨慎比较者", "首次功课者", "同城行动者", "蹲反馈者"]))).not.toContain("comment_surface_roles_flat");
    expect(codes(withRoles(["谨慎比较者", "首次功课者", "同城行动者", "蹲反馈者", "蹲反馈者"]))).toContain("comment_surface_roles_flat");
    expect(codes(withRoles(["谨慎比较者", "首次功课者", "同城行动者", "蹲反馈者", "谨慎比较者"]))).not.toContain("comment_surface_roles_flat");
  });

  it("exempts all-question networks that have follow-up depth", () => {
    const config = validationConfig();
    const flat = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？" }),
      thread({ id: "t2", question: "第二项怎么选？" }),
      thread({ id: "t3", question: "第三项怎么选？" }),
    ])));
    expect(codes(validate(flat, config, { orchestrationPlan: commentNetworkPlan(3, [0, 0], 8) }))).toContain("comment_network_all_questions");

    const deep = parseGenerationDraft(JSON.stringify(draftJson(plainBody, [
      thread({ id: "t1", question: "第一项怎么选？", followUps: [{ question: "那第二点呢？", answer: "也一样先看情况。", evidenceIds: [] }] }),
      thread({ id: "t2", question: "第二项怎么选？" }),
      thread({ id: "t3", question: "第三项怎么选？" }),
    ])));
    expect(codes(validate(deep, config, { orchestrationPlan: commentNetworkPlan(3, [0, 0]) }))).not.toContain("comment_network_all_questions");
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
    value.content.commentThreadMin = 2;
    value.content.commentThreadMax = 2;
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

  function stagedThreads(request: ModelGenerationRequest) {
    const match = requestText(request).match(/<task_data>\s*([\s\S]*?)\s*<\/task_data>/u);
    const taskData = match ? JSON.parse(match[1]!) : {};
    return ((taskData.orchestrationPlan?.dialogueThreads ?? []) as Array<{ id: string }>).map((item, index) => ({
      id: item.id,
      roleIndex: index,
      question: `第${index + 1}项应该怎么选？`,
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
    const brokenBody = "先核对手头的说法，再决定下一步。细节我还在整理，确认后再补充。";
    const fixedBody = "先核实适用边界，再决定下一步。细节我还在整理，确认后再补充。";
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comments") {
          return { text: JSON.stringify({ disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads: stagedThreads(request) }), raw: {} };
        }
        if (purpose === "generate_ledger") {
          return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        }
        if (purpose === "repair") {
          const ids = [...new Set(
            [...requestText(request).matchAll(/"id"\s*:\s*"([^"]+)"/gu)]
              .map((match) => match[1]!)
              .filter((id) => id.includes("_thread_")),
          )];
          const [first, second] = ids;
          const rawPatch = [
            "修复结果：",
            "```json",
            `{“N”：{“body”：“${fixedBody}”}，“Cref”：{“disclaimer”：“以下为模拟情景问答参考模板，不代表真实评论。”，“threads”：[{“id”：“${second}”，“question”：“第二项怎么选才稳？”，“answer”：“先看自己的情况。”，“followUps”：[]}，{“id”：“${first}”，“question”：“第一项还要确认什么？”，“answer”：“多问一句再定。”，“followUps”：[]}]}}`,
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
      // Out-of-order patch merged by id: original order, new prose.
      expect(pkg.content.Cref.threads.map((item) => item.question)).toEqual(["第一项还要确认什么？", "第二项怎么选才稳？"]);
      expect(pkg.validation.valid).toBe(true);
    }
  });

  it("keeps the candidate alive for review when repair fails terminally", async () => {
    const brokenBody = "先核对手头的说法，再决定下一步。细节我还在整理，确认后再补充。";
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comments") {
          return { text: JSON.stringify({ disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。", threads: stagedThreads(request) }), raw: {} };
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
      expect(pkg.validation.valid).toBe(false);
      // Exactly one terminal repair record (deduped across attempts), and the
      // channel's original issue is preserved with the pre-repair content.
      const repairIssues = pkg.validation.issues.filter((issue) => issue.code === "repair_parse_failed");
      expect(repairIssues).toHaveLength(1);
      expect(repairIssues[0]).toMatchObject({ severity: "error", repairable: false });
      expect(pkg.validation.issues.map((issue) => issue.code)).toContain("missing_required_phrase");
      expect(pkg.content.N.body).toBe(brokenBody);
    }
  });
});
