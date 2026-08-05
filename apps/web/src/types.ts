export type EvidenceStatus =
  | "已知事实"
  | "案例样本"
  | "用户观点"
  | "方法论推理"
  | "猜想"
  | "信息不足"
  | "禁止表达";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: string;
  mustChangePassword?: boolean;
  /** 原始系统角色(透传,不做显示转换);role 仍是展示用字段。 */
  systemRole?: string;
  /** 原始工作区角色(透传,不做显示转换)。 */
  workspaceRole?: string;
  /** 用户类型:research 科研用户(默认) / saas 极简创作用户。 */
  userKind?: "research" | "saas";
}

export interface Project {
  id: string;
  workspaceId?: string;
  name: string;
  description?: string;
  domain?: string;
  status?: "active" | "archived";
  knowledgeCount?: number;
  generationCount?: number;
  activeFormulaVersion?: string;
  updatedAt?: string;
  cities?: string[];
  doctors?: Array<{ name: string; points?: string[] }>;
  generationDefaults?: {
    audienceStage?: string;
    entryPoint?: string;
    city?: string;
    doctor?: string;
    mustInclude?: string | string[];
    forbidden?: string | string[];
  };
}

export interface KnowledgeFile {
  id: string;
  projectId: string;
  name: string;
  category?: string;
  kind?: EvidenceStatus;
  size: number;
  status?: "ready" | "processing" | "failed";
  version?: number;
  updatedAt?: string;
  summary?: string;
  path?: string;
}

/** One pickable knowledge section in the gap editor's evidence picker (Cref v1.1). */
export interface KnowledgeEvidenceSection {
  evidenceId: string;
  sectionId: string;
  heading: string;
  excerpt: string;
  charLength: number;
  kind: string;
  evidenceStatus: string;
  caveats: string[];
}

/** A latest-version knowledge document grouped with its pickable sections. */
export interface KnowledgeEvidenceDocument {
  id: string;
  path: string;
  title: string;
  kind: string;
  evidenceStatus: string;
  sections: KnowledgeEvidenceSection[];
}

/**
 * 知识库完善度预检的分档。与后端 knowledge-preflight.ts 的 PreflightTier 对齐。
 *
 * - `evidence_backed` 答案能在上传资料里找到支撑
 * - `approved_only` 无资料支撑,依据是人工填写并确认;生成会采用,但它不是资料里的事实
 * - `evidence_stale` 分析器给过出处但引用已失效,必须重新分析或恢复资料
 * - `will_be_dropped` 无资料支撑且没有有效的负责人审批记录,生成会丢弃
 * - `blank` 没有答案
 */
export type KnowledgePreflightTier =
  | 'evidence_backed'
  | 'approved_only'
  | 'evidence_stale'
  | 'will_be_dropped'
  | 'blank';

export interface KnowledgePreflightGap {
  id: string;
  label: string;
  status: string;
  required: boolean;
  category: string;
  tier: KnowledgePreflightTier;
  sectionEvidenceIds: string[];
  /** 声明了却已失效的证据引用(资料被改动或删除)。 */
  staleDeclaredEvidenceIds: string[];
  reasons: string[];
}

/**
 * 项目分析状态。与后端 AnalysisState 对齐。
 *
 * 必须和缺口分档分开看:「一条缺口都没有」在数据上和「所有缺口都落实」长得一样
 * (计数全为 0),但含义相反——前者是还没分析过,那时生成必然被拦。
 */
export type KnowledgeAnalysisState = 'missing' | 'draft' | 'approved' | 'stale';

export interface KnowledgePreflight {
  analysis: KnowledgeAnalysisState;
  /** 分析已确认,且所有必答缺口都站得住。与生成端 engine.ts:892 同判据。 */
  canGenerate: boolean;
  requiredOpen: Array<{ id: string; label: string; tier: KnowledgePreflightTier }>;
  tiers: Record<KnowledgePreflightTier, number>;
  byCategory: Array<{ category: string; total: number; settled: number }>;
  gaps: KnowledgePreflightGap[];
  warnings: string[];
  /** 口径说明:预检判的是答案能否被采用,不是内容质量评分,且结论是保守下界。 */
  note: string;
}

export interface FormulaVersion {
  id: string;
  projectId: string;
  version: string;
  /** Server-computed digest binding calculations to this exact definition. */
  digest?: string;
  name: string;
  description?: string;
  status: "draft" | "active" | "archived";
  formulaCount?: number;
  createdAt?: string;
  activatedAt?: string;
  config?: Record<string, unknown>;
  formulas?: FormulaDefinition[];
  /** Optional server-side runtime audit. Older API responses omit it. */
  executionAudit?: FormulaExecutionAudit;
  /** Compatibility alias used by persisted generation/formula snapshots. */
  formulaExecutionAudit?: FormulaExecutionAudit;
  auditScope?: FormulaAuditScope;
}

export interface EnsureReviewedFormulaDefaultsResult {
  projectId: string;
  formulaVersionId: string;
  formulaVersionDigest: string;
  changed: boolean;
  operation: 'ensure_reviewed_defaults';
}

export interface FormulaDefinition {
  id: string;
  title: string;
  type: 'architecture' | 'normative' | 'hypothesis' | 'proxy' | 'validation';
  evidenceStatus: 'definition' | 'unvalidated' | 'bounded' | 'unknown';
  equation: string;
  plainLanguage: string;
  purpose: string;
  variables?: FormulaVariableDefinition[];
  expression?: unknown;
  /** Runtime fields are authoritative only when returned by the server. */
  compatibilityStatus?: 'reviewed' | 'pending_review' | 'unreviewed' | string;
  reviewStatus?: 'reviewed' | 'approved' | 'pending_review' | 'unreviewed' | string;
  handlerState?: 'enabled' | 'disabled' | 'pending_review' | 'unreviewed' | string;
  effectiveHandlers?: Record<string, string[]>;
  registeredHandlers?: Record<string, string[]>;
  implementationStatus?: FormulaImplementationStatus;
  executionClass?: FormulaExecutionClass;
  executionRoles?: FormulaExecutionRole[];
  controlMode?: FormulaControlMode;
  implementationRuntimeState?: FormulaImplementationRuntimeState;
  disableable?: boolean;
  implementedStages?: FormulaExecutionStage[];
  declaredStages?: FormulaExecutionStage[];
  registeredDispatchStages?: FormulaExecutionStage[];
  effectiveDispatchStages?: FormulaExecutionStage[];
  nonDispatchedStages?: FormulaExecutionStage[];
  actualExecution?: string;
  implementationBoundary?: string;
  codeLocations?: string[];
  declaredEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  effectiveEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  calculatorContract?: FormulaCalculatorContract;
  diagnosticContract?: FormulaDiagnosticContract;
}

export type FormulaStringFormat = 'trend_source_ref' | 'rfc3339_timestamp';

export interface FormulaVariableDefinition {
  path: string;
  description: string;
  valueType: 'number' | 'string' | 'boolean';
  required: boolean;
  /** Inclusive bounds supplied by the reviewed server-side calculator contract. */
  minimum?: number;
  maximum?: number;
  /** Unit input paired with this numeric variable. */
  unitPath?: string;
  /** Numeric variables in one group must use one identical, non-empty unit. */
  unitGroup?: string;
  allowedValues?: Array<string | number | boolean | null>;
  nonEmpty?: boolean;
  /** Server-reviewed string format; the browser only presents it and never substitutes validation. */
  format?: FormulaStringFormat;
}

export type FormulaCalculationConsumer = 'generation' | 'planning' | 'selection' | 'validation';

export interface FormulaExcludedResearchOutput {
  metric: string;
  protocolId: string;
  status: 'not_executed';
  outputProduced: false;
  notProducedByCalculator: true;
  reason: string;
  requiredObservations: string[];
}

export interface FormulaCalculatorContract {
  mode: 'manual_scenario';
  outputMetric: string;
  outputSemantics: 'unvalidated_scenario_index';
  outputRange?: [number, number];
  consumedBy: Record<FormulaCalculationConsumer, false>;
  prohibitedUses: FormulaCalculationConsumer[];
  excludedResearchOutputs: FormulaExcludedResearchOutput[];
  boundaries: string[];
}

export type DiagnosticProxyFormulaId = 'F32' | 'F33';
export type DiagnosticProxySemantics = 'ordered_component_review_metadata';
export type DiagnosticProxyEvaluationStatus = 'not_evaluated';

export interface FormulaDiagnosticComponentContract {
  id: string;
  label: string;
  direction: 'positive' | 'cost' | 'risk';
  evidenceStatus: 'unvalidated_proxy';
  sourceRequirement: 'calibrated_component_observation';
  boundary: string;
}

