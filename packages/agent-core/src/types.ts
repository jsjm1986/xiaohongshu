/** Public domain types shared by the API, worker and web applications. */

export type KnowledgeKind =
  | "fact"
  | "case"
  | "user_view"
  | "methodology"
  | "inference"
  | "hypothesis"
  | "unknown"
  | "prohibited";

export type EvidenceStatus = "observed" | "user_supplied" | "inferred" | "unknown";

/** Frozen account topology for one traditional-generation job. */
export type PublishingTopology = "creative_scenario" | "institution_owned" | "confirmed_individual_author";

export type ConfirmedAuthorFactCategory =
  | "current_state"
  | "intent"
  | "constraint"
  | "project_contact"
  | "purchase"
  | "service_completion"
  | "recovery"
  | "outcome";

export interface ConfirmedAuthorFact {
  id: string;
  statement: string;
  category: ConfirmedAuthorFactCategory;
  confirmedBy: string;
  confirmedAt: string;
  /** Server-issued confirmation record for this frozen job snapshot. */
  confirmationId?: string;
}

export interface AuthorContext {
  status: "not_provided" | "confirmed";
  facts: ConfirmedAuthorFact[];
}

export interface KnowledgeSourceInput {
  id?: string;
  projectId: string;
  path: string;
  content: string;
  version?: string;
  importedAt?: string;
  metadata?: Partial<KnowledgeMetadata>;
}

export interface KnowledgeMetadata {
  title: string;
  kind: KnowledgeKind;
  evidenceStatus: EvidenceStatus;
  keywords: string[];
  scope: string[];
  caveats: string[];
  sourceRole?: string;
}

export interface KnowledgeHeading {
  level: number;
  title: string;
  line: number;
}

export interface KnowledgeDocument {
  id: string;
  projectId: string;
  path: string;
  extension: ".md" | ".txt";
  content: string;
  version: string;
  importedAt?: string;
  checksum: string;
  charLength: number;
  byteLength: number;
  estimatedTokens: number;
  headings: KnowledgeHeading[];
  metadata: KnowledgeMetadata;
  isIndex: boolean;
}

export interface KnowledgeSection {
  id: string;
  documentId: string;
  path: string;
  heading?: string;
  content: string;
  estimatedTokens: number;
  score: number;
  truncated: boolean;
}

export interface ContextBudget {
  maxInputTokens: number;
  systemPromptTokens: number;
  formulaPromptTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens?: number;
}

export interface KnowledgeContextSelection {
  mode: "empty" | "full" | "progressive";
  content: string;
  sections: KnowledgeSection[];
  selectedDocumentIds: string[];
  omittedDocumentIds: string[];
  estimatedTokens: number;
  availableTokens: number;
  generatedIndex: boolean;
  warnings: string[];
}

export interface EvidenceReference {
  id: string;
  documentId: string;
  path: string;
  section?: string;
  /** First cited span retained for v1 readers. Prefer quotedSpans when present. */
  quote?: string;
  /** Every exact span cited from this immutable evidence snapshot. */
  quotedSpans?: string[];
  documentChecksum?: string;
  documentVersion?: string;
  sectionChecksum?: string;
  assetId?: string;
  kind: KnowledgeKind;
  evidenceStatus: EvidenceStatus;
  scope: string[];
  caveats: string[];
}

export interface KnowledgeClaim {
  id: string;
  key: string;
  value: string | number | boolean | null;
  statement: string;
  kind: KnowledgeKind;
  evidenceStatus: EvidenceStatus;
  sourceIds: string[];
  scope: string[];
  caveats: string[];
}

export interface KnowledgeConflict {
  id: string;
  key: string;
  claimIds: string[];
  alternatives: Array<{ value: KnowledgeClaim["value"]; claimIds: string[] }>;
  status: "unresolved" | "resolved";
  resolution?: string;
}

export interface UnknownItem {
  id: string;
  key: string;
  question: string;
  reason: string;
  resolution?: string;
  impact: "low" | "medium" | "high";
  requiredFor: string[];
}

export interface KnowledgeLedger {
  claims: KnowledgeClaim[];
  conflicts: KnowledgeConflict[];
  unknowns: UnknownItem[];
  prohibited: KnowledgeClaim[];
}

export type FormulaPrimitive = string | number | boolean | null;

export type FormulaExpression =
  | { op: "literal"; value: FormulaPrimitive }
  | { op: "var"; path: string }
  | { op: "not" | "negate"; arg: FormulaExpression }
  | {
      op:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "min"
        | "max"
        | "and"
        | "or"
        | "eq"
        | "ne"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "concat";
      args: FormulaExpression[];
    }
  | { op: "clamp"; value: FormulaExpression; min: FormulaExpression; max: FormulaExpression }
  | {
      op: "if";
      condition: FormulaExpression;
      then: FormulaExpression;
      else: FormulaExpression;
    }
  | { op: "coalesce"; args: FormulaExpression[] };

export type FormulaType = "architecture" | "normative" | "hypothesis" | "proxy" | "validation";
export type FormulaEvidenceStatus = "definition" | "unvalidated" | "bounded" | "unknown";
export type FormulaStringFormat = "trend_source_ref" | "rfc3339_timestamp";

export interface FormulaVariableDefinition {
  path: string;
  description: string;
  valueType: "number" | "string" | "boolean";
  required: boolean;
  /** Inclusive numeric bounds enforced by the reviewed calculator input contract. */
  minimum?: number;
  maximum?: number;
  /** Path to the explicit unit label attached to this numeric input. */
  unitPath?: string;
  /** Inputs in the same non-empty group must declare one identical unit. */
  unitGroup?: string;
  /** Optional reviewed enum for manual calculator inputs; values are never coerced. */
  allowedValues?: FormulaPrimitive[];
  /** Reject an explicitly supplied empty or whitespace-only string. */
  nonEmpty?: boolean;
  /** Reviewed string syntax/semantic-shape validator; included in the formula semantic fingerprint. */
  format?: FormulaStringFormat;
}

export type FormulaCalculationConsumer = "generation" | "planning" | "selection" | "validation";

export interface FormulaExcludedResearchOutput {
  metric: string;
  protocolId: string;
  status: "not_executed";
  outputProduced: false;
  notProducedByCalculator: true;
  reason: string;
  requiredObservations: string[];
}

export interface FormulaCalculatorContract {
  mode: "manual_scenario";
  outputMetric: string;
  outputSemantics: "unvalidated_scenario_index";
  outputRange?: [number, number];
  consumedBy: Record<FormulaCalculationConsumer, false>;
  prohibitedUses: FormulaCalculationConsumer[];
  excludedResearchOutputs: FormulaExcludedResearchOutput[];
  boundaries: string[];
}

export type DiagnosticProxyFormulaId = "F32" | "F33";
export type DiagnosticProxySemantics = "ordered_component_review_metadata";
export type DiagnosticProxyEvaluationStatus = "not_evaluated";

export interface FormulaDiagnosticComponentContract {
  id: BodyDiagnosticDimension | CommentDiagnosticDimension;
  label: string;
  direction: "positive" | "cost" | "risk";
  evidenceStatus: "unvalidated_proxy";
  sourceRequirement: "calibrated_component_observation";
  boundary: string;
}

/**
 * Reviewed contract for F32/F33. It deliberately defines ordering metadata,
 * not a numeric diagnostic, threshold, aggregate score, or drafting target.
 */
export interface FormulaDiagnosticContract {
  mode: "display_priority_metadata";
  semantics: DiagnosticProxySemantics;
  aggregation: "components_only";
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  aggregateStatus: "unknown";
  aggregateValue: null;
  scoreProduced: false;
  missingDataPolicy: "unknown_not_zero";
  emphasis: {
    range: [0, 100];
    semantics: "display_and_manual_review_priority_only";
    affects: ["display_order", "manual_review_priority"];
    doesNotAffect: [
      "component_value",
      "component_status",
      "threshold",
      "diagnostic_conclusion",
      "generation",
      "planning",
      "selection",
      "validation",
    ];
    tieBreak: "canonical_component_order";
  };
  consumedBy: Record<FormulaCalculationConsumer, false>;
  componentDefinitions: FormulaDiagnosticComponentContract[];
  boundaries: string[];
}

export interface FormulaDefinition {
  id: `F${string}`;
  title: string;
  type: FormulaType;
  evidenceStatus: FormulaEvidenceStatus;
  equation: string;
  plainLanguage: string;
  purpose: string;
  variables: FormulaVariableDefinition[];
  expression?: FormulaExpression;
  calculatorContract?: FormulaCalculatorContract;
  diagnosticContract?: FormulaDiagnosticContract;
}

export interface FormulaVersion {
  id: string;
  projectId?: string;
  version: string;
  parentId?: string;
  status: "draft" | "active" | "archived";
  createdAt: string;
  formulas: FormulaDefinition[];
  digest: string;
}

export interface FormulaEvaluationResult {
  value: FormulaPrimitive;
  unknownPaths: string[];
  warnings: string[];
  calculatorContract?: FormulaCalculatorContract;
}

export interface DslValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ProjectDoctor {
  id?: string;
  name: string;
  points: string[];
}

export type BodyDiagnosticDimension =
  | "stateMatch"
  | "stageClarity"
  | "sceneDiagnosticity"
  | "traceCredibility"
  | "visualAnchoring"
  | "gapClarity"
  | "directInformation"
  | "cognitiveCost"
  | "adSuspicion"
  | "logicError";

