import {
  PROJECT_BLUEPRINT_MODULE_KEYS,
  type CommentUtteranceMode,
  type ContentPrototype,
  type ProjectBlueprintModuleKey,
  type ProjectBlueprintSourceRef,
  type ProjectBlueprintSourceStatus,
  type ProjectClaimRule,
  type ProjectCreativeBlueprint,
  type ProjectKnowledgeMapEntry,
  type ProjectScenarioFamily,
  type ResolvedGenerationConfig,
} from "./types.js";

const SOURCE_STATUSES = new Set<ProjectBlueprintSourceStatus>([
  "supplied_fact", "approved_observation", "inference", "hypothesis", "unknown",
]);
const PROTOTYPES = new Set<ContentPrototype>([
  "narrow_request", "live_moment", "expectation_reversal", "process_log",
  "outcome_observation", "retrospective_update", "relationship_moment", "option_comparison",
]);
const AUDIENCE_STAGES = new Set<ResolvedGenerationConfig["task"]["audienceStage"]>([
  "discovering", "collecting", "comparing", "hesitating", "ready",
]);
const UTTERANCE_MODES = new Set<CommentUtteranceMode>([
  "direct_question", "shared_concern", "experience_fragment", "counterexample",
  "social_reaction", "detail_spotter", "knowledge_translation", "identity_route", "service_answer",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = "", max = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function strings(value: unknown, maxItems = 100, maxChars = 1_000): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function sourceRef(value: unknown, fallback: ProjectBlueprintSourceStatus = "hypothesis"): ProjectBlueprintSourceRef {
  const data = record(value);
  const statusValue = text(data.status ?? data.sourceStatus) as ProjectBlueprintSourceStatus;
  return {
    status: SOURCE_STATUSES.has(statusValue) ? statusValue : fallback,
    evidenceIds: strings(data.evidenceIds, 100, 300),
    ...(text(data.note, "", 1_000) ? { note: text(data.note, "", 1_000) } : {}),
  };
}

function stages(value: unknown): ResolvedGenerationConfig["task"]["audienceStage"][] {
  return strings(value, 5, 50).filter((item): item is ResolvedGenerationConfig["task"]["audienceStage"] =>
    AUDIENCE_STAGES.has(item as ResolvedGenerationConfig["task"]["audienceStage"]));
}

function targetChars(value: unknown): [number, number] {
  if (!Array.isArray(value)) return [4, 30];
  const min = Number(value[0]);
  const max = Number(value[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [4, 30];
  const lower = Math.max(1, Math.min(120, Math.round(min)));
  return [lower, Math.max(lower, Math.min(240, Math.round(max)))];
}

function normalizeKnowledgeMap(raw: unknown): ProjectKnowledgeMapEntry[] {
  const data = record(raw);
  const items = Array.isArray(data.entries) ? data.entries : Array.isArray(raw) ? raw : [];
  const purposes = new Set<ProjectKnowledgeMapEntry["purpose"]>([
    "project_fact", "domain_note", "dynamic_information", "boundary", "reference_style", "unknown",
  ]);
  return items.map(record).map((item, index) => {
    const purposeValue = text(item.purpose) as ProjectKnowledgeMapEntry["purpose"];
    return {
      id: text(item.id, `knowledge_${index + 1}`, 200),
      sourceName: text(item.sourceName ?? item.filename, `source_${index + 1}`, 500),
      ...(text(item.section, "", 500) ? { section: text(item.section, "", 500) } : {}),
      purpose: purposes.has(purposeValue) ? purposeValue : "unknown",
      factEligible: item.factEligible === true,
      source: sourceRef(item.source, item.factEligible === true ? "supplied_fact" : "unknown"),
    };
  }).slice(0, 500);
}

function normalizeScenarioFamilies(raw: unknown): ProjectScenarioFamily[] {
  const data = record(raw);
  const items = Array.isArray(data.families) ? data.families : [];
  return items.map(record).map((item, index) => {
    const prototypeValue = text(item.prototype) as ContentPrototype;
    return {
      id: text(item.id, `scenario_${index + 1}`, 200),
      label: text(item.label, `场景 ${index + 1}`, 300),
      prototype: PROTOTYPES.has(prototypeValue) ? prototypeValue : "narrow_request",
      applicableStages: stages(item.applicableStages).length ? stages(item.applicableStages) : [...AUDIENCE_STAGES],
      hostIdentityCues: strings(item.hostIdentityCues),
      lifeContexts: strings(item.lifeContexts),
      timeAnchors: strings(item.timeAnchors),
      settings: strings(item.settings),
      triggers: strings(item.triggers),
      observableActions: strings(item.observableActions),
      frictions: strings(item.frictions),
      emotionalAftertastes: strings(item.emotionalAftertastes),
      imageMoments: strings(item.imageMoments),
      prohibitedUnsupportedHistories: strings(item.prohibitedUnsupportedHistories),
      source: sourceRef(item.source, "hypothesis"),
    };
  }).filter((item) => item.id && item.label).slice(0, 100);
}

const SERVICE_MODELS = new Set<NonNullable<ProjectCreativeBlueprint["roleModel"]["serviceModel"]>>([
  "one_time", "recurring", "mixed",
]);

function normalizeRoles(raw: unknown): ProjectCreativeBlueprint["roleModel"] {
  const data = record(raw);
  const items = Array.isArray(data.roles) ? data.roles : [];
  const roles = items.map(record).map((item, index) => ({
    id: text(item.id, `role_${index + 1}`, 200),
    displayRole: text(item.displayRole, `角色 ${index + 1}`, 300),
    relationToHost: text(item.relationToHost, "与发布者存在可解释的互动关系", 500),
    identityCues: strings(item.identityCues),
    situationCues: strings(item.situationCues),
    motives: strings(item.motives),
    knowledgePosition: text(item.knowledgePosition, "只知道公开内容和自身处境", 1_000),
    speechPatterns: strings(item.speechPatterns),
    lexicalCues: strings(item.lexicalCues),
    interactionHooks: strings(item.interactionHooks),
    permittedContributions: strings(item.permittedContributions),
    utteranceModes: strings(item.utteranceModes, 9, 100)
      .filter((mode): mode is CommentUtteranceMode => UTTERANCE_MODES.has(mode as CommentUtteranceMode)),
    replyDisplayRoles: strings(item.replyDisplayRoles),
    targetChars: targetChars(item.targetChars),
    accountable: item.accountable === true,
    source: sourceRef(item.source, "hypothesis"),
  })).filter((item) => item.displayRole).slice(0, 100);
  const serviceModelValue = text(data.serviceModel) as ProjectCreativeBlueprint["roleModel"]["serviceModel"];
  return {
    hostVoiceTraits: strings(data.hostVoiceTraits),
    hostSpeechMarkers: strings(data.hostSpeechMarkers),
    roles,
    ...(serviceModelValue && SERVICE_MODELS.has(serviceModelValue) ? { serviceModel: serviceModelValue } : {}),
  };
}

function normalizeClaimPolicy(raw: unknown): ProjectCreativeBlueprint["claimPolicy"] {
  const data = record(raw);
  const claimTypes = new Set<ProjectClaimRule["claimType"]>([
    "price", "identity", "credential", "schedule", "outcome", "causality", "suitability", "location", "historical_action", "other",
  ]);
  const handling = new Set<ProjectClaimRule["handling"]>(["block", "qualify", "verify"]);
  const rules = (Array.isArray(data.rules) ? data.rules : []).map(record).map((item, index) => {
    const claimTypeValue = text(item.claimType) as ProjectClaimRule["claimType"];
    const handlingValue = text(item.handling) as ProjectClaimRule["handling"];
    return {
      id: text(item.id, `claim_${index + 1}`, 200),
      label: text(item.label, `声明规则 ${index + 1}`, 300),
      claimType: claimTypes.has(claimTypeValue) ? claimTypeValue : "other",
      terms: strings(item.terms),
      requiresEvidence: item.requiresEvidence !== false,
      allowedEvidenceStatuses: strings(item.allowedEvidenceStatuses, 5, 100)
        .filter((status): status is ProjectBlueprintSourceStatus => SOURCE_STATUSES.has(status as ProjectBlueprintSourceStatus)),
      dynamic: item.dynamic === true,
      handling: handling.has(handlingValue) ? handlingValue : "verify",
      source: sourceRef(item.source, "inference"),
    } satisfies ProjectClaimRule;
  }).slice(0, 100);
  return {
    rules,
    prohibitedClaims: strings(data.prohibitedClaims),
    dynamicInformation: strings(data.dynamicInformation),
    unknownHandling: strings(data.unknownHandling),
  };
}

export function normalizeProjectCreativeBlueprint(input: {
  projectId: string;
  sourceFingerprint: string;
  moduleRevisions: Partial<Record<ProjectBlueprintModuleKey, string>>;
  modules: Partial<Record<ProjectBlueprintModuleKey, unknown>>;
}): ProjectCreativeBlueprint {
  const domain = record(input.modules.domain_model);
  const audience = record(input.modules.audience_model);
  const audienceItems = Array.isArray(audience.states) ? audience.states : [];
  const language = record(input.modules.surface_language);
  return {
    schemaVersion: "1.0",
    projectId: input.projectId,
    sourceFingerprint: input.sourceFingerprint,
    moduleRevisions: Object.fromEntries(PROJECT_BLUEPRINT_MODULE_KEYS.map((key) => [key, input.moduleRevisions[key] ?? "missing"])) as Record<ProjectBlueprintModuleKey, string>,
    knowledgeMap: normalizeKnowledgeMap(input.modules.knowledge_map),
    domainModel: {
      projectNoun: text(domain.projectNoun),
      industry: text(domain.industry),
      domain: text(domain.domain ?? domain.industry),
      objects: strings(domain.objects),
      actions: strings(domain.actions),
      concepts: strings(domain.concepts),
      decisionTasks: strings(domain.decisionTasks),
      vocabulary: strings(domain.vocabulary),
    },
    audienceModel: {
      states: audienceItems.map(record).map((item, index) => ({
        id: text(item.id, `audience_${index + 1}`, 200),
        label: text(item.label, `读者状态 ${index + 1}`, 300),
        stages: stages(item.stages).length ? stages(item.stages) : ["collecting"] as ResolvedGenerationConfig["task"]["audienceStage"][],
        goals: strings(item.goals),
        constraints: strings(item.constraints),
        knowledgeState: text(item.knowledgeState, "仍在补充信息", 1_000),
        hesitationReasons: strings(item.hesitationReasons),
        actionConditions: strings(item.actionConditions),
        source: sourceRef(item.source, "inference"),
      })).slice(0, 100),
    },
    scenarioModel: { families: normalizeScenarioFamilies(input.modules.scenario_model) },
    roleModel: normalizeRoles(input.modules.role_model),
    claimPolicy: normalizeClaimPolicy(input.modules.claim_policy),
    surfaceLanguage: {
      registerDescription: text(language.registerDescription, "自然、具体、符合当前项目读者的日常表达", 2_000),
      preferredTerms: strings(language.preferredTerms),
      optionalColloquialisms: strings(language.optionalColloquialisms),
      prohibitedCliches: strings(language.prohibitedCliches),
      antiCopyRules: strings(language.antiCopyRules),
    },
  };
}

/**
 * 双号运营的两个可追责公开身份(IP 本人 + 公开助理)。
 *
 * 规格要求 `exactly 2 accountable=true public identities`,且其他角色的
 * replyDisplayRoles 必须指向其中之一。但完整性检查此前只看 roles 非空,于是
 * 不合规的 role_model 能一路通过审批进入生成,直到 forcedReplyDisplayRole
 * 兜底成通用「项目助理」才在产物里暴露。
 *
 * 实测 12 份 role_model:5 份 accountable 数量不达标(0 个或 1 个)、8 份的
 * replyDisplayRoles 指向未定义角色且多为内部 id(host_account / role_IP /
 * assistant_account / role_01)。后果是同一账号在评论区出现多个名字,
 * 且 IP 与助理身份塌缩(实测毛毛驿站 11 条 org_answer 全部落在 staff)。
 */
const ACCOUNTABLE_PUBLIC_IDENTITY_COUNT = 2;

export function projectBlueprintCompleteness(blueprint: ProjectCreativeBlueprint): { complete: boolean; missing: string[] } {
  const missing: string[] = PROJECT_BLUEPRINT_MODULE_KEYS.filter((key) => blueprint.moduleRevisions[key] === "missing");
  if (!blueprint.domainModel.projectNoun) missing.push("domain_model.projectNoun");
  if (!blueprint.audienceModel.states.length) missing.push("audience_model.states");
  if (!blueprint.scenarioModel.families.length) missing.push("scenario_model.families");
  if (!blueprint.roleModel.roles.length) missing.push("role_model.roles");
  const roles = blueprint.roleModel.roles;
  if (roles.length) {
    const accountable = roles.filter((role) => role.accountable && role.displayRole);
    const accountableNames = new Set(accountable.map((role) => role.displayRole));
    if (accountableNames.size !== ACCOUNTABLE_PUBLIC_IDENTITY_COUNT) {
      missing.push(
        `role_model.accountable（双号运营需要恰好 ${ACCOUNTABLE_PUBLIC_IDENTITY_COUNT} 个可追责公开身份：IP 本人与公开助理，当前 ${accountableNames.size} 个）`,
      );
    }
    // replyDisplayRoles 必须是 accountable 的 displayRole,不能是内部 id。
    const dangling = [...new Set(
      roles.flatMap((role) => role.replyDisplayRoles ?? []).filter((name) => name && !accountableNames.has(name)),
    )];
    if (dangling.length) {
      missing.push(`role_model.replyDisplayRoles（指向未定义的可追责身份：${dangling.slice(0, 4).join("、")}）`);
    }
  }
  return { complete: missing.length === 0, missing };
}
