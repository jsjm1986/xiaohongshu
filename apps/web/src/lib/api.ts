import type {
  AnalysisTask,
  ApiList,
  AuditEntry,
  AppSettings,
  ContentPreset,
  CoverageRecord,
  EnsureReviewedFormulaDefaultsResult,
  FormulaVersion,
  FormulaCalculationResult,
  GenerateInput,
  GenerationJob,
  ImageAsset,
  InformationGap,
  KnowledgeEvidenceDocument,
  KnowledgeEvidenceSection,
  KnowledgeFile,
  OpportunityBatch,
  Project,
  PromptTemplate,
  ProjectBlueprintModule,
  ProjectIntelligence,
  RegistrationRequest,
  ResolvedConfigPreview,
  ResearchCalibrationProposal,
  ResearchClaim,
  ResearchDatasetSnapshot,
  ResearchEvidenceSource,
  ResearchExperiment,
  ResearchExperimentResult,
  ResearchOverview,
  ResearchReleaseManifest,
  ExpressionStrategy,
  StyleProfile,
  SystemUser,
  TopicOpportunity,
  User,
  WorkspaceMember,
  WorkspaceApiKey,
} from "../types";
import { gapPayload, opportunityPayload } from "./metric-payload";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

const cookieValue = (name: string) =>
  document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";

let csrfToken =
  sessionStorage.getItem("content-agent-csrf") ||
  decodeURIComponent(cookieValue("ca_csrf"));

// The API never wraps responses in a { data: T } envelope — endpoints return the
// business object or array directly. The old unwrap unconditionally stripped any
// top-level `data` key, which silently corrupted business objects that legitimately
// carry one (e.g. topic-opportunity / strategy mappers return `data: storedData`),
// returning the inner payload without an `id`. Pass the body through unchanged.
const unwrap = <T>(value: T | { data: T }): T => value as T;

const normalizeList = <T>(value: T[] | ApiList<T>): ApiList<T> => {
  if (Array.isArray(value)) return { items: value, total: value.length };
  return value;
};

type JsonRecord = Record<string, unknown>;

const normalizeUser = (raw: JsonRecord): User => ({
  id: String(raw.id || ""),
  username: String(raw.username || ""),
  displayName: String(raw.displayName || raw.username || "用户"),
  role: String(
    raw.role ||
      (raw.systemRole === "admin"
        ? "系统管理员"
        : raw.workspaceRole || raw.systemRole) ||
      "成员",
  ),
  mustChangePassword: Boolean(raw.mustChangePassword),
  // 原始字段透传,不做显示转换;role 才是展示用字段。
  systemRole: typeof raw.systemRole === "string" ? raw.systemRole : undefined,
  workspaceRole: typeof raw.workspaceRole === "string" ? raw.workspaceRole : undefined,
  userKind: raw.userKind === "saas" || raw.userKind === "research" ? raw.userKind : undefined,
});

const normalizeProject = (raw: JsonRecord): Project => {
  const profile =
    raw.profile && typeof raw.profile === "object"
      ? (raw.profile as JsonRecord)
      : {};
  const rawGenerationDefaults =
    raw.generationDefaults && typeof raw.generationDefaults === "object" && !Array.isArray(raw.generationDefaults)
      ? raw.generationDefaults as JsonRecord
      : profile.generationDefaults && typeof profile.generationDefaults === "object" && !Array.isArray(profile.generationDefaults)
        ? profile.generationDefaults as JsonRecord
        : profile.generation_defaults && typeof profile.generation_defaults === "object" && !Array.isArray(profile.generation_defaults)
          ? profile.generation_defaults as JsonRecord
          : {};
  const projectTextList = (value: unknown): string | string[] | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string");
      return items.length ? items : undefined;
    }
    return undefined;
  };
  const generationDefaults: NonNullable<Project["generationDefaults"]> = {
    audienceStage: typeof rawGenerationDefaults.audienceStage === "string"
      ? rawGenerationDefaults.audienceStage
      : typeof rawGenerationDefaults.audience_stage === "string" ? rawGenerationDefaults.audience_stage : undefined,
    entryPoint: typeof rawGenerationDefaults.entryPoint === "string"
      ? rawGenerationDefaults.entryPoint
      : typeof rawGenerationDefaults.entry === "string"
        ? rawGenerationDefaults.entry
        : typeof rawGenerationDefaults.entry_route === "string" ? rawGenerationDefaults.entry_route : undefined,
    city: typeof rawGenerationDefaults.city === "string" ? rawGenerationDefaults.city : undefined,
    doctor: typeof rawGenerationDefaults.doctor === "string"
      ? rawGenerationDefaults.doctor
      : typeof rawGenerationDefaults.person === "string" ? rawGenerationDefaults.person : undefined,
    mustInclude: projectTextList(rawGenerationDefaults.mustInclude ?? rawGenerationDefaults.mustMention ?? rawGenerationDefaults.must_mention),
    forbidden: projectTextList(rawGenerationDefaults.forbidden),
  };
  return {
    ...(raw as unknown as Project),
    id: String(raw.id || ""),
    name: String(raw.name || "未命名项目"),
    description: typeof raw.description === "string" ? raw.description : "",
    domain: String(raw.domain || profile.domain || ""),
    cities: Array.isArray(raw.cities)
      ? (raw.cities as string[])
      : Array.isArray(profile.cities)
        ? (profile.cities as string[])
        : [],
    doctors: Array.isArray(raw.doctors)
      ? (raw.doctors as Project["doctors"])
      : Array.isArray(profile.doctors)
        ? (profile.doctors as Project["doctors"])
        : [],
    generationDefaults: Object.values(generationDefaults).some((value) => value !== undefined)
      ? generationDefaults
      : undefined,
  };
};

const normalizeKnowledge = (raw: JsonRecord): KnowledgeFile => ({
  ...(raw as unknown as KnowledgeFile),
  id: String(raw.id || ""),
  projectId: String(raw.projectId || ""),
  name: String(raw.name || raw.filename || "未命名文件"),
  size: Number(raw.size ?? raw.bytes ?? 0),
  kind: (() => {
    const value = String(
      raw.kind || raw.category || raw.evidenceStatus || "",
    ).toLowerCase();
    if (/prohibit|forbidden|禁止/u.test(value)) return "禁止表达";
    if (/case|sample|案例|样本/u.test(value)) return "案例样本";
    if (/method|formula|方法|公式/u.test(value)) return "方法论推理";
    if (/hypothesis|猜想/u.test(value)) return "猜想";
    if (/inference|推理/u.test(value)) return "方法论推理";
    if (/unknown|未知|不足/u.test(value)) return "信息不足";
    if (/observed|核验|已知/u.test(value)) return "已知事实";
    return "用户观点";
  })() as KnowledgeFile["kind"],
  status: (raw.status || "ready") as KnowledgeFile["status"],
});