export type CommentDiagnosticDimension =
  | "gapCoverage"
  | "incrementalInformation"
  | "questionFit"
  | "answerGrounding"
  | "liveness"
  | "routeClarity"
  | "conditionalClarity"
  | "cognitiveCost"
  | "contradiction"
  | "overMarketing";

export interface GenerationMethodParameters {
  informationBreadth: number;
  decisionInformationDepth: number;
  stateInformationStrength: number;
  experienceInformationStrength: number;
  bodyCompleteness: number;
  commentExpansion: number;
  commentConditionality: number;
  commentRoleDiversity: number;
  commentConstraintDensity: number;
  commentGapMultiplexing: number;
  commentReplyIncrement: number;
  questionCompression: number;
  /** Amount of sample-attested platform vernacular allowed in visible comments. */
  commentPlatformRegister: number;
  /** Share of root comments expected to grow into a second or third conversational turn. */
  commentConversationRate: number;
  /** Strength of a causally triggered adjacent information branch inside multi-turn threads. */
  commentBranchingStrength: number;
  /** Permission for asymmetric reactions, disagreement and lightly unresolved social nodes. */
  commentOrganicVariation: number;
  commentDiscoveryStrength: number;
  commentInferenceEffort: number;
  commentSelfVerification: number;
  commentFalseClosureGuard: number;
  redundancyTolerance: number;
  evidenceStrictness: number;
  boundaryVisibility: number;
  routeSpecificity: number;
  noveltyAngle: number;
  questionNaturalness: number;
  titleTargetChars: number;
  paragraphTarget: number;
  bodyDiagnosticEmphasis: Record<BodyDiagnosticDimension, number>;
  commentDiagnosticEmphasis: Record<CommentDiagnosticDimension, number>;
}

export interface ResolvedGenerationConfig {
  schemaVersion: "1.0";
  project: {
    id: string;
    name: string;
    domain: string;
    productPoints: string[];
    organizationPoints: string[];
    cities: string[];
    doctors: ProjectDoctor[];
  };
  task: {
    theme: string;
    goal: string;
    audienceStage: "discovering" | "collecting" | "comparing" | "hesitating" | "ready";
    entry: "search" | "recommendation" | "profile" | "return_visit";
    city?: string;
    doctor?: string;
    /** Facts the user explicitly says the reader knew before seeing this content. */
    preContactKnown: string[];
    /** Omitted means the reader's prior content/search history is unknown. */
    readerHistory?: string[];
    /** Reader-side constraints supplied for this scenario, not project rules. */
    readerConstraints: string[];
    /** Frozen per-job publishing topology. Omitted configs resolve to creative_scenario. */
    publishingTopology: PublishingTopology;
    /** Human-confirmed author facts. Project knowledge and scenario hypotheses never populate this. */
    authorContext: AuthorContext;
    mustMention: string[];
    forbidden: string[];
  };
  knowledge: {
    mode: "auto" | "full" | "progressive";
    selectedFileIds: string[];
    excludedFileIds: string[];
    maxInputTokens: number;
    outputReserveTokens: number;
    safetyMarginTokens: number;
  };
  informationWindow: {
    gaps: string[];
    answers: string[];
    evidenceRequirements: string[];
    reusableFrameworks: string[];
    priorities: string[];
    boundaries: string[];
  };
  expressionWindow: {
    channels: Array<"hashtags" | "image" | "title" | "body" | "comments">;
    forms: string[];
    voice: string;
    sequence: string[];
    threadStyle: string;
  };
  content: {
    bodyMinChars: number;
    bodyMaxChars: number;
    hashtagMin: number;
    hashtagMax: number;
    commentThreadMin: number;
    commentThreadMax: number;
    followUpDepth: number;
    /**
     * Feature switch for the extra multi-turn comment growth pass (stage 2B).
     * Conservative default: when omitted or false, stage 2B (the additional LLM
     * growth call) is skipped and the root comments are used directly, which is
     * still a valid output. Set to true to opt in; growth then additionally
     * requires followUpDepth > 0 and commentConversationRate > 0.
     */
    commentMultiTurnGrowthEnabled?: boolean;
    imageBriefEnabled: boolean;
  };
  formula: {
    versionId: string;
    enabledFormulaIds: string[];
    variables: Record<string, FormulaPrimitive>;
  };
  model: {
    model?: string;
    temperature: number;
    maxOutputTokens: number;
  };
  generation: {
    candidateCount: 3;
    baseSeed: number;
    maxRepairAttempts: 0 | 1 | 2;
  };
  diagnostics: {
    requireEvidenceReferences: boolean;
    rejectUnknownAsFact: boolean;
    rejectProhibitedClaims: boolean;
    warnDuplicateInformation: boolean;
  };
  /** Optional for backward compatibility. Missing values compile from documented defaults. */
  parameters?: GenerationMethodParameters;
}

export type ParameterValue = string | number | boolean | string[];
export type ParameterControlKind = "slider" | "number" | "toggle" | "select" | "multi_select" | "text" | "text_list";
export type ParameterEvidenceStatus =
  | "architecture_definition"
  | "normative_boundary"
  | "sample_observation"
  | "hypothesis"
  | "unvalidated_proxy"
  | "operational_default"
  | "user_choice";

export interface ParameterControlOption {
  value: string | number | boolean;
  label: string;
  description: string;
}

export interface ParameterControlMetadata {
  kind: ParameterControlKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  options?: ParameterControlOption[];
  simpleMode: boolean;
  advanced: boolean;
}

export interface GenerationParameterDefinition {
  id: string;
  path: string;
  label: string;
  group: "reader" | "information" | "expression" | "channel" | "evidence" | "diagnostic" | "operation";
  control: ParameterControlMetadata;
  defaultValue: ParameterValue;
  noviceExplanation: string;
  increaseEffect: string;
  decreaseEffect: string;
  changeEffect?: string;
  formulaIds: Array<`F${string}`>;
  channels: ContentChannel[];
  /**
   * 评论生成阶段归属(单一真源):仅对 channels 含 "Cref" 的参数有意义。
   * reader=只注入读者提问侧(2A-R);answer=只注入机构答复侧(2A-O/2B-O);
   * both=两侧都注入。缺省表示该参数不参与评论侧的分阶段行为注入。
   * 注入的只是 behaviorInstructions 纯写作文本,绝不携带角色身份/口径信息。
   */
  commentStage?: "reader" | "answer" | "both";
  evidenceStatus: ParameterEvidenceStatus;
  evidenceNote: string;
  /**
   * 开启/调高该参数的**运行成本与副作用告知**,供 UI 醒目提示(不是风险等级,
   * riskFor 已由 evidenceStatus 承担)。只给确实会改变生成开销或产出容量的参数,
   * 让用户在勾选前就看到代价,而不是事后从耗时里猜。
   */
  costNotice?: {
    /** 一句话结论,UI 标题位。 */
    headline: string;
    /** 额外模型调用的阶段说明(没有额外调用则省略)。 */
    extraModelCalls?: string;
    /** 实测耗时影响;必须写明是实测还是估算。 */
    measuredImpact?: string;
    /** 该开关生效还依赖哪些前置条件——不满足时它不起作用。 */
    dependsOn?: string[];
  };
  /**
   * 该参数在系统里的**执行强度**——与 evidenceStatus 是两个正交维度。
   * evidenceStatus 说的是"改这个值的风险有多高"(riskFor 据此给 low/medium/high),
   * enforcement 说的是"系统靠什么让这个值生效":
   *
   *  - `validated`  值经确定性推导进入产物,且有校验层检查违反(违反可进 repair)。
   *  - `derived`    值经确定性推导改变产物结构,但没有校验层复核结果。
   *  - `guidance`   值只编译成一句提示词交给模型,系统不做任何结构性保证。
   *  - `display`    值只影响人工检查清单的展示顺序,不进模型也不进校验。
   *
   * 缺省按 `guidance` 理解(最弱假设);历史快照无此字段仍可读。
   */
  enforcement?: "validated" | "derived" | "guidance" | "display";
}

export interface BuiltInGenerationPreset {
  id: string;
  label: string;
  description: string;
  noviceExplanation: string;
  parameterValues: Record<string, ParameterValue>;
  behaviorInstructions: string[];
  evidenceStatus: ParameterEvidenceStatus;
}

export interface BuiltInStyleProfile {
  id: string;
  label: string;
  description: string;
  noviceExplanation: string;
  parameterValues: Record<string, ParameterValue>;
  behaviorInstructions: string[];
  evidenceStatus: ParameterEvidenceStatus;
  safetyBoundary: string;
}

export interface GenerationParameterSelection {
  presetId?: string;
  styleProfileId?: string;
  overrides?: Record<string, ParameterValue>;
}

export interface ParameterValueSource {
  source: "default" | "config" | "preset" | "style_profile" | "override";
  sourceId?: string;
}

export interface ParameterResolutionSnapshot {
  schemaVersion: "1.0";
  presetId?: string;
  styleProfileId?: string;
  values: Record<string, ParameterValue>;
  sourceByParameter: Record<string, ParameterValueSource>;
}

