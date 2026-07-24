import { createHash } from "node:crypto";

import {
  applyGenerationPatch,
  channelsForIssues,
  commentThreadFunction,
  diagnosticsFromValidation,
  evaluateGapCoverageRealization,
  mergeCrefPatchById,
  parseGenerationDraft,
  parseGenerationPatch,
  parseJsonObject,
  parseStagedCommentCopy,
  parseStagedCoreCopy,
  type StagedCommentCopy,
  validateGenerationDraft,
} from "./content.js";
import { buildProductionArtifacts } from "./artifacts.js";
import {
  deriveCandidateSeed,
  FORMULA_EXECUTION_POLICY_DIGEST,
  FORMULA_EXECUTION_POLICY_VERSION,
  formulaExecutionAudit,
  validateFormulaVersion,
} from "./formula.js";
import {
  buildKnowledgeLedger,
  conservativeEvidenceSupport,
  createSectionEvidenceReferences,
  evidenceIdForSection,
  estimateTokens,
  findSupportingSectionEvidenceIds,
  sectionEvidenceText,
  selectKnowledgeContext,
} from "./knowledge.js";
import type { ModelProvider } from "./model.js";
import { buildParameterDiagnostics, compileGenerationParameters } from "./parameters.js";
import {
  assignCommentDisplayName,
  planTopicOrchestrations,
  rankTopicOpportunities,
  createCoverageSignature,
} from "./planning.js";
import {
  buildRepairPrompt,
  buildStagedCommentGrowthPrompt,
  buildStagedCommentsPrompt,
  buildStagedCorePrompt,
  buildStagedLedgerPrompt,
  renderFormulaInstructions,
} from "./prompt.js";
import { analyzeRevisionDependencies, mergeContentByChannels } from "./revision.js";
import type {
  ContentPackage,
  ContentValidationIssue,
  EvidenceReference,
  FormulaVersion,
  GenerationDraft,
  GenerationInput,
  GenerationResult,
  ImageAssetAnalysis,
  InformationGap,
  KnowledgeContextSelection,
  KnowledgeDocument,
  KnowledgeLedger,
  ParameterImpactReport,
  ParameterResolutionSnapshot,
  OrchestrationPlan,
  OpportunitySelectionAudit,
  PlanningContext,
  ProjectIntelligence,
  ResolvedGenerationConfig,
  RevisionDependencyInput,
  RevisionRecord,
  TopicOpportunity,
} from "./types.js";

const TASK_PROJECT_EVIDENCE_ID = "evidence_task_project";
const PLANNING_CONTEXT_EVIDENCE_ID = "evidence_approved_planning_context";

function imageAnalysisEvidenceId(analysis: ImageAssetAnalysis): string {
  const observed = JSON.stringify({
    assetId: analysis.assetId,
    observedFacts: analysis.observedFacts,
    visibleText: analysis.visibleText,
  });
  return `evidence_image_${createHash("sha256").update(observed, "utf8").digest("hex").slice(0, 20)}`;
}

function imageAnalysisEvidenceReference(analysis: ImageAssetAnalysis): EvidenceReference | undefined {
  if (!analysis.observedFacts.length && !analysis.visibleText.length) return undefined;
  const quote = JSON.stringify({ observedFacts: analysis.observedFacts, visibleText: analysis.visibleText });
  const checksum = createHash("sha256").update(quote, "utf8").digest("hex");
  return {
    id: imageAnalysisEvidenceId(analysis),
    documentId: `image-analysis:${analysis.assetId}`,
    path: `image-analysis/${analysis.assetId}`,
    section: "multimodal observedFacts and visibleText only",
    quote,
    documentChecksum: checksum,
    documentVersion: "image-analysis-v1",
    sectionChecksum: checksum,
    assetId: analysis.assetId,
    kind: "fact",
    evidenceStatus: "observed",
    scope: [`asset:${analysis.assetId}`],
    caveats: ["Only observedFacts and visibleText are citable. inferredSignals and unknowns are not factual evidence."],
  };
}

export interface ContentGenerationEngineOptions {
  modelProvider?: ModelProvider;
  now?: () => Date;
  systemPromptTokenEstimate?: number;
}

export interface ReviseContentInput {
  package: ContentPackage;
  instruction: string;
  explicitChannels?: RevisionDependencyInput["explicitChannels"];
  formulaVersion: FormulaVersion;
  knowledge: KnowledgeDocument[];
  claims?: GenerationInput["claims"];
  parameterSelection?: GenerationInput["parameterSelection"];
  imageAnalyses?: ImageAssetAnalysis[];
  planningContext?: PlanningContext;
}

export interface ReviseContentResult {
  package: ContentPackage;
  dependency: ReturnType<typeof analyzeRevisionDependencies>;
}

export interface GenerationEngine {
  generate(input: GenerationInput): Promise<GenerationResult>;
  revise(input: ReviseContentInput): Promise<ReviseContentResult>;
}

interface CandidateVariation {
  opening: string;
  pacing: string;
  structure: string;
  phrasing: string;
}

