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
  evidenceStatus: ParameterEvidenceStatus;
  evidenceNote: string;
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

export type CommentSpeakerType = "simulated_reader" | "accountable_responder";

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
  status: "creative_scenario";
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

/** Explainable structural proxy; its counts are not a quality or conversion score. */
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

export interface CommentDiscoveryPlan {
  cue: string;
  inferencePrompt: string;
  reveal: string;
  selfCheck: string;
  boundary: string;
  revealTiming: "same_thread";
  difficulty: "low" | "moderate";
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

export interface CommentFollowUp extends CommentScenarioMetadata {
  id?: string;
  question: string;
  answer: string;
  evidenceIds: string[];
}

export interface CommentReferenceThread extends CommentScenarioMetadata {
  id: string;
  question: string;
  answer: string;
  followUps: CommentFollowUp[];
  postingIdentity: "author" | "brand" | "staff" | "expert" | "reader_question_template";
  sourceClusterIds: string[];
  evidenceIds: string[];
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
  roleModel: { hostVoiceTraits: string[]; hostSpeechMarkers: string[]; roles: ProjectRoleDefinition[] };
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
  densityProxy: CommentDensityProxy;
  replyPlan: CommentReplyPlan;
  discoveryPlan: CommentDiscoveryPlan;
  conversationPlan?: {
    topology: "single_exchange" | "two_turn" | "three_person_branch" | "reaction_then_reply";
    targetFollowUps: 0 | 1 | 2;
    openingMove: string;
    replyMove: string;
    extensionMove: string;
    extensionGapId?: string;
  };
  /** Visible person/scene carrier. The legacy roleCard remains the hidden decision task. */
  surfaceRoleCard?: CommentSurfaceRoleCard;
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

export interface DeploymentPlan {
  postingIdentity: DialogueThreadPlan["postingIdentity"];
  ownedFirstComment: boolean;
  pinPriority: string[];
  responseSla?: string;
  liveRouting: string[];
  updateTriggers: string[];
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

export interface ContentValidationIssue {
  code: string;
  severity: "error" | "warning";
  channel: ContentChannel | "package";
  message: string;
  repairable: boolean;
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

export interface ContentReasoningEntry {
  statement: string;
  status: "fact" | "sample" | "inference" | "hypothesis" | "unknown";
  evidenceIds: string[];
  /** Optional only so historical packages remain readable; new drafts require it. */
  location?: ReasoningLocation;
  /** Pin a claim to one visible occurrence so identical text cannot be reused across threads. */
  occurrence?: ReasoningOccurrence;
  /** Optional only so historical packages remain readable; new factual drafts require exact spans. */
  sourceSpans?: ClaimSourceSpan[];
}

export interface ContentPackage {
  schemaVersion: "1.0";
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
  unknowns: UnknownItem[];
  conflicts: KnowledgeConflict[];
  diagnostics: ContentDiagnostic[];
  resolutionSnapshot?: ParameterResolutionSnapshot;
  impactReport?: ParameterImpactReport;
  validation: {
    valid: boolean;
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

export interface GenerationDraft {
  content: ContentPackageContent;
  evidenceIds: string[];
  reasoning: ContentPackage["reasoning"];
  unknowns: UnknownItem[];
}

export interface GenerationInput {
  jobId: string;
  config: ResolvedGenerationConfig;
  formulaVersion: FormulaVersion;
  knowledge: KnowledgeDocument[];
  claims?: KnowledgeClaim[];
  unknowns?: UnknownItem[];
  parameterSelection?: GenerationParameterSelection;
  planningContext?: PlanningContext;
}

export interface GenerationResult {
  jobId: string;
  packages: [ContentPackage, ContentPackage, ContentPackage];
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