export interface ParameterImpactTrace {
  parameterId: string;
  path: string;
  label: string;
  value: ParameterValue;
  source: ParameterValueSource;
  behaviorInstructions: string[];
  formulaIds: Array<`F${string}`>;
  channels: ContentChannel[];
  evidenceStatus: ParameterEvidenceStatus;
  evidenceNote: string;
  /**
   * 当前配置下该参数值**不影响产出**的确定性原因(中文一句)。
   *
   * 只在能从 config 确定性判定时给出——例如 comment_conversation_rate 的三处
   * 读取全在 commentMultiTurnGrowthEnabled(默认 false)门后,开关关闭时它乘进
   * 一条恒为零的路径。有 inertReason 的参数不再产出 behaviorInstructions:
   * 给模型一句它无法执行的话只会稀释上下文。
   *
   * 可选字段,历史快照没有它按"未标注"处理(向后兼容)。
   */
  inertReason?: string;
}

export interface CompiledFormulaResult {
  formulaId: `F${string}`;
  title: string;
  value: FormulaPrimitive;
  unknownPaths: string[];
  warnings: string[];
  evidenceStatus: FormulaEvidenceStatus;
  interpretation: string;
  calculatorContract?: FormulaCalculatorContract;
}

export interface ChannelInformationItem {
  information: string;
  reason: string;
  critical: boolean;
  formulaIds: Array<`F${string}`>;
}

export interface ChannelInformationAllocation {
  channel: ContentChannel;
  purpose: string;
  information: ChannelInformationItem[];
  constraints: string[];
}

export interface DiagnosticProxyComponent {
  id: BodyDiagnosticDimension | CommentDiagnosticDimension;
  label: string;
  /** User display preference; never a weight, observation, threshold, or component value. */
  emphasis: number;
  displayOrder: number;
  manualReviewRank: number;
  emphasisSemantics: "display_and_manual_review_priority_only";
  direction: "positive" | "cost" | "risk";
  status: "unknown";
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  value: null;
  source: {
    kind: "not_observed";
    reference: null;
  };
  evidenceStatus: "unvalidated_proxy";
  boundary: string;
}

export interface DiagnosticProxyReport {
  formulaId: DiagnosticProxyFormulaId;
  formulaSemanticFingerprint: string;
  name: string;
  semantics: DiagnosticProxySemantics;
  status: "unknown";
  evaluationStatus: DiagnosticProxyEvaluationStatus;
  aggregateValue: null;
  scoreProduced: false;
  evidenceStatus: "unvalidated_proxy";
  aggregation: "components_only";
  components: DiagnosticProxyComponent[];
  warning: string;
  diagnosticContract: FormulaDiagnosticContract;
}

export interface ConfirmedSampleMetric {
  id: string;
  label: string;
  unit: "characters" | "paragraphs" | "lines" | "items" | "images";
  sampleSize: number;
  statistics: Record<string, number>;
  note?: string;
}

export interface ConfirmedSampleBaseline {
  id: string;
  label: string;
  evidenceStatus: "sample_observation";
  metrics: ConfirmedSampleMetric[];
  caveats: string[];
}

export interface ParameterImpactReport {
  schemaVersion: "1.0";
  behaviorInstructions: string[];
  formulaResults: CompiledFormulaResult[];
  /** Diagnostic parameter preview only; never the final orchestration placement. */
  advisoryAllocationPreview: Record<ContentChannel, ChannelInformationAllocation>;
  /** Historical v1 reports only. New production reports omit this ambiguous name. */
  channelAllocation?: Record<ContentChannel, ChannelInformationAllocation>;
  parameterTraces: ParameterImpactTrace[];
  diagnosticProxies: DiagnosticProxyReport[];
  baselineReferences: ConfirmedSampleBaseline[];
  warnings: string[];
}

export interface ParameterCompilationResult {
  config: ResolvedGenerationConfig;
  resolutionSnapshot: ParameterResolutionSnapshot;
  impactReport: ParameterImpactReport;
}

export type CommentPersonaRole =
  | "first_time_researcher"
  | "information_collector"
  | "comparison_decider"
  | "risk_concerned"
  | "local_action_seeker"
  | "skeptical_returning_reader";

/**
 * 节点说话人类型。本实现用**线程级双字段**表达方法论《统一身份协议》的两类
 * 角色,而不是"一个节点一个 roleType":
 *   speakerType     → 提问侧说话人,恒为 simulated_reader(校验层对任何其他值
 *                     判 invalid_scenario_speaker,见 content.ts)。
 *   postingIdentity → 答复侧的可追责身份(publisher/author/brand/staff/expert),
 *                     即方法论的 accountable_responder。
 * 因此 accountable_responder 这个字面值在运行时不会被赋出——它的职责由
 * postingIdentity 承载。枚举保留该值只为兼容历史包解析,不是待接线的缺口。
 */
export type CommentSpeakerType = "simulated_reader" | "accountable_responder";

/**
 * 线程答复的**结论强度**,与证据来源等级(EvidenceStatus)是两个不同的轴:
 *   EvidenceStatus(observed/user_supplied/inferred/unknown) = 这条证据从哪来,
 *     由知识台账定,claim_judge / knowledge_anchor_review 用它筛证据池。
 *   CommentClaimStatus = 给定证据后这条线程的答复能站到多硬,由规划层按 gap
 *     派生(有答案+有证据→verified;只有答案或框架→bounded;都没有→unknown)。
 *
 * hypothetical 承担方法论 generated_reference 的职责:T2 读者互聊与 T3 漂浮反应
 * 一律 hypothetical(见 planning.ts),且派生路径上**没有**通往 verified 的分支
 * ——这就是"generated_reference 不得升级为 observed"的结构性保证,不靠校验兜。
 */
export type CommentClaimStatus = "verified" | "bounded" | "unknown" | "hypothetical";

export type CommentEvidenceStance = "evidence_first" | "verification_seeking" | "boundary_sensitive" | "unknown_aware";

/** Hidden decision-state card. It decides what the turn needs, not how a visible person sounds. */
export interface DialogueRoleCard {
  stage: string;
  knowledge: string[];
  constraints: string[];
  decisionTask: string;
  evidenceStance: CommentEvidenceStance;
}

/**
 * Industry-neutral narrative shapes. Concrete people, places, actions and
 * vocabulary are supplied by the approved project blueprint.
 */
export type ContentPrototype =
  | "narrow_request"
  | "live_moment"
  | "expectation_reversal"
  | "process_log"
  | "outcome_observation"
  | "retrospective_update"
  | "relationship_moment"
  | "option_comparison";

/**
 * A visible narrator carrier reconstructed from the reference corpus.
 * Every value is a creative scenario instruction, not evidence that a real
 * consumer with this biography exists. The host remains stable across image,
 * title, body and author replies.
 */
export interface NarrativePersonaPlan {
  identityCue: string;
  lifeContext: string;
  localityCue: string;
  currentStage: string;
  immediateConstraint: string;
  relationshipAnchor: string;
  affect: string;
  motive: string;
  voiceTraits: string[];
  speechMarkers: string[];
  knowledgeBoundary: string;
  status: "creative_scenario" | "institution_owned" | "confirmed_author_facts";
}

/** One ordinary, time-bound event that gives the short caption a reason to exist now. */
export interface SceneEventPlan {
  timeAnchor: string;
  setting: string;
  trigger: string;
  observableAction: string;
  friction: string;
  emotionalAftertaste: string;
  openLoop: string;
  imageMoment: string;
}

export type CommentUtteranceMode =
  | "direct_question"
  | "shared_concern"
  | "experience_fragment"
  | "counterexample"
  | "social_reaction"
  | "detail_spotter"
  | "knowledge_translation"
  | "identity_route"
  | "service_answer";

/** Visible social position for one comment node; separate from the hidden decision card. */
export interface CommentSurfaceRoleCard {
  displayRole: string;
  relationToHost: string;
  identityCue: string;
  situationCue: string;
  motive: string;
  knowledgePosition: string;
  speechPattern: string;
  /** Optional, sample-attested register cues; examples, never mandatory keywords. */
  lexicalCues: string[];
  /** A phrase or detail that gives another person a natural reason to reply. */
  interactionHook: string;
  permittedContribution: string;
  utteranceMode: CommentUtteranceMode;
  targetChars: [number, number];
  replyDisplayRole: string;
  /**
   * 机构侧角色标记(双号运营):蓝图 roleModel 中 accountable=true 的角色
   * (机构 IP / 公开助理)在投影进 commentCast 时置 true。机构角色只能答复,
   * 不能坐在读者席——规划层分配开口者 A / 接话读者 B 时必须排除。
   * 历史包没有该字段,按读者侧处理(向后兼容)。
   */
  orgSide?: boolean;
}

export interface PersonaScenePlan {
  /** Project-defined family identifier used to select concrete scene material. */
  scenarioFamilyId: string;
  prototype: ContentPrototype;
  host: NarrativePersonaPlan;
  event: SceneEventPlan;
  commentCast: CommentSurfaceRoleCard[];
  commentNetwork: {
    platformRegister: "plain" | "light_platform" | "sample_rich";
    platformLanguageRule: string;
    multiTurnTarget: [number, number];
    branchMoves: string[];
    organicMoves: string[];
    antiScriptRules: string[];
  };
  surfaceTargets: {
    titleChars: [number, number];
    bodyChars: [number, number];
    bodyParagraphs: [number, number];
    visibleCommentLines: [number, number];
    typicalCommentChars: [number, number];
  };
  crossChannelRules: string[];
  sampleBasis: string;
}