const normalizeEvidenceSection = (raw: JsonRecord): KnowledgeEvidenceSection => ({
  evidenceId: String(raw.evidenceId || ""),
  sectionId: String(raw.sectionId || ""),
  heading: String(raw.heading || ""),
  excerpt: String(raw.excerpt || ""),
  charLength: Number(raw.charLength ?? 0),
  kind: String(raw.kind || ""),
  evidenceStatus: String(raw.evidenceStatus || ""),
  caveats: stringList(raw.caveats),
});

const normalizeEvidenceDocument = (raw: JsonRecord): KnowledgeEvidenceDocument => ({
  id: String(raw.id || ""),
  path: String(raw.path || ""),
  title: String(raw.title || raw.path || ""),
  kind: String(raw.kind || ""),
  evidenceStatus: String(raw.evidenceStatus || ""),
  sections: Array.isArray(raw.sections)
    ? raw.sections.map((item) => normalizeEvidenceSection(recordValue(item)))
    : [],
});

const normalizePreset = (raw: JsonRecord): ContentPreset => ({
  id: String(raw.id || ""),
  projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
  name: String(raw.name || "未命名预设"),
  description: String(raw.description || ""),
  source:
    raw.source === "built-in" || raw.source === "builtin" || raw.builtIn === true
      ? "built-in"
      : "project",
  isDefault: Boolean(raw.isDefault ?? raw.default),
  values: (raw.values || raw.overrides || raw.config || {}) as Record<string, unknown>,
  createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
  updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
});

const recordValue = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => {
    if (typeof item === "string" || typeof item === "number") return String(item);
    const record = recordValue(item);
    return String(record.text || record.fact || record.label || record.name || record.message || record.question || record.title || "");
  }).filter(Boolean) : [];

/** Preserve null for unknown metrics; never coerce an unknown metric to 0. */
const nullableNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeIntelligence = (raw: JsonRecord | undefined, projectId: string): ProjectIntelligence => {
  if (!raw) return { projectId, status: "missing" };
  const map = recordValue(raw.map);
  const resourceStatus = String(raw.approvalStatus || raw.status || "draft");
  const status: ProjectIntelligence["status"] =
    resourceStatus === "approved" ? "ready"
      : resourceStatus === "stale" ? "stale"
        : resourceStatus === "rejected" ? "rejected"
          : resourceStatus === "failed" ? "failed"
            : "draft";
  const categories = Array.isArray(map.categories)
    ? map.categories.map((item, index) => {
        const value = recordValue(item);
        return {
          id: String(value.id || `category-${index + 1}`),
          name: String(value.name || value.label || `分类 ${index + 1}`),
          description: typeof value.description === "string" ? value.description : undefined,
          gapCount: typeof value.gapCount === "number" ? value.gapCount : undefined,
        };
      })
    : undefined;
  return {
    id: String(raw.id || "") || undefined,
    projectId: String(raw.projectId || projectId),
    status,
    resourceStatus,
    approvalStatus: resourceStatus,
    entity: String(map.entity || map.domain || map.projectName || "") || undefined,
    industry: String(map.industry || map.projectSummary || "") || undefined,
    subdomains: stringList(map.subdomains),
    categories,
    knowledgeFingerprint: String(raw.sourceFingerprint || "") || undefined,
    analyzedAt: String(raw.updatedAt || raw.createdAt || "") || undefined,
    staleReasons: stringList(map.staleReasons),
    error: typeof raw.error === "string" ? raw.error : undefined,
    version: typeof raw.version === "number" ? raw.version : Number(raw.version || 0) || undefined,
    map,
  };
};

const normalizeBlueprintModule = (raw: JsonRecord): ProjectBlueprintModule => ({
  id: String(raw.id || ""),
  projectId: String(raw.projectId || ""),
  intelligenceId: String(raw.intelligenceId || "") || undefined,
  moduleKey: String(raw.moduleKey || "domain_model") as ProjectBlueprintModule["moduleKey"],
  version: Number(raw.version || 0),
  status: (["draft", "approved", "rejected", "stale"].includes(String(raw.status))
    ? String(raw.status)
    : "draft") as ProjectBlueprintModule["status"],
  contentRevision: String(raw.contentRevision || ""),
  sourceFingerprint: String(raw.sourceFingerprint || "") || undefined,
  data: recordValue(raw.data),
  updatedAt: String(raw.updatedAt || "") || undefined,
  approvedAt: String(raw.approvedAt || "") || undefined,
});

const normalizeGap = (raw: JsonRecord): InformationGap => {
  const data = recordValue(raw.data);
  const status = String(raw.approvalStatus || raw.status || "draft");
  const answer = String(raw.answer || data.answer || "");
  const source = String(data.sourceType || (raw.sourceAnalysisId ? "domain_inference" : "user"));
  const allowedSources = new Set(["domain_inference", "project_knowledge", "image_observation", "user", "external_signal"]);
  const answerability = String(data.answerability || (answer ? "approved" : "verifiable"));
  return {
    id: String(raw.id || ""),
    projectId: String(raw.projectId || ""),
    label: String(raw.label || data.label || raw.title || raw.question || "未命名缺口"),
    question: String(raw.question || data.question || raw.title || ""),
    description: String(raw.description || data.description || "") || undefined,
    category: String(raw.category || data.category || "未分类"),
    stages: stringList(raw.audienceStages || data.stages || data.audienceStages),
    decisionTasks: stringList(data.decisionTasks),
    sourceType: (allowedSources.has(source) ? source : "user") as InformationGap["sourceType"],
    evidenceStatus: String(raw.evidenceStatus || (status === "approved" ? "approved" : "unapproved")),
    answerability: (["approved", "verifiable", "unknown"].includes(answerability) ? answerability : "verifiable") as InformationGap["answerability"],
    answer: answer || undefined,
    evidenceIds: stringList(raw.evidenceIds || data.evidenceIds),
    frameworks: stringList(data.frameworks),
    boundaries: stringList(data.boundaries).length ? stringList(data.boundaries) : raw.boundary ? [String(raw.boundary)] : [],
    // Singular boundary (Cref v1.1, data_json top level); falls back to the legacy array form.
    boundary: [raw.boundary, data.boundary].find((value): value is string => typeof value === "string" && Boolean(value)) || stringList(data.boundaries)[0] || undefined,
    priority: Number(raw.priority ?? data.priority ?? 50),
    enabled: raw.enabled !== false && data.enabled !== false,
    locked: raw.locked === true || data.locked === true,
    userEdited: data.userEdited === true,
    importance: nullableNumber(raw.importance ?? data.importance),
    decisionLeverage: nullableNumber(raw.decisionLeverage ?? data.decisionLeverage),
    proofability: nullableNumber(raw.proofability ?? data.proofability),
    metricStatus: raw.metricStatus === "complete" || raw.metricStatus === "unknown"
      ? raw.metricStatus
      : undefined,
    unknownMetrics: stringList(raw.unknownMetrics),
    reviewRequired: raw.reviewRequired === true,
    sourceStatus: ["supplied_fact", "inference", "hypothesis", "unknown"].includes(String(data.sourceStatus))
      ? (data.sourceStatus as InformationGap["sourceStatus"])
      : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    status,
    approvalStatus: status,
  };
};