const VARIATIONS = {
  opening: ["从具体疑问开场", "从选择难点开场", "从常见误区开场", "从检查清单开场"],
  pacing: ["短句快节奏", "先结论后条件", "场景与解释交替", "逐层递进"],
  structure: ["问题—依据—边界", "经历入口—判断框架—下一步", "误区—核实方法—问答", "清单—反例—条件化建议"],
  phrasing: ["克制直接", "自然口语", "清晰说明", "温和提醒"],
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function variationFor(seed: number, candidateIndex: number): CandidateVariation {
  const next = random(seed);
  const choose = (values: string[], offset: number): string => values[(Math.floor(next() * values.length) + candidateIndex + offset) % values.length] ?? values[0] ?? "自然表达";
  return {
    opening: choose(VARIATIONS.opening, 0),
    pacing: choose(VARIATIONS.pacing, 1),
    structure: choose(VARIATIONS.structure, 2),
    phrasing: choose(VARIATIONS.phrasing, 3),
  };
}

function runtimeConfigChecks(config: ResolvedGenerationConfig): void {
  if (config.generation.candidateCount !== 3) throw new Error("The complete-content engine always generates exactly three candidates.");
  if (!Number.isInteger(config.generation.baseSeed)) throw new Error("generation.baseSeed must be an integer.");
  if (config.generation.maxRepairAttempts < 0 || config.generation.maxRepairAttempts > 2) throw new Error("maxRepairAttempts must be between zero and two.");
  if (config.content.bodyMinChars < 0 || config.content.bodyMaxChars < config.content.bodyMinChars) throw new Error("Invalid body character range.");
  if (config.content.hashtagMin < 0 || config.content.hashtagMax < config.content.hashtagMin) throw new Error("Invalid hashtag range.");
  if (config.content.commentThreadMin < 0 || config.content.commentThreadMax < config.content.commentThreadMin) throw new Error("Invalid comment thread range.");
}

function filterKnowledge(config: ResolvedGenerationConfig, knowledge: KnowledgeDocument[]): KnowledgeDocument[] {
  const excluded = new Set(config.knowledge.excludedFileIds);
  const selected = new Set(config.knowledge.selectedFileIds);
  return knowledge.filter((document) => {
    if (excluded.has(document.id)) return false;
    // Reference corpora calibrate validators and research views only. Even an
    // explicit UI selection must not turn sample wording into writer context.
    if (document.metadata.scope.includes("style-analysis-only")) return false;
    if (selected.size > 0) return selected.has(document.id);
    return true;
  });
}

function buildContext(
  config: ResolvedGenerationConfig,
  version: FormulaVersion,
  documents: KnowledgeDocument[],
  systemPromptTokens = 900,
): KnowledgeContextSelection {
  const formulaText = renderFormulaInstructions(version, config.formula.enabledFormulaIds);
  return selectKnowledgeContext({
    documents: filterKnowledge(config, documents),
    query: [
      config.task.theme,
      config.task.goal,
      config.task.audienceStage,
      config.task.entry,
      config.task.city ?? "",
      config.task.doctor ?? "",
      ...config.informationWindow.gaps,
      ...config.task.mustMention,
    ],
    budget: {
      maxInputTokens: config.knowledge.maxInputTokens,
      systemPromptTokens,
      formulaPromptTokens: estimateTokens(formulaText),
      outputReserveTokens: config.knowledge.outputReserveTokens,
      safetyMarginTokens: config.knowledge.safetyMarginTokens,
    },
    forceProgressive: config.knowledge.mode === "progressive",
  });
}

function taskProjectEvidence(config: ResolvedGenerationConfig): EvidenceReference {
  const disclosed = {
    projectId: config.project.id,
    projectName: config.project.name,
    domain: config.project.domain,
    productPoints: config.project.productPoints,
    organizationPoints: config.project.organizationPoints,
    doctors: config.project.doctors,
    taskTheme: config.task.theme,
    city: config.task.city,
    doctorName: config.task.doctor,
  };
  const quote = JSON.stringify(disclosed);
  const checksum = createHash("sha256").update(quote, "utf8").digest("hex");
  return {
    id: TASK_PROJECT_EVIDENCE_ID,
    documentId: `task:${config.project.id}`,
    path: "task.project",
    section: "explicit user-supplied project fields",
    quote,
    documentChecksum: checksum,
    documentVersion: "task-input-v1",
    sectionChecksum: checksum,
    kind: "fact",
    evidenceStatus: "user_supplied",
    scope: ["current-generation-task"],
    caveats: ["This source proves only that the field was explicitly supplied for this task; it does not independently verify the claim."],
  };
}

function generationEvidenceReferences(
  config: ResolvedGenerationConfig,
  documents: KnowledgeDocument[],
  context: KnowledgeContextSelection,
  planningContext?: GenerationInput["planningContext"],
  approvedImageAnalyses: ImageAssetAnalysis[] = planningContext?.imageAnalyses ?? [],
): EvidenceReference[] {
  const planningQuote = planningContext ? JSON.stringify({
    projectIntelligence: planningContext.projectIntelligence,
    informationGaps: planningContext.informationGaps,
    opportunities: planningContext.opportunities,
    expressionStrategies: planningContext.expressionStrategies,
  }) : undefined;
  const planningChecksum = planningQuote
    ? createHash("sha256").update(planningQuote, "utf8").digest("hex")
    : undefined;
  const planningReference: EvidenceReference[] = planningContext && planningQuote && planningChecksum ? [{
    id: PLANNING_CONTEXT_EVIDENCE_ID,
    documentId: `planning:${config.project.id}`,
    path: "planning.approved-context",
    section: "approved structured planning resources",
    quote: planningQuote,
    documentChecksum: planningChecksum,
    documentVersion: "approved-planning-v1",
    sectionChecksum: planningChecksum,
    kind: "fact",
    evidenceStatus: "user_supplied",
    scope: ["current-generation-planning-context"],
    caveats: ["This reference records an approved structured input. Its upstream source status and independent verification still govern each claim."],
  }] : [];
  const imageReferences = approvedImageAnalyses
    .map(imageAnalysisEvidenceReference)
    .filter((reference): reference is EvidenceReference => Boolean(reference));
  return [taskProjectEvidence(config), ...planningReference, ...imageReferences, ...createSectionEvidenceReferences(documents, context)];
}

/**
 * Exact source text used by the post-generation claim validator. A reference
 * ID proves nothing by itself: the cited quote must be a contiguous span of
 * the corresponding value in this map.
 */
function generationEvidenceSources(
  config: ResolvedGenerationConfig,
  documents: KnowledgeDocument[],
  context: KnowledgeContextSelection,
  planningContext?: GenerationInput["planningContext"],
  approvedImageAnalyses: ImageAssetAnalysis[] = planningContext?.imageAnalyses ?? [],
): Record<string, string> {
  return Object.fromEntries(
    generationEvidenceReferences(config, documents, context, planningContext, approvedImageAnalyses)
      .map((reference) => [
        reference.id,
        reference.quote ?? sectionEvidenceText(context, reference.id) ?? "",
      ] as const)
      .filter(([, source]) => source.length > 0),
  );
}

function comparableSpanText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function closestExactSourceSpan(source: string, claim: string): string | undefined {
  const trimmedClaim = claim.trim();
  if (trimmedClaim.length >= 2 && source.includes(trimmedClaim) && conservativeEvidenceSupport(trimmedClaim, trimmedClaim)) return trimmedClaim;
  const withoutAttribution = trimmedClaim
    .replace(/^(?:(?:项目资料|知识库|资料|研究|论文|报告|记录)(?:中)?(?:显示|表明|能确认|确认|记载|披露)?[：:,，]?\s*)+/iu, "")
    .replace(/[。；;]+$/u, "");
  if (withoutAttribution.length >= 2 && source.includes(withoutAttribution)
    && conservativeEvidenceSupport(trimmedClaim, withoutAttribution)) return withoutAttribution;
  const claimComparable = comparableSpanText(trimmedClaim);
  if (claimComparable.length < 4) return undefined;
  const claimPairs = new Set(Array.from({ length: Math.max(0, claimComparable.length - 1) }, (_, index) => claimComparable.slice(index, index + 2)));
  const candidates = source
    .split(/(?<=[。！？!?；;\n])/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && item.length <= 320);
  let best: { quote: string; score: number } | undefined;
  for (const quote of candidates) {
    if (!conservativeEvidenceSupport(trimmedClaim, quote)) continue;
    const comparable = comparableSpanText(quote);
    const pairs = new Set(Array.from({ length: Math.max(0, comparable.length - 1) }, (_, index) => comparable.slice(index, index + 2)));
    const overlap = [...claimPairs].filter((pair) => pairs.has(pair)).length;
    const score = claimPairs.size ? overlap / claimPairs.size : 0;
    if (!best || score > best.score) best = { quote, score };
  }
  return best && best.score >= 0.45 ? best.quote : undefined;
}

function sourceSpansForClaim(
  claim: string,
  evidenceIds: string[],
  evidenceSources: Record<string, string>,
): Array<{ evidenceId: string; quote: string }> {
  for (const evidenceId of evidenceIds) {
    const source = evidenceSources[evidenceId];
    if (!source) continue;
    const quote = closestExactSourceSpan(source, claim);
    if (quote) return [{ evidenceId, quote }];
  }
  return [];
}

function citedEvidenceSnapshot(
  references: EvidenceReference[],
  reasoning: GenerationDraft["reasoning"],
): EvidenceReference[] {
  const spansByEvidence = new Map<string, string[]>();
  for (const span of reasoning.flatMap((item) => item.sourceSpans ?? [])) {
    const spans = spansByEvidence.get(span.evidenceId) ?? [];
    if (span.quote.trim() && !spans.includes(span.quote)) spans.push(span.quote);
    spansByEvidence.set(span.evidenceId, spans);
  }
  return references
    .filter((reference) => spansByEvidence.has(reference.id))
    .map((reference) => {
      const quotedSpans = spansByEvidence.get(reference.id) ?? [];
      return {
        ...reference,
        quote: reference.quote ?? quotedSpans[0],
        quotedSpans,
      };
    });
}

function knowledgeSnapshotFor(
  documents: KnowledgeDocument[],
  context: KnowledgeContextSelection,
): ContentPackage["knowledgeSnapshot"] {
  return {
    mode: context.mode,
    documents: documents
      .filter((document) => context.selectedDocumentIds.includes(document.id))
      .map((document) => ({ id: document.id, path: document.path, checksum: document.checksum, version: document.version })),
    sectionIds: context.sections.map((section) => section.documentId === "generated" ? section.id : evidenceIdForSection(section)),
  };
}

function taskEvidenceSupports(config: ResolvedGenerationConfig, statements: Array<string | undefined>): boolean {
  const source = taskProjectEvidence(config).quote?.normalize("NFKC").replace(/\s+/gu, "") ?? "";
  return statements.some((statement) => {
    const normalized = statement?.trim().normalize("NFKC").replace(/\s+/gu, "") ?? "";
    return normalized.length >= 2 && source.includes(normalized);
  });
}

function planningEvidenceSupports(input: GenerationInput, statements: Array<string | undefined>): boolean {
  if (!input.planningContext) return false;
  const source = JSON.stringify({
    projectIntelligence: input.planningContext.projectIntelligence,
    informationGaps: input.planningContext.informationGaps,
    opportunities: input.planningContext.opportunities,
  }).normalize("NFKC").replace(/\s+/gu, "");
  return statements.some((statement) => {
    const normalized = statement?.trim().normalize("NFKC").replace(/\s+/gu, "") ?? "";
    return normalized.length >= 2 && source.includes(normalized);
  });
}

interface ResolvedGenerationPlanning {
  opportunity: TopicOpportunity;
  opportunitySelectionAudit: OpportunitySelectionAudit;
  gaps: InformationGap[];
  intelligence: ProjectIntelligence;
  imageAnalyses: ImageAssetAnalysis[];
  plans: [OrchestrationPlan, OrchestrationPlan, OrchestrationPlan];
}

function bindGapEvidence(
  gap: InformationGap,
  input: GenerationInput,
  context: KnowledgeContextSelection,
): InformationGap {
  const evidenceFor = (statement: string | undefined): string[] => {
    if (!statement?.trim()) return [];
    const mapped = findSupportingSectionEvidenceIds([statement], context);
    if (taskEvidenceSupports(input.config, [statement])) mapped.push(TASK_PROJECT_EVIDENCE_ID);
    if (planningEvidenceSupports(input, [statement])) mapped.push(PLANNING_CONTEXT_EVIDENCE_ID);
    return [...new Set(mapped)];
  };
  const answerEvidenceIds = evidenceFor(gap.answer);
  const frameworkEvidenceIds = evidenceFor(gap.framework);
  const answer = gap.answer && answerEvidenceIds.length ? gap.answer : undefined;
  const framework = gap.framework && frameworkEvidenceIds.length ? gap.framework : undefined;
  const evidenceIds = [...new Set([
    ...(answer ? answerEvidenceIds : []),
    ...(framework ? frameworkEvidenceIds : []),
  ])];
  const hasProposedAnswer = Boolean(gap.answer?.trim() || gap.framework?.trim());
  return {
    ...gap,
    answer,
    framework,
    evidenceIds,
    proofability: hasProposedAnswer && evidenceIds.length === 0 ? 0 : gap.proofability,
  };
}

function defaultProjectIntelligence(
  config: ResolvedGenerationConfig,
  evidenceIds: string[],
): ProjectIntelligence {
  return {
    projectId: config.project.id,
    industry: config.project.domain,
    domain: config.project.domain,
    projectSummary: `${config.project.name}：${config.task.theme}`,
    verifiedFacts: [...config.project.productPoints, ...config.project.organizationPoints],
    differentiators: [...config.project.productPoints],
    audienceStates: [config.task.audienceStage],
    hardBoundaries: [...config.informationWindow.boundaries],
    prohibitedClaims: [...config.task.forbidden],
    dynamicUnknowns: [],
    evidenceIds,
  };
}

function defaultInformationGaps(
  config: ResolvedGenerationConfig,
  context: KnowledgeContextSelection,
): InformationGap[] {
  const raw = config.informationWindow.gaps.length
    ? config.informationWindow.gaps
    : ["适用条件是什么", "怎样比较不同选择", "哪些信息还需要核验"];
  return raw.map((label, index) => {
    const answer = config.informationWindow.answers[index];
    const framework = config.informationWindow.reusableFrameworks[index];
    const boundary = config.informationWindow.boundaries[index];
    const evidenceFor = (statement: string | undefined): string[] => statement?.trim()
      ? [...new Set([
        ...findSupportingSectionEvidenceIds([statement], context),
        ...(taskEvidenceSupports(config, [statement]) ? [TASK_PROJECT_EVIDENCE_ID] : []),
      ])]
      : [];
    const answerEvidenceIds = evidenceFor(answer);
    const frameworkEvidenceIds = evidenceFor(framework);
    const groundedAnswer = answerEvidenceIds.length ? answer : undefined;
    const groundedFramework = frameworkEvidenceIds.length ? framework : undefined;
    const evidenceIds = [...new Set([...answerEvidenceIds, ...frameworkEvidenceIds])];
    return {
      id: `gap_${index + 1}`,
      label,
      question: label.endsWith("？") || label.endsWith("?") ? label : `${label}？`,
      category: index === 0 ? "decision" : "verification",
      audienceStages: [config.task.audienceStage],
      importance: Math.max(0.5, 0.85 - index * 0.08),
      decisionLeverage: Math.max(0.45, 0.85 - index * 0.1),
      proofability: evidenceIds.length ? 0.75 : answer || framework ? 0 : 0.4,
      answer: groundedAnswer,
      framework: groundedFramework,
      boundary,
      evidenceIds,
      required: index < config.task.mustMention.length,
      preferredChannels: index === 0 ? ["N.body"] : ["N.body", "Cref"],
    };
  });
}

function defaultTopicOpportunity(
  config: ResolvedGenerationConfig,
  gaps: InformationGap[],
): TopicOpportunity {
  const evidenceIds = [...new Set(gaps.flatMap((gap) => gap.evidenceIds))];
  return {
    id: `topic_${createHash("sha256").update(`${config.project.id}:${config.task.theme}`, "utf8").digest("hex").slice(0, 12)}`,
    topic: config.task.theme,
    angle: config.task.goal || "补全会改变选择的关键信息",
    gapIds: gaps.map((gap) => gap.id),
    audienceStage: config.task.audienceStage,
    entry: config.task.entry,
    relevance: 1,
    importance: 0.8,
    proofability: evidenceIds.length ? 0.75 : 0.4,
    novelty: 0.5,
    decisionLeverage: 0.8,
    cognitiveCost: 0.35,
    risk: 0.2,
    evidenceIds,
    boundaries: [...config.informationWindow.boundaries],
    tags: [config.task.theme, config.project.domain],
    imageAssetIds: [],
    status: "eligible",
    rankInputSources: {
      metrics: {
        relevance: { source: "default_policy", sourceRef: "defaultTopicOpportunity.relevance" },
        importance: { source: "default_policy", sourceRef: "defaultTopicOpportunity.importance" },
        proofability: { source: "system_heuristic", sourceRef: "defaultTopicOpportunity.evidenceIds" },
        novelty: { source: "default_policy", sourceRef: "defaultTopicOpportunity.novelty" },
        decisionLeverage: { source: "default_policy", sourceRef: "defaultTopicOpportunity.decisionLeverage" },
        cognitiveCost: { source: "default_policy", sourceRef: "defaultTopicOpportunity.cognitiveCost" },
        risk: { source: "default_policy", sourceRef: "defaultTopicOpportunity.risk" },
      },
      topic: { source: "project", sourceRef: "config.task.theme" },
      gapIds: { source: "system_heuristic", sourceRef: "defaultInformationGaps" },
      status: { source: "default_policy", sourceRef: "defaultTopicOpportunity.status" },
    },
  };
}

/**
 * M3 / component C: selectability lives on the Structural_Validity axis only.
 * A topic opportunity is selectable iff it is structurally valid — not blocked,
 * carries a non-empty topic, and references at least one gap. Predicted-performance
 * signals (the uncalibrated OpportunityRankHeuristicV1 score, proofability/risk
 * thresholds, and unknown/low metrics) are advisory: they order the default
 * presentation but never decide whether a candidate can be selected.
 * (Requirements 5.2, 5.3, 5.4, 5.7.)
 */
function isStructurallySelectable(opportunity: TopicOpportunity): boolean {
  return opportunity.status !== "blocked"
    && opportunity.topic.trim().length > 0
    && opportunity.gapIds.length > 0;
}

function resolveGenerationPlanning(
  input: GenerationInput,
  context: KnowledgeContextSelection,
): ResolvedGenerationPlanning {
  const planning = input.planningContext;
  const evidenceIds = generationEvidenceReferences(input.config, input.knowledge, context, planning).map((reference) => reference.id);
  const intelligence = planning?.projectIntelligence ?? defaultProjectIntelligence(input.config, [TASK_PROJECT_EVIDENCE_ID]);
  let gaps = planning?.informationGaps?.length
    ? structuredClone(planning.informationGaps)
    : defaultInformationGaps(input.config, context);
  gaps = gaps.map((gap) => bindGapEvidence(gap, input, context));
  const suppliedOpportunities = planning?.opportunities ?? [];
  let opportunity: TopicOpportunity;
  let opportunitySelectionAudit: OpportunitySelectionAudit;
  if (planning?.selectedOpportunityId) {
    const selected = suppliedOpportunities.find((item) => item.id === planning.selectedOpportunityId);
    if (!selected) throw new Error(`Selected topic opportunity does not exist: ${planning.selectedOpportunityId}`);
    // An explicitly locked, approved dependency is rejected only when it is
    // structurally invalid. Uncalibrated proofability/risk thresholds must not
    // block it (Requirement 5.7).
    if (!isStructurallySelectable(selected)) {
      throw new Error(`Selected topic opportunity is not structurally selectable (blocked, empty topic, or no referenced gaps): ${planning.selectedOpportunityId}`);
    }
    opportunity = structuredClone(selected);
    opportunitySelectionAudit = {
      selectedOpportunityId: selected.id,
      selectionMode: "explicit_locked",
      rankStatus: "not_applied",
      approvalBasis: "approved_dependency",
      rankNotAppliedReason: "selectedOpportunityId explicitly locked this approved dependency; no rank score was computed or used.",
    };
  } else if (suppliedOpportunities.length) {
    const ranked = rankTopicOpportunities({
      opportunities: suppliedOpportunities,
      recentCoverage: planning?.recentCoverage,
      recentCoverageSource: planning?.recentCoverageSource,
      options: planning?.orchestrationOptions,
      optionsSource: planning?.orchestrationOptionsSource,
    });
    // ranked[] is already in rank order (the uncalibrated heuristic only decides
    // presentation order). The default selection is the first structurally
    // selectable row; a null finalScore (unknown metrics) or a review_required
    // hint never removes a candidate from selection (Requirements 5.2, 5.3).
    const selectedRank = ranked.find((item) => isStructurallySelectable(item.opportunity));
    if (!selectedRank) {
      const rejected = ranked.map((item) => item.opportunity.id);
      const detail = rejected.length ? ` Rejected (blocked, empty topic, or no referenced gaps): ${rejected.join(", ")}.` : "";
      throw new Error(`No structurally selectable topic opportunity was supplied.${detail}`);
    }
    opportunity = structuredClone(selectedRank.opportunity);
    opportunitySelectionAudit = {
      selectedOpportunityId: selectedRank.opportunity.id,
      selectionMode: "heuristic_ranked",
      rankStatus: "applied",
      selectedOpportunityRank: structuredClone(selectedRank),
    };
  } else {
    opportunity = defaultTopicOpportunity(input.config, gaps);
    opportunitySelectionAudit = {
      selectedOpportunityId: opportunity.id,
      selectionMode: "default_policy",
      rankStatus: "not_applied",
      rankNotAppliedReason: "No candidate opportunity set was supplied; Core created the deterministic default opportunity.",
    };
  }
  const knownGapIds = new Set(gaps.map((gap) => gap.id));
  const missing = opportunity.gapIds.filter((id) => !knownGapIds.has(id));
  if (missing.length) throw new Error(`Topic opportunity references missing information gaps: ${missing.join(", ")}`);
  const allowedEvidenceIds = new Set(evidenceIds);
  opportunity = {
    ...opportunity,
    evidenceIds: [...new Set([
      ...opportunity.evidenceIds.filter((id) => allowedEvidenceIds.has(id)),
      ...gaps.filter((gap) => opportunity.gapIds.includes(gap.id)).flatMap((gap) => gap.evidenceIds),
    ])],
  };
  const seeds: [number, number, number] = [0, 1, 2].map((candidateIndex) =>
    deriveCandidateSeed(input.config.generation.baseSeed, input.formulaVersion.digest, input.jobId, candidateIndex),
  ) as [number, number, number];
  const imageAnalyses = structuredClone(planning?.imageAnalyses ?? []).map((analysis) => ({
    ...analysis,
    evidenceIds: [...new Set([
      ...analysis.evidenceIds,
      ...((analysis.observedFacts.length || analysis.visibleText.length) ? [imageAnalysisEvidenceId(analysis)] : []),
    ])],
  }));
  const plans = planTopicOrchestrations({
    opportunity,
    opportunitySelectionAudit,
    gaps,
    imageAnalyses,
    projectIntelligence: intelligence,
    projectBlueprint: planning?.projectBlueprint,
    config: input.config,
    seeds,
    recentCoverage: planning?.recentCoverage,
    options: planning?.orchestrationOptions,
    expressionStrategies: planning?.expressionStrategies,
  });
  return { opportunity, opportunitySelectionAudit, gaps, intelligence, imageAnalyses, plans };
}

function sanitizeText(value: string, forbidden: string[]): string {
  let result = value;
  for (const phrase of forbidden.filter(Boolean)) result = result.replaceAll(phrase, "[已省略]");
  return result;
}

function fitBody(fragments: string[], config: ResolvedGenerationConfig): string {
  const useful = fragments.filter(Boolean).map((fragment) => sanitizeText(fragment, config.task.forbidden));
  const supporting = [
    "这事我也是最近才开始认真看。",
    "主要还是怕影响平时的安排，越刷越拿不准。",
    "有了解的说说真实情况吧。",
  ];
  let source = [...useful];
  let preview = source.join("\n\n");
  for (const sentence of supporting) {
    if ([...preview].length >= config.content.bodyMinChars) break;
    source.push(sentence);
    preview = source.join("\n\n");
  }
  const paragraphTarget = Math.max(1, Math.round(config.parameters?.paragraphTarget ?? 3));
  const bucketCount = Math.min(paragraphTarget, source.length);
  const buckets = Array.from({ length: bucketCount }, () => [] as string[]);
  source.forEach((fragment, index) => buckets[Math.min(bucketCount - 1, Math.floor(index * bucketCount / source.length))]?.push(fragment));
  let body = buckets.map((bucket) => bucket.join(" ")).filter(Boolean).join("\n\n");
  const closing = "有了解的也可以说说。";
  while ([...body].length < config.content.bodyMinChars) body = `${body}${body ? "\n\n" : ""}${closing}`;
  if ([...body].length > config.content.bodyMaxChars) body = [...body].slice(0, config.content.bodyMaxChars).join("").trimEnd();
  return body;
}

function deterministicDraft(
  config: ResolvedGenerationConfig,
  context: KnowledgeContextSelection,
  ledger: KnowledgeLedger,
  candidateIndex: 0 | 1 | 2,
  variation: CandidateVariation,
  impactReport: ParameterImpactReport,
  orchestrationPlan?: OrchestrationPlan,
  topicOpportunity?: TopicOpportunity,
  evidenceSources: Record<string, string> = {},
): GenerationDraft {
  const topic = topicOpportunity?.topic ?? config.task.theme;
  const sectionEvidenceIds = context.sections
    .filter((section) => section.documentId !== "generated")
    .map((section) => evidenceIdForSection(section));
  const mustMention = config.task.mustMention.filter(Boolean).join("、");
  const facts = [
    ...config.project.productPoints.slice(0, 2),
    ...config.project.organizationPoints.slice(0, 1),
  ].filter(Boolean).map((item) => sanitizeText(item, config.task.forbidden));
  const primaryEvidence = facts.length ? TASK_PROJECT_EVIDENCE_ID : sectionEvidenceIds[0];
  const bodyGapCards = orchestrationPlan?.gapPlanningCards?.filter((card) => card.plannedPlacements.includes("N.body")) ?? [];
  const commentGapCards = orchestrationPlan?.gapPlanningCards?.filter((card) => card.plannedPlacements.includes("Cref")) ?? [];
  const gaps = config.informationWindow.gaps.length
    ? config.informationWindow.gaps
    : ["适用条件是什么", "哪些信息需要面谈核实", "不同选择怎样比较"];
  const openings = [
    `准备了解${topic}时，我会先把“想知道”和“已经确认”分开。`,
    `做${topic}功课时，可以先把不同信息的适用条件写清。`,
    `如果你正在比较${topic}，先别急着被一句结论带着走。`,
  ];
  const method = config.parameters!;
  const planBoundaries = orchestrationPlan?.boundaries ?? [];
  const boundaries = [...new Set([...config.informationWindow.boundaries, ...planBoundaries])];
  const boundaryText = boundaries.length
    ? `边界要提前写明：${boundaries.join("；")}。`
    : "判断只在资料明确的范围内成立；个体结果和平台触达都不能由文案公式保证。";
  const factStatements = facts.map((fact) => `项目资料能确认：${fact}。`);
  const factText = facts.length
    ? factStatements.join("")
    : "现有资料不足以支持具体结果，只能先给核验方向。";
  const bodyGapRequirements = bodyGapCards.map((card) => {
    const resolution = card.answer ?? card.framework;
    const cardBoundary = card.boundary;
    const separator = resolution && /[。！？!?；;]$/u.test(resolution) ? "" : "；";
    return resolution
      ? `${card.label}：${resolution}${cardBoundary ? `${separator}边界：${cardBoundary}` : ""}`
      : `${card.label}：当前仍未知，需补充可追溯来源或会改变判断的个人条件`;
  });
  const decisionText = method.decisionInformationDepth >= 55
    ? `先核实：${(bodyGapRequirements.length ? bodyGapRequirements : gaps.slice(0, 2)).join("；")}。`
    : "先处理最会改变选择的一个问题。";
  const personaScene = orchestrationPlan?.personaScenePlan;
  const host = personaScene?.host;
  const event = personaScene?.event;
  const primaryGap = bodyGapCards[0]?.question ?? gaps[0] ?? `关于${topic}到底该先看什么？`;
  const rawHostLead = host?.identityCue ?? ["上班族", "第一次认真做功课的人", "最近一直在刷相关内容的人"][candidateIndex]!;
  // Blueprint identity cues written as metadata ("用户直接问价") must not be
  // narrated as the host's self-description in the demo body.
  const hostLead = /^(?:用户|客户|读者|目标人群)/u.test(rawHostLead) ? "最近一直在刷相关内容的人" : rawHostLead;
  const sceneLead = event?.setting ?? "最近刷内容的时候";
  const friction = host?.immediateConstraint ?? event?.friction ?? "怕影响平时安排";
  const openQuestion = primaryGap.replace(/[。！!]+$/u, "").replace(/^[：:]/u, "");
  const factWhisper = facts[0] && method.decisionInformationDepth >= 85 ? `我目前只确认到${facts[0]}。` : "";
  const requiredOpenGap = bodyGapCards.find((card) => card.required && !((card.answer || card.framework) && card.evidenceIds.length));
  const requiredOpenLine = requiredOpenGap ? `关于${requiredOpenGap.label}我还没问明白，得再确认具体情况。` : "";
  const bodyByPrototype: Record<string, string[]> = {
    narrow_request: [`${hostLead}，${friction}。${openQuestion}`],
    live_moment: [`${event?.timeAnchor ?? "刚刚"}${sceneLead}，${event?.observableAction ?? "顺手记了一条"}。`, `${event?.friction ?? friction}，等会儿再看具体怎么说。`],
    expectation_reversal: [`本来都按${topic}安排好了，结果新得到的信息跟我想的不一样。`, `${event?.emotionalAftertaste ?? "现在还有点没反应过来"}，${openQuestion}`],
    process_log: [`${event?.timeAnchor ?? "今天"}${event?.observableAction ?? "记录了一下"}，${event?.friction ?? friction}。`, `${event?.emotionalAftertaste ?? "先记一下今天的情况"}。`],
    outcome_observation: [`${sceneLead}${event?.observableAction ?? "突然多留意了一下"}，${event?.emotionalAftertaste ?? "感受和以前有点不同"}。`],
    retrospective_update: [`${event?.timeAnchor ?? "隔了一段时间"}才想起来说说，${event?.observableAction ?? "翻到以前的记录"}。`, `${event?.friction ?? "平时状态也会有起伏"}，只说我现在看到的。`],
    relationship_moment: [`${hostLead}，以前${event?.friction ?? "在同一个场景总会犹豫一下"}。`, `今天${event?.observableAction ?? "做了一个以前不会做的小动作"}，${event?.emotionalAftertaste ?? "心里轻松了一点"}。`],
    option_comparison: [`最近看${topic}的信息看得有点乱，已经比较到一半，还是卡在${friction}。`, `${openQuestion}`],
  };
  const bodyFragments = [
    mustMention ? `${mustMention}。` : "",
    requiredOpenLine,
    ...(bodyByPrototype[personaScene?.prototype ?? "narrow_request"] ?? bodyByPrototype.narrow_request!),
    factWhisper,
  ];
  const body = fitBody(bodyFragments, config);

  const hashtagPool = [topic, ...(topicOpportunity?.tags ?? []), config.project.domain, config.task.city, config.task.doctor, "信息补全", "选择参考"]
    .filter((item): item is string => Boolean(item))
    .map((item) => sanitizeText(item.replace(/^#+/u, ""), config.task.forbidden));
  while (hashtagPool.length < config.content.hashtagMin) hashtagPool.push(`参考要点${hashtagPool.length + 1}`);
  const hashtagCount = Math.min(config.content.hashtagMax, Math.max(config.content.hashtagMin, 1));
  const hashtags = [...new Set(hashtagPool)].slice(0, hashtagCount);
  while (hashtags.length < config.content.hashtagMin) hashtags.push(`信息项${hashtags.length + 1}`);

  const commentSpan = Math.max(0, config.content.commentThreadMax - config.content.commentThreadMin);
  const threadCount = orchestrationPlan?.effectiveThreadCount
    ?? Math.min(config.content.commentThreadMax, config.content.commentThreadMin + Math.round(commentSpan * method.commentExpansion / 100));
  const stageLabel: Record<ResolvedGenerationConfig["task"]["audienceStage"], string> = {
    discovering: "刚发现问题", collecting: "收集信息", comparing: "比较方案", hesitating: "犹豫核实", ready: "准备行动",
  };
  const usedNaturalQuestions = new Set<string>();
  const usedNaturalAnswers = new Set<string>();
  const naturalThreads = personaScene ? Array.from({ length: threadCount }, (_, index) => {
    const planned = orchestrationPlan?.dialogueThreads[index % Math.max(1, orchestrationPlan.dialogueThreads.length)];
    const surface = planned?.surfaceRoleCard ?? personaScene.commentCast[index % personaScene.commentCast.length]!;
    const gapCard = orchestrationPlan?.gapPlanningCards?.find((item) => item.gapId === planned?.gapId)
      ?? commentGapCards[index % Math.max(1, commentGapCards.length)];
    const gapText = (gapCard?.question ?? planned?.questionIntent ?? primaryGap).replace(/[。！!]+$/u, "");
    const shortGap = [...gapText].slice(0, 20).join("");
    const shortGapCore = shortGap.replace(/[？?]+$/u, "");
    // Weave the gap phrase only when it is short enough to read naturally inside
    // a casual sentence; long formal gap questions would produce stilted copy.
    // Uniqueness among threads is carried by template cycling below, not by weaving.
    const weave = shortGapCore.length <= 10 ? shortGapCore : "";
    const questions: Record<string, string> = {
      direct_question: shortGap.endsWith("？") ? shortGap : `${shortGap}？`,
      shared_concern: weave ? `我也卡在${weave}，越看越不敢定` : "我也卡在这个，越看越不敢定",
      experience_fragment: `我也在查这个，${shortGapCore}还没弄明白`,
      counterexample: weave ? `我不会只看一个答案，${weave}还得问条件不一样怎么办` : "我不会只看一个答案，还会问条件不一样怎么办",
      social_reaction: "这个状态看着真的轻松了一点",
      detail_spotter: weave ? `我才看到你说的这个细节，${weave}是不是也得单独问` : "我才看到你说的这个细节，是不是也得单独问",
      knowledge_translation: "这个简单说主要看哪一点呀",
      identity_route: "这个具体找谁或去哪里核实呀",
      service_answer: "这个现在怎么确认比较准呀",
    };
    const answers: Record<string, string> = {
      direct_question: "我也还没定，就是怕这个才发出来问",
      shared_concern: weave ? `对，${weave}我现在也是信息越多越纠结` : "对，我现在也是信息越多越纠结",
      experience_fragment: "这个办法好，我也把自己的现实安排一起带去问",
      counterexample: "对，先把条件不一样的情况问出来，心里更有数",
      social_reaction: "哈哈我也是今天才后知后觉",
      detail_spotter: "对，我也是看素材才注意到，准备去的时候一起问",
      knowledge_translation: "我打算先把自己的情况说清楚，让对方按情况讲人话",
      identity_route: "我还在看，等确定了具体问谁再回你",
      service_answer: "这个会变，我行动前再确认一下比较稳",
    };
    const rawQuestion = questions[surface.utteranceMode] ?? shortGap;
    const ungroundedGap = !((gapCard?.answer || gapCard?.framework) && (gapCard?.evidenceIds.length ?? 0) > 0);
    const unknownAnswerVariants: Record<string, string> = {
      direct_question: "这点我也还没问明白，得再确认具体情况",
      shared_concern: "我现在也拿不准，准备再问清情况",
      experience_fragment: "每个人情况不一样，我不敢照自己的替你定",
      counterexample: "对，所以最好把自己的情况再确认一下",
      social_reaction: "这个我也想知道，等问明白了再说",
      detail_spotter: "我也只是刚注意到，先别按一张图自己定",
      knowledge_translation: "这点得看具体情况，我现在还不敢替你定",
      identity_route: "我还没问清，确定了来回你",
      service_answer: "具体情况还没确认，采取行动前再问一下比较稳",
    };
    const rawAnswer = ungroundedGap
      ? (unknownAnswerVariants[surface.utteranceMode] ?? "这点我也还没问明白，得再确认具体情况")
      : (answers[surface.utteranceMode] ?? "我也是想先把这个问明白");
    // The canned voice pool is keyed by utterance mode, so two threads sharing a
    // mode would repeat verbatim; cycle to the next structurally-distinct
    // template on collision (duplicate/near-duplicate comment checks are
    // error-level and containment-aware, so a suffix does not help).
    const comparable = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, "");
    const utteranceModePool = ["direct_question", "shared_concern", "experience_fragment", "counterexample", "social_reaction", "detail_spotter", "knowledge_translation", "identity_route", "service_answer"];
    const pickDistinct = (table: Record<string, string>, used: Set<string>, fallback: string): string => {
      const start = Math.max(0, utteranceModePool.indexOf(surface.utteranceMode));
      for (let offset = 0; offset < utteranceModePool.length; offset += 1) {
        const candidate = table[utteranceModePool[(start + offset) % utteranceModePool.length]!];
        if (candidate && !used.has(comparable(candidate))) return candidate;
      }
      return fallback;
    };
    const question = pickDistinct(questions, usedNaturalQuestions, rawQuestion);
    usedNaturalQuestions.add(comparable(question));
    const answer = pickDistinct(ungroundedGap ? unknownAnswerVariants : answers, usedNaturalAnswers, rawAnswer);
    usedNaturalAnswers.add(comparable(answer));
    const plannedFollowUps = planned?.conversationPlan?.targetFollowUps ?? 0;
    const fallbackFollowUpLines = [
      { question: "等等，你说的是紧接着就有重要安排吗", answer: "对，我最怕的就是现实时间对不上" },
      { question: "那我懂了，我还得把自己的安排也算进去", answer: "是，先把时间卡点说清楚会好问很多" },
    ];
    const followUps = Array.from({ length: Math.min(config.content.followUpDepth, plannedFollowUps) }, (_, followUpIndex) => {
      const visible = fallbackFollowUpLines[followUpIndex % fallbackFollowUpLines.length]!;
      return {
          question: visible.question,
          answer: visible.answer,
          // Cref contract v1.1 (demo): a follow-up node extends the thread.
          kind: "follow_up" as const,
          evidenceIds: [],
          personaRole: planned?.personaRole ?? "information_collector" as const,
          speakerType: "simulated_reader" as const,
          claimStatus: "hypothetical" as const,
          replyTo: planned?.id ?? `thread_${candidateIndex + 1}_${index + 1}`,
          threadDepth: 1,
          simulated: true,
          simulationLabel: "模拟潜在读者接话",
        };
    });
    return {
      id: planned?.id ?? `thread_${candidateIndex + 1}_${index + 1}`,
      stage: planned?.stage ?? stageLabel[config.task.audienceStage],
      gap: planned?.gapId ?? gapCard?.gapId ?? `surface_${index + 1}`,
      function: planned?.function ?? "clarify" as const,
      question,
      answer,
      followUps,
      // Cref contract v1.1 (demo): root nodes are positionally question/answer;
      // the thread boundary comes from the planned reply boundary, never invented.
      kind: "question" as const,
      answerKind: "answer" as const,
      boundary: planned?.replyPlan?.boundary,
      postingIdentity: planned?.postingIdentity ?? "publisher" as const,
      sourceClusterIds: [],
      evidenceIds: [],
      nextStep: planned?.nextStep ?? "按真实新问题继续接话",
      personaRole: planned?.personaRole ?? "information_collector" as const,
      speakerType: "simulated_reader" as const,
      claimStatus: "hypothetical" as const,
      replyTo: null,
      threadDepth: 0,
      simulated: true,
      simulationLabel: "模拟潜在读者情景",
      roleCard: planned?.roleCard,
      primaryGapId: planned?.primaryGapId ?? gapCard?.gapId,
      auxiliaryGapIds: planned?.auxiliaryGapIds ?? [],
      densityProxy: planned?.densityProxy,
      replyPlan: planned?.replyPlan,
      discoveryPlan: planned?.discoveryPlan,
      conversationPlan: planned?.conversationPlan,
      surfaceRoleCard: surface,
    };
  }) : [];
  const personaQuestion = (planned: OrchestrationPlan["dialogueThreads"][number] | undefined, gap: string): string => {
    if (planned?.discoveryPlan && method.commentDiscoveryStrength >= 50) {
      const target = Math.max(16, planned.densityProxy.questionTargetChars);
      // M7: discoveryPlan.cue is optional (streamlined form). Fold an absent cue to ""
      // so this gracefully falls back to the constraint/decision-task question below.
      const cue = (planned.discoveryPlan.cue ?? "")
        .replace(/^资料中已经披露[：:]?/u, "")
        .replace(/[“”"。；;！？!?]/gu, "")
        .slice(0, Math.max(4, Math.min(7, target - 10)));
      const focus = planned.roleCard.constraints[0]
        ?.replace(/^(?:待核实维度|已披露地点范围)[：:]/u, "")
        .replace(/[。；;]+$/u, "");
      const compactFocus = (focus ?? "什么条件").slice(0, Math.max(4, target - cue.length - 7));
      return cue
        ? `看到“${cue}”，核实${compactFocus}？`
        : `${(focus ?? planned.roleCard.decisionTask).slice(0, Math.max(6, target - 6))}，先核实什么？`;
    }
    const constraint = planned?.roleCard.constraints[0]
      ?.replace(/^(?:待核实维度|已披露地点范围)[：:]/u, "")
      .replace(/[。；;]+$/u, "");
    const core = gap.replace(/[？?。！!]+$/u, "").replace(/^(?:请问|想问一下|我想知道)/u, "");
    const lead = constraint
      ? method.questionCompression >= 70 ? `考虑${constraint}时，` : `如果还要考虑${constraint}，`
      : "";
    const stance = planned?.roleCard.evidenceStance;
    const question = stance === "evidence_first" ? `${lead}${core}，依据先看哪项`
      : stance === "verification_seeking" ? `${lead}${core}，怎么核实`
        : stance === "boundary_sensitive" ? `${lead}${core}，什么条件会改结论`
          : stance === "unknown_aware" ? `${lead}${core}，哪些还不能确定`
            : method.questionNaturalness >= 70 ? `${lead}${core}，先确认什么` : `${core}怎么判断`;
    return `${question.replace(/[？?。！!]+$/u, "")}？`;
  };
  const usedCommentQuestions = new Set<string>();
  const roleQuestionLead: Record<string, string> = {
    first_time_researcher: "第一次了解时，",
    information_collector: "继续收集资料时，",
    comparison_decider: "拿不同选择比较时，",
    risk_concerned: "如果更在意风险，",
    local_action_seeker: "准备下一步时，",
    skeptical_returning_reader: "复核现有说法时，",
  };
  const threads = personaScene ? naturalThreads : Array.from({ length: threadCount }, (_, index) => {
    const planned = orchestrationPlan?.dialogueThreads[index % Math.max(1, orchestrationPlan.dialogueThreads.length)];
    const fallbackCommentGap = commentGapCards[index % Math.max(1, commentGapCards.length)];
    const gap = planned?.questionIntent ?? fallbackCommentGap?.question ?? gaps[index % gaps.length] ?? `还需要核实什么信息${index + 1}？`;
    const rawQuestion = personaQuestion(planned, gap);
    let question = rawQuestion;
    const normalizedQuestion = (value: string) => value.replace(/[\s\p{P}\p{S}]+/gu, "");
    if (usedCommentQuestions.has(normalizedQuestion(question))) {
      question = `${roleQuestionLead[planned?.personaRole ?? ""] ?? "换一个判断角度时，"}${rawQuestion}`;
    }
    if (usedCommentQuestions.has(normalizedQuestion(question))) {
      question = `${rawQuestion.replace(/[？?]+$/u, "")}，还要核实第${index + 1}项什么？`;
    }
    usedCommentQuestions.add(normalizedQuestion(question));
    const requirement = (prefix: string, fallback: string): string =>
      planned?.answerRequirements.find((item) => item.startsWith(`${prefix}：`))?.slice(prefix.length + 1) || fallback;
    const directAnswer = (planned?.replyPlan.directAnswer ?? requirement("DirectAnswer", primaryEvidence ? "先按已披露资料核实主缺口" : "当前资料不足，不能直接下结论"))
      .replace(/[。；;]+$/u, "");
    const condition = planned?.replyPlan.condition ?? requirement("Condition", "仅在已披露条件内回答");
    const boundary = (planned?.replyPlan.boundary ?? requirement("Boundary", "未披露的个体条件不得代填"))
      .replace(/[。；;]+$/u, "");
    const unknown = (planned?.replyPlan.unknown ?? requirement("Unknown", primaryEvidence ? "资料未覆盖部分仍未知" : "缺少可核验来源"))
      .replace(/[。；;]+$/u, "");
    const rawNextQuestion = planned?.replyPlan.nextQuestion ?? requirement("NextQuestion", "核实会改变结论的条件");
    const focusedNextQuestion = rawNextQuestion.match(/(?:本线程|该线程|这条回答)再核实[：:]?\s*(.+)$/u)?.[1] ?? rawNextQuestion;
    const nextQuestion = focusedNextQuestion
      .replace(/^下一问(?:只)?(?:核实)?(?:辅助维度)?[：:]?/u, "")
      .replace(/[？?。；;]+$/u, "");
    const naturalCondition = condition
      .replace(/(^|[；;])\s*(?:待核实维度|已披露地点范围)[：:]/gu, "$1")
      .replace(/[；;]{2,}/gu, "；")
      .replace(/[；;]+/gu, "和");
    const roleLead: Record<string, string> = {
      first_time_researcher: "第一次了解时，先确认问题范围和判断目标",
      information_collector: "继续收集时，把已知、未知和待核实来源分开记录",
      comparison_decider: "比较选择时，用同一组适用条件、风险和成本口径",
      risk_concerned: "更在意风险时，先列不能接受的风险和现实限制",
      local_action_seeker: "准备行动时，先确认地点、时间和可执行条件",
      skeptical_returning_reader: "复核说法时，回到原始资料检查口径和适用范围",
    };
    const perspective = roleLead[planned?.personaRole ?? ""] ?? "先明确当前要解决的判断问题";
    const plannedGap = orchestrationPlan?.gapPlanningCards?.find((item) => item.gapId === planned?.gapId);
    const unknownGapLead = plannedGap && !plannedGap.answer && !plannedGap.framework
      ? `${plannedGap.label}目前仍需核实，请核实相关来源和适用条件。`
      : "";
    const richAnswerVariants = [
      `${unknownGapLead}${perspective}。${directAnswer}。适用前提要看${naturalCondition}；${boundary}。${unknown}，下一步确认${nextQuestion}。`,
      `${unknownGapLead}如果卡在${naturalCondition}，先别急着定。${directAnswer}。核对范围时记住：${boundary}。${unknown}；接着确认${nextQuestion}。`,
      `${unknownGapLead}换成核验清单：先看${naturalCondition}，再确认${nextQuestion}。${directAnswer}。${unknown}；${boundary}。`,
      `${unknownGapLead}${perspective}，这次把${naturalCondition}单独拎出来。${directAnswer}。反过来若条件不符，${unknown}；${boundary}。下一项查${nextQuestion}。`,
      `${unknownGapLead}做选择时给${naturalCondition}单列一栏。${directAnswer}。${boundary}；${unknown}。最后再核实${nextQuestion}。`,
      `${unknownGapLead}${unknown}。先把${naturalCondition}写成核对项，再用${directAnswer}作为当前参考。${boundary}。然后确认${nextQuestion}。`,
      `${unknownGapLead}这个问题分两步：先核实${naturalCondition}，再问${nextQuestion}。${directAnswer}。如果输入还不全，保留${unknown}；${boundary}。`,
    ];
    const compactAnswerVariants = [
      `${unknownGapLead}${perspective}。${directAnswer}，先核实${naturalCondition}；${boundary}。${unknown}，再确认${nextQuestion}。`,
      `${unknownGapLead}先看${naturalCondition}：${directAnswer}。${unknown}；${boundary}。下一步确认${nextQuestion}。`,
      `${unknownGapLead}${directAnswer}。比较时单独核实${naturalCondition}；${unknown}。${boundary}，再看${nextQuestion}。`,
    ];
    const answer = method.commentReplyIncrement >= 70
      ? richAnswerVariants[index % richAnswerVariants.length]!
      : compactAnswerVariants[index % compactAnswerVariants.length]!;
    const followUpQuestions = [
      [`${nextQuestion}具体怎么核实？`, `如果${naturalCondition}还没确定怎么办？`],
      [`核实${nextQuestion}时先看什么？`, `什么情况会让上面的判断改变？`],
      [`${naturalCondition}需要准备哪些信息？`, `资料说法不一致时先核对哪里？`],
      [`下一步怎么确认${nextQuestion}？`, `哪些信息必须留给可追责来源或正式文件确认？`],
    ][index % 4]!;
    const followUpAnswers = [
      `先把${naturalCondition}写成自己的待核实项，再带着已有资料询问能给出正式结论或文件的人；缺失输入继续保留未知。`,
      `如果${naturalCondition}、${nextQuestion}或证据来源发生变化，就重新比较。${boundary}；${unknown}。`,
    ];
    return {
      id: planned?.id ?? `thread_${candidateIndex + 1}_${index + 1}`,
      stage: planned?.stage ?? stageLabel[config.task.audienceStage],
      gap: planned?.gapId ?? gap,
      function: planned?.function ?? (method.commentConditionality >= 70 ? "clarify" as const : "answer" as const),
      question,
      answer,
      followUps: Array.from({ length: Math.max(0, config.content.followUpDepth - 1) }, (__, followUpIndex) => ({
        question: followUpQuestions[followUpIndex % followUpQuestions.length]!,
        answer: followUpAnswers[followUpIndex % followUpAnswers.length]!,
        evidenceIds: [],
        personaRole: planned?.personaRole ?? "information_collector",
        speakerType: "simulated_reader" as const,
        claimStatus: primaryEvidence ? "bounded" as const : "unknown" as const,
        replyTo: planned?.id ?? `thread_${candidateIndex + 1}_${index + 1}`,
        threadDepth: followUpIndex + 1,
        simulated: true,
        simulationLabel: "模拟潜在读者追问",
      })),
      postingIdentity: planned?.postingIdentity ?? "publisher" as const,
      sourceClusterIds: planned?.sourceClusterIds.length ? planned.sourceClusterIds : context.selectedDocumentIds.slice(0, 3),
      evidenceIds: planned?.evidenceIds.length ? planned.evidenceIds : primaryEvidence ? [primaryEvidence] : [],
      nextStep: planned?.nextStep ?? (primaryEvidence ? "记录自己的条件，并按来源逐项核实。" : "补充可信来源后再形成结论。"),
      personaRole: planned?.personaRole ?? "information_collector",
      speakerType: "simulated_reader" as const,
      claimStatus: planned?.claimStatus ?? (primaryEvidence ? "bounded" as const : "unknown" as const),
      replyTo: null,
      threadDepth: 0,
      simulated: true,
      simulationLabel: "模拟潜在读者情景",
      roleCard: planned?.roleCard,
      primaryGapId: planned?.primaryGapId ?? planned?.gapId,
      auxiliaryGapIds: planned?.auxiliaryGapIds ?? [],
      densityProxy: planned?.densityProxy,
      replyPlan: planned?.replyPlan,
      discoveryPlan: planned?.discoveryPlan,
      surfaceRoleCard: planned?.surfaceRoleCard,
    };
  });
  // Cref contract v1.1 (demo): assemble a deterministic publisher-owned first
  // comment from the first two thread Q&As. Only the persona-scene path
  // produces publisher-voice copy clean enough to pin; the FAQ fallback stays
  // without one rather than dressing audit language up as a publishable
  // comment, and no threads means no first comment.
  const ownedFirstComment = personaScene && threads.length
    ? `常见问题整理——${threads.slice(0, 2).map((thread) => {
        const q = thread.question.trim().replace(/[。！!；;]+$/u, "");
        const a = thread.answer.trim().replace(/[。！!；;]+$/u, "");
        return `问：${q}，答：${a}`;
      }).join("；")}。以上为常见问题整理，具体情况以当面评估为准。`
    : undefined;
  const titleTarget = Math.max(1, method.titleTargetChars);
  const titleOptions = [`${topic}：先核实什么`, `${topic}：怎么比较`, `${topic}：别急着定`];
  const misconceptionTitles = [`${topic}别只看一个结论`, `${topic}先拆一个误区`, `${topic}别被单一说法带走`];
  const verificationTitles = [`${topic}已知与未知清单`, `${topic}先核实关键条件`, `${topic}证据怎么逐项查`];
  const checklistTitles = [`${topic}核验清单`, `${topic}准备条件清单`, `${topic}判断步骤清单`];
  const short = (value: string | undefined, fallback: string, max = 10) =>
    value?.trim() ? [...value.trim()].slice(0, max).join("") : fallback;
  const surfaceTitles: Record<string, string[]> = {
    narrow_request: [`${topic}有人懂吗`, `${topic}先问一件事`, `卡在${short(event?.friction, topic, 8)}`],
    live_moment: [short(event?.timeAnchor, "就是现在", 10), short(event?.observableAction, "顺手记一下", 12), `${topic}现场一刻`],
    expectation_reversal: [short(event?.trigger, "跟想的不一样", 12), `${topic}又得重想`, "刚知道这一点"],
    process_log: [short(event?.observableAction, "今天先记一下", 12), `${topic}过程记录`, short(event?.timeAnchor, "今天这样", 10)],
    outcome_observation: [short(event?.trigger, "刚注意到变化", 12), `${topic}有限观察`, "只说这一次"],
    retrospective_update: [short(event?.timeAnchor, "过段时间再看", 10), `${topic}回头更新`, "后来又想起这件事"],
    relationship_moment: [short(event?.setting, "一个普通瞬间", 12), `${topic}被人问起`, short(event?.emotionalAftertaste, "突然有点感触", 12)],
    option_comparison: [`${topic}真的难选`, `${topic}差别在哪`, "两种说法对不上"],
  };
  const surfaceTitle = personaScene
    ? surfaceTitles[personaScene.prototype]?.[candidateIndex % (surfaceTitles[personaScene.prototype]?.length || 1)]
    : undefined;
  const rawTitle = surfaceTitle ?? (orchestrationPlan?.strategy.openingMode.includes("misconception")
    ? misconceptionTitles[candidateIndex]!
    : orchestrationPlan?.strategy.openingMode.includes("verification")
      ? verificationTitles[candidateIndex]!
      : orchestrationPlan?.strategy.openingMode.includes("checklist")
        ? checklistTitles[candidateIndex]!
        : titleOptions[candidateIndex] ?? `${topic}怎么判断`);
  const title = [...rawTitle].length > titleTarget * 1.8 && [...topic].length < titleTarget
    ? [...rawTitle].slice(0, Math.max(titleTarget, [...topic].length)).join("")
    : rawTitle;
  const reasoning: GenerationDraft["reasoning"] = [];
  const addGroundedFact = (
    statement: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    candidateEvidenceIds: string[],
    occurrence?: GenerationDraft["reasoning"][number]["occurrence"],
  ): void => {
    if (!statement.trim() || reasoning.some((item) => item.location === location && item.statement === statement
      && item.occurrence?.threadId === occurrence?.threadId && item.occurrence?.followUpIndex === occurrence?.followUpIndex)) return;
    const sourceSpans = sourceSpansForClaim(statement, candidateEvidenceIds, evidenceSources);
    if (!sourceSpans.length) return;
    reasoning.push({
      statement,
      location,
      ...(occurrence ? { occurrence } : {}),
      status: "fact",
      evidenceIds: [...new Set(sourceSpans.map((span) => span.evidenceId))],
      sourceSpans,
    });
  };
  for (const [index, fact] of facts.entries()) {
    if (body.includes(fact)) addGroundedFact(fact, "N.body", [TASK_PROJECT_EVIDENCE_ID], { field: "body" });
  }
  for (const card of bodyGapCards) {
    const answer = card.answer ?? card.framework;
    if (answer && body.includes(answer)) addGroundedFact(answer, "N.body", card.evidenceIds, { field: "body" });
  }
  for (const thread of threads) {
    const card = orchestrationPlan?.gapPlanningCards?.find((item) => item.gapId === thread.primaryGapId);
    const answer = card?.answer ?? card?.framework;
    if (answer && thread.answer.includes(answer)) {
      addGroundedFact(answer, "Cref.thread", thread.evidenceIds, { field: "answer", threadId: thread.id });
    }
  }
  const addCreativeIdentity = (
    statement: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>,
  ): void => {
    const cleaned = statement.trim();
    if (!cleaned || reasoning.some((item) => item.location === location && item.statement === cleaned
      && item.occurrence?.field === occurrence.field && item.occurrence?.threadId === occurrence.threadId
      && item.occurrence?.followUpIndex === occurrence.followUpIndex)) return;
    reasoning.push({ statement: cleaned, location, occurrence, status: "hypothesis", evidenceIds: [], sourceSpans: [] });
  };
  if (personaScene) {
    body.split(/(?<=[。！？!?])|\n+/u).map((item) => item.trim()).filter(Boolean)
      .forEach((statement) => addCreativeIdentity(statement, "N.body", { field: "body" }));
    threads.forEach((thread) => {
      addCreativeIdentity(thread.question, "Cref.thread", { field: "question", threadId: thread.id });
      addCreativeIdentity(thread.answer, "Cref.thread", { field: "answer", threadId: thread.id });
      thread.followUps.forEach((followUp, followUpIndex) => {
        addCreativeIdentity(followUp.question, "Cref.followUp", { field: "question", threadId: thread.id, followUpIndex });
        addCreativeIdentity(followUp.answer, "Cref.followUp", { field: "answer", threadId: thread.id, followUpIndex });
      });
    });
  }
  if (!reasoning.length) {
    reasoning.push({
      statement: factText,
      location: "N.body",
      occurrence: { field: "body" },
      status: "unknown",
      evidenceIds: [],
      sourceSpans: [],
    });
  }
  const citedEvidenceIds = [...new Set(reasoning.flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))];
  return {
    content: {
      H: { hashtags },
      N: {
        imageBrief: config.content.imageBriefEnabled
          ? orchestrationPlan
            ? `${orchestrationPlan.imagePlan.composition} 画面顺序：${orchestrationPlan.imagePlan.frames.join("—")}。边界：${orchestrationPlan.imagePlan.boundaries.join("；") || "不展示未经知识库支持的结果对比"}。`
            : `${topic}的一张普通生活现场照或求助卡；先交代人物和当下处境，不默认做知识信息卡。`
          : "",
        title: sanitizeText(title, config.task.forbidden),
        body,
      },
      Cref: { disclaimer: "以下为完整评论区创作参考，不代表已经发生的真实互动或观测口碑。", ownedFirstComment, threads },
    },
    evidenceIds: citedEvidenceIds,
    reasoning,
    unknowns: ledger.unknowns,
  };
}

function bindDialogueProvenance(
  draft: GenerationDraft,
  plan: OrchestrationPlan,
  allowedEvidenceIds: string[],
  evidenceSources: Record<string, string>,
): GenerationDraft {
  const allowed = new Set(allowedEvidenceIds);
  const originalThreadIds = new Map(
    draft.content.Cref.threads.map((thread, index) => [thread.id, plan.dialogueThreads[index]?.id ?? thread.id]),
  );
  // 展示昵称(纯展示元数据):计划侧昵称先占坑,缺失时按同一盐确定性补算;
  // 追问接话人按 `nickname:${threadId}:fu:${index}` 分配,包内去重顺延。
  const usedDisplayNames = new Set(
    plan.dialogueThreads.map((planned) => planned.displayName).filter((name): name is string => Boolean(name)),
  );
  const remappedReasoning = draft.reasoning.map((item) => item.occurrence?.threadId
    ? {
        ...item,
        occurrence: {
          ...item.occurrence,
          threadId: originalThreadIds.get(item.occurrence.threadId) ?? item.occurrence.threadId,
        },
      }
    : item);
  const remappedDraft: GenerationDraft = { ...draft, reasoning: remappedReasoning };
  const cleanVisibleText = (value: string): string => value
    .replace(/\bevidence_[\w:.-]+\b/giu, "资料原文")
    .replace(/(?:回到|核对)资料原文(?:核对)?/gu, "核对资料原文")
    .replace(/[；;，,]?\s*核验时只采用(?:本线程|该线程|这条回答)列出的证据来源[。；;]?/gu, "")
    .replace(/(?:本线程|该线程|线程内)/gu, "这条回答")
    .replace(/；{2,}/gu, "；")
    .replace(/。{2,}/gu, "。")
    .replace(/；。/gu, "。")
    .trim();
  const answerFromPlan = (planned: OrchestrationPlan["dialogueThreads"][number]): string => {
    const surface = planned.surfaceRoleCard;
    if (surface?.utteranceMode === "social_reaction") return "哈哈我也是今天才注意到";
    if (surface?.utteranceMode === "detail_spotter") return "对，我也是看照片才注意到这个";
    if (surface?.utteranceMode === "knowledge_translation") return "简单说得看具体情况，我先不替你定";
    if (surface?.utteranceMode === "identity_route") return "我还在看，确定了来回你";
    if (surface?.utteranceMode === "experience_fragment") return "那我还是多留点时间保险";
    if (surface?.utteranceMode === "counterexample") return "对，所以我也不敢只按一个人的情况算";
    return "我也是想先把这个问明白";
  };
  const threads = plan.dialogueThreads.map((planned, index) => {
    const existing = remappedDraft.content.Cref.threads[index];
    const fallbackId = planned.id;
    const base = existing ?? {
      id: fallbackId,
      question: planned.questionIntent.replace(/[？?]+$/u, "") + "？",
      answer: answerFromPlan(planned),
      followUps: [],
      postingIdentity: planned.postingIdentity,
      sourceClusterIds: [...planned.sourceClusterIds],
      evidenceIds: [...planned.evidenceIds],
    };
    const selectedSurface = base.surfaceRoleCard ?? planned.surfaceRoleCard;
    const realizedConversation = base.conversationPlan ?? planned.conversationPlan;
    // Preserve the model's visible copy. The orchestration plan is metadata,
    // not user-facing prose and may contain audit IDs or intentionally verbose
    // planning language that must never overwrite a natural question/answer.
    const existingQuestion = cleanVisibleText(base.question);
    const compactQuestion = cleanVisibleText(planned.questionIntent);
    // Extremely short comments such as “同问” or “蹲” are legitimate social
    // nodes in the reference corpus; never expand them merely for being short.
    const question = !existingQuestion
      ? compactQuestion
      : existingQuestion;
    const existingAnswer = cleanVisibleText(base.answer);
    const answer = existingAnswer || answerFromPlan(planned);
    // Planned evidence is context, not a citation. A visible thread may expose
    // only the exact factual source spans pinned to that thread occurrence.
    const evidenceIds = [...new Set(remappedDraft.reasoning
      .filter((item) => item.status === "fact" && item.location === "Cref.thread"
        && item.occurrence?.threadId === planned.id)
      .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))]
      .filter((id) => allowed.has(id));
    const threadDisplayName = planned.displayName
      ?? assignCommentDisplayName(plan.seed, `nickname:${planned.id}`, usedDisplayNames);
    usedDisplayNames.add(threadDisplayName);
    const followUps = base.followUps.map((followUp, followUpIndex) => {
      const followUpDisplayName = assignCommentDisplayName(plan.seed, `nickname:${planned.id}:fu:${followUpIndex}`, usedDisplayNames);
      usedDisplayNames.add(followUpDisplayName);
      return {
        ...followUp,
        displayName: followUpDisplayName,
        question: cleanVisibleText(followUp.question),
        answer: cleanVisibleText(followUp.answer),
        replyTo: planned.id,
        // Positional default: a follow-up node extends the thread, so its kind is
        // "follow_up" (its answer side is positionally a "clarification").
        kind: followUp.kind ?? "follow_up" as const,
        evidenceIds: [...new Set(remappedDraft.reasoning
          .filter((item) => item.status === "fact" && item.location === "Cref.followUp"
            && item.occurrence?.threadId === planned.id && item.occurrence.followUpIndex === followUpIndex)
          .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))]
          .filter((id) => allowed.has(id)),
      };
    });
    return {
      ...base,
      id: planned.id,
      displayName: threadDisplayName,
      question,
      answer,
      // Cref contract v1.1: keep model-stated dialogic kinds/boundary; when the
      // model did not state them, derive kinds positionally (root nodes) and
      // fall back to the planned reply boundary. A boundary is never invented.
      kind: base.kind ?? "question" as const,
      answerKind: base.answerKind ?? "answer" as const,
      boundary: base.boundary ?? planned.replyPlan?.boundary,
      postingIdentity: planned.postingIdentity,
      sourceClusterIds: [...planned.sourceClusterIds],
      evidenceIds,
      followUps,
      stage: planned.stage,
      gap: planned.gapId,
      // P3-15: the model may state the thread function in the staged schema; a
      // legal enum value wins, anything else silently falls back to the
      // content-derived planning value (no more positional rotation anywhere).
      function: commentThreadFunction(base.function) ?? planned.function,
      nextStep: planned.nextStep,
      personaRole: planned.personaRole,
      speakerType: planned.speakerType,
      claimStatus: evidenceIds.length
        ? planned.claimStatus
        : (["experience_fragment", "counterexample", "social_reaction"].includes(selectedSurface?.utteranceMode ?? "")
          ? "hypothetical"
          : (planned.claimStatus === "verified" ? "bounded" : planned.claimStatus)),
      replyTo: planned.replyTo,
      threadDepth: planned.threadDepth,
      simulated: planned.simulated,
      simulationLabel: planned.simulationLabel,
      roleCard: planned.roleCard,
      primaryGapId: planned.primaryGapId,
      auxiliaryGapIds: [...planned.auxiliaryGapIds],
      densityProxy: { ...planned.densityProxy },
      replyPlan: { ...planned.replyPlan },
      // M7: discoveryPlan is optional; preserve presence/absence rather than coercing to {}.
      discoveryPlan: planned.discoveryPlan ? { ...planned.discoveryPlan } : undefined,
      conversationPlan: realizedConversation ? { ...realizedConversation } : undefined,
      surfaceRoleCard: selectedSurface ? { ...selectedSurface, targetChars: [...selectedSurface.targetChars] as [number, number] } : undefined,
    };
  });
  // Plan-level uncovered-gap projection (Cref contract v1.1): a gap selected
  // for this candidate counts as covered by Cref when at least one dialogue
  // thread takes it as primaryGapId or lists it in auxiliaryGapIds; cards
  // planned for N.body belong to the body channel, not to Cref. The projection
  // is derived deterministically from the plan, never from model text, and is
  // distinct from gapCoverageLedger.uncoveredGapIds, which grades the final
  // draft's realization quality after generation. When the plan carries no
  // gapPlanningCards (historical snapshot) the field stays absent — an
  // uncomputable projection must not masquerade as an empty one.
  const coveredGapIds = new Set(plan.dialogueThreads
    .flatMap((planned) => [planned.primaryGapId, ...planned.auxiliaryGapIds]));
  const uncoveredGaps = plan.gapPlanningCards
    ? plan.gapPlanningCards
      .filter((card) => !coveredGapIds.has(card.gapId) && !card.plannedPlacements.includes("N.body"))
      .map((card) => card.gapId)
    : undefined;
  const bound: GenerationDraft = {
    ...remappedDraft,
    content: {
      ...remappedDraft.content,
      Cref: {
        ...remappedDraft.content.Cref,
        threads,
        uncoveredGaps,
        // Model-produced visible copy, cleaned like any other comment text;
        // when the staged flow produced none it stays absent (never synthesized).
        ownedFirstComment: remappedDraft.content.Cref.ownedFirstComment
          ? cleanVisibleText(remappedDraft.content.Cref.ownedFirstComment)
          : undefined,
      },
    },
  };
  const reconciled = reconcileReasoningEvidence(bound, allowedEvidenceIds, evidenceSources);
  return {
    ...reconciled,
    content: {
      ...reconciled.content,
      Cref: {
        ...reconciled.content.Cref,
        threads: reconciled.content.Cref.threads.map((thread) => ({
          ...thread,
          claimStatus: thread.claimStatus === "verified" && thread.evidenceIds.length === 0
            ? "bounded"
            : thread.claimStatus,
        })),
      },
    },
  };
}

function visibleTextForReasoning(draft: GenerationDraft, item: GenerationDraft["reasoning"][number]): string | undefined {
  switch (item.location) {
    case "H": return draft.content.H.hashtags.join(" ");
    case "N.imageBrief": return draft.content.N.imageBrief;
    case "N.title": return draft.content.N.title;
    case "N.body": return draft.content.N.body;
    case "Cref.thread": {
      const thread = draft.content.Cref.threads.find((candidate) => candidate.id === item.occurrence?.threadId);
      if (!thread) return undefined;
      return item.occurrence?.field === "question" ? thread.question
        : item.occurrence?.field === "nextStep" ? thread.nextStep
          : thread.answer;
    }
    case "Cref.followUp": {
      const thread = draft.content.Cref.threads.find((candidate) => candidate.id === item.occurrence?.threadId);
      const followUp = thread?.followUps[item.occurrence?.followUpIndex ?? -1];
      if (!followUp) return undefined;
      return item.occurrence?.field === "question" ? followUp.question : followUp.answer;
    }
    default: return undefined;
  }
}

function groundedVisibleSegments(draft: GenerationDraft): Array<{
  statement: string;
  location: NonNullable<GenerationDraft["reasoning"][number]["location"]>;
  occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>;
}> {
  const result: Array<{
    statement: string;
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>;
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>;
  }> = [];
  const add = (
    text: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>,
  ): void => {
    for (const statement of text.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter((item) => [...item].length >= 4)) {
      result.push({ statement, location, occurrence });
    }
  };
  add(draft.content.N.body, "N.body", { field: "body" });
  for (const thread of draft.content.Cref.threads) {
    add(thread.answer, "Cref.thread", { field: "answer", threadId: thread.id });
    thread.followUps.forEach((followUp, followUpIndex) => {
      add(followUp.answer, "Cref.followUp", { field: "answer", threadId: thread.id, followUpIndex });
    });
  }
  return result;
}

function reconcileReasoningEvidence(
  draft: GenerationDraft,
  allowedEvidenceIds: string[],
  evidenceSources: Record<string, string>,
): GenerationDraft {
  const allowed = new Set(allowedEvidenceIds);
  const reasoning: GenerationDraft["reasoning"] = [];
  for (const item of draft.reasoning) {
    const visible = visibleTextForReasoning(draft, item);
    if (!visible?.includes(item.statement)) continue;
    if (item.status !== "fact") {
      reasoning.push({ ...item, evidenceIds: [], sourceSpans: [] });
      continue;
    }
    const preferred = [...new Set([
      ...(item.sourceSpans ?? []).map((span) => span.evidenceId),
      ...item.evidenceIds,
      ...allowedEvidenceIds,
    ])].filter((id) => allowed.has(id));
    const sourceSpans = sourceSpansForClaim(item.statement, preferred, evidenceSources);
    if (!sourceSpans.length) continue;
    reasoning.push({
      ...item,
      evidenceIds: sourceSpans.map((span) => span.evidenceId),
      sourceSpans,
    });
  }
  for (const segment of groundedVisibleSegments(draft)) {
    if (reasoning.some((item) => item.status === "fact" && item.location === segment.location
      && item.occurrence?.threadId === segment.occurrence.threadId
      && item.occurrence?.followUpIndex === segment.occurrence.followUpIndex
      && conservativeEvidenceSupport(segment.statement, item.statement))) continue;
    const sourceSpans = sourceSpansForClaim(segment.statement, allowedEvidenceIds, evidenceSources);
    if (!sourceSpans.length) continue;
    reasoning.push({
      statement: segment.statement,
      location: segment.location,
      occurrence: segment.occurrence,
      status: "fact",
      evidenceIds: sourceSpans.map((span) => span.evidenceId),
      sourceSpans,
    });
  }
  const threads = draft.content.Cref.threads.map((thread) => ({
    ...thread,
    evidenceIds: [...new Set(reasoning
      .filter((item) => item.status === "fact" && item.location === "Cref.thread"
        && item.occurrence?.threadId === thread.id)
      .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))],
    followUps: thread.followUps.map((followUp, followUpIndex) => ({
      ...followUp,
      evidenceIds: [...new Set(reasoning
        .filter((item) => item.status === "fact" && item.location === "Cref.followUp"
          && item.occurrence?.threadId === thread.id && item.occurrence.followUpIndex === followUpIndex)
        .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))],
    })),
  }));
  return {
    ...draft,
    content: {
      ...draft.content,
      Cref: { ...draft.content.Cref, threads },
    },
    evidenceIds: [...new Set(reasoning.flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)))],
    reasoning,
  };
}