/**
 * Explainable structural proxy; its counts are not a quality or conversion score.
 *
 * M7 convergence (design 组件 E · E1/E2, densityProxy row): densityProxy is downgraded to an
 * OPTIONAL audit field. On the parsed/validated thread (`CommentReferenceThread.densityProxy`)
 * it is optional — its absence never triggers `comment_density_metadata_incomplete`, and when
 * present content.ts still audits its self-consistency. The density contract is anchored on
 * roleCard + primaryGapId, and the real structural constraint remains
 * `comment_gap_multiplexing_exceeded`.
 */
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

/**
 * M7 convergence (discoveryPlan → optional / streamlined form).
 * Decision record (design 组件 E · E1, discoveryPlan row): the discovery scaffolding
 * has (c) no traceable evidence, but the safety checks it feeds do carry creative value.
 * So the structure is downgraded to optional while the safety semantics are kept.
 *
 * Only `boundary` (the field the false-closure safety check anchors on) is required.
 * The remaining discovery scaffolding (cue / inferencePrompt / reveal / selfCheck /
 * revealTiming / difficulty) is optional, so dialoguePlans may emit a streamlined plan.
 * When a plan is present, content.ts still enforces the three safety checks
 * (withholding / false-closure / discovery-as-evidence) at `error` level.
 */