export interface FormulaDiagnosticContract {
  mode: 'display_priority_metadata';
  semantics: DiagnosticProxySemantics;
  aggregation: 'components_only';
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  aggregateStatus: 'unknown';
  aggregateValue: null;
  scoreProduced: false;
  missingDataPolicy: 'unknown_not_zero';
  emphasis: {
    range: [0, 100];
    semantics: 'display_and_manual_review_priority_only';
    affects: ['display_order', 'manual_review_priority'];
    doesNotAffect: ['component_value', 'component_status', 'threshold', 'diagnostic_conclusion', 'generation', 'planning', 'selection', 'validation'];
    tieBreak: 'canonical_component_order';
  };
  consumedBy: Record<FormulaCalculationConsumer, false>;
  componentDefinitions: FormulaDiagnosticComponentContract[];
  boundaries: string[];
}

export interface DiagnosticProxyComponent {
  id: string;
  label: string;
  emphasis: number;
  displayOrder: number;
  manualReviewRank: number;
  emphasisSemantics: 'display_and_manual_review_priority_only';
  direction: 'positive' | 'cost' | 'risk';
  status: 'unknown';
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  value: null;
  source: { kind: 'not_observed'; reference: null };
  evidenceStatus: 'unvalidated_proxy';
  boundary: string;
}

export interface DiagnosticProxyReport {
  formulaId: DiagnosticProxyFormulaId;
  formulaSemanticFingerprint: string;
  name: string;
  semantics: DiagnosticProxySemantics;
  status: 'unknown';
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  aggregateValue: null;
  scoreProduced: false;
  evidenceStatus: 'unvalidated_proxy';
  aggregation: 'components_only';
  components: DiagnosticProxyComponent[];
  warning: string;
  diagnosticContract: FormulaDiagnosticContract;
}

export interface HistoricalUnknownDiagnosticProxyComponent {
  id?: string;
  label?: string;
  emphasis?: unknown;
  displayOrder: null;
  manualReviewRank: null;
  emphasisSemantics: 'unknown';
  direction?: 'positive' | 'cost' | 'risk' | 'unknown';
  status: 'unknown';
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  value: null;
  source: null;
  evidenceStatus: 'unknown';
  contractStatus: 'unknown';
  boundary?: string | null;
}

export interface HistoricalUnknownDiagnosticProxyReport {
  formulaId?: string;
  formulaSemanticFingerprint: null;
  name?: string;
  semantics: 'unknown';
  status: 'unknown';
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  aggregateValue: null;
  scoreProduced: false;
  evidenceStatus: 'unknown';
  aggregation: 'unknown';
  components: HistoricalUnknownDiagnosticProxyComponent[];
  warning?: string;
  diagnosticContract: null;
  contractStatus: 'unknown';
  unknown: {
    status: 'unknown';
    reason: 'historical_contract_incomplete';
    missingFields: string[];
  };
}

export type DiagnosticProxySnapshot = DiagnosticProxyReport | HistoricalUnknownDiagnosticProxyReport;

export interface ContentDiagnostic {
  formulaId?: string;
  formulaSemanticFingerprint?: string | null;
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  explanation?: string;
  message?: string;
  score?: number;
  semantics?: DiagnosticProxySemantics | 'unknown';
  evaluationStatus?: DiagnosticProxyEvaluationStatus;
  aggregateValue?: null;
  scoreProduced?: false;
  parameterIds?: string[];
  channels?: string[];
  evidenceStatus?: string;
  aggregation?: 'components_only' | 'unknown';
  components?: Array<DiagnosticProxyComponent | HistoricalUnknownDiagnosticProxyComponent>;
  diagnosticContract?: FormulaDiagnosticContract | null;
  contractStatus?: 'current' | 'unknown';
  unknown?: {
    status: 'unknown';
    reason: 'historical_contract_incomplete';
    missingFields: string[];
  };
}

export interface ValidationReadinessHeuristic {
  schemaVersion: '1.0';
  kind: 'validation_issue_count_heuristic';
  semantics: 'non_quality_score';
  status: 'computed';
  value: number;
  range: [0, 100];
  inputs: {
    errorCount: number;
    warningCount: number;
    errorPenalty: 25;
    warningPenalty: 5;
  };
  evidenceStatus: 'operational_heuristic';
  calibrated: false;
  predicts: { quality: false; effect: false };
  excludes: {
    formulaIds: ['F32', 'F33'];
    diagnosticProxies: true;
    emphasis: true;
    missingValues: true;
  };
  consumedBy: Record<FormulaCalculationConsumer, false>;
}

export interface FormulaCalculationIssue {
  path: string;
  code:
    | 'required_input_missing'
    | 'invalid_type'
    | 'invalid_value'
    | 'empty_value'
    | 'source_ref_hashtag_only'
    | 'source_ref_not_specific'
    | 'observed_at_invalid_format'
    | 'observed_at_invalid_value'
    | 'out_of_range'
    | 'unit_required'
    | 'unit_mismatch'
    | 'unknown_variable'
    | 'calculation_warning';
  message: string;
}

export interface FormulaCalculationResult {
  formulaVersionId: string;
  formulaVersionDigest: string;
  formulaId: string;
  status: 'computed' | 'unknown' | 'invalid';
  value: number | null;
  unit: string | null;
  unknownPaths: string[];
  issues: FormulaCalculationIssue[];
  calculationOnly: true;
  directGeneration: false;
  consumedBy: {
    generation: false;
    planning: false;
    candidateSelection: false;
    validation: false;
    reachPrediction: false;
  };
  resultSemantics: 'manual_conditional_calculation';
  boundary: {
    explicitInputsOnly: true;
    usesLivePlatformData: false;
    predictsReach: false;
    predictsQualifiedReach: false;
    comparesHotTopicRankings: false;
  };
  calculatorContract?: FormulaCalculatorContract;
}

export type FormulaImplementationStatus = 'active' | 'partial' | 'conditional' | 'protocol-only' | 'not-implemented';
export type FormulaExecutionClass = 'direct-executable' | 'derived-calculator' | 'diagnostic-proxy' | 'protocol' | 'hypothesis' | 'not-implemented';
export type FormulaExecutionRole = 'direct-generation' | 'parameter-guidance' | 'conditional-calculator' | 'diagnostic-proxy' | 'deterministic-mechanism' | 'research-protocol';
export type FormulaControlMode = 'fully-gated' | 'partially-gated' | 'always-on' | 'not-running';
export type FormulaImplementationRuntimeState = 'not-reviewed' | 'not-running' | 'always-on' | 'mixed-active' | 'always-on-core-only' | 'calculator-ready' | 'handler-active' | 'disabled';
export type FormulaExecutionStage = 'configuration' | 'calculation' | 'generation' | 'planning' | 'binding' | 'diagnostic' | 'evaluation' | 'validation' | 'knowledge-update' | string;
export type FormulaEffectiveEvidenceStatus = FormulaDefinition['evidenceStatus'] | 'unreviewed';

export interface FormulaExecutionTrace {
  id: string;
  semanticFingerprint?: string;
  equationFingerprint?: string;
  compatibilityStatus?: string;
  reviewStatus?: string;
  handlerState?: string;
  requestedEnabled?: boolean;
  implementationStatus?: FormulaImplementationStatus;
  executionClass?: FormulaExecutionClass;
  executionRoles?: FormulaExecutionRole[];
  controlMode?: FormulaControlMode;
  implementationRuntimeState?: FormulaImplementationRuntimeState;
  disableable?: boolean;
  stages?: FormulaExecutionStage[];
  implementedStages?: FormulaExecutionStage[];
  declaredStages?: FormulaExecutionStage[];
  registeredDispatchStages?: FormulaExecutionStage[];
  effectiveDispatchStages?: FormulaExecutionStage[];
  nonDispatchedStages?: FormulaExecutionStage[];
  actualExecution?: string;
  implementationBoundary?: string;
  dataRequirement?: string;
  codeLocations?: string[];
  declaredEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  effectiveEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  registeredHandlers?: Record<string, string[]>;
  effectiveHandlers?: Record<string, string[]>;
}

export interface FormulaExecutionAudit {
  auditScope?: FormulaAuditScope;
  formulaTrace?: FormulaExecutionTrace[];
  pendingReviewFormulas?: FormulaExecutionTrace[];
  unreviewedFormulas?: FormulaExecutionTrace[];
}

export interface FormulaAuditScope {
  kind: string;
  formulaVersionId?: string;
  formulaVersionDigest?: string;
  enabledFormulaMode?: string;
  recordsSingleGenerationRun?: boolean;
  description?: string;
}

export type CommentPersonaRole =
  | "first_time_researcher"
  | "information_collector"
  | "comparison_decider"
  | "risk_concerned"
  | "local_action_seeker"
  | "skeptical_returning_reader";