/** Ensure every creative scene fragment has an explicit non-factual identity.
 * This never turns prose into evidence: missing visible fragments are recorded
 * as hypotheses, while grounded fact rows from the ledger stay untouched. */
function refreshCreativeScenarioIdentities(draft: GenerationDraft): GenerationDraft {
  const reasoning = [...draft.reasoning];
  const add = (
    statement: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>,
  ): void => {
    const cleaned = statement.trim();
    if (!cleaned || reasoning.some((item) => item.location === location
      && item.occurrence?.field === occurrence.field
      && item.occurrence?.threadId === occurrence.threadId
      && item.occurrence?.followUpIndex === occurrence.followUpIndex
      && (item.statement.includes(cleaned) || cleaned.includes(item.statement)))) return;
    reasoning.push({ statement: cleaned, location, occurrence, status: "hypothesis", evidenceIds: [], sourceSpans: [] });
  };
  const addText = (
    text: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>,
  ): void => {
    const segments = text.split(/(?<=[。！？!?；;])|\n+/u).map((item) => item.trim()).filter(Boolean);
    (segments.length ? segments : [text]).forEach((statement) => add(statement, location, occurrence));
  };
  draft.content.N.body.split(/(?<=[。！？!?])|\n+/u).forEach((statement) => add(statement, "N.body", { field: "body" }));
  draft.content.Cref.threads.forEach((thread) => {
    addText(thread.question, "Cref.thread", { field: "question", threadId: thread.id });
    addText(thread.answer, "Cref.thread", { field: "answer", threadId: thread.id });
    thread.followUps.forEach((followUp, followUpIndex) => {
      addText(followUp.question, "Cref.followUp", { field: "question", threadId: thread.id, followUpIndex });
      addText(followUp.answer, "Cref.followUp", { field: "answer", threadId: thread.id, followUpIndex });
    });
  });
  return { ...draft, reasoning };
}