export interface CommentDiscoveryPlan {
  boundary: string;
  cue?: string;
  inferencePrompt?: string;
  reveal?: string;
  selfCheck?: string;
  revealTiming?: "same_thread";
  difficulty?: "low" | "moderate";
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

/**
 * Dialogic function of one visible comment node (Cref contract v1.1).
 * `question` opens a thread, `answer` resolves it, `follow_up` extends it with a
 * new reader question, `clarification` answers that extension. All kind fields
 * are optional so historical packages (written before this contract) still
 * parse; a missing kind means "not recorded", never a defaulted certainty.
 */
export type CommentNodeKind = "question" | "answer" | "follow_up" | "clarification";

/**
 * 追问层级（方法论《问题—答复—追问的最小结构》的 followUp.level）。
 * L0 初问＝根评论本身，L1 补改变答案的条件，L2 处理反例或矛盾，L3 给核验与
 * 下一步。方法论原话是「追问层级不是越深越好…没有新增缺口就停止；不得用
 * 循环追问制造热闹感」——所以这是**功能标注**，不是必须走满四级的深度要求：
 * 层级只说明这一轮追问承担什么，不代表允许更深。
 *
 * 可见行数预算独立约束实际轮数：追问容量按
 * `(visibleCommentLines[1] - threadCount*2)/2` 计算（见 planning/content），
 * 各原型上限 12–15 行、线程 3–5 条时本就只剩 1–2 轮，因此深度上限不随层级
 * 放开。可选字段，历史包没有该标注。
 */
export type CommentFollowUpLevel = "L1" | "L2" | "L3";

/**
 * 追问停止原因（方法论同一结构里的 stopWhen：已回答、证据不足需标 unknown、
 * 或应转专业核验）。标注为什么这一支停在这里，供审计区分"自然收束"与
 * "缺证据被迫停"——两者都合法，但后者必须能被看见。可选，历史包没有。
 */
export type CommentFollowUpStopReason = "answered" | "unknown_pending_evidence" | "route_to_professional";

/**
 * 评论互动类型(读者互动层),标记整条线程的互动形态:
 * - `org_answer` 机构问答(T1,缺省值):读者开口 → 可追责身份(IP/助理)答复;
 *   涉项目事实的问题必须此型。
 * - `reader_exchange` 读者互聊(T2):读者A开口 → 读者B接话,机构可插话或不出现;
 *   B 只说自己的处境/感受/疑问/轻反应,禁讲项目事实、价格数字、效果证词、机构信息。
 * - `organic_reaction` 漂浮短反应(T3):单条 4-20 字短共鸣,无回答需求,机构不出现。
 * 注意与节点级 `kind`(CommentNodeKind,提问/回答/追问/澄清)区分:threadKind 是
 * 线程级互动形态。可选,历史包缺省按 `org_answer` 理解与渲染。
 */
export type CommentThreadKind = "org_answer" | "host_reply" | "reader_exchange" | "organic_reaction";

export interface CommentFollowUp extends CommentScenarioMetadata {
  id?: string;
  question: string;
  answer: string;
  evidenceIds: string[];
  /**
   * Dialogic kind of this follow-up node. The node is stored as a question /
   * answer pair; `kind` tags the extending (question) side — positional default
   * `follow_up` — while its answer side is positionally a `clarification`.
   */
  kind?: CommentNodeKind;
  /** Optional node-level boundary note (e.g. what this exchange must not assert). */
  boundary?: string;
  /**
   * 本轮追问承担的层级功能（方法论《问题—答复—追问的最小结构》）。位置默认按
   * 深度推导（第 1 轮 L1、第 2 轮 L2…），显式值优先。可选，历史包没有该字段。
   */
  level?: CommentFollowUpLevel;
  /**
   * 本轮追问后为什么停（方法论 stopWhen）。只在该追问是本线程最后一轮时有意义；
   * 可选，历史包没有该字段。
   */
  stopReason?: CommentFollowUpStopReason;
  /**
   * Backend display nickname for this follow-up speaker (纯展示元数据).
   * Assigned deterministically from the package seed so readers can tell the
   * speakers apart; never sent to the model, and comment copy is not required
   * to address anyone by name. Optional so historical packages still parse.
   */
  displayName?: string;
}

export interface CommentReferenceThread extends CommentScenarioMetadata {
  id: string;
  question: string;
  answer: string;
  followUps: CommentFollowUp[];
  postingIdentity: "author" | "brand" | "staff" | "expert" | "reader_question_template" | "publisher";
  /** Actual visible answer speaker. Reader exchanges do not inherit the future publisher route. */
  answerIdentity?: "simulated_reader" | "none" | "author" | "brand" | "staff" | "expert" | "publisher";
  sourceClusterIds: string[];
  evidenceIds: string[];
  /** Dialogic kind of the root question node; positional default `question`. */
  kind?: CommentNodeKind;
  /** Dialogic kind of the root answer node; positional default `answer`. */
  answerKind?: CommentNodeKind;
  /** Thread-level boundary, sourced from replyPlan.boundary when the model did not state one. */
  boundary?: string;
  /** New explainable thread fields are optional so historical packages still parse. */
  stage?: string;
  gap?: string;
  function?: "surface_gap" | "answer" | "clarify" | "counterexample" | "verification" | "next_step";
  nextStep?: string;
  roleCard?: DialogueRoleCard;
  primaryGapId?: string;
  auxiliaryGapIds?: string[];
  densityProxy?: CommentDensityProxy;
  replyPlan?: CommentReplyPlan;
  discoveryPlan?: CommentDiscoveryPlan;
  conversationPlan?: DialogueThreadPlan["conversationPlan"];
  surfaceRoleCard?: CommentSurfaceRoleCard;
  /**
   * Backend display nickname for the thread opener (纯展示元数据), assigned
   * deterministically from the package seed. Display-only: it lets readers
   * tell commenters apart and must never collide with an accountable
   * publisher-side identity. Optional so historical packages still parse.
   */
  displayName?: string;
  /**
   * 线程级互动形态(读者互动层)。可选,历史包缺省按 `org_answer` 理解;
   * 校验、渲染与导出都按缺省 T1 处理,不出错。
   */
  threadKind?: CommentThreadKind;
  /**
   * T2(reader_exchange)接话读者 B 的展示昵称(纯展示元数据),与开口者 A 的
   * displayName 必不相同;仅 T2 线程出现,不投给模型。
   */
  replyDisplayName?: string;
  /**
   * T2(reader_exchange)接话读者 B 的可见角色卡,displayRole 与开口者 A 的
   * surfaceRoleCard 必不相同;B 的接话范围限其 permittedContribution。
   */
  replySurfaceRoleCard?: CommentSurfaceRoleCard;
  /** Human-confirmed author facts used by a host_reply. Never project evidenceIds into this field. */
  authorFactIds?: string[];
  /** Social threads may stay on-topic without owning or resolving a project information gap. */
  topicAnchorGapId?: string;
}

export interface ContentPackageContent {
  H: {
    hashtags: string[];
  };
  N: {
    imageBrief: string;
    title: string;
    body: string;
  };
  Cref: {
    disclaimer: string;
    threads: CommentReferenceThread[];
    /**
     * Optional publisher-owned first comment (FAQ-style pinned reply) produced
     * during staged generation. Absent means none was produced; it is never
     * synthesized after the fact.
     */
    ownedFirstComment?: string;
    /**
     * Plan-level projection of selected gaps that no dialogue thread covers
     * (primary or auxiliary) and that are not planned for N.body. Derived
     * deterministically by the engine at bind time; absent on historical
     * packages means "not computed", not "nothing uncovered". Distinct from
     * CommentGapCoverageLedger.uncoveredGapIds, which grades the final draft's
     * realization quality after generation.
     */
    uncoveredGaps?: string[];
  };
}

export type ContentChannel = "H" | "N.imageBrief" | "N.title" | "N.body" | "Cref";

/** Normalized project facts used by the non-vector planning layer. */
export interface ProjectIntelligence {
  projectId: string;
  industry: string;
  domain: string;
  projectSummary: string;
  verifiedFacts: string[];
  differentiators: string[];
  audienceStates: string[];
  hardBoundaries: string[];
  prohibitedClaims: string[];
  dynamicUnknowns: string[];
  evidenceIds: string[];
  /** Optional for historical analyses created before mechanical evidence validation. */
  evidenceValidationIssues?: Array<{
    path: string;
    statement: string;
    reason: "missing_ledger" | "invalid_source_status" | "unknown_evidence" | "unsupported_statement";
    evidenceIds?: string[];
  }>;
  /** File-level disclosure coverage captured for the analysis snapshot. */
  knowledgeCoverage?: Array<{
    documentId: string;
    filename: string;
    status: "fully_disclosed" | "partially_disclosed" | "omitted_by_budget" | "truncated" | "unreadable";
  }>;
}

export const PROJECT_BLUEPRINT_MODULE_KEYS = [
  "knowledge_map",
  "domain_model",
  "audience_model",
  "scenario_model",
  "role_model",
  "claim_policy",
  "surface_language",
] as const;

export type ProjectBlueprintModuleKey = typeof PROJECT_BLUEPRINT_MODULE_KEYS[number];
export type ProjectBlueprintSourceStatus = "supplied_fact" | "approved_observation" | "inference" | "hypothesis" | "unknown";

export interface ProjectBlueprintSourceRef {
  status: ProjectBlueprintSourceStatus;
  evidenceIds: string[];
  note?: string;
}

export interface ProjectKnowledgeMapEntry {
  id: string;
  sourceName: string;
  section?: string;
  purpose: "project_fact" | "domain_note" | "dynamic_information" | "boundary" | "reference_style" | "unknown";
  factEligible: boolean;
  source: ProjectBlueprintSourceRef;
}

export interface ProjectScenarioFamily {
  id: string;
  label: string;
  prototype: ContentPrototype;
  applicableStages: ResolvedGenerationConfig["task"]["audienceStage"][];
  hostIdentityCues: string[];
  lifeContexts: string[];
  timeAnchors: string[];
  settings: string[];
  triggers: string[];
  observableActions: string[];
  frictions: string[];
  emotionalAftertastes: string[];
  imageMoments: string[];
  prohibitedUnsupportedHistories: string[];
  source: ProjectBlueprintSourceRef;
}

export interface ProjectRoleDefinition {
  id: string;
  displayRole: string;
  relationToHost: string;
  identityCues: string[];
  situationCues: string[];
  motives: string[];
  knowledgePosition: string;
  speechPatterns: string[];
  lexicalCues: string[];
  interactionHooks: string[];
  permittedContributions: string[];
  utteranceModes: CommentUtteranceMode[];
  replyDisplayRoles: string[];
  targetChars: [number, number];
  accountable: boolean;
  source: ProjectBlueprintSourceRef;
}

export interface ProjectClaimRule {
  id: string;
  label: string;
  claimType: "price" | "identity" | "credential" | "schedule" | "outcome" | "causality" | "suitability" | "location" | "historical_action" | "other";
  terms: string[];
  requiresEvidence: boolean;
  allowedEvidenceStatuses: ProjectBlueprintSourceStatus[];
  dynamic: boolean;
  handling: "block" | "qualify" | "verify";
  source: ProjectBlueprintSourceRef;
}

export interface ProjectCreativeBlueprint {
  schemaVersion: "1.0";
  projectId: string;
  sourceFingerprint: string;
  moduleRevisions: Record<ProjectBlueprintModuleKey, string>;
  knowledgeMap: ProjectKnowledgeMapEntry[];
  domainModel: {
    projectNoun: string;
    industry: string;
    domain: string;
    objects: string[];
    actions: string[];
    concepts: string[];
    decisionTasks: string[];
    vocabulary: string[];
  };
  audienceModel: {
    states: Array<{
      id: string;
      label: string;
      stages: ResolvedGenerationConfig["task"]["audienceStage"][];
      goals: string[];
      constraints: string[];
      knowledgeState: string;
      hesitationReasons: string[];
      actionConditions: string[];
      source: ProjectBlueprintSourceRef;
    }>;
  };
  scenarioModel: { families: ProjectScenarioFamily[] };
  roleModel: {
    hostVoiceTraits: string[];
    hostSpeechMarkers: string[];
    roles: ProjectRoleDefinition[];
    /**
     * 双号运营服务模型,蓝图生成时从项目资料判定;历史蓝图没有该字段,故可选。
     * one_time 一次性服务:营销角色池不含老客复购,重点是转介绍/服务后回访;
     * recurring 疗程复购:允许老客复购类角色;mixed 混合:按话头裁剪两类角色。
     */
    serviceModel?: "one_time" | "recurring" | "mixed";
  };
  claimPolicy: { rules: ProjectClaimRule[]; prohibitedClaims: string[]; dynamicInformation: string[]; unknownHandling: string[] };
  surfaceLanguage: {
    registerDescription: string;
    preferredTerms: string[];
    optionalColloquialisms: string[];
    prohibitedCliches: string[];
    antiCopyRules: string[];
  };
}

export interface InformationGap {
  id: string;
  label: string;
  question: string;
  category: string;
  audienceStages: ResolvedGenerationConfig["task"]["audienceStage"][];
  importance: number;
  decisionLeverage: number;
  proofability: number;
  answer?: string;
  framework?: string;
  boundary?: string;
  evidenceIds: string[];
  /**
   * 答案来源。决定 bindGapEvidence 是否给出人工背书证据。
   *
   * - supplied_fact 资料里有出处,分析器基于 evidenceSections 判定
   * - user_supplied 人工填写并确认过,与资料支撑同等有效
   * - inference / hypothesis / unknown 仍属待补充
   */
  sourceStatus?: "supplied_fact" | "user_supplied" | "inference" | "hypothesis" | "unknown";
  /**
   * Immutable approval metadata for an owner-asserted answer. Merely setting
   * sourceStatus is insufficient: formal evidence is created only when the API
   * freezes the approving principal and timestamp into the generation snapshot.
   */
  humanConfirmation?: {
    confirmedBy: string;
    confirmedAt: string;
  };
  /** Whether this planning gap should also become project Markdown knowledge. */
  knowledgeAction?: "organize_existing" | "ask_user" | "none";
  knowledgeReason?: string;
  knowledgeFindingStatus?:
    | "supported"
    | "not_found_after_full_scan"
    | "not_assessed_due_to_coverage"
    | "conflicting"
    | "stale_reference";
  evidenceValidationIssues?: Array<{
    path: string;
    statement: string;
    reason: "missing_ledger" | "invalid_source_status" | "unknown_evidence" | "unsupported_statement";
    evidenceIds?: string[];
  }>;
  required: boolean;
  preferredChannels?: ContentChannel[];
}

export type InformationGapPriority = "required" | "high" | "standard";

/**
 * The canonical planning card for one information gap.
 *
 * It deliberately keeps the content requirement and its planned placement in
 * one object. `channelAllocation` remains on OrchestrationPlan as a backwards-
 * compatible rendered view, but planners, prompts and ledgers should consume
 * these cards instead of independently assigning gaps to channels.
 */
export interface InformationGapPlanningCard {
  gapId: string;
  label: string;
  question: string;
  category: string;
  audienceStages: ResolvedGenerationConfig["task"]["audienceStage"][];
  importance: number;
  decisionLeverage: number;
  proofability: number;
  required: boolean;
  priority: InformationGapPriority;
  answer?: string;
  framework?: string;
  boundary?: string;
  evidenceIds: string[];
  plannedPlacements: ContentChannel[];
}

export interface ExpressionStrategy {
  id: string;
  label: string;
  /** Reference-corpus surface prototype; optional for historical/custom strategies. */
  prototype?: ContentPrototype;
  openingMode: string;
  narrativeMode: string;
  bodyRole: string;
  imageRole: ImagePlan["role"];
  commentMode: string;
  voice: string;
  sequence: string[];
  targetChannels: ContentChannel[];
  enabled?: boolean;
  locked?: boolean;
  selectionWeight?: number;
  randomization?: {
    enabled: boolean;
    weight?: number;
  };
}

/** Inputs consumed by the versioned opportunity-ranking heuristic. */
export type OpportunityRankMetric =
  | "relevance"
  | "importance"
  | "proofability"
  | "decisionLeverage"
  | "novelty"
  | "cognitiveCost"
  | "risk";

/**
 * Provenance is asserted by the caller. `legacy_unspecified` means that a
 * numeric value exists in an older payload but Core cannot truthfully infer
 * where it came from; `unknown` means that no usable input was supplied.
 */
export type OpportunityRankInputSourceKind =
  | "observed"
  | "user"
  | "project"
  | "model_heuristic"
  | "system_heuristic"
  | "default_policy"
  | "legacy_unspecified"
  | "unknown";

export interface OpportunityRankInputProvenance {
  source: OpportunityRankInputSourceKind;
  sourceRef?: string;
  note?: string;
}

export interface OpportunityRankInputSources {
  metrics?: Partial<Record<OpportunityRankMetric, OpportunityRankInputProvenance>>;
  status?: OpportunityRankInputProvenance;
  topic?: OpportunityRankInputProvenance;
  gapIds?: OpportunityRankInputProvenance;
}

export interface OpportunityRankHeuristicDescriptor {
  id: "OpportunityRankHeuristicV1";
  version: "1.0.0";
  weights: Readonly<Record<OpportunityRankMetric, number>>;
  criticalMetrics: readonly OpportunityRankMetric[];
  weightsCalibrated: false;
  causal: false;
  notF28: true;
  scoreSemantics: "ordinal_noncausal_heuristic";
  scoreRange: readonly [0, 1];
}

export interface OpportunityRankComponent {
  metric: OpportunityRankMetric;
  rawValue: number | null;
  transformedValue: number | null;
  transformation: "identity" | "one_minus";
  weight: number;
  contribution: number | null;
  source: OpportunityRankInputProvenance;
}

export type OpportunityRankUnknownMetric = OpportunityRankMetric | "recentOverlap";
export type OpportunityRankEffectiveEligibility = "eligible" | "ineligible" | "review_required";

export interface OpportunityRankResultInputSources {
  metrics: Record<OpportunityRankMetric, OpportunityRankInputProvenance>;
  status: OpportunityRankInputProvenance;
  topic: OpportunityRankInputProvenance;
  gapIds: OpportunityRankInputProvenance;
  recentCoverage: OpportunityRankInputProvenance;
  options: OpportunityRankInputProvenance;
}

export interface OpportunityRankRecentCoverageTrace {
  status: "provided" | "unknown";
  count: number | null;
  similarity: number | null;
  source: OpportunityRankInputProvenance;
}

export interface OpportunityRankPolicySnapshot {
  minProofability: number;
  maxRisk: number;
  recentPenaltyWeight: number;
  reuseCooldown: number;
}

export interface TopicOpportunity {
  id: string;
  topic: string;
  angle: string;
  gapIds: string[];
  /** Explicitly approved expression-policy dependency for this opportunity. */
  strategyId?: string;
  audienceStage: ResolvedGenerationConfig["task"]["audienceStage"];
  entry: ResolvedGenerationConfig["task"]["entry"];
  relevance?: number;
  importance?: number;
  proofability?: number;
  novelty?: number;
  decisionLeverage?: number;
  cognitiveCost?: number;
  risk?: number;
  evidenceIds: string[];
  boundaries: string[];
  tags: string[];
  imageAssetIds: string[];
  status: "eligible" | "blocked" | "unknown";
  /** Caller-asserted source metadata; omitted legacy fields remain explicitly untraceable. */
  rankInputSources?: OpportunityRankInputSources;
  /** @deprecated Accepted for old payloads only; OpportunityRankHeuristicV1 never consumes it. */
  score?: number;
}

/** Serializable audit row produced by OpportunityRankHeuristicV1. */
export interface RankedTopicOpportunity {
  /** Rank among effective eligible results only; review/ineligible rows remain unranked. */
  rank: number | null;
  opportunity: TopicOpportunity;
  heuristic: OpportunityRankHeuristicDescriptor;
  components: OpportunityRankComponent[];
  inputSources: OpportunityRankResultInputSources;
  unknownMetrics: OpportunityRankUnknownMetric[];
  reviewRequired: boolean;
  reviewReasons: string[];
  effectiveEligibility: OpportunityRankEffectiveEligibility;
  /**
   * Advisory-only hints derived from the uncalibrated policy thresholds
   * (minProofability/maxRisk). These are ranking/prompt inputs, never gates:
   * they never affect effectiveEligibility or a candidate's selectability
   * (req 5.4, design C2).
   */
  advisoryNotes?: string[];
  unboundedBaseScore: number | null;
  baseScore: number | null;
  recentPenalty: number | null;
  /** Legacy-compatible field name. The value is an ordinal, non-causal heuristic. */
  finalScore: number | null;
  scoreSemantics: "ordinal_noncausal_heuristic";
  policy: OpportunityRankPolicySnapshot;
  recentCoverage: OpportunityRankRecentCoverageTrace;
  legacyInputScore?: {
    value: number;
    used: false;
    semantics: "legacy_heuristic";
  };
  reasons: string[];
}

export interface OpportunitySelectionAudit {
  selectedOpportunityId: string;
  selectionMode: "heuristic_ranked" | "explicit_locked" | "default_policy" | "revision_inherited";
  rankStatus: "applied" | "not_applied";
  approvalBasis?: "approved_dependency";
  rankNotAppliedReason?: string;
  selectedOpportunityRank?: RankedTopicOpportunity;
}

export type ImageAssetRole = "cover" | "evidence" | "scene" | "diagram" | "before_after" | "other";

export interface ImageAssetAnalysis {
  assetId: string;
  imageUrl?: string;
  mimeType?: string;
  altText?: string;
  observedFacts: string[];
  inferredSignals: string[];
  unknowns: string[];
  visibleText: string[];
  roles: ImageAssetRole[];
  quality: {
    clarity: number;
    relevance: number;
    textLegibility: number;
  };
  safetyFlags: string[];
  evidenceIds: string[];
  source: "uploaded" | "knowledge" | "generated_reference";
}

export type AudienceStateHypothesisLevel = "low" | "medium" | "high";

export interface AudienceStateHypothesis {
  level: AudienceStateHypothesisLevel;
  range: [number, number];
  calibrated: false;
  source: "stage_heuristic";
  basis: string;
}

export interface AudienceStateSeed {
  entry: ResolvedGenerationConfig["task"]["entry"];
  stage: ResolvedGenerationConfig["task"]["audienceStage"];
  /** User-supplied only. Project knowledge must never be copied here. */
  preContactKnown: string[];
  /** Evidence available to the agent; this is not assumed reader knowledge. */
  availableEvidence: string[];
  hypothesizedGaps: string[];
  readerConstraints: string[];
  /** Project/content boundaries available to the agent, not reader traits. */
  availableBoundaries: string[];
  history: {
    status: "provided" | "unknown";
    items: string[];
  };
  stateHypotheses: {
    skepticism: AudienceStateHypothesis;
    fatigue: AudienceStateHypothesis;
    closureNeed: AudienceStateHypothesis;
  };
  status: "hypothesis";
  calibrationStatus: "unvalidated";
}

export interface ImagePlan {
  /** Approved source material used to plan the visual. This is not a generated final image. */
  sourceAssetId?: string;
  /** @deprecated Use sourceAssetId. Kept so historical packages remain readable. */
  primaryAssetId?: string;
  role: ImageAssetRole;
  coverText?: string;
  frames: string[];
  composition: string;
  altText: string;
  evidenceIds: string[];
  boundaries: string[];
}

export type ArtifactAlignmentStatus = "pass" | "warn" | "fail" | "not_evaluated";

export interface ArtifactAlignmentCheck {
  id: string;
  status: ArtifactAlignmentStatus;
  reason: string;
  /** Human-readable plan or boundary anchors considered by this check. */
  anchors: string[];
}

export interface ArtifactAlignmentEvaluation {
  status: ArtifactAlignmentStatus;
  /** False only when the required downstream artifact does not exist. */
  evaluated: boolean;
  reasons: string[];
  checks: ArtifactAlignmentCheck[];
}

/**
 * Evidence-aware production state. A plan, brief or declaration must never be
 * presented as proof that a final asset was created, published or observed.
 */
export interface ProductionArtifacts {
  schemaVersion: "1.0";
  imageObservation: {
    /** `approved` means the supplied analysis was approved for this generation, not that every inference is factual. */
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
    /** `contract_validated` requires a passing plan-to-copy alignment; a warning remains only a draft. */
    status: "disabled" | "absent" | "drafted" | "contract_validated";
    note: string;
  };
  finalImageAsset: {
    /** A declared asset is still not verified. */
    status: "absent" | "declared" | "verified";
    assetId?: string;
    note: string;
  };
  entrySnapshot: {
    /** A captured snapshot is still not independently verified. */
    status: "absent" | "captured" | "verified";
    snapshotId?: string;
    note: string;
  };
  deployment: {
    status: "not_deployed" | "recorded" | "observed" | "unknown";
    note: string;
  };
  planToCopyAlignment: ArtifactAlignmentEvaluation;
  finalAssetAlignment: ArtifactAlignmentEvaluation;
  entrySnapshotAlignment: ArtifactAlignmentEvaluation;
}

export interface DialogueThreadPlan {
  id: string;
  gapId: string;
  stage: string;
  function: NonNullable<CommentReferenceThread["function"]>;
  questionIntent: string;
  answerRequirements: string[];
  followUpIntent: string;
  nextStep: string;
  postingIdentity: Exclude<CommentReferenceThread["postingIdentity"], "reader_question_template">;
  sourceClusterIds: string[];
  evidenceIds: string[];
  boundaryRequired: boolean;
  personaRole: CommentPersonaRole;
  speakerType: "simulated_reader";
  claimStatus: CommentClaimStatus;
  replyTo: null;
  threadDepth: 0;
  simulated: true;
  simulationLabel: string;
  roleCard: DialogueRoleCard;
  primaryGapId: string;
  auxiliaryGapIds: string[];
  /**
   * M7: densityProxy is an optional audit field on the validated thread. The planner still
   * always emits it (and engine.ts consumes `densityProxy.questionTargetChars`), so it stays
   * required on this planning contract; content.ts treats a missing densityProxy as
   * acceptable (optional audit) and never reports comment_density_metadata_incomplete for it.
   */
  densityProxy: CommentDensityProxy;
  replyPlan: CommentReplyPlan;
  /** M7: downgraded to optional (streamlined-capable); see CommentDiscoveryPlan. */
  discoveryPlan?: CommentDiscoveryPlan;
  conversationPlan?: {
    topology: "single_exchange" | "two_turn" | "three_person_branch" | "reaction_then_reply" | "host_reply" | "reader_exchange" | "organic_reaction";
    targetFollowUps: 0 | 1 | 2;
    openingMove: string;
    replyMove: string;
    extensionMove: string;
    extensionGapId?: string;
  };
  /** Visible person/scene carrier. The legacy roleCard remains the hidden decision task. */
  surfaceRoleCard?: CommentSurfaceRoleCard;
  /**
   * Backend display nickname for the thread opener (纯展示元数据), assigned by
   * the planner from the plan seed and carried into the bound thread; never
   * projected to the model. Optional so historical plan snapshots stay readable.
   */
  displayName?: string;
  /**
   * 线程级互动形态(读者互动层),由规划侧按种子确定性分配(不设死比例;营销
   * 话头 gap 的线程 org_answer 概率自然偏高)。缺省 `org_answer`。
   */
  threadKind?: CommentThreadKind;
  /** New plans set primary_gap only for org_answer; historical plans omit it. */
  coverageRole?: "primary_gap" | "topic_anchor" | "none";
  /** Social thread topic association; it never resolves the gap. */
  topicAnchorGapId?: string;
  /** Confirmed author facts available to a host_reply; empty for every other kind. */
  authorFactIds?: string[];
  /** Narrow host-only reply contract. Present only on host_reply in new plans. */
  hostReplyPlan?: {
    focus: "current_state" | "intent" | "constraint" | "visible_detail" | "open_loop";
    allowedAuthorFactIds: string[];
    questionIntent: string;
  };
  /** T2 接话读者 B 的展示昵称(纯展示元数据),与开口者 A 不同;仅 T2 线程出现。 */
  replyDisplayName?: string;
  /** T2 接话读者 B 的可见角色卡,displayRole 与开口者不同;B 接话范围限其 permittedContribution。 */
  replySurfaceRoleCard?: CommentSurfaceRoleCard;
  /**
   * 规划期冻结答复身份时记录的一句理由，随包落库供审计；生成与修复阶段只读，
   * 不得依据成稿问题重新分配。可选以兼容历史计划。
   */
  routingReason?: string;
  /**
   * 项目已审核角色库为当前提问角色指定的答复展示身份。它来自读者角色的
   * replyDisplayRoles，不等于最终展示字段；路由层先把它解析成 staff/expert，
   * 再写入最终 postingIdentity/replyDisplayRole。可选以兼容历史计划。
   */
  preferredReplyDisplayRole?: string;
  /**
   * 开口人物去重标记:读者角色池小于线程数时允许同一 displayRole 重复开口,
   * 重复线程置 true,提示词规格里提示换说法。可选,历史计划快照没有该字段。
   */
  personaRepeated?: boolean;
}

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
  /** Canonical pre-generation placement copied from the gap planning card. */
  plannedPlacements: ContentChannel[];
  /** Populated only after evaluating the final visible body and comment output. */
  actualRealizations: GapActualRealization[];
  primaryThreadIds: string[];
  auxiliaryThreadIds: string[];
  reason: string;
  requiredInput?: string;
  verificationPath?: string;
}