export type CommentSpeakerType = "simulated_reader" | "accountable_responder";
export type CommentClaimStatus = "verified" | "bounded" | "unknown" | "hypothetical";
export type CommentEvidenceStance = "evidence_first" | "verification_seeking" | "boundary_sensitive" | "unknown_aware";
export interface DialogueRoleCard {
  stage: string;
  knowledge: string[];
  constraints: string[];
  decisionTask: string;
  evidenceStance: CommentEvidenceStance;
}
export interface CommentSurfaceRoleCard {
  displayRole: string;
  relationToHost: string;
  identityCue: string;
  situationCue: string;
  motive: string;
  knowledgePosition: string;
  speechPattern: string;
  lexicalCues: string[];
  interactionHook: string;
  permittedContribution: string;
  utteranceMode: string;
  targetChars: [number, number];
  replyDisplayRole: string;
}
export interface PersonaScenePlan {
  prototype: string;
  host: {
    identityCue: string; lifeContext: string; localityCue: string; currentStage: string;
    immediateConstraint: string; relationshipAnchor: string; affect: string; motive: string;
    voiceTraits: string[]; speechMarkers: string[]; knowledgeBoundary: string; status: string;
  };
  event: {
    timeAnchor: string; setting: string; trigger: string; observableAction: string;
    friction: string; emotionalAftertaste: string; openLoop: string; imageMoment: string;
  };
  commentCast: CommentSurfaceRoleCard[];
  commentNetwork: {
    platformRegister: string; platformLanguageRule: string; multiTurnTarget: [number, number];
    branchMoves: string[]; organicMoves: string[]; antiScriptRules: string[];
  };
  surfaceTargets: {
    titleChars: [number, number]; bodyChars: [number, number]; bodyParagraphs: [number, number];
    visibleCommentLines: [number, number]; typicalCommentChars: [number, number];
  };
  crossChannelRules: string[];
  sampleBasis: string;
}
export interface CommentDensityProxy {
  primaryGapCount: 1;
  auxiliaryDimensionCount: number;
  roleDimensionCount: number;
  constraintCount: number;
  expectedReplyComponents: 5;
  questionTargetChars: number;
}
export interface CommentReplyPlan {
  directAnswer: string;
  condition: string;
  boundary: string;
  unknown: string;
  nextQuestion: string;
}
export interface DiscoveryPlan {
  cue: string;
  inferencePrompt: string;
  reveal: string;
  selfCheck: string;
  boundary: string;
  revealTiming: "same_thread";
  difficulty: "low" | "moderate";
}
export type CommentDiscoveryPlan = DiscoveryPlan;
export type ContentChannel = "H" | "N.imageBrief" | "N.title" | "N.body" | "Cref";
export type CommentGapCoverageStatus =
  | "planned_for_body"
  | "planned_for_thread"
  | "body_resolved"
  | "thread_resolved"
  | "realization_failed"
  | "awaiting_user_input"
  | "unknown_with_verification"
  | "explicitly_deferred";
export interface GapActualRealization {
  channel: "N.body" | "Cref";
  threadId?: string;
  answerRealized: boolean;
  conditionOrBoundaryRealized: boolean;
  evidenceRealized: boolean;
  findable: boolean;
  resolved: boolean;
  missing: Array<"answer" | "condition_or_boundary" | "evidence" | "findability">;
}
export interface CommentGapCoverageEntry {
  gapId: string;
  label: string;
  status: CommentGapCoverageStatus;
  required: boolean;
  bodyAllocated: boolean;
  commentAllocated: boolean;
  /** Canonical planned positions. Optional only so historical jobs remain readable. */
  plannedPlacements?: ContentChannel[];
  /** Filled after checking the final visible body and comment threads. */
  actualRealizations?: GapActualRealization[];
  primaryThreadIds: string[];
  auxiliaryThreadIds: string[];
  reason: string;
  requiredInput?: string;
  verificationPath?: string;
}
export interface CommentGapCoverageLedger {
  entries: CommentGapCoverageEntry[];
  uncoveredGapIds: string[];
  /** Whether every selected gap has a ledger row; this is not a resolution rate. */
  ledgerCompleteness?: number;
  /** Legacy alias of ledgerCompleteness. */
  closureRate: number;
  resolvedRate: number;
  /** Null means the final visible draft has not been evaluated. */
  realizedResolvedRate?: number | null;
  realizationStatus?: "not_evaluated" | "evaluated";
  targetThreadCount: number;
  effectiveThreadCount: number;
  capacityWarning?: string;
}
export interface CommentScenarioMetadata {
  personaRole?: CommentPersonaRole;
  speakerType?: CommentSpeakerType;
  claimStatus?: CommentClaimStatus;
  replyTo?: string | null;
  threadDepth?: number;
  simulated?: boolean;
  simulationLabel?: string;
}

/** Dialogic node kind (Cref contract v1.1). Optional everywhere so historical packages stay readable. */
export type CommentNodeKind = "question" | "answer" | "follow_up" | "clarification";

export interface CommentThread extends CommentScenarioMetadata {
  question: string;
  answer: string;
  purpose?: string;
  id?: string;
  gapId?: string;
  gap?: string;
  stage?: string;
  readerState?: ReaderStateProxy;
  dialogue?: CommentDialogueTurn[];
  nextStep?: string;
  followUps?: Array<CommentScenarioMetadata & { id?: string; question: string; answer: string; evidenceIds?: string[]; kind?: CommentNodeKind | string; boundary?: string; displayName?: string }>;
  /** 提问者展示昵称(纯展示元数据);历史包没有该字段,界面不出空徽标。 */
  displayName?: string;
  /** 线程级互动形态(读者互动层);历史包缺省按 org_answer(T1 机构问答)渲染。 */
  threadKind?: "org_answer" | "reader_exchange" | "organic_reaction" | string;
  /** T2 接话读者 B 的展示昵称(纯展示元数据);仅 T2 线程出现。 */
  replyDisplayName?: string;
  /** T2 接话读者 B 的可见角色卡;仅 T2 线程出现。 */
  replySurfaceRoleCard?: CommentSurfaceRoleCard;
  /** Dialogic kind of the root question node; positional default `question`. */
  kind?: CommentNodeKind | string;
  /** Dialogic kind of the root answer node; positional default `answer`. */
  answerKind?: CommentNodeKind | string;
  /** Thread-level boundary (Cref contract v1.1). */
  boundary?: string;
  postingIdentity?: "author" | "brand" | "staff" | "expert" | "reader_question_template" | string;
  answerIdentity?: "simulated_reader" | "none" | "author" | "brand" | "staff" | "expert" | "publisher" | string;
  sourceClusterIds?: string[];
  evidenceIds?: string[];
  function?: "surface_gap" | "answer" | "clarify" | "counterexample" | "verification" | "next_step" | string;
  roleCard?: DialogueRoleCard;
  primaryGapId?: string;
  auxiliaryGapIds?: string[];
  densityProxy?: CommentDensityProxy;
  replyPlan?: CommentReplyPlan;
  discoveryPlan?: DiscoveryPlan;
  conversationPlan?: DialogueThreadPlan["conversationPlan"];
  surfaceRoleCard?: CommentSurfaceRoleCard;
}

export type ReaderStateHypothesisLevel = "low" | "medium" | "high";

export interface ReaderStateHypothesis {
  level: ReaderStateHypothesisLevel;
  range: [number, number];
  calibrated: false;
  source: "stage_heuristic";
  basis: string;
}

/** Current orchestration scenario. These fields are hypotheses, not observed reader traits. */
export interface AudienceStateSeedProxy {
  entry: string;
  stage: string;
  /** User-supplied only; project evidence must never be promoted into this field. */
  preContactKnown: string[];
  /** Evidence available to the agent, not information assumed to be known by the reader. */
  availableEvidence: string[];
  hypothesizedGaps: string[];
  readerConstraints: string[];
  /** Project/content boundaries available to the agent, not reader constraints. */
  availableBoundaries: string[];
  history: {
    status: "provided" | "unknown";
    items: string[];
  };
  stateHypotheses: {
    skepticism: ReaderStateHypothesis;
    fatigue: ReaderStateHypothesis;
    closureNeed: ReaderStateHypothesis;
  };
  status: "hypothesis";
  calibrationStatus: "unvalidated";
}

/** Historical snapshot shape retained only so previously generated packages remain readable. */
export interface LegacyReaderStateProxy {
  entry?: string;
  stage: string;
  known?: string[];
  perceivedGaps?: string[];
  goal?: string;
  constraints?: string[];
  scene?: string;
  priorKnowledge?: string;
  concern?: string;
  comparisonHistory?: string;
  skepticism?: number;
  fatigue?: number;
  closureNeed?: number;
  status?: "hypothesis" | string;
}

export type ReaderStateProxy = AudienceStateSeedProxy | LegacyReaderStateProxy;

export interface CommentDialogueTurn {
  id: string;
  replyTo?: string | null;
  kind: "question" | "answer" | "follow_up" | "counterexample" | "clarification" | "verification" | "next_step";
  text: string;
  role: string;
  postingIdentity: string;
  sourceClusterIds: string[];
  evidenceIds: string[];
  boundary?: string;
}

export interface ImagePlanItem {
  assetId?: string;
  position: number;
  role: "cover" | "context" | "process" | "comparison" | "evidence" | "summary" | string;
  informationTask: string;
  overlayText?: string;
  crop?: string;
  evidenceIds?: string[];
  caveats?: string[];
}

