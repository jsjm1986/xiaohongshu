import { createHash } from "node:crypto";

import {
  applyGenerationPatch,
  authorFactAuthorizesVisibleStatement,
  candidateQualityStatus,
  channelsForIssues,
  commentThreadFunction,
  issueDisposition,
  issueOverridePolicy,
  diagnosticsFromValidation,
  evaluateGapCoverageRealization,
  mergeCrefPatchById,
  normalizeContentValidationIssue,
  normalizePublicCommentBoundary,
  parseStagedCommentEditor,
  publicCommentSurfaceReasons,
  readerExchangeContinuesTopic,
  parseGenerationDraft,
  parseGenerationPatch,
  parseJsonObject,
  parseStagedCommentCopy,
  parseStagedCommentGrowth,
  parseStagedCommentNetworkEditor,
  parseStagedCommentReaders,
  parseStagedCoreCopy,
  parseStagedCoreEditor,
  parseStagedOrgAnswers,
  splitSensitiveStatements,
  STAGED_COMMENT_DISCLAIMER,
  type StagedCommentCopy,
  type StagedOrgAnswersCopy,
  verifyOrgAnswerSelfReview,
  validateGenerationDraft,
  validatePublishingTopologyCopy,
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
  combinedEvidenceSupport,
  conservativeEvidenceSupport,
  createSectionEvidenceReferences,
  evidenceReferenceCanSupportFact,
  evidenceIdForSection,
  exactEvidenceSupportSpans,
  estimateTokens,
  findSupportingSectionEvidenceIds,
  organizationNamePublicationRestricted,
  redactRestrictedProjectIdentity,
  resolveCanonicalEvidenceId,
  redactPublicationRestrictedText,
  publicationRestrictionsFromText,
  sectionEvidenceText,
  selectKnowledgeContext,
} from "./knowledge.js";
import {
  attachKnowledgeAnchors,
  attachKnowledgeAnchorSelections,
  collectUnanchoredSensitiveClaims,
  knowledgeAnchorEvidencePool,
  parseClaimJudgeVerdicts,
  resolveClaimJudgments,
  type KnowledgeAnchorContext,
} from "./knowledge-anchor.js";
import { ModelProviderError, type ModelProvider } from "./model.js";
import {
  GENERATION_CORE_OUTPUT_TOKENS,
  GENERATION_LEDGER_OUTPUT_TOKENS,
  GENERATION_REVIEW_OUTPUT_TOKENS,
  GENERATION_SHORT_OUTPUT_TOKENS,
} from "./output-budget.js";
import { buildParameterDiagnostics, compileGenerationParameters } from "./parameters.js";
import {
  assignCommentDisplayName,
  diagnoseAccountableIdentities,
  guardedReplyIdentitiesForQuestion,
  planTopicOrchestrations,
  questionMatchesPlannedGap,
  rankTopicOpportunities,
  createCoverageSignature,
} from "./planning.js";
import {
  buildClaimJudgePrompt,
  buildRepairPrompt,
  buildStagedCommentEditorPrompt,
  buildStagedCommentGrowthPrompt,
  buildStagedCommentNetworkEditorPrompt,
  buildStagedCommentReadersCorrectionPrompt,
  buildStagedCommentReadersPrompt,
  buildStagedCommentReadersRegenerationPrompt,
  buildStagedCorePrompt,
  buildStagedCoreEditorPrompt,
  buildStagedCoreIdentityRepairPrompt,
  buildStagedHostAnswersPrompt,
  buildStagedLedgerPrompt,
  buildStagedOrgAnswersPrompt,
  buildStagedOrgFollowUpAnswersPrompt,
  renderFormulaInstructions,
} from "./prompt.js";
import { analyzeRevisionDependencies, mergeContentByChannels } from "./revision.js";
import type {
  ArtifactRealization,
  CommentAnswerRealization,
  ContentChannel,
  ContentPackage,
  CommentGapCoverageLedger,
  ContentValidationIssue,
  EditorialAssessmentRecord,
  EvidenceReference,
  FormulaVersion,
  GenerationDraft,
  GenerationInput,
  GenerationResult,
  GenerationTelemetryEvent,
  GenerationValidationTelemetrySummary,
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
const LEGACY_PLANNING_CONTEXT_EVIDENCE_PATH = "planning.approved-context";

type HumanApprovedField = "answer" | "framework";

function humanApprovedEvidenceId(
  projectId: string,
  gap: InformationGap,
  field: HumanApprovedField,
  content: string,
): string | undefined {
  const confirmation = gap.humanConfirmation;
  if (gap.sourceStatus !== "user_supplied" || !confirmation?.confirmedBy.trim() || !confirmation.confirmedAt.trim()) return undefined;
  const identity = JSON.stringify({
    projectId,
    gapId: gap.id,
    field,
    content,
    boundary: gap.boundary ?? "",
    confirmedBy: confirmation.confirmedBy,
    confirmedAt: confirmation.confirmedAt,
  });
  return `evidence_human_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24)}`;
}

function humanApprovedEvidenceReferences(
  projectId: string,
  planningContext?: GenerationInput["planningContext"],
): EvidenceReference[] {
  return (planningContext?.informationGaps ?? []).flatMap((gap): EvidenceReference[] => {
    const confirmation = gap.humanConfirmation;
    if (gap.sourceStatus !== "user_supplied" || !confirmation?.confirmedBy.trim() || !confirmation.confirmedAt.trim()) return [];
    return (["answer", "framework"] as const).flatMap((field): EvidenceReference[] => {
      const quote = gap[field]?.trim();
      if (!quote) return [];
      const id = humanApprovedEvidenceId(projectId, gap, field, quote);
      if (!id) return [];
      const checksum = createHash("sha256").update(quote, "utf8").digest("hex");
      return [{
        id,
        documentId: `human-confirmation:${gap.id}:${field}`,
        path: `planning.human-confirmation/${gap.id}/${field}`,
        section: `${field} confirmed by project owner`,
        quote,
        documentChecksum: checksum,
        documentVersion: confirmation.confirmedAt,
        sectionChecksum: checksum,
        kind: "fact",
        evidenceStatus: "user_supplied",
        scope: [`gap:${gap.id}`, "project-owner-assertion"],
        caveats: [
          `Confirmed by ${confirmation.confirmedBy} at ${confirmation.confirmedAt}.`,
          "This records a project-owner assertion; it is not independent external verification.",
          ...(gap.boundary?.trim() ? [`Boundary: ${gap.boundary.trim()}`] : []),
        ],
      }];
    });
  });
}

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
  /** Formal API delivery requires an actual model run and complete required-gap realization. */
  deliveryReadinessPolicy?: "structural" | "formal";
}

/**
 * AI 判官(敏感声明校验与证据挂账的联合语义层):机械锚定后仍未锚定的
 * 词表命中句,批量一次模型调用做分类与支持判断。裁决经机械校验(引文必须是
 * 证据源内逐字连续片段,不过改判无据)后以文本匹配形式并入 draft.claimJudgments,
 * 由校验层消费:邀约/限定/疑问放行,事实断言 supported 放行、unsupported 报
 * error(与旧行为同码)。无未锚定句不调用(零成本);调用或解析失败安全降级为
 * 无裁决——校验层走词面旧逻辑,error 照旧,不更坏。
 */
export async function judgeSensitiveClaimsWithModel(
  provider: ModelProvider,
  draft: GenerationDraft,
  context: KnowledgeAnchorContext,
  request: {
    model?: string;
    seed?: number;
    temperature?: number;
    maxOutputTokens?: number;
    metadata?: Record<string, string | number | boolean>;
    /**
     * 判官失败时的观测钩子。原实现 catch 后静默返回,判官这一层可以整体失效而
     * 不留任何信号:实测生产 174 个包 claimJudgments 全为 0、其中 60 个包报出
     * sensitive_claim_without_evidence,却无从判断是文案无据还是判官没跑。
     * 降级行为保持不变(仍回退词面旧逻辑),只是把真因交给调用方记录。
     */
    onFailure?: (error: unknown) => void;
  },
): Promise<GenerationDraft> {
  // 无未锚定句或无锚定池时不调用;同时清掉可能残留的过期裁决(句面已变)。
  const clear = (): GenerationDraft => draft.claimJudgments ? { ...draft, claimJudgments: undefined } : draft;
  const claims = collectUnanchoredSensitiveClaims(draft, context);
  if (!claims.length) return clear();
  const evidencePool = knowledgeAnchorEvidencePool(context);
  if (!evidencePool.length) return clear();
  const prompt = buildClaimJudgePrompt({
    statements: claims.map((claim) => claim.statement),
    evidenceSources: evidencePool,
  });
  try {
    const response = await provider.generate({
      messages: prompt.messages,
      responseSchema: prompt.responseSchema,
      schemaName: "claim_judge",
      model: request.model,
      seed: request.seed,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      metadata: request.metadata,
    });
    const verdicts = parseClaimJudgeVerdicts(parseJsonObject(response.text), claims.length);
    const anchored = attachKnowledgeAnchorSelections(
      draft,
      context,
      claims,
      verdicts.flatMap((verdict) => verdict.classification === "factual_assertion"
        && verdict.supported === true && verdict.evidenceId && verdict.quote
        ? [{ statementIndex: verdict.statementIndex, evidenceId: verdict.evidenceId, quote: verdict.quote }]
        : []),
    );
    return { ...anchored, claimJudgments: resolveClaimJudgments(claims, verdicts, evidencePool) };
  } catch (error) {
    request.onFailure?.(error);
    return clear();
  }
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
  // Planning resources remain model-visible drafting inputs, but are not facts.
  // Only explicit task fields, disclosed knowledge/image observations, and
  // individually frozen owner confirmations enter the factual evidence pool.
  const humanReferences = humanApprovedEvidenceReferences(config.project.id, planningContext);
  const imageReferences = approvedImageAnalyses
    .map(imageAnalysisEvidenceReference)
    .filter((reference): reference is EvidenceReference => Boolean(reference));
  return [taskProjectEvidence(config), ...humanReferences, ...imageReferences, ...createSectionEvidenceReferences(documents, context)];
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
        // Section references carry a server-sanitized public quote. Prefer it
        // over the raw selected section so internal/non-public sibling clauses
        // can never be selected into sourceSpans or persisted quotedSpans.
        reference.quote ?? sectionEvidenceText(context, reference.id) ?? "",
      ] as const)
      .filter(([, source]) => source.length > 0),
  );
}

