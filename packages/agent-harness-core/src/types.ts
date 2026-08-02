import type { HarnessMethodId, HarnessMethodProfile } from "./methods.js";

export type HarnessEvidenceStatus = "observed" | "user_supplied" | "inferred" | "unknown";

export interface HarnessEvidenceSource {
  evidenceId: string;
  documentId: string;
  path: string;
  heading: string;
  content: string;
  kind: string;
  evidenceStatus: HarnessEvidenceStatus;
  caveats: string[];
  sourceType?: "knowledge" | "approved_image_observation";
  assetId?: string;
}

export interface HarnessTask {
  topic: string;
  goal: string;
  topicMode?: "agent_discovery" | "user_defined";
  creativeIntent?: string;
  methodProfileId?: HarnessMethodId;
  /** Frozen method semantics used by this run; retries keep this exact snapshot. */
  methodProfile?: HarnessMethodProfile;
  audienceStage?: string;
  audience?: string;
  entryPoint?: string;
  tone?: string;
  bodyLength?: "short" | "medium" | "long";
  accountIdentity?: string;
  callToAction?: string;
  publishingNotes?: string;
  mustInclude: string[];
  forbidden: string[];
  notes?: string;
  /** Explicitly selected project image assets. Unselected assets never enter the run. */
  imageAssetIds?: string[];
  /** Explicit confirmation that generic, non-project-specific output is acceptable when no evidence exists. */
  allowUngrounded?: boolean;
}

export interface HarnessImageSource {
  assetId: string;
  evidenceId: string;
  filename: string;
  mediaType: string;
  width?: number;
  height?: number;
  /** Only an approved observation snapshot may be supplied to the Harness. */
  observation: Record<string, unknown>;
  analysisId: string;
  approvedAt?: string;
}

export type HarnessFollowUpKind = "follow_up" | "counterexample";
export type HarnessThreadStopReason = "answered" | "no_new_gap" | "evidence_boundary" | "professional_review";

export interface HarnessCommentThread {
  id: string;
  /** The simulated reader's concrete residual question. */
  question: string;
  /** Direct answer first; conditions and caveats may follow. */
  answer: string;
  /** Optional: only continue when a new gap or counterexample exists. */
  followUps: Array<{ kind?: HarnessFollowUpKind; question: string; answer: string }>;
  /** Reconcile differences or state what cannot be concluded from the thread. */
  clarification?: string;
  /** A verifiable action after the answer, not a conversion promise. */
  nextStep?: string;
  /** Why this generated reference thread stops instead of mechanically growing. */
  stopReason?: HarnessThreadStopReason;
  postingIdentity: "author" | "brand" | "staff" | "expert" | "publisher";
  evidenceIds: string[];
  boundary?: string;
}

export interface HarnessLiveQuestionRoute {
  when: string;
  owner: "publisher" | "staff" | "expert";
  action: string;
}

export interface HarnessImagePlanItem {
  sequence: number;
  source: "selected_asset" | "new_design";
  /** Empty only when source=new_design. */
  assetId: string;
  role: string;
  overlayText: string;
  direction: string;
  evidenceIds: string[];
}

export interface HarnessAssetDecision {
  assetId: string;
  decision: "use" | "omit";
  rationale: string;
  evidenceIds: string[];
}

export interface HarnessCandidate {
  candidateIndex: 0 | 1 | 2;
  concept: string;
  content: {
    H: { hashtags: string[] };
    N: {
      coverHeadline: string;
      coverSubheadline: string;
      imageBrief: string;
      imageSequence: HarnessImagePlanItem[];
      title: string;
      body: string;
      callToAction: string;
    };
    Cref: {
      disclaimer: string;
      ownedFirstComment: string;
      threads: HarnessCommentThread[];
    };
    publishing: {
      entryPoint: string;
      accountIdentity: string;
      timingNote: string;
      interactionGoal: string;
      /** aC execution plan. Optional only for reading pre-contract historical runs. */
      responseSla?: string;
      liveQuestionRoutes?: HarnessLiveQuestionRoute[];
      updateTriggers?: string[];
      stopRules?: string[];
    };
  };
  assetDecisions: HarnessAssetDecision[];
  citations: Array<{ statement: string; evidenceIds: string[] }>;
  unknowns: string[];
  selfReview: string;
  /** Required for revision runs; empty arrays for original/retry runs. */
  revisionNotes: { instructionApplied: string[]; preservedElements: string[] };
}

