import { describe, expect, it } from "vitest";

import {
  assignCommentDisplayName,
  buildKnowledgeLedger,
  COMMENT_NICKNAME_POOL,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  indexKnowledgeSource,
  INSTITUTIONAL_NICKNAME_TERMS,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  planTopicOrchestrations,
  validateGenerationDraft,
} from "../src/index.js";
import type {
  GenerationDraft,
  InformationGap,
  ProjectBlueprintModuleKey,
  TopicOpportunity,
} from "../src/index.js";

const project = {
  id: "p1",
  name: "测试项目",
  domain: "决策信息",
  productPoints: ["资料中确认了产品要点"],
  organizationPoints: ["资料中确认了服务边界"],
  cities: ["上海"],
  doctors: [],
};

function config() {
  const value = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  value.task.theme = "方案选择";
  value.task.city = "上海";
  value.informationWindow.gaps = ["适合谁", "如何比较", "哪些未知"];
  value.informationWindow.boundaries = ["不能保证个体结果"];
  value.content.bodyMinChars = 120;
  value.content.bodyMaxChars = 800;
  value.content.hashtagMin = 3;
  value.content.hashtagMax = 6;
  value.content.commentThreadMin = 2;
  value.content.commentThreadMax = 4;
  value.content.followUpDepth = 2;
  // 打开多轮生长开关,让计划侧排出 targetFollowUps > 0 的线程,从而覆盖
  // 追问接话人昵称(fu 盐)的绑定路径。
  value.content.commentMultiTurnGrowthEnabled = true;
  value.knowledge.maxInputTokens = 20_000;
  value.knowledge.outputReserveTokens = 1_000;
  value.knowledge.safetyMarginTokens = 100;
  return value;
}

const knowledge = [
  indexKnowledgeSource({ projectId: "p1", id: "d1", path: "INDEX.md", content: "# 索引\n- facts.md" }),
  indexKnowledgeSource({ projectId: "p1", id: "d2", path: "facts.md", content: "# 已知事实\n项目资料只确认这些信息，并要求保留适用边界。" }),
];

const gaps: InformationGap[] = [
  {
    id: "fit_gap",
    label: "适用条件",
    question: "哪些条件会改变适用性？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.9,
    decisionLeverage: 0.9,
    proofability: 0.8,
    evidenceIds: ["evidence_d2"],
    required: true,
    preferredChannels: ["Cref"],
  },
  {
    id: "compare_gap",
    label: "比较维度",
    question: "应该按哪些维度比较？",
    category: "decision",
    audienceStages: ["comparing"],
    importance: 0.8,
    decisionLeverage: 0.85,
    proofability: 0.8,
    evidenceIds: ["evidence_d2"],
    required: false,
    preferredChannels: ["Cref"],
  },
];

function opportunity(): TopicOpportunity {
  return {
    id: "topic-nickname",
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
    evidenceIds: ["evidence_d2"],
    boundaries: ["个体适用性需要单独核验"],
    tags: ["比较方法"],
    imageAssetIds: [],
    status: "eligible",
  };
}

describe("assignCommentDisplayName (展示昵称确定性分配)", () => {
  it("is deterministic: same seed + salt + used set always returns the same nickname", () => {
    const used = new Set(["桃子气泡水"]);
    const first = assignCommentDisplayName(42, "nickname:strategy_a_thread_1", used);
    const second = assignCommentDisplayName(42, "nickname:strategy_a_thread_1", used);
    expect(first).toBe(second);
    expect(COMMENT_NICKNAME_POOL).toContain(first);
    // 盐不同则抽取位不同:一批线程盐应产生多种昵称(不是全员同一名)。
    const draws = new Set(Array.from({ length: 12 }, (_, index) =>
      assignCommentDisplayName(42, `nickname:strategy_a_thread_${index + 1}`, new Set())));
    expect(draws.size).toBeGreaterThan(3);
  });

  it("skips used names deterministically (重复顺延) so package-level names stay unique", () => {
    const picked = assignCommentDisplayName(7, "nickname:t1", new Set());
    const reassigned = assignCommentDisplayName(7, "nickname:t1", new Set([picked]));
    expect(reassigned).not.toBe(picked);
    expect(COMMENT_NICKNAME_POOL).toContain(picked);
    expect(COMMENT_NICKNAME_POOL).toContain(reassigned);
    // The follow-up salt keeps one speaker fixed inside one thread.
    const followUp = assignCommentDisplayName(7, "nickname:t1:fu:0", new Set([picked, reassigned]));
    expect(assignCommentDisplayName(7, "nickname:t1:fu:0", new Set([picked, reassigned]))).toBe(followUp);
    expect(followUp).not.toBe(picked);
  });

  it("pool stays in the 80-100 range, has no duplicates and no institutional terms", () => {
    expect(COMMENT_NICKNAME_POOL.length).toBeGreaterThanOrEqual(80);
    expect(COMMENT_NICKNAME_POOL.length).toBeLessThanOrEqual(100);
    expect(new Set(COMMENT_NICKNAME_POOL).size).toBe(COMMENT_NICKNAME_POOL.length);
    for (const name of COMMENT_NICKNAME_POOL) {
      for (const term of INSTITUTIONAL_NICKNAME_TERMS) {
        expect(name.includes(term), `昵称「${name}」含机构感词「${term}」`).toBe(false);
      }
    }
  });
});