export interface CommentGapCoverageLedger {
  entries: CommentGapCoverageEntry[];
  uncoveredGapIds: string[];
  /** Completeness of the ledger itself; this is not a content-resolution rate. */
  ledgerCompleteness: number;
  /** @deprecated Read ledgerCompleteness. Kept so historical clients remain readable. */
  closureRate: number;
  /** Actual resolved rate after final-draft evaluation; 0 before that evaluation. */
  resolvedRate: number;
  /** Null means the final draft has not been evaluated yet. */
  realizedResolvedRate: number | null;
  realizationStatus: "not_evaluated" | "evaluated";
  targetThreadCount: number;
  effectiveThreadCount: number;
  capacityWarning?: string;
}

/**
 * One structured routing rule for real incoming comments (aC operations,
 * strictly separate from Cref reference content — F03).
 */
export interface DeploymentLiveRoutingRule {
  /** Which kind of real comment this rule covers. */
  route: string;
  /** When the rule applies. */
  condition: string;
  /** What the operator does; individual conclusions are never auto-filled. */
  action: string;
}

export interface DeploymentPlan {
  postingIdentity: DialogueThreadPlan["postingIdentity"];
  ownedFirstComment: boolean;
  /** Legal thread-function values only; historical snapshots may contain other strings. */
  pinPriority: Array<NonNullable<CommentReferenceThread["function"]>>;
  /** Response-time tier for the operating account (static template text). */
  sla?: string;
  /** @deprecated Historical snapshots stored the SLA here. Kept so they stay readable. */
  responseSla?: string;
  /** Historical snapshots stored plain strings; both shapes stay readable. */
  liveRouting: DeploymentLiveRoutingRule[] | string[];
  updateTriggers: string[];
  /** Rule for feeding new high-frequency real questions back into the update queue. */
  updatePolicy?: string[];
  stopRules: string[];
}