function keepCriticalBoundariesInBody(
  draft: GenerationDraft,
  plan: OrchestrationPlan,
  config: ResolvedGenerationConfig,
): GenerationDraft {
  const sentenceSafeTrim = (value: string, limit: number): string => {
    if (limit <= 0) return "";
    const chars = [...value.trim().replace(/。{2,}/gu, "。").replace(/；。/gu, "。")];
    if (chars.length <= limit) return chars.join("");
    const clipped = chars.slice(0, Math.max(1, limit));
    const floor = Math.floor(clipped.length * 0.58);
    let cut = -1;
    for (let index = clipped.length - 1; index >= floor; index -= 1) {
      if (/[。！？!?；;\n]/u.test(clipped[index] ?? "")) { cut = index + 1; break; }
    }
    if (cut < 0) {
      for (let index = clipped.length - 1; index >= Math.floor(clipped.length * 0.78); index -= 1) {
        if (/[，,、：:]/u.test(clipped[index] ?? "")) { cut = index; break; }
      }
    }
    const result = clipped.slice(0, cut > 0 ? cut : clipped.length).join("").trimEnd();
    if (/[。！？!?]$/u.test(result)) return result;
    const stem = result.replace(/[，,、：:；;]+$/u, "");
    return `${[...stem].slice(0, Math.max(0, limit - 1)).join("")}。`;
  };
  const selectedGapBoundaries = (plan.gapPlanningCards ?? [])
    .filter((card) => card.required && card.plannedPlacements.includes("N.body"))
    .flatMap((card) => card.boundary?.trim() ? [card.boundary.trim()] : []);
  const selectedGapAnswers = (plan.gapPlanningCards ?? [])
    .filter((card) => card.required && card.plannedPlacements.includes("N.body"))
    .flatMap((card) => (card.answer ?? card.framework)?.trim() ? [(card.answer ?? card.framework)!.trim()] : []);
  const boundaryPool = selectedGapBoundaries;
  const missingBoundaries = [...new Set(boundaryPool)].filter((boundary) =>
    boundary.trim() && !draft.content.N.body.includes(boundary.trim()),
  );
  const missingGapAnswers = [...new Set(selectedGapAnswers)].filter((answer) =>
    answer && !draft.content.N.body.includes(answer),
  );
  const missingRequired = [...new Set(config.task.mustMention.map((item) => item.trim()).filter(Boolean))]
    .filter((item) => !draft.content.N.body.includes(item));
  if (!missingBoundaries.length && !missingRequired.length && !missingGapAnswers.length) {
    const body = sentenceSafeTrim(draft.content.N.body, config.content.bodyMaxChars);
    return body === draft.content.N.body
      ? draft
      : { ...draft, content: { ...draft.content, N: { ...draft.content.N, body } } };
  }
  const suffixCandidates = [
    ...missingRequired.map((item) => /[。！？!?]$/u.test(item) ? item : `${item}。`),
    ...missingGapAnswers.map((answer) => /[。！？!?]$/u.test(answer) ? answer : `${answer}。`),
    ...missingBoundaries.map((boundary) => /[。！？!?]$/u.test(boundary) ? boundary : `${boundary}。`),
  ];
  const suffixParts: string[] = [];
  for (const part of suffixCandidates) {
    const candidate = suffixParts.length ? `${suffixParts.join("\n")}\n${part}` : part;
    if ([...candidate].length <= config.content.bodyMaxChars) suffixParts.push(part);
  }
  const suffix = suffixParts.length ? `\n\n${suffixParts.join("\n")}` : "";
  const available = Math.max(0, config.content.bodyMaxChars - [...suffix].length);
  const main = sentenceSafeTrim(draft.content.N.body, available);
  const body = `${main}${suffix}`.trim();
  return {
    ...draft,
    content: { ...draft.content, N: { ...draft.content.N, body } },
  };
}