export interface ImagePlan {
  /** Source material the plan may refer to. This is not a generated final image. */
  sourceAssetId?: string;
  /** @deprecated Historical alias. Treat only as a planned source-material reference. */
  primaryAssetId?: string;
  role?: string;
  coverText?: string;
  frames?: string[];
  composition?: string;
  altText?: string;
  evidenceIds?: string[];
  boundaries?: string[];
  /** Legacy/UI-authored storyboard shape. */
  summary?: string;
  items?: ImagePlanItem[];
  missingShots?: string[];
}

export type ProductionAlignmentStatus = "pass" | "warn" | "fail" | "not_evaluated";

export interface ProductionAlignmentCheck {
  id: string;
  status: ProductionAlignmentStatus;
  reason: string;
  anchors: string[];
}

/**
 * A bounded semantic check between two production stages. It describes only
 * the supplied artifacts; it is not a platform-performance or visual-quality score.
 */
export interface ProductionAlignmentReport {
  status: ProductionAlignmentStatus;
  evaluated: boolean;
  reasons: string[];
  checks: ProductionAlignmentCheck[];
}

/** Explicit stage ledger. A plan, brief or deployment plan is never a final asset or deployment record. */
export interface ProductionArtifacts {
  schemaVersion: "1.0";
  imageObservation: {
    status: "not_supplied" | "approved";
    sourceAssetId?: string;
    analysisAssetIds: string[];
    note: string;
  };
  imagePlan: {
    status: "absent" | "planned";
    sourceAssetId?: string;
    note: string;
  };
  imageBrief: {
    status: "disabled" | "absent" | "drafted" | "contract_validated";
    note: string;
  };
  finalImageAsset: {
    status: "absent" | "declared" | "verified";
    assetId?: string;
    note: string;
  };
  entrySnapshot: {
    status: "absent" | "captured" | "verified";
    snapshotId?: string;
    note: string;
  };
  deployment: {
    status: "not_deployed" | "recorded" | "observed" | "unknown";
    note: string;
  };
  planToCopyAlignment: ProductionAlignmentReport;
  finalAssetAlignment: ProductionAlignmentReport;
  entrySnapshotAlignment: ProductionAlignmentReport;
}

export interface DeploymentPlan {
  postingIdentity?: string;
  ownedFirstComment?: boolean | string;
  pinPriority?: string[];
  /** Response-time tier (Cref contract v1.1). */
  sla?: string;
  /** @deprecated Historical snapshots stored the SLA here. */
  responseSla?: string;
  actions?: Array<{
    order: number;
    threadId?: string;
    turnId?: string;
    postingIdentity: string;
    condition?: string;
  }>;
  /** v1.1 structured {route,condition,action} rules; historical snapshots stored plain strings or legacy intent/target objects. */
  liveRouting?: Array<{ route: string; condition: string; action: string } | { intent: string; target: string; reason?: string } | string>;
  updatePolicy?: string[];
  updateTriggers?: string[];
  stopRules?: string[];
}

export interface CoverageSignature {
  version?: string;
  topicKey?: string;
  gapIds: string[];
  strategyId?: string;
  imageRole?: string;
  audienceStage?: string;
  entry?: string;
  channelFeatures?: Record<string, string[]>;
  tokens?: string[];
  fingerprint?: string;
  createdAt?: string;
  /** Legacy coverage fields. */
  value?: string;
  stateIds?: string[];
  imageRoles?: string[];
  allocation?: string[];
  threadTopology?: string[];
  evidenceIds?: string[];
}

