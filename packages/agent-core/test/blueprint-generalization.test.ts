import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  normalizeProjectCreativeBlueprint,
  parseGenerationDraft,
  planTopicOrchestrations,
  projectBlueprintCompleteness,
  validateGenerationDraft,
} from "../src/index.js";
import type { ProjectBlueprintModuleKey, TopicOpportunity } from "../src/index.js";

const revisions = Object.fromEntries([
  "knowledge_map", "domain_model", "audience_model", "scenario_model",
  "role_model", "claim_policy", "surface_language",
].map((key) => [key, `${key}-v1`])) as Record<ProjectBlueprintModuleKey, string>;

function blueprint(input: {
  noun: string;
  industry: string;
  sceneId: string;
  setting: string;
  role: string;
  relation: string;
  term: string;
}) {
  return normalizeProjectCreativeBlueprint({
    projectId: `project-${input.sceneId}`,
    sourceFingerprint: `fingerprint-${input.sceneId}`,
    moduleRevisions: revisions,
    modules: {
      knowledge_map: { entries: [] },
      domain_model: {
        projectNoun: input.noun,
        industry: input.industry,
        domain: input.industry,
        objects: [input.noun],
        actions: ["比较", "核验"],
        concepts: [input.term],
        decisionTasks: ["核验适用条件"],
        vocabulary: [input.term],
      },
      audience_model: {
        states: [{
          id: "comparer",
          label: "正在比较的人",
          stages: ["comparing"],
          goals: ["减少选择成本"],
          constraints: ["时间有限"],
          knowledgeState: "知道基本名词，但缺少比较依据",
          hesitationReasons: ["信息口径不一致"],
          actionConditions: ["关键边界可核验"],
          source: { status: "inference", evidenceIds: [] },
        }],
      },
      scenario_model: {
        families: [{
          id: input.sceneId,
          label: "项目场景",
          prototype: "option_comparison",
          applicableStages: ["comparing"],
          hostIdentityCues: ["手里已有两个选项的人"],
          lifeContexts: ["午休时继续做功课"],
          timeAnchors: ["今天午休"],
          settings: [input.setting],
          triggers: ["两种说法对不上"],
          observableActions: ["把差异记进备忘录"],
          frictions: ["下班前只能再问一个问题"],
          emotionalAftertastes: ["有点纠结但不想草率"],
          imageMoments: ["手机备忘录里的比较项"],
          prohibitedUnsupportedHistories: [],
          source: { status: "hypothesis", evidenceIds: [] },
        }],
      },
      role_model: {
        hostVoiceTraits: ["克制", "具体"],
        hostSpeechMarkers: ["短句"],
        roles: [{
          id: "peer",
          displayRole: input.role,
          relationToHost: input.relation,
          identityCues: [input.role],
          situationCues: ["也在比较"],
          motives: ["确认一个边界"],
          knowledgePosition: "只知道公开信息和自己的限制",
          speechPatterns: ["先说处境，再问一个窄问题"],
          lexicalCues: [],
          interactionHooks: ["追问适用条件"],
          permittedContributions: ["提出条件化问题"],
          utteranceModes: ["direct_question"],
          // 双号运营：读者角色只能路由到已定义的可追责公开身份（展示名，不是内部 id）。
          replyDisplayRoles: [`${input.noun}主创`],
          targetChars: [6, 30],
          accountable: false,
          source: { status: "hypothesis", evidenceIds: [] },
        }, {
          id: "org_ip",
          displayRole: `${input.noun}主创`,
          relationToHost: "机构 IP 本人",
          identityCues: ["长期做这件事的人"],
          situationCues: ["在评论区解释边界"],
          motives: ["把判断依据讲清楚"],
          knowledgePosition: "掌握项目口径与适用条件",
          speechPatterns: ["先给条件，再给结论"],
          lexicalCues: [],
          interactionHooks: ["补一条判断依据"],
          permittedContributions: ["解释适用条件"],
          utteranceModes: ["knowledge_translation", "service_answer"],
          replyDisplayRoles: [],
          targetChars: [20, 60],
          accountable: true,
          source: { status: "hypothesis", evidenceIds: [] },
        }, {
          id: "org_assistant",
          displayRole: `${input.noun}助理`,
          relationToHost: "机构公开助理",
          identityCues: ["对接咨询的人"],
          situationCues: ["接住具体问题"],
          motives: ["给下一步核验路径"],
          knowledgePosition: "掌握流程与对接方式",
          speechPatterns: ["直接说下一步怎么做"],
          lexicalCues: [],
          interactionHooks: ["给核验路径"],
          permittedContributions: ["说明流程"],
          utteranceModes: ["service_answer"],
          replyDisplayRoles: [],
          targetChars: [20, 60],
          accountable: true,
          source: { status: "hypothesis", evidenceIds: [] },
        }],
      },
      claim_policy: {
        rules: [{
          id: "outcome",
          label: "项目结果承诺",
          claimType: "outcome",
          terms: [input.term],
          requiresEvidence: true,
          allowedEvidenceStatuses: ["supplied_fact"],
          dynamic: false,
          handling: "block",
          source: { status: "inference", evidenceIds: [] },
        }],
        prohibitedClaims: [],
        dynamicInformation: [],
        unknownHandling: ["保持未知并给核验路径"],
      },
      surface_language: {
        registerDescription: "自然、具体，不写说明书",
        preferredTerms: [input.term],
        optionalColloquialisms: ["蹲个真实反馈"],
        prohibitedCliches: ["闭眼入"],
        antiCopyRules: ["不复刻样本句子"],
      },
    },
  });
}