function packageId(jobId: string, candidateIndex: number, seed: number): string {
  return `pkg_${createHash("sha256").update(`${jobId}:${candidateIndex}:${seed}`).digest("hex").slice(0, 20)}`;
}

function uniqueUnknowns(ledger: KnowledgeLedger, draft: GenerationDraft): GenerationDraft["unknowns"] {
  return [...new Map([...ledger.unknowns, ...draft.unknowns].map((item) => [item.id, item])).values()];
}

function cloneConfig(config: ResolvedGenerationConfig): ResolvedGenerationConfig {
  return structuredClone(config);
}

export class ContentGenerationAgent implements GenerationEngine {
  private readonly provider?: ModelProvider;
  private readonly now: () => Date;
  private readonly systemPromptTokenEstimate: number;

  constructor(options: ContentGenerationEngineOptions = {}) {
    this.provider = options.modelProvider;
    this.now = options.now ?? (() => new Date());
    this.systemPromptTokenEstimate = options.systemPromptTokenEstimate ?? 900;
  }

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const formulaIssues = validateFormulaVersion(input.formulaVersion);
    if (formulaIssues.length) throw new Error(`Formula version is invalid: ${formulaIssues.map((item) => item.message).join("; ")}`);
    if (input.config.formula.versionId !== input.formulaVersion.id) throw new Error("Config formula.versionId does not match the supplied immutable formula version.");
    const compilation = compileGenerationParameters(input.config, input.formulaVersion, input.parameterSelection);
    const effectiveInput: GenerationInput = { ...input, config: compilation.config };
    runtimeConfigChecks(effectiveInput.config);
    const knownFormulaIds = new Set(effectiveInput.formulaVersion.formulas.map((formula) => formula.id));
    const missingFormula = effectiveInput.config.formula.enabledFormulaIds.find((id) => !knownFormulaIds.has(id as `F${string}`));
    if (missingFormula) throw new Error(`Enabled formula does not exist in the supplied version: ${missingFormula}`);