export interface OrchestrationPlan {
  id: string;
  topicOpportunityId: string;
  /** Optional only for historical snapshots; all new generation plans populate it. */
  opportunitySelectionAudit?: OpportunitySelectionAudit;
  candidateIndex: 0 | 1 | 2;
  seed: number;
  strategy: ExpressionStrategy;
  stateSeed: AudienceStateSeed;
  /** Cross-channel human carrier and event scene used by the visible renderer. */
  personaScenePlan?: PersonaScenePlan;
  selectedGapIds: string[];
  /** Canonical source of truth for gap content and channel placement. */
  gapPlanningCards?: InformationGapPlanningCard[];
  /** Backwards-compatible rendered view; gap:* entries derive from gapPlanningCards. */
  channelAllocation: Record<ContentChannel, string[]>;
  imagePlan: ImagePlan;
  /** Optional only so historical orchestration snapshots remain readable; all new plans populate it. */
  productionArtifacts?: ProductionArtifacts;
  dialogueThreads: DialogueThreadPlan[];
  gapCoverageLedger: CommentGapCoverageLedger;
  targetThreadCount: number;
  effectiveThreadCount: number;
  capacityWarning?: string;
  deploymentPlan: DeploymentPlan;
  rationale: string[];
  evidenceIds: string[];
  boundaries: string[];
}

export interface CoverageSignature {
  version: "1.0";
  topicKey: string;
  gapIds: string[];
  strategyId: string;
  imageRole: ImageAssetRole;
  audienceStage: ResolvedGenerationConfig["task"]["audienceStage"];
  entry: ResolvedGenerationConfig["task"]["entry"];
  channelFeatures: Record<ContentChannel, string[]>;
  tokens: string[];
  fingerprint: string;
  createdAt?: string;
}

