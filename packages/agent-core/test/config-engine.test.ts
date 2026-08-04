import { describe, expect, it } from "vitest";

import {
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  FORMULA_EXECUTION_POLICY_DIGEST,
  FORMULA_EXECUTION_POLICY_VERSION,
  indexKnowledgeSource,
  resolveGenerationConfig,
} from "../src/index.js";
import type { ModelGenerationRequest, ModelProvider } from "../src/index.js";

const project = {
  id: "p1",
  name: "测试项目",
  domain: "决策信息",
  productPoints: ["资料中确认了产品要点"],
  organizationPoints: ["资料中确认了服务边界"],
  cities: ["上海"],
  doctors: [{ name: "张医生", points: ["资料中列出的专业方向"] }],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.task.city = "上海";
  value.task.mustMention = ["适用边界"];
  value.informationWindow.gaps = ["适合谁", "如何比较", "哪些未知"];
  value.informationWindow.boundaries = ["不能保证个体结果"];
  value.content.bodyMinChars = 120;
  value.content.bodyMaxChars = 800;
  value.content.hashtagMin = 3;
  value.content.hashtagMax = 6;
  value.content.commentThreadMin = 2;
  value.content.commentThreadMax = 4;
  value.content.followUpDepth = 2;
  value.knowledge.maxInputTokens = 20_000;
  value.knowledge.outputReserveTokens = 1_000;
  value.knowledge.safetyMarginTokens = 100;
  return value;
}