const normalizeStrategy = (raw: JsonRecord): ExpressionStrategy => {
  const data = recordValue(raw.data);
  const status = String(raw.approvalStatus || raw.status || "draft");
  const imageRole = String(raw.imageRole || data.imageRole || "other");
  const allowedImageRoles = new Set(["cover", "evidence", "scene", "diagram", "before_after", "other"]);
  return {
    id: String(raw.id || ""),
    projectId: String(raw.projectId || ""),
    name: String(raw.name || raw.title || "未命名策略"),
    description: String(raw.description || data.description || ""),
    routePolicy: String(data.routePolicy || raw.openingMode || "标签与标题建立清晰入口"),
    imagePolicy: String(data.imagePolicy || raw.imageRole || "图片承担场景和可见信息"),
    titlePolicy: String(data.titlePolicy || raw.openingMode || "标题对应具体问题"),
    bodyPolicy: String(data.bodyPolicy || raw.bodyRole || "正文回答核心问题并说明边界"),
    commentPolicy: String(data.commentPolicy || raw.commentMode || "评论展开残余信息缺口"),
    deploymentPolicy: String(data.deploymentPolicy || "以透明、可追责身份发布"),
    compatibleGapTypes: stringList(data.compatibleGapTypes),
    incompatibleConditions: stringList(data.incompatibleConditions),
    randomizableDimensions: stringList(data.randomizableDimensions),
    weight: Number(data.weight ?? raw.selectionWeight ?? 60),
    enabled: raw.enabled !== false && data.enabled !== false,
    locked: raw.locked === true || data.locked === true,
    source: (data.source === "builtin" || data.source === "user" ? data.source : raw.sourceAnalysisId ? "ai" : "user") as ExpressionStrategy["source"],
    evidenceStatus: String(raw.evidenceStatus || "unapproved"),
    status,
    approvalStatus: status,
    label: String(raw.label || data.label || raw.name || "未命名策略"),
    openingMode: String(raw.openingMode || data.openingMode || data.routePolicy || "reader_question"),
    narrativeMode: String(raw.narrativeMode || data.narrativeMode || data.routePolicy || "question_framework_boundary"),
    bodyRole: String(raw.bodyRole || data.bodyRole || data.bodyPolicy || "minimum_sufficient_information"),
    imageRole: (allowedImageRoles.has(imageRole) ? imageRole : "other") as ExpressionStrategy["imageRole"],
    commentMode: String(raw.commentMode || data.commentMode || data.commentPolicy || "gap_completion"),
    voice: String(raw.voice || data.voice || raw.description || "克制、真实、条件化"),
    sequence: stringList(raw.sequence || data.sequence),
    targetChannels: stringList(raw.targetChannels || data.targetChannels),
    selectionWeight: Number(raw.selectionWeight ?? data.selectionWeight ?? data.weight ?? 0.6),
    randomization: recordValue(raw.randomization || data.randomization) as ExpressionStrategy["randomization"],
    prototype: ([
      "narrow_request", "live_moment", "expectation_reversal", "process_log",
      "outcome_observation", "retrospective_update", "relationship_moment", "option_comparison",
    ].includes(String(raw.prototype || data.prototype))
      ? String(raw.prototype || data.prototype)
      : undefined) as ExpressionStrategy["prototype"],
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
};

const normalizeOpportunity = (raw: JsonRecord): TopicOpportunity => {
  const data = recordValue(raw.data);
  const ranking = recordValue(raw.ranking || raw.opportunityRanking || data.ranking || data.opportunityRanking);
  const heuristicRaw = recordValue(raw.heuristic || raw.descriptor || ranking.heuristic || ranking.descriptor || data.heuristic || data.descriptor);
  const componentRaw = Array.isArray(raw.components)
    ? raw.components
    : Array.isArray(ranking.components)
      ? ranking.components
      : Array.isArray(data.components)
        ? data.components
        : [];
  const inputSourcesRaw = recordValue(raw.inputSources || ranking.inputSources || data.inputSources);
  const recentCoverageRaw = recordValue(raw.recentCoverage || ranking.recentCoverage || data.recentCoverage);
  const policyRaw = recordValue(raw.policy || ranking.policy || data.policy);
  const task = recordValue(raw.task || data.task);
  const approvalStatus = String(raw.approvalStatus || raw.status || "draft");
  const eligibilityStatus = String(raw.eligibilityStatus || data.status || "eligible");
  const answerability = String(data.answerability || (approvalStatus === "approved" ? "approved" : "verifiable"));
  const recommendedEntryPoint = String(
    raw.recommendedEntryPoint
      || raw.entryPoint
      || raw.entry
      || data.recommendedEntryPoint
      || data.entryPoint
      || data.entry
      || task.entry
      || "",
  ) || undefined;
  const simpleTextList = (value: unknown): string | string[] | undefined => {
    if (typeof value === "string") return value;
    const items = stringList(value);
    return items.length ? items : undefined;
  };
  const finiteNumber = (value: unknown): number | null => {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const heuristic = typeof heuristicRaw.id === "string"
    && heuristicRaw.weightsCalibrated === false
    && heuristicRaw.causal === false
    && heuristicRaw.notF28 === true
    ? {
      id: heuristicRaw.id,
      version: String(heuristicRaw.version || ""),
      weights: Object.fromEntries(
        Object.entries(recordValue(heuristicRaw.weights))
          .map(([key, value]) => [key, finiteNumber(value)])
          .filter((entry): entry is [string, number] => entry[1] !== null),
      ),
      criticalMetrics: stringList(heuristicRaw.criticalMetrics),
      weightsCalibrated: false as const,
      causal: false as const,
      notF28: true as const,
      scoreSemantics: heuristicRaw.scoreSemantics === "ordinal_noncausal_heuristic" ? "ordinal_noncausal_heuristic" as const : undefined,
      scoreRange: Array.isArray(heuristicRaw.scoreRange) && heuristicRaw.scoreRange[0] === 0 && heuristicRaw.scoreRange[1] === 1 ? [0, 1] as const : undefined,
    }
    : undefined;
  const components = componentRaw.map((value) => recordValue(value)).map((component) => ({
    metric: String(component.metric || "unknown"),
    rawValue: finiteNumber(component.rawValue),
    transformedValue: finiteNumber(component.transformedValue),
    transformation: String(component.transformation || "identity"),
    weight: finiteNumber(component.weight) ?? Number.NaN,
    contribution: finiteNumber(component.contribution),
    source: component.source,
  }));
  const recentCoverage = Object.keys(recentCoverageRaw).length
    ? {
      status: recentCoverageRaw.status === "provided" ? "provided" as const : "unknown" as const,
      count: finiteNumber(recentCoverageRaw.count),
      similarity: finiteNumber(recentCoverageRaw.similarity),
      source: recentCoverageRaw.source,
    }
    : undefined;
  const effectiveEligibility = ["eligible", "ineligible", "review_required"].includes(String(raw.effectiveEligibility || ranking.effectiveEligibility))
    ? String(raw.effectiveEligibility || ranking.effectiveEligibility) as TopicOpportunity["effectiveEligibility"]
    : undefined;
  const legacyInputRaw = recordValue(raw.legacyInputScore || ranking.legacyInputScore);
  const legacyInputValue = finiteNumber(legacyInputRaw.value);
  const policyValues = {
    minProofability: finiteNumber(policyRaw.minProofability),
    maxRisk: finiteNumber(policyRaw.maxRisk),
    recentPenaltyWeight: finiteNumber(policyRaw.recentPenaltyWeight),
    reuseCooldown: finiteNumber(policyRaw.reuseCooldown),
  };
  const policy = Object.values(policyValues).every((value) => value !== null)
    ? policyValues as TopicOpportunity["policy"]
    : undefined;
  return {
    id: String(raw.id || ""),
    projectId: String(raw.projectId || ""),
    title: String(raw.title || raw.topic || "未命名选题"),
    coreQuestion: String(data.coreQuestion || data.question || raw.title || ""),
    summary: String(data.summary || raw.angle || raw.rationale || ""),
    gapIds: stringList(raw.gapIds || data.gapIds),
    readerStages: raw.audienceStage ? [String(raw.audienceStage)] : stringList(data.readerStages || data.audienceStages),
    decisionTask: String(data.decisionTask || "补全决策信息"),
    whyValuable: String(data.whyValuable || raw.rationale || "补全读者正在寻找的信息"),
    projectAngle: String(data.projectAngle || raw.angle || "") || undefined,
    answerability: (["approved", "verifiable", "unknown"].includes(answerability) ? answerability : "verifiable") as TopicOpportunity["answerability"],
    evidenceIds: stringList(raw.evidenceIds || data.evidenceIds),
    unknowns: stringList(data.unknowns),
    boundaries: stringList(raw.boundaries || data.boundaries),
    suggestedImageAssetIds: stringList(raw.imageAssetIds || data.suggestedImageAssetIds || data.imageAssetIds),
    strategyId: String(raw.strategyId || data.strategyId || "") || undefined,
    compatibleStrategyIds: stringList(data.compatibleStrategyIds),
    coverageStatus: (["new", "recent", "cooldown"].includes(String(data.coverageStatus)) ? data.coverageStatus : undefined) as TopicOpportunity["coverageStatus"],
    status: approvalStatus,
    approvalStatus,
    eligibilityStatus,
    collectionStatus: (["active", "collected", "archived"].includes(String(raw.collectionStatus))
      ? String(raw.collectionStatus)
      : "active") as TopicOpportunity["collectionStatus"],
    batchId: raw.batchId ? String(raw.batchId) : null,
    reviewRequired: raw.reviewRequired === true || ranking.reviewRequired === true || data.reviewRequired === true,
    unknownMetrics: stringList(raw.unknownMetrics || ranking.unknownMetrics || data.unknownMetrics),
    relevance: finiteNumber(raw.relevance ?? data.relevance),
    importance: finiteNumber(raw.importance ?? data.importance),
    proofability: finiteNumber(raw.proofability ?? data.proofability),
    decisionLeverage: finiteNumber(raw.decisionLeverage ?? data.decisionLeverage),
    novelty: finiteNumber(raw.novelty ?? data.novelty),
    cognitiveCost: finiteNumber(raw.cognitiveCost ?? data.cognitiveCost),
    risk: finiteNumber(raw.risk ?? data.risk),
    audienceStage: String(raw.audienceStage || data.audienceStage || "") || undefined,
    entry: (["search", "recommendation", "profile", "return_visit"].includes(String(raw.entry ?? data.entry))
      ? String(raw.entry ?? data.entry)
      : undefined) as TopicOpportunity["entry"],
    rank: finiteNumber(raw.rank ?? ranking.rank),
    heuristic,
    components,
    inputSources: Object.keys(inputSourcesRaw).length ? inputSourcesRaw : undefined,
    reviewReasons: stringList(raw.reviewReasons || ranking.reviewReasons || data.reviewReasons),
    effectiveEligibility,
    unboundedBaseScore: finiteNumber(raw.unboundedBaseScore ?? ranking.unboundedBaseScore),
    baseScore: finiteNumber(raw.baseScore ?? ranking.baseScore),
    recentPenalty: finiteNumber(raw.recentPenalty ?? ranking.recentPenalty),
    finalScore: finiteNumber(raw.finalScore ?? ranking.finalScore),
    recentCoverage,
    scoreSemantics: typeof (raw.scoreSemantics || ranking.scoreSemantics) === "string" ? String(raw.scoreSemantics || ranking.scoreSemantics) : undefined,
    policy,
    reasons: stringList(raw.reasons || ranking.reasons || data.reasons),
    legacyInputScore: legacyInputValue !== null && legacyInputRaw.used === false && legacyInputRaw.semantics === "legacy_heuristic"
      ? { value: legacyInputValue, used: false, semantics: "legacy_heuristic" as const }
      : undefined,
    score: finiteNumber(raw.score ?? data.score) ?? undefined,
    angle: typeof raw.angle === "string" ? raw.angle : undefined,
    rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
    recommendedEntryPoint,
    entryPoint: recommendedEntryPoint,
    city: String(raw.city || data.city || task.city || "") || undefined,
    doctor: String(raw.doctor || raw.person || data.doctor || data.person || task.doctor || "") || undefined,
    mustInclude: simpleTextList(raw.mustInclude ?? raw.mustMention ?? data.mustInclude ?? data.mustMention ?? task.mustMention),
    forbidden: simpleTextList(raw.forbidden ?? data.forbidden ?? task.forbidden),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
  };
};

const normalizeImageAnalysis = (raw: JsonRecord): ImageAsset["analysis"] => {
  const observations = recordValue(raw.observations);
  const qualityRaw = recordValue(raw.quality || observations.quality);
  const quality = {
    clarity: nullableNumber(qualityRaw.clarity),
    relevance: nullableNumber(qualityRaw.relevance),
    textLegibility: nullableNumber(qualityRaw.textLegibility),
  };
  const hasQuality = Object.keys(qualityRaw).length > 0;
  return {
    ocr: stringList(raw.visibleText || observations.ocr || observations.visibleText),
    visibleFacts: stringList(raw.observedFacts || observations.visibleFacts || observations.observedFacts || observations.observations),
    scene: String(raw.altText || observations.scene || observations.visualSummary || "") || undefined,
    imageType: String(observations.imageType || observations.type || stringList(raw.roles)[0] || "") || undefined,
    suggestedRoles: stringList(raw.roles || observations.suggestedRoles || observations.suggestedUses),
    safeClaims: stringList(observations.safeClaims),
    forbiddenInferences: stringList(raw.inferredSignals || raw.unknowns || observations.forbiddenInferences || observations.uncertainties),
    privacyFlags: stringList(raw.safetyFlags || observations.privacyFlags || observations.risks),
    suitableGapIds: stringList(observations.suitableGapIds),
    approvedFields: stringList(observations.approvedFields),
    quality: hasQuality ? quality : undefined,
    qualityStatus: raw.qualityStatus === "complete" || raw.qualityStatus === "unknown"
      ? raw.qualityStatus
      : undefined,
    unknownQualityMetrics: stringList(raw.unknownQualityMetrics),
  };
};

const normalizeImage = (raw: JsonRecord): ImageAsset => {
  const analyses = Array.isArray(raw.analyses) ? raw.analyses.map(recordValue) : [];
  const latest = analyses[0];
  const analysisStatus = String(raw.analysisStatus || latest?.approvalStatus || latest?.status || "not_analyzed");
  const latestApprovalStatus = String(latest?.approvalStatus || latest?.status || analysisStatus);
  return {
    id: String(raw.id || raw.assetId || ""),
    projectId: String(raw.projectId || ""),
    filename: String(raw.filename || "未命名图片"),
    mediaType: String(raw.mediaType || "image/jpeg"),
    bytes: Number(raw.bytes || 0),
    sha256: String(raw.sha256 || ""),
    width: Number(raw.width || 0) || undefined,
    height: Number(raw.height || 0) || undefined,
    status: analysisStatus === "failed" ? "failed" : analysisStatus === "not_analyzed" ? "uploaded" : "ready",
    approved: analysisStatus === "approved" || latestApprovalStatus === "approved",
    analysis: latest ? normalizeImageAnalysis(latest) : undefined,
    latestAnalysisId: String(raw.latestAnalysisId || latest?.id || "") || undefined,
    analysisStatus,
    approvalStatus: latestApprovalStatus,
    contentUrl: String(raw.contentUrl || "") || undefined,
    previewUrl: String(raw.contentUrl || "") || undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
};

const inferImageRole = (policy = ""): NonNullable<ExpressionStrategy["imageRole"]> => {
  if (/证据|可见|核验/u.test(policy)) return "evidence";
  if (/前后|对比/u.test(policy)) return "before_after";
  if (/场景|生活|环境/u.test(policy)) return "scene";
  if (/图解|示意|流程|清单/u.test(policy)) return "diagram";
  if (/封面|入口/u.test(policy)) return "cover";
  return "other";
};

const strategyPayload = (input: Partial<ExpressionStrategy>) => {
  const openingMode = input.openingMode || input.routePolicy || "reader_question";
  const narrativeMode = input.narrativeMode || input.routePolicy || input.description || "question_framework_boundary";
  const bodyRole = input.bodyRole || input.bodyPolicy || "minimum_sufficient_information";
  const commentMode = input.commentMode || input.commentPolicy || "gap_completion";
  const imageRole = input.imageRole || inferImageRole(input.imagePolicy);
  const sequence = input.sequence?.length
    ? input.sequence
    : [openingMode, narrativeMode, bodyRole, commentMode];
  const data = {
    ...input,
    label: input.label || input.name,
    openingMode,
    narrativeMode,
    bodyRole,
    imageRole,
    commentMode,
    voice: input.voice || input.description || "克制、真实、条件化",
    sequence,
    targetChannels: input.targetChannels?.length ? input.targetChannels : ["H", "N.imageBrief", "N.title", "N.body", "Cref"],
    selectionWeight: input.selectionWeight ?? input.weight ?? 0.6,
    randomization: input.randomization || { enabled: true, weight: input.weight ?? 0.6 },
    id: undefined,
    projectId: undefined,
    status: undefined,
    approvalStatus: undefined,
    createdAt: undefined,
    updatedAt: undefined,
  };
  return { name: input.name, description: input.description, data };
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const activeCsrf = decodeURIComponent(cookieValue("ca_csrf")) || csrfToken;
  if (activeCsrf && activeCsrf !== csrfToken) {
    csrfToken = activeCsrf;
    sessionStorage.setItem("content-agent-csrf", activeCsrf);
  }
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      Accept: "application/json",
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(activeCsrf &&
      options.method &&
      !["GET", "HEAD"].includes(options.method.toUpperCase())
        ? { "X-CSRF-Token": activeCsrf }
        : {}),
      ...options.headers,
    },
  });

  const body =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      (body as { message?: string } | undefined)?.message ||
      (response.status === 401
        ? "登录已失效，请重新登录"
        : `请求失败 (${response.status})`);
    throw new ApiError(
      Array.isArray(message) ? message.join("；") : message,
      response.status,
      body,
    );
  }
  return unwrap(body as T | { data: T });
}

