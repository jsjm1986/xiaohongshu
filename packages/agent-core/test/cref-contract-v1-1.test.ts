import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  buildRepairPrompt,
  buildStagedCommentsPrompt,
  buildStagedLedgerPrompt,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  parseGenerationDraft,
  parseStagedCommentCopy,
  PROMPT_CONTRACT_VERSION,
  selectKnowledgeContext,
  STAGED_COMMENTS_JSON_SCHEMA,
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

/** A pre-v1.1 (historical) draft shape: no kind/answerKind/boundary/ownedFirstComment anywhere. */
function legacyDraftJson() {
  return {
    content: {
      H: { hashtags: ["#信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body: "这是有依据且保留边界的正文内容，帮助读者补全信息。" },
      Cref: {
        disclaimer: "评论区问答参考模板",
        threads: [{
          id: "t1",
          question: "怎么判断？",
          answer: "先核实条件。",
          followUps: [{ question: "还能怎么核验？", answer: "查看来源。", evidenceIds: [] }],
          postingIdentity: "author",
          sourceClusterIds: ["d1"],
          evidenceIds: ["evidence_d1"],
        }],
      },
    },
    evidenceIds: ["evidence_d1"],
    reasoning: [{ statement: "这是一条事实", status: "fact", evidenceIds: ["evidence_d1"] }],
    unknowns: [],
  };
}

function stagedThreadSkeletons(request: ModelGenerationRequest) {
  const content = request.messages[1]!.content;
  const text = Array.isArray(content) ? content.find((part) => part.type === "text")?.text ?? "" : content;
  const match = text.match(/<task_data>\s*([\s\S]*?)\s*<\/task_data>/u);
  const taskData = match ? JSON.parse(match[1]!) : {};
  return (taskData.orchestrationPlan?.dialogueThreads ?? []).map((thread: { id: string }, index: number) => ({
    id: thread.id,
    roleIndex: index % Math.max(1, taskData.orchestrationPlan?.personaScenePlan?.commentCast?.length ?? 1),
    question: `第${index + 1}项应该核实什么？`,
    answer: "按资料逐项核实。",
    followUps: [] as Array<Record<string, unknown>>,
  }));
}

describe("Cref contract v1.1 binding", () => {
  it("derives positional kinds, binds the replyPlan boundary and projects uncoveredGaps", async () => {
    const result = await new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "cref-v1-1-deterministic", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    expect(result.packages).toHaveLength(3);
    for (const pkg of result.packages) {
      expect(pkg.schemaVersion).toBe("1.1");
      // The deterministic draft now assembles a publisher-owned first comment
      // from the first two thread Q&As; it stays visible copy with no
      // internal vocabulary.
      const owned = pkg.content.Cref.ownedFirstComment;
      expect(owned).toBeDefined();
      expect(owned).toContain("以上为常见问题整理，具体情况以当面评估为准");
      expect(owned).not.toMatch(/evidence_|sourceCluster|replyPlan|discoveryPlan|本线程/u);
      const plannedById = new Map((pkg.dialogueThreads ?? []).map((thread) => [thread.id, thread]));
      for (const thread of pkg.content.Cref.threads) {
        expect(thread.kind).toBe("question");
        expect(thread.answerKind).toBe("answer");
        expect(thread.postingIdentity).toBe("publisher");
        const planned = plannedById.get(thread.id);
        expect(planned).toBeDefined();
        // The demo states the planned reply boundary directly; bind keeps it.
        expect(thread.boundary).toBe(planned!.replyPlan.boundary);
        for (const followUp of thread.followUps) {
          expect(followUp.kind).toBe("follow_up");
        }
      }
      // Same projection the engine must apply: selected gap cards not covered by any
      // dialogue thread (primary or auxiliary) and not planned for N.body.
      const plan = pkg.orchestrationSnapshot!;
      const covered = new Set(plan.dialogueThreads.flatMap((thread) => [thread.primaryGapId, ...thread.auxiliaryGapIds]));
      const expected = (plan.gapPlanningCards ?? [])
        .filter((card) => !covered.has(card.gapId) && !card.plannedPlacements.includes("N.body"))
        .map((card) => card.gapId);
      expect(pkg.content.Cref.uncoveredGaps).toEqual(expected);
    }
  });

  it("demo end-to-end: publisher identity, derived kinds and a clean owned first comment", async () => {
    const result = await new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "cref-v1-1-demo-identity", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    for (const pkg of result.packages) {
      expect(pkg.content.Cref.threads.length).toBeGreaterThan(0);
      for (const thread of pkg.content.Cref.threads) {
        expect(thread.postingIdentity).toBe("publisher");
        expect(thread.kind).toBe("question");
        expect(thread.answerKind).toBe("answer");
        expect(thread.speakerType).toBe("simulated_reader");
        expect(thread.simulated).toBe(true);
        for (const followUp of thread.followUps) {
          expect(followUp.kind).toBe("follow_up");
        }
      }
      const owned = pkg.content.Cref.ownedFirstComment ?? "";
      expect(owned.startsWith("常见问题整理")).toBe(true);
      expect(owned).toContain("以上为常见问题整理，具体情况以当面评估为准");
      expect(owned).not.toMatch(/evidence_|sourceCluster|replyPlan|discoveryPlan|本线程|核验路径|资料未覆盖/u);
    }
  });

  it("keeps model-stated kind/boundary/ownedFirstComment in the staged flow and derives the rest", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comments") {
          const threads = stagedThreadSkeletons(request).map((thread, index) => ({
            ...thread,
            // Only the first thread states the v1.1 fields; the rest omit them
            // so the engine must apply the positional/planned defaults.
            ...(index === 0 ? { kind: "follow_up", answerKind: "clarification", boundary: "模特声明的边界" } : {}),
          }));
          return {
            text: JSON.stringify({
              disclaimer: "评论区问答参考模板",
              ownedFirstComment: "置顶：价格以当期为准，详见 evidence_d1。",
              threads,
            }),
            raw: {},
          };
        }
        if (purpose === "generate_comment_growth") {
          const threads = stagedThreadSkeletons(request).map((thread) => ({
            ...thread,
            followUps: [
              { question: "那这个呢？", answer: "也要核实。", kind: "clarification", boundary: "追问边界" },
              { question: "还有别的吗？", answer: "先按来源核对。" },
            ],
          }));
          return { text: JSON.stringify({ disclaimer: "评论区问答参考模板", threads }), raw: {} };
        }
        if (purpose === "generate_ledger") {
          return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        }
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["方案选择", "信息", "核验"] },
              N: {
                imageBrief: "信息清单封面",
                title: "先核实信息",
                body: "资料中确认了产品要点。适用边界已经写明，个体差异仍需核验。资料中确认了产品要点，个体差异仍需核验。",
              },
              Cref: { disclaimer: "评论区问答参考模板", threads: [] },
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
    value.content.commentThreadMin = 1;
    value.content.commentThreadMax = 1;
    value.content.commentMultiTurnGrowthEnabled = true;
    value.generation.maxRepairAttempts = 0;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "cref-v1-1-staged", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    for (const pkg of result.packages) {
      const threads = pkg.content.Cref.threads;
      expect(threads.length).toBeGreaterThanOrEqual(1);
      const first = threads[0]!;
      // Model-stated values win over both positional defaults and replyPlan.boundary.
      expect(first.kind).toBe("follow_up");
      expect(first.answerKind).toBe("clarification");
      expect(first.boundary).toBe("模特声明的边界");
      // Owned first comment is kept, cleaned like any other visible copy.
      expect(pkg.content.Cref.ownedFirstComment).toBe("置顶：价格以当期为准，详见 资料原文。");
      for (const [threadIndex, thread] of threads.entries()) {
        if (threadIndex > 0) {
          const planned = (pkg.dialogueThreads ?? []).find((candidate) => candidate.id === thread.id);
          expect(thread.kind).toBe("question");
          expect(thread.answerKind).toBe("answer");
          expect(thread.boundary).toBe(planned?.replyPlan.boundary);
        }
        for (const [followUpIndex, followUp] of thread.followUps.entries()) {
          if (followUpIndex === 0) {
            expect(followUp.kind).toBe("clarification");
            expect(followUp.boundary).toBe("追问边界");
          } else {
            // Kind omitted by the model: positional default; no boundary invented.
            expect(followUp.kind).toBe("follow_up");
            expect(followUp.boundary).toBeUndefined();
          }
        }
      }
      // The single-thread plan leaves budget for both grown follow-ups on thread 0.
      expect(first.followUps).toHaveLength(2);
    }
  });

  it("keeps a legal model-stated function and silently falls back on illegal or absent ones (P3-15)", async () => {
    const provider: ModelProvider = {
      async generate(request) {
        const purpose = String(request.metadata?.purpose);
        if (purpose === "generate_comments") {
          const threads = stagedThreadSkeletons(request).map((thread, index) => ({
            ...thread,
            // Thread 0 states a legal function; thread 1 states an illegal one
            // (parses as absent); thread 2 omits it entirely.
            ...(index === 0 ? { function: "counterexample" } : {}),
            ...(index === 1 ? { function: "opinion" } : {}),
          }));
          return {
            text: JSON.stringify({ disclaimer: "评论区问答参考模板", threads }),
            raw: {},
          };
        }
        if (purpose === "generate_ledger") {
          return { text: JSON.stringify({ evidenceIds: [], reasoning: [], unknowns: [] }), raw: {} };
        }
        return {
          text: JSON.stringify({
            content: {
              H: { hashtags: ["方案选择", "信息", "核验"] },
              N: {
                imageBrief: "信息清单封面",
                title: "先核实信息",
                body: "资料中确认了产品要点。适用边界已经写明，个体差异仍需核验。资料中确认了产品要点，个体差异仍需核验。",
              },
              Cref: { disclaimer: "评论区问答参考模板", threads: [] },
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
    value.content.commentThreadMin = 3;
    value.content.commentThreadMax = 3;
    value.generation.maxRepairAttempts = 0;
    const result = await new ContentGenerationAgent({ modelProvider: provider, now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "cref-v1-1-function", config: value, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    for (const pkg of result.packages) {
      const threads = pkg.content.Cref.threads;
      expect(threads.length).toBeGreaterThanOrEqual(3);
      const plannedById = new Map((pkg.dialogueThreads ?? []).map((thread) => [thread.id, thread]));
      // Legal model value wins over the content-derived planning fallback…
      expect(threads[0]!.function).toBe("counterexample");
      // …while an illegal value and an omitted one both fall back to the plan.
      expect(threads[1]!.function).toBe(plannedById.get(threads[1]!.id)!.function);
      expect(threads[1]!.function).not.toBe("opinion");
      expect(threads[2]!.function).toBe(plannedById.get(threads[2]!.id)!.function);
    }
  });
});

describe("Cref contract v1.1 parse compatibility", () => {
  it("parses historical packages (no v1.1 fields) with the new fields absent, never backfilled", () => {
    const draft = parseGenerationDraft(JSON.stringify(legacyDraftJson()));
    const thread = draft.content.Cref.threads[0]!;
    expect(thread.kind).toBeUndefined();
    expect(thread.answerKind).toBeUndefined();
    expect(thread.boundary).toBeUndefined();
    expect(thread.followUps[0]!.kind).toBeUndefined();
    expect(thread.followUps[0]!.boundary).toBeUndefined();
    expect(draft.content.Cref.ownedFirstComment).toBeUndefined();
    expect(draft.content.Cref.uncoveredGaps).toBeUndefined();
  });

  it("round-trips v1.1 fields including the publisher posting identity", () => {
    const value = legacyDraftJson();
    value.content.Cref.ownedFirstComment = "置顶：先核实适用条件。";
    Object.assign(value.content.Cref.threads[0]!, {
      kind: "question",
      answerKind: "answer",
      boundary: "不代填个人情况",
      postingIdentity: "publisher",
    });
    Object.assign(value.content.Cref.threads[0]!.followUps[0]!, { kind: "follow_up", boundary: "追问边界" });
    const draft = parseGenerationDraft(JSON.stringify(value));
    const thread = draft.content.Cref.threads[0]!;
    expect(thread.postingIdentity).toBe("publisher");
    expect(thread.kind).toBe("question");
    expect(thread.answerKind).toBe("answer");
    expect(thread.boundary).toBe("不代填个人情况");
    expect(thread.followUps[0]).toMatchObject({ kind: "follow_up", boundary: "追问边界" });
    expect(draft.content.Cref.ownedFirstComment).toBe("置顶：先核实适用条件。");
  });

  it("carries v1.1 fields through the staged comment parser and treats invalid ones as absent", () => {
    const parsed = parseStagedCommentCopy(JSON.stringify({
      disclaimer: "参考模板",
      ownedFirstComment: "置顶：先核实适用条件。",
      threads: [{
        id: "t1",
        question: "怎么判断？",
        answer: "先核实。",
        kind: "opinion",
        boundary: 7,
        function: "verification",
        followUps: [{ question: "追问？", answer: "澄清。", kind: "follow_up" }],
      }, {
        id: "t2",
        question: "还比较什么？",
        answer: "按维度比。",
        function: "opinion",
        followUps: [],
      }],
    }));
    expect(parsed.ownedFirstComment).toBe("置顶：先核实适用条件。");
    // An unrecognised kind or non-string boundary means "not recorded", never an error.
    expect(parsed.threads[0]!.kind).toBeUndefined();
    expect(parsed.threads[0]!.boundary).toBeUndefined();
    expect(parsed.threads[0]!.followUps[0]!.kind).toBe("follow_up");
    // P3-15: a legal function is carried; an illegal one parses as absent.
    expect(parsed.threads[0]!.function).toBe("verification");
    expect(parsed.threads[1]!.function).toBeUndefined();
  });
});

describe("Cref contract v1.1 prompt contract", () => {
  it("bumps the prompt contract version and exposes the new optional staged-schema fields", () => {
    expect(PROMPT_CONTRACT_VERSION).toBe("2.1.0");
    const properties = STAGED_COMMENTS_JSON_SCHEMA.properties as Record<string, any>;
    expect(STAGED_COMMENTS_JSON_SCHEMA.required).toEqual(["disclaimer", "threads"]);
    expect(properties.ownedFirstComment).toEqual({ type: "string" });
    const threadProperties = properties.threads.items.properties;
    expect(threadProperties.kind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(threadProperties.answerKind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(threadProperties.boundary).toEqual({ type: "string" });
    // P3-15: the model may state the thread function; it stays optional.
    expect(threadProperties.function).toEqual({ enum: ["surface_gap", "answer", "clarify", "counterexample", "verification", "next_step"] });
    expect(properties.threads.items.required).not.toContain("kind");
    expect(properties.threads.items.required).not.toContain("function");
    const followUpProperties = properties.threads.items.properties.followUps.items.properties;
    expect(followUpProperties.kind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(followUpProperties.boundary).toEqual({ type: "string" });
  });

  it("exposes the same optional fields on the repair Cref schema", () => {
    const document = indexKnowledgeSource({ projectId: "p1", id: "d1", path: "facts.md", content: "# 资料\n修复参考。" });
    const repair = buildRepairPrompt({
      current: parseGenerationDraft(JSON.stringify(legacyDraftJson())),
      issues: [{ code: "comment_reply_voice_repetition", severity: "error", channel: "Cref", message: "口吻重复", repairable: true }],
      channels: ["Cref"],
      config: createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION),
      knowledge: selectKnowledgeContext({
        documents: [document],
        query: "资料",
        budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
      }),
      seed: 1,
      attempt: 1,
    });
    const cref = (repair.responseSchema.properties as Record<string, any>).Cref;
    expect(cref.properties.ownedFirstComment).toEqual({ type: "string" });
    const threadProperties = cref.properties.threads.items.properties;
    expect(threadProperties.kind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(threadProperties.answerKind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(threadProperties.boundary).toEqual({ type: "string" });
    expect(cref.properties.threads.items.required).toEqual(["id", "question", "answer", "followUps"]);
  });
});

describe("Cref contract v1.1 staged prompt text", () => {
  const stagedPromptInput = () => ({
    config: config(),
    formulaVersion: DEFAULT_FORMULA_VERSION,
    knowledge: selectKnowledgeContext({
      documents: knowledge,
      query: "资料",
      budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    }),
    ledger: buildKnowledgeLedger([]),
    candidateIndex: 0 as const,
    seed: 1,
    variation: { opening: "问题", pacing: "短句", structure: "问答", phrasing: "克制" },
  });

  it("2A binds the publisher identity, the three reply paths and the cast dedup rule", () => {
    const prompt = buildStagedCommentsPrompt(stagedPromptInput(), {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
    });
    const phase = String(prompt.messages[3]?.content);
    // Identity layer: the answering side is the publishing account speaking in
    // the host voice; the question side stays an explicitly labelled proxy.
    expect(phase).toContain("publisher");
    expect(phase).toContain("personaScenePlan.host");
    expect(phase).toContain("模拟读者代理");
    expect(phase).toContain("replyDisplayRole");
    expect(phase).toContain("accountable=true");
    // Three reply paths: knowledge-backed → routed verification → kept unknown.
    expect(phase).toContain("usableEvidenceReferences直接支持");
    expect(phase).toContain("以当期确认为准");
    expect(phase).toContain("路由式回答");
    expect(phase).toContain("保留未知");
    // Per-thread function/kind/answerKind/boundary annotation duties.
    expect(phase).toContain("function六选一");
    expect(phase).toContain("surface_gap");
    expect(phase).toContain("answerKind");
    expect(phase).toContain("boundary");
    // Cast dedup coexists with the no-rotating-assignment rule.
    expect(phase).toContain("不按角色池顺序轮流填空");
    expect(phase).toContain("同一个displayRole不得重复选用");
    // The publisher-owned first comment is requested but optional.
    expect(phase).toContain("ownedFirstComment");
    // The no-followUps and same-thread-reveal rules survive the rewrite.
    expect(phase).toContain("followUps必须为空数组");
    expect(phase).toContain("禁止故意留悬念");
  });

  it("ledger prompt requires knowledge-backed claims to be recorded as facts", () => {
    const prompt = buildStagedLedgerPrompt(stagedPromptInput(), {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
      Cref: { disclaimer: "参考模板", threads: [] },
    });
    const phase = String(prompt.messages[5]?.content);
    expect(phase).toContain("必须记为 fact");
    expect(phase).toContain("usableEvidenceReferences 中对应小节的逐字原文");
    expect(phase).toContain("按 hypothesis 记，不得伪装成 fact");
  });
});