describe("dialoguePlans displayName assignment", () => {
  it("assigns a unique pool nickname to every planned thread, stable for the same seeds", () => {
    const build = () => planTopicOrchestrations({
      opportunity: opportunity(),
      gaps,
      config: config(),
      seeds: [11, 22, 33],
    });
    const plans = build();
    const rerun = build();
    plans.forEach((plan, planIndex) => {
      expect(plan.dialogueThreads.length).toBeGreaterThan(0);
      const names = plan.dialogueThreads.map((thread) => thread.displayName);
      for (const name of names) {
        expect(name).toBeDefined();
        expect(COMMENT_NICKNAME_POOL).toContain(name);
      }
      expect(new Set(names).size, "包内昵称不得重复").toBe(names.length);
      // 同种子重放,昵称完全一致(确定性)。
      expect(rerun[planIndex]!.dialogueThreads.map((thread) => thread.displayName)).toEqual(names);
    });
  });
});

describe("engine binding carries displayName into the final package", () => {
  it("binds thread + followUp nicknames, unique per package and reproducible across runs", async () => {
    const generate = () => new ContentGenerationAgent({ now: () => new Date("2026-07-12T12:00:00Z") })
      .generate({ jobId: "display-name-e2e", config: config(), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const [first, second] = [await generate(), await generate()];
    expect(first.packages).toHaveLength(3);
    first.packages.forEach((pkg, pkgIndex) => {
      const plannedById = new Map((pkg.dialogueThreads ?? []).map((thread) => [thread.id, thread]));
      const names: string[] = [];
      for (const thread of pkg.content.Cref.threads) {
        expect(thread.displayName).toBeDefined();
        // 绑定结果与计划侧一致(计划是唯一昵称来源)。
        expect(thread.displayName).toBe(plannedById.get(thread.id)?.displayName);
        names.push(thread.displayName!);
        for (const followUp of thread.followUps) {
          expect(followUp.displayName).toBeDefined();
          names.push(followUp.displayName!);
        }
      }
      expect(new Set(names).size, "包内所有发言昵称(含接话人)不得重复").toBe(names.length);
      // 同输入重跑,昵称完全一致(确定性)。
      const rerunThreads = second.packages[pkgIndex]!.content.Cref.threads;
      expect(rerunThreads.map((thread) => thread.displayName)).toEqual(
        pkg.content.Cref.threads.map((thread) => thread.displayName),
      );
      expect(rerunThreads.map((thread) => thread.followUps.map((followUp) => followUp.displayName))).toEqual(
        pkg.content.Cref.threads.map((thread) => thread.followUps.map((followUp) => followUp.displayName)),
      );
    });
  });
});

const blueprintRevisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

function accountableBlueprint() {
  return normalizeProjectCreativeBlueprint({
    projectId: "p1",
    sourceFingerprint: "display-name-test",
    moduleRevisions: blueprintRevisions,
    modules: {
      knowledge_map: { entries: [] },
      domain_model: {
        projectNoun: "皮肤管理",
        industry: "医美",
        domain: "医美",
        objects: ["皮肤管理"],
        actions: ["比较"],
        concepts: ["适用条件"],
        decisionTasks: ["核验适用条件"],
        vocabulary: ["适用条件"],
      },
      audience_model: { states: [] },
      scenario_model: { families: [] },
      role_model: {
        hostVoiceTraits: ["克制"],
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
            utteranceModes: ["knowledge_translation"],
            replyDisplayRoles: ["知肤研究所"],
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
            utteranceModes: ["direct_question"],
            replyDisplayRoles: ["知肤研究所"],
            targetChars: [6, 30],
            accountable: false,
            source: { status: "hypothesis", evidenceIds: [] },
          },
        ],
      },
      claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
      surface_language: {
        registerDescription: "自然、具体",
        preferredTerms: [],
        optionalColloquialisms: [],
        prohibitedCliches: [],
        antiCopyRules: [],
      },
    },
  });
}