export interface PlanningOptions {
  minProofability?: number;
  maxRisk?: number;
  recentPenaltyWeight?: number;
  minStructureDistance?: number;
  lockedGapIds?: string[];
  lockedStrategyId?: string;
  randomizationDimensions?: PlanningRandomizationDimension[];
  variationStrength?: number;
  reuseCooldown?: number;
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

export interface PlanningContext {
  projectIntelligence?: ProjectIntelligence;
  projectBlueprint?: ProjectCreativeBlueprint;
  informationGaps?: InformationGap[];
  opportunities?: TopicOpportunity[];
  imageAnalyses?: ImageAssetAnalysis[];
  expressionStrategies?: ExpressionStrategy[];
  selectedOpportunityId?: string;
  recentCoverage?: CoverageSignature[];
  recentCoverageSource?: OpportunityRankInputProvenance;
  orchestrationOptions?: PlanningOptions;
  orchestrationOptionsSource?: OpportunityRankInputProvenance;
}

export type ContentIssueDisposition = "block" | "review" | "advisory";
export type ContentIssueOrigin = "deterministic" | "agent" | "infrastructure";
export type CandidateQualityStatus = "passed" | "needs_review" | "blocked";

export interface ContentValidationIssue {
  code: string;
  /** Legacy presentation level. Publication decisions use disposition. */
  severity: "error" | "warning";
  channel: ContentChannel | "package";
  message: string;
  repairable: boolean;
  /** New packages state the action explicitly; historical issues derive error=block, warning=advisory. */
  disposition?: ContentIssueDisposition;
  /** Identifies who made the judgment without pretending heuristic signals are hard constraints. */
  origin?: ContentIssueOrigin;
}

export interface ContentDiagnostic {
  formulaId?: string;
  formulaSemanticFingerprint?: string;
  name: string;
  status: "pass" | "warn" | "fail" | "unknown";
  explanation: string;
  /** Generic/legacy validator summaries only; forbidden for F32/F33 component metadata. */
  score?: number;
  semantics?: DiagnosticProxySemantics;
  evaluationStatus?: DiagnosticProxyEvaluationStatus;
  aggregateValue?: null;
  scoreProduced?: false;
  parameterIds?: string[];
  channels?: ContentChannel[];
  evidenceStatus?: ParameterEvidenceStatus;
  aggregation?: "components_only";
  components?: DiagnosticProxyComponent[];
  diagnosticContract?: FormulaDiagnosticContract;
}

export interface RevisionRecord {
  id: string;
  createdAt: string;
  instruction: string;
  directChannels: ContentChannel[];
  rerunChannels: ContentChannel[];
  parentPackageId?: string;
}

export type ReasoningLocation = "H" | "N.imageBrief" | "N.title" | "N.body" | "Cref.thread" | "Cref.followUp";

export interface ReasoningOccurrence {
  /** Exact channel-level field. Thread fields additionally require threadId. */
  field: "hashtags" | "imageBrief" | "title" | "body" | "question" | "answer" | "nextStep";
  threadId?: string;
  followUpIndex?: number;
}

export interface ClaimSourceSpan {
  evidenceId: string;
  /** Exact contiguous text copied from the disclosed evidence source. */
  quote: string;
}

export interface CommentEditorialAssessment {
  status: "pass" | "review";
  reasons: string[];
  summary: string;
}

export interface ContentReasoningEntry {
  statement: string;
  status: "fact" | "human_confirmed_author_fact" | "sample" | "inference" | "hypothesis" | "unknown";
  evidenceIds: string[];
  /** Human-confirmed author facts use this instead of a project-evidence source span. */
  authorFactId?: string;
  confirmationId?: string;
  /** Optional only so historical packages remain readable; new drafts require it. */
  location?: ReasoningLocation;
  /** Pin a claim to one visible occurrence so identical text cannot be reused across threads. */
  occurrence?: ReasoningOccurrence;
  /** Optional only so historical packages remain readable; new factual drafts require exact spans. */
  sourceSpans?: ClaimSourceSpan[];
}

export interface ContentPackage {
  /**
   * "1.1" adds the optional Cref contract fields (thread/followUp kind, thread
   * answerKind/boundary, Cref ownedFirstComment/uncoveredGaps) and the
   * "publisher" postingIdentity value. Every addition is optional, so "1.0"
   * packages parse unchanged: readers must treat the new fields as absent
   * (unknown), never report an error and never backfill defaults.
   */
  schemaVersion: "1.0" | "1.1";
  id: string;
  projectId: string;
  jobId: string;
  candidateId: string;
  candidateIndex: 0 | 1 | 2;
  seed: number;
  createdAt: string;
  formulaSnapshot: {
    versionId: string;
    digest: string;
    enabledFormulaIds: string[];
    /** Optional only for historical packages created before execution-policy gating. */
    executionPolicyVersion?: string;
    /** Reconstructs the exact reviewed formula-handler ownership policy. */
    executionPolicyDigest?: string;
    /** Server-side trace only; never injected into the drafting model prompt. */
    executionAudit?: Record<string, unknown>;
  };
  configSnapshot: ResolvedGenerationConfig;
  knowledgeSnapshot: {
    mode: KnowledgeContextSelection["mode"];
    documents: Array<{ id: string; path: string; checksum: string; version: string }>;
    sectionIds: string[];
  };
  /** Optional planner snapshots keep historical v1 packages readable. */
  imagePlan?: ImagePlan;
  /** Optional only so historical v1 packages remain readable; all new packages populate it. */
  productionArtifacts?: ProductionArtifacts;
  dialogueThreads?: DialogueThreadPlan[];
  deploymentPlan?: DeploymentPlan;
  orchestrationSnapshot?: OrchestrationPlan;
  coverageSignature?: CoverageSignature;
  content: ContentPackageContent;
  evidence: EvidenceReference[];
  reasoning: ContentReasoningEntry[];
  /**
   * AI 判官对敏感声明的裁决。缺省表示这一轮没有需要裁决的句子(或判官调用失败,
   * 那种情况另有 model_claim_judge_failed 信号)。
   *
   * 落库是为了可审计:判官在校验层确实生效(content.ts 的敏感声明检查会消费它),
   * 但此前只存在于 GenerationDraft 上、组包时丢弃,导致无法事后区分
   * 「sensitive_claim_without_evidence 是判官判了 unsupported」还是「判官没覆盖到」。
   */
  claimJudgments?: ClaimJudgment[];
  /** Agent editorial result for reader-side semantic quality; absent on historical packages. */
  commentEditorialAssessment?: CommentEditorialAssessment;
  unknowns: UnknownItem[];
  conflicts: KnowledgeConflict[];
  diagnostics: ContentDiagnostic[];
  resolutionSnapshot?: ParameterResolutionSnapshot;
  impactReport?: ParameterImpactReport;
  validation: {
    valid: boolean;
    /** Candidate-level result; optional for historical packages. */
    qualityStatus?: CandidateQualityStatus;
    repairAttempts: number;
    issues: ContentValidationIssue[];
  };
  revisions: RevisionRecord[];
}

export interface PromptTextPart {
  type: "text";
  text: string;
}

export interface PromptImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export type PromptContentPart = PromptTextPart | PromptImageUrlPart;

export interface PromptMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | PromptContentPart[];
}

export interface PromptBundle {
  messages: PromptMessage[];
  responseSchema: Record<string, unknown>;
  estimatedTokens: number;
}

/** AI 判官对敏感声明句的分类:事实断言需要证据;邀约/限定/疑问不需要。 */
export type ClaimJudgmentClassification = "factual_assertion" | "service_offer" | "hedge" | "question";

/**
 * AI 判官对单条敏感声明句的裁决(引擎在校验前并入 draft,按句面文本精确匹配
 * 消费):service_offer/hedge/question 直接放行;factual_assertion 仅当
 * supported=true 时放行,否则按无证据受控声明报 error。
 */
export interface ClaimJudgment {
  statement: string;
  classification: ClaimJudgmentClassification;
  /** 仅 factual_assertion 有意义:给出的证据源是否语义支持该句。 */
  supported?: boolean;
}

export interface GenerationDraft {
  content: ContentPackageContent;
  evidenceIds: string[];
  reasoning: ContentPackage["reasoning"];
  unknowns: UnknownItem[];
  /** AI 判官裁决旁路;无裁决(未调用/调用失败)时缺省,校验层走词面旧逻辑。 */
  claimJudgments?: ClaimJudgment[];
  /** Reader-copy editor result. It records semantic review without becoming evidence. */
  commentEditorialAssessment?: CommentEditorialAssessment;
}

export interface GenerationValidationTelemetrySummary {
  issueCount: number;
  errorCount: number;
  warningCount: number;
  blockingCount: number;
  reviewCount: number;
  advisoryCount: number;
  repairableBlockingCount: number;
  terminalBlockingCount: number;
  issueCodes: string[];
  channels: string[];
  origins: string[];
}

/**
 * Safe, metadata-only observability emitted by the traditional generation
 * engine. It intentionally excludes prompts, visible copy and model output.
 */
export type GenerationTelemetryEvent =
  | {
    type: "candidate_validation";
    candidateIndex: number;
    phase: "initial" | "after_repair";
    repairAttempt: number;
    summary: GenerationValidationTelemetrySummary;
  }
  | {
    type: "candidate_repair_started";
    candidateIndex: number;
    repairAttempt: number;
    channels: string[];
    before: GenerationValidationTelemetrySummary;
  }
  | {
    type: "candidate_repair_failed";
    candidateIndex: number;
    repairAttempt: number;
    errorName: string;
  }
  | {
    type: "candidate_repair_skipped";
    candidateIndex: number;
    reason: "terminal_blocker" | "repair_disabled";
    summary: GenerationValidationTelemetrySummary;
  }
  | {
    type: "candidate_completed";
    candidateIndex: number;
    qualityStatus: CandidateQualityStatus;
    repairAttempts: number;
    summary: GenerationValidationTelemetrySummary;
  }
  | {
    type: "candidate_failed";
    candidateIndex: number;
    errorName: string;
  };

export interface GenerationInput {
  jobId: string;
  config: ResolvedGenerationConfig;
  formulaVersion: FormulaVersion;
  knowledge: KnowledgeDocument[];
  claims?: KnowledgeClaim[];
  unknowns?: UnknownItem[];
  parameterSelection?: GenerationParameterSelection;
  planningContext?: PlanningContext;
  /** Optional metadata-only telemetry sink. Failures in the sink are ignored. */
  onTelemetry?: (event: GenerationTelemetryEvent) => void;
}

export interface GenerationResult {
  jobId: string;
  /**
   * 至少一个候选;正常是 3 个。原先是固定三元组,任一候选失败即整单抛错、三个
   * 候选的产出全部丢弃(实测 87 个失败任务落库包数均为 0)。现在只要有候选跑
   * 通就落库,失败的候选记入 degradedCandidates 供前端与运维查因。
   */
  packages: ContentPackage[];
  /** 失败候选的索引与真因;为空表示三个候选都成功。 */
  degradedCandidates?: Array<{ candidateIndex: number; reason: string }>;
  knowledgeContext: KnowledgeContextSelection;
  startedAt: string;
  completedAt: string;
  resolutionSnapshot?: ParameterResolutionSnapshot;
  impactReport?: ParameterImpactReport;
}

export interface RevisionDependencyInput {
  instruction: string;
  explicitChannels?: ContentChannel[];
}

export interface RevisionDependencyResult {
  directChannels: ContentChannel[];
  downstreamChannels: ContentChannel[];
  rerunChannels: ContentChannel[];
  preservedChannels: ContentChannel[];
  /** False only for an explicitly presentation-only edit. */
  semanticChange: boolean;
  reasons: string[];
}
