import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  buildRepairPrompt,
  buildStagedCommentGrowthPrompt,
  buildStagedCommentReadersCorrectionPrompt,
  buildStagedCommentReadersPrompt,
  buildStagedCorePrompt,
  buildStagedLedgerPrompt,
  buildStagedOrgAnswersPrompt,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  parseGenerationDraft,
  parseStagedCommentCopy,
  planTopicOrchestrations,
  PROMPT_CONTRACT_VERSION,
  selectKnowledgeContext,
  STAGED_COMMENT_READERS_JSON_SCHEMA,
  STAGED_COMMENTS_JSON_SCHEMA,
  STAGED_ORG_ANSWERS_JSON_SCHEMA,
} from "../src/index.js";
import type { CommentSurfaceRoleCard, DialogueThreadPlan, InformationGap, ModelGenerationRequest, ModelProvider, TopicOpportunity } from "../src/index.js";

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

function stagedThreadSkeletons(request: ModelGenerationRequest) {
  return stagedThreadIds(request).map((id, index) => ({
    id,
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
        const ownsPrimaryGap = (planned!.coverageRole
          ?? ((planned!.threadKind ?? "org_answer") === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap";
        // Project-answer boundaries belong only to primary-gap threads. Social
        // nodes remain readable but cannot expose the project's reply inventory.
        expect(thread.boundary).toBe(ownsPrimaryGap ? planned!.replyPlan.boundary : undefined);
        if (!ownsPrimaryGap) {
          expect(thread.primaryGapId).toBeUndefined();
          expect(thread.replyPlan).toBeUndefined();
          expect(thread.evidenceIds).toEqual([]);
        }
        for (const followUp of thread.followUps) {
          expect(followUp.kind).toBe("follow_up");
        }
      }
      // Same projection the engine must apply: selected gap cards not covered by any
      // dialogue thread (primary or auxiliary) and not planned for N.body.
      const plan = pkg.orchestrationSnapshot!;
      const covered = new Set(plan.dialogueThreads
        .filter((thread) => (thread.coverageRole
          ?? ((thread.threadKind ?? "org_answer") === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap")
        .flatMap((thread) => [thread.primaryGapId, ...thread.auxiliaryGapIds]));
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
        if (purpose === "generate_comment_readers") {
          const threads = stagedThreadSkeletons(request).map((thread, index) => ({
            ...thread,
            // Only the first thread states the v1.1 fields; the rest omit them
            // so the engine must apply the positional/planned defaults.
            ...(index === 0 ? { kind: "follow_up", answerKind: "clarification", boundary: "模特声明的边界" } : {}),
          }));
          return { text: JSON.stringify({ threads }), raw: {} };
        }
        if (purpose === "generate_org_answers") {
          // 机构答复调用只回可见答复;首评仅 publisher 调用产出。
          return {
            text: JSON.stringify({
              answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })),
              ...(request.metadata?.identity === "publisher" ? { ownedFirstComment: "置顶：价格以当期为准，详见 evidence_d1。" } : {}),
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
      // Owned first comment is kept, cleaned like any other visible copy. 按角色
      // 隔离后首评只可能由 publisher 答复调用产出:该候选没有 publisher 机构线程
      // 时(全部线程落在读者侧)跳过该角色调用,首评自然缺省,不凭空合成。
      const hasPublisherOrgThread = (pkg.dialogueThreads ?? [])
        .some((thread) => (thread.threadKind ?? "org_answer") === "org_answer" && thread.postingIdentity === "publisher");
      if (hasPublisherOrgThread) {
        expect(pkg.content.Cref.ownedFirstComment).toBe("置顶：价格以当期为准，详见 资料原文。");
      } else {
        expect(pkg.content.Cref.ownedFirstComment).toBeUndefined();
      }
      for (const [threadIndex, thread] of threads.entries()) {
        if (threadIndex > 0) {
          const planned = (pkg.dialogueThreads ?? []).find((candidate) => candidate.id === thread.id);
          expect(thread.kind).toBe("question");
          expect(thread.answerKind).toBe("answer");
          const ownsPrimaryGap = (planned?.coverageRole
            ?? ((planned?.threadKind ?? "org_answer") === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap";
          expect(thread.boundary).toBe(ownsPrimaryGap ? planned?.replyPlan.boundary : undefined);
          if (!ownsPrimaryGap) {
            expect(thread.primaryGapId).toBeUndefined();
            expect(thread.replyPlan).toBeUndefined();
            expect(thread.evidenceIds).toEqual([]);
          }
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
        if (purpose === "generate_comment_readers") {
          const threads = stagedThreadSkeletons(request).map((thread, index) => ({
            ...thread,
            // Thread 0 states a legal function; thread 1 states an illegal one
            // (parses as absent); thread 2 omits it entirely.
            ...(index === 0 ? { function: "counterexample" } : {}),
            ...(index === 1 ? { function: "opinion" } : {}),
          }));
          return { text: JSON.stringify({ threads }), raw: {} };
        }
        if (purpose === "generate_org_answers") {
          return { text: JSON.stringify({ answers: stagedThreadIds(request).map((id) => ({ id, answer: "按资料逐项核实。" })) }), raw: {} };
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
    // 2.4.0: stable cross-candidate prefix + one bounded reader-shape correction.
    expect(PROMPT_CONTRACT_VERSION).toBe("2.4.0");
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
    // 2.2.0: 人物由规划层分配,模型不再输出 roleIndex。
    expect(properties.threads.items.required).not.toContain("roleIndex");
    expect(threadProperties.roleIndex).toBeUndefined();
    const followUpProperties = properties.threads.items.properties.followUps.items.properties;
    expect(followUpProperties.kind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(followUpProperties.boundary).toEqual({ type: "string" });
    // 读者侧 schema:不要 disclaimer/roleIndex,answer 允许空串(T1 留待 2A-O、T3 恒空)。
    const readersProperties = STAGED_COMMENT_READERS_JSON_SCHEMA.properties as Record<string, any>;
    expect(STAGED_COMMENT_READERS_JSON_SCHEMA.required).toEqual(["threads"]);
    expect(readersProperties.disclaimer).toBeUndefined();
    expect(readersProperties.threads.items.required).toEqual(["id", "question", "answer", "followUps"]);
    expect(readersProperties.threads.items.properties.roleIndex).toBeUndefined();
    expect(readersProperties.threads.items.properties.answer).toEqual({ type: "string" });
    // 机构侧 schema:答复列表 + 可选首评。
    const orgProperties = STAGED_ORG_ANSWERS_JSON_SCHEMA.properties as Record<string, any>;
    expect(STAGED_ORG_ANSWERS_JSON_SCHEMA.required).toEqual(["answers"]);
    expect(orgProperties.ownedFirstComment).toEqual({ type: "string" });
    expect(orgProperties.answers.items.required).toEqual(["id", "answer"]);
    expect(orgProperties.answers.items.properties.answerKind).toEqual({ enum: ["question", "answer", "follow_up", "clarification"] });
    expect(orgProperties.answers.items.properties.boundary).toEqual({ type: "string" });
  });

  it("places the large stable knowledge prefix before candidate-specific orchestration", () => {
    const base = {
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
    };
    const first = requestText(buildStagedCorePrompt(base));
    const second = requestText(buildStagedCorePrompt({
      ...base, candidateIndex: 1 as const, seed: 2,
      variation: { opening: "反问", pacing: "长短句", structure: "递进", phrasing: "口语" },
    }));
    const firstKnowledge = first.indexOf("<knowledge_data");
    const firstCandidate = first.indexOf('<task_data scope="candidate">');
    expect(firstKnowledge).toBeGreaterThanOrEqual(0);
    expect(firstCandidate).toBeGreaterThan(firstKnowledge);
    expect(first.slice(firstKnowledge, firstCandidate)).toBe(second.slice(second.indexOf("<knowledge_data"), second.indexOf('<task_data scope="candidate">')));
  });

  it("builds a bounded one-shot reader correction without project knowledge", () => {
    const prompt = buildStagedCommentReadersCorrectionPrompt(
      '{"threads":[]}',
      [{ id: "t1", threadKind: "org_answer" }, { id: "t2", threadKind: "reader_exchange" }],
      "missing IDs",
    );
    const text = requestText(prompt);
    expect(text).toMatch(/"id"\s*:\s*"t1"/u);
    expect(text).toMatch(/"threadKind"\s*:\s*"reader_exchange"/u);
    expect(text).toContain("只返回完整 JSON");
    expect(text).not.toContain("<knowledge_data");
    expect(prompt.responseSchema).toBe(STAGED_COMMENT_READERS_JSON_SCHEMA);
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

  function promptFullText(bundle: { messages: ModelGenerationRequest["messages"] }): string {
    return bundle.messages.map((message) => {
      const content = message.content;
      return Array.isArray(content)
        ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
        : content;
    }).join("\n");
  }

  function fakeSurfaceRoleCard(replyDisplayRole: string): CommentSurfaceRoleCard {
    return {
      displayRole: "同城比较者",
      relationToHost: "同城读者",
      identityCue: "同城",
      situationCue: "在比较",
      motive: "确认条件",
      knowledgePosition: "只知道正文公开的信息",
      speechPattern: "短句",
      lexicalCues: [],
      interactionHook: "补一个条件",
      permittedContribution: "一个窄问题",
      utteranceMode: "direct_question",
      targetChars: [8, 28],
      replyDisplayRole,
    };
  }

  function fakeThreadPlan(overrides: Partial<DialogueThreadPlan> & { id: string; postingIdentity: "publisher" | "staff" }): DialogueThreadPlan {
    return {
      gapId: "g1",
      stage: "comparing",
      function: "verification",
      questionIntent: "哪些条件影响适用性？",
      answerRequirements: [],
      followUpIntent: "",
      nextStep: "按证据来源核验自己的适用条件",
      sourceClusterIds: [],
      evidenceIds: [],
      boundaryRequired: false,
      personaRole: "information_collector",
      speakerType: "simulated_reader",
      claimStatus: "bounded",
      replyTo: null,
      threadDepth: 0,
      simulated: true,
      simulationLabel: "模拟潜在读者情景",
      roleCard: { stage: "comparing", knowledge: [], constraints: [], decisionTask: "哪些条件影响适用性？", evidenceStance: "verification_seeking" },
      primaryGapId: "g1",
      auxiliaryGapIds: [],
      densityProxy: { primaryGapCount: 1, auxiliaryDimensionCount: 0, roleDimensionCount: 4, constraintCount: 0, expectedReplyComponents: 5, questionTargetChars: 22 },
      replyPlan: { directAnswer: "按资料逐项核实", condition: "仅已披露条件", boundary: "不代填个人情况", unknown: "个体差异未知", nextQuestion: "核实个人条件" },
      threadKind: "org_answer",
      ...overrides,
    };
  }

  it("2A-R binds planner-assigned personas and the reader-side contract", () => {
    const prompt = buildStagedCommentReadersPrompt(stagedPromptInput(), {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
    });
    const phase = String(prompt.messages[3]?.content);
    // 人物由规划层分配:模型只用分配好的人物声音开口,不选角、不写 roleIndex。
    expect(phase).toContain("已由规划分配");
    expect(phase).toContain("不得换人");
    expect(phase).not.toContain("roleIndex");
    // 读者互动层三形态规则保留:T2 读者B接话、T3 短共鸣、其余 answer 留空。
    expect(phase).toContain("reader_exchange");
    expect(phase).toContain("permittedContribution");
    expect(phase).toContain("organic_reaction");
    expect(phase).toContain("空字符串");
    // Per-thread function/kind/boundary annotation duties.
    expect(phase).toContain("function六选一");
    expect(phase).toContain("surface_gap");
    expect(phase).toContain("boundary");
    // The no-followUps rule survives the rewrite.
    expect(phase).toContain("followUps必须为空数组");
  });

  it("2A-O publisher binds an explicit project identity, the three reply paths and the optional first comment", () => {
    const threads = [{
      planned: fakeThreadPlan({ id: "s1_thread_1", postingIdentity: "publisher", surfaceRoleCard: fakeSurfaceRoleCard("发布者") }),
      question: "适用条件怎么判断？",
    }];
    const prompt = buildStagedOrgAnswersPrompt(stagedPromptInput(), {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
    }, "publisher", threads);
    const text = promptFullText(prompt);
    // ROLE 04 的 publisher 是明确项目方，不继承正文叙事人物；三条答复路径仍为
    // 有口径→引口径、无口径可核验→路由式回答、完全未知→保留未知。
    expect(text).toContain("项目发布账号");
    expect(text).toContain("不是正文叙事人物");
    expect(text).not.toContain("叙述声音");
    expect(text).toContain("不冒充独立消费者");
    expect(text).toContain("以当期确认为准");
    expect(text).toContain("路由式回答");
    expect(text).toContain("保留未知");
    expect(text).toContain("禁止故意留悬念");
    expect(text).toContain("你只知道下方列出的口径");
    // 应答骨架去重约束保留:禁止把答复要点全套展开。
    expect(text).toContain("禁止每条都写");
    // The publisher-owned first comment is requested but optional.
    expect(text).toContain("ownedFirstComment");
    // 另一个角色(助理)的任何定义不出现。
    expect(text).not.toContain("助理");
    expect(text).not.toContain("staff");
  });

  it("2A-O staff binds the service tone and the scope-anchoring contract", () => {
    const threads = [{
      planned: fakeThreadPlan({ id: "s1_thread_2", postingIdentity: "staff", surfaceRoleCard: fakeSurfaceRoleCard("拾光助理") }),
      question: "价格是多少、怎么预约？",
    }];
    const prompt = buildStagedOrgAnswersPrompt(stagedPromptInput(), {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
    }, "staff", threads);
    const text = promptFullText(prompt);
    // 话术自由,但价格数字承诺锚定口径;无口径转人工;动态信息带限定。
    expect(text).toContain("拾光助理");
    expect(text).toContain("我帮你跟专人确认");
    expect(text).toContain("以当期确认为准");
    expect(text).toContain("你只知道下方列出的口径");
    expect(text).toContain("禁止每条都写");
    // 另一个角色(IP/楼主)的任何定义不出现。
    expect(text).not.toContain("楼主");
    expect(text).not.toContain("发布者");
    expect(text).not.toContain("publisher");
  });

  it("2B injects the planned followUpIntent only for multi-turn threads", () => {
    const scenario = config();
    scenario.content.commentThreadMin = 2;
    scenario.content.commentThreadMax = 2;
    scenario.content.commentMultiTurnGrowthEnabled = true;
    scenario.content.followUpDepth = 2;
    const growthGaps: InformationGap[] = [
      {
        id: "fit", label: "适用条件", question: "哪些条件会改变适用性？", category: "decision",
        audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.8,
        evidenceIds: ["evidence_d1"], required: true,
      },
      {
        id: "cost", label: "成本边界", question: "成本会怎样改变选择？", category: "decision",
        audienceStages: ["comparing"], importance: 0.7, decisionLeverage: 0.7, proofability: 0.6,
        evidenceIds: [], required: false,
      },
    ];
    const growthOpportunity: TopicOpportunity = {
      id: "growth-2b", topic: "方案选择", angle: "先核验再比较", gapIds: ["fit", "cost"],
      audienceStage: "comparing", entry: "search", relevance: 0.9, importance: 0.8, proofability: 0.8,
      novelty: 0.6, decisionLeverage: 0.8, cognitiveCost: 0.3, risk: 0.2,
      evidenceIds: ["evidence_d1"], boundaries: ["个体适用性需要单独核验"], tags: ["比较方法"],
      imageAssetIds: [], status: "eligible",
    };
    const plan = planTopicOrchestrations({ opportunity: growthOpportunity, gaps: growthGaps, config: scenario, seed: 99 })[0]!;
    const growing = plan.dialogueThreads.filter((thread) => (thread.conversationPlan?.targetFollowUps ?? 0) > 0);
    const resting = plan.dialogueThreads.filter((thread) => (thread.conversationPlan?.targetFollowUps ?? 0) === 0);
    expect(growing.length).toBeGreaterThan(0);
    expect(resting.length).toBeGreaterThan(0);
    const prompt = buildStagedCommentGrowthPrompt({ ...stagedPromptInput(), config: scenario, orchestrationPlan: plan }, {
      H: { hashtags: ["方案选择"] },
      N: { imageBrief: "", title: "先核实信息", body: "正文。" },
    }, {
      disclaimer: "以下为完整评论区创作参考，不代表已经发生的真实互动或观测口碑。",
      threads: plan.dialogueThreads.map((thread) => ({ id: thread.id, question: "根评论", answer: "根回复", followUps: [] })),
    });
    const phase = String(prompt.messages[4]?.content);
    expect(phase).toContain("followUpIntent");
    // 计划多轮的线程投出接龙方向；单交换线程不投。
    for (const thread of growing) expect(phase).toContain(thread.followUpIntent);
    for (const thread of resting) expect(phase).not.toContain(thread.followUpIntent);
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