function draftWithNickname(threadDisplayName?: string, followUpDisplayName?: string): GenerationDraft {
  const draft = parseGenerationDraft(JSON.stringify({
    content: {
      H: { hashtags: ["信息", "选择"] },
      N: { imageBrief: "清单式封面", title: "先核实，再决定", body: "先看自己的情况，别急着下结论，多问一句再定。" },
      Cref: {
        disclaimer: "以下为模拟情景问答参考模板，不代表真实评论。",
        threads: [{
          id: "t1",
          question: "这个要怎么判断？",
          answer: "先按手头的说法核实条件。",
          followUps: [{ question: "那要带上什么去问？", answer: "带上自己的时间安排。", evidenceIds: [] }],
          postingIdentity: "publisher",
          sourceClusterIds: [],
          evidenceIds: [],
          personaRole: "information_collector",
          speakerType: "simulated_reader",
          claimStatus: "hypothetical",
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
  // displayName 是引擎绑定的展示元数据,不经模型解析,这里直接附上再校验。
  if (threadDisplayName) draft.content.Cref.threads[0]!.displayName = threadDisplayName;
  if (followUpDisplayName) draft.content.Cref.threads[0]!.followUps[0]!.displayName = followUpDisplayName;
  return draft;
}

function validate(draft: GenerationDraft, extras: Record<string, unknown> = {}) {
  const validationConfig = config();
  validationConfig.content.bodyMinChars = 2;
  validationConfig.content.hashtagMin = 1;
  return validateGenerationDraft({
    draft,
    config: validationConfig,
    ledger: buildKnowledgeLedger([]),
    allowedEvidenceIds: ["ev_k1"],
    ...extras,
  });
}

const codes = (issues: ReturnType<typeof validateGenerationDraft>) => issues.map((issue) => issue.code);

describe("displayName validation (warning 级)", () => {
  it("warns when a nickname carries an institutional term (机构感词)", () => {
    const issues = validate(draftWithNickname("官方小助手", "医美百事通"));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "comment_display_name_institutional",
      severity: "warning",
      channel: "Cref",
    }));
    // 提问者与接话人各触发一次。
    expect(codes(issues).filter((code) => code === "comment_display_name_institutional")).toHaveLength(2);
  });

  it("warns when a nickname equals or contains the project name (互相包含)", () => {
    const issues = validate(draftWithNickname("测试项目小粉丝"));
    expect(issues).toContainEqual(expect.objectContaining({
      code: "comment_display_name_identity_clash",
      severity: "warning",
    }));
  });

  it("warns when a nickname clashes with an accountable blueprint displayRole (IP/助理名)", () => {
    const issues = validate(draftWithNickname(undefined, "知肤研究所小跟班"), { projectBlueprint: accountableBlueprint() });
    expect(codes(issues)).toContain("comment_display_name_identity_clash");
  });

  it("does not fire for clean nicknames or for historical packages without displayName", () => {
    const clean = validate(draftWithNickname("桃子气泡水", "熬夜的猫"), { projectBlueprint: accountableBlueprint() });
    expect(codes(clean)).not.toContain("comment_display_name_institutional");
    expect(codes(clean)).not.toContain("comment_display_name_identity_clash");
    const historical = validate(draftWithNickname());
    expect(codes(historical)).not.toContain("comment_display_name_institutional");
    expect(codes(historical)).not.toContain("comment_display_name_identity_clash");
  });
});
