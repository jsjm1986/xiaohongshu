import { describe, expect, it } from "vitest";

import {
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  planTopicOrchestrations,
} from "../src/index.js";
import type { InformationGap, TopicOpportunity } from "../src/index.js";

/**
 * 参数可分辨性(effective range)回归。
 *
 * 滑杆是 0–100 步长 1,但消费端是分档阈值。只要预设实际取值区间整段落在同一
 * 档内,滑杆在生产中就是常量——UI 上能调 21 个刻度,产出逐字不变。本文件锁住
 * 「预设区间内必须可分辨」这条约束,防止阈值再次漂到区间之外。
 *
 * comment_role_diversity 的内置预设取值为 75–95(parameters.ts BUILT_IN
 * GENERATION_PRESETS),所以基准点取 75/85/95。
 */
const project = {
  id: "p1",
  name: "项目",
  domain: "决策信息",
  productPoints: ["资料确认的项目事实"],
  organizationPoints: ["资料确认的服务边界"],
  cities: ["上海"],
  doctors: [],
};

function config(roleDiversity: number) {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.task.city = "上海";
  value.informationWindow.boundaries = ["个体适用性需要单独核验"];
  value.content.commentThreadMin = 3;
  value.content.commentThreadMax = 5;
  value.content.followUpDepth = 2;
  value.parameters!.commentRoleDiversity = roleDiversity;
  return value;
}

const gaps: InformationGap[] = ["fit", "compare", "unknown", "cost", "timing"].map((id, index) => ({
  id,
  label: `维度${index + 1}`,
  question: `第${index + 1}个维度怎么判断？`,
  category: "decision" as const,
  audienceStages: ["comparing" as const],
  importance: 0.9 - index * 0.05,
  decisionLeverage: 0.9 - index * 0.05,
  proofability: 0.8,
  evidenceIds: ["evidence_d1"],
  required: index < 2,
  preferredChannels: ["Cref" as const],
}));

function opportunity(): TopicOpportunity {
  return {
    id: "o1",
    topic: "方案选择",
    angle: "先核验再比较",
    gapIds: gaps.map((gap) => gap.id),
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
    imageAssetIds: ["img1"],
    status: "eligible",
  } as TopicOpportunity;
}

/** 同一固定种子下的可观测角色形态,唯一变量是滑杆值。 */
function roleShapeAt(roleDiversity: number) {
  const plans = planTopicOrchestrations({
    opportunity: opportunity(),
    gaps,
    config: config(roleDiversity),
    seeds: [11, 22, 33],
  });
  const threads = plans.flatMap((plan) => plan.dialogueThreads);
  return {
    stances: new Set(threads.map((thread) => thread.roleCard.evidenceStance)).size,
    stages: new Set(threads.map((thread) => thread.roleCard.stage)).size,
    personas: new Set(threads.map((thread) => thread.personaRole)).size,
  };
}

describe("开启多轮生长时为追问预留行数预算", () => {
  /**
   * followUpLineCapacity = floor((visibleCommentLines[1] - threads*2) / 2)。
   * 根评论数固定 5、行数上限 13 时容量只有 1 —— 接话比例从 48 调到 75 也只能产出
   * 1 条追问(实测两篇 rate=60/70 生长数都是 1)。开启开关就应该把追问要占的行数
   * 一并预留进去,否则"选中了多轮"和"没选"在产出上几乎无差别。
   *
   * 预留量受确认样本基线约束(comment_lines p75=14 / max=20),不凭空放大形态。
   */
  function capacityFor(growth: boolean) {
    const value = config(85);
    value.content.commentMultiTurnGrowthEnabled = growth;
    const plans = planTopicOrchestrations({ opportunity: opportunity(), gaps, config: value, seeds: [11, 22, 33] });
    const plan = plans[0]!;
    const linesMax = plan.personaScenePlan!.surfaceTargets.visibleCommentLines[1];
    const threads = plan.effectiveThreadCount;
    return {
      linesMax,
      threads,
      capacity: Math.max(0, Math.floor((linesMax - threads * 2) / 2)),
      target: plan.personaScenePlan!.commentNetwork.multiTurnTarget,
    };
  }

  it("开启后行数上限提高,追问容量大于关闭时", () => {
    const off = capacityFor(false);
    const on = capacityFor(true);
    expect(on.linesMax).toBeGreaterThan(off.linesMax);
    expect(on.capacity).toBeGreaterThan(off.capacity);
  });

  it("预留不超过确认样本基线的评论行数上限(max=20)", () => {
    expect(capacityFor(true).linesMax).toBeLessThanOrEqual(20);
  });

  it("多轮目标下限不超过实际可用容量,避免不可达期望", () => {
    const on = capacityFor(true);
    expect(on.target[0]).toBeLessThanOrEqual(on.capacity);
  });

  it("关闭时行数预算保持样本原型基线(不影响单轮形态)", () => {
    // 不写死数字:各原型基线不同(12–15),这里断言它落在样本基线区间内且未被抬高。
    const off = capacityFor(false);
    expect(off.linesMax).toBeGreaterThanOrEqual(12);
    expect(off.linesMax).toBeLessThanOrEqual(15);
    // 关闭时不预留追问行数,所以必须严格小于开启时。
    expect(off.linesMax).toBeLessThan(capacityFor(true).linesMax);
  });
});

describe("comment_role_diversity 在预设实际区间内可分辨", () => {
  it("75 / 85 / 95 三个预设取值不能产出完全相同的角色形态", () => {
    const shapes = [75, 85, 95].map(roleShapeAt);
    const fingerprints = shapes.map((shape) => JSON.stringify(shape));
    // 三点全等 => 整个预设区间落在同一档,滑杆在生产中是常量。
    expect(new Set(fingerprints).size).toBeGreaterThan(1);
  });

  it("低档位语义保留:0 仍明显弱于 100", () => {
    const low = roleShapeAt(0);
    const high = roleShapeAt(100);
    expect(low.stances).toBeLessThan(high.stances);
  });

  it("同值可重放:相同滑杆值与种子产出相同形态", () => {
    expect(roleShapeAt(85)).toEqual(roleShapeAt(85));
  });
});