function sourceSpansForClaim(
  claim: string,
  evidenceIds: string[],
  evidenceSources: Record<string, string>,
): Array<{ evidenceId: string; quote: string }> {
  for (const evidenceId of evidenceIds) {
    const source = evidenceSources[evidenceId];
    if (!source) continue;
    const quotes = exactEvidenceSupportSpans(claim, source);
    if (quotes.length) return quotes.map((quote) => ({ evidenceId, quote }));
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
      // Publication restrictions are generation-time server guards. Persisting
      // their exact internal clauses would expose them through package audit or
      // export surfaces, so both initial and revised evidence snapshots omit them.
      const { publicationRestrictions: _publicationRestrictions, ...persistableReference } = reference;
      return {
        ...persistableReference,
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
  const references = generationEvidenceReferences(input.config, input.knowledge, context, input.planningContext);
  const sources = generationEvidenceSources(input.config, input.knowledge, context, input.planningContext);
  const approvedIds = [...new Set(gap.evidenceIds
    .map((id) => resolveCanonicalEvidenceId(id, references))
    .filter((id): id is string => Boolean(id)))];
  const evidenceFor = (statement: string | undefined, field: HumanApprovedField): string[] => {
    if (!statement?.trim()) return [];
    // Preserve an approved citation when the same current, immutable source
    // still supports the reviewed wording. Only then search the rest of the
    // disclosed catalogue. This prevents a valid approval from being silently
    // detached merely because a later retrieval order changed.
    const mapped = approvedIds.filter((id) => {
      const source = sources[id];
      return source ? combinedEvidenceSupport(statement, [source]) : false;
    });
    mapped.push(...findSupportingSectionEvidenceIds([statement], context));
    if (taskEvidenceSupports(input.config, [statement])) mapped.push(TASK_PROJECT_EVIDENCE_ID);
    const humanEvidenceId = humanApprovedEvidenceId(input.config.project.id, gap, field, statement.trim());
    if (humanEvidenceId) mapped.push(humanEvidenceId);
    return [...new Set(mapped)];
  };
  const retainSupportedSentences = (value: string, field: HumanApprovedField): { text?: string; evidenceIds: string[]; partial: boolean } => {
    const fullIds = evidenceFor(value, field);
    if (fullIds.length) return { text: value, evidenceIds: fullIds, partial: false };
    // Fail soft at sentence/semicolon boundaries. Each retained sentence must
    // independently pass the same evidence gate; unsupported siblings remain
    // visible in the audit issue instead of erasing supported facts.
    const sentences = value
      .split(/(?<=[。！？!?；;])|\n+/u)
      .map((item) => item.trim())
      .filter(Boolean);
    const retained = sentences.map((sentence) => ({ sentence, ids: evidenceFor(sentence, field) }))
      .filter((item) => item.ids.length > 0);
    return retained.length
      ? { text: retained.map((item) => item.sentence).join(""), evidenceIds: [...new Set(retained.flatMap((item) => item.ids))], partial: true }
      : { evidenceIds: [], partial: false };
  };
  // Governance-only clauses are not factual answer atoms. Bind the public
  // remainder first; otherwise a compound value such as “public address + name
  // must not be disclosed” fails evidence matching as a whole and is wrongly
  // downgraded to unknown before planning can separate its visible duties.
  const publicAnswer = gap.answer ? redactPublicationRestrictedText(gap.answer).trim() : "";
  const publicFramework = gap.framework ? redactPublicationRestrictedText(gap.framework).trim() : "";
  const answerBinding = publicAnswer ? retainSupportedSentences(publicAnswer, "answer") : { evidenceIds: [], partial: false };
  const frameworkBinding = publicFramework ? retainSupportedSentences(publicFramework, "framework") : { evidenceIds: [], partial: false };
  const answer = answerBinding.text;
  const framework = frameworkBinding.text;
  const evidenceIds = [...new Set([...answerBinding.evidenceIds, ...frameworkBinding.evidenceIds])];
  const hasProposedAnswer = Boolean(publicAnswer || publicFramework);
  const degraded = hasProposedAnswer && (!answer && !framework);
  const partial = answerBinding.partial || frameworkBinding.partial;
  const runtimeIssues = partial || degraded ? [{
    path: "generation.bindGapEvidence",
    statement: [publicAnswer, publicFramework].filter(Boolean).join("\n"),
    reason: "unsupported_statement" as const,
    evidenceIds: [...gap.evidenceIds],
  }] : [];
  return {
    ...gap,
    answer,
    framework,
    evidenceIds,
    proofability: degraded ? 0 : gap.proofability,
    evidenceValidationIssues: [...(gap.evidenceValidationIssues ?? []), ...runtimeIssues],
    evidenceBindingStatus: degraded ? "downgraded" : partial ? "partial" : hasProposedAnswer ? "supported" : "not_applicable",
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

function topicBigrams(value: string): Set<string> {
  const normalized = value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return new Set(Array.from({ length: Math.max(0, normalized.length - 1) }, (_, index) => normalized.slice(index, index + 2)));
}

function explicitThemePlanningGaps(
  config: ResolvedGenerationConfig,
  gaps: InformationGap[],
): InformationGap[] {
  const themePairs = topicBigrams(config.task.theme);
  const scored = gaps.map((gap) => {
    const surfacePairs = topicBigrams(`${gap.label} ${gap.question}`);
    const overlap = [...themePairs].filter((pair) => surfacePairs.has(pair)).length;
    return { gap, overlap };
  }).filter((item) => item.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.gap.importance - left.gap.importance)
    .slice(0, 2)
    .map((item) => item.gap);
  const supportingEvidenceIds = [...new Set(scored.flatMap((gap) => gap.evidenceIds))];
  const themeGap: InformationGap = {
    id: `task_theme_${createHash("sha256").update(config.task.theme, "utf8").digest("hex").slice(0, 12)}`,
    label: config.task.theme,
    question: /[？?]$/u.test(config.task.theme) ? config.task.theme : `${config.task.theme}？`,
    category: "decision",
    audienceStages: [config.task.audienceStage],
    importance: 1,
    decisionLeverage: 1,
    proofability: supportingEvidenceIds.length ? 0.75 : 0.4,
    evidenceIds: supportingEvidenceIds,
    required: true,
    preferredChannels: ["N.body"],
  };
  return [themeGap, ...scored];
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
  if (planning?.taskThemeLocked && !planning.selectedOpportunityId) {
    gaps = explicitThemePlanningGaps(input.config, gaps);
    opportunity = defaultTopicOpportunity(input.config, gaps);
    opportunitySelectionAudit = {
      selectedOpportunityId: opportunity.id,
      selectionMode: "default_policy",
      rankStatus: "not_applied",
      rankNotAppliedReason: "The user supplied an explicit topic; approved opportunity ranking was intentionally bypassed.",
    };
  } else if (planning?.selectedOpportunityId) {
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
  const supporting = config.task.publishingTopology === "institution_owned"
    ? ["本次只说明已有依据与适用条件。", "尚未核实的信息保持未知，不替读者作个人结论。", "具体判断应结合已披露条件继续核实。"]
    : config.task.publishingTopology === "confirmed_individual_author"
      ? ["其余个人情况不作补充。", "未确认的时间、地点、动作和结果保持未知。", "项目事实由可追责机构身份另行说明。"]
      : ["这事我也是最近才开始认真看。", "主要还是怕影响平时的安排，越刷越拿不准。", "有了解的说说真实情况吧。"];
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
  const closing = config.task.publishingTopology === "institution_owned"
    ? "尚未核实的信息保持未知。"
    : config.task.publishingTopology === "confirmed_individual_author"
      ? "其余个人情况不作补充。"
      : "有了解的也可以说说。";
  while ([...body].length < config.content.bodyMinChars) body = `${body}${body ? "\n\n" : ""}${closing}`;
  if ([...body].length > config.content.bodyMaxChars) body = [...body].slice(0, config.content.bodyMaxChars).join("").trimEnd();
  return body;
}

function publicCopyBoundary(value: string): boolean {
  // Policy instructions constrain the writer but are not audience-facing copy.
  // Keep natural limitations (for example “具体以当期确认为准”), while hiding
  // backend wording such as “不允许写/禁止使用/统一口径”.
  return !/(?:不允许|不得|禁止|不能|避免|不要)(?:写|说|使用|出现|宣称)|(?:禁用|统一口径|表达红线|内部口径)/u.test(value);
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
  const boundaries = [...new Set([...config.informationWindow.boundaries, ...planBoundaries])]
    .filter(publicCopyBoundary);
  const boundaryText = boundaries.length
    ? `边界要提前写明：${boundaries.join("；")}。`
    : "判断只在资料明确的范围内成立；个体结果和平台触达都不能由文案公式保证。";
  const factStatements = facts.map((fact) => `项目资料能确认：${fact}。`);
  const factText = facts.length
    ? factStatements.join("")
    : "现有资料不足以支持具体结果，只能先给核验方向。";
  const bodyGapRequirements = bodyGapCards.map((card) => {
    const resolution = card.answer ?? card.framework;
    const cardBoundary = card.boundary && publicCopyBoundary(card.boundary) ? card.boundary : undefined;
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
  const primaryGapCard = bodyGapCards[0];
  const primaryGap = primaryGapCard?.question ?? gaps[0] ?? `关于${topic}到底该先看什么？`;
  const primaryGapHasEvidence = Boolean(
    primaryGapCard
    && (primaryGapCard.answer || primaryGapCard.framework)
    && primaryGapCard.evidenceIds.length,
  );
  // An unresolved question may itself contain example claims (“短暂刺痛、酸胀…”).
  // Repeating it in deterministic body copy turns a question premise into a
  // visible factual fragment. Keep only the gap label and an explicit question;
  // comment questions may still quote the reader's actual uncertainty.
  const openQuestion = primaryGapCard && !primaryGapHasEvidence
    ? `关于${primaryGapCard.label}，目前有哪些信息可以公开核实？`
    : primaryGap.replace(/[。！!]+$/u, "").replace(/^[：:]/u, "");
  const individualAuthor = config.task.publishingTopology === "confirmed_individual_author";
  const institutionOwned = config.task.publishingTopology === "institution_owned";
  const authorFactStatements = config.task.authorContext.facts.map((fact) => fact.statement.trim()).filter(Boolean);
  const requiredOpenGap = bodyGapCards.find((card) => card.required && !((card.answer || card.framework) && card.evidenceIds.length));
  const institutionFocus = [
    "先说明已有依据与未知边界",
    "按同一组条件整理比较口径",
    "把最影响判断的一项单独说清",
  ][candidateIndex]!;
  const nameGovernance = [
    config.task.goal,
    config.informationWindow.boundaries,
    orchestrationPlan?.gapPlanningCards?.flatMap((card) => card.publicationRestrictions ?? []),
  ];
  const publicProjectName = organizationNamePublicationRestricted(...nameGovernance)
    ? "本机构"
    : config.project.name;
  const institutionFragments = redactRestrictedProjectIdentity([
    `${publicProjectName}官方账号就“${topic}”整理一项说明：${institutionFocus}。`,
    requiredOpenGap ? `${requiredOpenGap.label}目前仍待核实。` : "",
    decisionText,
    factText,
    boundaryText,
  ], config.project.name, ...nameGovernance);
  const authorFragments = [
    ...authorFactStatements,
    `关于“${topic}”，本次只保留一个问题：${openQuestion}`,
    "其余个人情况不作补充。",
  ];
  const rawHostLead = host?.identityCue ?? ["上班族", "第一次认真做功课的人", "最近一直在刷相关内容的人"][candidateIndex]!;
  const hostLead = /^(?:用户|客户|读者|目标人群)/u.test(rawHostLead) ? "最近一直在刷相关内容的人" : rawHostLead;
  const sceneLead = event?.setting ?? "最近刷内容的时候";
  const friction = host?.immediateConstraint ?? event?.friction ?? "怕影响平时安排";
  const factWhisper = facts[0] && method.decisionInformationDepth >= 85 ? `我目前只确认到${facts[0]}。` : "";
  const creativeBodyByPrototype: Record<string, string[]> = {
    narrow_request: [`${hostLead}，${friction}。${openQuestion}`],
    live_moment: [`${event?.timeAnchor ?? "刚刚"}${sceneLead}，${event?.observableAction ?? "顺手记了一条"}。`, `${event?.friction ?? friction}，等会儿再看具体怎么说。`],
    expectation_reversal: [`本来都按${topic}安排好了，结果新得到的信息跟我想的不一样。`, `${event?.emotionalAftertaste ?? "现在还有点没反应过来"}，${openQuestion}`],
    process_log: [`${event?.timeAnchor ?? "今天"}${event?.observableAction ?? "记录了一下"}，${event?.friction ?? friction}。`, `${event?.emotionalAftertaste ?? "先记一下今天的情况"}。`],
    outcome_observation: [`${sceneLead}${event?.observableAction ?? "突然多留意了一下"}，${event?.emotionalAftertaste ?? "感受和以前有点不同"}。`],
    retrospective_update: [`${event?.timeAnchor ?? "隔了一段时间"}才想起来说说，${event?.observableAction ?? "翻到以前的记录"}。`, `${event?.friction ?? "平时状态也会有起伏"}，只说我现在看到的。`],
    relationship_moment: [`${hostLead}，以前${event?.friction ?? "在同一个场景总会犹豫一下"}。`, `今天${event?.observableAction ?? "做了一个以前不会做的小动作"}，${event?.emotionalAftertaste ?? "心里轻松了一点"}。`],
    option_comparison: [`最近看${topic}的信息看得有点乱，已经比较到一半，还是卡在${friction}。`, openQuestion],
  };
  const creativeSceneFragments = [
    requiredOpenGap ? `关于${requiredOpenGap.label}我还没问明白，得再确认具体情况。` : "",
    ...(creativeBodyByPrototype[personaScene?.prototype ?? "narrow_request"] ?? creativeBodyByPrototype.narrow_request!),
    factWhisper,
  ];
  const bodyFragments = [
    mustMention ? `${mustMention}。` : "",
    ...(institutionOwned ? institutionFragments : individualAuthor ? authorFragments : creativeSceneFragments),
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
    const threadKind = planned?.threadKind ?? "org_answer";
    const ownsProjectGap = (planned?.coverageRole ?? (threadKind === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap";
    const gapCard = ownsProjectGap
      ? (orchestrationPlan?.gapPlanningCards?.find((item) => item.gapId === planned?.gapId)
        ?? commentGapCards[index % Math.max(1, commentGapCards.length)])
      : undefined;
    const gapText = (gapCard?.question ?? primaryGap).replace(/[。！!]+$/u, "");
    const shortGap = [...gapText].slice(0, 20).join("");
    const shortGapCore = shortGap.replace(/[？?]+$/u, "");
    // Weave the gap phrase only when it is short enough to read naturally inside
    // a casual sentence; long formal gap questions would produce stilted copy.
    // Uniqueness among threads is carried by template cycling below, not by weaving.
    const weave = shortGapCore.length <= 10 ? shortGapCore : "";
    const userQuestions: Record<string, string> = {
      direct_question: shortGap.endsWith("？") ? shortGap : `${shortGap}？`,
      shared_concern: weave ? `我也卡在${weave}，越看越不敢定` : "我也卡在这个，越看越不敢定",
      experience_fragment: `我也在查这个，${shortGapCore}还没弄明白`,
      counterexample: weave ? `我不会只看一个答案，${weave}还得问条件不一样怎么办` : "我不会只看一个答案，还会问条件不一样怎么办",
      social_reaction: "这个状态看着真的轻松了一点",
      detail_spotter: weave ? `我才看到这个细节，${weave}是不是也得单独问` : "我才看到这个细节，是不是也得单独问",
      knowledge_translation: "这个简单说主要看哪一点呀",
      identity_route: "这个具体找谁或去哪里核实呀",
      service_answer: "这个现在怎么确认比较准呀",
    };
    const institutionQuestions: Record<string, string> = {
      direct_question: `想确认一个具体问题：${shortGap.endsWith("？") ? shortGap : `${shortGap}？`}`,
      shared_concern: weave ? `如果现实条件不同，${weave}的判断会怎么变` : "如果现实条件不同，判断范围会怎么变",
      experience_fragment: `准备咨询前，${shortGapCore}需要带哪些情况说明`,
      counterexample: weave ? `${weave}不能只看一个结论，还要核实哪些前提` : "同一个结论不一定适用，还要核实哪些前提",
      social_reaction: "这个边界说明很有必要",
      detail_spotter: weave ? `${weave}涉及的条件范围能再说具体一点吗` : "这里的条件范围能再说具体一点吗",
      knowledge_translation: "能用一句话说明判断顺序吗",
      identity_route: "这项应该由哪个明确身份来确认",
      service_answer: "行动前还要再次确认哪些动态信息",
    };
    const questions = institutionOwned ? institutionQuestions : userQuestions;
    const userAnswers: Record<string, string> = {
      direct_question: "我也还没定，就是怕这个才发出来问",
      shared_concern: weave ? `对，${weave}我现在也是信息越多越纠结` : "对，我现在也是信息越多越纠结",
      experience_fragment: "这个办法好，我也把自己的现实安排一起带去问",
      counterexample: "对，先把条件不一样的情况问出来，心里更有数",
      social_reaction: "哈哈我也是今天才后知后觉",
      detail_spotter: "对，我也是刚注意到，准备去的时候一起问",
      knowledge_translation: "我打算先把自己的情况说清楚，让对方按情况讲人话",
      identity_route: "我还在看，等确定了具体问谁再回你",
      service_answer: "这个会变，我行动前再确认一下比较稳",
    };
    const institutionAnswers: Record<string, string> = {
      direct_question: "先把会改变判断的个人条件说清，再核对当前口径。",
      shared_concern: "条件变化时不能沿用同一结论，需要重新确认适用范围。",
      experience_fragment: "可以带上现实安排和已知情况，避免只问一个抽象结论。",
      counterexample: "对，先确认前提和例外，再看结论是否适用。",
      social_reaction: "边界会直接影响判断，这一项应单独说明。",
      detail_spotter: "需要把条件范围拆开确认，不能从一个细节直接推结论。",
      knowledge_translation: "先确认条件，再核对依据，最后保留仍未知的部分。",
      identity_route: "应由能对该项负责的明确身份按现有依据确认。",
      service_answer: "动态信息要在行动前按当期情况再次确认。",
    };
    const answers = institutionOwned ? institutionAnswers : userAnswers;
    const rawQuestion = questions[surface.utteranceMode] ?? shortGap;
    const ungroundedGap = !((gapCard?.answer || gapCard?.framework) && (gapCard?.evidenceIds.length ?? 0) > 0);
    const userUnknownAnswers: Record<string, string> = {
      direct_question: "这点我也还没问明白，得再确认具体情况",
      shared_concern: "我现在也拿不准，准备再问清情况",
      experience_fragment: "每个人情况不一样，我不敢照自己的替你定",
      counterexample: "对，所以最好把自己的情况再确认一下",
      social_reaction: "这个我也想知道，等问明白了再说",
      detail_spotter: "我也只是刚注意到，先别按一个细节自己定",
      knowledge_translation: "这点得看具体情况，我现在还不敢替你定",
      identity_route: "我还没问清，先确认应该向谁核实",
      service_answer: "具体情况还没确认，采取行动前再问一下比较稳",
    };
    const institutionUnknownAnswers: Record<string, string> = {
      direct_question: "这项目前无法确认，需要先核实会改变判断的具体情况。",
      shared_concern: "当前没有统一结论，条件不同就要重新确认适用范围。",
      experience_fragment: "现有信息不足，先补充个人情况和现实限制再判断。",
      counterexample: "这个反例会改变答案，目前只能保留未知并核实前提。",
      social_reaction: "这一项仍未确认，不能从当前信息直接得出结论。",
      detail_spotter: "单个细节不足以判断，还需要核实完整条件范围。",
      knowledge_translation: "简单说就是依据不足，目前不能替个人确定。",
      identity_route: "当前无法确认，应向对该项负责的明确身份核实。",
      service_answer: "动态信息尚未确认，行动前应按当期情况核实。",
    };
    const unknownAnswerVariants = institutionOwned ? institutionUnknownAnswers : userUnknownAnswers;
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
    // 读者互动层:T3 漂浮短反应从 4-20 字短共鸣池取开口,answer 为空(无回答
    // 需求);T2 读者互聊的 answer 是读者 B 的接话,不用机构答复模板。
    const organicReactionPool = institutionOwned
      ? ["这条边界先记下", "条件范围很重要", "先看判断前提", "未知项要保留", "等明确口径"]
      : ["蹲一个", "姐妹我也是", "码住慢慢看", "先收藏了", "看看后续怎么说"];
    const organicReactionTable = Object.fromEntries(utteranceModePool.map((mode, modeIndex) =>
      [mode, organicReactionPool[modeIndex % organicReactionPool.length]!]));
    const generatedQuestion = threadKind === "organic_reaction"
      ? pickDistinct(organicReactionTable, usedNaturalQuestions, "蹲一个")
      : threadKind === "reader_exchange"
        ? (institutionOwned
          ? ["我想确认的也是这个条件", "这个判断前提我也没弄清", "这里的适用范围我也在问", "先看看条件不同怎么处理"][index % 4]!
          : ["我也卡在这一步", "同问，我也没想明白", "这个我也在纠结", "先蹲蹲大家怎么想"][index % 4]!)
        : threadKind === "host_reply"
          ? "所以你现在还是没定下来吗？"
          : pickDistinct(questions, usedNaturalQuestions, rawQuestion);
    // 无模型降级稿也遵守与阶段化生成相同的冻结主问题合同。通用人物模板可能只写
    // “这个怎么确认”，无法证明仍在原 gap 上；此时把 gap 标签自然带回可见问题，
    // 而不是等最终校验报错。T3 仍保持短反应，只保留一个主 gap 锚点。
    const anchoredQuestion = ownsProjectGap && gapCard && planned && !questionMatchesPlannedGap(generatedQuestion, gapCard)
      ? threadKind === "organic_reaction"
        ? `${gapCard.label}也蹲一个`
        : `关于${gapCard.label}，${generatedQuestion}`
      : generatedQuestion;
    // 同一主 gap 可以有多条社会位置不同的评论，但不能生成完全相同的问题。
    // 去重必须发生在“补回主 gap 锚点”之后，否则多个通用模板会被锚定成同一句。
    const questionContexts = ["第一次了解时，", "拿不同选择比较时，", "准备下一步时，", "如果更在意风险，"];
    const question = usedNaturalQuestions.has(comparable(anchoredQuestion))
      ? threadKind === "organic_reaction"
        ? `${gapCard?.label ?? shortGapCore}${["同问", "也想知道", "先码住", "等后续"][index % 4]}`
        : `${questionContexts[index % questionContexts.length]}${anchoredQuestion}`
      : anchoredQuestion;
    usedNaturalQuestions.add(comparable(question));
    const groundedGapAnswer = gapCard?.answer ?? gapCard?.framework;
    const answer = threadKind === "organic_reaction"
      ? ""
      : threadKind === "reader_exchange"
        ? (institutionOwned
          ? ["对，我也想先确认判断前提。", "同感，条件范围还得问清。", "我先把动态信息单独核实。", "确实，不能省掉适用边界。"][index % 4]!
          : ["我也是，准备再多问一句。", "同感，我还没敢定。", "我也先等等看。", "这个确实容易纠结。"][index % 4]!)
        : threadKind === "host_reply"
          ? (config.task.authorContext.facts.find((fact) => (planned?.authorFactIds ?? []).includes(fact.id))?.statement
            ?? "我现在还没定下来。")
          : groundedGapAnswer
            ? (institutionOwned
              ? `现有口径是：${groundedGapAnswer}${gapCard?.boundary ? `；适用边界：${gapCard.boundary}` : ""}`
              : `${groundedGapAnswer}${gapCard?.boundary ? `；${gapCard.boundary}` : ""}`)
            : (institutionOwned
              ? `${gapCard?.label ?? "这件事"}目前无法确认，需要先核实具体条件和适用范围。`
              : `${gapCard?.label ?? "这件事"}还没确认，先问清具体情况再定。`);
    usedNaturalAnswers.add(comparable(answer));
    const plannedFollowUps = planned?.conversationPlan?.targetFollowUps ?? 0;
    const fallbackFollowUpLines = institutionOwned
      ? [
          { question: "如果现实安排不同，原来的判断还适用吗", answer: "不一定，需要把时间条件重新纳入确认。" },
          { question: "那行动前最后要核实哪一项", answer: "先核实会改变结论的条件和当期动态信息。" },
        ]
      : [
          { question: "等等，你说的是紧接着就有重要安排吗", answer: "对，我最怕的就是现实时间对不上" },
          { question: "那我懂了，我还得把自己的安排也算进去", answer: "是，先把时间卡点说清楚会好问很多" },
        ];
    const followUps = threadKind === "org_answer"
      ? Array.from({ length: Math.min(config.content.followUpDepth, plannedFollowUps) }, (_, followUpIndex) => {
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
      })
      : [];
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
      answerIdentity: threadKind === "reader_exchange"
        ? "simulated_reader" as const
        : threadKind === "organic_reaction" ? "none" as const : (planned?.postingIdentity ?? "publisher" as const),
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
      threadKind,
      replyDisplayName: planned?.replyDisplayName,
      replySurfaceRoleCard: planned?.replySurfaceRoleCard,
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
    const threadKind = planned?.threadKind ?? "org_answer";
    const ownsProjectGap = (planned?.coverageRole ?? (threadKind === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap";
    const plannedGapCard = ownsProjectGap
      ? orchestrationPlan?.gapPlanningCards?.find((item) => item.gapId === planned?.gapId)
      : undefined;
    const gap = plannedGapCard?.question ?? fallbackCommentGap?.question ?? gaps[index % gaps.length] ?? `还需要确认什么信息${index + 1}？`;
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
    // 读者互动层:T3 漂浮短反应的开口为 4-20 字短共鸣,不走缺口问句模板。
    if (threadKind === "organic_reaction") {
      question = ["蹲一个", "姐妹我也是", "码住慢慢看", "先收藏了"][index % 4]!;
    }
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
    const plannedGap = plannedGapCard;
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
    const groundedGapAnswer = plannedGap?.answer ?? plannedGap?.framework;
    const answer = threadKind === "organic_reaction"
      ? ""
      : threadKind === "reader_exchange"
        ? (institutionOwned
          ? ["对，我也想先确认判断前提。", "同感，条件范围还得问清。", "我先把动态信息单独核实。", "确实，不能省掉适用边界。"][index % 4]!
          : ["我也是，准备再多问一句。", "同感，我还没敢定。", "我也先等等看。", "这个确实容易纠结。"][index % 4]!)
        : threadKind === "host_reply"
          ? (config.task.authorContext.facts.find((fact) => (planned?.authorFactIds ?? []).includes(fact.id))?.statement
            ?? "我现在还没定下来。")
          : groundedGapAnswer
            ? `${groundedGapAnswer}${plannedGap?.boundary ? `；${plannedGap.boundary}` : ""}`
            : `${plannedGap?.label ?? "这件事"}还没确认，先问清具体情况再定。`;
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
      followUps: threadKind === "org_answer" ? Array.from({ length: Math.max(0, config.content.followUpDepth - 1) }, (__, followUpIndex) => ({
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
      })) : [],
      postingIdentity: planned?.postingIdentity ?? "publisher" as const,
      answerIdentity: threadKind === "reader_exchange"
        ? "simulated_reader" as const
        : threadKind === "organic_reaction" ? "none" as const : (planned?.postingIdentity ?? "publisher" as const),
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
      threadKind,
      replyDisplayName: planned?.replyDisplayName,
      replySurfaceRoleCard: planned?.replySurfaceRoleCard,
    };
  });
  // Publisher-owned copy is a separate publishable asset, never a synthesis of
  // simulated reader questions. Keep one or two accountable answer points and
  // omit the field when no organization answer can safely carry it.
  const ownedFirstCommentParts = threads
    .filter((thread) => (thread.threadKind ?? "org_answer") === "org_answer"
      && thread.postingIdentity !== "author" && thread.answer.trim())
    .map((thread) => thread.answer.trim().replace(/[。！!；;]+$/u, ""))
    .filter((answer, index, all) => all.indexOf(answer) === index)
    .slice(0, 2);
  const ownedFirstComment = ownedFirstCommentParts.length
    ? `补充一个会影响判断的点：${ownedFirstCommentParts.join("；")}。先结合自己的条件看是否适用，不需要急着做决定。`
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
  const surfaceTitle = personaScene && !institutionOwned && !individualAuthor
    ? surfaceTitles[personaScene.prototype]?.[candidateIndex % (surfaceTitles[personaScene.prototype]?.length || 1)]
    : undefined;
  const topologyTitle = institutionOwned
    ? [`${topic}官方说明`, `${topic}条件说明`, `${topic}待核实项`][candidateIndex]
    : individualAuthor ? [`${topic}先问一件事`, `${topic}还在确认`, `${topic}一个问题`][candidateIndex] : undefined;
  const rawTitle = topologyTitle ?? surfaceTitle ?? (orchestrationPlan?.strategy.openingMode.includes("misconception")
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

/** Reader-stage language checks are diagnostics; visible speech remains agent-authored. */
const QUESTIONNAIRE_QUESTION = /(?:公开渠道(?:能|可)?(?:查到|看到|核验)的有哪些|有哪些(?:可公开|能公开|可以公开|可核验|能核验)(?:的)?(?:信息|内容)?|具体要看什么条件|需要核实哪些(?:条件|信息)|由哪个(?:明确)?身份(?:来)?确认|行动前还要再次确认哪些)/u;

function factualEvidenceForThread(
  planned: OrchestrationPlan["dialogueThreads"][number],
  plan: OrchestrationPlan,
  references: EvidenceReference[],
): EvidenceReference[] {
  const card = plan.gapPlanningCards?.find((item) => item.gapId === planned.primaryGapId);
  const pinned = new Set(card?.evidenceIds ?? []);
  return references.filter((reference) => pinned.has(reference.id)
    && evidenceReferenceCanSupportFact(reference)
    && Boolean(reference.quote?.trim()));
}

function bindDialogueProvenance(
  draft: GenerationDraft,
  plan: OrchestrationPlan,
  allowedEvidenceIds: string[],
  evidenceSources: Record<string, string>,
  evidenceReferences?: EvidenceReference[],
): GenerationDraft {
  const canonicalize = (id: string): string => evidenceReferences
    ? (resolveCanonicalEvidenceId(id, evidenceReferences) ?? id)
    : id;
  draft = {
    ...draft,
    evidenceIds: [...new Set(draft.evidenceIds.map(canonicalize))],
    reasoning: draft.reasoning.map((item) => ({
      ...item,
      evidenceIds: [...new Set(item.evidenceIds.map(canonicalize))],
      sourceSpans: (item.sourceSpans ?? []).map((span) => ({
        ...span,
        evidenceId: canonicalize(span.evidenceId),
      })),
    })),
    content: {
      ...draft.content,
      Cref: {
        ...draft.content.Cref,
        threads: draft.content.Cref.threads.map((thread) => ({
          ...thread,
          evidenceIds: [...new Set(thread.evidenceIds.map(canonicalize))],
          followUps: thread.followUps.map((followUp) => ({
            ...followUp,
            evidenceIds: [...new Set(followUp.evidenceIds.map(canonicalize))],
          })),
        })),
      },
    },
  };
  const allowed = new Set(allowedEvidenceIds);
  const originalThreadIds = new Map(
    draft.content.Cref.threads.map((thread, index) => [thread.id, plan.dialogueThreads[index]?.id ?? thread.id]),
  );
  // 展示昵称(纯展示元数据):计划侧昵称先占坑,缺失时按同一盐确定性补算;
  // 追问接话人按 `nickname:${threadId}:fu:${index}` 分配,包内去重顺延。
  // T2 读者互聊的接话读者 B 昵称(计划侧 replyDisplayName)同样先占坑。
  const usedDisplayNames = new Set(
    plan.dialogueThreads.flatMap((planned) => [planned.displayName, planned.replyDisplayName])
      .filter((name): name is string => Boolean(name)),
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
  const threads = plan.dialogueThreads.map((planned, index) => {
    const base = remappedDraft.content.Cref.threads[index];
    if (!base) throw new Error(`Missing generated comment thread at index ${index}; provenance binding cannot author visible copy.`);
    const selectedSurface = base.surfaceRoleCard ?? planned.surfaceRoleCard;
    const realizedConversation = base.conversationPlan ?? planned.conversationPlan;
    // Preserve the model's visible copy. The orchestration plan is metadata,
    // not user-facing prose and may contain audit IDs or intentionally verbose
    // planning language that must never overwrite a natural question/answer.
    // Binding owns metadata only. Visible copy is preserved byte-for-byte;
    // leaks or weak prose are validator/editor responsibilities, not binder work.
    const question = base.question;
    const answer = base.answer;
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
    // 读者互动层:线程形态透传(缺省 org_answer);T2 接话读者 B 的昵称优先取
    // 计划侧,缺失时按同一盐确定性补算,包内去重。
    const threadKind = planned.threadKind ?? "org_answer";
    const ownsPrimaryGap = (planned.coverageRole
      ?? (threadKind === "org_answer" ? "primary_gap" : "topic_anchor")) === "primary_gap";
    const replyDisplayName = threadKind === "reader_exchange"
      ? (planned.replyDisplayName ?? assignCommentDisplayName(plan.seed, `nickname:${planned.id}:reader:b`, usedDisplayNames))
      : undefined;
    if (replyDisplayName) usedDisplayNames.add(replyDisplayName);
    const followUps = base.followUps.map((followUp, followUpIndex) => {
      const followUpDisplayName = assignCommentDisplayName(plan.seed, `nickname:${planned.id}:fu:${followUpIndex}`, usedDisplayNames);
      usedDisplayNames.add(followUpDisplayName);
      return {
        ...followUp,
        displayName: followUpDisplayName,
        question: followUp.question,
        answer: followUp.answer,
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
      threadKind,
      ...(replyDisplayName ? { replyDisplayName } : {}),
      question,
      answer,
      // Cref contract v1.1: keep model-stated dialogic kinds/boundary; when the
      // model did not state them, derive kinds positionally (root nodes) and
      // fall back to the planned reply boundary. A boundary is never invented.
      kind: base.kind ?? "question" as const,
      answerKind: base.answerKind ?? "answer" as const,
      boundary: ownsPrimaryGap
        ? normalizePublicCommentBoundary(base.boundary ?? planned.replyPlan?.boundary)
        : undefined,
      postingIdentity: planned.postingIdentity,
      answerIdentity: threadKind === "reader_exchange"
        ? "simulated_reader" as const
        : threadKind === "organic_reaction" ? "none" as const : planned.postingIdentity,
      sourceClusterIds: ownsPrimaryGap ? [...planned.sourceClusterIds] : [],
      evidenceIds: ownsPrimaryGap ? evidenceIds : [],
      followUps: threadKind === "host_reply" || threadKind === "organic_reaction" ? [] : followUps,
      stage: planned.stage,
      gap: ownsPrimaryGap ? planned.gapId : undefined,
      // P3-15: the model may state the thread function in the staged schema; a
      // legal enum value wins, anything else silently falls back to the
      // content-derived planning value (no more positional rotation anywhere).
      function: commentThreadFunction(base.function) ?? planned.function,
      nextStep: ownsPrimaryGap ? planned.nextStep : undefined,
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
      roleCard: ownsPrimaryGap ? planned.roleCard : undefined,
      primaryGapId: ownsPrimaryGap ? planned.primaryGapId : undefined,
      auxiliaryGapIds: ownsPrimaryGap ? [...planned.auxiliaryGapIds] : [],
      authorFactIds: threadKind === "host_reply" ? [...(planned.authorFactIds ?? [])] : undefined,
      topicAnchorGapId: planned.topicAnchorGapId,
      densityProxy: ownsPrimaryGap ? { ...planned.densityProxy } : undefined,
      replyPlan: ownsPrimaryGap ? { ...planned.replyPlan } : undefined,
      // M7: discoveryPlan is optional; preserve presence/absence rather than coercing to {}.
      discoveryPlan: ownsPrimaryGap && planned.discoveryPlan ? { ...planned.discoveryPlan } : undefined,
      conversationPlan: realizedConversation ? { ...realizedConversation } : undefined,
      surfaceRoleCard: selectedSurface ? { ...selectedSurface, targetChars: [...selectedSurface.targetChars] as [number, number] } : undefined,
      questionContext: planned.questionContext ? { ...planned.questionContext } : undefined,
      ...(planned.replySurfaceRoleCard ? {
        replySurfaceRoleCard: {
          ...planned.replySurfaceRoleCard,
          targetChars: [...planned.replySurfaceRoleCard.targetChars] as [number, number],
        },
      } : {}),
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
        // Model-produced visible copy is preserved exactly; absent stays absent.
        ownedFirstComment: remappedDraft.content.Cref.ownedFirstComment,
      },
    },
  };
  const reconciled = reconcileReasoningEvidence(bound, allowedEvidenceIds, evidenceSources, evidenceReferences);
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

/**
 * Bind visible real-author copy to the server-frozen author-fact ledger.
 * This is deterministic and never asks the model to invent confirmation metadata.
 */
export function attachConfirmedAuthorFactReasoning(
  draft: GenerationDraft,
  config: ResolvedGenerationConfig,
): GenerationDraft {
  if (config.task.publishingTopology !== "confirmed_individual_author"
    || config.task.authorContext.status !== "confirmed") return draft;

  const candidates: Array<{
    statement: string;
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>;
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>;
  }> = [];
  const addText = (
    text: string,
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>,
    occurrence: NonNullable<GenerationDraft["reasoning"][number]["occurrence"]>,
  ): void => {
    text.split(/(?<=[。！？!?；;])|\n+/u).map((item) => item.trim()).filter(Boolean)
      .forEach((statement) => candidates.push({ statement, location, occurrence }));
  };
  addText(draft.content.N.title, "N.title", { field: "title" });
  addText(draft.content.N.body, "N.body", { field: "body" });
  for (const thread of draft.content.Cref.threads) {
    if (thread.threadKind === "host_reply" || thread.postingIdentity === "author") {
      addText(thread.answer, "Cref.thread", { field: "answer", threadId: thread.id });
    }
  }

  let reasoning = [...draft.reasoning];
  for (const candidate of candidates) {
    const fact = config.task.authorContext.facts.find((item) => authorFactAuthorizesVisibleStatement(candidate.statement, item.statement));
    if (!fact) continue;
    reasoning = reasoning.filter((item) => !(item.location === candidate.location
      && item.occurrence?.field === candidate.occurrence.field
      && item.occurrence?.threadId === candidate.occurrence.threadId
      && item.occurrence?.followUpIndex === candidate.occurrence.followUpIndex
      && item.status !== "fact"
      && (item.statement === candidate.statement
        || item.statement.includes(candidate.statement)
        || candidate.statement.includes(item.statement))));
    if (reasoning.some((item) => item.status === "human_confirmed_author_fact"
      && item.location === candidate.location
      && item.occurrence?.field === candidate.occurrence.field
      && item.occurrence?.threadId === candidate.occurrence.threadId
      && item.statement === candidate.statement)) continue;
    reasoning.push({
      statement: candidate.statement,
      location: candidate.location,
      occurrence: candidate.occurrence,
      status: "human_confirmed_author_fact",
      authorFactId: fact.id,
      ...(fact.confirmationId ? { confirmationId: fact.confirmationId } : {}),
      evidenceIds: [],
      sourceSpans: [],
    });
  }
  return { ...draft, reasoning };
}

function reconcileReasoningEvidence(
  draft: GenerationDraft,
  allowedEvidenceIds: string[],
  evidenceSources: Record<string, string>,
  evidenceReferences?: EvidenceReference[],
): GenerationDraft {
  const referenceById = new Map((evidenceReferences ?? []).map((reference) => [reference.id, reference]));
  const allowed = new Set(allowedEvidenceIds.filter((id) => {
    if (!evidenceReferences) return true;
    const reference = referenceById.get(id);
    return Boolean(reference && evidenceReferenceCanSupportFact(reference));
  }));
  const factualAllowedIds = allowedEvidenceIds.filter((id) => allowed.has(id));
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
      ...factualAllowedIds,
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
      && conservativeEvidenceSupport(segment.statement, item.statement)
      && combinedEvidenceSupport(item.statement, (item.sourceSpans ?? []).map((span) => span.quote)))) continue;
    const sourceSpans = sourceSpansForClaim(segment.statement, factualAllowedIds, evidenceSources);
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
    // A boundary may be a writer policy ("不允许写…/统一口径") rather
    // than reader-facing information. It remains in the plan and validation
    // contract, but must never be appended verbatim to public body copy.
    .flatMap((card) => card.boundary?.trim() && publicCopyBoundary(card.boundary)
      ? [card.boundary.trim()]
      : []);
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

/**
 * 生长阶段(2.2)因中继/模型不可用而失败时,followUps 必然为空——此时
 * comment_network_under_grown 描述的"是否漏掉了可接的话头"是内容判断,却会把
 * 一次基础设施故障说成质量问题,是误导信号。已有 model_comment_growth_failed
 * 如实报告了真因,故在其存在时抑制这条分布告警(过量生长不受影响:生长失败不可
 * 能导致超额)。校验层保持纯函数,不感知基础设施状态。
 */
/**
 * 判官失败记一条 warning,不改降级行为。
 *
 * 受控声明的语义裁决(邀约/限定/疑问放行,事实断言查证)只有判官能做;判官缺席
 * 时校验层回退纯词面命中,于是「助理可以帮你约时间」这类句子照样落 error。行为
 * 上这是保守的(宁可多报),但**无声**:实测 174 个包无一条裁决,60 个包报出
 * sensitive_claim_without_evidence,没有任何信号指向判官。这条 warning 只补信号
 * ——同一次生成里若同时看到它和成批的受控声明 error,真因就在判官而非文案。
 *
 * 每候选只记一条:判官在初次与每轮修复后各调用一次,失败原因通常同一个。
 */
function recordClaimJudgeFailure(stageIssues: ContentValidationIssue[], error: unknown): void {
  if (stageIssues.some((issue) => issue.code === "model_claim_judge_failed")) return;
  stageIssues.push({
    code: "model_claim_judge_failed",
    severity: "warning",
    channel: "package",
    disposition: "advisory",
    origin: "infrastructure",
    message: `受控声明的语义裁决未完成，敏感声明改按词面命中判定（可能偏严）：${error instanceof Error ? error.message : String(error)}`,
    repairable: false,
  });
}

function suppressGrowthWarningsAfterGrowthFailure(
  issues: ContentValidationIssue[],
  stageIssues: ContentValidationIssue[],
): ContentValidationIssue[] {
  if (!stageIssues.some((issue) => issue.code === "model_comment_growth_failed")) return issues;
  return issues.filter((issue) => issue.code !== "comment_network_under_grown");
}

function uniqueUnknowns(ledger: KnowledgeLedger, draft: GenerationDraft): GenerationDraft["unknowns"] {
  return [...new Map([...ledger.unknowns, ...draft.unknowns].map((item) => [item.id, item])).values()];
}

function stagedCommentsFromDraft(draft: GenerationDraft): StagedCommentCopy {
  return {
    disclaimer: draft.content.Cref.disclaimer,
    ownedFirstComment: draft.content.Cref.ownedFirstComment,
    threads: draft.content.Cref.threads.map((thread) => ({
      id: thread.id,
      question: thread.question,
      answer: thread.answer,
      followUps: thread.followUps.map((followUp) => ({
        question: followUp.question, answer: followUp.answer, kind: followUp.kind, boundary: followUp.boundary,
      })),
      kind: thread.kind,
      answerKind: thread.answerKind,
      boundary: thread.boundary,
      function: thread.function,
    })),
  };
}

function applyAcceptedCommentNetwork(draft: GenerationDraft, accepted: StagedCommentCopy): GenerationDraft {
  const visibleById = new Map(accepted.threads.map((thread) => [thread.id, thread]));
  return {
    ...draft,
    content: {
      ...draft.content,
      Cref: {
        ...draft.content.Cref,
        disclaimer: accepted.disclaimer,
        ownedFirstComment: accepted.ownedFirstComment,
        threads: draft.content.Cref.threads.map((thread) => {
          const visible = visibleById.get(thread.id);
          if (!visible) return thread;
          return {
            ...thread,
            question: visible.question,
            answer: visible.answer,
            followUps: visible.followUps.map((followUp, index) => ({
              ...thread.followUps[index]!, question: followUp.question, answer: followUp.answer,
              kind: followUp.kind ?? thread.followUps[index]?.kind,
              boundary: followUp.boundary ?? thread.followUps[index]?.boundary,
            })),
          };
        }),
      },
    },
  };
}

function answerRealizationFor(
  thread: GenerationDraft["content"]["Cref"]["threads"][number],
  plan: OrchestrationPlan,
  issues: readonly ContentValidationIssue[],
  mode: ArtifactRealization["mode"],
): CommentAnswerRealization {
  const kind = thread.threadKind ?? "org_answer";
  if (kind === "organic_reaction") return { availability: "not_applicable" };
  if (thread.answer.trim()) return { availability: "generated", stage: mode === "deterministic_preview" ? "preview" : kind === "reader_exchange" ? "reader_exchange" : kind === "host_reply" ? "host_answer" : "org_answer" };
  const related = issues.filter((issue) => issue.channel === "Cref" && issue.message.includes(thread.id));
  if (related.some((issue) => issue.code === "model_org_answer_skipped_no_evidence")) {
    return { availability: "withheld_no_evidence", reasonCode: "model_org_answer_skipped_no_evidence", stage: "org_answer" };
  }
  const failed = related.find((issue) => issue.code === "model_org_answer_failed"
    || issue.code === "model_org_answer_self_review_rejected"
    || issue.code === "model_host_answer_failed");
  if (failed) return {
    availability: failed.origin === "infrastructure" ? "failed_provider" : "withheld_unsupported",
    reasonCode: failed.code,
    stage: kind === "host_reply" ? "host_answer" : "org_answer",
  };
  const planned = plan.dialogueThreads.find((item) => item.id === thread.id);
  if (kind === "org_answer" && !(planned?.evidenceIds.length)) return { availability: "withheld_no_evidence", reasonCode: "no_planned_evidence", stage: "org_answer" };
  return { availability: "rejected_contract", reasonCode: "comment_answer_unavailable", stage: kind === "host_reply" ? "host_answer" : kind === "reader_exchange" ? "reader_exchange" : "org_answer" };
}

function annotateAnswerRealizations(
  draft: GenerationDraft,
  plan: OrchestrationPlan,
  issues: readonly ContentValidationIssue[],
  mode: ArtifactRealization["mode"],
): GenerationDraft {
  return {
    ...draft,
    content: { ...draft.content, Cref: { ...draft.content.Cref, threads: draft.content.Cref.threads.map((thread) => ({
      ...thread, answerRealization: answerRealizationFor(thread, plan, issues, mode),
    })) } },
  };
}

function artifactRealizationFor(
  draft: GenerationDraft,
  plan: OrchestrationPlan | undefined,
  issues: readonly ContentValidationIssue[],
  mode: ArtifactRealization["mode"],
): ArtifactRealization {
  const issueCodes = (predicate: (issue: ContentValidationIssue) => boolean) => [...new Set(issues.filter(predicate).map((issue) => issue.code))].sort();
  const coreCodes = issueCodes((issue) => issue.channel === "H" || issue.channel.startsWith("N."));
  const commentCodes = issueCodes((issue) => issue.channel === "Cref");
  const ledgerCodes = issueCodes((issue) => issue.code.includes("ledger") || issue.code.includes("evidence") || issue.code.includes("fact_source"));
  const channelStatus = (codes: string[], failed: boolean): "complete" | "partial" | "failed" => failed ? "failed" : codes.length ? "partial" : "complete";
  const coreFailed = !draft.content.N.title.trim() || !draft.content.N.body.trim();
  const commentsApplicable = (plan?.dialogueThreads.length ?? draft.content.Cref.threads.length) > 0;
  const commentsFailed = commentsApplicable && draft.content.Cref.threads.some((thread) => {
    const kind = thread.threadKind ?? "org_answer";
    return (kind === "org_answer" || kind === "host_reply") && !thread.answer.trim();
  });
  const ledgerFailed = issues.some((issue) => issue.code === "model_ledger_failed") && draft.reasoning.length === 0;
  const channels: ArtifactRealization["channels"] = {
    core: { status: channelStatus(coreCodes, coreFailed), reasonCodes: coreCodes },
    comments: { status: commentsApplicable ? channelStatus(commentCodes, commentsFailed) : "not_applicable", reasonCodes: commentCodes },
    ledger: { status: channelStatus(ledgerCodes, ledgerFailed), reasonCodes: ledgerCodes },
  };
  const statuses = Object.values(channels).map((channel) => channel.status);
  return {
    status: mode === "deterministic_preview" ? "partial" : statuses.includes("failed") ? "failed" : statuses.includes("partial") ? "partial" : "complete",
    mode,
    deliverability: mode === "model_generated" ? "eligible" : "non_deliverable",
    channels,
  };
}

function completeIssueMetadata(issues: readonly ContentValidationIssue[]): ContentValidationIssue[] {
  return issues.map((issue) => normalizeContentValidationIssue({
    ...issue,
    origin: issue.origin ?? (issue.code.startsWith("model_") ? "infrastructure" : "deterministic"),
  }));
}

/** Formal-delivery review gates derived only after final visible-copy realization. */
function formalDeliveryReviewIssues(
  plan: OrchestrationPlan | undefined,
  coverage: CommentGapCoverageLedger | undefined,
  modelInvoked: boolean,
  modelMessage: string,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  if (!modelInvoked) {
    issues.push({
      code: "model_not_invoked", severity: "warning", channel: "package",
      disposition: "review", origin: "infrastructure", message: modelMessage, repairable: false,
    }, {
      code: "deterministic_preview_non_deliverable", severity: "error", channel: "package",
      disposition: "block", origin: "deterministic",
      message: "确定性预览不属于模型正式成品，不能通过人工确认升级为可交付内容。", repairable: false,
    });
  }
  const degradedCards = (plan?.gapPlanningCards ?? []).filter((card) =>
    card.evidenceBindingStatus === "partial" || card.evidenceBindingStatus === "downgraded");
  if (degradedCards.length) {
    issues.push({
      code: "gap_evidence_binding_degraded", severity: "warning", channel: "package",
      disposition: "review", origin: "deterministic",
      message: `${degradedCards.length} 个选中信息缺口的审批答案在运行时仅部分匹配或已降级，发布前需核对证据。`,
      repairable: false,
    });
  }
  if (plan && coverage) {
    const requiredUnresolved = coverage.entries.filter((entry) => entry.required
      && entry.status !== "body_resolved" && entry.status !== "thread_resolved");
    if (requiredUnresolved.length || (plan.selectedGapIds.length > 0 && coverage.realizedResolvedRate === 0)) {
      issues.push({
        code: "required_information_not_realized", severity: "warning", channel: "package",
        disposition: "review", origin: "deterministic",
        message: requiredUnresolved.length
          ? `${requiredUnresolved.length} 个必要信息缺口未在最终正文或正确评论线程中完整实现。`
          : "最终实际解决率为 0%，选中信息缺口均未在可见内容中完整实现。",
        repairable: false,
      });
    }
  }
  return issues;
}

/**
 * Stable convergence state for the repair loop. It includes only publication-
 * relevant output and blocking contracts; model prose, prompts and diagnostics
 * are deliberately excluded. Equal fingerprints mean another identical repair
 * cannot improve publishability.
 */
function repairConvergenceFingerprint(
  draft: GenerationDraft,
  issues: readonly ContentValidationIssue[],
): string {
  const factualReasoning = draft.reasoning
    .filter((item) => item.status === "fact" || item.status === "human_confirmed_author_fact")
    .map((item) => ({
      statement: item.statement,
      status: item.status,
      evidenceIds: [...item.evidenceIds].sort(),
      authorFactId: item.authorFactId,
      location: item.location,
      occurrence: item.occurrence,
      sourceSpans: [...(item.sourceSpans ?? [])]
        .map((span) => ({ evidenceId: span.evidenceId, quote: span.quote }))
        .sort((left, right) => `${left.evidenceId}:${left.quote}`.localeCompare(`${right.evidenceId}:${right.quote}`)),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const blockers = issues
    .filter((issue) => issueDisposition(issue) === "block")
    .map((issue) => ({ code: issue.code, channel: issue.channel, repairable: issue.repairable }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify({
    content: draft.content,
    evidenceIds: [...draft.evidenceIds].sort(),
    factualReasoning,
    blockers,
  }), "utf8").digest("hex");
}

function compactEditorialText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * A body obligation needs a specific visible anchor, not a generic two-character
 * overlap such as “判断” or “条件”. The full planner label is sufficient; otherwise
 * one contiguous 3—6 character fragment from the approved answer/framework must
 * survive in the copy. This stays domain-neutral while preventing false closure.
 */
function bodyRealizesPlanningCard(
  visible: string,
  card: NonNullable<OrchestrationPlan["gapPlanningCards"]>[number],
): boolean {
  const compactVisible = compactEditorialText(visible);
  const compactLabel = compactEditorialText(card.label);
  if (compactLabel.length >= 2 && compactVisible.includes(compactLabel)) return true;
  return [card.answer, card.framework]
    .filter((value): value is string => Boolean(value?.trim()))
    .some((source) => {
      const chars = [...compactEditorialText(source)];
      for (let size = Math.min(6, chars.length); size >= 3; size -= 1) {
        for (let index = 0; index + size <= chars.length; index += 1) {
          if (compactVisible.includes(chars.slice(index, index + size).join(""))) return true;
        }
      }
      return false;
    });
}

/** Server-owned trigger for a focused core edit; it is not a quality score. */
export function coreEditorialReasons(
  core: Pick<ContentPackage["content"], "H" | "N">,
  plan: OrchestrationPlan,
): string[] {
  const cards = plan.gapPlanningCards ?? [];
  const required = new Set(plan.contentIntent?.bodyMustEstablish ?? cards
    .filter((card) => card.obligation === "body_required")
    .map((card) => card.gapId));
  return cards.flatMap((card) => {
    if (!required.has(card.gapId)) return [];
    const visible = `${core.N.title}
${core.N.body}`;
    return bodyRealizesPlanningCard(visible, card)
      ? []
      : [`正文没有可见承载 body_required gap ${card.gapId}（${card.label}）`];
  });
}

/** Stage-local diagnostics for reader speech. This function never rewrites visible copy. */
function readerStageEditorialReasons(
  readers: ReturnType<typeof parseStagedCommentReaders>,
  plan: OrchestrationPlan,
  claimRules: Parameters<typeof guardedReplyIdentitiesForQuestion>[1],
): string[] {
  const cards = new Map((plan.gapPlanningCards ?? []).map((card) => [card.gapId, card]));
  const reasons: string[] = [];
  readers.threads.forEach((thread, index) => {
    const planned = plan.dialogueThreads[index];
    if (!planned || thread.id !== planned.id) {
      reasons.push(`线程顺序或ID与冻结计划不一致：${thread.id}`);
      return;
    }
    const kind = planned.threadKind ?? "org_answer";
    if (QUESTIONNAIRE_QUESTION.test(thread.question)) reasons.push(`线程 ${thread.id} 使用采访或审核清单腔`);
    for (const reason of publicCommentSurfaceReasons(`${thread.question}\n${thread.answer}`)) {
      reasons.push(`线程 ${thread.id} 的读者公开文案${reason}`);
    }
    if (kind === "org_answer") {
      const card = cards.get(planned.primaryGapId);
      if (!card || !questionMatchesPlannedGap(thread.question, card)) reasons.push(`线程 ${thread.id} 偏离冻结主缺口 ${planned.primaryGapId}`);
      const guarded = guardedReplyIdentitiesForQuestion(thread.question, claimRules);
      if ([...guarded].some((identity) => identity !== planned.postingIdentity)) reasons.push(`线程 ${thread.id} 改变了冻结答复身份`);
    }
    if (kind === "host_reply") {
      const guarded = guardedReplyIdentitiesForQuestion(thread.question, claimRules);
      if (guarded.size) reasons.push(`线程 ${thread.id} 越过楼主个人事实边界`);
    }
    if (kind === "reader_exchange" && thread.answer.trim()
      && !readerExchangeContinuesTopic(thread.question, thread.answer)) {
      reasons.push(`线程 ${thread.id} 的读者B接话跨题`);
    }
  });
  return [...new Set(reasons)];
}

/** Accept only reader-side visible edits that preserve the frozen thread contract. */
function acceptReaderStageEdit(
  original: ReturnType<typeof parseStagedCommentReaders>,
  edited: ReturnType<typeof parseStagedCommentEditor>,
  plan: OrchestrationPlan,
  claimRules: Parameters<typeof guardedReplyIdentitiesForQuestion>[1],
): ReturnType<typeof parseStagedCommentReaders> {
  if (edited.threads.length !== original.threads.length) throw new CommentEditorContractError("Reader editor changed thread count.");
  const threads = edited.threads.map((thread, index) => {
    const before = original.threads[index]!;
    const planned = plan.dialogueThreads[index]!;
    if (thread.id !== before.id || thread.id !== planned.id) throw new CommentEditorContractError(`Reader editor changed thread identity at ${index}.`);
    const kind = planned.threadKind ?? "org_answer";
    if (kind !== "reader_exchange" && thread.answer.trim()) throw new CommentEditorContractError(`Reader editor wrote an answer for ${thread.id}.`);
    if (kind === "reader_exchange" && !thread.answer.trim()) throw new CommentEditorContractError(`Reader editor removed reader-B speech from ${thread.id}.`);
    return { ...before, question: thread.question, answer: thread.answer };
  });
  const candidate = { threads };
  const remaining = readerStageEditorialReasons(candidate, plan, claimRules);
  if (remaining.length) {
    throw new CommentEditorContractError(`Reader editor left frozen-contract defects: ${remaining.join("; ")}`);
  }
  return candidate;
}

/** Server-owned trigger for complete-network editing; no vocabulary is treated as a quality score. */
export function commentNetworkEditorialReasons(
  comments: StagedCommentCopy,
  plan: OrchestrationPlan,
  claimRules: Parameters<typeof guardedReplyIdentitiesForQuestion>[1] = [],
): string[] {
  const reasons: string[] = [];
  const seenAnswers = new Map<string, string>();
  const seenQuestions = new Map<string, string>();
  const normalize = (value: string): string => value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  comments.threads.forEach((thread, index) => {
    const planned = plan.dialogueThreads[index];
    if (!planned || thread.id !== planned.id) {
      reasons.push(`线程顺序或ID与冻结计划不一致：${thread.id}`);
      return;
    }
    const compactQuestion = normalize(thread.question);
    if (compactQuestion.length >= 6) {
      const prior = seenQuestions.get(compactQuestion);
      if (prior) reasons.push(`线程 ${thread.id} 与 ${prior} 的根问题重复`);
      else seenQuestions.set(compactQuestion, thread.id);
    }
    const compactAnswer = normalize(thread.answer);
    if (compactAnswer.length >= 8) {
      const prior = seenAnswers.get(compactAnswer);
      if (prior) reasons.push(`线程 ${thread.id} 与 ${prior} 的根答复重复`);
      else seenAnswers.set(compactAnswer, thread.id);
    }
    const kind = planned.threadKind ?? "org_answer";
    const publicNodes = [thread.question, thread.answer, thread.boundary ?? "",
      ...thread.followUps.flatMap((followUp) => [followUp.question, followUp.answer, followUp.boundary ?? ""])];
    for (const reason of publicNodes.flatMap(publicCommentSurfaceReasons)) {
      reasons.push(`线程 ${thread.id} 的公开文案${reason}`);
    }
    if (kind === "org_answer") {
      const card = plan.gapPlanningCards?.find((item) => item.gapId === planned.primaryGapId);
      if (card && !questionMatchesPlannedGap(thread.question, card)) {
        reasons.push(`线程 ${thread.id} 的问题偏离冻结主缺口 ${card.gapId}`);
      }
      const guarded = guardedReplyIdentitiesForQuestion(thread.question, claimRules);
      if ([...guarded].some((identity) => identity !== planned.postingIdentity)) {
        reasons.push(`线程 ${thread.id} 的问题改变了冻结答复身份`);
      }
    }
    if (kind === "host_reply" && guardedReplyIdentitiesForQuestion(thread.question, claimRules).size) {
      reasons.push(`线程 ${thread.id} 的问题越过楼主个人事实边界`);
    }
    if (kind === "reader_exchange" && thread.question.trim() && thread.answer.trim()
      && !readerExchangeContinuesTopic(thread.question, thread.answer)) {
      reasons.push(`线程 ${thread.id} 的读者B接话没有承接根问题`);
    }
    let previous = thread.answer || thread.question;
    thread.followUps.forEach((followUp, followUpIndex) => {
      const next = `${followUp.question}
${followUp.answer}`;
      if (previous.trim() && next.trim()) {
        const priorTokens = new Set((previous.match(/[\p{L}\p{N}]{2,4}/gu) ?? []));
        const continues = [...priorTokens].some((token) => next.includes(token));
        if (!continues && next.length > 16) reasons.push(`线程 ${thread.id} 追问 ${followUpIndex + 1} 没有承接上一句的可见对象或条件`);
      }
      previous = followUp.answer || followUp.question || previous;
    });
  });
  return [...new Set(reasons)];
}

/** Atomic acceptance of a complete-network edit. */
function acceptCommentNetworkEdit(
  original: StagedCommentCopy,
  edited: ReturnType<typeof parseStagedCommentNetworkEditor>,
  plan: OrchestrationPlan,
  claimRules: Parameters<typeof guardedReplyIdentitiesForQuestion>[1],
): StagedCommentCopy {
  if (edited.disclaimer !== original.disclaimer) throw new CommentEditorContractError("Comment editor changed the deterministic disclaimer.");
  if (edited.threads.length !== original.threads.length) throw new CommentEditorContractError("Comment editor changed thread count.");
  const threads = edited.threads.map((thread, index) => {
    const before = original.threads[index]!;
    const planned = plan.dialogueThreads[index]!;
    if (thread.id !== before.id || thread.id !== planned.id) throw new CommentEditorContractError(`Comment editor changed thread identity at ${index}.`);
    if (thread.followUps.length > before.followUps.length) throw new CommentEditorContractError(`Comment editor added follow-ups to ${thread.id}.`);
    const kind = planned.threadKind ?? "org_answer";
    if (kind === "org_answer") {
      if (!before.answer.trim() && thread.answer.trim()) {
        throw new CommentEditorContractError(`Comment editor filled unavailable organization copy in ${thread.id}.`);
      }
      if (before.answer.trim() && !thread.answer.trim()) {
        throw new CommentEditorContractError(`Comment editor removed an available organization answer from ${thread.id}.`);
      }
      if (thread.answer !== before.answer) {
        throw new CommentEditorContractError(`Comment editor changed self-reviewed organization copy in ${thread.id}.`);
      }
      if (thread.followUps.some((followUp, followUpIndex) =>
        followUp.answer !== before.followUps[followUpIndex]?.answer)) {
        throw new CommentEditorContractError(`Comment editor changed a self-reviewed organization follow-up in ${thread.id}.`);
      }
    }
    if (kind === "organic_reaction" && (thread.answer.trim() || thread.followUps.length)) throw new CommentEditorContractError(`Comment editor expanded organic reaction ${thread.id}.`);
    if (kind === "host_reply" && thread.followUps.length) throw new CommentEditorContractError(`Comment editor expanded host thread ${thread.id}.`);
    return {
      ...before,
      question: thread.question,
      answer: thread.answer,
      followUps: thread.followUps.map((followUp, followUpIndex) => ({ ...before.followUps[followUpIndex]!, ...followUp })),
    };
  });
  const candidate = { ...original, threads };
  const originalReasons = commentNetworkEditorialReasons(original, plan, claimRules);
  const remaining = commentNetworkEditorialReasons(candidate, plan, claimRules);
  const introduced = remaining.filter((reason) => !originalReasons.includes(reason));
  if (introduced.length || remaining.length > originalReasons.length) {
    throw new CommentEditorContractError(`Comment editor introduced or worsened defects: ${introduced.join("; ") || remaining.join("; ")}`);
  }
  const publicLeaks = candidate.threads.flatMap((thread) => [
    thread.question, thread.answer, thread.boundary ?? "",
    ...thread.followUps.flatMap((followUp) => [followUp.question, followUp.answer, followUp.boundary ?? ""]),
  ]).flatMap(publicCommentSurfaceReasons);
  if (publicLeaks.length) {
    throw new CommentEditorContractError(`Comment editor left public-language leaks: ${[...new Set(publicLeaks)].join("; ")}`);
  }
  if (edited.assessment.status === "pass" && remaining.length) {
    throw new CommentEditorContractError(`Comment editor reported pass with unresolved defects: ${remaining.join("; ")}`);
  }
  return candidate;
}

/** The editor returned valid JSON but attempted to renegotiate a server-owned contract. */
class CommentEditorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommentEditorContractError";
  }
}

/** Completed HTTP-200 responses with no visible content require one full regeneration.
 * They are not malformed JSON and must never enter the shape-correction prompt. */
export function shouldRegenerateCommentReadersFailure(error: unknown): boolean {
  if (!(error instanceof ModelProviderError) || error.status !== 200 || error.retryable !== false) return false;
  const diagnostics = error.responseDiagnostics;
  // Provider-level empty-output recovery only asks the same response to expose
  // its final text. If that still returns empty, the comment stage gets one
  // full, lower-temperature regeneration from the original frozen task.
  return diagnostics?.contentKind === "missing"
    || diagnostics?.contentChars === 0
    || diagnostics?.emptyOutputRecoveryAttempted === true
    || /did not contain output text/iu.test(error.message);
}

/** Shape correction is only for non-empty model text that failed local parsing. */
export function shouldCorrectCommentReadersFailure(error: unknown, originalResponse = ""): boolean {
  return originalResponse.trim().length > 0 && !(error instanceof ModelProviderError);
}

export type RepairResponsibility = "none" | "ledger_only" | "core_copy" | "comment_editor" | "replan_required";

const LEDGER_REPAIR_CODES = new Set([
  "evidence_quote_empty", "evidence_quote_not_exact", "evidence_quote_not_supportive",
  "fact_source_id_mismatch", "fact_source_span_missing",
  "followup_evidence_ledger_mismatch", "package_evidence_ledger_mismatch",
  "thread_evidence_ledger_mismatch", "ungrounded_fact", "unknown_evidence",
  "visible_claim_not_in_ledger",
]);

const REPLAN_REQUIRED_CODES = new Set([
  "comment_gap_missing_primary", "comment_gap_primary_thread_mismatch",
  "comment_gap_primary_thread_missing", "comment_gap_silently_dropped",
  "comment_primary_gap_mismatch", "reply_display_role_plan_drift",
  "reply_identity_plan_drift", "reply_question_plan_drift",
]);

// Automatic repair is deliberately bounded to defects for which a local patch
// has a clear owner and measurable value. Review-only planning/completeness
// findings stay visible but no longer trigger an expensive rewrite by default.
const CORE_COPY_REPAIR_CODES = new Set([
  "explicit_topic_not_realized", "missing_required_phrase", "forbidden_phrase",
  "body_too_short", "body_too_long", "sensitive_claim_without_evidence",
  "restricted_source_content_visible", "internal_audit_artifact_visible",
  "frontstage_instruction_leak", "unsupported_narrative_history",
  "publishing_topology_voice_mismatch",
]);
const COMMENT_COPY_REPAIR_CODES = new Set([
  "comment_reply_topic_drift", "duplicate_comment_question", "duplicate_comment_answer",
  "comment_context_meta_leak", "comment_source_language_surface_leak",
  "comment_plan_language_surface_leak",
]);

function automaticRepairEligible(issue: ContentValidationIssue): boolean {
  return LEDGER_REPAIR_CODES.has(issue.code)
    || CORE_COPY_REPAIR_CODES.has(issue.code)
    || COMMENT_COPY_REPAIR_CODES.has(issue.code);
}

/** Route every repairable blocker to one stage owner. Generic patches never own Cref. */
export function repairResponsibilityForIssues(
  issues: readonly ContentValidationIssue[],
): { responsibility: RepairResponsibility; channels: ContentChannel[] } {
  // Delivery disposition and repair routing are intentionally independent.
  // A semantic/editorial issue may be review-only for publication while still
  // deserving one bounded quality repair. Terminal mechanical gates remain
  // visible and non-deliverable, but must not suppress an independent local
  // copy/ledger improvement in the same candidate.
  const actionable = issues.filter((issue) => issue.repairable
    && (issueDisposition(issue) === "block" || issueDisposition(issue) === "review"));
  const repairable = actionable.filter(automaticRepairEligible);
  if (!repairable.length) {
    return actionable.some((issue) => REPLAN_REQUIRED_CODES.has(issue.code))
      ? { responsibility: "replan_required", channels: [] }
      : { responsibility: "none", channels: [] };
  }
  // Replanning findings are not patchable, but they must not suppress an
  // independent local copy/ledger repair in the same candidate. Route the
  // locally repairable subset first; leave replanning findings visible.
  const locallyRepairable = repairable.filter((issue) => !REPLAN_REQUIRED_CODES.has(issue.code));
  if (!locallyRepairable.length) return { responsibility: "replan_required", channels: [] };
  if (locallyRepairable.every((issue) => LEDGER_REPAIR_CODES.has(issue.code))) return { responsibility: "ledger_only", channels: [] };
  const channels = channelsForIssues(locallyRepairable);
  const hasComments = channels.includes("Cref");
  const hasCore = channels.some((channel) => channel !== "Cref");
  // A mixed failure cannot be atomically delegated to two agents in one bounded
  // attempt. Repair the core first; the next validation routes residual comment
  // defects to the network editor.
  if (hasCore) return { responsibility: "core_copy", channels: channels.filter((channel) => channel !== "Cref") };
  if (hasComments) return { responsibility: "comment_editor", channels: ["Cref"] };
  return { responsibility: "none", channels: [] };
}

export function shouldAttemptGenerationRepair(issues: readonly ContentValidationIssue[]): boolean {
  return ["ledger_only", "core_copy", "comment_editor"].includes(repairResponsibilityForIssues(issues).responsibility);
}

function claimJudgeSurfaceFingerprint(draft: GenerationDraft): string {
  return JSON.stringify({
    body: draft.content.N.body,
    answers: draft.content.Cref.threads
      .filter((thread) => (thread.threadKind ?? "org_answer") === "org_answer")
      .map((thread) => ({
        id: thread.id,
        answer: thread.answer,
        followUps: thread.followUps.map((followUp) => followUp.answer),
      })),
  });
}

function validationTelemetrySummary(
  issues: readonly ContentValidationIssue[],
): GenerationValidationTelemetrySummary {
  const dispositions = issues.map((issue) => issueDisposition(issue));
  const origins = issues.map((issue) => issue.origin
    ?? (issue.code.startsWith("model_") ? "infrastructure" : "deterministic"));
  return {
    issueCount: issues.length,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    warningCount: issues.filter((issue) => issue.severity === "warning").length,
    blockingCount: dispositions.filter((value) => value === "block").length,
    reviewCount: dispositions.filter((value) => value === "review").length,
    advisoryCount: dispositions.filter((value) => value === "advisory").length,
    repairableBlockingCount: issues.filter((issue) => issueDisposition(issue) === "block" && issue.repairable).length,
    terminalBlockingCount: issues.filter((issue) => issueDisposition(issue) === "block" && !issue.repairable).length,
    issueCodes: [...new Set(issues.map((issue) => issue.code))].sort(),
    channels: [...new Set(issues.map((issue) => issue.channel))].sort(),
    origins: [...new Set(origins)].sort(),
  };
}

function emitGenerationTelemetry(input: GenerationInput, event: GenerationTelemetryEvent): void {
  try {
    input.onTelemetry?.(event);
  } catch {
    // Observability must never change generated content or job outcome.
  }
}

function cloneConfig(config: ResolvedGenerationConfig): ResolvedGenerationConfig {
  return structuredClone(config);
}

export class ContentGenerationAgent implements GenerationEngine {
  private readonly provider?: ModelProvider;
  private readonly now: () => Date;
  private readonly systemPromptTokenEstimate: number;
  private readonly deliveryReadinessPolicy: "structural" | "formal";

  constructor(options: ContentGenerationEngineOptions = {}) {
    this.provider = options.modelProvider;
    this.now = options.now ?? (() => new Date());
    this.systemPromptTokenEstimate = options.systemPromptTokenEstimate ?? 900;
    this.deliveryReadinessPolicy = options.deliveryReadinessPolicy ?? "structural";
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
    // Warm the provider prefix cache with candidate 0's Core request before the
    // other two large Core requests start. Only Core is staggered: after the first
    // Core settles, all candidate pipelines may continue under the API limiter.
    let releaseCoreWarmup!: () => void;
    const coreWarmup = new Promise<void>((resolve) => { releaseCoreWarmup = resolve; });
    let coreWarmupReleased = false;
    const releaseOnce = (): void => {
      if (coreWarmupReleased) return;
      coreWarmupReleased = true;
      releaseCoreWarmup();
    };
    const firstCandidate = this.generateCandidate(
      effectiveInput, context, ledger, 0, planning, compilation.resolutionSnapshot,
      compilation.impactReport, true, undefined, releaseOnce,
    );
    // Prevent a pre-Core exception from deadlocking candidates 1/2.
    void firstCandidate.then(releaseOnce, releaseOnce);
    const candidateResults = await Promise.allSettled([
      firstCandidate,
      this.generateCandidate(effectiveInput, context, ledger, 1, planning, compilation.resolutionSnapshot, compilation.impactReport, true, coreWarmup),
      this.generateCandidate(effectiveInput, context, ledger, 2, planning, compilation.resolutionSnapshot, compilation.impactReport, true, coreWarmup),
    ]);
    // 部分成功即交付:原先任一候选 rejected 就整单抛错,另外两个已跑完的候选
    // (每个 6+ 次模型调用)连同产物一起丢弃——实测 87 个失败任务落库包数均为
    // 0,其中 9ee6677e 挂在候选 2,候选 1 白跑 21 分钟。三候选的产品语义是"给
    // 用户挑一个",两个也能挑,所以只要有候选跑通就交付,失败的记因。
    const degradedCandidates = candidateResults.flatMap((result, candidateIndex) => result.status === "rejected"
      ? [{ candidateIndex, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
      : []);
    candidateResults.forEach((result, candidateIndex) => {
      if (result.status !== "rejected") return;
      emitGenerationTelemetry(effectiveInput, {
        type: "candidate_failed",
        candidateIndex,
        errorName: result.reason instanceof Error ? result.reason.name.slice(0, 80) : "UnknownError",
      });
    });
    const candidates = candidateResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (!candidates.length) {
      throw new Error(
        `三个模型候选全部生成失败，未生成可发布降级稿：${degradedCandidates.map((item) => `候选 ${item.candidateIndex + 1}：${item.reason}`).join("；")}`,
      );
    }
    return {
      jobId: input.jobId,
      packages: candidates,
      ...(degradedCandidates.length ? { degradedCandidates } : {}),
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
    coreStartBarrier?: Promise<void>,
    onCoreSettled?: () => void,
  ): Promise<ContentPackage> {
    let orchestrationPlan = planning.plans[candidateIndex];
    const seed = orchestrationPlan.seed;
    const variation = variationFor(seed, candidateIndex);
    const availableEvidence = generationEvidenceReferences(input.config, input.knowledge, context, input.planningContext);
    const evidenceSources = generationEvidenceSources(input.config, input.knowledge, context, input.planningContext);
    const stageIssues: ContentValidationIssue[] = [];
    const editorialAssessments: EditorialAssessmentRecord[] = [];
    let draft: GenerationDraft;
    if (this.provider && useProvider) {
      let promptInput = {
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
      if (coreStartBarrier) await coreStartBarrier;
      let coreResponse;
      try {
        const generateCore = (purpose: "generate_core" | "regenerate_core", retrySeed: number, temperature: number) =>
          this.provider!.generate({
            messages: corePrompt.messages,
            responseSchema: corePrompt.responseSchema,
            schemaName: "content_candidate_core",
            model: input.config.model.model,
            seed: retrySeed,
            temperature,
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_CORE_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose, stage: purpose === "generate_core" ? 1 : 1.01 },
          });
        try {
          coreResponse = await generateCore("generate_core", seed, input.config.model.temperature);
        } catch (error) {
          if (!shouldRegenerateCommentReadersFailure(error)) throw error;
          stageIssues.push({
            code: "model_core_regenerated",
            severity: "warning",
            disposition: "advisory",
            origin: "infrastructure",
            channel: "package",
            message: "核心图文首次只返回内部推理而没有可见正文，已按同一冻结任务完整重生成一次。",
            repairable: false,
          });
          coreResponse = await generateCore("regenerate_core", seed + 101, Math.min(input.config.model.temperature, 0.35));
        }
      } finally {
        onCoreSettled?.();
      }
      let core = parseStagedCoreCopy(coreResponse.text);
      editorialAssessments.push({ stage: "core", status: "pass", reasons: [], summary: "核心图文已生成并进入合同校验。", accepted: true, attempt: 1 });
      const coreIdentityIssues = validatePublishingTopologyCopy(core, input.config, input.planningContext?.projectBlueprint);
      if (coreIdentityIssues.length) {
        const identityRepairPrompt = buildStagedCoreIdentityRepairPrompt(promptInput, core, coreIdentityIssues);
        const identityRepairResponse = await this.provider.generate({
          messages: identityRepairPrompt.messages,
          responseSchema: identityRepairPrompt.responseSchema,
          schemaName: "content_candidate_core_identity_repair",
          model: input.config.model.model,
          seed: seed + 9,
          temperature: Math.min(input.config.model.temperature, 0.3),
          maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_CORE_OUTPUT_TOKENS),
          metadata: { jobId: input.jobId, candidateIndex, purpose: "repair_core_identity", stage: 1.1 },
        });
        core = parseStagedCoreCopy(identityRepairResponse.text);
        const remainingIdentityIssues = validatePublishingTopologyCopy(core, input.config, input.planningContext?.projectBlueprint);
        if (remainingIdentityIssues.length) {
          throw new Error(`Publishing-topology preflight failed after one focused repair: ${remainingIdentityIssues.map((issue) => issue.code).join(", ")}`);
        }
      }
      // Stage 1E: only a server-proven unmet body obligation triggers semantic editing.
      // The editor cannot redefine the task; identity, body budget and the same
      // content-intent card are rechecked before accepting the complete H/N atomically.
      const unmetCoreObligations = coreEditorialReasons(core, orchestrationPlan);
      if (unmetCoreObligations.length) {
        try {
          const editorPrompt = buildStagedCoreEditorPrompt(promptInput, core, unmetCoreObligations);
          const editorResponse = await this.provider.generate({
            messages: editorPrompt.messages,
            responseSchema: editorPrompt.responseSchema,
            schemaName: "content_candidate_core_editor",
            model: input.config.model.model,
            seed: seed + 104,
            temperature: Math.min(input.config.model.temperature, 0.35),
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_CORE_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "edit_core", stage: 1.2 },
          });
          const edited = parseStagedCoreEditor(editorResponse.text);
          const identityIssues = validatePublishingTopologyCopy(edited.core, input.config, input.planningContext?.projectBlueprint);
          const remaining = coreEditorialReasons(edited.core, orchestrationPlan);
          const bodyLength = [...edited.core.N.body].length;
          if (bodyLength < input.config.content.bodyMinChars || bodyLength > input.config.content.bodyMaxChars) {
            throw new CommentEditorContractError("Core editor changed the configured body-length contract.");
          }
          core = edited.core;
          editorialAssessments.push({ stage: "core", status: edited.assessment.status, reasons: [...edited.assessment.reasons], summary: edited.assessment.summary, accepted: true, attempt: 2 });
          if (edited.assessment.status === "review" || identityIssues.length || remaining.length) {
            stageIssues.push({
              code: "core_editor_review", severity: "warning", channel: "N.body",
              message: edited.assessment.summary || edited.assessment.reasons.join("；") || [...identityIssues.map((issue) => issue.message), ...remaining].join("；") || "核心图文编辑仍建议人工复核。",
              repairable: false, disposition: "review", origin: "agent",
            });
          }
        } catch (error) {
          const rejected = error instanceof CommentEditorContractError;
          editorialAssessments.push({ stage: "core", status: rejected ? "rejected" : "unavailable", reasons: [error instanceof Error ? error.message : String(error)], summary: "核心编辑结果未被采用。", accepted: false, attempt: 2 });
          stageIssues.push({
            code: rejected ? "core_editor_contract_rejected" : "core_editor_unavailable",
            severity: "warning", channel: "N.body",
            message: rejected
              ? `核心编辑越过或未完成冻结内容意图，已原子拒收并保留原图文：${error.message}`
              : `核心编辑阶段未完成，保留原图文：${error instanceof Error ? error.message : String(error)}`,
            repairable: false, disposition: rejected ? "review" : "advisory",
            origin: rejected ? "deterministic" : "infrastructure",
          });
        }
      }

      // 存量蓝图的可追责身份体检:审批层校验只挡新模块,已批准的不合规
      // role_model 会让答复展示名静默回落到通用兜底名。这里显性记 warning。
      for (const message of diagnoseAccountableIdentities(input.planningContext?.projectBlueprint)) {
        stageIssues.push({
          code: "accountable_identity_incomplete", severity: "warning", channel: "Cref", message, repairable: false,
          disposition: "review", origin: "deterministic",
        });
      }
      // 阶段2A-R 生成读者侧可见问题。每条线程的 gap、问题职责、答复身份与展示
      // 角色均已由规划器冻结；模型必须在合同内措辞，不能通过改写问题来换答复人。
      const readersPrompt = buildStagedCommentReadersPrompt(promptInput, core);
      const expectedReaderThreads = orchestrationPlan.dialogueThreads.map((thread) => ({
        id: thread.id,
        threadKind: thread.threadKind ?? "org_answer",
      }));
      const expectedReaderIds = expectedReaderThreads.map((thread) => thread.id);
      const parseReaders = (text: string): ReturnType<typeof parseStagedCommentReaders> => {
        const parsed = parseStagedCommentReaders(text);
        const actualIds = parsed.threads.map((thread) => thread.id);
        if (actualIds.length !== expectedReaderIds.length
          || actualIds.some((id, index) => id !== expectedReaderIds[index])) {
          throw new Error(`Staged comment output IDs ${JSON.stringify(actualIds)} did not match expected ${JSON.stringify(expectedReaderIds)}.`);
        }
        parsed.threads.forEach((thread, index) => {
          const expected = expectedReaderThreads[index]!;
          if (!thread.question.trim()) throw new Error(`Staged comment thread ${thread.id} has an empty visible question.`);
          if (expected.threadKind === "reader_exchange" && !thread.answer.trim()) {
            throw new Error(`Staged reader-exchange thread ${thread.id} has an empty reader-B reply.`);
          }
          if (expected.threadKind !== "reader_exchange") thread.answer = "";
        });
        return parsed;
      };
      const generateReaders = async (
        prompt: typeof readersPrompt,
        purpose: "generate_comment_readers" | "regenerate_comment_readers",
        retrySeed: number,
        stage: number,
      ): Promise<string> => {
        const response = await this.provider!.generate({
          messages: prompt.messages,
          responseSchema: prompt.responseSchema,
          schemaName: "content_candidate_comment_readers",
          model: input.config.model.model,
          seed: retrySeed,
          temperature: purpose === "regenerate_comment_readers"
            ? Math.min(input.config.model.temperature, 0.35)
            : input.config.model.temperature,
          maxOutputTokens: input.config.model.maxOutputTokens,
          metadata: { jobId: input.jobId, candidateIndex, purpose, stage, ...(purpose === "regenerate_comment_readers" ? { attempt: 1 } : {}) },
        });
        return response.text;
      };
      let parsedReaderSide: ReturnType<typeof parseStagedCommentReaders>;
      if (!expectedReaderIds.length) {
        // Comments are explicitly disabled. Do not pay for or fabricate an
        // empty reader stage; downstream assembly naturally keeps Cref empty.
        parsedReaderSide = { threads: [] };
      } else {
        let initialReaderText = "";
        try {
          initialReaderText = await generateReaders(readersPrompt, "generate_comment_readers", seed + 1, 2);
        } catch (error) {
          if (!shouldRegenerateCommentReadersFailure(error)) throw error;
          stageIssues.push({
            code: "model_comment_readers_regenerated",
            severity: "warning",
            disposition: "advisory",
            origin: "infrastructure",
            channel: "Cref",
            message: "读者评论阶段首次返回没有可见正文，已使用完整原任务重新生成一次；该候选需要人工复核评论自然度。",
            repairable: false,
          });
          const regenerationPrompt = buildStagedCommentReadersRegenerationPrompt(readersPrompt);
          // A second empty response is terminal for this candidate. Never fabricate
          // comments from planning instructions or route it through shape correction.
          initialReaderText = await generateReaders(regenerationPrompt, "regenerate_comment_readers", seed + 101, 2.02);
        }
        try {
          parsedReaderSide = parseReaders(initialReaderText);
        } catch (error) {
          if (!shouldCorrectCommentReadersFailure(error, initialReaderText)) throw error;
          stageIssues.push({
            code: "model_comment_readers_corrected",
            severity: "warning",
            disposition: "advisory",
            origin: "infrastructure",
            channel: "Cref",
            message: "读者评论有可见原文但 JSON 结构不符合冻结合同，已做一次仅修结构的校正；该候选需要人工复核。",
            repairable: false,
          });
          const correctionPrompt = buildStagedCommentReadersCorrectionPrompt(
            initialReaderText,
            expectedReaderThreads,
            error instanceof Error ? error.message : String(error),
          );
          const corrected = await this.provider.generate({
            messages: correctionPrompt.messages,
            responseSchema: correctionPrompt.responseSchema,
            schemaName: "content_candidate_comment_readers_correction",
            model: input.config.model.model,
            seed: seed + 102,
            temperature: Math.min(input.config.model.temperature, 0.2),
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "repair_comment_readers", stage: 2.01, attempt: 1 },
          });
          parsedReaderSide = parseReaders(corrected.text);
        }
      }
      const gapCardById = new Map((orchestrationPlan.gapPlanningCards ?? []).map((card) => [card.gapId, card]));
      const claimRules = input.planningContext?.projectBlueprint?.claimPolicy.rules ?? [];
      let commentEditorialAssessment: import("./types.js").CommentEditorialAssessment | undefined;
      let readerSide = parsedReaderSide;
      const initialReaderReasons = readerStageEditorialReasons(readerSide, orchestrationPlan, claimRules);
      if (!initialReaderReasons.length) editorialAssessments.push({ stage: "comment_openers", status: "skipped", reasons: [], summary: "读者开口未触发编辑。", accepted: true, attempt: 0 });
      if (initialReaderReasons.length) {
        try {
          const editorPrompt = buildStagedCommentEditorPrompt(promptInput, core, readerSide);
          const editorResponse = await this.provider.generate({
            messages: editorPrompt.messages,
            responseSchema: editorPrompt.responseSchema,
            schemaName: "content_candidate_comment_reader_editor",
            model: input.config.model.model,
            seed: seed + 102,
            temperature: Math.min(input.config.model.temperature, 0.35),
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "edit_comment_openers", stage: 2.03 },
          });
          const edited = parseStagedCommentEditor(editorResponse.text);
          const accepted = acceptReaderStageEdit(readerSide, edited, orchestrationPlan, claimRules);
          const remaining = readerStageEditorialReasons(accepted, orchestrationPlan, claimRules);
          readerSide = accepted;
          commentEditorialAssessment = edited.assessment;
          editorialAssessments.push({ stage: "comment_openers", status: edited.assessment.status, reasons: [...edited.assessment.reasons], summary: edited.assessment.summary, accepted: true, attempt: 1 });
          if (edited.assessment.status === "review" || remaining.length) {
            stageIssues.push({
              code: "reader_editor_review", severity: "warning", channel: "Cref",
              message: edited.assessment.summary || edited.assessment.reasons.join("；") || remaining.join("；") || "读者问题编辑后仍建议人工复核。",
              repairable: false, disposition: "review", origin: "agent",
            });
          }
        } catch (error) {
          const rejected = error instanceof CommentEditorContractError;
          editorialAssessments.push({ stage: "comment_openers", status: rejected ? "rejected" : "unavailable", reasons: [error instanceof Error ? error.message : String(error)], summary: "读者开口编辑结果未被采用。", accepted: false, attempt: 1 });
          stageIssues.push({
            code: rejected ? "reader_editor_contract_rejected" : "reader_editor_unavailable",
            severity: "warning", channel: "Cref",
            message: rejected
              ? `读者问题编辑越过或未完成冻结职责，已原子拒收并保留模型原文：${error.message}`
              : `读者问题编辑未完成，保留模型原文：${error instanceof Error ? error.message : String(error)}`,
            repairable: false, disposition: "review", origin: rejected ? "deterministic" : "infrastructure",
          });
        }
      }


      // postingIdentity、replyDisplayRole 与 routingReason 已在线程规划时冻结。
      // 读者模型只负责在该线程 questionIntent / gap 职责内写可见问题；这里不再
      // 根据成稿问题调用模型重分配，避免“先写问题、后换角色”的映射漂移。
      // 阶段2A-O 机构答复(三身份:publisher 项目发布账号/staff 助理/expert 机构 IP,
      // 各≤1 次,该身份无线程则跳过):每次调用只见本角色身份卡与逐 gap 口径
      // scope,其他身份的任何信息不出现。每个调用独立 try/catch；失败、缺 id
      // 或证据不足时答复保持空缺，由最终完整性校验阻断，不生成替代话术。
      const accountableAnswerIssueStart = stageIssues.length;
      const hostAnswersById = new Map<string, StagedOrgAnswersCopy["answers"][number]>();
      const hostAnswerThreads = orchestrationPlan.dialogueThreads
        .map((planned, index) => ({ planned, reader: readerSide.threads[index]! }))
        .filter(({ planned }) => planned.threadKind === "host_reply");
      if (hostAnswerThreads.length) {
        try {
          const hostPrompt = buildStagedHostAnswersPrompt(
            promptInput,
            core,
            hostAnswerThreads.map(({ planned, reader }) => ({ planned, question: reader.question })),
          );
          const hostResponse = await this.provider.generate({
            messages: hostPrompt.messages,
            responseSchema: hostPrompt.responseSchema,
            schemaName: "content_candidate_host_answers",
            model: input.config.model.model,
            seed: seed + 10,
            temperature: input.config.model.temperature,
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_host_answers", stage: 2.05 },
          });
          const hostSide = parseStagedOrgAnswers(hostResponse.text);
          for (const { planned } of hostAnswerThreads) {
            const found = hostSide.answers.find((answer) => answer.id === planned.id);
            if (found) hostAnswersById.set(planned.id, found);
            else stageIssues.push({
              code: "model_host_answer_failed", severity: "warning", channel: "Cref",
              message: `楼主答复未覆盖线程 ${planned.id}；该答复保持空缺并阻断交付。`,
              repairable: false, disposition: "review", origin: "agent",
            });
          }
        } catch (error) {
          stageIssues.push({
            code: "model_host_answer_failed",
            severity: "warning",
            channel: "Cref",
            message: `楼主答复阶段失败；答复保持空缺并阻断交付：${error instanceof Error ? error.message : String(error)}`,
            repairable: false, disposition: "review", origin: "infrastructure",
          });
        }
      }
      const orgAnswersById = new Map<string, StagedOrgAnswersCopy["answers"][number]>();
      let ownedFirstComment: string | undefined;
      const orgAnswerThreads = orchestrationPlan.dialogueThreads
        .map((planned, index) => ({ planned, reader: readerSide.threads[index]! }))
        .filter(({ planned }) => (planned.threadKind ?? "org_answer") === "org_answer");
      const orgAnswerSeeds = { publisher: 11, staff: 12, expert: 15 } as const;
      for (const identity of ["publisher", "staff", "expert"] as const) {
        const identityThreads = orgAnswerThreads.filter(({ planned }) => planned.postingIdentity === identity);
        if (!identityThreads.length) continue;
        const evidenceByThread = new Map(identityThreads.map(({ planned }) => [
          planned.id,
          factualEvidenceForThread(planned, orchestrationPlan, availableEvidence),
        ]));
        const modelEligibleThreads = identityThreads.filter(({ planned }) => (evidenceByThread.get(planned.id)?.length ?? 0) > 0);
        for (const { planned } of identityThreads.filter(({ planned }) => !modelEligibleThreads.some((item) => item.planned.id === planned.id))) {
          stageIssues.push({
            code: "model_org_answer_skipped_no_evidence", severity: "warning", channel: "Cref",
            message: `线程 ${planned.id} 没有可支持机构答复的事实来源；答复保持空缺，未用系统模板代写。`,
            repairable: false, disposition: "review", origin: "deterministic",
          });
        }
        // No factual source means there is nothing an accountable organization
        // answer model may safely add. Skip the call instead of paying it to
        // hallucinate a website, licence, route, booking flow or future service.
        if (!modelEligibleThreads.length) continue;
        try {
          const orgPrompt = buildStagedOrgAnswersPrompt(
            promptInput,
            core,
            identity,
            modelEligibleThreads.map(({ planned, reader }) => ({ planned, question: reader.question })),
          );
          const orgResponse = await this.provider.generate({
            messages: orgPrompt.messages,
            responseSchema: orgPrompt.responseSchema,
            schemaName: "content_candidate_org_answers",
            model: input.config.model.model,
            seed: seed + orgAnswerSeeds[identity],
            temperature: input.config.model.temperature,
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_org_answers", stage: 2.1, identity },
          });
          const orgSide = parseStagedOrgAnswers(orgResponse.text);
          if (identity === "publisher" && orgSide.ownedFirstComment?.trim()) {
            const publisherEvidence = [...evidenceByThread.values()].flatMap((references) => references)
              .flatMap((reference) => reference.quote ? [{ id: reference.id, quote: reference.quote }] : []);
            const review = verifyOrgAnswerSelfReview(
              orgSide.ownedFirstComment,
              orgSide.ownedFirstCommentReview,
              publisherEvidence,
            );
            if (review.accepted) ownedFirstComment = orgSide.ownedFirstComment;
            else stageIssues.push({
              code: "model_org_first_comment_self_review_rejected",
              severity: "warning", channel: "Cref",
              message: `发布账号首评未通过同次 AI 逐句自检，已省略：${review.reason}`,
              repairable: false, disposition: "review", origin: "agent",
            });
          }
          for (const { planned } of modelEligibleThreads) {
            const found = orgSide.answers.find((answer) => answer.id === planned.id);
            if (found?.answer.trim()) {
              const review = verifyOrgAnswerSelfReview(
                found.answer,
                found.review,
                (evidenceByThread.get(planned.id) ?? []).flatMap((reference) =>
                  reference.quote ? [{ id: reference.id, quote: reference.quote }] : []),
              );
              if (!review.accepted) {
                stageIssues.push({
                  code: "model_org_answer_self_review_rejected",
                  severity: "warning",
                  channel: "Cref",
                  message: `线程 ${planned.id} 的机构答复未通过同次 AI 逐句自检，已在进入公开评论前整条拒收：${review.reason}`,
                  repairable: false,
                  disposition: "review",
                  origin: "agent",
                });
              } else {
                orgAnswersById.set(planned.id, found);
              }
            } else {
              stageIssues.push({
                code: "model_org_answer_failed",
                severity: "error",
                channel: "Cref",
                message: `机构答复（${identity}）未覆盖线程 ${planned.id}；节点保持空缺。`,
                repairable: false,
                disposition: "block",
                origin: "agent",
              });
            }
          }
        } catch (error) {
          stageIssues.push({
            code: "model_org_answer_failed",
            severity: "warning",
            channel: "Cref",
            message: `机构答复（${identity}）阶段失败；该角色线程答复保持空缺：${error instanceof Error ? error.message : String(error)}`,
            repairable: false, disposition: "review", origin: "infrastructure",
          });
        }
      }
      const accountableThreadCount = hostAnswerThreads.length + orgAnswerThreads.length;
      const accountableAnswerIssues = stageIssues.slice(accountableAnswerIssueStart).filter((issue) =>
        issue.code === "model_host_answer_failed"
        || issue.code === "model_org_answer_failed"
        || issue.code === "model_org_answer_skipped_no_evidence");
      if (!accountableThreadCount) {
        editorialAssessments.push({
          stage: "org_answers", status: "skipped", reasons: [],
          summary: "当前评论网络没有可追责答复节点。", accepted: true, attempt: 0,
        });
      } else if (accountableAnswerIssues.some((issue) => issueDisposition(issue) === "block")) {
        editorialAssessments.push({
          stage: "org_answers", status: "rejected",
          reasons: accountableAnswerIssues.map((issue) => issue.message),
          summary: "部分可追责答复未通过证据或冻结职责校验，相关节点保持空缺。", accepted: false, attempt: 1,
        });
      } else if (accountableAnswerIssues.some((issue) => issue.origin === "infrastructure")) {
        editorialAssessments.push({
          stage: "org_answers", status: "unavailable",
          reasons: accountableAnswerIssues.map((issue) => issue.message),
          summary: "可追责答复阶段未完整执行，未生成替代话术。", accepted: false, attempt: 1,
        });
      } else if (accountableAnswerIssues.length) {
        editorialAssessments.push({
          stage: "org_answers", status: "review",
          reasons: accountableAnswerIssues.map((issue) => issue.message),
          summary: "可追责答复阶段完成，但无依据或不受支持的节点保持空缺。", accepted: true, attempt: 1,
        });
      } else {
        editorialAssessments.push({
          stage: "org_answers", status: "pass", reasons: [],
          summary: "可追责答复已生成并通过证据边界校验。", accepted: true, attempt: 1,
        });
      }
      // 合并层确定性:surfaceRoleCard/postingIdentity/threadKind 一律以规划层
      // 为准;模型输出只取可见文案。disclaimer 用确定性常量,不再由模型输出。
      const roots: StagedCommentCopy = {
        disclaimer: STAGED_COMMENT_DISCLAIMER,
        ownedFirstComment,
        threads: orchestrationPlan.dialogueThreads.map((planned, index) => {
          const reader = readerSide.threads[index]!;
          const threadKind = planned.threadKind ?? "org_answer";
          const orgAnswer = threadKind === "org_answer" ? orgAnswersById.get(planned.id) : undefined;
          const hostAnswer = threadKind === "host_reply" ? hostAnswersById.get(planned.id) : undefined;
          return {
            id: reader.id,
            question: reader.question,
            // T3 恒空；T2 读者B接话来自读者侧；可追责答复缺失时保持空缺。
            answer: threadKind === "organic_reaction"
              ? ""
              : threadKind === "reader_exchange"
                ? reader.answer
                : threadKind === "host_reply"
                  ? (hostAnswer?.answer ?? "")
                  : (orgAnswer?.answer ?? ""),
            kind: reader.kind,
            answerKind: hostAnswer?.answerKind ?? orgAnswer?.answerKind ?? reader.answerKind,
            boundary: threadKind === "host_reply"
              ? undefined
              : normalizePublicCommentBoundary(orgAnswer?.boundary ?? reader.boundary ?? planned.replyPlan?.boundary),
            function: reader.function,
            followUps: [],
          };
        }),
      };
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
      const shouldGrowComments = orchestrationPlan.focusContract?.allowMultiTurnGrowth !== false
        && orchestrationPlan.dialogueThreads.some((thread) => (thread.conversationPlan?.targetFollowUps ?? 0) > 0)
        && input.config.content.commentMultiTurnGrowthEnabled === true
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
          const growthPatches = parseStagedCommentGrowth(
            growthResponse.text,
            normalizedRoots.threads.map((thread) => thread.id),
          );
          const grownById = new Map(growthPatches.map((thread) => [thread.id, thread]));
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
      // 阶段2B-O 机构补答(条件触发):仅当 2B 后仍存在 answer 为空的
      // org_answer followUp 时,按角色各 1 次(通常 0-1 次)。上下文隔离规则同
      // 2A-O;失败或未补答的追问确定性丢弃(不保留空答复),并记 warning。
      const pendingOrgFollowUps = comments.threads.flatMap((thread, threadIndex) => {
        const planned = orchestrationPlan.dialogueThreads[threadIndex]!;
        if ((planned.threadKind ?? "org_answer") !== "org_answer") return [];
        return thread.followUps
          .map((followUp, followUpIndex) => ({ planned, thread, followUp, followUpIndex }))
          .filter(({ followUp }) => !followUp.answer.trim() && followUp.question.trim());
      });
      if (pendingOrgFollowUps.length) {
        const filledAnswers = new Map<string, string>();
        const orgFollowUpSeeds = { publisher: 13, staff: 14, expert: 16 } as const;
        for (const identity of ["publisher", "staff", "expert"] as const) {
          const items = pendingOrgFollowUps.filter(({ planned }) => planned.postingIdentity === identity);
          if (!items.length) continue;
          const evidenceByRequestId = new Map(items.map(({ planned, thread, followUpIndex }) => [
            `${thread.id}:fu:${followUpIndex}`,
            factualEvidenceForThread(planned, orchestrationPlan, availableEvidence),
          ]));
          const modelEligibleItems = items.filter(({ thread, followUpIndex }) =>
            (evidenceByRequestId.get(`${thread.id}:fu:${followUpIndex}`)?.length ?? 0) > 0);
          for (const { thread, followUpIndex } of items.filter(({ thread, followUpIndex }) =>
            !modelEligibleItems.some((item) => item.thread.id === thread.id && item.followUpIndex === followUpIndex))) {
            stageIssues.push({
              code: "comment_followup_answer_unavailable", severity: "warning", channel: "Cref",
              message: `线程 ${thread.id} 的第 ${followUpIndex + 1} 条追问没有可支持答复的事实来源；未用系统模板代写，该可选追问将不进入成稿。`,
              repairable: false, disposition: "review", origin: "deterministic",
            });
          }
          if (!modelEligibleItems.length) continue;
          try {
            const followUpPrompt = buildStagedOrgFollowUpAnswersPrompt(
              promptInput,
              core,
              identity,
              modelEligibleItems.map(({ planned, thread, followUp, followUpIndex }) => ({
                planned,
                rootQuestion: thread.question,
                rootAnswer: thread.answer,
                followUpId: `${thread.id}:fu:${followUpIndex}`,
                question: followUp.question,
              })),
            );
            const followUpResponse = await this.provider.generate({
              messages: followUpPrompt.messages,
              responseSchema: followUpPrompt.responseSchema,
              schemaName: "content_candidate_org_followup_answers",
              model: input.config.model.model,
              seed: seed + orgFollowUpSeeds[identity],
              temperature: input.config.model.temperature,
              maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
              metadata: { jobId: input.jobId, candidateIndex, purpose: "generate_org_followup_answers", stage: 2.3, identity },
            });
            const followUpSide = parseStagedOrgAnswers(followUpResponse.text);
            for (const { planned, thread, followUpIndex } of modelEligibleItems) {
              const requestId = `${thread.id}:fu:${followUpIndex}`;
              const found = followUpSide.answers.find((answer) => answer.id === requestId);
              if (found?.answer.trim()) {
                const review = verifyOrgAnswerSelfReview(
                  found.answer,
                  found.review,
                  (evidenceByRequestId.get(requestId) ?? []).flatMap((reference) =>
                    reference.quote ? [{ id: reference.id, quote: reference.quote }] : []),
                );
                if (!review.accepted) {
                  stageIssues.push({
                    code: "model_org_answer_self_review_rejected",
                    severity: "warning",
                    channel: "Cref",
                    message: `线程 ${thread.id} 的第 ${followUpIndex + 1} 条机构补答未通过同次 AI 逐句自检，已丢弃：${review.reason}`,
                    repairable: false,
                    disposition: "review",
                    origin: "agent",
                  });
                } else {
                  filledAnswers.set(requestId, found.answer);
                }
              } else {
                stageIssues.push({
                  code: "model_org_answer_failed",
                  severity: "warning",
                  channel: "Cref",
                  message: `机构补答（${identity}）未覆盖线程 ${thread.id} 的第 ${followUpIndex + 1} 条追问；该可选追问将不进入成稿。`,
                  repairable: false,
                  disposition: "review",
                  origin: "agent",
                });
              }
            }
          } catch (error) {
            stageIssues.push({
              code: "model_org_answer_failed",
              severity: "warning",
              channel: "Cref",
              message: `机构补答（${identity}）阶段失败，待承接追问已确定性丢弃：${error instanceof Error ? error.message : String(error)}`,
              repairable: false,
            });
          }
        }
        comments = {
          ...comments,
          threads: comments.threads.map((thread, threadIndex) => {
            const planned = orchestrationPlan.dialogueThreads[threadIndex]!;
            if ((planned.threadKind ?? "org_answer") !== "org_answer") return thread;
            return {
              ...thread,
              followUps: thread.followUps.flatMap((followUp, followUpIndex) => {
                if (followUp.answer.trim() || !followUp.question.trim()) return [followUp];
                const filled = filledAnswers.get(`${thread.id}:fu:${followUpIndex}`);
                return filled ? [{ ...followUp, answer: filled }] : [];
              }),
            };
          }),
        };
      }
      comments = {
        ...comments,
        threads: comments.threads.map((thread, index) =>
          orchestrationPlan.dialogueThreads[index]?.threadKind === "host_reply"
            ? { ...thread, followUps: [] }
            : thread),
      };
      // Stage 2E: edit the complete network only when deterministic structure
      // exposes a concrete problem. All answers and follow-ups are now visible;
      // server acceptance keeps IDs, responsibilities, evidence and unknowns frozen.
      const networkReasons = commentNetworkEditorialReasons(comments, orchestrationPlan, claimRules);
      if (!networkReasons.length) editorialAssessments.push({ stage: "comment_network", status: "skipped", reasons: [], summary: "完整评论网络未触发终编。", accepted: true, attempt: 0 });
      if (networkReasons.length) {
        try {
          const editorPrompt = buildStagedCommentNetworkEditorPrompt(promptInput, core, comments, networkReasons);
          const editorResponse = await this.provider.generate({
            messages: editorPrompt.messages,
            responseSchema: editorPrompt.responseSchema,
            schemaName: "content_candidate_comment_network_editor",
            model: input.config.model.model,
            seed: seed + 103,
            temperature: Math.min(input.config.model.temperature, 0.4),
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "edit_comment_readers", stage: 2.4 },
          });
          const edited = parseStagedCommentNetworkEditor(editorResponse.text);
          const accepted = acceptCommentNetworkEdit(comments, edited, orchestrationPlan, claimRules);
          const remainingNetworkReasons = commentNetworkEditorialReasons(accepted, orchestrationPlan, claimRules);
          comments = accepted;
          commentEditorialAssessment = edited.assessment;
          editorialAssessments.push({ stage: "comment_network", status: edited.assessment.status, reasons: [...edited.assessment.reasons], summary: edited.assessment.summary, accepted: true, attempt: 1 });
          if (edited.assessment.status === "review" || remainingNetworkReasons.length) {
            stageIssues.push({
              code: "comment_editor_review", severity: "warning", channel: "Cref",
              message: edited.assessment.summary || edited.assessment.reasons.join("；") || remainingNetworkReasons.join("；") || "完整评论网络仍建议人工复核。",
              repairable: false, disposition: "review", origin: "agent",
            });
          }
        } catch (error) {
          const rejected = error instanceof CommentEditorContractError;
          editorialAssessments.push({ stage: "comment_network", status: rejected ? "rejected" : "unavailable", reasons: [error instanceof Error ? error.message : String(error)], summary: "完整评论网络编辑结果未被采用。", accepted: false, attempt: 1 });
          stageIssues.push({
            code: rejected ? "comment_editor_contract_rejected" : "comment_editor_unavailable",
            severity: "warning", channel: "Cref",
            message: rejected
              ? `完整评论终编越过冻结职责，已原子拒收并保留原评论：${error.message}`
              : `完整评论终编未完成，保留原评论：${error instanceof Error ? error.message : String(error)}`,
            repairable: false, disposition: rejected ? "review" : "advisory",
            origin: rejected ? "deterministic" : "infrastructure",
          });
        }
      }

      const maxVisibleCommentLines = orchestrationPlan.personaScenePlan?.surfaceTargets.visibleCommentLines[1]
        ?? comments.threads.length * 2 + input.config.content.followUpDepth * 2;
      let remainingFollowUps = Math.max(0, Math.floor((maxVisibleCommentLines - comments.threads.length * 2) / 2));
      let stagedContent: GenerationDraft["content"] = {
        H: core.H,
        N: core.N,
        Cref: {
          disclaimer: comments.disclaimer,
          // Carried only when the model produced one; bindDialogueProvenance
          // cleans it like any other visible copy. Absent stays absent.
          ownedFirstComment: comments.ownedFirstComment,
          threads: deterministicBase.content.Cref.threads.map((base, threadIndex) => {
            const visible = comments.threads[threadIndex]!;
            // Stage 2E may edit root wording after all replies are visible. Use the
            // accepted complete-network node here; normalizedRoots is only the
            // pre-growth input and must not overwrite the terminal edit.
            const root = visible;
            // T3 漂浮短反应不生长:模型多写了也确定性截为空。
            const followUps = base.threadKind === "organic_reaction" || base.threadKind === "host_reply"
              ? []
              : visible.followUps.slice(0, Math.min(input.config.content.followUpDepth, remainingFollowUps));
            remainingFollowUps -= followUps.length;
            const rootAnswer = root.answer.split(/\n\s*(?:追问|Q\d*)[：:]/iu)[0]?.trim() || root.answer.trim();
            // 身份以规划层为准:不再用模型输出的 roleIndex 选卡——按侧+按角色
            // 隔离后模型只做分配好的人物开口,surfaceRoleCard 直接取规划值
            // (base.surfaceRoleCard 仅作历史兜底)。
            const selectedSurface = orchestrationPlan.dialogueThreads[threadIndex]?.surfaceRoleCard ?? base.surfaceRoleCard;
            // 读者互动层:T2/T3 线程的对话拓扑由线程形态决定,不随接话数漂移。
            const topology = base.threadKind === "organic_reaction"
              ? "organic_reaction" as const
              : base.threadKind === "host_reply"
                ? "host_reply" as const
              : base.threadKind === "reader_exchange"
                ? "reader_exchange" as const
                : followUps.length >= 2
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
                replyMove: "可追责发布身份自然承接当前评论",
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
      // The ledger sees the exact accepted agent copy. Length defects are routed
      // to the core editor/final validator; deterministic code never trims prose.
      draft = {
        ...deterministicBase,
        content: stagedContent,
        ...(commentEditorialAssessment ? { commentEditorialAssessment } : {}),
        editorialAssessments,
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
          maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_LEDGER_OUTPUT_TOKENS),
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
        editorialAssessments.push({ stage: "ledger", status: "pass", reasons: [], summary: "事实台账已生成并解析。", accepted: true, attempt: 1 });
      } catch (error) {
        // 与同类阶段失败对齐为 warning。判官/机构答复/评论生长失败都是 warning,
        // 只有台账判 error,于是中继一抖动 quality_status 就归零——实测 18 篇产出
        // 零 passed 全由这一条决定,质量信号失去区分度。
        //
        // 定级依据(实测 217 个包):台账失败**不导致台账缺失**,126/126 个失败包的
        // reasoning 均非空(catch 保留了前序阶段的产出,只是没被本阶段精炼);它降低
        // 的是事实锚定率(人均 fact 0.8 → 0.2)。这是质量削弱,不是内容失效,可发布
        // 但需人工复核锚定——故 warning + repairable:false,并在文案里点明后果。
        editorialAssessments.push({ stage: "ledger", status: "unavailable", reasons: [error instanceof Error ? error.message : String(error)], summary: "事实台账阶段不可用，保留前序台账。", accepted: false, attempt: 1 });
        stageIssues.push({
          code: "model_ledger_failed",
          severity: "warning",
          disposition: "review",
          origin: "infrastructure",
          channel: "package",
          message: `模型可见文案已保留，但事实台账阶段失败，事实锚定与证据引用可能不完整，发布前需人工复核：${error instanceof Error ? error.message : String(error)}`,
          repairable: false,
        });
      }
    } else {
      draft = deterministicDraft(input.config, context, ledger, candidateIndex, variation, impactReport, orchestrationPlan, planning.opportunity, evidenceSources);
      editorialAssessments.push(
        { stage: "core", status: "skipped", reasons: ["model_not_invoked"], summary: "确定性预览未运行核心写作 Agent。", accepted: true, attempt: 0 },
        { stage: "comment_openers", status: "skipped", reasons: ["model_not_invoked"], summary: "确定性预览未运行读者开口 Agent。", accepted: true, attempt: 0 },
        { stage: "comment_network", status: "skipped", reasons: ["model_not_invoked"], summary: "确定性预览未运行评论终编 Agent。", accepted: true, attempt: 0 },
        { stage: "ledger", status: "skipped", reasons: ["model_not_invoked"], summary: "确定性预览未运行台账 Agent。", accepted: true, attempt: 0 },
      );
      draft = { ...draft, editorialAssessments };
    }

    const allowedEvidenceIds = availableEvidence.map((reference) => reference.id);
    if (!this.provider || !useProvider) {
      draft = keepCriticalBoundariesInBody(draft, orchestrationPlan, input.config);
    }
    draft = bindDialogueProvenance(draft, orchestrationPlan, allowedEvidenceIds, evidenceSources, availableEvidence);
    const anchorContext: KnowledgeAnchorContext = { allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, projectBlueprint: input.planningContext?.projectBlueprint };
    // 证据自动锚定:bind 完成后、校验前,为敏感面上可精确锚定的受控声明补
    // fact 台账;锚不到的声明不挂,仍由校验层 error 拦截。
    draft = attachKnowledgeAnchors(draft, anchorContext);
    if (this.provider && useProvider) {
      // AI 判官兜底:仍未锚定的句子批量一次裁决,邀约/限定/疑问与有据断言放行。
      draft = await judgeSensitiveClaimsWithModel(this.provider, draft, anchorContext, {
        model: input.config.model.model,
        seed: seed + 5,
        temperature: Math.min(input.config.model.temperature, 0.2),
        maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_REVIEW_OUTPUT_TOKENS),
        metadata: { jobId: input.jobId, candidateIndex, purpose: "claim_judge", stage: 3.6 },
        onFailure: (error) => recordClaimJudgeFailure(stageIssues, error),
      });
    }
    draft = attachConfirmedAuthorFactReasoning(draft, input.config);
    draft = refreshCreativeScenarioIdentities(draft);
    let issues = [
      ...suppressGrowthWarningsAfterGrowthFailure(
        validateGenerationDraft({ draft, config: input.config, ledger, allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, orchestrationPlan, projectBlueprint: input.planningContext?.projectBlueprint }),
        stageIssues,
      ),
      ...stageIssues,
    ];
    emitGenerationTelemetry(input, {
      type: "candidate_validation",
      candidateIndex,
      phase: "initial",
      repairAttempt: 0,
      summary: validationTelemetrySummary(issues),
    });
    let repairAttempts = 0;
    if (issues.some((item) => issueDisposition(item) === "block")
      && !shouldAttemptGenerationRepair(issues)) {
      emitGenerationTelemetry(input, {
        type: "candidate_repair_skipped",
        candidateIndex,
        reason: issues.some((item) => issueDisposition(item) === "block" && !item.repairable)
          ? "terminal_blocker"
          : "repair_disabled",
        summary: validationTelemetrySummary(issues),
      });
    }
    // A model patch cannot make a candidate publishable while any terminal hard
    // error remains. Skip expensive repairs instead of spending tens of thousands
    // of tokens on a candidate that must still be reviewed.
    const maxAutomaticRepairAttempts = Math.min(input.config.generation.maxRepairAttempts, 1);
    while (shouldAttemptGenerationRepair(issues)
      && repairAttempts < maxAutomaticRepairAttempts) {
      repairAttempts += 1;
      const repairRoute = repairResponsibilityForIssues(issues);
      const channels = repairRoute.channels;
      if (repairRoute.responsibility !== "ledger_only" && !channels.length) break;
      const beforeRepairFingerprint = repairConvergenceFingerprint(draft, issues);
      const beforeJudgeSurface = claimJudgeSurfaceFingerprint(draft);
      emitGenerationTelemetry(input, {
        type: "candidate_repair_started",
        candidateIndex,
        repairAttempt: repairAttempts,
        channels,
        before: validationTelemetrySummary(issues),
      });
      if (repairRoute.responsibility === "comment_editor") {
        if (!this.provider || !useProvider) break;
        const commentsBefore = stagedCommentsFromDraft(draft);
        try {
          const commentPromptInput = {
            config: input.config, formulaVersion: input.formulaVersion, knowledge: context, ledger,
            candidateIndex, seed, variation, impactReport, topicOpportunity: planning.opportunity,
            projectIntelligence: planning.intelligence, projectBlueprint: input.planningContext?.projectBlueprint,
            imageAnalyses: planning.imageAnalyses, orchestrationPlan, evidenceReferences: availableEvidence,
          };
          const reasons = issues.filter((issue) => issue.repairable && issueDisposition(issue) !== "advisory" && issue.channel === "Cref").map((issue) => `${issue.code}: ${issue.message}`);
          const prompt = buildStagedCommentNetworkEditorPrompt(commentPromptInput, { H: draft.content.H, N: draft.content.N }, commentsBefore, reasons);
          const response = await this.provider.generate({
            messages: prompt.messages, responseSchema: prompt.responseSchema, schemaName: "content_candidate_comment_network_editor",
            model: input.config.model.model, seed: seed + 300 + repairAttempts, temperature: Math.min(input.config.model.temperature, 0.35),
            maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
            metadata: { jobId: input.jobId, candidateIndex, purpose: "repair_comment_network", attempt: repairAttempts, stage: 4.1 },
          });
          const edited = parseStagedCommentNetworkEditor(response.text);
          const accepted = acceptCommentNetworkEdit(
            commentsBefore,
            edited,
            orchestrationPlan,
            input.planningContext?.projectBlueprint?.claimPolicy.rules ?? [],
          );
          draft = applyAcceptedCommentNetwork(draft, accepted);
          editorialAssessments.push({ stage: "comment_network", status: edited.assessment.status, reasons: [...edited.assessment.reasons], summary: edited.assessment.summary, accepted: true, attempt: repairAttempts + 1 });
        } catch (error) {
          editorialAssessments.push({ stage: "comment_network", status: error instanceof CommentEditorContractError ? "rejected" : "unavailable", reasons: [error instanceof Error ? error.message : String(error)], summary: "评论修复未被采用。", accepted: false, attempt: repairAttempts + 1 });
          issues = [...issues, { code: "comment_editor_contract_rejected", severity: "error", channel: "Cref", message: error instanceof Error ? error.message : String(error), repairable: false, disposition: "block", origin: "deterministic" }];
          continue;
        }
      } else if (!this.provider || !useProvider) {
        const replacement = deterministicDraft(input.config, context, ledger, candidateIndex, variation, impactReport, orchestrationPlan, planning.opportunity, evidenceSources);
        draft = { ...replacement, content: mergeContentByChannels(draft.content, replacement.content, channels), editorialAssessments };
      } else {
        const prompt = buildRepairPrompt({
          current: draft, issues, channels, config: input.config, knowledge: context,
          seed: seed + repairAttempts, attempt: repairAttempts, impactReport,
          imageAnalyses: planning.imageAnalyses, orchestrationPlan, evidenceReferences: availableEvidence,
        });
        try {
          const response = await this.provider.generate({
            messages: prompt.messages, responseSchema: prompt.responseSchema, schemaName: "content_repair_patch",
            model: input.config.model.model, seed: seed + repairAttempts, temperature: Math.min(input.config.model.temperature, 0.4),
            maxOutputTokens: input.config.model.maxOutputTokens,
            metadata: { jobId: input.jobId, candidateIndex, purpose: "repair", attempt: repairAttempts },
          });
          const patch = parseGenerationPatch(response.text);
          if (patch.Cref) throw new CommentEditorContractError("Generic repair attempted to write Cref; comments belong to the network editor.");
          draft = applyGenerationPatch(draft, patch);
        } catch (error) {
          emitGenerationTelemetry(input, { type: "candidate_repair_failed", candidateIndex, repairAttempt: repairAttempts, errorName: error instanceof Error ? error.name.slice(0, 80) : "UnknownError" });
          issues = [...issues.filter((item) => item.code !== "repair_parse_failed"), {
            code: "repair_parse_failed", severity: "error", channel: "package",
            message: error instanceof Error ? error.message : String(error), repairable: repairAttempts < maxAutomaticRepairAttempts,
          }];
          continue;
        }
      }
      if (!this.provider || !useProvider) {
        draft = keepCriticalBoundariesInBody(draft, orchestrationPlan, input.config);
      }
      draft = bindDialogueProvenance(draft, orchestrationPlan, allowedEvidenceIds, evidenceSources, availableEvidence);
      // 修复回路同样在校验前做证据自动锚定(幂等,已挂的不会重复挂)。
      draft = attachKnowledgeAnchors(draft, anchorContext);
      if (this.provider && useProvider && claimJudgeSurfaceFingerprint(draft) !== beforeJudgeSurface) {
        // Only rerun the judge when a sensitive visible surface actually changed.
        // Metadata/reader-only edits preserve prior judgments and avoid a costly
        // no-op judge round.
        draft = await judgeSensitiveClaimsWithModel(this.provider, draft, anchorContext, {
          model: input.config.model.model,
          seed: seed + repairAttempts + 200,
          temperature: Math.min(input.config.model.temperature, 0.2),
          maxOutputTokens: Math.min(input.config.model.maxOutputTokens, GENERATION_REVIEW_OUTPUT_TOKENS),
          metadata: { jobId: input.jobId, candidateIndex, purpose: "claim_judge", attempt: repairAttempts },
          onFailure: (error) => recordClaimJudgeFailure(stageIssues, error),
        });
      }
      draft = attachConfirmedAuthorFactReasoning(draft, input.config);
      draft = refreshCreativeScenarioIdentities(draft);
      issues = [
        ...suppressGrowthWarningsAfterGrowthFailure(
          validateGenerationDraft({ draft, config: input.config, ledger, allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence, orchestrationPlan, projectBlueprint: input.planningContext?.projectBlueprint }),
          stageIssues,
        ),
        ...stageIssues,
      ];
      emitGenerationTelemetry(input, {
        type: "candidate_validation",
        candidateIndex,
        phase: "after_repair",
        repairAttempt: repairAttempts,
        summary: validationTelemetrySummary(issues),
      });
      if (repairConvergenceFingerprint(draft, issues) === beforeRepairFingerprint) {
        emitGenerationTelemetry(input, {
          type: "candidate_repair_skipped",
          candidateIndex,
          reason: "no_progress",
          summary: validationTelemetrySummary(issues),
        });
        break;
      }
    }

    const realizedCoverage = evaluateGapCoverageRealization(draft, orchestrationPlan);
    if (this.deliveryReadinessPolicy === "formal") {
      issues.push(...formalDeliveryReviewIssues(
        orchestrationPlan,
        realizedCoverage,
        Boolean(this.provider && useProvider),
        "本候选由确定性兜底生成，未执行配置的模型；可查看结构，但发布前必须人工确认或重新生成。",
      ));
    }
    issues = completeIssueMetadata(issues);
    const generationMode = this.provider && useProvider ? "model_generated" as const : "deterministic_preview" as const;
    draft = annotateAnswerRealizations({ ...draft, editorialAssessments }, orchestrationPlan, issues, generationMode);
    const artifactRealization = artifactRealizationFor(draft, orchestrationPlan, issues, generationMode);
    const finalQualityStatus = candidateQualityStatus({ issues });
    emitGenerationTelemetry(input, {
      type: "candidate_completed",
      candidateIndex,
      qualityStatus: finalQualityStatus,
      repairAttempts,
      summary: validationTelemetrySummary(issues),
    });

    const realizedPlanWithoutArtifacts: OrchestrationPlan = {
      ...orchestrationPlan,
      dialogueThreads: orchestrationPlan.dialogueThreads.map((thread, index) => ({
        ...thread,
        surfaceRoleCard: draft.content.Cref.threads[index]?.surfaceRoleCard ?? thread.surfaceRoleCard,
        conversationPlan: draft.content.Cref.threads[index]?.conversationPlan ?? thread.conversationPlan,
      })),
      gapCoverageLedger: realizedCoverage,
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
      // 判官裁决随包落库。此前它只存在于 GenerationDraft 上,组包时丢弃,于是
      // 229 个落库包 claimJudgments 全为 0——那是观测盲区,不是判官没跑(它在
      // content.ts 的敏感声明校验里确实被消费)。落库后才能回答「敏感声明报错
      // 里判官覆盖了多少、判了多少 unsupported」。不改变任何判定行为。
      ...(draft.claimJudgments?.length ? { claimJudgments: draft.claimJudgments } : {}),
      ...(draft.commentEditorialAssessment ? { commentEditorialAssessment: draft.commentEditorialAssessment } : {}),
      editorialAssessments: structuredClone(editorialAssessments),
      artifactRealization,
      generationMode,
      unknowns: uniqueUnknowns(ledger, draft),
      conflicts: ledger.conflicts,
      diagnostics: [...diagnosticsFromValidation(issues), ...buildParameterDiagnostics(impactReport)],
      resolutionSnapshot,
      impactReport,
      validation: (() => {
        return { valid: finalQualityStatus !== "blocked", qualityStatus: finalQualityStatus, repairAttempts, issues };
      })(),
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
    const changesCommentContract = dependency.directChannels.includes("Cref")
      && /(?:答复|发布|发言|回复).{0,6}(?:身份|角色)|(?:身份|角色).{0,6}(?:改|换|调整)|主缺口|primary\s*gap|posting\s*identity|reply\s*identity/iu.test(input.instruction);
    if (changesCommentContract) {
      throw new Error("修改涉及评论答复身份、角色或主缺口，必须重新规划并生成，不能在改稿补丁中变更。");
    }

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
    const inheritedEvidence = input.package.evidence.filter((reference) => reference.path !== LEGACY_PLANNING_CONTEXT_EVIDENCE_PATH);
    const availableEvidence = [...new Map(
      [...inheritedEvidence, ...refreshedEvidence].map((reference) => [reference.id, reference]),
    ).values()];
    const evidenceSources = {
      ...Object.fromEntries(inheritedEvidence.flatMap((reference) => {
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
    const editorialAssessments: EditorialAssessmentRecord[] = [...(input.package.editorialAssessments ?? [])];
    const current: GenerationDraft = {
      content: input.package.content,
      evidenceIds: input.package.evidence.map((item) => item.id),
      reasoning: input.package.reasoning,
      unknowns: input.package.unknowns,
      commentEditorialAssessment: input.package.commentEditorialAssessment,
      coreEditorialAssessment: input.package.coreEditorialAssessment,
      editorialAssessments,
    };
    let revised = current;
    const coreChannels = dependency.rerunChannels.filter((channel) => channel !== "Cref");
    const revisesComments = dependency.rerunChannels.includes("Cref");

    if (this.provider) {
      if (coreChannels.length) {
        const syntheticIssues: ContentValidationIssue[] = coreChannels.map((channel) => ({
          code: dependency.semanticChange ? "user_revision_fact_consistency" : "user_revision_presentation",
          severity: "error", channel, message: input.instruction, repairable: true,
        }));
        const prompt = buildRepairPrompt({
          current: revised, issues: syntheticIssues, channels: coreChannels,
          config, knowledge: context, seed: input.package.seed + input.package.revisions.length + 1,
          attempt: 1, impactReport, imageAnalyses: input.imageAnalyses,
          orchestrationPlan: input.package.orchestrationSnapshot, evidenceReferences: availableEvidence,
        });
        const response = await this.provider.generate({
          messages: prompt.messages, responseSchema: prompt.responseSchema, schemaName: "chat_revision_core_patch",
          model: config.model.model, seed: input.package.seed + input.package.revisions.length + 1,
          temperature: config.model.temperature, maxOutputTokens: config.model.maxOutputTokens,
          metadata: { jobId: input.package.jobId, candidateIndex: input.package.candidateIndex, purpose: "revision", stage: "core" },
        });
        const parsedPatch = parseGenerationPatch(response.text);
        if (parsedPatch.Cref) throw new CommentEditorContractError("Core revision attempted to write Cref.");
        const patched = applyGenerationPatch(revised, parsedPatch);
        const contentRevision = coreChannels.some((channel) => channel !== "H");
        revised = {
          ...patched,
          content: mergeContentByChannels(revised.content, patched.content, coreChannels),
          evidenceIds: contentRevision ? patched.evidenceIds : revised.evidenceIds,
          reasoning: contentRevision ? patched.reasoning : revised.reasoning,
          unknowns: contentRevision ? patched.unknowns : revised.unknowns,
          editorialAssessments,
        };
      }
      if (revisesComments) {
        const plan = input.package.orchestrationSnapshot;
        if (!plan) throw new Error("历史内容缺少冻结评论编排，不能自动修改评论；请重新生成。");
        const promptInput: import("./prompt.js").GenerationPromptInput = {
          config, formulaVersion: input.formulaVersion, knowledge: context, ledger,
          candidateIndex: input.package.candidateIndex,
          seed: input.package.seed + input.package.revisions.length + 1,
          variation: variationFor(input.package.seed + input.package.revisions.length + 1, input.package.candidateIndex),
          impactReport, topicOpportunity: revisionOpportunity,
          projectIntelligence: input.planningContext?.projectIntelligence,
          projectBlueprint: input.planningContext?.projectBlueprint,
          imageAnalyses: input.imageAnalyses, orchestrationPlan: plan, evidenceReferences: availableEvidence,
        };
        const before = stagedCommentsFromDraft(revised);
        const prompt = buildStagedCommentNetworkEditorPrompt(promptInput, { H: revised.content.H, N: revised.content.N }, before, [
          `用户修改要求：${input.instruction}`,
        ]);
        const response = await this.provider.generate({
          messages: prompt.messages, responseSchema: prompt.responseSchema,
          schemaName: "chat_revision_comment_network",
          model: config.model.model, seed: input.package.seed + input.package.revisions.length + 101,
          temperature: Math.min(config.model.temperature, 0.4),
          maxOutputTokens: Math.min(config.model.maxOutputTokens, GENERATION_SHORT_OUTPUT_TOKENS),
          metadata: { jobId: input.package.jobId, candidateIndex: input.package.candidateIndex, purpose: "revision_comment_network", stage: "comment_network" },
        });
        const edited = parseStagedCommentNetworkEditor(response.text);
        const accepted = acceptCommentNetworkEdit(
          before,
          edited,
          plan,
          input.planningContext?.projectBlueprint?.claimPolicy.rules ?? [],
        );
        revised = applyAcceptedCommentNetwork(revised, accepted);
        revised.commentEditorialAssessment = edited.assessment;
        editorialAssessments.push({
          stage: "comment_network", status: edited.assessment.status,
          reasons: [...edited.assessment.reasons], summary: edited.assessment.summary,
          accepted: true, attempt: input.package.revisions.length + 1,
        });
      }
      editorialAssessments.push({
        stage: "revision", status: "pass", reasons: [], summary: "修改已按阶段职责原子应用。",
        accepted: true, attempt: input.package.revisions.length + 1,
      });
    } else {
      const variation = variationFor(input.package.seed + input.package.revisions.length + 1, input.package.candidateIndex);
      const replacement = deterministicDraft(
        config, context, ledger, input.package.candidateIndex, variation, impactReport,
        input.package.orchestrationSnapshot, revisionOpportunity, evidenceSources,
      );
      // Deterministic compatibility mode may preview H/N changes, but never
      // rewrites comments that are owned by staged agents.
      revised = {
        ...replacement,
        content: mergeContentByChannels(current.content, replacement.content, coreChannels),
        editorialAssessments,
      };
      editorialAssessments.push({
        stage: "revision", status: "skipped", reasons: ["model_not_invoked"],
        summary: revisesComments ? "确定性预览未修改评论；评论需由阶段化 Agent 处理。" : "确定性预览未运行修改 Agent。",
        accepted: true, attempt: input.package.revisions.length + 1,
      });
    }

    const allowedEvidenceIds = availableEvidence.map((reference) => reference.id);
    if (input.package.orchestrationSnapshot) {
      if (!this.provider) revised = keepCriticalBoundariesInBody(revised, input.package.orchestrationSnapshot, config);
      revised = bindDialogueProvenance(revised, input.package.orchestrationSnapshot, allowedEvidenceIds, evidenceSources, availableEvidence);
      const anchorContext: KnowledgeAnchorContext = {
        allowedEvidenceIds, evidenceSources, evidenceReferences: availableEvidence,
        projectBlueprint: input.planningContext?.projectBlueprint,
      };
      revised = attachKnowledgeAnchors(revised, anchorContext);
      if (this.provider) {
        revised = await judgeSensitiveClaimsWithModel(this.provider, revised, anchorContext, {
          model: config.model.model, seed: input.package.seed + input.package.revisions.length + 202,
          temperature: Math.min(config.model.temperature, 0.2),
          maxOutputTokens: Math.min(config.model.maxOutputTokens, GENERATION_REVIEW_OUTPUT_TOKENS),
          metadata: { jobId: input.package.jobId, candidateIndex: input.package.candidateIndex, purpose: "claim_judge" },
        });
      }
      revised = refreshCreativeScenarioIdentities(revised);
    }
    const revisionIssues = validateGenerationDraft({
      draft: revised, config, ledger, allowedEvidenceIds, evidenceSources,
      evidenceReferences: availableEvidence, orchestrationPlan: input.package.orchestrationSnapshot,
      projectBlueprint: input.planningContext?.projectBlueprint,
    });
    const revisionCoverage = input.package.orchestrationSnapshot
      ? evaluateGapCoverageRealization(revised, input.package.orchestrationSnapshot) : undefined;
    if (this.deliveryReadinessPolicy === "formal") {
      revisionIssues.push(...formalDeliveryReviewIssues(
        input.package.orchestrationSnapshot, revisionCoverage, Boolean(this.provider),
        "本次修改未执行配置的模型，结果仅为不可交付预览。",
      ));
    }
    const issues = completeIssueMetadata(revisionIssues);
    const generationMode = this.provider ? "model_generated" as const : "deterministic_preview" as const;
    if (input.package.orchestrationSnapshot) {
      revised = annotateAnswerRealizations(revised, input.package.orchestrationSnapshot, issues, generationMode);
    }
    const artifactRealization = artifactRealizationFor(revised, input.package.orchestrationSnapshot, issues, generationMode);
    const now = this.now().toISOString();
    const revision: RevisionRecord = {
      id: `rev_${createHash("sha256").update(`${input.package.id}:${input.instruction}:${input.package.revisions.length}`).digest("hex").slice(0, 16)}`,
      createdAt: now, instruction: input.instruction,
      directChannels: dependency.directChannels, rerunChannels: dependency.rerunChannels,
      parentPackageId: input.package.id,
    };
    const revisedEvidence = citedEvidenceSnapshot(availableEvidence, revised.reasoning);
    const revisionPlanWithoutArtifacts: OrchestrationPlan | undefined = input.package.orchestrationSnapshot
      ? { ...input.package.orchestrationSnapshot, gapCoverageLedger: revisionCoverage! } : undefined;
    const productionArtifacts = buildProductionArtifacts({
      plan: revisionPlanWithoutArtifacts, content: revised.content, imageAnalyses: input.imageAnalyses,
      imageBriefEnabled: config.content.imageBriefEnabled, previous: input.package.productionArtifacts,
    });
    const realizedRevisionPlan = revisionPlanWithoutArtifacts
      ? { ...revisionPlanWithoutArtifacts, productionArtifacts: structuredClone(productionArtifacts) } : undefined;
    const qualityStatus = candidateQualityStatus({ issues });
    const revisedPackage: ContentPackage = {
      ...input.package,
      id: `${input.package.id}_r${input.package.revisions.length + 1}`,
      createdAt: now, content: revised.content, productionArtifacts,
      knowledgeSnapshot: knowledgeSnapshotFor(input.knowledge, context), orchestrationSnapshot: realizedRevisionPlan,
      formulaSnapshot: {
        versionId: input.formulaVersion.id, digest: input.formulaVersion.digest,
        enabledFormulaIds: [...config.formula.enabledFormulaIds],
        executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
        executionPolicyDigest: FORMULA_EXECUTION_POLICY_DIGEST,
        executionAudit: formulaExecutionAudit(input.formulaVersion, config.formula.enabledFormulaIds),
      },
      evidence: revisedEvidence, reasoning: revised.reasoning,
      commentEditorialAssessment: revised.commentEditorialAssessment,
      coreEditorialAssessment: revised.coreEditorialAssessment,
      editorialAssessments: structuredClone(editorialAssessments), artifactRealization, generationMode,
      unknowns: uniqueUnknowns(ledger, revised), conflicts: ledger.conflicts,
      diagnostics: [...diagnosticsFromValidation(issues), ...buildParameterDiagnostics(impactReport)],
      configSnapshot: cloneConfig(config), resolutionSnapshot: compilation.resolutionSnapshot, impactReport,
      validation: { valid: qualityStatus !== "blocked", qualityStatus, repairAttempts: 0, issues },
      revisions: [...input.package.revisions, revision],
    };
    return { package: revisedPackage, dependency };
  }}

export async function generateThreeCandidates(
  input: GenerationInput,
  options: ContentGenerationEngineOptions = {},
): Promise<GenerationResult> {
  return new ContentGenerationAgent(options).generate(input);
}