function opportunity(topic: string): TopicOpportunity {
  return {
    id: `topic-${topic}`,
    topic,
    angle: "先核验比较条件",
    gapIds: ["criteria"],
    audienceStage: "comparing",
    entry: "search",
    relevance: 0.9,
    importance: 0.8,
    proofability: 0.8,
    novelty: 0.5,
    decisionLeverage: 0.8,
    cognitiveCost: 0.3,
    risk: 0.2,
    evidenceIds: [],
    boundaries: [],
    tags: [],
    imageAssetIds: [],
    status: "eligible",
  };
}

function config(noun: string, domain: string) {
  const value = createDefaultGenerationConfig({
    id: `project-${noun}`,
    name: noun,
    domain,
    productPoints: [],
    organizationPoints: [],
    cities: [],
    doctors: [],
  }, DEFAULT_FORMULA_VERSION);
  value.task.theme = `${noun}怎么选`;
  value.task.audienceStage = "comparing";
  value.content.commentThreadMax = 2;
  return value;
}

describe("project creative blueprint generalization", () => {
  it("requires all seven versioned modules and preserves project-derived roles and scenes", () => {
    const saas = blueprint({
      noun: "团队协作软件", industry: "企业软件", sceneId: "trial-expiry",
      setting: "试用到期前的团队群", role: "项目管理员", relation: "负责组织试用反馈", term: "永久不限量",
    });
    expect(projectBlueprintCompleteness(saas)).toEqual({ complete: true, missing: [] });

    const plans = planTopicOrchestrations({
      opportunity: opportunity("团队协作软件怎么选"),
      gaps: [{
        id: "criteria", label: "比较依据", question: "哪些条件会改变选择？", category: "comparison",
        audienceStages: ["comparing"], importance: 0.8, decisionLeverage: 0.8, proofability: 0.7,
        evidenceIds: [], required: true,
      }],
      config: config("团队协作软件", "企业软件"),
      projectBlueprint: saas,
      seeds: [11, 22, 33],
    });
    for (const plan of plans) {
      expect(plan.personaScenePlan?.scenarioFamilyId).toBe("trial-expiry");
      expect(plan.personaScenePlan?.event.setting).toBe("试用到期前的团队群");
      expect(plan.personaScenePlan?.commentCast.filter((role) => !role.orgSide).map((role) => role.displayRole))
        .toEqual(["项目管理员"]);
      expect(plan.personaScenePlan?.commentCast.filter((role) => role.orgSide).map((role) => role.displayRole))
        .toEqual(["团队协作软件主创", "团队协作软件助理"]);
    }
  });

  it("cross-samples a second industry without leaking the first industry's vocabulary", () => {
    const renovation = blueprint({
      noun: "旧房改造", industry: "家装", sceneId: "material-check",
      setting: "周末去建材城的路上", role: "同小区邻居", relation: "户型相近", term: "零增项",
    });
    const plan = planTopicOrchestrations({
      opportunity: opportunity("旧房改造怎么比报价"),
      gaps: [{
        id: "criteria", label: "报价边界", question: "哪些项目容易漏算？", category: "comparison",
        audienceStages: ["comparing"], importance: 0.9, decisionLeverage: 0.9, proofability: 0.7,
        evidenceIds: [], required: true,
      }],
      config: config("旧房改造", "家装"),
      projectBlueprint: renovation,
      seeds: [41, 42, 43],
    })[0]!;
    const visiblePlan = JSON.stringify(plan.personaScenePlan);
    expect(visiblePlan).toContain("周末去建材城的路上");
    expect(visiblePlan).toContain("同小区邻居");
    expect(visiblePlan).not.toMatch(/团队协作软件|项目管理员|试用到期/u);
  });

  it("uses the project claim policy instead of a baked-in industry term list", () => {
    const saas = blueprint({
      noun: "团队协作软件", industry: "企业软件", sceneId: "trial-expiry",
      setting: "团队群", role: "项目管理员", relation: "负责试用", term: "永久不限量",
    });
    const value = config("团队协作软件", "企业软件");
    value.content.bodyMinChars = 1;
    value.content.bodyMaxChars = 500;
    value.content.hashtagMin = 1;
    value.content.commentThreadMin = 0;
    const draft = parseGenerationDraft(JSON.stringify({
      content: {
        H: { hashtags: ["软件选择"] },
        N: { imageBrief: "试用记录", title: "先看边界", body: "这个版本永久不限量。" },
        Cref: { disclaimer: "参考讨论结构", threads: [] },
      },
      evidenceIds: [],
      reasoning: [],
      unknowns: [],
    }));
    const issues = validateGenerationDraft({
      draft,
      config: value,
      ledger: buildKnowledgeLedger([]),
      allowedEvidenceIds: [],
      evidenceSources: {},
      projectBlueprint: saas,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      code: "sensitive_claim_without_evidence",
      severity: "warning",
      disposition: "review",
      channel: "N.body",
    }));
  });

  it("keeps static writer, planner, validator and fallback sources free of one-industry assumptions", () => {
    const source = ["prompt.ts", "planning.ts", "content.ts", "engine.ts", "parameters.ts"]
      .map((filename) => readFileSync(new URL(`../src/${filename}`, import.meta.url), "utf8"))
      .join("\n");
    expect(source).not.toMatch(/眼袋|泪沟|医生|面诊|术后|恢复期|到院|候诊|医美|护理|留疤/u);
  });
});