export interface CoverageRecord {
  id: string;
  projectId: string;
  generationJobId: string | null;
  contentPackageId: string | null;
  opportunityId: string | null;
  signature: CoverageSignature;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DialogueThreadPlan extends CommentScenarioMetadata {
  id: string;
  gapId?: string;
  stage?: string;
  function?: string;
  questionIntent?: string;
  answerRequirements?: string[];
  followUpIntent?: string;
  nextStep?: string;
  postingIdentity?: string;
  sourceClusterIds?: string[];
  evidenceIds?: string[];
  boundaryRequired?: boolean;
  roleCard?: DialogueRoleCard;
  primaryGapId?: string;
  auxiliaryGapIds?: string[];
  densityProxy?: CommentDensityProxy;
  replyPlan?: CommentReplyPlan;
  discoveryPlan?: DiscoveryPlan;
  surfaceRoleCard?: CommentSurfaceRoleCard;
  conversationPlan?: {
    topology: string; targetFollowUps: number; openingMove: string; replyMove: string;
    extensionMove: string; extensionGapId?: string;
  };
  /** 线程级互动形态(读者互动层);历史包缺省按 org_answer 理解。 */
  threadKind?: "org_answer" | "reader_exchange" | "organic_reaction" | string;
  /** T2 接话读者 B 的展示昵称(纯展示元数据);仅 T2 线程出现。 */
  replyDisplayName?: string;
  /** T2 接话读者 B 的可见角色卡;仅 T2 线程出现。 */
  replySurfaceRoleCard?: CommentSurfaceRoleCard;
}

export interface InformationGapPlanningCard {
  gapId: string;
  label: string;
  question: string;
  category: string;
  audienceStages: string[];
  importance: number;
  decisionLeverage: number;
  proofability: number;
  required: boolean;
  priority: "required" | "high" | "standard";
  answer?: string;
  framework?: string;
  boundary?: string;
  evidenceIds: string[];
  plannedPlacements: ContentChannel[];
}

export interface OrchestrationSnapshot {
  id?: string;
  topicOpportunityId?: string;
  candidateIndex?: number;
  seed?: number;
  strategy?: {
    id?: string;
    label?: string;
    openingMode?: string;
    narrativeMode?: string;
    bodyRole?: string;
    imageRole?: string;
    commentMode?: string;
    voice?: string;
    sequence?: string[];
  };
  stateSeed?: ReaderStateProxy;
  personaScenePlan?: PersonaScenePlan;
  selectedGapIds?: string[];
  gapPlanningCards?: InformationGapPlanningCard[];
  channelAllocation?: Record<string, string[]>;
  imagePlan?: ImagePlan;
  /** Optional for historical packages. New packages carry the explicit production-stage ledger. */
  productionArtifacts?: ProductionArtifacts;
  dialogueThreads?: DialogueThreadPlan[];
  gapCoverageLedger?: CommentGapCoverageLedger;
  targetThreadCount?: number;
  effectiveThreadCount?: number;
  capacityWarning?: string;
  deploymentPlan?: DeploymentPlan;
  rationale?: string[];
  evidenceIds?: string[];
  boundaries?: string[];
  /** Legacy UI snapshot fields. */
  opportunityId?: string;
  strategyId?: string;
  strategyName?: string;
  gapIds?: string[];
  readerStates?: ReaderStateProxy[];
  structuralDifferences?: string[];
  opportunitySelectionAudit?: OpportunitySelectionAudit;
}

/**
 * 阅读投影(GET /api/generations/:id/reader)。极简创作「查看」用这个,
 * 字段集由 apps/api/test/generation-reader-view.test.ts 白名单锁死。
 *
 * 与 Candidate 的分工:Candidate 是完整版工作台的全量视图(含 trace、参数影响报告、
 * 编排快照,单候选 234 KB);ReaderCandidate 只留阅读与决策要用的字段(约 12 KB),
 * 但反过来带上了 Candidate 没有的 reasoning / gapLedger / strategy。
 */
export interface ReaderReasoningEntry {
  statement: string;
  status: string;
  location?: string;
  /** 落在哪个具体字段:title / body / question / answer / imageBrief / hashtags / nextStep */
  field?: string;
  threadId?: string;
  followUpIndex?: number;
  evidenceIds: string[];
}

export interface ReaderComment {
  id?: string;
  question: string;
  answer: string;
  function?: string;
  /** 线程互动形态:只有 org_answer 的 answer 出自可追责身份,其余是模拟读者接话。 */
  threadKind?: "org_answer" | "reader_exchange" | "organic_reaction" | string;
  postingIdentity?: string;
  answerIdentity?: "simulated_reader" | "none" | "author" | "brand" | "staff" | "expert" | "publisher" | string;
  /** 最终机构答复展示角色；创作区仿真预览也使用，避免统一署成项目账号。 */
  surfaceRoleCard?: Pick<CommentSurfaceRoleCard, "replyDisplayRole">;
  personaRole?: string;
  stage?: string;
  gap?: string;
  boundary?: string;
  nextStep?: string;
  simulated?: boolean;
  displayName?: string;
  followUps: Array<{ question: string; answer: string; boundary?: string }>;
}

/** 候选表达轴。prototype 是封闭枚举;其余是开放词表(含模型产出的中文自由文本),原样显示。 */
export interface ReaderStrategy {
  label?: string;
  prototype?: string;
  openingMode?: string;
  narrativeMode?: string;
  bodyRole?: string;
  commentMode?: string;
  voice?: string;
}

export interface ReaderGapLedgerEntry {
  gapId: string;
  label: string;
  status: string;
  required: boolean;
  plannedPlacements: string[];
  reason?: string;
  requiredInput?: string;
  verificationPath?: string;
  realizations: Array<{ channel: string; threadId?: string; resolved: boolean; missing: string[] }>;
}

export type ContentIssueDisposition = "block" | "review" | "advisory";
export type ContentIssueOrigin = "deterministic" | "agent" | "infrastructure";
export type CandidateQualityStatus = "passed" | "needs_review" | "blocked";

export interface CommentEditorialAssessment {
  status: "pass" | "review";
  reasons: string[];
  summary: string;
}

export interface CandidateValidationIssue {
  code?: string;
  severity: "error" | "warning";
  channel?: string;
  message: string;
  repairable?: boolean;
  disposition?: ContentIssueDisposition;
  origin?: ContentIssueOrigin;
}

export interface CandidateValidation {
  valid: boolean;
  qualityStatus?: CandidateQualityStatus;
  repairAttempts: number;
  issues: CandidateValidationIssue[];
}

export interface ReaderCandidate {
  id: string;
  /** 当前用户对当前候选的人工交付确认；不改变 validation.valid。 */
  manualDeliveryConfirmation?: {
    confirmed: true;
    confirmedAt: string;
    confirmedBy: string;
  };
  packageId: string;
  candidateIndex: number;
  seed: number;
  title: string;
  body: string;
  tags: string[];
  imageBrief?: string;
  commentDisclaimer?: string;
  commentOwnedFirstComment?: string;
  commentUncoveredGaps?: string[];
  comments: ReaderComment[];
  validation?: CandidateValidation;
  commentEditorialAssessment?: CommentEditorialAssessment;
  reasoning: ReaderReasoningEntry[];
  gapLedger?: { entries: ReaderGapLedgerEntry[]; realizationStatus?: string };
  gapCards: Array<{
    gapId: string;
    label: string;
    question: string;
    required: boolean;
    priority?: string;
    boundary?: string;
    plannedPlacements: string[];
  }>;
  sources: Array<{ name: string; kind?: string; evidenceStatus?: string; section?: string }>;
  unknowns: Array<{ question: string; impact?: string; reason?: string }>;
  strategy?: ReaderStrategy;
  deploymentPlan?: DeploymentPlan;
}

export interface ReaderJob {
  id: string;
  projectId: string;
  topic: string;
  goal?: string;
  status: GenerationStatus;
  qualityStatus?: GenerationQualityStatus;
  createdAt?: string;
  completedAt?: string;
  error?: string;
  /**
   * 修改任务。改稿期间 status 仍是 completed,所以「有没有在改」由这个字段回答;
   * 无活跃任务时后端回落成最近一条(含终态),有值 ≠ 正在改,要看 status。
   */
  activeRevision?: RevisionTask;
  candidates: ReaderCandidate[];
}

export interface Candidate {
  id: string;
  label?: string;
  /** Current user's candidate-scoped manual delivery confirmation. Does not change validation.valid. */
  manualDeliveryConfirmation?: {
    confirmed: true;
    confirmedAt: string;
    confirmedBy: string;
  };
  title: string;
  body: string;
  tags: string[];
  comments: CommentThread[];
  commentDisclaimer?: string;
  /** Publisher-owned first comment text (Cref contract v1.1); absent means none was produced. */
  commentOwnedFirstComment?: string;
  /**
   * Plan-level projection of selected gap ids no thread/body covers (Cref v1.1).
   * Absent on historical packages means "not computed", not "nothing uncovered".
   */
  commentUncoveredGaps?: string[];
  imageBrief?: string;
  /** Legacy compatibility value; display only when bound to validationHeuristic. */
  score?: number;
  validationHeuristic?: ValidationReadinessHeuristic;
  diagnostics?: ContentDiagnostic[];
  sources?: Array<{ fileId?: string; name: string; detail?: string }>;
  unknowns?: string[];
  conflicts?: string[];
  validation?: {
    valid: boolean;
    repairAttempts: number;
    issues: Array<{ code?: string; severity: "error" | "warning"; channel?: string; message: string }>;
  };
  imagePlan?: ImagePlan;
  /** Optional for historical packages; absence must not be interpreted as execution. */
  productionArtifacts?: ProductionArtifacts;
  dialogueThreads?: DialogueThreadPlan[];
  gapCoverageLedger?: CommentGapCoverageLedger;
  targetThreadCount?: number;
  effectiveThreadCount?: number;
  capacityWarning?: string;
  deploymentPlan?: DeploymentPlan;
  orchestrationSnapshot?: OrchestrationSnapshot;
  coverageSignature?: CoverageSignature;
}

export interface ProjectIntelligence {
  id?: string;
  projectId: string;
  status: "missing" | "draft" | "stale" | "queued" | "analyzing" | "ready" | "failed" | "rejected";
  resourceStatus?: string;
  approvalStatus?: string;
  entity?: string;
  industry?: string;
  subdomains?: string[];
  categories?: Array<{ id: string; name: string; description?: string; gapCount?: number }>;
  knowledgeFingerprint?: string;
  analyzedAt?: string;
  staleReasons?: string[];
  error?: string;
  analysisJobId?: string;
  version?: number;
  map?: Record<string, unknown>;
}

export interface AnalysisTask {
  id: string;
  projectId: string;
  kind: "project" | "image";
  targetId: string | null;
  status: "queued" | "running" | "completed" | "failed";
  /** 后端一直在返回,前端类型此前漏了。知识库补充任务靠 `enrich:` 前缀区分。 */
  sourceFingerprint: string;
  attemptCount: number;
  /** 完整项目分析使用同一对话的多轮进度；其他任务不返回这些字段。 */
  currentTurn?: number;
  totalTurns?: number;
  turnKey?: string;
  turnLabel?: string;
  turnStatus?: "running" | "completed" | "failed";
  turnAttemptCount?: number;
  resultId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type ProjectBlueprintModuleKey =
  | "knowledge_map"
  | "domain_model"
  | "audience_model"
  | "scenario_model"
  | "role_model"
  | "claim_policy"
  | "surface_language";

export interface ProjectBlueprintModule {
  id: string;
  projectId: string;
  intelligenceId?: string;
  moduleKey: ProjectBlueprintModuleKey;
  version: number;
  status: "draft" | "approved" | "rejected" | "stale";
  contentRevision: string;
  sourceFingerprint?: string;
  data: Record<string, unknown>;
  updatedAt?: string;
  approvedAt?: string;
}

export interface InformationGap {
  id: string;
  projectId: string;
  label: string;
  question: string;
  description?: string;
  category: string;
  stages: string[];
  decisionTasks: string[];
  sourceType: "domain_inference" | "project_knowledge" | "image_observation" | "user" | "external_signal";
  evidenceStatus: string;
  answerability: "approved" | "verifiable" | "unknown";
  answer?: string;
  evidenceIds: string[];
  /** Singular answer boundary (Cref contract v1.1); stored at data_json top level. */
  boundary?: string;
  frameworks?: string[];
  boundaries?: string[];
  priority: number;
  enabled: boolean;
  locked: boolean;
  userEdited?: boolean;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  approvalStatus?: string;
  /** Review-priority heuristics (0..1). Null means unknown and blocks approval. */
  importance?: number | null;
  decisionLeverage?: number | null;
  proofability?: number | null;
  metricStatus?: "complete" | "unknown";
  unknownMetrics?: string[];
  reviewRequired?: boolean;
  /** Evidence-strength label the model assigns to this gap's estimates. */
  sourceStatus?: "supplied_fact" | "user_supplied" | "inference" | "hypothesis" | "unknown";
  knowledgeAction?: "organize_existing" | "ask_user" | "none";
  knowledgeReason?: string;
  framework?: string;
  preferredChannels?: string[];
  audienceStages?: string[];
}

export interface ExpressionStrategy {
  id: string;
  projectId: string;
  name: string;
  description: string;
  routePolicy: string;
  imagePolicy: string;
  titlePolicy: string;
  bodyPolicy: string;
  commentPolicy: string;
  deploymentPolicy: string;
  compatibleGapTypes: string[];
  incompatibleConditions: string[];
  randomizableDimensions: string[];
  weight: number;
  enabled: boolean;
  locked: boolean;
  source: "builtin" | "ai" | "user";
  evidenceStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  approvalStatus?: string;
  /** Core planner fields compiled from the natural-language policies. */
  label?: string;
  openingMode?: string;
  narrativeMode?: string;
  bodyRole?: string;
  imageRole?: "cover" | "evidence" | "scene" | "diagram" | "before_after" | "other";
  commentMode?: string;
  voice?: string;
  sequence?: string[];
  targetChannels?: string[];
  selectionWeight?: number;
  randomization?: { enabled: boolean; weight?: number };
  prototype?:
    | "narrow_request"
    | "live_moment"
    | "expectation_reversal"
    | "process_log"
    | "outcome_observation"
    | "retrospective_update"
    | "relationship_moment"
    | "option_comparison";
}

export interface TopicOpportunity {
  id: string;
  projectId: string;
  title: string;
  coreQuestion: string;
  summary: string;
  gapIds: string[];
  readerStages: string[];
  decisionTask: string;
  whyValuable: string;
  projectAngle?: string;
  answerability: "approved" | "verifiable" | "unknown";
  evidenceIds: string[];
  unknowns: string[];
  boundaries: string[];
  suggestedImageAssetIds: string[];
  /** Strategy explicitly referenced by the opportunity and required for approval. */
  strategyId?: string;
  compatibleStrategyIds: string[];
  coverageStatus?: "new" | "recent" | "cooldown";
  selected?: boolean;
  createdAt?: string;
  status?: string;
  angle?: string;
  rationale?: string;
  approvalStatus?: string;
  eligibilityStatus?: "eligible" | "blocked" | "unknown" | string;
  reviewRequired?: boolean;
  unknownMetrics?: string[];
  /**
   * Editable review-priority heuristics (0..1, null when unset). Uncalibrated,
   * non-causal ordering aids for human review — never facts or predictions.
   * All seven must be non-null before the opportunity can be approved.
   */
  relevance?: number | null;
  importance?: number | null;
  proofability?: number | null;
  decisionLeverage?: number | null;
  novelty?: number | null;
  cognitiveCost?: number | null;
  risk?: number | null;
  metricStatus?: "complete" | "unknown";
  audienceStage?: string;
  entry?: string;
  sourceStatus?: "supplied_fact" | "user_supplied" | "inference" | "hypothesis" | "unknown";
  /**
   * Explainable ordering snapshot returned by the server. This is an
   * uncalibrated product heuristic, not F28 and not a causal performance
   * estimate. Older APIs may omit the entire snapshot.
   */
  rank?: number | null;
  heuristic?: OpportunityRankHeuristicMetadata;
  components?: OpportunityRankComponent[];
  inputSources?: OpportunityRankInputSources;
  reviewReasons?: string[];
  effectiveEligibility?: "eligible" | "ineligible" | "review_required";
  unboundedBaseScore?: number | null;
  baseScore?: number | null;
  recentPenalty?: number | null;
  finalScore?: number | null;
  recentCoverage?: OpportunityRecentCoverage;
  scoreSemantics?: "ordinal_noncausal_heuristic" | string;
  policy?: OpportunityRankPolicySnapshot;
  reasons?: string[];
  legacyInputScore?: {
    value: number;
    used: false;
    semantics: "legacy_heuristic";
  };
  /** Historical pre-R11 value; never treat as a current comparable score. */
  score?: number;
  recommendedEntryPoint?: string;
  entryPoint?: string;
  city?: string;
  doctor?: string;
  mustInclude?: string | string[];
  forbidden?: string | string[];
  collectionStatus?: "active" | "collected" | "archived";
  batchId?: string | null;
}

export interface OpportunityBatch {
  id: string;
  projectId: string;
  trigger: string;
  userGuidance: string;
  temperature: number | null;
  opportunityCount: number;
  liveCount: number;
  createdAt: string;
}

export interface PromptTemplate {
  id: string;
  projectId: string;
  label: string;
  guidance: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpportunityRankHeuristicMetadata {
  id: "OpportunityRankHeuristicV1" | string;
  version: string;
  weights: Record<string, number>;
  criticalMetrics?: string[];
  weightsCalibrated: false;
  causal: false;
  notF28: true;
  scoreSemantics?: "ordinal_noncausal_heuristic";
  scoreRange?: readonly [0, 1];
}

export interface OpportunityRankComponent {
  metric: string;
  rawValue: number | null;
  transformedValue: number | null;
  transformation: "identity" | "one_minus" | string;
  weight: number;
  contribution: number | null;
  source: unknown;
}

export interface OpportunityRankInputSources {
  metrics?: Record<string, unknown>;
  status?: unknown;
  topic?: unknown;
  gapIds?: unknown;
  recentCoverage?: unknown;
  options?: unknown;
  [key: string]: unknown;
}

export interface OpportunityRecentCoverage {
  status: "provided" | "unknown";
  count: number | null;
  similarity: number | null;
  source: unknown;
}

export interface OpportunityRankPolicySnapshot {
  minProofability: number;
  maxRisk: number;
  recentPenaltyWeight: number;
  reuseCooldown: number;
}

export interface ImageAssetAnalysis {
  ocr: string[];
  visibleFacts: string[];
  scene?: string;
  imageType?: string;
  suggestedRoles: string[];
  safeClaims: string[];
  forbiddenInferences: string[];
  privacyFlags: string[];
  suitableGapIds: string[];
  approvedFields?: string[];
  /** Model-produced review-priority metrics (0–1). Read-only in the UI; there is no manual write endpoint yet. */
  quality?: { clarity: number | null; relevance: number | null; textLegibility: number | null };
  qualityStatus?: "complete" | "unknown";
  unknownQualityMetrics?: string[];
}

export interface ImageAsset {
  id: string;
  projectId: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  status: "uploaded" | "queued" | "analyzing" | "ready" | "failed";
  approved: boolean;
  analysis?: ImageAssetAnalysis;
  previewUrl?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  latestAnalysisId?: string;
  analysisStatus?: string;
  contentUrl?: string;
  approvalStatus?: string;
}

export type PlanningRandomizationDimension =
  | "strategy"
  | "opening"
  | "state_seed"
  | "narrative_sequence"
  | "channel_allocation"
  | "body_role"
  | "comment_topology"
  | "voice"
  | "image_role"
  | "gap_order";

export type GenerationStatus = "queued" | "running" | "completed" | "failed";
export type GenerationQualityStatus = "unknown" | "passed" | "needs_review";

export type ResearchReviewStatus = "draft" | "under_review" | "approved" | "deprecated" | "rejected";

export interface ResearchClaim {
  id: string;
  projectId: string;
  logicalKey: string;
  version: number;
  parentId?: string | null;
  title: string;
  statement: string;
  claimType: "definition" | "external_research" | "internal_observation" | "inference" | "hypothesis" | "unknown";
  status: ResearchReviewStatus;
  scope: string[];
  metadata: Record<string, unknown>;
  evidenceCount?: number;
  createdAt?: string;
  reviewedAt?: string | null;
}

export interface ResearchEvidenceSource {
  id: string;
  projectId: string;
  sourceKey: string;
  version: number;
  kind: string;
  citation: string;
  url?: string | null;
  supports: string;
  limitations: string;
  status: ResearchReviewStatus;
  metadata: Record<string, unknown>;
  claimCount?: number;
  createdAt?: string;
  reviewedAt?: string | null;
}

export interface ResearchDatasetSnapshot {
  id: string;
  projectId: string;
  datasetKey: string;
  version: number;
  label: string;
  kind: "internal_sample" | "experiment" | "live_observation" | "external";
  sha256: string;
  rowCount?: number | null;
  storageRef: string;
  provenance: string;
  limitations: string;
  schema: Record<string, unknown>;
  status: ResearchReviewStatus;
  createdAt?: string;
  approvedAt?: string | null;
}

export interface ResearchExperimentResult {
  id: string;
  experimentVersionId: string;
  version: number;
  datasetSnapshotId?: string | null;
  result: Record<string, unknown>;
  conclusion: "supports" | "contradicts" | "inconclusive" | "not_analyzed";
  status: "draft" | "under_review" | "approved" | "rejected";
  createdAt?: string;
  reviewedAt?: string | null;
}

export interface ResearchExperiment {
  id: string;
  projectId: string;
  experimentKey: string;
  version: number;
  title: string;
  hypothesis: string;
  design: Record<string, unknown>;
  metrics: unknown[];
  analysisPlan: Record<string, unknown>;
  status: "draft" | "preregistered" | "running" | "completed" | "replicated" | "rejected" | "archived";
  results: ResearchExperimentResult[];
  createdAt?: string;
  approvedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ResearchCalibrationProposal {
  id: string;
  projectId: string;
  targetType: "parameter" | "formula" | "prompt" | "policy";
  targetKey: string;
  current: Record<string, unknown>;
  proposed: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>;
  impact: Record<string, unknown>;
  status: "draft" | "under_review" | "approved" | "rejected" | "applied";
  appliedReleaseId?: string | null;
  createdAt?: string;
  reviewedAt?: string | null;
}

export interface ResearchReleaseManifest {
  id: string;
  projectId: string;
  version: string;
  parentId?: string | null;
  status: "draft" | "approved" | "rejected" | "active" | "archived";
  appVersion: string;
  buildId: string;
  formulaVersionId: string;
  formulaDigest: string;
  executionPolicyVersion: string;
  executionPolicyDigest: string;
  promptVersion: string;
  promptDigest: string;
  parameterPolicyVersion: string;
  parameterPolicyDigest: string;
  evidenceCatalogVersion: string;
  evidenceCatalogDigest: string;
  bindings: {
    datasetSnapshotIds: string[];
    experimentResultIds: string[];
    calibrationProposalIds: string[];
    source?: string;
  };
  notes: string;
  parameterOverrides?: Record<string, unknown>;
  researchInjectedIntoPrompt?: boolean;
  createdAt?: string;
  approvedAt?: string | null;
  activatedAt?: string | null;
}

export interface ResearchOverview {
  projectId: string;
  isolationPolicy: {
    researchInjectedIntoPrompt: false;
    experimentsAutoApply: false;
    calibrationRequiresApproval: true;
    runtimeChangesRequireActiveRelease: true;
  };
  catalog: { version: string; digest: string; sourcePath: string };
  counts: {
    claims: number;
    evidenceSources: number;
    datasets: number;
    experiments: number;
    experimentResults: number;
    calibrationProposals: number;
    releases: number;
  };
  activeRelease?: ResearchReleaseManifest;
  claims: ResearchClaim[];
  evidenceSources: ResearchEvidenceSource[];
  datasets: ResearchDatasetSnapshot[];
  experiments: ResearchExperiment[];
  calibrationProposals: ResearchCalibrationProposal[];
  releases: ResearchReleaseManifest[];
}

/**
 * 一次修改任务(revise)。异步化后它与 job 分离:job.status 在改稿期间保持
 * completed(前端多处按它判定能否查看产出),「有没有在改」由这个对象回答。
 */
export interface RevisionTask {
  id: string;
  jobId: string;
  candidateId: string;
  instruction: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  attemptCount: number;
  /** 后端已写成中文用户文案,直接显示,不要二次加工 */
  error: string | null;
  /** 实际重跑的通道,如 ["N.body","Cref"];用于完成提示 */
  rerunChannels: string[];
  resultPackageId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GenerationJob {
  id: string;
  projectId: string;
  projectName?: string;
  topic: string;
  goal?: string;
  mode: "simple" | "advanced";
  status: GenerationStatus;
  qualityStatus?: GenerationQualityStatus;
  progress?: number;
  /** Batch this job belongs to; absent for single generations. */
  batchId?: string;
  /** 1-based position in the server's in-memory queue; absent once running. */
  queuePosition?: number;
  /** Total jobs currently queued server-wide, for "第 N/M 位". */
  queueLength?: number;
  candidates?: Candidate[];
  /**
   * 最近一次修改任务。进行中时前端显示进度;终态时用于显示「上次修改完成/失败」。
   *
   * 名字名不副实:后端在没有活跃任务时会回落成「最近一条」,终态任务也从这个键
   * 返回。所以有值 ≠ 正在改,必须看 status(用 isRevisionInFlight)。
   * 另外 job.status 在改稿期间仍是 completed——不要用它判断有没有在改。
   */
  activeRevision?: RevisionTask;
  seed?: string;
  formulaVersion?: string;
  createdAt?: string;
  completedAt?: string;
  error?: string;
  presetId?: string;
  resolvedConfig?: Record<string, unknown>;
  configPreview?: ResolvedConfigPreview;
  impactReport?: ParameterImpact[] | GenerationImpactReport;
  parameterImpactReport?: GenerationImpactReport;
  diagnosticProxies?: DiagnosticProxySnapshot[];
  impacts?: ParameterImpact[];
  impactPreview?: ParameterImpact[];
  /** Frozen selected-opportunity context; historical jobs may not have it. */
  opportunitySnapshot?: Partial<TopicOpportunity> & {
    opportunitySelectionAudit?: OpportunitySelectionAudit;
  } & Record<string, unknown>;
  opportunitySelectionAudit?: OpportunitySelectionAudit;
  /** Frozen runtime contract used for this generation. */
  releaseManifestId?: string;
  researchSnapshot?: Partial<ResearchReleaseManifest> & {
    source?: string;
    parameterOverrides?: Record<string, unknown>;
    researchInjectedIntoPrompt?: boolean;
  };
}

export type AgentHarnessStatus = "queued" | "running" | "completed" | "failed";

export interface AgentHarnessValidationIssue {
  code: string;
  severity: "error" | "warning";
  candidateIndex: number;
  message: string;
}

export interface AgentHarnessCandidate {
  id: string;
  candidateIndex: 0 | 1 | 2;
  concept: string;
  marketingStrategy?: {
    narrativePath?: "tension_first" | "observation_first" | "question_first";
    readerDesire: string;
    hiddenTension: string;
    oldJudgment: string;
    newJudgment: string;
    projectBridge: string;
    lowPressureNextStep: string;
    tensionAnchor: string;
    reframeAnchor: string;
    projectBridgeAnchor: string;
    openLoopAnchor: string;
  };
  content: {
    H: { hashtags: string[] };
    N: {
      coverHeadline: string;
      coverSubheadline: string;
      imageBrief: string;
      imageSequence: Array<{
        sequence: number;
        source: "selected_asset" | "new_design";
        assetId: string;
        role: string;
        overlayText: string;
        direction: string;
        evidenceIds: string[];
      }>;
      title: string;
      body: string;
      callToAction: string;
    };
    Cref: {
      // disclaimer 不再是交付字段:模拟标注由 HARNESS_SIMULATION_NOTICE 常量提供,
      // 界面与导出固定携带,不再混进用户要粘贴到评论区的内容里。
      ownedFirstComment: string;
      threads: Array<{
        id: string;
        threadKind?: "org_answer" | "reader_exchange" | "organic_reaction";
        displayName?: string;
        replyDisplayName?: string;
        question: string;
        answer: string;
        followUps: Array<{ kind?: "follow_up" | "counterexample"; question: string; answer: string }>;
        clarification?: string;
        nextStep?: string;
        stopReason?: "answered" | "no_new_gap" | "evidence_boundary" | "professional_review";
        postingIdentity: "author" | "brand" | "staff" | "expert" | "publisher";
        evidenceIds: string[];
        boundary?: string;
      }>;
    };
    publishing: {
      entryPoint: string;
      accountIdentity: string;
      timingNote: string;
      interactionGoal: string;
      responseSla?: string;
      liveQuestionRoutes?: Array<{ when: string; owner: "publisher" | "staff" | "expert"; action: string }>;
      updateTriggers?: string[];
      stopRules?: string[];
    };
  };
  assetDecisions: Array<{
    assetId: string;
    decision: "use" | "omit";
    rationale: string;
    evidenceIds: string[];
  }>;
  citations: Array<{ statement: string; evidenceIds: string[] }>;
  claimAudit?: Array<{
    candidateIndex: 0 | 1 | 2;
    statement: string;
    evidenceIds: string[];
    classification: "project_fact" | "general_guidance" | "unknown_or_hedged";
  }>;
  unknowns: string[];
  selfReview: string;
  revisionNotes: { instructionApplied: string[]; preservedElements: string[] };
  publicationChecklist: Array<{
    key: "soft_marketing" | "evidence" | "simulation_disclosure" | "execution_plan" | "asset_authorization" | "platform_compliance" | "final_proofread";
    status: "ready" | "blocked" | "manual_review";
    note: string;
  }>;
  validation: { valid: boolean; issues: AgentHarnessValidationIssue[] };
}

export interface AgentHarnessTrace {
  sequence: number;
  action: "search_knowledge" | "read_evidence" | "submit_candidates";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  summary: string;
  createdAt?: string;
}

export interface AgentHarnessJob {
  id: string;
  projectId: string;
  channel: "agent_harness";
  status: AgentHarnessStatus;
  progress: number;
  topic: string;
  goal: string;
  runKind: "original" | "retry" | "revision";
  parentJobId?: string | null;
  sourceCandidateId?: string | null;
  instruction?: string;
  error?: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  deletedAt?: string | null;
  failureStage?: string;
  reviewStatus?: "pending" | "running" | "completed" | "blocked";
  reviewError?: string;
  reviewAttemptCount?: number;
  candidateCheckpointAt?: string | null;
  queuePosition?: number;
  queueLength?: number;
  cancelledAt?: string | null;
  selectedCandidateId?: string | null;
  approvalStatus?: "draft" | "selected" | "approved";
  approvalNotes?: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvedContentHash?: string;
  purgeAfter?: string | null;
  parentDeleted?: boolean;
  task?: Record<string, unknown>;
  runtimeSnapshot?: Record<string, unknown>;
  projectSnapshot?: Record<string, unknown>;
  providerSnapshot?: Record<string, unknown>;
  evidenceInventory?: Array<{
    evidenceId: string;
    path: string;
    heading: string;
    kind: string;
    evidenceStatus: string;
    caveats: string[];
  }>;
  decisionSummary?: string;
  reviewSummary?: string;
  claimAuditSummary?: string;
  imageSnapshot?: Array<{
    assetId: string;
    evidenceId: string;
    filename: string;
    mediaType: string;
    width?: number;
    height?: number;
    analysisId: string;
    approvedAt?: string;
  }>;
  usage?: { modelCalls?: number; inputTokens?: number; outputTokens?: number; toolCalls?: number; replans?: number };
  partialUsage?: { modelCalls?: number; inputTokens?: number; outputTokens?: number };
  candidates?: AgentHarnessCandidate[];
  traces?: AgentHarnessTrace[];
  derivedRuns?: AgentHarnessJob[];
}

export interface AgentHarnessCreateInput {
  projectId: string;
  topic?: string;
  topicMode?: "agent_discovery" | "user_defined";
  creativeIntent?: string;
  methodProfileId?: import("@content-agent/agent-harness-core/methods").HarnessMethodId;
  audienceStage?: string;
  goal?: string;
  audience?: string;
  entryPoint?: string;
  tone?: string;
  bodyLength?: "short" | "medium" | "long";
  accountIdentity?: string;
  callToAction?: string;
  publishingNotes?: string;
  mustInclude?: string[];
  forbidden?: string[];
  notes?: string;
  imageAssetIds?: string[];
  allowUngrounded?: boolean;
  /**
   * 素人代发种草模式。不传时由后端落 DEFAULT_HARNESS_SEEDING_MODE —— 前端不编第二份
   * 默认值,否则后端改默认时两边会悄悄分叉。
   */
  seedingMode?: import("@content-agent/agent-harness-core/methods").HarnessSeedingMode;
}

export interface AgentHarnessCapabilities {
  projectId: string;
  canRun: boolean;
  canRevise: boolean;
  canEdit: boolean;
  canExport: boolean;
}

export type GenerationBatchStatus = "queued" | "running" | "completed" | "failed" | "partial";

export interface GenerationBatch {
  id: string;
  projectId: string;
  name: string;
  status: GenerationBatchStatus;
  totalJobs: number;
  createdAt?: string;
  completedAt?: string;
  jobs: GenerationJob[];
}

export interface OpportunitySelectionAudit {
  selectedOpportunityId?: string;
  selectionMode: "explicit_locked" | "heuristic_ranked" | "default_policy" | "revision_inherited" | string;
  rankStatus: "not_applied" | "applied" | string;
  approvalBasis?: string;
  rankNotAppliedReason?: string;
  selectedOpportunityRank?: (Partial<TopicOpportunity> & {
    opportunity?: Partial<TopicOpportunity>;
  });
}

export interface GenerateInput {
  projectId: string;
  mode: "simple" | "advanced";
  topic?: string;
  goal?: string;
  opportunityId?: string;
  imageAssetIds?: string[];
  lockedGapIds?: string[];
  lockedStrategyId?: string;
  locks?: { gapIds?: string[]; strategyId?: string };
  randomizationDimensions?: PlanningRandomizationDimension[];
  randomization?: {
    dimensions?: PlanningRandomizationDimension[];
    randomizationDimensions?: PlanningRandomizationDimension[];
    variationStrength?: number;
    reuseCooldown?: number;
  };
  audienceStage: string;
  entryPoint: string;
  city?: string;
  doctor?: string;
  mustInclude?: string;
  forbidden?: string;
  /** Frozen account topology for this generation job. */
  publishingTopology?: "creative_scenario" | "institution_owned" | "confirmed_individual_author";
  /** New requests submit atomic drafts; the server supplies confirmation identity and time. */
  authorFacts?: Array<{
    id: string;
    statement: string;
    category: "current_state" | "intent" | "constraint" | "project_contact" | "purchase" | "service_completion" | "recovery" | "outcome";
  }>;
  authorFactsConfirmed?: boolean;
  /** Legacy/expert request shape and resolved snapshot shape. */
  authorContext?: {
    status: "not_provided" | "confirmed";
    facts: Array<{
      id: string;
      statement: string;
      category: "current_state" | "intent" | "constraint" | "project_contact" | "purchase" | "service_completion" | "recovery" | "outcome";
      confirmedBy: string;
      confirmedAt: string;
      confirmationId?: string;
    }>;
  };
  config?: AdvancedGenerationConfig;
  presetId?: string;
  overrides?: Record<string, unknown>;
}

export interface AdvancedGenerationConfig {
  knowledgeScope: string;
  informationBreadth: number;
  informationDepth: number;
  expressionFreedom: number;
  vigilanceLevel: number;
  bodyLength: number;
  commentThreads: number;
  tone: string;
  titleStyle: string;
  formulaVersion?: string;
  model?: string;
  temperature: number;
  repairRounds: number;
  evidenceMode: "strict" | "balanced" | "creative";
  overrides?: Record<string, unknown>;
}

export type ParameterControl = 'slider' | 'select' | 'toggle' | 'text' | 'list' | 'text_list' | 'multi_select' | 'number';

export interface ParameterOption {
  label: string;
  value: string | number | boolean;
  description?: string;
}

export interface GenerationParameterDefinition {
  id: string;
  path: string;
  label: string;
  shortLabel?: string;
  group: string;
  control: ParameterControl;
  description: string;
  noviceExplanation: string;
  formulaIds: string[];
  equation?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue: unknown;
  options?: ParameterOption[];
  increaseEffect?: string;
  decreaseEffect?: string;
  risk?: string;
  recommendedRange?: [number, number];
  advancedOnly?: boolean;
  simpleMode?: boolean;
  evidenceStatus?: string;
  evidenceNote?: string;
  channels?: string[];
}

export interface GenerationParameterSchema {
  schemaVersion: string;
  groups: Array<{ id: string; label: string; description?: string }>;
  parameters: GenerationParameterDefinition[];
  formulas?: FormulaDefinition[];
  formulaVersion?: FormulaVersion;
}

export interface ContentPreset {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  source: 'built-in' | 'project';
  isDefault?: boolean;
  /** Canonical shape is a direct parameterId -> value map. Legacy nested values are normalized at the UI boundary. */
  values: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigConflict {
  id?: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  paths?: string[];
  suggestion?: string;
}

export interface ParameterImpact {
  parameterId: string;
  label: string;
  value: unknown;
  direction?: 'higher' | 'lower' | 'changed' | 'default';
  summary: string;
  affects?: string[];
  risk?: string;
}

export interface GenerationImpactReport {
  schemaVersion?: string;
  parameterTraces?: Array<{
    parameterId: string;
    path?: string;
    label: string;
    value: unknown;
    source?: { source?: string; sourceId?: string } | string;
    behaviorInstructions?: string[];
    formulaIds?: string[];
    channels?: string[];
    evidenceStatus?: string;
    evidenceNote?: string;
  }>;
  behaviorInstructions?: string[];
  formulaResults?: Array<{
    formulaId: string;
    title?: string;
    value?: unknown;
    unknownPaths?: string[];
    warnings?: string[];
    evidenceStatus?: string;
    interpretation?: string;
    calculatorContract?: FormulaCalculatorContract;
  }>;
  diagnosticProxies?: DiagnosticProxySnapshot[];
  channelAllocation?: Record<string, {
    channel?: string;
    purpose?: string;
    information?: Array<{ information?: string; reason?: string; critical?: boolean; formulaIds?: string[] }>;
    constraints?: string[];
  }>;
  advisoryAllocationPreview?: Record<string, {
    channel?: string;
    purpose?: string;
    information?: Array<{ information?: string; reason?: string; critical?: boolean; formulaIds?: string[] }>;
    constraints?: string[];
  }>;
  warnings?: string[];
}

export interface AuthorFactOrganizationResult {
  sourceText: string;
  facts: Array<{
    id: string;
    statement: string;
    sourceQuote: string;
    category: NonNullable<GenerateInput["authorFacts"]>[number]["category"];
    needsReview: boolean;
    reviewReason?: string;
  }>;
  warnings: string[];
}

export interface ResolvedConfigPreview {
  resolvedConfig: Record<string, unknown>;
  conflicts: ConfigConflict[];
  warnings?: ConfigConflict[];
  impacts: ParameterImpact[];
  formulaVersion?: string;
  knowledgeMode?: string;
  knowledgeFiles?: number;
  estimatedInputTokens?: number;
}

export interface StyleProfile {
  projectId: string;
  preferredTone?: string;
  preferredStructures?: string[];
  avoidedPatterns?: string[];
  examples?: string[];
  updatedAt?: string;
}

export interface AppSettings {
  providerMode: "platform" | "byok";
  provider?: string;
  model: string;
  apiBaseUrl?: string;
  transport?: "responses" | "chat_completions";
  hasApiKey?: boolean;
  monthlyQuota: number;
  quotaUsed: number;
  defaultTemperature?: number;
  generationDefaults?: Record<string, unknown>;
}

export interface ApiList<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

export interface SystemUser {
  id: string;
  username: string;
  systemRole: "admin" | "user";
  mustChangePassword: boolean;
  createdAt?: string;
  disabledAt?: string | null;
}

export interface RegistrationRequest {
  id: string;
  username: string;
  organizationName: string;
  phone: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  username: string;
  role: "Owner" | "Admin" | "KnowledgeEditor" | "ContentEditor" | "Viewer";
  grants: string[];
  denies: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AuditEntry {
  id: number;
  username?: string;
  action: string;
  entityType: string;
  entityId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceApiKey {
  id: string;
  name: string;
  prefix: string;
  key?: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}