    const startedAt = this.now().toISOString();
    const context = buildContext(effectiveInput.config, effectiveInput.formulaVersion, effectiveInput.knowledge, this.systemPromptTokenEstimate);
    const ledger = buildKnowledgeLedger(effectiveInput.claims ?? [], effectiveInput.unknowns ?? []);
    const planning = resolveGenerationPlanning(effectiveInput, context);
    // Candidates may plan independently, while the API's shared provider limiter
    // controls actual gateway concurrency. A limit of one interleaves candidate
    // stages without issuing simultaneous long requests or blocking the whole job
    // behind one candidate's complete repair chain.
    const candidateResults = await Promise.allSettled([
      this.generateCandidate(effectiveInput, context, ledger, 0, planning, compilation.resolutionSnapshot, compilation.impactReport),
      this.generateCandidate(effectiveInput, context, ledger, 1, planning, compilation.resolutionSnapshot, compilation.impactReport),
      this.generateCandidate(effectiveInput, context, ledger, 2, planning, compilation.resolutionSnapshot, compilation.impactReport),
    ]);
    const failedCandidate = candidateResults.findIndex((result) => result.status === "rejected");
    if (failedCandidate >= 0) {
      const failed = candidateResults[failedCandidate] as PromiseRejectedResult;
      throw new Error(
        `模型候选 ${failedCandidate + 1} 生成失败，任务已停止且未生成可发布降级稿：${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}`,
      );
    }
    const candidates = candidateResults.map(
      (result) => (result as PromiseFulfilledResult<ContentPackage>).value,
    ) as [ContentPackage, ContentPackage, ContentPackage];
    return {
      jobId: input.jobId,
      packages: candidates,
      knowledgeContext: context,
      startedAt,
      completedAt: this.now().toISOString(),
      resolutionSnapshot: compilation.resolutionSnapshot,
      impactReport: compilation.impactReport,
    };
  }

  private async generateCandidate(
    input: GenerationInput,
    context: KnowledgeContextSelection,
    ledger: KnowledgeLedger,
    candidateIndex: 0 | 1 | 2,
    planning: ResolvedGenerationPlanning,
    resolutionSnapshot: ParameterResolutionSnapshot,
    impactReport: ParameterImpactReport,
    useProvider = true,
  ): Promise<ContentPackage> {
    const orchestrationPlan = planning.plans[candidateIndex];
    const seed = orchestrationPlan.seed;
    const variation = variationFor(seed, candidateIndex);
    const availableEvidence = generationEvidenceReferences(input.config, input.knowledge, context, input.planningContext);
    const evidenceSources = generationEvidenceSources(input.config, input.knowledge, context, input.planningContext);
    const stageIssues: ContentValidationIssue[] = [];
    let draft: GenerationDraft;
    if (this.provider && useProvider) {
      const promptInput = {
        config: input.config,
        formulaVersion: input.formulaVersion,
        knowledge: context,
        ledger,
        candidateIndex,
        seed,
        variation,
        impactReport,
        topicOpportunity: planning.opportunity,
        projectIntelligence: planning.intelligence,
        projectBlueprint: input.planningContext?.projectBlueprint,
        imageAnalyses: planning.imageAnalyses,
        orchestrationPlan,
        evidenceReferences: availableEvidence,
      };
      const deterministicBase = deterministicDraft(
        input.config,
        context,
        ledger,
        candidateIndex,
        variation,
        impactReport,
        orchestrationPlan,
        planning.opportunity,
        evidenceSources,
      );
      const corePrompt = buildStagedCorePrompt(promptInput);
      const coreResponse = await this.provider.generate({
        messages: corePrompt.messages,
        responseSchema: corePrompt.responseSchema,
        schemaName: "content_candidate_core",
        model: input.config.model.model,
        seed,
        temperature: input.config.model.temperature,
        maxOutputTokens: Math.min(input.config.model.maxOutputTokens, 4_000),
        metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_core", stage: 1 },
      });
      const core = parseStagedCoreCopy(coreResponse.text);
      const commentsPrompt = buildStagedCommentsPrompt(promptInput, core);
      const commentsResponse = await this.provider.generate({
        messages: commentsPrompt.messages,
        responseSchema: commentsPrompt.responseSchema,
        schemaName: "content_candidate_comments",
        model: input.config.model.model,
        seed: seed + 1,
        temperature: input.config.model.temperature,
        maxOutputTokens: input.config.model.maxOutputTokens,
        metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_comments", stage: 2 },
      });
      const roots = parseStagedCommentCopy(commentsResponse.text);
      if (roots.threads.length !== orchestrationPlan.dialogueThreads.length) {
        throw new Error(`Staged comment output returned ${roots.threads.length} threads; expected ${orchestrationPlan.dialogueThreads.length}.`);
      }
      const normalizedRoots: StagedCommentCopy = {
        ...roots,
        threads: roots.threads.map((thread) => ({ ...thread, followUps: [] })),
      };
      // M7 per-mechanism ruling — 需求 7.6 / design 组件 E · E1: multi-turn growth = (c/b) →
      // no traceable evidence that extra turns improve outcomes (c), but "natural comment
      // section" realism has recorded creative value (b) AND a real cost, so it was made a
      // conservative-by-default FEATURE SWITCH (task 7.3) rather than removed. Not required:
      // when skipped the root comments are still valid output.
      //
      // Task 7.3 (M7 收敛评论网络复杂度): the extra multi-turn comment growth pass
      // (stage 2B) is a conservative, opt-in feature switch. The additional LLM
      // growth call only fires when it is explicitly enabled AND followUpDepth > 0
      // AND the comment conversation rate > 0. When skipped, the already-generated
      // root comments are used directly — an equally valid output, identical to the
      // pre-existing graceful-degradation path. See design 组件E(E2) / Error Handling.
      const growthConversationRate = input.config.parameters?.commentConversationRate ?? 48;
      const shouldGrowComments = input.config.content.commentMultiTurnGrowthEnabled === true
        && input.config.content.followUpDepth > 0
        && growthConversationRate > 0;
      let comments = normalizedRoots;
      if (shouldGrowComments) {
        try {
          const growthPrompt = buildStagedCommentGrowthPrompt(promptInput, core, normalizedRoots);
          const growthResponse = await this.provider.generate({
            messages: growthPrompt.messages,
            responseSchema: growthPrompt.responseSchema,
            schemaName: "content_candidate_comment_growth",
            model: input.config.model.model,
            seed: seed + 2,
            temperature: input.config.model.temperature,
            maxOutputTokens: input.config.model.maxOutputTokens,
            metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_comment_growth", stage: 2.2 },
          });
          const grown = parseStagedCommentCopy(growthResponse.text);
          const grownById = new Map(grown.threads.map((thread) => [thread.id, thread]));
          if (normalizedRoots.threads.some((thread) => !grownById.has(thread.id))) {
            throw new Error("Comment growth output omitted one or more root thread IDs.");
          }
          comments = {
            ...normalizedRoots,
            threads: normalizedRoots.threads.map((root) => ({
              ...root,
              followUps: grownById.get(root.id)?.followUps ?? [],
            })),
          };
        } catch (error) {
          stageIssues.push({
            code: "model_comment_growth_failed",
            severity: "warning",
            channel: "Cref",
            message: `根评论已保留，但自然接龙阶段失败：${error instanceof Error ? error.message : String(error)}`,
            repairable: false,
          });
        }
      }
      const maxVisibleCommentLines = orchestrationPlan.personaScenePlan?.surfaceTargets.visibleCommentLines[1]
        ?? comments.threads.length * 2 + input.config.content.followUpDepth * 2;
      let remainingFollowUps = Math.max(0, Math.floor((maxVisibleCommentLines - comments.threads.length * 2) / 2));
      const stagedContent: GenerationDraft["content"] = {
        H: core.H,
        N: core.N,
        Cref: {
          disclaimer: comments.disclaimer,
          // Carried only when the model produced one; bindDialogueProvenance
          // cleans it like any other visible copy. Absent stays absent.
          ownedFirstComment: comments.ownedFirstComment,
          threads: deterministicBase.content.Cref.threads.map((base, threadIndex) => {
            const visible = comments.threads[threadIndex]!;
            const root = normalizedRoots.threads[threadIndex]!;
            const followUps = visible.followUps.slice(0, Math.min(input.config.content.followUpDepth, remainingFollowUps));
            remainingFollowUps -= followUps.length;
            const rootAnswer = root.answer.split(/\n\s*(?:追问|Q\d*)[：:]/iu)[0]?.trim() || root.answer.trim();
            const cast = orchestrationPlan.personaScenePlan?.commentCast ?? [];
            const selectedRoleIndex = root.roleIndex ?? threadIndex % Math.max(1, cast.length);
            const selectedSurface = cast[selectedRoleIndex] ?? base.surfaceRoleCard;
            const topology = followUps.length >= 2
              ? "three_person_branch" as const
              : followUps.length === 1
                ? "two_turn" as const
                : selectedSurface?.utteranceMode === "social_reaction"
                  ? "reaction_then_reply" as const
                  : "single_exchange" as const;
            return {
              ...base,
              id: root.id,
              question: root.question,
              answer: rootAnswer,
              // Model-stated Cref contract v1.1 fields; bindDialogueProvenance
              // fills the positional defaults when the model left them out.
              kind: root.kind,
              answerKind: root.answerKind,
              boundary: root.boundary,
              // P3-15: a legal model-stated function wins at bind time; an absent
              // or illegal one falls back to the planning derivation.
              function: root.function,
              surfaceRoleCard: selectedSurface,
              conversationPlan: {
                topology,
                targetFollowUps: Math.min(2, followUps.length) as 0 | 1 | 2,
                openingMove: "由模型根据正文话头和缺口现场选择社会位置",
                replyMove: "楼主或可追责身份自然承接当前评论",
                extensionMove: followUps.length ? "从已出现的具体词或现实条件继续生长" : "当前话头自然停住",
              },
              followUps: followUps.map((visibleFollowUp, followUpIndex) => ({
                ...(base.followUps[followUpIndex] ?? {
                  personaRole: base.personaRole,
                  speakerType: "simulated_reader" as const,
                  claimStatus: "hypothetical" as const,
                  replyTo: root.id,
                  threadDepth: followUpIndex + 1,
                  simulated: true,
                  simulationLabel: "模拟潜在读者接话",
                }),
                question: visibleFollowUp.question,
                answer: visibleFollowUp.answer,
                kind: visibleFollowUp.kind,
                boundary: visibleFollowUp.boundary,
                evidenceIds: [],
              })),
            };
          }),
        },
      };
      draft = {
        ...deterministicBase,
        content: stagedContent,
      };
      const ledgerPrompt = buildStagedLedgerPrompt(promptInput, stagedContent);
      try {
        const ledgerResponse = await this.provider.generate({
          messages: ledgerPrompt.messages,
          responseSchema: ledgerPrompt.responseSchema,
          schemaName: "content_candidate_ledger",
          model: input.config.model.model,
          seed: seed + 3,
          temperature: Math.min(input.config.model.temperature, 0.2),
          maxOutputTokens: input.config.model.maxOutputTokens,
          metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_ledger", stage: 3 },
        });
        const ledgerObject = parseJsonObject(ledgerResponse.text);
        const parsed = parseGenerationDraft(JSON.stringify({ ...ledgerObject, content: stagedContent }));
        draft = {
          ...draft,
          evidenceIds: parsed.evidenceIds,
          reasoning: parsed.reasoning,
          unknowns: parsed.unknowns,
        };
      } catch (error) {
        stageIssues.push({
          code: "model_ledger_failed",
          severity: "error",
          channel: "package",
          message: `模型可见文案已保留，但事实台账阶段失败，必须人工复核：${error instanceof Error ? error.message : String(error)}`,
          repairable: false,
        });
      }
    } else {
      draft = deterministicDraft(input.config, context, ledger, candidateIndex, variation, impactReport, orchestrationPlan, planning.opportunity, evidenceSources);
    }

    const allowedEvidenceIds = availableEvidence.map((reference) => reference.id);
    if (!this.provider || !useProvider) {
      draft = keepCriticalBoundariesInBody(draft, orchestrationPlan, input.config);
    }
    draft = bindDialogueProvenance(draft, orchestrationPlan, allowedEvidenceIds, evidenceSources);
    draft = refreshCreativeScenarioIdentities(draft);
    let issues = [
      ...validateGenerationDraft({ draft, config: input.config, ledger, allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, orchestrationPlan, projectBlueprint: input.planningContext?.projectBlueprint }),
      ...stageIssues,
    ];
    let repairAttempts = 0;
    while (issues.some((item) => item.severity === "error" && item.repairable) && repairAttempts < input.config.generation.maxRepairAttempts) {
      repairAttempts += 1;
      const channels = channelsForIssues(issues);
      if (!channels.length) break;
      if (!this.provider || !useProvider) {
        const replacement = deterministicDraft(input.config, context, ledger, candidateIndex, variation, impactReport, orchestrationPlan, planning.opportunity, evidenceSources);
        draft = { ...replacement, content: mergeContentByChannels(draft.content, replacement.content, channels) };
      } else {
        const prompt = buildRepairPrompt({
          current: draft,
          issues,
          channels,
          config: input.config,
          knowledge: context,
          seed: seed + repairAttempts,
          attempt: repairAttempts,
          impactReport,
          imageAnalyses: planning.imageAnalyses,
          orchestrationPlan,
          evidenceReferences: availableEvidence,
        });
        try {
          const response = await this.provider.generate({
            messages: prompt.messages,
            responseSchema: prompt.responseSchema,
            schemaName: "content_repair_patch",
            model: input.config.model.model,
            seed: seed + repairAttempts,
            temperature: Math.min(input.config.model.temperature, 0.4),
            maxOutputTokens: input.config.model.maxOutputTokens,
            metadata: { jobId: input.jobId, candidateIndex, purpose: "repair", attempt: repairAttempts },
          });
          const patch = parseGenerationPatch(response.text);
          if (patch.Cref) {
            // P4-22: merge the visible-copy patch by thread id — out-of-order
            // and partial patches are fine (unreturned threads keep their
            // prose); only unplanned ids or a missing disclaimer fail.
            patch.Cref = mergeCrefPatchById(draft.content.Cref, patch.Cref);
          }
          draft = applyGenerationPatch(draft, patch);
        } catch (error) {
          // P4-22: a failed repair never fails the whole candidate. Record one
          // issue (terminal attempts are repairable:false), keep the channel's
          // original issues and the pre-repair draft; the candidate survives
          // for human review (surfaced as needs_review downstream).
          issues = [
            ...issues.filter((item) => item.code !== "repair_parse_failed"),
            {
              code: "repair_parse_failed",
              severity: "error",
              channel: "package",
              message: error instanceof Error ? error.message : String(error),
              repairable: repairAttempts < input.config.generation.maxRepairAttempts,
            },
          ];
          continue;
        }
      }
      if (!this.provider || !useProvider) {
        draft = keepCriticalBoundariesInBody(draft, orchestrationPlan, input.config);
      }
      draft = bindDialogueProvenance(draft, orchestrationPlan, allowedEvidenceIds, evidenceSources);
      draft = refreshCreativeScenarioIdentities(draft);
      issues = [
        ...validateGenerationDraft({ draft, config: input.config, ledger, allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, orchestrationPlan, projectBlueprint: input.planningContext?.projectBlueprint }),
        ...stageIssues,
      ];
    }

    const realizedPlanWithoutArtifacts: OrchestrationPlan = {
      ...orchestrationPlan,
      dialogueThreads: orchestrationPlan.dialogueThreads.map((thread, index) => ({
        ...thread,
        surfaceRoleCard: draft.content.Cref.threads[index]?.surfaceRoleCard ?? thread.surfaceRoleCard,
        conversationPlan: draft.content.Cref.threads[index]?.conversationPlan ?? thread.conversationPlan,
      })),
      gapCoverageLedger: evaluateGapCoverageRealization(draft, orchestrationPlan),
    };
    const productionArtifacts = buildProductionArtifacts({
      plan: realizedPlanWithoutArtifacts,
      content: draft.content,
      imageAnalyses: planning.imageAnalyses,
      imageBriefEnabled: input.config.content.imageBriefEnabled,
    });
    const realizedOrchestrationPlan: OrchestrationPlan = {
      ...realizedPlanWithoutArtifacts,
      productionArtifacts: structuredClone(productionArtifacts),
    };
    const allEvidence = availableEvidence;
    const createdAt = this.now().toISOString();
    const id = packageId(input.jobId, candidateIndex, seed);
    return {
      schemaVersion: "1.1",
      id,
      projectId: input.config.project.id,
      jobId: input.jobId,
      candidateId: `${input.jobId}:candidate:${candidateIndex + 1}`,
      candidateIndex,
      seed,
      createdAt,
      formulaSnapshot: {
        versionId: input.formulaVersion.id,
        digest: input.formulaVersion.digest,
        enabledFormulaIds: [...input.config.formula.enabledFormulaIds],
        executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
        executionPolicyDigest: FORMULA_EXECUTION_POLICY_DIGEST,
        executionAudit: formulaExecutionAudit(input.formulaVersion, input.config.formula.enabledFormulaIds),
      },
      configSnapshot: cloneConfig(input.config),
      knowledgeSnapshot: knowledgeSnapshotFor(input.knowledge, context),
      imagePlan: structuredClone(orchestrationPlan.imagePlan),
      productionArtifacts,
      dialogueThreads: structuredClone(orchestrationPlan.dialogueThreads),
      deploymentPlan: structuredClone(orchestrationPlan.deploymentPlan),
      orchestrationSnapshot: structuredClone(realizedOrchestrationPlan),
      coverageSignature: createCoverageSignature(realizedOrchestrationPlan, planning.opportunity.topic),
      content: draft.content,
      evidence: citedEvidenceSnapshot(allEvidence, draft.reasoning),
      reasoning: draft.reasoning,
      unknowns: uniqueUnknowns(ledger, draft),
      conflicts: ledger.conflicts,
      diagnostics: [...diagnosticsFromValidation(issues), ...buildParameterDiagnostics(impactReport)],
      resolutionSnapshot,
      impactReport,
      validation: { valid: !issues.some((item) => item.severity === "error"), repairAttempts, issues },
      revisions: [],
    };
  }

  async revise(input: ReviseContentInput): Promise<ReviseContentResult> {
    const formulaIssues = validateFormulaVersion(input.formulaVersion);
    if (formulaIssues.length) throw new Error(`Formula version is invalid: ${formulaIssues.map((item) => item.message).join("; ")}`);
    if (input.package.configSnapshot.formula.versionId !== input.formulaVersion.id) {
      throw new Error("Package config formula.versionId does not match the supplied immutable formula version.");
    }
    const dependency = analyzeRevisionDependencies({ instruction: input.instruction, explicitChannels: input.explicitChannels });
    const inheritedSelection = input.parameterSelection ?? {
      presetId: input.package.resolutionSnapshot?.presetId,
      styleProfileId: input.package.resolutionSnapshot?.styleProfileId,
    };
    const compilation = compileGenerationParameters(input.package.configSnapshot, input.formulaVersion, inheritedSelection);
    const config = compilation.config;
    const impactReport = compilation.impactReport;
    const context = buildContext(config, input.formulaVersion, input.knowledge, this.systemPromptTokenEstimate);
    const ledger = buildKnowledgeLedger(input.claims ?? [], input.package.unknowns);
    const refreshedEvidence = generationEvidenceReferences(config, input.knowledge, context, undefined, input.imageAnalyses ?? []);
    const availableEvidence = [...new Map(
      [...input.package.evidence, ...refreshedEvidence].map((reference) => [reference.id, reference]),
    ).values()];
    const evidenceSources = {
      ...Object.fromEntries(input.package.evidence.flatMap((reference) => {
        const persisted = reference.quotedSpans?.length ? reference.quotedSpans.join("\n") : reference.quote;
        return persisted ? [[reference.id, persisted]] : [];
      })),
      ...generationEvidenceSources(config, input.knowledge, context, undefined, input.imageAnalyses ?? []),
    };
    const revisionGaps = defaultInformationGaps(config, context);
    const revisionOpportunity = {
      ...defaultTopicOpportunity(config, revisionGaps),
      topic: input.package.coverageSignature?.topicKey ?? config.task.theme,
      id: input.package.orchestrationSnapshot?.topicOpportunityId ?? `revision_${input.package.id}`,
    };
    const current: GenerationDraft = {
      content: input.package.content,
      evidenceIds: input.package.evidence.map((item) => item.id),
      reasoning: input.package.reasoning,
      unknowns: input.package.unknowns,
    };
    let revised = current;
    if (this.provider) {
      const syntheticIssues: ContentValidationIssue[] = dependency.rerunChannels.map((channel) => ({
        code: dependency.semanticChange ? "user_revision_fact_consistency" : "user_revision_presentation",
        severity: "error",
        channel,
        message: input.instruction,
        repairable: true,
      }));
      const prompt = buildRepairPrompt({
        current,
        issues: syntheticIssues,
        channels: dependency.rerunChannels,
        config,
        knowledge: context,
        seed: input.package.seed + input.package.revisions.length + 1,
        attempt: 1,
        impactReport,
        imageAnalyses: input.imageAnalyses,
        orchestrationPlan: input.package.orchestrationSnapshot,
        evidenceReferences: availableEvidence,
      });
      const response = await this.provider.generate({
        messages: prompt.messages,
        responseSchema: prompt.responseSchema,
        schemaName: "chat_revision_patch",
        model: config.model.model,
        seed: input.package.seed + input.package.revisions.length + 1,
        temperature: config.model.temperature,
        maxOutputTokens: config.model.maxOutputTokens,
        metadata: { jobId: input.package.jobId, candidateIndex: input.package.candidateIndex, purpose: "revision" },
      });
      const patched = applyGenerationPatch(current, parseGenerationPatch(response.text));
      const contentRevision = dependency.rerunChannels.some((channel) => channel !== "H");
      revised = {
        ...patched,
        content: mergeContentByChannels(current.content, patched.content, dependency.rerunChannels),
        evidenceIds: contentRevision ? patched.evidenceIds : current.evidenceIds,
        reasoning: contentRevision ? patched.reasoning : current.reasoning,
        unknowns: contentRevision ? patched.unknowns : current.unknowns,
      };
    } else {
      const variation = variationFor(input.package.seed + input.package.revisions.length + 1, input.package.candidateIndex);
      const replacement = deterministicDraft(
        config,
        context,
        ledger,
        input.package.candidateIndex,
        variation,
        impactReport,
        input.package.orchestrationSnapshot,
        revisionOpportunity,
        evidenceSources,
      );
      revised = { ...replacement, content: mergeContentByChannels(current.content, replacement.content, dependency.rerunChannels) };
    }

    const allowedEvidenceIds = availableEvidence.map((reference) => reference.id);
    if (input.package.orchestrationSnapshot) {
      if (!this.provider) revised = keepCriticalBoundariesInBody(revised, input.package.orchestrationSnapshot, config);
      revised = bindDialogueProvenance(revised, input.package.orchestrationSnapshot, allowedEvidenceIds, evidenceSources);
      revised = refreshCreativeScenarioIdentities(revised);
    }
    const issues = validateGenerationDraft({ draft: revised, config, ledger, allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, orchestrationPlan: input.package.orchestrationSnapshot, projectBlueprint: input.planningContext?.projectBlueprint });
    const now = this.now().toISOString();
    const revision: RevisionRecord = {
      id: `rev_${createHash("sha256").update(`${input.package.id}:${input.instruction}:${input.package.revisions.length}`).digest("hex").slice(0, 16)}`,
      createdAt: now,
      instruction: input.instruction,
      directChannels: dependency.directChannels,
      rerunChannels: dependency.rerunChannels,
      parentPackageId: input.package.id,
    };
    const revisedEvidence = citedEvidenceSnapshot(availableEvidence, revised.reasoning);
    const revisionPlanWithoutArtifacts: OrchestrationPlan | undefined = input.package.orchestrationSnapshot
      ? {
        ...input.package.orchestrationSnapshot,
        gapCoverageLedger: evaluateGapCoverageRealization(revised, input.package.orchestrationSnapshot),
      }
      : undefined;
    const productionArtifacts = buildProductionArtifacts({
      plan: revisionPlanWithoutArtifacts,
      content: revised.content,
      imageAnalyses: input.imageAnalyses,
      imageBriefEnabled: config.content.imageBriefEnabled,
      previous: input.package.productionArtifacts,
    });
    const realizedRevisionPlan = revisionPlanWithoutArtifacts
      ? { ...revisionPlanWithoutArtifacts, productionArtifacts: structuredClone(productionArtifacts) }
      : undefined;
    const revisedPackage: ContentPackage = {
      ...input.package,
      id: `${input.package.id}_r${input.package.revisions.length + 1}`,
      createdAt: now,
      content: revised.content,
      productionArtifacts,
      knowledgeSnapshot: knowledgeSnapshotFor(input.knowledge, context),
      orchestrationSnapshot: realizedRevisionPlan,
      formulaSnapshot: {
        versionId: input.formulaVersion.id,
        digest: input.formulaVersion.digest,
        enabledFormulaIds: [...config.formula.enabledFormulaIds],
        executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
        executionPolicyDigest: FORMULA_EXECUTION_POLICY_DIGEST,
        executionAudit: formulaExecutionAudit(input.formulaVersion, config.formula.enabledFormulaIds),
      },
      evidence: revisedEvidence,
      reasoning: revised.reasoning,
      unknowns: uniqueUnknowns(ledger, revised),
      conflicts: ledger.conflicts,
      diagnostics: [...diagnosticsFromValidation(issues), ...buildParameterDiagnostics(impactReport)],
      configSnapshot: cloneConfig(config),
      resolutionSnapshot: compilation.resolutionSnapshot,
      impactReport,
      validation: { valid: !issues.some((item) => item.severity === "error"), repairAttempts: 0, issues },
      revisions: [...input.package.revisions, revision],
    };
    return { package: revisedPackage, dependency };
  }
}

export async function generateThreeCandidates(
  input: GenerationInput,
  options: ContentGenerationEngineOptions = {},
): Promise<GenerationResult> {
  return new ContentGenerationAgent(options).generate(input);
}
