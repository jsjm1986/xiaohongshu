import { describe, expect, it } from "vitest";

import { diagnoseAccountableIdentities, projectBlueprintCompleteness } from "../src/index.js";
import type { ProjectCreativeBlueprint, ProjectRoleCard } from "../src/index.js";

/**
 * 双号运营的可追责身份完整性:审批层(projectBlueprintCompleteness)挡新提交,
 * 生成层(diagnoseAccountableIdentities)显性化存量。存量线上数据里 5/12 项目
 * 的 role_model 只有 0 或 1 个 accountable 身份,8/12 的 replyDisplayRoles
 * 写的是内部 id,两类缺陷此前都是静默的。
 */

function role(input: Partial<ProjectRoleCard> & { id: string; displayRole: string }): ProjectRoleCard {
  return {
    relationToHost: "同处境",
    identityCues: [input.displayRole],
    situationCues: ["在比较"],
    motives: ["确认一个边界"],
    knowledgePosition: "只知道公开信息",
    speechPatterns: ["先说处境再问"],
    lexicalCues: [],
    interactionHooks: ["追问条件"],
    permittedContributions: ["提出条件化问题"],
    utteranceModes: ["direct_question"],
    replyDisplayRoles: [],
    targetChars: [6, 30],
    accountable: false,
    source: { status: "hypothesis", evidenceIds: [] },
    ...input,
  } as ProjectRoleCard;
}

const IP = role({
  id: "org_ip",
  displayRole: "项目主创",
  utteranceModes: ["knowledge_translation", "service_answer"],
  accountable: true,
});
const ASSISTANT = role({
  id: "org_assistant",
  displayRole: "项目助理",
  utteranceModes: ["service_answer", "identity_route"],
  accountable: true,
});

function blueprintWith(roles: ProjectRoleCard[]): ProjectCreativeBlueprint {
  return {
    projectId: "p1",
    sourceFingerprint: "fp",
    moduleRevisions: {} as ProjectCreativeBlueprint["moduleRevisions"],
    knowledgeMap: { entries: [] },
    domainModel: { projectNoun: "项目", industry: "行业", domain: "行业", concepts: [], actions: [], objects: [], constraints: [], source: { status: "hypothesis", evidenceIds: [] } },
    audienceModel: { states: [] },
    scenarioModel: { families: [] },
    roleModel: { hostVoiceTraits: [], hostSpeechMarkers: [], roles },
    claimPolicy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
    surfaceLanguage: { registerDescription: "", preferredTerms: [], optionalColloquialisms: [], forbiddenPatterns: [], punctuationRules: [] },
  } as unknown as ProjectCreativeBlueprint;
}

describe("diagnoseAccountableIdentities (存量蓝图体检)", () => {
  it("stays silent for a compliant two-account role model", () => {
    const reader = role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["项目主创"] });
    expect(diagnoseAccountableIdentities(blueprintWith([reader, IP, ASSISTANT]))).toEqual([]);
  });

  it("flags a role model with only one accountable identity", () => {
    const problems = diagnoseAccountableIdentities(blueprintWith([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["项目主创"] }),
      IP,
    ]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("只有 1 个可追责公开身份");
  });

  it("flags replyDisplayRoles that point at internal ids", () => {
    const problems = diagnoseAccountableIdentities(blueprintWith([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["host_account", "role_IP"] }),
      IP,
      ASSISTANT,
    ]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("host_account");
    expect(problems[0]).toContain("role_IP");
  });

  it("reports both defects together and stays silent when there are no roles at all", () => {
    expect(diagnoseAccountableIdentities(blueprintWith([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["role_01"] }),
    ]))).toHaveLength(2);
    // 空 role_model 由 completeness 的 roles 非空检查负责,这里不重复报。
    expect(diagnoseAccountableIdentities(blueprintWith([]))).toEqual([]);
    expect(diagnoseAccountableIdentities(undefined)).toEqual([]);
  });
});

describe("projectBlueprintCompleteness (审批层拦截)", () => {
  const modules = {
    knowledge_map: "v1", domain_model: "v1", audience_model: "v1", scenario_model: "v1",
    role_model: "v1", claim_policy: "v1", surface_language: "v1",
  } as ProjectCreativeBlueprint["moduleRevisions"];

  function completenessOf(roles: ProjectRoleCard[]) {
    return projectBlueprintCompleteness({
      ...blueprintWith(roles),
      moduleRevisions: modules,
      audienceModel: { states: [{ id: "s" }] },
      scenarioModel: { families: [{ id: "f" }] },
    } as unknown as ProjectCreativeBlueprint);
  }

  it("accepts exactly two accountable identities with resolvable reply routing", () => {
    expect(completenessOf([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["项目助理"] }),
      IP,
      ASSISTANT,
    ])).toEqual({ complete: true, missing: [] });
  });

  it("blocks a single-accountable role model", () => {
    const result = completenessOf([role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["项目主创"] }), IP]);
    expect(result.complete).toBe(false);
    expect(result.missing.some((item) => item.startsWith("role_model.accountable"))).toBe(true);
  });

  /**
   * 悬空 replyDisplayRoles 不阻断生成:该修,但不该拦。
   *
   * 原用例断言它进 missing。但 missing 会让 intelligence.service 读蓝图时抛
   * BadRequestException,对**已批准的存量蓝图**追溯生效——实测线上两个项目因此
   * 完全无法生成,而它们 2 个 accountable 身份齐备、只是 replyDisplayRoles 写成了
   * host_account / assistant_account。
   *
   * 这类瑕疵没有实际后果:forcedReplyDisplayRole 不读 replyDisplayRoles,而是从
   * accountable 角色直接解析。实测那两个项目的三身份全部正确解析为自己的展示名。
   * 显性化由生成阶段的 accountable_identity_incomplete warning 承担。
   */
  it("does not block generation for dangling replyDisplayRoles when both accountable identities exist", () => {
    const result = completenessOf([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["assistant_account"] }),
      IP,
      ASSISTANT,
    ]);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("still blocks when an accountable identity is missing: that collapses IP and assistant", () => {
    const result = completenessOf([
      role({ id: "peer", displayRole: "同处境读者", replyDisplayRoles: ["项目主创"] }),
      IP,
    ]);
    expect(result.complete).toBe(false);
    expect(result.missing.some((item) => item.startsWith("role_model.accountable"))).toBe(true);
  });
});