export const api = {
  auth: {
    me: async () => {
      csrfToken ||= decodeURIComponent(cookieValue("ca_csrf"));
      const result = await request<JsonRecord | { user: JsonRecord }>(
        "/api/auth/me",
      );
      return normalizeUser(
        ("user" in result ? result.user : result) as JsonRecord,
      );
    },
    login: async (username: string, password: string) => {
      const result = await request<User | { user: User; csrfToken?: string }>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
      );
      if ("user" in result) {
        csrfToken = result.csrfToken || "";
        if (csrfToken) sessionStorage.setItem("content-agent-csrf", csrfToken);
        return normalizeUser(result.user as unknown as JsonRecord);
      }
      return normalizeUser(result as unknown as JsonRecord);
    },
    logout: async () => {
      const result = await request<void>("/api/auth/logout", {
        method: "POST",
      });
      csrfToken = "";
      sessionStorage.removeItem("content-agent-csrf");
      return result;
    },
    changePassword: (currentPassword: string, newPassword: string) =>
      request<void>("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
  },
  workspaces: {
    list: () => request<Array<{ id: string; name: string }>>("/api/workspaces"),
    members: (workspaceId: string) =>
      request<WorkspaceMember[]>(`/api/workspaces/${workspaceId}/members`),
    setMember: (
      workspaceId: string,
      userId: string,
      input: Pick<WorkspaceMember, "role" | "grants" | "denies">,
    ) =>
      request<WorkspaceMember>(
        `/api/workspaces/${workspaceId}/members/${userId}`,
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
      ),
    removeMember: (workspaceId: string, userId: string) =>
      request<void>(`/api/workspaces/${workspaceId}/members/${userId}`, {
        method: "DELETE",
      }),
    apiKeys: (workspaceId: string) =>
      request<WorkspaceApiKey[]>(`/api/workspaces/${workspaceId}/api-keys`),
    createApiKey: (workspaceId: string, name: string) =>
      request<WorkspaceApiKey>(`/api/workspaces/${workspaceId}/api-keys`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    revokeApiKey: (workspaceId: string, keyId: string) =>
      request<void>(`/api/workspaces/${workspaceId}/api-keys/${keyId}`, {
        method: "DELETE",
      }),
  },
  register: (input: {
    username: string;
    password: string;
    organizationName: string;
    phone: string;
  }) =>
    request<{ ok: true }>("/api/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  admin: {
    users: () => request<SystemUser[]>("/api/admin/users"),
    createUser: (input: {
      username: string;
      password: string;
      systemRole: "admin" | "user";
      userKind?: "research" | "saas";
    }) =>
      request<SystemUser>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    registrations: (status = "pending") =>
      request<RegistrationRequest[]>(
        `/api/admin/registrations?status=${encodeURIComponent(status)}`,
      ),
    approveRegistration: (id: string) =>
      request<{ userId: string; workspaceId: string }>(
        `/api/admin/registrations/${id}/approve`,
        { method: "POST" },
      ),
    rejectRegistration: (id: string, reason: string) =>
      request<{ ok: true }>(`/api/admin/registrations/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  },
  audit: {
    list: (workspaceId: string, limit = 20) =>
      request<AuditEntry[]>(
        `/api/audit?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
      ),
  },
  projects: {
    list: async () => {
      const result = normalizeList(
        await request<JsonRecord[] | ApiList<JsonRecord>>("/api/projects"),
      );
      return { items: result.items.map(normalizeProject), total: result.total };
    },
    create: async (
      input: Pick<Project, "name" | "description" | "domain"> & {
        workspaceId?: string;
      },
    ) =>
      normalizeProject(
        await request<JsonRecord>("/api/projects", {
          method: "POST",
          body: JSON.stringify({ ...input, profile: { domain: input.domain } }),
        }),
      ),
    update: async (id: string, input: Partial<Project>) =>
      normalizeProject(
        await request<JsonRecord>(`/api/projects/${id}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      ),
    remove: (id: string) =>
      request<void>(`/api/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  },
  knowledge: {
    list: async (projectId: string) => {
      const result = normalizeList(
        await request<JsonRecord[] | ApiList<JsonRecord>>(
          `/api/knowledge?projectId=${encodeURIComponent(projectId)}`,
        ),
      );
      return {
        items: result.items.map(normalizeKnowledge),
        total: result.total,
      };
    },
    upload: (projectId: string, file: File, category: string, kind: string) => {
      const body = new FormData();
      body.append("projectId", projectId);
      body.append("file", file);
      body.append("category", category);
      body.append("evidenceStatus", kind);
      return request<JsonRecord>("/api/knowledge", {
        method: "POST",
        body,
      }).then(normalizeKnowledge);
    },
    create: (projectId: string, filename: string, content: string, category: string, kind: string) =>
      request<JsonRecord>("/api/knowledge", {
        method: "POST",
        body: JSON.stringify({ projectId, filename, content, category, evidenceStatus: kind }),
      }).then(normalizeKnowledge),
    remove: (id: string) =>
      request<void>(`/api/knowledge/${id}`, { method: "DELETE" }),
    get: async (id: string) => {
      const raw = await request<JsonRecord>(`/api/knowledge/${encodeURIComponent(id)}`);
      return { ...normalizeKnowledge(raw), content: typeof raw.content === "string" ? raw.content : "" };
    },
    evidenceSections: async (projectId: string) => {
      const raw = await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/knowledge/evidence-sections`);
      return {
        documents: Array.isArray(raw.documents)
          ? raw.documents.map((item) => normalizeEvidenceDocument(recordValue(item)))
          : [],
        warnings: stringList(raw.warnings),
      };
    },
  },
  intelligence: {
    get: async (projectId: string) => {
      const rows = await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/intelligence`);
      return normalizeIntelligence(rows[0], projectId);
    },
    analyze: async (projectId: string, force = false) => {
      const result = await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/intelligence/analyze`, {
        method: "POST",
        body: JSON.stringify({ force }),
      });
      return {
        intelligence: normalizeIntelligence(recordValue(result.intelligence), projectId),
        blueprintModules: Array.isArray(result.blueprintModules) ? result.blueprintModules.map((item) => normalizeBlueprintModule(recordValue(item))) : [],
        informationGaps: Array.isArray(result.informationGaps) ? result.informationGaps.map((item) => normalizeGap(recordValue(item))) : [],
        expressionStrategies: Array.isArray(result.expressionStrategies) ? result.expressionStrategies.map((item) => normalizeStrategy(recordValue(item))) : [],
        topicOpportunities: Array.isArray(result.topicOpportunities) ? result.topicOpportunities.map((item) => normalizeOpportunity(recordValue(item))) : [],
      };
    },
    approve: async (projectId: string, id: string) =>
      normalizeIntelligence(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/intelligence/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      }), projectId),
    tasks: {
      list: (projectId: string) =>
        request<AnalysisTask[]>(`/api/projects/${encodeURIComponent(projectId)}/intelligence/analysis-tasks`),
      get: (projectId: string, taskId: string) =>
        request<AnalysisTask>(`/api/projects/${encodeURIComponent(projectId)}/intelligence/analysis-tasks/${encodeURIComponent(taskId)}`),
    },
  },
  blueprintModules: {
    list: async (projectId: string) =>
      (await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/blueprint-modules`)).map(normalizeBlueprintModule),
    update: async (projectId: string, id: string, data: Record<string, unknown>) =>
      normalizeBlueprintModule(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/blueprint-modules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      })),
    approve: async (projectId: string, id: string) =>
      normalizeBlueprintModule(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/blueprint-modules/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      })),
  },
  informationGaps: {
    list: async (projectId: string) =>
      normalizeList((await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/information-gaps`)).map(normalizeGap)),
    create: async (projectId: string, input: Partial<InformationGap>) =>
      normalizeGap(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/information-gaps`, {
        method: "POST",
        body: JSON.stringify(gapPayload(input)),
      })),
    update: async (projectId: string, id: string, input: Partial<InformationGap>) =>
      normalizeGap(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/information-gaps/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(gapPayload(input)),
      })),
    approve: async (projectId: string, id: string) =>
      normalizeGap(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/information-gaps/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      })),
    remove: (projectId: string, id: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/information-gaps/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  expressionStrategies: {
    list: async (projectId: string) =>
      normalizeList((await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/expression-strategies`)).map(normalizeStrategy)),
    create: async (projectId: string, input: Partial<ExpressionStrategy>) =>
      normalizeStrategy(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/expression-strategies`, {
        method: "POST",
        body: JSON.stringify(strategyPayload(input)),
      })),
    update: async (projectId: string, id: string, input: Partial<ExpressionStrategy>) =>
      normalizeStrategy(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/expression-strategies/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(strategyPayload(input)),
      })),
    approve: async (projectId: string, id: string) =>
      normalizeStrategy(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/expression-strategies/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      })),
    remove: (projectId: string, id: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/expression-strategies/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  opportunities: {
    list: async (projectId: string) =>
      normalizeList((await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities`)).map(normalizeOpportunity)),
    refresh: async (projectId: string, userGuidance?: string) => {
      const result = await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/refresh`, {
        method: "POST",
        body: JSON.stringify(userGuidance ? { userGuidance } : {}),
      });
      const list = Array.isArray(result.topicOpportunities)
        ? result.topicOpportunities.map((item) => normalizeOpportunity(recordValue(item)))
        : [];
      return normalizeList(list);
    },
    setCollection: async (projectId: string, id: string, status: "active" | "collected" | "archived") =>
      normalizeOpportunity(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/${encodeURIComponent(id)}/collection`, {
        method: "POST",
        body: JSON.stringify({ status }),
      })),
    listBatches: (projectId: string) =>
      request<OpportunityBatch[]>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunity-batches`),
    update: async (projectId: string, id: string, input: Partial<TopicOpportunity>) =>
      normalizeOpportunity(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(opportunityPayload(input)),
      })),
    approve: async (projectId: string, id: string) =>
      normalizeOpportunity(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      })),
    remove: (projectId: string, id: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  promptTemplates: {
    list: (projectId: string) =>
      request<PromptTemplate[]>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates`),
    create: (projectId: string, label: string, guidance: string) =>
      request<PromptTemplate>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates`, {
        method: "POST",
        body: JSON.stringify({ label, guidance }),
      }),
    remove: (projectId: string, templateId: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates/${encodeURIComponent(templateId)}`, {
        method: "DELETE",
      }),
  },
  imageAssets: {
    list: async (projectId: string) => {
      const rows = await request<JsonRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/image-assets`);
      const detailed = await Promise.all(rows.map((row) => request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(String(row.id || row.assetId || ""))}`).catch(() => row)));
      return normalizeList(detailed.map(normalizeImage));
    },
    upload: async (projectId: string, file: File) => {
      const body = new FormData();
      body.append("file", file);
      return normalizeImage(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets`, { method: "POST", body }));
    },
    analyze: async (projectId: string, id: string) => {
      await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return normalizeImage(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}`));
    },
    approve: async (projectId: string, id: string, analysisId?: string) => {
      if (!analysisId) throw new ApiError("图片还没有可确认的分析版本", 400);
      await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}/analyses/${encodeURIComponent(analysisId)}/approve`, {
        method: "POST",
        body: JSON.stringify({ status: "approved" }),
      });
      return normalizeImage(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}`));
    },
    updateAnalysis: async (projectId: string, id: string, analysisId: string, quality: { clarity: number | null; relevance: number | null; textLegibility: number | null }) => {
      // Each metric is sent explicitly (null = unknown). The backend merges
      // quality by key and folds null via optionalRatio(null) === null, so an
      // unset metric must be sent as explicit null (not omitted) to become
      // unknown; user-set 0..1 values pass through verbatim.
      await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}/analyses/${encodeURIComponent(analysisId)}`, {
        method: "PATCH",
        body: JSON.stringify({ quality }),
      });
      return normalizeImage(await request<JsonRecord>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}`));
    },
    remove: (projectId: string, id: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}`, { method: "DELETE" }),
    contentUrl: (projectId: string, id: string) =>
      `/api/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(id)}/content`,
  },
  coverage: {
    list: (projectId: string) =>
      request<CoverageRecord[]>(`/api/projects/${encodeURIComponent(projectId)}/coverage`),
  },
  research: {
    overview: (projectId: string) =>
      request<ResearchOverview>(`/api/projects/${encodeURIComponent(projectId)}/research/overview`),
    createClaim: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchClaim>(`/api/projects/${encodeURIComponent(projectId)}/research/claims`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewClaim: (projectId: string, id: string, status: string) =>
      request<ResearchClaim>(`/api/projects/${encodeURIComponent(projectId)}/research/claims/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    linkEvidence: (projectId: string, claimId: string, input: Record<string, unknown>) =>
      request<Record<string, unknown>>(`/api/projects/${encodeURIComponent(projectId)}/research/claims/${encodeURIComponent(claimId)}/evidence-links`, {
        method: "POST", body: JSON.stringify(input),
      }),
    createSource: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchEvidenceSource>(`/api/projects/${encodeURIComponent(projectId)}/research/evidence-sources`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewSource: (projectId: string, id: string, status: string) =>
      request<ResearchEvidenceSource>(`/api/projects/${encodeURIComponent(projectId)}/research/evidence-sources/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    createDataset: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchDatasetSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/research/datasets`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewDataset: (projectId: string, id: string, status: string) =>
      request<ResearchDatasetSnapshot>(`/api/projects/${encodeURIComponent(projectId)}/research/datasets/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    createExperiment: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchExperiment>(`/api/projects/${encodeURIComponent(projectId)}/research/experiments`, {
        method: "POST", body: JSON.stringify(input),
      }),
    transitionExperiment: (projectId: string, id: string, status: string) =>
      request<ResearchExperiment>(`/api/projects/${encodeURIComponent(projectId)}/research/experiments/${encodeURIComponent(id)}/transition`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    createExperimentResult: (projectId: string, id: string, input: Record<string, unknown>) =>
      request<ResearchExperimentResult>(`/api/projects/${encodeURIComponent(projectId)}/research/experiments/${encodeURIComponent(id)}/results`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewExperimentResult: (projectId: string, id: string, status: string) =>
      request<ResearchExperimentResult>(`/api/projects/${encodeURIComponent(projectId)}/research/experiment-results/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    createCalibration: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchCalibrationProposal>(`/api/projects/${encodeURIComponent(projectId)}/research/calibrations`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewCalibration: (projectId: string, id: string, status: string) =>
      request<ResearchCalibrationProposal>(`/api/projects/${encodeURIComponent(projectId)}/research/calibrations/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    createRelease: (projectId: string, input: Record<string, unknown>) =>
      request<ResearchReleaseManifest>(`/api/projects/${encodeURIComponent(projectId)}/research/releases`, {
        method: "POST", body: JSON.stringify(input),
      }),
    reviewRelease: (projectId: string, id: string, status: string) =>
      request<ResearchReleaseManifest>(`/api/projects/${encodeURIComponent(projectId)}/research/releases/${encodeURIComponent(id)}/review`, {
        method: "POST", body: JSON.stringify({ status }),
      }),
    activateRelease: (projectId: string, id: string) =>
      request<ResearchReleaseManifest>(`/api/projects/${encodeURIComponent(projectId)}/research/releases/${encodeURIComponent(id)}/activate`, {
        method: "POST", body: JSON.stringify({}),
      }),
  },
  formulas: {
    list: async (projectId: string) =>
      normalizeList(
        await request<FormulaVersion[] | ApiList<FormulaVersion>>(
          `/api/formulas?projectId=${encodeURIComponent(projectId)}`,
        ),
      ),
    create: (input: Partial<FormulaVersion> & { parentId?: string }) =>
      request<FormulaVersion>("/api/formulas", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    activate: (id: string) =>
      request<FormulaVersion>(`/api/formulas/${id}/activate`, {
        method: "POST",
      }),
    ensureReviewedDefaults: (projectId: string) =>
      request<EnsureReviewedFormulaDefaultsResult>(
        `/api/formulas/projects/${encodeURIComponent(projectId)}/ensure-reviewed-defaults`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    calculate: (versionId: string, formulaId: string, variables: Record<string, number | string | boolean | null>) =>
      request<FormulaCalculationResult>(
        `/api/formulas/${encodeURIComponent(versionId)}/${encodeURIComponent(formulaId)}/calculate`,
        {
          method: "POST",
          body: JSON.stringify({ variables }),
        },
      ),
  },
  parameters: {
    schema: (projectId?: string) =>
      request<unknown>(
        `/api/generation-parameters/schema${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),
  },
  presets: {
    list: async (projectId: string) => {
      const result = normalizeList(
        await request<JsonRecord[] | ApiList<JsonRecord>>(
          `/api/projects/${projectId}/presets`,
        ),
      );
      return { items: result.items.map(normalizePreset), total: result.total };
    },
    create: async (
      projectId: string,
      input: Omit<ContentPreset, "id" | "projectId" | "source">,
    ) =>
      normalizePreset(
        await request<JsonRecord>(`/api/projects/${projectId}/presets`, {
          method: "POST",
          body: JSON.stringify({
            ...input,
            values:
              input.values.parameters && typeof input.values.parameters === "object"
                ? input.values.parameters
                : input.values,
          }),
        }),
      ),
    update: async (
      projectId: string,
      id: string,
      input: Partial<ContentPreset>,
    ) =>
      normalizePreset(
        await request<JsonRecord>(`/api/projects/${projectId}/presets/${id}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      ),
    remove: (projectId: string, id: string) =>
      request<void>(`/api/projects/${projectId}/presets/${id}`, {
        method: "DELETE",
      }),
    copy: async (
      projectId: string,
      id: string,
      body?: { name?: string; description?: string },
    ) =>
      normalizePreset(
        await request<JsonRecord>(
          `/api/projects/${projectId}/presets/${id}/copy`,
          { method: "POST", body: JSON.stringify(body ?? {}) },
        ),
      ),
    setDefault: async (projectId: string, id: string) =>
      normalizePreset(
        await request<JsonRecord>(
          `/api/projects/${projectId}/presets/${id}/default`,
          { method: "POST" },
        ),
      ),
  },
  config: {
    resolve: (projectId: string, input: GenerateInput) =>
      request<ResolvedConfigPreview>(
        `/api/projects/${projectId}/resolve-config`,
        { method: "POST", body: JSON.stringify(input) },
      ),
  },
  styleProfile: {
    get: (projectId: string) =>
      request<StyleProfile>(`/api/projects/${projectId}/style-profile`),
    update: (projectId: string, input: Partial<StyleProfile>) =>
      request<StyleProfile>(`/api/projects/${projectId}/style-profile`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
  },
  generations: {
    list: async (projectId?: string) =>
      normalizeList(
        await request<GenerationJob[] | ApiList<GenerationJob>>(
          `/api/generations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
        ),
      ),
    get: (id: string) => request<GenerationJob>(`/api/generations/${id}`),
    create: (input: GenerateInput) =>
      request<GenerationJob>("/api/generations", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    revise: (id: string, candidateId: string, instruction: string) =>
      request<GenerationJob>(`/api/generations/${id}/revise`, {
        method: "POST",
        body: JSON.stringify({ candidateId, instruction }),
      }),
    exportUrl: (
      id: string,
      candidateId: string,
      format: "markdown" | "json" | "docx" | "pdf",
    ) =>
      `/api/generations/${encodeURIComponent(id)}/candidates/${encodeURIComponent(candidateId)}/export?format=${format}`,
  },
  settings: {
    get: (workspaceId?: string) =>
      request<AppSettings>(
        `/api/settings${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
      ),
    update: (
      input: Partial<AppSettings> & { apiKey?: string; workspaceId?: string; clearApiKey?: boolean },
    ) =>
      request<AppSettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
  },
};
