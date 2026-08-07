import { describe, expect, it } from "vitest";

import {
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
} from "../src/index.js";
import type { InformationGap, KnowledgeDocument } from "../src/index.js";

/**
 * 人工确认的答案必须在生成端真的被采用。
 *
 * bindGapEvidence 的规则是「答案拿不到证据就置 undefined、proofability 归 0」。
 * 人工填的答案不在资料里,分节匹配不中;此前它靠 planningEvidenceSupports 的自证
 * 侥幸成立——而那条路格式敏感:JSON 转义会在换行、半角双引号、制表符、反斜杠处
 * 插入反斜杠,破坏子串匹配。缺口编辑器的答案框是 textarea,多行是常态,
 * 所以效力取决于用户有没有敲回车。这里改成显式路径。
 */
const knowledge: KnowledgeDocument[] = [indexKnowledgeSource({
  projectId: "p1",
  path: "facts.md",
  content: "# 项目事实\n\n资料里确认过的一句话。",
})];

function config() {
  const value = createDefaultGenerationConfig({
    id: "p1",
    name: "项目",
    domain: "健康信息",
    productPoints: ["资料确认的项目事实"],
    organizationPoints: [],
    cities: [],
    doctors: [],
  }, DEFAULT_FORMULA_VERSION);
  value.task.theme = "信息核实";
  value.task.audienceStage = "comparing";
  value.task.forbidden = [];
  return value;
}

function gap(overrides: Partial<InformationGap> = {}): InformationGap {
  return {
    id: "g1",
    label: "资质编号",
    question: "资质编号是多少？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    evidenceIds: [],
    required: true,
    ...overrides,
  };
}

const confirmation = { confirmedBy: "owner-1", confirmedAt: "2026-08-01T10:00:00.000Z" };

async function generatedGap(input: InformationGap) {
  const result = await new ContentGenerationAgent().generate({
    jobId: "human-evidence-job",
    config: config(),
    formulaVersion: DEFAULT_FORMULA_VERSION,
    knowledge,
    planningContext: { informationGaps: [input] },
  });
  const packageResult = result.packages[0];
  const cards = packageResult?.orchestrationSnapshot?.gapPlanningCards ?? [];
  return { result, packageResult, card: cards.find((card) => card.gapId === "g1") };
}

describe("人工确认的缺口答案", () => {
  it("多行答案标了 user_supplied 也拿到证据并被采用", async () => {
    // 多行是这条路径的关键形态:旧的自证路线在这里必然失败
    const { card } = await generatedGap(gap({ answer: "编号待确认\n证件在门店", sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    expect(card?.evidenceIds.some((id) => id.startsWith("evidence_human_"))).toBe(true);
    expect(card?.answer).toBe("编号待确认\n证件在门店");
  });

  it("含半角双引号的答案同样成立", async () => {
    const { card } = await generatedGap(gap({ answer: '按"套内面积"计算', sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    expect(card?.evidenceIds.some((id) => id.startsWith("evidence_human_"))).toBe(true);
  });

  it("没标 user_supplied 的答案不获得人工证据", async () => {
    const { card } = await generatedGap(gap({ answer: "编号待确认\n证件在门店", sourceStatus: "unknown" }));
    expect((card?.evidenceIds ?? []).some((id) => id.startsWith("evidence_human_"))).toBe(false);
  });

  it("supplied_fact 不算人工背书", async () => {
    // supplied_fact 只能由分析器写,代表「资料里本来就有」,该由分节证据背书。
    // 把它也认成人工背书就等于让分析器自己给自己盖章——这条钉住那道边界。
    const { card } = await generatedGap(gap({ answer: "编号待确认\n证件在门店", sourceStatus: "supplied_fact" }));
    expect((card?.evidenceIds ?? []).some((id) => id.startsWith("evidence_human_"))).toBe(false);
  });

  it("人工证据与资料分节证据不混同,来源可追溯", async () => {
    const { card } = await generatedGap(gap({ answer: "资料里确认过的一句话", sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    const ids = card?.evidenceIds ?? [];
    expect(ids.some((id) => id.startsWith("evidence_human_"))).toBe(true);
    expect(ids.some((id) => id.startsWith("evidence_section_"))).toBe(true);
  });

  it("没有答案时不凭空给人工证据", async () => {
    const { card } = await generatedGap(gap({ sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    expect((card?.evidenceIds ?? []).some((id) => id.startsWith("evidence_human_"))).toBe(false);
  });

  it("只有 user_supplied 标签、没有真实审批元数据时不会获得人工证据", async () => {
    const { card } = await generatedGap(gap({ answer: "项目负责人尚未真正审批", sourceStatus: "user_supplied" }));
    expect(card?.answer).toBeUndefined();
    expect((card?.evidenceIds ?? []).some((id) => id.startsWith("evidence_human_"))).toBe(false);
  });


  it("keeps a reviewed SOFT pain answer bound across harmless frequency paraphrases", async () => {
    const softKnowledge = [indexKnowledgeSource({
      projectId: "p1",
      path: "soft.md",
      content: [
        "# SOFT 分层双麻缓释技术",
        "术中体验：打麻药的时候有短暂的进针刺痛感，之后操作无痛感，些许人会有酸胀、牵拉或压迫感；过程中可沟通并根据情况调整节奏，客户常常睡着或在聊天中结束。",
      ].join("\n"),
    })];
    const answer = "打麻药时有短暂进针刺痛感，之后操作无痛感，部分人有酸胀、牵拉或压迫感；过程中可沟通调整节奏，常有人睡着或聊天中结束。";
    const result = await new ContentGenerationAgent().generate({
      jobId: "soft-reviewed-gap",
      config: config(),
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge: softKnowledge,
      planningContext: { informationGaps: [gap({ answer, sourceStatus: "supplied_fact", proofability: 0.3 })] },
    });
    const card = result.packages[0]?.orchestrationSnapshot?.gapPlanningCards?.find((item) => item.gapId === "g1");
    expect(card?.answer).toBe(answer);
    expect(card?.proofability).toBe(0.3);
    expect(card?.evidenceIds.some((id) => id.startsWith("evidence_section_"))).toBe(true);
  });

  it("人工证据进入正式引用池并随最终包冻结", async () => {
    const answer = "门店确认：编号 A-1024";
    const { card, packageResult } = await generatedGap(gap({ answer, sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    const evidenceId = card?.evidenceIds.find((id) => id.startsWith("evidence_human_"));
    expect(evidenceId).toBeTruthy();
    const reference = packageResult?.evidence.find((item) => item.id === evidenceId);
    expect(reference).toMatchObject({
      id: evidenceId,
      path: "planning.human-confirmation/g1/answer",
      kind: "fact",
      evidenceStatus: "user_supplied",
      quote: answer,
    });
    expect(reference?.caveats.join(" ")).toContain("owner-1");
  });

  it("答案或审批时间变化会产生新的内容寻址证据 ID", async () => {
    const first = await generatedGap(gap({ answer: "编号 A-1", sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    const second = await generatedGap(gap({ answer: "编号 A-2", sourceStatus: "user_supplied", humanConfirmation: confirmation }));
    const third = await generatedGap(gap({
      answer: "编号 A-1",
      sourceStatus: "user_supplied",
      humanConfirmation: { ...confirmation, confirmedAt: "2026-08-02T10:00:00.000Z" },
    }));
    const idFor = (value: Awaited<ReturnType<typeof generatedGap>>) => value.card?.evidenceIds.find((id) => id.startsWith("evidence_human_"));
    expect(idFor(first)).not.toBe(idFor(second));
    expect(idFor(first)).not.toBe(idFor(third));
  });
});