export interface HarnessValidationIssue {
  code: string;
  severity: "error" | "warning";
  candidateIndex: number;
  message: string;
}

export interface HarnessClaimAuditEntry {
  candidateIndex: 0 | 1 | 2;
  /** Exact visible sentence/span classified as a project or externally verifiable fact. */
  statement: string;
  evidenceIds: string[];
  classification: "project_fact" | "general_guidance" | "unknown_or_hedged";
}

export interface HarnessClaimAudit {
  complete: boolean;
  summary: string;
  claims: HarnessClaimAuditEntry[];
}

export interface HarnessPublicationCheck {
  key: "evidence" | "simulation_disclosure" | "execution_plan" | "asset_authorization" | "platform_compliance" | "final_proofread";
  status: "ready" | "blocked" | "manual_review";
  note: string;
}

export interface HarnessCandidateResult extends HarnessCandidate {
  claimAudit: HarnessClaimAuditEntry[];
  publicationChecklist: HarnessPublicationCheck[];
  validation: { valid: boolean; issues: HarnessValidationIssue[] };
}

export type HarnessToolAction =
  | { action: "search_knowledge"; query: string; rationale: string }
  | { action: "read_evidence"; evidenceIds: string[]; rationale: string }
  | { action: "submit_candidates"; candidates: HarnessCandidate[]; decisionSummary: string };

export interface HarnessToolTrace {
  sequence: number;
  action: HarnessToolAction["action"];
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  summary: string;
}

export interface HarnessModelRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  schemaName: string;
  responseSchema: Record<string, unknown>;
  temperature: number;
  maxOutputTokens: number;
  metadata: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

export interface HarnessModelProvider {
  generate(request: HarnessModelRequest): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
}

export interface HarnessRunInput {
  jobId: string;
  project: { id: string; name: string; description: string; profile: Record<string, unknown> };
  task: HarnessTask;
  evidence: HarnessEvidenceSource[];
  images?: HarnessImageSource[];
  runMode?: "original" | "retry" | "revision";
  revisionInstruction?: string;
  /** Present for a revision-derived run; treated as user-provided draft context, not evidence. */
  sourceCandidate?: HarnessCandidate;
  provider: HarnessModelProvider;
  maxToolCalls?: number;
  maxReplans?: number;
  onTrace?: (trace: HarnessToolTrace) => void;
  onProgress?: (progress: number) => void;
  /** Durable boundary: called immediately after candidate generation, before auxiliary review. */
  onCandidates?: (checkpoint: HarnessCandidateCheckpoint) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface HarnessCandidateCheckpoint {
  candidates: HarnessCandidate[];
  decisionSummary: string;
  readEvidenceIds: string[];
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number; replans: number };
}

export interface HarnessReviewInput {
  jobId: string;
  project: HarnessRunInput["project"];
  task: HarnessTask;
  evidence: HarnessEvidenceSource[];
  images?: HarnessImageSource[];
  runMode?: "original" | "retry" | "revision";
  revisionInstruction?: string;
  sourceCandidate?: HarnessCandidate;
  candidates: HarnessCandidate[];
  readEvidenceIds: string[];
  provider: HarnessModelProvider;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface HarnessRunResult {
  candidates: HarnessCandidateResult[];
  traces: HarnessToolTrace[];
  decisionSummary: string;
  reviewSummary: string;
  claimAuditSummary: string;
  sourceEvidenceIds: string[];
  readEvidenceIds: string[];
  reviewStatus: "completed" | "blocked";
  reviewError?: string;
  usage: { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number; replans: number };
}