const knowledge = [
  indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

function requestText(request: ModelGenerationRequest): string {
  return request.messages.map((message) => {
    const content = message.content;
    return Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : content;
  }).join("\n");
}

/** 按侧+按角色隔离后,提示词不再有 task_data;线程 id 直接从提示词全文的规格/清单/根评论 JSON 中提取。 */
function stagedThreadIds(request: ModelGenerationRequest): string[] {
  return [...new Set([...requestText(request).matchAll(/"id"\s*:\s*"([^"]*_thread_\d+)"/gu)].map((match) => match[1]!))];
}

function stagedCommentThreads(request: ModelGenerationRequest, answer: string) {
  return stagedThreadIds(request).map((id, index) => ({
    id,
    question: `第${index + 1}项应该核实什么？`,
    answer,
    followUps: [],
  }));
}

describe("resolved generation config", () => {
  it("applies system -> workspace -> project -> task precedence and replaces arrays", () => {
    const defaults = config();
    const resolved = resolveGenerationConfig(defaults, {
      system: { content: { bodyMinChars: 200 }, task: { forbidden: ["系统禁词"] } },
      workspace: { content: { bodyMinChars: 240 } },
      project: { task: { forbidden: ["项目禁词"] } },
      task: { content: { bodyMinChars: 280 }, task: { forbidden: ["任务禁词"] } },
    });
    expect(resolved.content.bodyMinChars).toBe(280);
    expect(resolved.task.forbidden).toEqual(["任务禁词"]);
    expect(resolved.project.id).toBe("p1");
  });

  it("blocks prototype pollution keys during merge", () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
    const resolved = resolveGenerationConfig(config(), { task: malicious });
    expect(({} as any).polluted).toBeUndefined();
    expect(resolved.project.id).toBe("p1");
  });
});

describe("three-candidate content generation engine", () => {
  it("generates exactly three distinct, reproducible packages without configured model", async () => {
    const fixedNow = () => new Date("2026-07-12T12:00:00.000Z");
    const first = await new ContentGenerationAgent({ now: fixedNow }).generate({ jobId: "job-1", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const second = await new ContentGenerationAgent({ now: fixedNow }).generate({ jobId: "job-1", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    expect(first.packages).toHaveLength(3);
    expect(new Set(first.packages.map((item) => item.seed)).size).toBe(3);
    expect(new Set(first.packages.map((item) => item.content.N.title)).size).toBe(3);
    expect(new Set(first.packages.map((item) => item.content.N.body)).size).toBe(3);
    expect(new Set(first.packages.map((item) => item.content.N.imageBrief)).size).toBe(3);
    expect(new Set(first.packages.map((item) => item.orchestrationSnapshot?.strategy.id)).size).toBe(3);
    expect(first.packages.map((item) => item.content)).toEqual(second.packages.map((item) => item.content));
    expect(
      first.packages.every((item) => item.validation.valid),
      JSON.stringify(first.packages.map((item) => item.validation)),
    ).toBe(true);
    expect(first.packages.every((item) => item.reasoning
      .filter((entry) => entry.status === "fact")
      .every((entry) => Boolean(entry.location)
        && Boolean(entry.sourceSpans?.length)
        && entry.sourceSpans!.every((span) => entry.evidenceIds.includes(span.evidenceId))))).toBe(true);
    expect(first.packages.every((item) => item.content.Cref.disclaimer.includes("完整评论区创作参考"))).toBe(true);
    expect(first.packages[0].formulaSnapshot.digest).toBe(DEFAULT_FORMULA_VERSION.digest);
    expect(first.packages[0].formulaSnapshot).toMatchObject({
      executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
      executionPolicyDigest: FORMULA_EXECUTION_POLICY_DIGEST,
    });
    const executionAudit = first.packages[0].formulaSnapshot.executionAudit as any;
    expect(executionAudit?.indirectFormulas.map((item: any) => item.id)).not.toEqual(expect.arrayContaining(["F15", "F27"]));
    const protocolOnly = executionAudit?.nonDispatchedFormulas.filter((item: any) => ["F15", "F27"].includes(item.id));
    expect(protocolOnly).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "F15", implementationStatus: "protocol-only", controlMode: "not-running" }),
      expect.objectContaining({ id: "F27", implementationStatus: "protocol-only", controlMode: "not-running" }),
    ]));
    expect(protocolOnly).toHaveLength(2);
    expect(protocolOnly.every((item: any) => Object.values(item.effectiveHandlers as Record<string, unknown[]>).every((handlers) => handlers.length === 0))).toBe(true);
    expect(first.packages[0].knowledgeSnapshot.documents.map((item) => item.id)).toEqual(["d1", "d2"]);
    expect(first.packages.every((item) => item.evidence.every((evidence) => item.reasoning.some((entry) =>
      entry.status === "fact" && entry.sourceSpans?.some((span) => span.evidenceId === evidence.id),
    )))).toBe(true);
    expect(first.packages.every((item) => item.productionArtifacts?.finalImageAsset.status === "absent"
      && item.productionArtifacts.entrySnapshot.status === "absent"
      && item.productionArtifacts.deployment.status === "not_deployed"
      && item.productionArtifacts.finalAssetAlignment.status === "not_evaluated"
      && item.productionArtifacts.entrySnapshotAlignment.status === "not_evaluated")).toBe(true);
    expect(first.packages.every((item) => item.orchestrationSnapshot?.productionArtifacts?.schemaVersion === "1.0")).toBe(true);
    expect(first.packages.every((item) => item.orchestrationSnapshot?.opportunitySelectionAudit?.selectionMode === "default_policy"
      && item.orchestrationSnapshot.opportunitySelectionAudit.rankStatus === "not_applied"
      && item.orchestrationSnapshot.opportunitySelectionAudit.selectedOpportunityRank === undefined)).toBe(true);
  });

  it("persists the selected automatic opportunity rank in every orchestration snapshot", async () => {
    const metricSource = { source: "model_heuristic" as const, sourceRef: "analysis.opportunities" };
    const result = await new ContentGenerationAgent({ now: () => new Date("2026-07-13T01:00:00Z") }).generate({
      jobId: "ranked-planning-job",
      config: config(),
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      planningContext: {
        informationGaps: [{
          id: "fit",
          label: "适用条件",
          question: "哪些条件影响适用性？",
          category: "decision",
          audienceStages: ["comparing"],
          importance: 0.9,
          decisionLeverage: 0.9,
          proofability: 0.8,
          boundary: "个体适用性需要核验",
          evidenceIds: [],
          required: true,
        }],
        opportunities: [{
          id: "auto-topic",
          topic: "自动排序选题",
          angle: "先核验条件",
          gapIds: ["fit"],
          audienceStage: "comparing",
          entry: "search",
          relevance: 0.9,
          importance: 0.85,
          proofability: 0.8,
          novelty: 0.7,
          decisionLeverage: 0.9,
          cognitiveCost: 0.25,
          risk: 0.2,
          evidenceIds: [],
          boundaries: ["个体适用性需要核验"],
          tags: ["条件核验"],
          imageAssetIds: [],
          status: "eligible",
          rankInputSources: {
            metrics: {
              relevance: metricSource,
              importance: metricSource,
              proofability: metricSource,
              novelty: metricSource,
              decisionLeverage: metricSource,
              cognitiveCost: metricSource,
              risk: metricSource,
            },
            status: metricSource,
            topic: { source: "user", sourceRef: "task.theme" },
            gapIds: { source: "project", sourceRef: "information_gaps" },
          },
        }],
        recentCoverage: [],
        recentCoverageSource: { source: "observed", sourceRef: "coverage_records" },
      },
    });
    expect(result.packages.every((item) => item.orchestrationSnapshot?.opportunitySelectionAudit?.selectionMode === "heuristic_ranked"
      && item.orchestrationSnapshot.opportunitySelectionAudit.rankStatus === "applied"
      && item.orchestrationSnapshot.opportunitySelectionAudit.selectedOpportunityRank?.heuristic.id === "OpportunityRankHeuristicV1"
      && item.orchestrationSnapshot.opportunitySelectionAudit.selectedOpportunityRank?.effectiveEligibility === "eligible"
      && item.orchestrationSnapshot.opportunitySelectionAudit.selectedOpportunityRank?.finalScore !== null)).toBe(true);
  });

  it("passes candidate seed/model settings, caps repairs and fails closed when a provider ignores comment repairs", async () => {
    const calls: ModelGenerationRequest[] = [];
    const evidenceId = "evidence_task_project";
    const supportedFact = "资料中确认了产品要点";
    const validBody = `${supportedFact}。适用边界已经写明；适合谁、如何比较、哪些未知目前仍未知，请补充个人条件并按来源核实。先记录条件，再比较选择。`.repeat(2);
    const baseDraft = {
      content: {
        H: { hashtags: ["方案选择", "信息"] },
        N: { imageBrief: "信息清单封面", title: "先核实信息", body: supportedFact },
        Cref: {
          disclaimer: "评论区问答参考模板",
          threads: [0, 1, 2, 3].map((index) => ({ id: `t${index + 1}`, question: `第${index + 1}项怎么比较？`, answer: "按资料逐项核实。", followUps: [], postingIdentity: "author", sourceClusterIds: ["d1"], evidenceIds: [evidenceId] })),
        },
      },
      evidenceIds: [evidenceId],
      reasoning: [{
        statement: supportedFact,
        location: "N.body",
        occurrence: { field: "body" },
        status: "fact",
        evidenceIds: [evidenceId],
        sourceSpans: [{ evidenceId, quote: supportedFact }],
      }],
      unknowns: [],
    };
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        if (request.metadata?.purpose === "repair") return { text: JSON.stringify({ N: { body: validBody } }), raw: {} };
        if (String(request.metadata?.purpose) === "generate_comment_readers") return {
          text: JSON.stringify({ threads: stagedCommentThreads(request, "按资料逐项核实。") }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })) }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_comment_growth") return {
          text: JSON.stringify({ disclaimer: "评论区问答参考模板", threads: stagedCommentThreads(request, "按资料逐项核实。") }),
          raw: {},
        };
        return { text: JSON.stringify(baseDraft), raw: {} };
      },
    };
    const value = config();
    value.task.mustMention = ["适用边界"];
    value.content.bodyMinChars = 40;
    value.content.hashtagMin = 2;
    value.content.commentThreadMin = 1;
    value.generation.maxRepairAttempts = 2;
    value.task.forbidden = ["按资料逐项核实"];
    value.model.model = "provider-selected-model";
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T00:00:00Z") })
      .generate({ jobId: "repair-job", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [knowledge[0]!] });
    expect(calls.filter((item) => item.metadata?.purpose === "generate_core")).toHaveLength(3);
    // 按侧+按角色隔离后,评论读者侧调用取代原合并评论调用(purpose 更名)。
    expect(calls.filter((item) => item.metadata?.purpose === "generate_comment_readers")).toHaveLength(3);
    // Task 7.3: multi-turn comment growth (stage 2B) is opt-in and conservative by
    // default, so with the default config it never fires the extra LLM growth call.
    // The pipeline still produces valid root comments and fails closed as expected.
    expect(calls.filter((item) => item.metadata?.purpose === "generate_comment_growth")).toHaveLength(0);
    const repairCalls = calls.filter((item) => item.metadata?.purpose === "repair");
    expect(repairCalls.length).toBeGreaterThanOrEqual(3);
    expect(repairCalls.length).toBeLessThanOrEqual(6);
    expect(calls.every((item) => item.model === "provider-selected-model")).toBe(true);
    expect(result.packages.every((item) => item.validation.repairAttempts === 2)).toBe(true);
    expect(result.packages.every((item) => item.validation.valid === false
      && item.validation.issues.some((issue) => issue.code === "forbidden_phrase"))).toBe(true);
  });

  it("fails closed when one initial model request fails instead of returning a publishable fallback", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        if (request.metadata?.candidateIndex === 1) throw new Error("temporary upstream failure");
        if (String(request.metadata?.purpose) === "generate_comment_readers") return {
          text: JSON.stringify({
            threads: stagedCommentThreads(request, "先确认问题类型，再核实适用边界。"),
          }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "先确认问题类型，再核实适用边界。" })) }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_comment_growth") return {
          text: JSON.stringify({
            disclaimer: "多角色情景演练参考模板",
            threads: stagedCommentThreads(request, "先确认问题类型，再核实适用边界。"),
          }),
          raw: {},
        };
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["信息核验", "方案选择"] },
              N: { imageBrief: "核验清单", title: "先核实再决定", body: "资料中确认了产品要点。具体适用条件仍需核实。" },
              Cref: {
                disclaimer: "多角色情景演练参考模板",
                threads: [0, 1, 2, 3].map((index) => ({ id: `t${index + 1}`, question: `第${index + 1}项先核实什么？`, answer: "先确认问题类型，再核实适用边界。", followUps: [], postingIdentity: "author", sourceClusterIds: [], evidenceIds: [] })),
              },
            },
            evidenceIds: [],
            reasoning: [],
            unknowns: [],
          }),
          raw: {},
        };
      },
    };
    const value = config();
    value.generation.maxRepairAttempts = 0;

    // 本测试守的是"不拿机械兜底稿冒充模型产出",不是"必须整单失败"。原实现挂一
    // 个候选就废整单,连另外两个真实跑通的候选(各 6+ 次模型调用)一起丢——实测
    // 87 个失败任务落库包数均为 0。现在交付真实候选、失败候选记因,兜底稿仍然
    // 不得出现,这条约束在下面正面断言。
    const result = await new ContentGenerationAgent({ modelProvider: provider })
      .generate({ jobId: "partial-provider-failure", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    expect(result.packages).toHaveLength(2);
    expect(result.packages.map((item) => item.candidateIndex)).toEqual([0, 2]);
    expect(result.degradedCandidates).toEqual([
      { candidateIndex: 1, reason: expect.stringContaining("temporary upstream failure") },
    ]);
    // 交付的必须是模型产出:失败候选的序号不出现,且没有候选退化成确定性兜底稿。
    expect(result.packages.every((item) => item.content.N.title === "先核实再决定")).toBe(true);
  });

  it("三个候选全失败时仍然整单失败,不吐兜底稿", async () => {
    const provider: ModelProvider = { async generate() { throw new Error("temporary upstream failure"); } };
    const value = config();
    value.generation.maxRepairAttempts = 0;
    await expect(new ContentGenerationAgent({ modelProvider: provider })
      .generate({ jobId: "all-candidates-failed", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge }))
      .rejects.toThrow(/三个模型候选全部生成失败.*未生成可发布降级稿/u);
  });

  it("revises only the selected candidate and preserves unaffected channels", async () => {
    const engine = new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") });
    const generated = await engine.generate({ jobId: "rev-job", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const original = generated.packages[0];
    const changedKnowledge = [
      knowledge[0]!,
      indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n知识内容已经更新，旧结论不能沿用。" }),
    ];
    const result = await engine.revise({ package: original, instruction: "标题更短一点", formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: changedKnowledge });
    expect(result.dependency.rerunChannels).toEqual(["N.title"]);
    expect(result.package.content.N.body).toBe(original.content.N.body);
    expect(result.package.content.Cref).toEqual(original.content.Cref);
    expect(result.package.revisions).toHaveLength(1);
    expect(result.package.knowledgeSnapshot.documents.find((item) => item.id === "d2")?.checksum)
      .toBe(changedKnowledge[1]!.checksum);
    expect(result.package.knowledgeSnapshot.sectionIds).not.toEqual(original.knowledgeSnapshot.sectionIds);
    expect(generated.packages[1].revisions).toHaveLength(0);
  });

  it("rejects formula-version drift before model calls", async () => {
    const value = config();
    value.formula.versionId = "other";
    await expect(new ContentGenerationAgent().generate({ jobId: "bad", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge })).rejects.toThrow(/does not match/u);
  });

  it("consumes the selected topic, image analysis and three distinct orchestration plans", async () => {
    const calls: ModelGenerationRequest[] = [];
    const approvedImageAnalyses = [{
      assetId: "img1",
      imageUrl: "https://example.test/image.png",
      observedFacts: ["图片中有核验清单"],
      inferredSignals: ["可能是咨询场景"],
      unknowns: ["拍摄时间未知"],
      visibleText: ["核验清单"],
      roles: ["evidence" as const],
      quality: { clarity: 0.9, relevance: 0.9, textLegibility: 0.8 },
      safetyFlags: [],
      evidenceIds: ["evidence_d1"],
      source: "uploaded" as const,
    }];
    const longBody = "正文明确说明适用边界，并把已知、未知和需要核验的信息分开。".repeat(10);
    const provider: ModelProvider = {
      async generate(request) {
        calls.push(request);
        if (String(request.metadata?.purpose) === "generate_comment_readers") return {
          text: JSON.stringify({
            threads: stagedCommentThreads(request, "按资料来源逐项核验。"),
          }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料来源逐项核验。" })) }),
          raw: {},
        };
        if (String(request.metadata?.purpose) === "generate_comment_growth") return {
          text: JSON.stringify({
            disclaimer: "以下为评论区问答参考模板，不代表真实用户发言。",
            threads: stagedCommentThreads(request, "按资料来源逐项核验。"),
          }),
          raw: {},
        };
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["指定选题", "信息补全", "比较方法"] },
              N: { imageBrief: "按上传图片制作核验清单", title: "指定选题先核验", body: longBody },
              Cref: {
                disclaimer: "以下为评论区问答参考模板，不代表真实用户发言。",
                threads: [0, 1].map((index) => ({
                  id: `t${index}`,
                  stage: "比较方案",
                  gap: "fit",
                  function: "verification",
                  question: "哪些条件需要核验？",
                  answer: "按资料来源逐项核验。",
                  followUps: [],
                  nextStep: "记录自己的条件。",
                  postingIdentity: "author",
                  sourceClusterIds: ["d1"],
                  evidenceIds: ["evidence_d1"],
                })),
              },
            },
            evidenceIds: ["evidence_d1"],
            reasoning: [{ statement: "使用项目资料", status: "fact", evidenceIds: ["evidence_d1"] }],
            unknowns: [],
          }),
          raw: {},
        };
      },
    };
    const value = config();
    value.content.bodyMinChars = 20;
    value.content.commentThreadMin = 2;
    value.generation.maxRepairAttempts = 0;
    // Task 7.3: explicitly opt in to the multi-turn comment growth pass (stage 2B)
    // so this integration test still exercises the full staged flow (core +
    // comments + growth + ledger) per candidate.
    value.content.commentMultiTurnGrowthEnabled = true;
    const engine = new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-13T00:00:00Z") });
    const result = await engine.generate({
      jobId: "planned-job",
      config: value,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      planningContext: {
        selectedOpportunityId: "selected-topic",
        informationGaps: [{
          id: "fit",
          label: "适用条件",
          question: "哪些条件影响适用性？",
          category: "decision",
          audienceStages: ["comparing"],
          importance: 0.9,
          decisionLeverage: 0.9,
          proofability: 0.8,
          boundary: "个体适用性需要核验",
          evidenceIds: ["evidence_d1"],
          required: true,
        }],
        opportunities: [{
          id: "selected-topic",
          topic: "指定选题",
          angle: "先核验再选择",
          gapIds: ["fit"],
          audienceStage: "comparing",
          entry: "search",
          relevance: 1,
          importance: 0.9,
          proofability: 0.8,
          novelty: 0.6,
          decisionLeverage: 0.9,
          cognitiveCost: 0.3,
          risk: 0.2,
          evidenceIds: ["evidence_d1"],
          boundaries: ["个体适用性需要核验"],
          tags: ["比较方法"],
          imageAssetIds: ["img1"],
          status: "eligible",
        }],
        imageAnalyses: approvedImageAnalyses,
      },
    });
    // 身份已在规划期冻结，每候选 5 次阶段调用：core + comment_readers(2A-R)
    // + org_answers(2A-O，本测试线程同一身份，1 次) + comment_growth(2B) + ledger。
    // 不再存在 assign_reply_identities 二次映射调用。
    expect(calls).toHaveLength(15);
    expect(calls.filter((item) => item.metadata?.purpose === "assign_reply_identities")).toHaveLength(0);
    expect(calls.filter((item) => item.metadata?.purpose === "generate_comment_readers")).toHaveLength(3);
    expect(calls.filter((item) => item.metadata?.purpose === "generate_org_answers")).toHaveLength(3);
    expect(calls.filter((item) => item.metadata?.purpose === "generate_comment_growth")).toHaveLength(3);
    const promptTextOf = (call: ModelGenerationRequest): string => {
      const content = call.messages[1]!.content;
      return Array.isArray(content) ? content.find((part) => part.type === "text")?.text ?? "" : content;
    };
    const fullContractCalls = calls.filter((call) => ["generate_core", "generate_ledger"].includes(String(call.metadata?.purpose)));
    const isolatedCalls = calls.filter((call) => ["generate_comment_readers", "generate_org_answers", "generate_comment_growth"].includes(String(call.metadata?.purpose)));
    // stage1/stage3 仍注入全量生产合同(含图片);按侧隔离的评论调用只带精简
    // 上下文——不含编排元信息,也不再随附图片(图片只影响 stage1 图文)。
    for (const call of fullContractCalls) expect(Array.isArray(call.messages[1]!.content)).toBe(true);
    expect(fullContractCalls.map(promptTextOf).every((text) => text.includes("指定选题") && text.includes("orchestrationPlan"))).toBe(true);
    expect(fullContractCalls.map(promptTextOf).every((text) => text.includes("image-analysis:img1") && text.includes("inferredSignals and unknowns are not factual evidence"))).toBe(true);
    expect(isolatedCalls.map(promptTextOf).every((text) => !text.includes("orchestrationPlan") && !text.includes("image-analysis:img1"))).toBe(true);
    // 读者侧上下文含任务基本信息(主题);机构侧上下文含本角色身份卡(项目名)。
    const readerSideCalls = calls.filter((call) => ["generate_comment_readers", "generate_comment_growth"].includes(String(call.metadata?.purpose)));
    expect(readerSideCalls.map(promptTextOf).every((text) => text.includes("方案选择"))).toBe(true);
    expect(calls.filter((call) => call.metadata?.purpose === "generate_org_answers").map(promptTextOf).every((text) => text.includes("测试项目"))).toBe(true);
    expect(new Set(result.packages.map((item) => item.orchestrationSnapshot?.strategy.id)).size).toBe(3);
    expect(result.packages.every((item) => item.orchestrationSnapshot?.opportunitySelectionAudit?.selectionMode === "explicit_locked"
      && item.orchestrationSnapshot.opportunitySelectionAudit.rankStatus === "not_applied"
      && item.orchestrationSnapshot.opportunitySelectionAudit.approvalBasis === "approved_dependency"
      && item.orchestrationSnapshot.opportunitySelectionAudit.selectedOpportunityRank === undefined)).toBe(true);
    expect(new Set(result.packages.map((item) => item.coverageSignature?.fingerprint)).size).toBe(3);
    expect(result.packages.every((item) => item.imagePlan?.sourceAssetId === "img1" && item.imagePlan?.primaryAssetId === "img1")).toBe(true);
    expect(result.packages.every((item) => item.productionArtifacts?.imageObservation.status === "approved"
      && item.productionArtifacts.imageObservation.analysisAssetIds.includes("img1")
      && item.productionArtifacts.finalImageAsset.status === "absent"
      && item.productionArtifacts.entrySnapshot.status === "absent"
      && item.productionArtifacts.deployment.status === "not_deployed")).toBe(true);
    expect(result.packages.every((item) => item.dialogueThreads?.[0]?.postingIdentity === "publisher")).toBe(true);
    expect(result.packages.every((item) => item.dialogueThreads?.every((thread) => thread.roleCard.stage === thread.stage && Object.values(thread.replyPlan).every(Boolean)))).toBe(true);
    expect(result.packages.every((item) => item.content.Cref.threads.every((thread) => Boolean(thread.roleCard && thread.replyPlan && thread.primaryGapId)))).toBe(true);
    expect(result.packages.every((item) => item.content.Cref.threads.every((thread) => thread.followUps.length <= 2))).toBe(true);
    expect(result.packages.some((item) => item.content.Cref.threads.some((thread) => thread.followUps.length === 0))).toBe(true);
    // 按侧+按角色隔离:T1 答复来自机构调用,T2 来自读者侧(同一 mock 文案);
    // T3 漂浮短反应的 answer 由合并层确定性置空(旧流程由模型一次写全部,
    // mock 文案会覆盖 T3;新流程 T3 恒空是设计语义)。
    expect(result.packages.every((item) => item.content.Cref.threads.every((thread) =>
      (thread.threadKind ?? "org_answer") === "organic_reaction"
        ? thread.answer === ""
        : thread.answer === "按资料来源逐项核验。"))).toBe(true);
    expect(result.packages.every((item) => item.content.Cref.threads.every((thread) => !/直接回答\s*[：:]|NextQuestion\s*[：:]/u.test(thread.answer)))).toBe(true);
    expect(result.packages.every((item) => item.content.Cref.threads.every((thread) => !thread.question.includes("…")))).toBe(true);
    // 缺口边界流入 stage1/stage3 全量上下文(task_data)与机构侧逐 gap 口径;
    // 读者侧精简上下文按设计不含边界口径。机构调用的口径在线程清单(messages[3]),
    // 这里按提示词全文判定。
    const fullTextOf = (call: ModelGenerationRequest): string => call.messages.map((message) => {
      const content = message.content;
      return Array.isArray(content) ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n") : content;
    }).join("\n");
    expect([...fullContractCalls, ...calls.filter((call) => call.metadata?.purpose === "generate_org_answers")]
      .map(fullTextOf).every((text) => text.includes("个体适用性需要核验"))).toBe(true);

    const revised = await engine.revise({
      package: result.packages[0],
      instruction: "把封面图片改成另一种核验思路",
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      imageAnalyses: approvedImageAnalyses,
    });
    expect(revised.dependency.rerunChannels).toEqual(["N.imageBrief", "N.title", "N.body", "Cref"]);
    expect(revised.package.productionArtifacts).toMatchObject({
      imageObservation: { status: "approved", sourceAssetId: "img1", analysisAssetIds: ["img1"] },
      finalImageAsset: { status: "absent" },
      entrySnapshot: { status: "absent" },
      deployment: { status: "not_deployed" },
    });
    expect(revised.package.orchestrationSnapshot?.opportunitySelectionAudit).toMatchObject({
      selectionMode: "explicit_locked",
      rankStatus: "not_applied",
      approvalBasis: "approved_dependency",
    });
    const revisionCall = calls.at(-1)!;
    expect(revisionCall.metadata?.purpose).toBe("revision");
    const revisionContent = revisionCall.messages[1]!.content;
    const revisionText = Array.isArray(revisionContent)
      ? revisionContent.find((part) => part.type === "text")?.text ?? ""
      : revisionContent;
    expect(revisionText).toContain("图片中有核验清单");
    expect(revisionText).toContain("image-analysis:img1");
    expect(Array.isArray(revisionContent) && revisionContent.some((part) => part.type === "image_url")).toBe(true);
  });

  /**
   * 生长阶段(2.2)因中继/上游不可用而失败时,followUps 必然为空,于是
   * comment_network_under_grown 也必然触发 —— 但它的措辞("是否漏掉了可接的话
   * 头")把一次基础设施故障说成内容质量问题。生产实测(job 4ee471e2 候选 0/2)两
   * 条 warning 成对出现,真因只有 model_comment_growth_failed 那条。
   *
   * 抑制只针对欠生长:生长调用失败不可能导致超额,故 over_grown 不受影响。
   */
  it("生长调用失败时抑制欠生长告警,只保留真因", async () => {
    const growthOutcomes: Array<"fail" | "ok"> = ["fail", "ok", "fail"];
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comment_growth") {
          const candidateIndex = Number(request.metadata?.candidateIndex ?? 0);
          if (growthOutcomes[candidateIndex] === "fail") {
            throw new Error("读取响应失败: error decoding response body");
          }
          return {
            text: JSON.stringify({ disclaimer: "评论区问答参考模板", threads: stagedCommentThreads(request, "按资料逐项核实。") }),
            raw: {},
          };
        }
        if (purpose === "generate_comment_readers") return {
          text: JSON.stringify({ threads: stagedCommentThreads(request, "按资料逐项核实。") }),
          raw: {},
        };
        if (purpose === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })) }),
          raw: {},
        };
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["信息补全", "比较方法"] },
              N: {
                imageBrief: "核验清单",
                title: "先核验再选择",
                body: "正文明确说明适用边界，并把已知、未知和需要核验的信息分开。".repeat(10),
              },
              Cref: {
                disclaimer: "以下为评论区问答参考模板，不代表真实用户发言。",
                threads: [0, 1].map((index) => ({
                  id: `t${index}`,
                  stage: "比较方案",
                  gap: "fit",
                  function: "verification",
                  question: "哪些条件需要核验？",
                  answer: "按资料逐项核实。",
                  followUps: [],
                  nextStep: "记录自己的条件。",
                  postingIdentity: "author",
                  sourceClusterIds: ["d1"],
                  evidenceIds: ["evidence_d1"],
                })),
              },
            },
            evidenceIds: ["evidence_d1"],
            reasoning: [{ statement: "使用项目资料", status: "fact", evidenceIds: ["evidence_d1"] }],
            unknowns: [],
          }),
          raw: {},
        };
      },
    };
    const value = config();
    value.content.bodyMinChars = 20;
    value.content.commentThreadMin = 2;
    value.generation.maxRepairAttempts = 0;
    value.content.commentMultiTurnGrowthEnabled = true;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-25T00:00:00Z") })
      .generate({ jobId: "growth-failure-job", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [knowledge[0]!] });
    const codesOf = (index: number) => result.packages[index]!.validation.issues.map((issue) => issue.code);
    for (const failedIndex of [0, 2]) {
      const codes = codesOf(failedIndex);
      // 真因保留,如实报告基础设施故障。
      expect(codes).toContain("model_comment_growth_failed");
      // 误导性的内容判断被抑制。
      expect(codes).not.toContain("comment_network_under_grown");
    }
    // 生长成功的候选完全不受影响:抑制条件不成立,分布告警照常按内容判定。
    expect(codesOf(1)).not.toContain("model_comment_growth_failed");
  });

  /**
   * 台账阶段失败是 warning,不是 error。
   *
   * 定级依据(实测 217 个包):台账失败**不导致台账缺失**——126/126 个失败包的
   * reasoning 均非空(catch 保留前序阶段产出),它降低的是事实锚定率(人均 fact
   * 0.8 → 0.2)。这是质量削弱而非内容失效。同类阶段失败(判官/机构答复/评论生长)
   * 全是 warning,只有台账判 error,导致中继一抖动 quality_status 就归零:实测
   * 18 篇产出零 passed 全由这一条决定,质量信号失去区分度。
   */
  it("台账阶段失败记 warning 并保留可见文案，不把整篇判为无效", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_ledger") throw new Error("读取响应失败: error decoding response body");
        if (purpose === "generate_comment_readers") return {
          text: JSON.stringify({ threads: stagedCommentThreads(request, "按资料逐项核实。") }),
          raw: {},
        };
        if (purpose === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })) }),
          raw: {},
        };
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["信息补全", "比较方法"] },
              N: {
                imageBrief: "核验清单",
                title: "先核验再选择",
                body: "正文明确说明适用边界，并把已知、未知和需要核验的信息分开。".repeat(8),
              },
              Cref: {
                disclaimer: "以下为评论区问答参考模板，不代表真实用户发言。",
                threads: [0, 1].map((index) => ({
                  id: `t${index}`,
                  stage: "比较方案",
                  gap: "fit",
                  function: "verification",
                  question: "哪些条件需要核验？",
                  answer: "按资料逐项核实。",
                  followUps: [],
                  nextStep: "记录自己的条件。",
                  postingIdentity: "author",
                  sourceClusterIds: ["d1"],
                  evidenceIds: ["evidence_d1"],
                })),
              },
            },
            evidenceIds: ["evidence_d1"],
            reasoning: [{ statement: "使用项目资料", status: "fact", evidenceIds: ["evidence_d1"] }],
            unknowns: [],
          }),
          raw: {},
        };
      },
    };
    const value = config();
    value.content.bodyMinChars = 20;
    value.content.commentThreadMin = 2;
    value.generation.maxRepairAttempts = 0;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-26T00:00:00Z") })
      .generate({ jobId: "ledger-failure-job", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [knowledge[0]!] });
    const ledgerIssues = result.packages.flatMap((item) =>
      item.validation.issues.filter((issue) => issue.code === "model_ledger_failed"));
    expect(ledgerIssues.length).toBeGreaterThan(0);
    // 与同类阶段失败一致:warning、不可 repair。
    expect(ledgerIssues.every((issue) => issue.severity === "warning" && issue.repairable === false)).toBe(true);
    // 文案要点明后果(锚定不完整),而不是只说"失败"。
    expect(ledgerIssues[0]!.message).toContain("事实锚定");
    // 可见文案完整保留,台账失败不再让候选整体无效。
    expect(result.packages.every((item) => item.content.N.body.length > 0)).toBe(true);
    expect(result.packages.every((item) => item.content.Cref.threads.length >= 2)).toBe(true);
  });

  /**
   * 判官失效必须留下信号。生产实测:174 个包 claimJudgments 全为 0、60 个包报出
   * sensitive_claim_without_evidence,却没有任何 issue 指向判官——受控声明是按
   * 语义裁决还是按裸词面判定,从产物上完全看不出来。
   */
  it("判官调用失败时在校验结果里留下 model_claim_judge_failed", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "claim_judge") throw new Error("读取响应失败: error decoding response body");
        if (purpose === "generate_comment_readers") return {
          text: JSON.stringify({ threads: stagedCommentThreads(request, "按资料逐项核实。") }),
          raw: {},
        };
        if (purpose === "generate_org_answers") return {
          text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })) }),
          raw: {},
        };
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["信息补全", "比较方法"] },
              N: {
                imageBrief: "核验清单",
                title: "先核验再选择",
                // 带数字的受控声明:走 genericMeasuredClaim,正是判官的输入。
                body: `消肿一般7天左右，具体以面诊为准。${"正文明确说明适用边界，并把已知、未知和需要核验的信息分开。".repeat(8)}`,
              },
              Cref: {
                disclaimer: "以下为评论区问答参考模板，不代表真实用户发言。",
                threads: [0, 1].map((index) => ({
                  id: `t${index}`,
                  stage: "比较方案",
                  gap: "fit",
                  function: "verification",
                  question: "哪些条件需要核验？",
                  answer: "按资料逐项核实。",
                  followUps: [],
                  nextStep: "记录自己的条件。",
                  postingIdentity: "author",
                  sourceClusterIds: ["d1"],
                  evidenceIds: ["evidence_d1"],
                })),
              },
            },
            evidenceIds: ["evidence_d1"],
            reasoning: [{ statement: "使用项目资料", status: "fact", evidenceIds: ["evidence_d1"] }],
            unknowns: [],
          }),
          raw: {},
        };
      },
    };
    const value = config();
    value.content.bodyMinChars = 20;
    value.content.commentThreadMin = 2;
    value.generation.maxRepairAttempts = 0;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-25T00:00:00Z") })
      .generate({ jobId: "judge-failure-job", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [knowledge[0]!] });
    const failures = result.packages.flatMap((item) =>
      item.validation.issues.filter((issue) => issue.code === "model_claim_judge_failed"));
    expect(failures.length).toBeGreaterThan(0);
    // 只补信号,不升级严重度:判官失效不阻断发布。
    expect(failures.every((issue) => issue.severity === "warning" && issue.repairable === false)).toBe(true);
    expect(failures[0]!.message).toContain("error decoding response body");
    // 每候选只记一条,不随重试次数堆叠。
    for (const item of result.packages) {
      expect(item.validation.issues.filter((issue) => issue.code === "model_claim_judge_failed").length).toBeLessThanOrEqual(1);
    }
  });
});
