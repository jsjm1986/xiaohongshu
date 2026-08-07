import { describe, expect, it } from "vitest";

import {
  commentNetworkEditorialReasons,
  compileContentIntentCard,
  coreEditorialReasons,
  repairResponsibilityForIssues,
  STAGED_COMMENT_DISCLAIMER,
} from "../src/index.js";
import type {
  ContentValidationIssue,
  ExpressionStrategy,
  ImagePlan,
  InformationGapPlanningCard,
  OrchestrationPlan,
} from "../src/index.js";

const strategy: ExpressionStrategy = {
  id: "decision_note",
  label: "决策说明",
  openingMode: "从当前阻力开场",
  narrativeMode: "单一判断推进",
  bodyRole: "先说明关键条件",
  imageRole: "diagram",
  commentMode: "verification",
  voice: "自然、具体",
  sequence: ["problem", "condition", "next_step"],
  targetChannels: ["N.body", "Cref"],
  postingIdentity: "publisher",
  ownedFirstComment: false,
  pinPriority: ["verification"],
  liveRouting: [],
  updateTriggers: [],
  stopRules: [],
};

const imagePlan: ImagePlan = {
  role: "diagram",
  frames: ["一个判断关系图"],
  composition: "单页关系图",
  altText: "判断关系图",
  evidenceIds: [],
  boundaries: [],
};

const domains = [
  { name: "医疗", bodyId: "eligibility", bodyLabel: "适用条件", bodyQuestion: "哪些条件会改变适用判断？", answer: "适用条件需要结合个人情况判断", networkId: "appointment", networkLabel: "预约安排", networkQuestion: "预约安排要确认什么？" },
  { name: "教育", bodyId: "prerequisite", bodyLabel: "入学前提", bodyQuestion: "哪些前提会改变课程选择？", answer: "入学前提会影响课程选择", networkId: "schedule", networkLabel: "上课安排", networkQuestion: "上课安排要确认什么？" },
  { name: "软件", bodyId: "compatibility", bodyLabel: "兼容条件", bodyQuestion: "哪些条件会改变兼容判断？", answer: "兼容条件取决于当前系统环境", networkId: "deployment", networkLabel: "部署安排", networkQuestion: "部署安排要确认什么？" },
] as const;

function card(input: {
  id: string;
  label: string;
  question: string;
  answer?: string;
  placement: "N.body" | "Cref";
  obligation: "body_required" | "network_required";
}): InformationGapPlanningCard {
  return {
    gapId: input.id,
    label: input.label,
    question: input.question,
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    required: true,
    priority: "required",
    obligation: input.obligation,
    ...(input.answer ? { answer: input.answer } : {}),
    evidenceIds: [],
    disclosureScope: "shared",
    plannedPlacements: [input.placement],
  };
}

function planFor(domain: typeof domains[number]): OrchestrationPlan {
  const cards = [
    card({ id: domain.bodyId, label: domain.bodyLabel, question: domain.bodyQuestion, answer: domain.answer, placement: "N.body", obligation: "body_required" }),
    card({ id: domain.networkId, label: domain.networkLabel, question: domain.networkQuestion, placement: "Cref", obligation: "network_required" }),
  ];
  const contentIntent = compileContentIntentCard({
    id: `topic_${domain.bodyId}`,
    topic: `${domain.name}决策`,
    angle: domain.bodyQuestion,
    gapIds: cards.map((item) => item.gapId),
    audienceStage: "comparing",
    entry: "search",
    evidenceIds: [],
    boundaries: [],
    tags: [],
    imageAssetIds: [],
    status: "eligible",
  }, cards, strategy, imagePlan);
  return {
    gapPlanningCards: cards,
    contentIntent,
    dialogueThreads: cards.map((item, index) => ({
      id: `thread_${index + 1}`,
      primaryGapId: item.gapId,
      auxiliaryGapIds: [],
      threadKind: "org_answer",
      postingIdentity: "publisher",
    })),
  } as unknown as OrchestrationPlan;
}

describe("domain-neutral editorial orchestration", () => {
  it.each(domains)("compiles the same body/network responsibility contract for $name", (domain) => {
    const plan = planFor(domain);
    expect(plan.contentIntent).toMatchObject({
      bodyOwnedGapIds: [domain.bodyId],
      commentOwnedGapIds: [domain.networkId],
      bodyMustEstablish: [domain.bodyId],
      bodyMustNotExpand: [domain.networkId],
      imageRole: "explain_concept",
      completionMode: "answer",
    });

    expect(coreEditorialReasons({
      H: { hashtags: [] },
      N: { title: "先判断", body: "这里只写了泛化结论。", imageBrief: "关系图" },
    }, plan)).toHaveLength(1);
    expect(coreEditorialReasons({
      H: { hashtags: [] },
      N: { title: domain.bodyLabel, body: domain.answer, imageBrief: "关系图" },
    }, plan)).toEqual([]);
  });

  it.each(domains)("detects duplicate complete-network answers for $name without industry rules", (domain) => {
    const plan = planFor(domain);
    const comments = {
      disclaimer: STAGED_COMMENT_DISCLAIMER,
      threads: [
        { id: "thread_1", question: domain.bodyQuestion, answer: "这一项当前无法确认，先不下结论。", followUps: [] },
        { id: "thread_2", question: domain.networkQuestion, answer: "这一项当前无法确认，先不下结论。", followUps: [] },
      ],
    };
    expect(commentNetworkEditorialReasons(comments, plan)).toContain("线程 thread_2 与 thread_1 的根答复重复");
  });
});

describe("repair responsibility routing", () => {
  const issue = (code: string, channel: ContentValidationIssue["channel"]): ContentValidationIssue => ({
    code,
    channel,
    severity: "error",
    disposition: "block",
    message: code,
    repairable: true,
  });

  it("routes ledger mapping, visible copy and planning conflicts to different owners", () => {
    expect(repairResponsibilityForIssues([issue("visible_claim_not_in_ledger", "N.body")])).toEqual({
      responsibility: "ledger_only",
      channels: [],
    });
    expect(repairResponsibilityForIssues([issue("forbidden_phrase", "N.body")])).toEqual({
      responsibility: "visible_copy",
      channels: ["N.body"],
    });
    expect(repairResponsibilityForIssues([issue("reply_identity_plan_drift", "Cref")])).toEqual({
      responsibility: "replan_required",
      channels: [],
    });
  });
});
