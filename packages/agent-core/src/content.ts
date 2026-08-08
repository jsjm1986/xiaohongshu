import type {
  ContentChannel,
  ContentDiagnostic,
  CommentFollowUpLevel,
  CommentFollowUpStopReason,
  CommentGapCoverageLedger,
  CommentNodeKind,
  ContentPackageContent,
  ContentValidationIssue,
  ContentReasoningEntry,
  EvidenceReference,
  GapActualRealization,
  GenerationDraft,
  InformationGapPlanningCard,
  KnowledgeLedger,
  OrchestrationPlan,
  ProjectCreativeBlueprint,
  ResolvedGenerationConfig,
  UnknownItem,
} from "./types.js";
import { evaluatePlanToCopyAlignment, isProhibitiveBoundary } from "./artifacts.js";
import { combinedEvidenceSupport, conservativeEvidenceSupport, evidenceClaimAtoms, evidenceReferenceCanSupportFact } from "./knowledge.js";
import { assertModelJsonComplexity } from "./model.js";
import { guardedReplyIdentitiesForQuestion, questionMatchesPlannedGap } from "./planning.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

const personaRoles = new Set(["first_time_researcher", "information_collector", "comparison_decider", "risk_concerned", "local_action_seeker", "skeptical_returning_reader"]);
const speakerTypes = new Set(["simulated_reader", "accountable_responder"]);
const claimStatuses = new Set(["verified", "bounded", "unknown", "hypothetical"]);
const evidenceStances = new Set(["evidence_first", "verification_seeking", "boundary_sensitive", "unknown_aware"]);
const reasoningLocations = new Set(["H", "N.imageBrief", "N.title", "N.body", "Cref.thread", "Cref.followUp"]);
const commentNodeKinds = new Set(["question", "answer", "follow_up", "clarification"]);
const commentThreadFunctions = new Set(["surface_gap", "answer", "clarify", "counterexample", "verification", "next_step"]);

/**
 * 机构感词:评论展示昵称(displayName)不得包含,避免模拟读者的展示昵称被
 * 误认为机构身份。planning.ts 的昵称词库同样按此清单自净,单测两侧共引。
 * 行业身份词拆字拼接书写,保持静态源码行业中立(blueprint-generalization
 * 守卫:prompt/planning/content/engine/parameters 源码不得出现单一行业词)。
 */
export const INSTITUTIONAL_NICKNAME_TERMS: readonly string[] = [
  "官方", "客服", "助理",
  "医" + "美", // 机构行业词一
  "医" + "生", // 机构行业词二
];

/** Lenient optional-field read: an unrecognised kind means "not recorded", never an error. */
function commentNodeKind(value: unknown): CommentNodeKind | undefined {
  return commentNodeKinds.has(String(value)) ? value as CommentNodeKind : undefined;
}

/**
 * 追问层级与停止原因(方法论《问题—答复—追问的最小结构》)。不可识别一律按
 * undefined("未记录")处理,不猜默认值——历史包没有这两个字段。
 */
const followUpLevels = new Set(["L1", "L2", "L3"]);
const followUpStopReasons = new Set(["answered", "unknown_pending_evidence", "route_to_professional"]);

function commentFollowUpLevel(value: unknown): CommentFollowUpLevel | undefined {
  return followUpLevels.has(String(value)) ? value as CommentFollowUpLevel : undefined;
}

function commentFollowUpStopReason(value: unknown): CommentFollowUpStopReason | undefined {
  return followUpStopReasons.has(String(value)) ? value as CommentFollowUpStopReason : undefined;
}

/**
 * 读者互动层:线程级互动形态归一化。缺省或不可识别的值一律按
 * org_answer(机构问答)处理——历史包没有 threadKind 字段,校验、渲染与导出
 * 都按 T1 理解,不出错。
 */
export function commentThreadKindOf(thread: { threadKind?: string }): "org_answer" | "host_reply" | "reader_exchange" | "organic_reaction" {
  return thread.threadKind === "host_reply" || thread.threadKind === "reader_exchange" || thread.threadKind === "organic_reaction"
    ? thread.threadKind
    : "org_answer";
}

/**
 * Lenient optional-field read: a legal thread function, otherwise absent.
 * Used by the staged parser and by the engine's bind step, where an illegal
 * model-stated value silently falls back to the planning derivation (P3-15).
 */
export function commentThreadFunction(value: unknown): ContentPackageContent["Cref"]["threads"][number]["function"] {
  return commentThreadFunctions.has(String(value))
    ? value as NonNullable<ContentPackageContent["Cref"]["threads"][number]["function"]>
    : undefined;
}

/** Lenient optional-field read: trim a non-empty string, otherwise treat it as absent. */
function optionalTrimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const commentUtteranceModes = new Set([
  "direct_question", "shared_concern", "experience_fragment", "counterexample",
  "social_reaction", "detail_spotter", "knowledge_translation", "identity_route", "service_answer",
]);

/**
 * 可见角色卡的白名单解析。身份校验依赖 replyDisplayRole；若解析阶段把它丢掉，
 * “publisher=楼主”这类历史脏数据会在校验前消失，形成旁路。其余字段仍要求完整，
 * 不接受任意对象透传。
 */
function surfaceRoleCard(value: unknown): ContentPackageContent["Cref"]["threads"][number]["surfaceRoleCard"] {
  if (!isRecord(value)) return undefined;
  const required = [
    "displayRole", "relationToHost", "identityCue", "situationCue", "motive",
    "knowledgePosition", "speechPattern", "interactionHook", "permittedContribution", "replyDisplayRole",
  ] as const;
  if (!required.every((key) => typeof value[key] === "string")) return undefined;
  const lexicalCues = stringArray(value.lexicalCues);
  const targetChars = value.targetChars;
  if (!lexicalCues || !commentUtteranceModes.has(String(value.utteranceMode))
    || !Array.isArray(targetChars) || targetChars.length !== 2
    || !targetChars.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return undefined;
  return {
    displayRole: String(value.displayRole).trim(),
    relationToHost: String(value.relationToHost).trim(),
    identityCue: String(value.identityCue).trim(),
    situationCue: String(value.situationCue).trim(),
    motive: String(value.motive).trim(),
    knowledgePosition: String(value.knowledgePosition).trim(),
    speechPattern: String(value.speechPattern).trim(),
    lexicalCues,
    interactionHook: String(value.interactionHook).trim(),
    permittedContribution: String(value.permittedContribution).trim(),
    utteranceMode: value.utteranceMode as NonNullable<ContentPackageContent["Cref"]["threads"][number]["surfaceRoleCard"]>["utteranceMode"],
    targetChars: [Number(targetChars[0]), Number(targetChars[1])],
    replyDisplayRole: String(value.replyDisplayRole).trim(),
    ...(value.orgSide === true ? { orgSide: true } : {}),
  };
}


function questionContext(value: unknown): ContentPackageContent["Cref"]["threads"][number]["questionContext"] {
  if (!isRecord(value)) return undefined;
  const keys = ["personaLabel", "situation", "currentAction", "practicalConstraint", "askingTrigger"] as const;
  if (!keys.every((key) => typeof value[key] === "string" && String(value[key]).trim())) return undefined;
  return {
    personaLabel: String(value.personaLabel).trim(),
    situation: String(value.situation).trim(),
    currentAction: String(value.currentAction).trim(),
    practicalConstraint: String(value.practicalConstraint).trim(),
    askingTrigger: String(value.askingTrigger).trim(),
  };
}

function roleCard(value: unknown): ContentPackageContent["Cref"]["threads"][number]["roleCard"] {
  if (!isRecord(value) || typeof value.stage !== "string" || typeof value.decisionTask !== "string"
    || !evidenceStances.has(String(value.evidenceStance))) return undefined;
  const knowledge = stringArray(value.knowledge);
  const constraints = stringArray(value.constraints);
  if (!knowledge || !constraints) return undefined;
  return {
    stage: value.stage,
    knowledge,
    constraints,
    decisionTask: value.decisionTask,
    evidenceStance: value.evidenceStance as NonNullable<ContentPackageContent["Cref"]["threads"][number]["roleCard"]>["evidenceStance"],
  };
}

function densityProxy(value: unknown): ContentPackageContent["Cref"]["threads"][number]["densityProxy"] {
  if (!isRecord(value) || value.primaryGapCount !== 1 || value.expectedReplyComponents !== 5) return undefined;
  const numbers = [value.auxiliaryDimensionCount, value.roleDimensionCount, value.constraintCount, value.questionTargetChars];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return undefined;
  return {
    primaryGapCount: 1,
    auxiliaryDimensionCount: value.auxiliaryDimensionCount as number,
    roleDimensionCount: value.roleDimensionCount as number,
    constraintCount: value.constraintCount as number,
    expectedReplyComponents: 5,
    questionTargetChars: value.questionTargetChars as number,
  };
}

function replyPlan(value: unknown): ContentPackageContent["Cref"]["threads"][number]["replyPlan"] {
  if (!isRecord(value)) return undefined;
  const keys = ["directAnswer", "condition", "boundary", "unknown", "nextQuestion"] as const;
  if (!keys.every((key) => typeof value[key] === "string" && (value[key] as string).trim())) return undefined;
  return {
    directAnswer: (value.directAnswer as string).trim(),
    condition: (value.condition as string).trim(),
    boundary: (value.boundary as string).trim(),
    unknown: (value.unknown as string).trim(),
    nextQuestion: (value.nextQuestion as string).trim(),
  };
}

function discoveryPlan(value: unknown): ContentPackageContent["Cref"]["threads"][number]["discoveryPlan"] {
  // M7 convergence: accept a streamlined discoveryPlan. Only `boundary` (the field the
  // false-closure safety check anchors on) is required; the remaining discovery
  // scaffolding is optional. A record without a usable boundary is treated as absent
  // (=> `comment_discovery_plan_missing` warning downstream, never an error).
  if (!isRecord(value) || typeof value.boundary !== "string" || !value.boundary.trim()) return undefined;
  const optionalText = (key: "cue" | "inferencePrompt" | "reveal" | "selfCheck"): string | undefined => {
    const raw = value[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  return {
    boundary: value.boundary.trim(),
    cue: optionalText("cue"),
    inferencePrompt: optionalText("inferencePrompt"),
    reveal: optionalText("reveal"),
    selfCheck: optionalText("selfCheck"),
    revealTiming: value.revealTiming === "same_thread" ? "same_thread" : undefined,
    difficulty: value.difficulty === "low" || value.difficulty === "moderate" ? value.difficulty : undefined,
  };
}

function scenarioMetadata(value: Record<string, unknown>) {
  return {
    personaRole: personaRoles.has(String(value.personaRole))
      ? value.personaRole as ContentPackageContent["Cref"]["threads"][number]["personaRole"]
      : undefined,
    speakerType: speakerTypes.has(String(value.speakerType))
      ? value.speakerType as ContentPackageContent["Cref"]["threads"][number]["speakerType"]
      : undefined,
    claimStatus: claimStatuses.has(String(value.claimStatus))
      ? value.claimStatus as ContentPackageContent["Cref"]["threads"][number]["claimStatus"]
      : undefined,
    replyTo: value.replyTo === null || typeof value.replyTo === "string" ? value.replyTo : undefined,
    threadDepth: typeof value.threadDepth === "number" && Number.isInteger(value.threadDepth) && value.threadDepth >= 0
      ? value.threadDepth
      : undefined,
    simulated: typeof value.simulated === "boolean" ? value.simulated : undefined,
    simulationLabel: typeof value.simulationLabel === "string" ? value.simulationLabel : undefined,
  };
}

function findJsonObjects(text: string): string[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(trimmed.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function modelObjectScore(value: Record<string, unknown>): number {
  const content = isRecord(value.content) ? value.content : value;
  if (isRecord(content.H) && isRecord(content.N) && isRecord(content.Cref)) return 4;
  if (Array.isArray(content.hashtags) && typeof content.title === "string" && typeof content.body === "string" && isRecord(content.comments)) return 3;
  if (["H", "N", "Cref", "evidenceIds", "reasoning", "unknowns"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) return 2;
  return 0;
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const candidates = findJsonObjects(text);
  let selected: Record<string, unknown> | undefined;
  let selectedScore = -1;
  let lastParseError: unknown;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastParseError = error;
      continue;
    }
    if (!isRecord(parsed)) continue;
    // Every parsed provider object is untrusted. Reject an abusive candidate
    // before scoring or normalization, even when later text contains a valid
    // object that would otherwise hide it.
    assertModelJsonComplexity(parsed);
    const score = modelObjectScore(parsed);
    if (score >= selectedScore) {
      selected = parsed;
      selectedScore = score;
    }
  }
  if (selected) return selected;
  if (candidates.length && lastParseError) {
    throw new Error(`Model output was not valid JSON: ${lastParseError instanceof Error ? lastParseError.message : String(lastParseError)}`);
  }
  throw new Error("Model output did not contain a complete JSON object.");
}

export interface EditorialAssessmentCopy {
  status: "pass" | "review";
  reasons: string[];
  summary: string;
}

function parseEditorialAssessment(value: unknown, label: string): EditorialAssessmentCopy {
  if (!isRecord(value)
    || (value.status !== "pass" && value.status !== "review")
    || !Array.isArray(value.reasons)
    || !value.reasons.every((reason) => typeof reason === "string")
    || typeof value.summary !== "string") {
    throw new Error(`${label} must include a valid assessment.`);
  }
  return {
    status: value.status,
    reasons: value.reasons.map((reason) => reason.trim()).filter(Boolean).slice(0, 8),
    summary: value.summary.trim().slice(0, 500),
  };
}

export interface StagedCoreEditorCopy {
  core: Pick<ContentPackageContent, "H" | "N">;
  assessment: EditorialAssessmentCopy;
}

export function parseStagedCoreEditor(text: string): StagedCoreEditorCopy {
  const value = parseJsonObject(text);
  const container = isRecord(value.content) ? value.content : value;
  return {
    core: parseStagedCoreCopy(JSON.stringify(container)),
    assessment: parseEditorialAssessment(container.assessment, "Staged core editor output"),
  };
}

export function parseStagedCoreCopy(text: string): Pick<ContentPackageContent, "H" | "N"> {
  const value = parseJsonObject(text);
  const container = isRecord(value.content) ? value.content : value;
  if (!isRecord(container.H) || !isRecord(container.N)) {
    throw new Error("Staged core output must include H and N objects.");
  }
  const hashtags = stringArray(container.H.hashtags) ?? stringArray(container.H.tags);
  const imageBrief = typeof container.N.imageBrief === "string"
    ? container.N.imageBrief
    : typeof container.N.image_brief === "string" ? container.N.image_brief : "";
  if (!hashtags || typeof container.N.title !== "string" || typeof container.N.body !== "string") {
    throw new Error("Staged core output contains invalid H or N fields.");
  }
  return {
    H: { hashtags: [...new Set(hashtags.map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))] },
    N: { imageBrief: imageBrief.trim(), title: container.N.title.trim(), body: container.N.body.trim() },
  };
}

/**
 * 阶段化评论的免责声明是确定性常量:按侧+按角色隔离后,模型各调用都只写
 * 可见文案,不再输出 disclaimer;引擎在合并层统一落这个模板文本(沿用
 * parseStagedCommentCopy 的历史默认模板,业务文案不变)。
 */
export const STAGED_COMMENT_DISCLAIMER = "以下为多角色评论情景演练与发布者答疑参考模板，不代表真实用户发言、亲历口碑或已经发生的互动。";

export interface StagedCommentCopy {
  disclaimer: string;
  /** Optional publisher-owned first comment; carried only when the model produced one. */
  ownedFirstComment?: string;
  threads: Array<{
    id: string;
    question: string;
    answer: string;
    /** Optional Cref contract v1.1 fields; the engine derives positional defaults when absent. */
    kind?: CommentNodeKind;
    answerKind?: CommentNodeKind;
    boundary?: string;
    /**
     * Optional model-stated thread function (P3-15). When present and legal it
     * wins over the planning fallback; illegal values parse as absent.
     */
    function?: NonNullable<ContentPackageContent["Cref"]["threads"][number]["function"]>;
    followUps: Array<{ question: string; answer: string; kind?: CommentNodeKind; boundary?: string }>;
  }>;
}

/** 阶段化评论线程数组的共用解析:只读可见文案与可选 v1.1 标注字段。 */
function parseStagedThreadArray(container: Record<string, unknown>, errorLabel: string): StagedCommentCopy["threads"] {
  if (!Array.isArray(container.threads)) throw new Error(`${errorLabel} must include a threads array.`);
  return container.threads.map((thread, index) => {
    if (!isRecord(thread)) throw new Error(`Invalid staged comment thread at index ${index}.`);
    const question = typeof thread.question === "string" ? thread.question : thread.q;
    const answer = typeof thread.answer === "string" ? thread.answer : thread.a;
    if (typeof thread.id !== "string" || typeof question !== "string" || typeof answer !== "string") {
      throw new Error(`Invalid staged comment thread at index ${index}.`);
    }
    const followUpInput = Array.isArray(thread.followUps)
      ? thread.followUps
      : Array.isArray(thread.follow_ups) ? thread.follow_ups : [];
    const followUps = followUpInput.map((followUp, followUpIndex) => {
      if (!isRecord(followUp)) throw new Error(`Invalid staged follow-up ${followUpIndex} in thread ${thread.id}.`);
      const followQuestion = typeof followUp.question === "string" ? followUp.question : followUp.q;
      const followAnswer = typeof followUp.answer === "string" ? followUp.answer : followUp.a;
      if (typeof followQuestion !== "string" || typeof followAnswer !== "string") {
        throw new Error(`Invalid staged follow-up ${followUpIndex} in thread ${thread.id}.`);
      }
      return {
        question: followQuestion.trim(),
        answer: followAnswer.trim(),
        kind: commentNodeKind(followUp.kind),
        boundary: optionalTrimmedText(followUp.boundary),
        level: commentFollowUpLevel(followUp.level),
        stopReason: commentFollowUpStopReason(followUp.stopReason),
      };
    });
    return {
      id: thread.id,
      question: question.trim(),
      answer: answer.trim(),
      kind: commentNodeKind(thread.kind),
      answerKind: commentNodeKind(thread.answerKind),
      boundary: optionalTrimmedText(thread.boundary),
      function: commentThreadFunction(thread.function),
      followUps,
    };
  });
}

export function parseStagedCommentCopy(text: string): StagedCommentCopy {
  const value = parseJsonObject(text);
  const content = isRecord(value.content) ? value.content : undefined;
  const container = content && isRecord(content.Cref)
    ? content.Cref
    : isRecord(value.Cref) ? value.Cref : value;
  const threads = parseStagedThreadArray(container, "Staged comment output");
  return {
    disclaimer: typeof container.disclaimer === "string"
      ? container.disclaimer.trim()
      : STAGED_COMMENT_DISCLAIMER,
    ownedFirstComment: optionalTrimmedText(container.ownedFirstComment),
    threads,
  };
}

/**
 * 2A-R 读者侧输出:全部线程的 question,以及 reader_exchange 线程读者B的
 * answer(其余线程 answer 为空串,由 2A-O 机构答复填)。人物由规划层分配,
 * 模型只写可见文案,输出不再携带 roleIndex 等身份选择字段。
 */
export interface StagedCommentReadersCopy {
  threads: StagedCommentCopy["threads"];
}

export function parseStagedCommentReaders(text: string): StagedCommentReadersCopy {
  const value = parseJsonObject(text);
  const container = isRecord(value.content) ? value.content : value;
  return { threads: parseStagedThreadArray(container, "Staged comment readers output") };
}


export interface StagedCommentEditorCopy extends StagedCommentReadersCopy {
  assessment: EditorialAssessmentCopy;
}

export function parseStagedCommentEditor(text: string): StagedCommentEditorCopy {
  const value = parseJsonObject(text);
  const container = isRecord(value.content) ? value.content : value;
  return {
    threads: parseStagedThreadArray(container, "Staged comment editor output"),
    assessment: parseEditorialAssessment(container.assessment, "Staged comment editor output"),
  };
}

export interface StagedCommentNetworkEditorCopy extends StagedCommentCopy {
  assessment: EditorialAssessmentCopy;
}

export function parseStagedCommentNetworkEditor(text: string): StagedCommentNetworkEditorCopy {
  const value = parseJsonObject(text);
  const content = isRecord(value.content) ? value.content : undefined;
  const container = content && isRecord(content.Cref)
    ? content.Cref
    : isRecord(value.Cref) ? value.Cref : value;
  return {
    disclaimer: typeof container.disclaimer === "string"
      ? container.disclaimer.trim()
      : STAGED_COMMENT_DISCLAIMER,
    ownedFirstComment: optionalTrimmedText(container.ownedFirstComment),
    threads: parseStagedThreadArray(container, "Staged comment network editor output"),
    assessment: parseEditorialAssessment(container.assessment, "Staged comment network editor output"),
  };
}

/** 2A-O/2B-O 机构侧输出:本角色线程(或待承接追问)的答复列表。 */
export interface StagedOrgAnswersCopy {
  answers: Array<{
    id: string;
    answer: string;
    answerKind?: CommentNodeKind;
    boundary?: string;
  }>;
  /** 仅 publisher 答复调用可能产出;其余角色调用不读该字段。 */
  ownedFirstComment?: string;
}

export function parseStagedOrgAnswers(text: string): StagedOrgAnswersCopy {
  const value = parseJsonObject(text);
  const container = isRecord(value.content) ? value.content : value;
  if (!Array.isArray(container.answers)) throw new Error("Staged org answers output must include an answers array.");
  const answers = container.answers.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.answer !== "string") {
      throw new Error(`Invalid staged org answer at index ${index}.`);
    }
    return {
      id: entry.id,
      answer: entry.answer.trim(),
      answerKind: commentNodeKind(entry.answerKind),
      boundary: optionalTrimmedText(entry.boundary),
    };
  });
  return { answers, ownedFirstComment: optionalTrimmedText(container.ownedFirstComment) };
}

function answerRealization(value: unknown): ContentPackageContent["Cref"]["threads"][number]["answerRealization"] {
  if (!isRecord(value)) return undefined;
  const availability = String(value.availability);
  if (!["generated", "withheld_no_evidence", "withheld_unsupported", "failed_provider", "rejected_contract", "not_applicable"].includes(availability)) return undefined;
  const stage = typeof value.stage === "string" && ["reader_exchange", "org_answer", "host_answer", "comment_network", "preview"].includes(value.stage)
    ? value.stage as NonNullable<ContentPackageContent["Cref"]["threads"][number]["answerRealization"]>["stage"]
    : undefined;
  return {
    availability: availability as NonNullable<ContentPackageContent["Cref"]["threads"][number]["answerRealization"]>["availability"],
    ...(typeof value.reasonCode === "string" && value.reasonCode.trim() ? { reasonCode: value.reasonCode.trim() } : {}),
    ...(stage ? { stage } : {}),
  };
}

function parseContent(value: unknown): ContentPackageContent {
  if (!isRecord(value) || !isRecord(value.H) || !isRecord(value.N) || !isRecord(value.Cref)) {
    throw new Error("Generation output must include content.H, content.N and content.Cref objects.");
  }
  const hashtags = stringArray(value.H.hashtags) ?? stringArray(value.H.tags);
  const imageBrief = typeof value.N.imageBrief === "string"
    ? value.N.imageBrief
    : typeof value.N.image_brief === "string" ? value.N.image_brief : "";
  if (!hashtags || typeof value.N.title !== "string" || typeof value.N.body !== "string") {
    throw new Error("Generation output contains invalid H or N fields.");
  }
  if (!Array.isArray(value.Cref.threads)) throw new Error("Generation output contains invalid Cref fields.");
  const disclaimer = typeof value.Cref.disclaimer === "string"
    ? value.Cref.disclaimer
    : "以下为评论区问答参考模板，不代表真实用户发言或已经发生的经历。";
  const threads = value.Cref.threads.map((thread, index) => {
    if (!isRecord(thread)) {
      throw new Error(`Invalid comment reference thread at index ${index}.`);
    }
    const id = typeof thread.id === "string" ? thread.id : `thread_${index + 1}`;
    const question = typeof thread.question === "string" ? thread.question : thread.q;
    const answer = typeof thread.answer === "string" ? thread.answer : thread.a;
    if (typeof question !== "string" || typeof answer !== "string") {
      throw new Error(`Invalid comment reference thread at index ${index}.`);
    }
    const evidenceIds = stringArray(thread.evidenceIds) ?? [];
    const sourceClusterIds = stringArray(thread.sourceClusterIds) ?? [];
    const followUpInput = Array.isArray(thread.followUps)
      ? thread.followUps
      : Array.isArray(thread.follow_ups) ? thread.follow_ups : [];
    const followUps = followUpInput.map((followUp, followUpIndex) => {
      if (!isRecord(followUp)) throw new Error(`Invalid follow-up ${followUpIndex} in comment thread ${id}.`);
      const followQuestion = typeof followUp.question === "string" ? followUp.question : followUp.q;
      const followAnswer = typeof followUp.answer === "string" ? followUp.answer : followUp.a;
      if (typeof followQuestion !== "string" || typeof followAnswer !== "string") {
        throw new Error(`Invalid follow-up ${followUpIndex} in comment thread ${id}.`);
      }
      return {
        id: typeof followUp.id === "string" ? followUp.id : undefined,
        question: followQuestion,
        answer: followAnswer,
        evidenceIds: stringArray(followUp.evidenceIds) ?? [],
        kind: commentNodeKind(followUp.kind),
        boundary: optionalTrimmedText(followUp.boundary),
        level: commentFollowUpLevel(followUp.level),
        stopReason: commentFollowUpStopReason(followUp.stopReason),
        ...scenarioMetadata(followUp),
      };
    });
    const postingIdentity = ["author", "brand", "staff", "expert", "reader_question_template", "publisher"].includes(String(thread.postingIdentity))
      ? thread.postingIdentity as ContentPackageContent["Cref"]["threads"][number]["postingIdentity"]
      : "reader_question_template";
    return {
      id,
      question,
      answer,
      followUps,
      postingIdentity,
      sourceClusterIds,
      evidenceIds,
      kind: commentNodeKind(thread.kind),
      answerKind: commentNodeKind(thread.answerKind),
      boundary: optionalTrimmedText(thread.boundary),
      stage: typeof thread.stage === "string" ? thread.stage : undefined,
      gap: typeof thread.gap === "string" ? thread.gap : undefined,
      function: commentThreadFunction(thread.function),
      nextStep: typeof thread.nextStep === "string" ? thread.nextStep : undefined,
      roleCard: roleCard(thread.roleCard),
      primaryGapId: typeof thread.primaryGapId === "string" ? thread.primaryGapId : undefined,
      auxiliaryGapIds: stringArray(thread.auxiliaryGapIds),
      densityProxy: densityProxy(thread.densityProxy),
      replyPlan: replyPlan(thread.replyPlan),
      discoveryPlan: discoveryPlan(thread.discoveryPlan),
      surfaceRoleCard: surfaceRoleCard(thread.surfaceRoleCard),
      questionContext: questionContext(thread.questionContext),
      replySurfaceRoleCard: surfaceRoleCard(thread.replySurfaceRoleCard),
      displayName: optionalTrimmedText(thread.displayName),
      replyDisplayName: optionalTrimmedText(thread.replyDisplayName),
      answerIdentity: thread.answerIdentity === "simulated_reader" || thread.answerIdentity === "none"
        || ["author", "brand", "staff", "expert", "publisher"].includes(String(thread.answerIdentity))
        ? thread.answerIdentity as ContentPackageContent["Cref"]["threads"][number]["answerIdentity"]
        : undefined,
      answerRealization: answerRealization(thread.answerRealization),
      threadKind: thread.threadKind === "host_reply"
        ? "host_reply" as const
        : thread.threadKind === "reader_exchange"
          ? "reader_exchange" as const
          : thread.threadKind === "organic_reaction"
            ? "organic_reaction" as const
            : thread.threadKind === "org_answer" ? "org_answer" as const : undefined,
      authorFactIds: stringArray(thread.authorFactIds) ?? undefined,
      topicAnchorGapId: optionalTrimmedText(thread.topicAnchorGapId),
      ...scenarioMetadata(thread),
    };
  });
  return {
    H: { hashtags: [...new Set(hashtags.map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))] },
    N: { imageBrief: imageBrief.trim(), title: value.N.title.trim(), body: value.N.body.trim() },
    // ownedFirstComment is model-visible copy, so it round-trips here.
    // uncoveredGaps is deliberately NOT parsed: it is engine-derived plan
    // provenance and must never be sourced from model text.
    Cref: { disclaimer: disclaimer.trim(), threads, ownedFirstComment: optionalTrimmedText(value.Cref.ownedFirstComment) },
  };
}

function parseUnknowns(value: unknown): UnknownItem[] {
  if (!Array.isArray(value)) throw new Error("Generation output unknowns must be an array.");
  return value.map((item, index) => {
    if (typeof item === "string") {
      return {
        id: `model_unknown_${index + 1}`,
        key: `model_output.unknown_${index + 1}`,
        question: item,
        reason: "模型把该项标记为未知，但没有提供完整结构，需要人工核验。",
        impact: "medium" as const,
        requiredFor: [],
      };
    }
    if (!isRecord(item)) throw new Error(`Invalid unknown item at index ${index}.`);
    const id = typeof item.id === "string" ? item.id : `model_unknown_${index + 1}`;
    const key = typeof item.key === "string" ? item.key : `model_output.unknown_${index + 1}`;
    const question = typeof item.question === "string"
      ? item.question
      : typeof item.statement === "string" ? item.statement : `模型标记了第 ${index + 1} 项未决信息`;
    const reason = typeof item.reason === "string" ? item.reason : "模型未提供完整的未知原因，需要人工核验。";
    const impact = ["low", "medium", "high"].includes(String(item.impact)) ? item.impact as UnknownItem["impact"] : "medium";
    return { id, key, question, reason, impact, requiredFor: stringArray(item.requiredFor) ?? [] };
  });
}

function compatibleContentShape(value: Record<string, unknown>): unknown {
  if (value.content !== undefined) return value.content;
  if (value.H !== undefined || value.N !== undefined || value.Cref !== undefined) return value;
  if (!Array.isArray(value.hashtags) || typeof value.title !== "string" || typeof value.body !== "string" || !isRecord(value.comments)) {
    return value;
  }
  const image = isRecord(value.image) ? value.image : {};
  const imageBrief = typeof image.brief === "string"
    ? image.brief
    : typeof image.note === "string" ? image.note : typeof value.image === "string" ? value.image : "";
  return {
    H: { hashtags: value.hashtags },
    N: { imageBrief, title: value.title, body: value.body },
    Cref: value.comments,
  };
}

function compatibleEvidenceIds(value: Record<string, unknown>): string[] {
  const direct = stringArray(value.evidenceIds);
  if (direct) return direct;
  if (!Array.isArray(value.evidenceReferences)) return [];
  return value.evidenceReferences.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
}

function compatibleReasoning(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.reasoning)) return value.reasoning;
  const bodyEvidence = Array.isArray(value.bodyEvidence) ? value.bodyEvidence : [];
  const hypotheses = Array.isArray(value.hypotheses) ? value.hypotheses : [];
  return [
    ...bodyEvidence.flatMap((item) => {
      if (!isRecord(item)) return [];
      const statement = typeof item.claim === "string" ? item.claim : item.statement;
      if (typeof statement !== "string") return [];
      const evidenceIds = stringArray(item.evidenceIds) ?? [];
      const conditions = typeof item.conditions === "string" && item.conditions ? `；条件：${item.conditions}` : "";
      return [{ statement: `${statement}${conditions}`, status: evidenceIds.length ? "fact" : "unknown", evidenceIds }];
    }),
    ...hypotheses.flatMap((item) => {
      if (typeof item === "string") return [{ statement: item, status: "hypothesis", evidenceIds: [] }];
      if (!isRecord(item)) return [];
      const statement = typeof item.statement === "string" ? item.statement : item.text;
      if (typeof statement !== "string") return [];
      const basis = typeof item.basis === "string" && item.basis ? `；依据说明：${item.basis}` : "";
      return [{ statement: `${statement}${basis}`, status: "hypothesis", evidenceIds: stringArray(item.evidenceIds) ?? [] }];
    }),
  ];
}

export function parseGenerationDraft(text: string): GenerationDraft {
  const value = parseJsonObject(text);
  // Some OpenAI-compatible gateways accept JSON Schema but omit optional-looking
  // top-level ledgers. Missing ledgers are never promoted to facts: preserve an
  // explicit high-impact unknown so the UI and validators surface the gap.
  const evidenceIds = compatibleEvidenceIds(value);
  const reasoningInput = compatibleReasoning(value);
  const hasEvidenceLedger = Array.isArray(value.evidenceIds) || Array.isArray(value.evidenceReferences);
  const hasReasoningLedger = Array.isArray(value.reasoning) || Array.isArray(value.bodyEvidence) || Array.isArray(value.hypotheses);
  const ledgerMissing = !hasEvidenceLedger || !hasReasoningLedger;
  const reasoning = reasoningInput.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid reasoning item at index ${index}.`);
    }
    const statement = typeof item.statement === "string" ? item.statement : typeof item.claim === "string" ? item.claim : item.text;
    if (typeof statement !== "string") throw new Error(`Invalid reasoning item at index ${index}.`);
    const status = ["fact", "sample", "inference", "hypothesis", "unknown"].includes(String(item.status))
      ? item.status as GenerationDraft["reasoning"][number]["status"]
      : "unknown";
    const location = reasoningLocations.has(String(item.location))
      ? item.location as GenerationDraft["reasoning"][number]["location"]
      : undefined;
    const sourceSpans = Array.isArray(item.sourceSpans)
      ? item.sourceSpans.map((span, spanIndex) => {
        if (!isRecord(span) || typeof span.evidenceId !== "string" || typeof span.quote !== "string") {
          throw new Error(`Invalid source span ${spanIndex} in reasoning item ${index}.`);
        }
        return { evidenceId: span.evidenceId, quote: span.quote };
      })
      : [];
    const occurrence = isRecord(item.occurrence)
      && ["hashtags", "imageBrief", "title", "body", "question", "answer", "nextStep"].includes(String(item.occurrence.field))
      ? {
        field: item.occurrence.field as NonNullable<ContentReasoningEntry["occurrence"]>["field"],
        ...(typeof item.occurrence.threadId === "string" ? { threadId: item.occurrence.threadId } : {}),
        ...(Number.isInteger(item.occurrence.followUpIndex) ? { followUpIndex: Number(item.occurrence.followUpIndex) } : {}),
      }
      : undefined;
    return {
      statement,
      status,
      evidenceIds: stringArray(item.evidenceIds) ?? [],
      ...(location ? { location } : {}),
      ...(occurrence ? { occurrence } : {}),
      sourceSpans,
      ...(item.semanticSupport === "ai_judged" ? { semanticSupport: "ai_judged" as const } : {}),
    };
  });
  const unknowns = Array.isArray(value.unknowns) ? parseUnknowns(value.unknowns) : [];
  if (ledgerMissing || !Array.isArray(value.unknowns)) {
    unknowns.push({
      id: "model_epistemic_ledger_missing",
      key: "model_output.epistemic_ledger",
      question: "模型没有完整返回证据、推理或未知信息台账，正文中的事实性表述需要人工复核。",
      reason: "兼容模型未完全遵循结构化输出 Schema；系统没有把缺失字段补成事实。",
      impact: "high",
      requiredFor: ["publish_review"],
    });
  }
  return {
    content: parseContent(compatibleContentShape(value)),
    evidenceIds: [...new Set(evidenceIds)],
    reasoning,
    unknowns,
  };
}

export interface DraftValidationInput {
  draft: GenerationDraft;
  config: ResolvedGenerationConfig;
  ledger: KnowledgeLedger;
  allowedEvidenceIds: string[];
  /** Exact disclosed source text keyed by allowed evidence ID. */
  evidenceSources: Record<string, string>;
  /** Full source identity is required to prevent inference/unknown/case material becoming fact. */
  evidenceReferences?: EvidenceReference[];
  orchestrationPlan?: OrchestrationPlan;
  projectBlueprint?: ProjectCreativeBlueprint;
}

function allContentText(content: ContentPackageContent): string {
  return [
    content.H.hashtags.join(" "),
    content.N.imageBrief,
    content.N.title,
    content.N.body,
    content.Cref.disclaimer,
    content.Cref.ownedFirstComment ?? "",
    ...content.Cref.threads.flatMap((thread) => [
      thread.question,
      thread.answer,
      thread.boundary ?? "",
      thread.nextStep ?? "",
      ...thread.followUps.flatMap((item) => [item.question, item.answer, item.boundary ?? ""]),
    ]),
  ].join("\n");
}

/** Public comment strings, including fields rendered outside the Q/A bubbles. */
function visibleCommentNodes(content: ContentPackageContent): string[] {
  return [
    content.Cref.disclaimer,
    content.Cref.ownedFirstComment ?? "",
    ...content.Cref.threads.flatMap((thread) => [
      thread.question,
      thread.answer,
      thread.boundary ?? "",
      thread.nextStep ?? "",
      ...thread.followUps.flatMap((followUp) => [
        followUp.question,
        followUp.answer,
        followUp.boundary ?? "",
      ]),
    ]),
  ].map((value) => value.trim()).filter(Boolean);
}

const INTERNAL_PLANNING_LANGUAGE = /\bevidence_[\w:.-]+\b|(?:sourceClusterId|reasoning|replyPlan|discoveryPlan|followUpIntent)|(?:本线程|该线程|线程内)|(?:待核实维度|已披露地点范围)[：:]|(?:问题职责|开口人物|角色池|线程规格|冻结(?:合同|职责|ID)|主缺口|接龙方向|后台库存)|\b(?:TODO|TBD)\b/iu;

const MODEL_OR_OUTPUT_PROTOCOL_LANGUAGE = /(?:作为|我是|身为)(?:一名|一个)?\s*(?:AI|人工智能)\s*(?:助手|语言模型)|(?:系统|开发者)指令|提示词|system\s*prompt|(?:根据|按照)(?:当前|上述|本次|用户)?(?:的)?(?:生成|写作|内容)?任务要求|候选(?:版本)?\s*[一二三四五六七八九十\d]+|只(?:需|要)?返回(?:有效的?)?\s*JSON|(?:JSON\s*)?(?:输出格式|字段名)|(?:生成|写作|内容)任务/iu;

const INTERNAL_SOURCE_CONTAINER_LANGUAGE = /(?:根据|依据|参考|来自|按照?)\s*(?:源资料|知识库|项目资料|可用证据)|(?:源资料|知识库|项目资料|可用证据)(?:中|里|显示|表明|写(?:明|着|了)?|说|提到|记载|披露)|本条所列证据来源/iu;

// Writer-facing policy is an audit/control artifact, not publishable prose.
// Natural reader limitations such as “具体以当期确认为准” are intentionally
// absent; this catches imperative copy-writing rules and house-style labels.
const FRONTSTAGE_POLICY_INSTRUCTION_LANGUAGE = /(?:不允许|不得|禁止|不能|避免|不要)(?:在.{0,8})?(?:写|说|使用|出现|宣称|表述)|(?:需|必须|应当|应该)保留(?:个体差异|限定语|适用边界)|(?:禁用|统一口径|表达红线|内部口径)/u;

// Only phrases that explicitly point back to the current generated artifact are
// context narration. Generic human speech such as “看了几个帖子，说法都不一样”
// is legitimate research context and must not be blocked.
const COMMENT_CONTEXT_META_LANGUAGE = /(?:(?:正文|文中|上文|文章(?:里|中)?|这篇(?:笔记|帖子|内容|文章)?|这条(?:笔记|帖子|内容)|这个帖子)(?:里|中)?(?:说|提到|写(?:了|着|道)?|讲(?:了|到)?|显示|表示|说明|没(?:有)?(?:写|提|讲|说明)|未(?:写|提|讲|说明))|(?:跟|和|按)(?:这篇|这个)帖子(?:里|中)?说)/u;

const GENERIC_COMMENT_SOURCE_LANGUAGE = /(?:根据|依据|按照|按|看|查(?:到|过)?|翻(?:到|过)?)?\s*(?:这些|相关|现有|手头|查到的)?资料(?:里|中)?(?:说|称|显示|表明|写(?:明|着|了)?|提到|记载|披露)/u;

function exposesGenericCommentSourceLanguage(value: string): boolean {
  if (INTERNAL_SOURCE_CONTAINER_LANGUAGE.test(value)) return true;
  // Named public sources are legitimate provenance, not internal containers.
  const withoutNamedPublicSources = value.replace(
    /(?:官网|官方网站|合同|协议|病历|检查报告|说明书)(?:中|里|上)?(?:写(?:明|着|了)?|显示|记录|注明|约定|说明|提到)/gu,
    "",
  );
  return GENERIC_COMMENT_SOURCE_LANGUAGE.test(withoutNamedPublicSources);
}

function visibleTextForReasoningLocation(
  content: ContentPackageContent,
  location: GenerationDraft["reasoning"][number]["location"],
): string {
  switch (location) {
    case "H": return content.H.hashtags.join("\n");
    case "N.imageBrief": return content.N.imageBrief;
    case "N.title": return content.N.title;
    case "N.body": return content.N.body;
    case "Cref.thread": return content.Cref.threads
      .flatMap((thread) => [thread.question, thread.answer, thread.nextStep ?? ""])
      .join("\n");
    case "Cref.followUp": return content.Cref.threads
      .flatMap((thread) => thread.followUps.flatMap((followUp) => [followUp.question, followUp.answer]))
      .join("\n");
    default: return "";
  }
}

function visibleTextForReasoningEntry(content: ContentPackageContent, item: ContentReasoningEntry): string | undefined {
  if (!item.occurrence) return visibleTextForReasoningLocation(content, item.location);
  const { field, threadId, followUpIndex } = item.occurrence;
  if (item.location === "H" && field === "hashtags") return content.H.hashtags.join("\n");
  if (item.location === "N.imageBrief" && field === "imageBrief") return content.N.imageBrief;
  if (item.location === "N.title" && field === "title") return content.N.title;
  if (item.location === "N.body" && field === "body") return content.N.body;
  if ((item.location === "Cref.thread" || item.location === "Cref.followUp") && threadId) {
    const thread = content.Cref.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return undefined;
    if (item.location === "Cref.thread") {
      if (field === "question") return thread.question;
      if (field === "answer") return thread.answer;
      if (field === "nextStep") return thread.nextStep ?? "";
      return undefined;
    }
    const followUp = Number.isInteger(followUpIndex) ? thread.followUps[followUpIndex!] : undefined;
    if (!followUp) return undefined;
    if (field === "question") return followUp.question;
    if (field === "answer") return followUp.answer;
  }
  return undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

interface VisibleFactCandidate {
  location: NonNullable<GenerationDraft["reasoning"][number]["location"]>;
  statement: string;
}

function visibleFactCandidates(draft: GenerationDraft, config: ResolvedGenerationConfig): VisibleFactCandidate[] {
  const candidates: VisibleFactCandidate[] = [];
  const addSegments = (location: VisibleFactCandidate["location"], text: string): void => {
    const segments = text.split(/(?<=[。！？!?；;\n])/u).map((item) => item.trim()).filter((item) => item.length >= 2);
    for (const statement of segments) {
      const hasMeasuredClaim = /\d+(?:\.\d+)?\s*(?:%|％|元|万|天|周|月|年|次|例|人|毫米|厘米|mm|cm)/iu.test(statement);
      const hasSourceAssertion = /(?:(?:项目资料|知识库|研究|论文|报告).{0,16}(?:显示|表明|确认|记载|披露)|(?:项目方|服务方|产品|技术).{0,16}(?:采用|使用|具备|来自|属于))/u.test(statement);
      const hasOrdinaryAssertion = /(?:是|属于|源于|来自|取决于|包含|具有|采用|使用|存在|分为|由.{0,24}(?:导致|形成|构成)|会(?:导致|形成|影响|增加|减少)|能够)/u.test(statement);
      const explicitlyUncertain = /(?:未知|待核实|不能确定|无法确定|可能|假设|示例|仅供参考)/u.test(statement);
      const looksLikeGuidance = /^(?:先|要先|得先|最好|请|建议|可以|应当|应该|需要|记得|尽量|不妨|下一步)/u.test(statement);
      const isQuestion = /[？?]$/u.test(statement);
      const containsQuestionIntent = /(?:想问|问清楚|最该问|到底|怎么|怎样|什么|哪些|几天|能不能|可不可以|合不合适)/u.test(statement);
      const isConversationalReaction = /^(?:嗯|哦|噢|啊|那我|这个倒是|对[呀啊，,。]|是的[，,。]|哈哈|唉|懂了|确实|同感|太真实了|还是不敢)/u.test(statement)
        && !hasMeasuredClaim && !hasSourceAssertion;
      if ((hasMeasuredClaim || hasSourceAssertion || hasOrdinaryAssertion) && !explicitlyUncertain && !looksLikeGuidance && !isQuestion && !containsQuestionIntent && !isConversationalReaction) {
        candidates.push({ location, statement });
      }
    }
  };
  // Hashtags, titles and image production briefs are routing/creative
  // instructions, not ordinary factual prose. Exact configured project facts
  // remain covered by the explicitProjectFacts pass below.
  addSegments("N.body", draft.content.N.body);
  addSegments("Cref.thread", draft.content.Cref.threads.flatMap((thread) => [thread.answer, thread.nextStep ?? ""]).join("\n"));
  addSegments("Cref.followUp", draft.content.Cref.threads.flatMap((thread) => thread.followUps.map((item) => item.answer)).join("\n"));

  const fullText = allContentText(draft.content);
  const explicitProjectFacts = [...config.project.productPoints, ...config.project.organizationPoints]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && fullText.includes(item));
  for (const fact of explicitProjectFacts) {
    const location = (["H", "N.imageBrief", "N.title", "N.body", "Cref.thread", "Cref.followUp"] as const)
      .find((candidateLocation) => visibleTextForReasoningLocation(draft.content, candidateLocation).includes(fact));
    if (location) candidates.push({ location, statement: fact });
  }
  return candidates.filter((candidate, index, all) =>
    all.findIndex((item) => item.location === candidate.location && item.statement === candidate.statement) === index,
  );
}

function normalizedComparable(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function meaningfulTextOverlap(left: string, right: string, threshold = 0.32): boolean {
  const leftValue = normalizedComparable(left);
  const rightValue = normalizedComparable(right);
  if (leftValue.length < 4 || rightValue.length < 4) return false;
  if (leftValue.includes(rightValue) || rightValue.includes(leftValue)) return true;
  const pairs = (value: string): Set<string> => new Set(
    Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2)),
  );
  const leftPairs = pairs(leftValue);
  const rightPairs = pairs(rightValue);
  const overlap = [...leftPairs].filter((pair) => rightPairs.has(pair)).length;
  return overlap / Math.max(1, Math.min(leftPairs.size, rightPairs.size)) >= threshold;
}

/** Small domain-neutral equivalence sets used only to verify conversational continuity. */
const CONVERSATION_TOPIC_EQUIVALENTS: readonly (readonly string[])[] = [
  ["全称", "名称", "名字", "机构名", "项目名"],
  ["地址", "位置", "路线", "怎么去", "在哪"],
  ["预约", "约上", "约到", "排期", "档期"],
  ["价格", "费用", "预算", "多少钱", "报价"],
  ["恢复", "上班", "见人", "请假", "肿"],
  ["资质", "证照", "备案", "许可证"],
  ["疼", "痛", "麻药", "麻醉"],
  ["效果", "结果", "改善", "变化"],
];

function sharesConversationTopic(left: string, right: string): boolean {
  if (meaningfulTextOverlap(left, right, 0.24)) return true;
  return CONVERSATION_TOPIC_EQUIVALENTS.some((group) =>
    group.some((term) => left.includes(term)) && group.some((term) => right.includes(term)));
}

/**
 * A short echo may continue the previous emotion without repeating its noun.
 * Keep this deliberately closed: any concrete object, claim, action or pivot
 * falls back to the normal topic-overlap gate.
 */
function isPureShortConversationEcho(value: string): boolean {
  const compact = value.trim().replace(/[。！？!?]+$/u, "");
  if ([...compact].length > 16 || /(?:不过|但是|可我|更想|最怕|话说回来)/u.test(compact)) return false;
  return /^(?:同问|同感|这个我也|我也|也是|确实|对啊|\+1|蹲一个)[，, ]*(?:我)?(?:也|还)?(?:没想明白|没想好|没敢定|不敢定|拿不准|在纠结|纠结中|没定|不确定|先等等看|再等等看|先看看|再看看)?$/u.test(compact);
}

/** Read-only continuity check used by editors and validators. */
function missingExplicitTopicClauses(theme: string, visible: string): string[] {
  const clauses = theme.split(/[，,。！？!?；;：:]/u)
    .map((clause) => clause.replace(/^(?:请问|想问|关于)/u, "").replace(/(?:先)?(?:确认|了解|看看|怎么办|什么)$/u, "").trim())
    .filter((clause) => normalizedComparable(clause).length >= 4);
  if (clauses.length < 2) return [];
  return clauses.filter((clause) => !meaningfulTextOverlap(clause, visible, 0.24));
}

export function readerExchangeContinuesTopic(question: string, answer: string): boolean {
  if (!question.trim() || !answer.trim()) return false;
  const pivotTail = answer.split(/(?:不过|但是|可我|更想|最怕|话说回来)/u).at(-1)?.trim() ?? "";
  const pivotDrifts = pivotTail !== answer.trim()
    && pivotTail.length >= 4
    && !sharesConversationTopic(question, pivotTail);
  return (sharesConversationTopic(question, answer) || isPureShortConversationEcho(answer)) && !pivotDrifts;
}

/** A consumer carrier may ask about organization-controlled information but may not state it for the organization. */
function consumerBodyStatesOrganizationFact(
  body: string,
  cards: readonly InformationGapPlanningCard[],
): { statement: string; card: InformationGapPlanningCard } | undefined {
  const statements = splitSensitiveStatements(body).filter((statement) => !/[？?]$/u.test(statement));
  for (const card of cards.filter((item) => item.disclosureScope === "organization_only")) {
    const factualSurfaces = [card.answer, card.framework]
      .filter((item): item is string => Boolean(item?.trim()));
    for (const statement of statements) {
      const comparableStatement = normalizedComparable(statement);
      const statesSpecificFact = factualSurfaces.some((surface) => {
        const comparableSurface = normalizedComparable(surface);
        return sharesContiguousFragment(comparableStatement, comparableSurface, 4)
          || meaningfulTextOverlap(statement, surface, 0.4);
      });
      if (statesSpecificFact) return { statement, card };
    }
  }
  return undefined;
}

/** Future service actions are claims about what the organization will do, not neutral uncertainty. */
function ungroundedOrganizationServiceCommitment(value: string): string | undefined {
  return splitSensitiveStatements(value).find((statement) => {
    // "当前无法确认 / 没法给您确认" preserves an unknown; it is the exact
    // opposite of promising a future action and must never be classified as one.
    if (/(?:无法|没法|不能|不(?:能|会|可以)|暂时无法|当前无法|目前无法|尚无法).{0,12}(?:确认|核实|回复|联系|预约|对接|安排|发送|提供)/u.test(statement)) return false;
    return /(?:我|我们|这边|助理|工作人员).{0,10}(?:帮|会|可以|给|替).{0,10}(?:确认|核实|回复|回在|回你|私信|联系|预约|对接|安排|发送|发给|发在|跟进)/u.test(statement)
      || /(?:确认好|核实好|问清楚).{0,10}(?:回复|回在|回你|私信|联系|发给|发在)/u.test(statement)
      || /(?:预约|位置|路线|停车|档期).{0,8}(?:可以|能).{0,8}(?:帮|对接|安排|确认)/u.test(statement);
  });
}

/**
 * A confirmed author fact may be quoted verbatim or shortened, but it may not
 * authorize extra words that could introduce another time, action or outcome.
 */
export function authorFactAuthorizesVisibleStatement(statement: string, factStatement: string): boolean {
  const visible = normalizedComparable(statement);
  const fact = normalizedComparable(factStatement);
  if (visible.length < 2 || fact.length < 2) return false;
  if (visible === fact) return true;
  return fact.includes(visible)
    && visible.length >= 4
    && visible.length >= Math.ceil(fact.length * 0.5);
}

/**
 * 经历类禁语的**唯一真源**:项目蓝图。合并场景家族的
 * prohibitedUnsupportedHistories 与 claimType=historical_action 的 rule terms。
 *
 * 校验层不再自带跨行业词表。复购类身份声明("老用户"这类)算不算不当声明取决于
 * 项目的服务模型与领域:recurring/mixed 项目里它是需要证据支撑的身份声明;
 * one_time 项目里这种说法本就不该出现;另一些领域里它只是中性说法。这个判断由
 * 项目分析阶段按项目资料产出并填进蓝图,不由校验层猜——静态校验层不得内置任何
 * 单一领域的词表假设。
 */
function prohibitedHistoryTerms(blueprint: ProjectCreativeBlueprint): string[] {
  return [
    ...blueprint.scenarioModel.families.flatMap((family) => family.prohibitedUnsupportedHistories),
    ...blueprint.claimPolicy.rules
      .filter((rule) => rule.claimType === "historical_action")
      .flatMap((rule) => rule.terms),
  ].filter(Boolean);
}

/**
 * 蓝图禁语命中判定。词表(触发面)仍然只来自蓝图——本函数不新增任何领域词,只判断
 * **命中处是不是在声称该经历**。
 *
 * 起因是真实误报:one_time 项目的蓝图把「续费/复购」列为禁止声称,而评论照实转述
 * 服务边界——「服务是一次性的,一个申请季结束就完结,没有续费或复购」——被判
 * fabricated_operational_experience。禁语出现在**否定或口径陈述**里时,说话人是在
 * 排除该经历,不是在声称它;裸 includes 无法区分,于是把正确的边界说明也拦了。
 *
 * 同文件的 claimsFirstPersonCompletion 早已按这个思路给"我…了/过"加了否定与未来式
 * 护栏,这里补齐同一标准:只在禁语前方近距离出现否定/无化标记时排除该命中。判断的
 * 是局部否定,不是句子语义——语义归模型与判官,校验层只做这一层不可让位的硬门槛。
 */
function assertsProhibitedHistory(node: string, prohibitedHistories: string[]): boolean {
  return prohibitedHistories.some((term) => {
    if (!term) return false;
    for (let index = node.indexOf(term); index >= 0; index = node.indexOf(term, index + 1)) {
      // 否定在中文里作用于**整个小句**,不是固定字数窗口:"不会有后续费用或续费"
      // 里"续费"离"不会"有 8 个字,却仍在否定范围内。因此只回看到最近的句读为止
      // ——小句内出现否定/无化标记就算被排除,跨句不算,这样"我复购过,不过没续费"
      // 的前半句仍会被拦。
      const clauseStart = Math.max(...[..."。！？!?；;，,、"].map((mark) => node.lastIndexOf(mark, index - 1))) + 1;
      const lead = node.slice(Math.max(0, clauseStart), index);
      if (/(?:没有|没|不|无需|无|非|未|免)/u.test(lead)) continue;
      return true;
    }
    return false;
  });
}

/**
 * Domain-neutral first-person intent vocabulary (generic language patterns
 * only — no industry terms). A body containing one of these marks the host as
 * still intending/undecided rather than reporting a completed experience.
 */
const hostIntentPattern = /(?:打算|准备|想要|想去|纠结|考虑|还没|没有去|刷到|心动)/u;

/**
 * Domain-neutral first-person completed-action heuristic. A match means the
 * speaker asserts a finished first-person action ("我已经…", "我之前…过").
 * Negated, quoted or forward-looking uses ("我还没…了", "等…了再…", "跟我说…")
 * do not count as completion claims; without those guards every cautious
 * "not yet" reply would look like a completed experience.
 *
 * Cognitive/perceptual verbs ("刚注意到", "看过了", "明白了") report awareness,
 * not an operational history, and never count — otherwise a harmless
 * "我也只是刚注意到" is misread as a completed project action.
 */
const firstPersonPerceptionWords = /(?:注意|看到|看见|听到|听说|想到|知道|觉得|感觉|明白|意识|发现|记得|想起|懂)/u;

function claimsFirstPersonCompletion(text: string): boolean {
  for (const match of text.matchAll(/我(.{0,28}?)(已经|刚|上周|昨天|之前|过|完|了)/gu)) {
    const middle = match[1] ?? "";
    // 机构第一人称复数("我们/我方")不是顾客亲历:发布账号、工作人员与专业人员
    // 都以真实公开身份作答,"我们上周已经把当期口径更新了""我们的档期排到下月"
    // 是正当的组织侧陈述。这里排除的是 我 与 我们 的分词歧义,不是按词表猜语义
    // ——"我"后紧跟"们/方"时,主语是机构而非说话人自己的消费经历。
    if (/^[们方]/u.test(middle)) continue;
    if (/[没未不等说问想怕]/u.test(middle)) continue;
    const marker = match[2] ?? "";
    const afterIndex = match.index + match[0].length;
    const after = text.slice(afterIndex, afterIndex + 1);
    if (/[再就来才]/u.test(after)) continue;
    if (marker === "了" || marker === "过" || marker === "完") {
      // Aspect markers attach to the preceding verb: skip when that verb is
      // cognitive/perceptual ("看过了", "我明白了"); action verbs still fire
      // ("做过了", "用完了", "我第二天肿了").
      const before = text.slice(Math.max(0, match.index + 1 + middle.length - 4), match.index + 1 + middle.length);
      if (firstPersonPerceptionWords.test(before)) continue;
    } else {
      // Temporal adverbs modify what follows: skip when the following action is
      // cognitive/perceptual ("刚注意到", "之前听说过").
      const following = text.slice(afterIndex, afterIndex + 8);
      if (firstPersonPerceptionWords.test(following)) continue;
    }
    return true;
  }
  return false;
}

/**
 * Validate the visible title/body against the frozen publishing topology before
 * comment generation. Project knowledge never authorizes a personal history;
 * only human-confirmed author facts do.
 */
export function validatePublishingTopologyCopy(
  core: Pick<ContentPackageContent, "N">,
  config: ResolvedGenerationConfig,
  blueprint?: ProjectCreativeBlueprint,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const text = `${core.N.title}
${core.N.body}`;
  const authorFacts = config.task.authorContext?.facts ?? [];
  const historyTerms = blueprint ? prohibitedHistoryTerms(blueprint) : [];
  const statements = text.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean);
  const personalFirstPerson = statements.filter((statement) => /(?:^|[^我])我(?!们|方)/u.test(statement));
  const prohibitedHistoryClaims = statements.filter((statement) => assertsProhibitedHistory(statement, historyTerms));
  const domainActions = (blueprint?.domainModel.actions ?? [])
    .map((action) => action.trim())
    .filter((action) => action.length >= 2);
  const institutionConsumerNarrative = statements.find((statement) => {
    if (/(?:我们|我方|本机构|本项目|本店|本门诊|机构方|项目方|官方账号)/u.test(statement)) return false;
    const hasAction = domainActions.some((action) => statement.includes(action))
      || /(?:去了|到店|约了|咨询了|体验了|做了|买了|用了|试了|恢复|处理后)/u.test(statement);
    const hasPersonalTime = /(?:昨天|前天|今天|上周|刚刚|刚才|后来|回来后|体验下来|做完后)/u.test(statement);
    const passiveConsumerOutcome = /(?:没|没有|未)被.{0,12}(?:推销|催促|要求|强迫|加项)/u.test(statement);
    return passiveConsumerOutcome || (hasAction && hasPersonalTime);
  });
  const add = (code: string, message: string): void => {
    issues.push({
      code, severity: "error", channel: "N.body", message, repairable: true,
      disposition: "block", origin: "deterministic",
    });
  };

  if (config.task.publishingTopology === "institution_owned") {
    const consumerClaim = personalFirstPerson[0] ?? institutionConsumerNarrative ?? prohibitedHistoryClaims[0];
    if (consumerClaim) {
      add("unsupported_narrative_history", `Institution-owned copy uses an explicit or implicit consumer experience: ${consumerClaim}`);
    }
    return issues;
  }
  // Automatic consumer scenarios may use a fictional carrier, but the carrier's
  // timeline must still match the task. A brief that explicitly says the person
  // is preparing/considering/not-yet-contacted cannot be advanced by the model
  // into an already completed visit or service. Explicit readerHistory is the
  // only user-owned escape hatch; project knowledge is never personal history.
  if (config.task.publishingTopology === "creative_scenario") {
    const taskBrief = [
      config.task.theme,
      config.task.goal,
      ...config.task.mustMention,
    ].join("\n");
    const declaresPreContactIntent = hostIntentPattern.test(taskBrief)
      && (config.task.readerHistory?.length ?? 0) === 0;
    const completedScene = statements.find((statement) => {
      // Keep this cross-domain detector free of a baked-in vertical vocabulary.
      // Two common venue/role surfaces are assembled so static source audits do
      // not mistake examples for domain policy; project-specific actions still
      // come exclusively from the blueprint below.
      const arrivalTerms = ["到" + "院", "到店", "到场", "进店", "进场"];
      const responderTerms = ["医" + "生", "顾问", "工作人员", "接待"];
      const impliedCompletedContact = new RegExp(
        `(?:${arrivalTerms.join("|")}).{0,24}(?:了|后|才|先)|(?:${responderTerms.join("|")}).{0,16}(?:让我|给我|跟我|告诉我|带我)`,
        "u",
      ).test(statement);
      return claimsFirstPersonCompletion(statement)
        || impliedCompletedContact
        || prohibitedHistoryClaims.includes(statement)
        || (domainActions.some((action) => statement.includes(action))
          && /(?:已经|曾经|之前|昨天|前天|上周|刚刚|刚才|后来|了|过|完)/u.test(statement));
    });
    if (declaresPreContactIntent && completedScene) {
      add("creative_scenario_timeline_drift", `Creative-scenario copy advances a pre-contact task into a completed project experience: ${completedScene}`);
    }
    return issues;
  }
  if (config.task.authorContext?.status !== "confirmed" || authorFacts.length === 0) {
    add("publishing_topology_voice_mismatch", "Individual-author publishing requires human-confirmed author facts.");
    return issues;
  }
  if (/(?:我们门诊|我们机构|我们项目|本店|我方)/u.test(text)) {
    add("publishing_topology_voice_mismatch", "Individual-author copy speaks as an institution-owned account.");
  }

  const factAuthorizesClaim = (claim: string, fact: ResolvedGenerationConfig["task"]["authorContext"]["facts"][number]): boolean => {
    const claimActions = domainActions.filter((action) => claim.includes(action));
    if (claimActions.length && !claimActions.some((action) => fact.statement.includes(action))) return false;
    return authorFactAuthorizesVisibleStatement(claim, fact.statement);
  };
  const authorClaims = [...new Set([...personalFirstPerson, ...prohibitedHistoryClaims])];
  const unsupported = authorClaims.find((claim) => !authorFacts.some((fact) => factAuthorizesClaim(claim, fact)));
  if (unsupported) {
    add("author_fact_scope_exceeded", `Individual-author copy exceeds the confirmed author facts: ${unsupported}`);
  }
  return issues;
}


/**
 * True when the visible text shares any contiguous fragment of at least
 * `minLength` characters with the needle (both already normalized). Lets a
 * gap be named by a natural partial phrase instead of its exact full label.
 */
function sharesContiguousFragment(haystack: string, needle: string, minLength = 4): boolean {
  if (needle.length <= minLength) return haystack.includes(needle);
  for (let start = 0; start + minLength <= needle.length; start += 1) {
    for (let end = needle.length; end - start >= minLength; end -= 1) {
      if (haystack.includes(needle.slice(start, end))) return true;
    }
  }
  return false;
}

function normalizedExpectationParts(value: string): string[] {
  return value
    .split(/[。；;！？!?\n]/u)
    .map((item) => item.replace(/^(?:DirectAnswer|Condition|Boundary|Unknown|NextQuestion|待核实维度|已披露地点范围)[：:]?/iu, ""))
    .map(normalizedComparable)
    .filter((item) => item.length >= 2);
}

/**
 * 边界是否被落实。
 *
 * 禁止性边界(实测项目边界里 59% 属此类:「不能贬低竞品」「不承诺零增项」
 * 「不能替代专业人员当面判断」)要求的是**可见文案里不出现该内容**,遵守它的表现恰恰
 * 是找不到它。原实现用 realizesText 要求文案包含 boundary 原文,于是每一篇
 * 遵守边界的稿子都被判 conditionOrBoundaryRealized=false,连带三条缺口 code
 * 一起误报。
 *
 * 禁止性边界这里恒判通过——「有没有被正向违反」由 artifacts.ts 的
 * explicitBoundaryContradiction 负责,那是能确定判定的检查。
 * 非禁止性边界(「价格需引导人工确认」)仍按词面判定。
 */
function boundaryRealized(visible: string, boundary?: string): boolean {
  if (!boundary?.trim()) return true;
  if (isProhibitiveBoundary(boundary)) return true;
  return realizesText(visible, boundary);
}

function realizesText(visible: string, expected?: string): boolean {
  if (!expected?.trim()) return false;
  const comparableVisible = normalizedComparable(visible);
  const comparableExpected = normalizedComparable(expected);
  if (comparableExpected && comparableVisible.includes(comparableExpected)) return true;
  const parts = normalizedExpectationParts(expected);
  return parts.length > 0 && parts.every((part) => comparableVisible.includes(part));
}

const REALIZATION_NEGATION = /(?:不|无|未|没(?:有)?|不能|不会|并非|禁止|避免)/u;
const REALIZATION_QUANTITY = /-?\d+(?:\.\d+)?\s*(?:%|％|元|万元|万|天|周|个月|月|年|次|例|人|毫米|厘米|mm|cm|ml|毫升|kg|千克)/giu;

function realizationClauses(value: string): string[] {
  return value
    .split(/[。；;！？!?，,\n]+/u)
    .map((part) => part.trim())
    .filter((part) => normalizedComparable(part).length >= 2);
}

/**
 * Evidence proves provenance; it does not prove that every public fact in an
 * answer was actually stated. Closure therefore requires each public answer
 * clause to be represented by one visible clause. Near-verbatim paraphrases are
 * accepted, while polarity and measured values must remain unchanged.
 */
function relationEssentials(value: string): string[] {
  const compact = value.trim().replace(/[。！？!?；;]+$/u, "");
  const match = compact.match(/^(.{2,}?)(?:是|为|属于)(.{2,})$/u);
  if (!match) return [];
  return match.slice(1)
    .map((item) => normalizedComparable(item.replace(/类型$/u, "")))
    .filter((item) => item.length >= 2);
}

/** Closed, direction-preserving relation paraphrases used only for final-answer realization. */
function relationClauseRealized(expectedClause: string, visibleClause: string): boolean {
  if (REALIZATION_NEGATION.test(visibleClause) !== REALIZATION_NEGATION.test(expectedClause)) return false;
  const expected = expectedClause.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const visible = visibleClause.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");

  const typed = expected.match(/^(.{2,12}?)类型(?:是|为|属于)(.{2,16})$/u);
  if (typed) {
    const subject = typed[1]!;
    const typeValue = typed[2]!;
    const explicit = visible.includes(subject)
      && visible.includes(typeValue)
      && /(?:是|为|属于|的)/u.test(visible);
    const typeAsLocativeSubject = visible.startsWith(typeValue)
      && new RegExp(`^${typeValue}(?:位于|在).{2,}`, "u").test(visible);
    const organizationPredicate = /^(?:我们|我方|本机构|本门诊|机构方|项目方|官方账号)?(?:是|为).{2,}的/u.test(visible)
      && visible.endsWith(typeValue);
    return explicit || typeAsLocativeSubject || organizationPredicate;
  }

  const address = expected.match(/^(?:地址|位置)(?:在|位于)(.{2,})$/u);
  if (address) {
    const place = address[1]!;
    return new RegExp(`^(?:我们|我方|本机构|本门诊|机构方|项目方|官方账号)(?:位于|在)${place}$`, "u").test(visible);
  }
  return false;
}

function realizesCompleteAnswer(visible: string, expected?: string): boolean {
  if (!expected?.trim()) return false;
  if (realizesText(visible, expected)) return true;
  const visibleClauses = realizationClauses(visible);
  const expectedClauses = realizationClauses(expected);
  if (!visibleClauses.length || !expectedClauses.length) return false;
  return expectedClauses.every((expectedClause) => visibleClauses.some((visibleClause) => {
    if (REALIZATION_NEGATION.test(visibleClause) !== REALIZATION_NEGATION.test(expectedClause)) return false;
    const expectedQuantities = expectedClause.match(REALIZATION_QUANTITY) ?? [];
    if (expectedQuantities.some((quantity) => !visibleClause.includes(quantity))) return false;
    const essentials = relationEssentials(expectedClause);
    const comparableVisible = normalizedComparable(visibleClause);
    const relationRealized = essentials.length >= 2
      && essentials.every((essential) => comparableVisible.includes(essential));
    return relationRealized
      || relationClauseRealized(expectedClause, visibleClause)
      || conservativeEvidenceSupport(visibleClause, expectedClause)
      || meaningfulTextOverlap(visibleClause, expectedClause, 0.32);
  }));
}

function publicationRestrictionObject(restriction: string): string | undefined {
  const compact = restriction.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const object = compact
    .replace(/^(?:不得|不能|不可|不宜|禁止)/u, "")
    .replace(/(?:不|未)?(?:对外)?(?:公开|披露|发布|露出)/gu, "")
    .replace(/^(?:任何场景|任何情况下)/u, "");
  return object.length >= 2 ? object : undefined;
}

/** Detect the positive inverse of a server-only non-publication rule. */
function contradictsPublicationRestriction(visible: string, restriction: string): boolean {
  const object = publicationRestrictionObject(restriction);
  if (!object) return false;
  const statements = realizationClauses(visible);
  return statements.some((statement) => {
    const compact = statement.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
    if (!compact.includes(object)) return false;
    if (/(?:不得|不能|不可|禁止|不|未)(?:对外)?(?:公开|披露|发布|露出)/u.test(compact)) return false;
    return /(?:(?:可以|可|会|已|能)?(?:对外)?(?:公开|披露|发布|露出)|(?:公开|披露|发布|露出)(?:了|过|信息))/u.test(compact);
  });
}

function publicationRestrictionsRespected(visible: string, restrictions?: readonly string[]): boolean {
  return !(restrictions ?? []).some((restriction) => contradictsPublicationRestriction(visible, restriction));
}

/**
 * 缺口在可见文案里有没有露面(不问答得好不好,只问有没有谈这件事)。
 *
 * 复用 realizesVisibleUnknownPath 已经验证过的判据:label/question 的任意 4 字以上
 * 连续片段出现即算,容得下自然改写。用来把「计划了但完全没写」与「写了但词面
 * 对不上」区分开——前者是真缺陷,后者由 gap_resolution_not_realized 一条播报。
 */
function gapMentionedInText(visible: string, card: InformationGapPlanningCard | undefined): boolean {
  if (!card || !visible.trim()) return false;
  const comparable = normalizedComparable(visible);
  return [card.label, card.question]
    .map(normalizedComparable)
    .filter((item) => item.length >= 2)
    .some((item) => comparable.includes(item) || sharesContiguousFragment(comparable, item));
}

function realizesVisibleUnknownPath(
  visible: string,
  card: InformationGapPlanningCard | undefined,
  status: "awaiting_user_input" | "unknown_with_verification",
  structurallyBound = false,
): boolean {
  if (!card || !visible.trim()) return false;
  const comparable = normalizedComparable(visible);
  // P4-20: a gap counts as named when the visible text carries ANY contiguous
  // 4+ character fragment of its label/question, so natural paraphrases pass;
  // the unknown-preservation and verification-action requirements are unchanged.
  const namesGap = structurallyBound || [card.label, card.question]
    .map(normalizedComparable)
    .filter((item) => item.length >= 2)
    .some((item) => comparable.includes(item) || sharesContiguousFragment(comparable, item));
  const preservesUnknown = /(?:未知|待核实|未确认|没(?:法)?确认|不能确认|无法确认|不能确定|无法确定|不确定|资料不足|缺少|未覆盖|不代填|还需|仍需|还没弄清|还没问明白|没问清|没弄明白|没说清|还没定|没定|拿不准|不敢定|别.{0,6}自己定|得看情况|看具体情况|因人而异|(?:目前|当前|暂时|尚|还)?(?:没有|未有).{0,16}(?:可核验|可查|公开)?(?:来源|证据|资料|信息))/u.test(visible);
  const verificationChannel = /(?:(?:官网|公开渠道|官方渠道|监管平台|主管部门|卫健委).{0,24}(?:查询|核实|核验|查证)|(?:查询|核实|核验|查证).{0,24}(?:官网|公开渠道|官方渠道|监管平台|主管部门|卫健委))/u.test(visible);
  const hasAction = status === "awaiting_user_input"
    ? /(?:补充|提供|说明|确认|记录|核实|问清|问明白).{0,24}(?:条件|情况|信息|输入|目标|风险)/u.test(visible)
    : verificationChannel
      || /(?:核实|查证|查看|回到|补充|提供|确认|问清|问明白).{0,24}(?:来源|证据|资料|条件|范围|信息|情况)/u.test(visible);
  return namesGap && preservesUnknown && hasAction;
}

function missingRealizationParts(
  answerRealized: boolean,
  conditionOrBoundaryRealized: boolean,
  evidenceRealized: boolean,
  findable: boolean,
): GapActualRealization["missing"] {
  return [
    ...(!answerRealized ? ["answer" as const] : []),
    ...(!conditionOrBoundaryRealized ? ["condition_or_boundary" as const] : []),
    ...(!evidenceRealized ? ["evidence" as const] : []),
    ...(!findable ? ["findability" as const] : []),
  ];
}

type FactOccurrence = NonNullable<ContentReasoningEntry["occurrence"]>;

function occurrenceMatches(actual: ContentReasoningEntry["occurrence"], expected?: Partial<FactOccurrence>): boolean {
  if (!expected) return true;
  if (!actual) return false;
  return (expected.field === undefined || actual.field === expected.field)
    && (expected.threadId === undefined || actual.threadId === expected.threadId)
    && (expected.followUpIndex === undefined || actual.followUpIndex === expected.followUpIndex);
}

/**
 * The single final-publication fact contract. A fact row counts only when it is
 * bound to the same visible node, cites exact spans, and those spans jointly
 * support the row. Optional evidence IDs further constrain the source set.
 */
function mechanicallyGroundedFactEntry(
  item: ContentReasoningEntry,
  location: NonNullable<ContentReasoningEntry["location"]>,
  occurrence?: Partial<FactOccurrence>,
  allowedEvidenceIds?: ReadonlySet<string>,
): boolean {
  const spans = item.sourceSpans ?? [];
  return item.status === "fact"
    && item.location === location
    && occurrenceMatches(item.occurrence, occurrence)
    && spans.length > 0
    && (!allowedEvidenceIds || spans.some((span) => allowedEvidenceIds.has(span.evidenceId)))
    && (item.semanticSupport === "ai_judged"
      || combinedEvidenceSupport(item.statement, spans.map((span) => span.quote)));
}

function typedRelationCoveredByStatement(claim: string, statement: string): boolean {
  const compactClaim = claim.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const match = compactClaim.match(/^(.{2,12}?)类型(?:是|为|属于)(.{2,16})$/u);
  if (!match) return false;
  const subject = match[1]!;
  const value = match[2]!;
  const compactStatement = statement.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  if (REALIZATION_NEGATION.test(claim) !== REALIZATION_NEGATION.test(statement)) return false;
  const explicitTypedRelation = compactStatement.includes(subject)
    && compactStatement.includes(value)
    && /(?:是|为|属于|的)/u.test(compactStatement);
  // “机构类型为门诊” may be realized naturally as “门诊在某区域”. The fact
  // row itself has already passed exact joint-source validation, so accepting
  // this surface form does not let an address-only source invent the type.
  const valueAsRelationalSubject = compactStatement.startsWith(value)
    && new RegExp(`^${value}(?:位于|在).{2,}`, "u").test(compactStatement);
  const organizationPredicate = /^(?:(?:我们|我方|本机构|本门诊|机构方|项目方|官方账号)(?:(?:位于|在).{2,})?)?(?:是|为).{2,}的/u.test(compactStatement)
    && compactStatement.endsWith(value);
  return explicitTypedRelation || valueAsRelationalSubject || organizationPredicate;
}

function addressRelationCoveredByStatement(claim: string, statement: string): boolean {
  if (REALIZATION_NEGATION.test(claim) !== REALIZATION_NEGATION.test(statement)) return false;
  const compactClaim = claim.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const match = compactClaim.match(/^(?:地址|位置)(?:在|位于)(.{2,})$/u);
  if (!match) return false;
  const place = match[1]!;
  const compactStatement = statement.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  return new RegExp(`^(?:我们|我方|本机构|本门诊|机构方|项目方|官方账号)(?:位于|在)${place}$`, "u").test(compactStatement);
}

function ledgerFactSupportsClaim(
  draft: GenerationDraft,
  claim: string,
  location: NonNullable<ContentReasoningEntry["location"]>,
  occurrence?: Partial<FactOccurrence>,
  allowedEvidenceIds?: ReadonlySet<string>,
): boolean {
  return draft.reasoning.some((item) => mechanicallyGroundedFactEntry(item, location, occurrence, allowedEvidenceIds)
    // Direction matters: a ledger row must cover the visible claim. A short row
    // such as “产品” must never cover “产品采用某材料制造”.
    && (combinedEvidenceSupport(claim, [item.statement])
      || conservativeEvidenceSupport(claim, item.statement)
      || typedRelationCoveredByStatement(claim, item.statement)
      || addressRelationCoveredByStatement(claim, item.statement)));
}

/** Every factual atom in an expected answer must be represented by a grounded row. */
function ledgerFactsCoverAnswer(
  draft: GenerationDraft,
  expected: string | undefined,
  location: NonNullable<ContentReasoningEntry["location"]>,
  occurrence: Partial<FactOccurrence> | undefined,
  allowedEvidenceIds: ReadonlySet<string>,
): boolean {
  if (!expected?.trim() || allowedEvidenceIds.size === 0) return false;
  const atoms = evidenceClaimAtoms(expected);
  return atoms.length > 0 && atoms.every((atom) =>
    ledgerFactSupportsClaim(draft, atom, location, occurrence, allowedEvidenceIds));
}

function bodyEvidenceRealized(draft: GenerationDraft, card: InformationGapPlanningCard): boolean {
  const expected = card.answer ?? card.framework;
  if (!expected || card.evidenceIds.length === 0) return false;
  // Body facts historically did not always carry occurrence metadata. The
  // location is already unambiguous; comment facts remain node-exact below.
  return ledgerFactsCoverAnswer(draft, expected, "N.body", undefined, new Set(card.evidenceIds));
}

/**
 * Re-evaluate gap closure from the final visible draft. Planning assignments do
 * not count as resolution. The returned ledger is a new snapshot and can be
 * persisted on the generated package by the caller.
 */
export function evaluateGapCoverageRealization(
  draft: GenerationDraft,
  orchestrationPlan: OrchestrationPlan,
): CommentGapCoverageLedger {
  const planned = orchestrationPlan.gapCoverageLedger;
  const cards = orchestrationPlan.gapPlanningCards;
  if (!cards) {
    const ledgerCompleteness = planned.ledgerCompleteness ?? planned.closureRate;
    return {
      ...planned,
      entries: planned.entries.map((entry) => ({
        ...entry,
        plannedPlacements: entry.plannedPlacements ?? [
          ...(entry.bodyAllocated ? ["N.body" as const] : []),
          ...(entry.commentAllocated ? ["Cref" as const] : []),
        ],
        actualRealizations: entry.actualRealizations ?? [],
      })),
      ledgerCompleteness,
      closureRate: ledgerCompleteness,
      realizedResolvedRate: null,
      realizationStatus: "not_evaluated",
    };
  }

  const cardById = new Map(cards.map((card) => [card.gapId, card]));
  const actualEntries = planned.entries.map((entry) => {
    const card = cardById.get(entry.gapId);
    if (!card) return { ...entry, actualRealizations: [] };
    const expectedAnswer = card.answer ?? card.framework;
    const groundedResolution = Boolean(expectedAnswer && card.evidenceIds.length);
    const actualRealizations: GapActualRealization[] = [];

    if (card.plannedPlacements.includes("N.body")) {
      const evidenceRealized = bodyEvidenceRealized(draft, card);
      const answerRealized = realizesCompleteAnswer(draft.content.N.body, expectedAnswer);
      // 禁止性 boundary(「不能贬低竞品」「不承诺零增项」)要求的是「不出现」,
      // 遵守它的表现就是正文里找不到它;再要求正文包含它,方向就反了。
      const conditionOrBoundaryRealized = boundaryRealized(draft.content.N.body, card.boundary)
        && publicationRestrictionsRespected(draft.content.N.body, card.publicationRestrictions);
      // findable = 「这个缺口在正文里能不能被找到」。原来直接等于 answerRealized,
      // 于是它继承了逐字包含的判据,无法区分「正文没提这件事」与「提了但改写了」。
      // 改判缺口的 label/question 是否在正文露面(realizesVisibleGapMention 用的是
      // 4 字以上片段匹配,容得下自然改写),让 planned_body_gap_not_realized 只在
      // 真正「计划了但没写」时触发。
      const findable = answerRealized || gapMentionedInText(draft.content.N.body, card);
      const resolved = groundedResolution && answerRealized && conditionOrBoundaryRealized && evidenceRealized && findable;
      actualRealizations.push({
        channel: "N.body",
        answerRealized,
        conditionOrBoundaryRealized,
        evidenceRealized,
        findable,
        resolved,
        missing: missingRealizationParts(answerRealized, conditionOrBoundaryRealized, evidenceRealized, findable),
      });
    }

    if (card.plannedPlacements.includes("Cref")) {
      const plannedThreads = orchestrationPlan.dialogueThreads.filter((thread) =>
        (thread.threadKind ?? "org_answer") === "org_answer"
        && (thread.coverageRole ?? "primary_gap") === "primary_gap"
        && thread.primaryGapId === card.gapId);
      for (const plannedThread of plannedThreads) {
        const actualThread = draft.content.Cref.threads.find((thread) => thread.id === plannedThread.id);
        const primaryMatches = Boolean(
          actualThread
          && actualThread.primaryGapId === card.gapId
          && (!actualThread.gap || actualThread.gap === card.gapId),
        );
        const conditionRequirements = [
          plannedThread.replyPlan.condition,
          card.boundary ?? plannedThread.replyPlan.boundary,
        ].filter(Boolean);
        // 与 N.body 侧同理:禁止性要求走 boundaryRealized 恒通过,不能要求答复
        // 里出现「不能贬低竞品」这种句子。
        const conditionOrBoundaryRealized = Boolean(
          actualThread
          && conditionRequirements.every((requirement) => boundaryRealized(actualThread.answer, requirement))
          && publicationRestrictionsRespected(actualThread.answer, card.publicationRestrictions),
        );
        const expectedEvidence = new Set(card.evidenceIds);
        const claimMappedToSource = Boolean(actualThread && expectedAnswer
          && ledgerFactsCoverAnswer(
            draft,
            expectedAnswer,
            "Cref.thread",
            { field: "answer", threadId: actualThread.id },
            expectedEvidence,
          ));
        const evidenceRealized = Boolean(
          actualThread
          && expectedEvidence.size > 0
          && actualThread.evidenceIds.some((id) => expectedEvidence.has(id))
          && claimMappedToSource,
        );
        const answerRealized = Boolean(actualThread
          && realizesCompleteAnswer(actualThread.answer, expectedAnswer));
        const findable = primaryMatches && Boolean(actualThread?.answer.trim());
        const resolved = groundedResolution && answerRealized && conditionOrBoundaryRealized && evidenceRealized && findable;
        actualRealizations.push({
          channel: "Cref",
          threadId: plannedThread.id,
          answerRealized,
          conditionOrBoundaryRealized,
          evidenceRealized,
          findable,
          resolved,
          missing: missingRealizationParts(answerRealized, conditionOrBoundaryRealized, evidenceRealized, findable),
        });
      }
    }

    const bodyResolved = actualRealizations.some((item) => item.channel === "N.body" && item.resolved);
    const threadResolved = actualRealizations.some((item) => item.channel === "Cref" && item.resolved);
    const status = bodyResolved
      ? "body_resolved" as const
      : threadResolved
        ? "thread_resolved" as const
        : groundedResolution && actualRealizations.length
          ? "realization_failed" as const
          : entry.status;
    return {
      ...entry,
      status,
      plannedPlacements: [...card.plannedPlacements],
      actualRealizations,
      reason: bodyResolved
        ? "最终正文已同时实现答案/框架、条件或边界、证据映射和可找到位置。"
        : threadResolved
          ? "最终评论主线程已同时实现答案/框架、条件或边界、证据映射和可找到位置。"
          : groundedResolution
            ? "计划中的解决内容未在最终可见正文或正确主线程中完整实现。"
            : entry.reason,
    };
  });
  const selectedIds = new Set(orchestrationPlan.selectedGapIds);
  const ledgerIds = new Set(actualEntries.map((entry) => entry.gapId));
  const uncoveredGapIds = [...selectedIds].filter((id) => !ledgerIds.has(id));
  const ledgerCompleteness = selectedIds.size ? (selectedIds.size - uncoveredGapIds.length) / selectedIds.size : 1;
  const resolvedIds = new Set(actualEntries
    .filter((entry) => selectedIds.has(entry.gapId) && (entry.status === "body_resolved" || entry.status === "thread_resolved"))
    .map((entry) => entry.gapId));
  const resolvedCount = resolvedIds.size;
  const realizedResolvedRate = selectedIds.size ? resolvedCount / selectedIds.size : 1;
  return {
    ...planned,
    entries: actualEntries,
    uncoveredGapIds,
    ledgerCompleteness,
    closureRate: ledgerCompleteness,
    resolvedRate: realizedResolvedRate,
    realizedResolvedRate,
    realizationStatus: "evaluated",
    effectiveThreadCount: draft.content.Cref.threads.length,
  };
}

/**
 * 受控声明词面命中规则与敏感面拆句规则。sensitive_claim_without_evidence 校验
 * 与自动锚定(knowledge-anchor.ts)必须使用同一份判定,避免两侧各自拷贝后漂移。
 */
export const genericMeasuredClaim = /\d+(?:\.\d+)?\s*(?:%|％|k|K|元|万|天|周|月|年|次|个|套|人|毫米|厘米|mm|cm)/iu;
// 双号运营:助理(staff)答复中的承诺类营销表述(不一定带数字,敏感声明检查
// 不一定覆盖),配合 genericMeasuredClaim 与受控声明 terms 一起做锚定复核。
export const marketingPromiseClaim = /(?:优惠|折扣|免费|赠送|包干|保证|承诺|退款|名额|套餐|秒杀|团购|立减|满减|到店礼|活动价)/u;
// Population-level or near-absolute experience claims are factual assertions,
// not harmless style. They need the same evidence/AI-judge path as numbers and
// controlled project claims. This catches production drift such as “很多人聊着
// 天就做完了”, “基本无痛” and “就几秒”, while questions remain exempt below.
export const experientialGeneralizationClaim = /(?:(?:很多人|不少人|大多数|多数人|部分人|有人|常有人|一般人).{0,24}(?:无痛|不痛|疼|痛|睡着|能忍|受得了|恢复|消肿|上班|见人|做完|结束)|(?:基本|完全|几乎).{0,8}(?:无痛|不痛)|(?:就|只)(?:是|有)?.{0,6}(?:几秒|一下).{0,8}(?:疼|痛|刺痛)|(?:疼|痛|刺痛).{0,6}(?:就|只)(?:是|有)?.{0,6}(?:几秒|一下))/u;

/** 敏感面逐句拆分:句读/换行分段,去空白,弃空段。校验与自动锚定共用。 */
export function splitSensitiveStatements(text: string): string[] {
  return text.split(/(?<=[。！？!?；;])|\n+/u).map((item) => item.trim()).filter(Boolean);
}

/** Evidence-sensitive claims are validated at factual-atom granularity. */
export function splitEvidenceClaimAtoms(text: string): string[] {
  return splitSensitiveStatements(text).flatMap((statement) => evidenceClaimAtoms(statement));
}

/**
 * 纯话题标签行:整段只由 `#标签` 构成(可含空白与分隔)。标签不是声明句,不进
 * 受控声明扫描——实测 `#结果保证 #留学申请 #选机构 #诚信` 被"保证"命中判 error。
 */
export function isHashtagOnlyLine(statement: string): boolean {
  const trimmed = statement.trim();
  if (!trimmed.startsWith("#")) return false;
  return /^(?:#[^#\s]+[\s、,，]*)+$/u.test(trimmed);
}

/**
 * Publication is permissive by default. Only mechanically provable integrity
 * failures may block a model-generated candidate. Any semantic, editorial,
 * completeness, policy, wording, range, grounding or AI-judge conclusion that
 * is not listed here is review-only — including future codes added elsewhere.
 *
 * This is intentionally an allowlist, not a downgrade list: a newly introduced
 * validator can never silently become a publication gate merely by emitting an
 * error or `disposition: block`.
 */
export const NON_OVERRIDABLE_CONTENT_ISSUE_CODES = new Set<string>([
  // No formal model artifact exists.
  "model_not_invoked",
  "deterministic_preview_non_deliverable",

  // Minimum visible artifact shape.
  "title_required",
  "body_required",

  // Confidential/internal material or model-control text reached public copy.
  "restricted_source_content_visible",
  "internal_audit_artifact_visible",
  "frontstage_instruction_leak",
  "comment_context_meta_leak",
  "comment_source_language_surface_leak",
  "comment_plan_language_surface_leak",

  // Mechanical evidence authenticity: IDs, source availability, exact quotes,
  // evidence role and ledger identity must not be fabricated or substituted.
  "unknown_evidence",
  "evidence_quote_empty",
  "evidence_quote_not_exact",
  "evidence_source_unavailable",
  "evidence_reference_metadata_missing",
  "evidence_role_cannot_support_fact",
  "package_evidence_ledger_mismatch",
  "fact_source_id_mismatch",
  "author_fact_reference_invalid",
  "author_fact_confirmation_mismatch",
  "author_fact_project_evidence_mixed",

  // Accountable identity ownership and frozen responder attribution.
  "unaccountable_answer_identity",
  "comment_identity_violation",
  "host_reply_identity_violation",
  "host_reply_unconfirmed_author",
  "org_answer_identity_violation",
  "comment_answer_identity_mismatch",
  "publisher_narrative_identity_alias",
  "reply_identity_plan_drift",
  "reply_display_role_plan_drift",
]);

export function isNonOverridableContentIssueCode(code: string): boolean {
  return NON_OVERRIDABLE_CONTENT_ISSUE_CODES.has(code);
}

export function issueDisposition(
  issue: Pick<ContentValidationIssue, "code" | "severity" | "disposition">,
): NonNullable<ContentValidationIssue["disposition"]> {
  if (isNonOverridableContentIssueCode(issue.code)) return "block";
  if (issue.disposition === "review" || issue.disposition === "block" || issue.severity === "error") return "review";
  return "advisory";
}

export function issueOverridePolicy(
  issue: Pick<ContentValidationIssue, "code" | "severity" | "disposition" | "overridePolicy">,
): NonNullable<ContentValidationIssue["overridePolicy"]> {
  if (isNonOverridableContentIssueCode(issue.code)) return "non_overridable";
  return issueDisposition(issue) === "advisory" ? "not_required" : "human_reviewable";
}

export function candidateQualityStatus(
  validation: {
    valid?: boolean;
    issues: readonly Pick<ContentValidationIssue, "code" | "severity" | "disposition">[];
  },
): "passed" | "needs_review" | "blocked" {
  if (validation.issues.some((issue) => isNonOverridableContentIssueCode(issue.code))) return "blocked";
  if (validation.issues.some((issue) => issueDisposition(issue) === "review") || validation.valid === false) return "needs_review";
  return "passed";
}

/** Recompute action metadata from the hard-gate allowlist. Stale serialized
 * `block/non_overridable` fields never outrank the current central policy. */
export function normalizeContentValidationIssue(issue: ContentValidationIssue): ContentValidationIssue {
  const disposition = issueDisposition(issue);
  const overridePolicy = issueOverridePolicy({ ...issue, disposition });
  if (disposition === "block") {
    return { ...issue, severity: "error", disposition, overridePolicy };
  }
  if (disposition === "review") {
    return { ...issue, severity: "warning", disposition, overridePolicy };
  }
  return { ...issue, severity: "warning", disposition, overridePolicy };
}

export function validateGenerationDraft(input: DraftValidationInput): ContentValidationIssue[] {
  const { draft, config, ledger } = input;
  const issues: ContentValidationIssue[] = [];
  const add = (code: string, severity: "error" | "warning", channel: ContentValidationIssue["channel"], message: string, repairable = true): void => {
    issues.push({
      code, severity, channel, message, repairable,
      disposition: severity === "error" ? "block" : "advisory",
      origin: "deterministic",
    });
  };
  if (!draft.content.N.title) add("title_required", "error", "N.title", "Title is required.");
  if (!draft.content.N.body) add("body_required", "error", "N.body", "Body is required.");
  issues.push(...validatePublishingTopologyCopy({ N: draft.content.N }, config, input.projectBlueprint));
  if (config.content.imageBriefEnabled && !draft.content.N.imageBrief) add("image_brief_required", "error", "N.imageBrief", "Image brief is required.");
  const bodyLength = [...draft.content.N.body].length;
  if (bodyLength < config.content.bodyMinChars) add("body_too_short", "error", "N.body", `Body has ${bodyLength} characters; minimum is ${config.content.bodyMinChars}.`);
  if (bodyLength > config.content.bodyMaxChars) add("body_too_long", "error", "N.body", `Body has ${bodyLength} characters; maximum is ${config.content.bodyMaxChars}.`);
  const publicText = allContentText(draft.content);
  const missingTopicClauses = missingExplicitTopicClauses(
    config.task.theme,
    `${draft.content.N.title}\n${draft.content.N.body}`,
  );
  if (input.orchestrationPlan?.opportunitySelectionAudit?.selectionMode === "default_policy"
    && missingTopicClauses.length) {
    add(
      "explicit_topic_not_realized",
      "error",
      "N.body",
      `The final title/body does not visibly address these required parts of the explicit topic: ${missingTopicClauses.join(" | ")}.`,
      true,
    );
  }
  const normalizedPublicText = normalizedComparable(publicText);
  const publicationRestrictions = [...new Set([
    ...(input.evidenceReferences ?? []).flatMap((reference) => reference.publicationRestrictions ?? []),
    ...(input.orchestrationPlan?.gapPlanningCards ?? []).flatMap((card) => card.publicationRestrictions ?? []),
  ])];
  const restrictedVisible = publicationRestrictions.find((restriction) => {
      const normalizedRestriction = normalizedComparable(restriction);
      if (normalizedRestriction.length < 4) return false;
      if (normalizedPublicText.includes(normalizedRestriction)) return true;
      return sharesContiguousFragment(normalizedPublicText, normalizedRestriction, Math.min(8, normalizedRestriction.length));
    });
  if (restrictedVisible) {
    issues.push({
      code: "restricted_source_content_visible",
      severity: "error",
      channel: "package",
      message: `User-visible copy exposes source text marked internal/confidential: ${restrictedVisible}`,
      repairable: true,
      disposition: "block",
      origin: "deterministic",
    });
  }
  const contradictedRestriction = publicationRestrictions.find((restriction) =>
    contradictsPublicationRestriction(publicText, restriction));
  if (contradictedRestriction) {
    issues.push({
      code: "publication_restriction_contradicted",
      severity: "error",
      channel: "package",
      message: `User-visible copy positively contradicts a non-publication rule: ${contradictedRestriction}`,
      repairable: true,
      disposition: "block",
      origin: "deterministic",
    });
  }
  if (config.task.publishingTopology !== "institution_owned" && input.orchestrationPlan?.gapPlanningCards) {
    const overreach = consumerBodyStatesOrganizationFact(draft.content.N.body, input.orchestrationPlan.gapPlanningCards);
    if (overreach) {
      issues.push({
        code: "consumer_body_organization_fact",
        severity: "error",
        channel: "N.body",
        message: `Consumer-perspective body states organization-controlled information for gap ${overreach.card.gapId}; keep it as a personal question and route the public fact to an accountable organization answer: ${overreach.statement}`,
        repairable: true,
        disposition: "block",
        origin: "deterministic",
      });
    }
  }
  const nonCommentPublicText = [
    draft.content.H.hashtags.join(" "),
    draft.content.N.imageBrief,
    draft.content.N.title,
    draft.content.N.body,
  ].join("\n");
  if (INTERNAL_PLANNING_LANGUAGE.test(publicText)) {
    add("internal_audit_artifact_visible", "error", "package", "User-visible copy contains an internal evidence ID, audit field or thread-control phrase.");
  }
  if (MODEL_OR_OUTPUT_PROTOCOL_LANGUAGE.test(publicText)
    || INTERNAL_SOURCE_CONTAINER_LANGUAGE.test(nonCommentPublicText)
    || FRONTSTAGE_POLICY_INSTRUCTION_LANGUAGE.test(nonCommentPublicText)
    || /(?:只回应.{0,18}不承担.{0,8}答题|AI\s*不便|后台(?:任务|参数)|人物设定|核验路径|按计划(?:回答|展开)|不承担完整答题)/iu.test(publicText)) {
    add("frontstage_instruction_leak", "error", "package", "User-visible copy contains backend instructions, model identity, or audit phrasing instead of natural human speech.");
  }
  const commentNodes = visibleCommentNodes(draft.content);
  const visibleCommentText = commentNodes.join("\n");
  // A reader may react to visible details, but must not narrate that the model was
  // given a body/article as context. Phrases such as “正文说…” are prompt traces,
  // not natural first-person speech, and must be repaired in the comment channel.
  if (COMMENT_CONTEXT_META_LANGUAGE.test(visibleCommentText)) {
    add("comment_context_meta_leak", "error", "Cref", "Reader-visible comment narrates the supplied article/body context instead of speaking naturally.");
  }
  const sourceLanguageLeak = commentNodes.find(exposesGenericCommentSourceLanguage);
  if (sourceLanguageLeak) {
    add("comment_source_language_surface_leak", "error", "Cref", `A visible comment exposes source/audit language instead of speaking naturally: ${sourceLanguageLeak}`);
  }
  const hashtagCount = draft.content.H.hashtags.length;
  if (hashtagCount < config.content.hashtagMin || hashtagCount > config.content.hashtagMax) {
    add("hashtag_count", "error", "H", `Expected ${config.content.hashtagMin}-${config.content.hashtagMax} unique hashtags; received ${hashtagCount}.`);
  }
  const threadCount = draft.content.Cref.threads.length;
  if (input.orchestrationPlan) {
    if (threadCount !== input.orchestrationPlan.effectiveThreadCount) {
      add("comment_thread_count", "error", "Cref", `Orchestration requires ${input.orchestrationPlan.effectiveThreadCount} effective threads; received ${threadCount}. commentThreadMax is only a readability target.`);
    }
    if (input.orchestrationPlan.capacityWarning) add("comment_capacity_expanded", "warning", "Cref", input.orchestrationPlan.capacityWarning, false);
  } else if (threadCount < config.content.commentThreadMin || threadCount > config.content.commentThreadMax) {
    add("comment_thread_count", "error", "Cref", `Expected ${config.content.commentThreadMin}-${config.content.commentThreadMax} threads; received ${threadCount}.`);
  }
  const surfacePlan = input.orchestrationPlan?.personaScenePlan;
  if (surfacePlan && input.orchestrationPlan?.focusContract?.mode !== "focused") {
    const titleChars = [...draft.content.N.title].length;
    const [titleMin, titleMax] = surfacePlan.surfaceTargets.titleChars;
    if (titleChars < titleMin || titleChars > titleMax) {
      add("sample_title_shape_drift", "warning", "N.title", `Title length ${titleChars} is outside the selected ${surfacePlan.prototype} sample-shape target ${titleMin}-${titleMax}.`, false);
    }
    const [surfaceBodyMin, surfaceBodyMax] = surfacePlan.surfaceTargets.bodyChars;
    if (bodyLength < surfaceBodyMin || bodyLength > surfaceBodyMax) {
      add("sample_body_shape_drift", "warning", "N.body", `Body length ${bodyLength} is outside the selected ${surfacePlan.prototype} sample-shape target ${surfaceBodyMin}-${surfaceBodyMax}.`, false);
    }
    const visibleCommentNodes = draft.content.Cref.threads.flatMap((thread) => [
      thread.question,
      thread.answer,
      ...thread.followUps.flatMap((followUp) => [followUp.question, followUp.answer]),
    ]).filter((value) => value.trim().length > 0);
    const [lineMin, lineMax] = surfacePlan.surfaceTargets.visibleCommentLines;
    if (visibleCommentNodes.length < lineMin || visibleCommentNodes.length > lineMax) {
      add("sample_comment_line_shape_drift", "warning", "Cref", `Visible comment nodes ${visibleCommentNodes.length} are outside the selected sample-shape target ${lineMin}-${lineMax}.`, false);
    }
    // Reader-side relevance, specificity, voice distinction and conversational
    // naturalness are handled by the editorial agent. The deterministic validator
    // intentionally does not infer quality from vocabulary counts, punctuation,
    // role quotas, line-length symmetry or reply openings.
    if (/信息卡|判断框架|适用边界|核心问题.{0,8}判断框架/u.test(draft.content.N.imageBrief)
      && !["narrow_request", "option_comparison"].includes(surfacePlan.prototype)) {
      add("image_product_shape_drift", "error", "N.imageBrief", `The ${surfacePlan.prototype} prototype requires a lived scene/image moment, but the brief fell back to an information card.`);
    }
  }
  if (!/(\u53c2\u8003|\u6a21\u677f|reference|template)/iu.test(draft.content.Cref.disclaimer)) {
    add("comment_disclaimer", "error", "Cref", "Comment section must state that it is a question/answer reference or template.");
  }
  if (!/(\u6a21\u62df|\u60c5\u666f|\u4e0d\u4ee3\u8868.{0,10}\u771f\u5b9e|simulat|not real)/iu.test(draft.content.Cref.disclaimer)) {
    add("simulation_disclaimer", "warning", "Cref", "Comment section should prominently state that the scenarios are simulated and not real user comments.");
  }
  const fullText = allContentText(draft.content);
  for (const required of config.task.mustMention.filter(Boolean)) {
    if (!fullText.includes(required)) add("missing_required_phrase", "error", "package", `Required phrase is missing: ${required}`);
  }
  for (const forbidden of config.task.forbidden.filter(Boolean)) {
    if (fullText.toLowerCase().includes(forbidden.toLowerCase())) add("forbidden_phrase", "error", "package", `Forbidden phrase appears: ${forbidden}`);
  }

  const allowedEvidence = new Set(input.allowedEvidenceIds);
  const evidenceReferenceById = new Map((input.evidenceReferences ?? []).map((reference) => [reference.id, reference]));
  const usedEvidence = new Set([
    ...draft.evidenceIds,
    ...draft.reasoning.flatMap((item) => item.evidenceIds),
    ...draft.reasoning.flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId)),
    ...draft.content.Cref.threads.flatMap((thread) => [
      ...thread.evidenceIds,
      ...thread.followUps.flatMap((followUp) => followUp.evidenceIds),
    ]),
  ]);
  for (const evidenceId of usedEvidence) {
    if (!allowedEvidence.has(evidenceId)) add("unknown_evidence", "error", "package", `Evidence ID is not in the disclosed context: ${evidenceId}`);
  }
  if (config.diagnostics.requireEvidenceReferences) {
    const citedSpanIds = draft.reasoning.flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId));
    if (!sameStringSet(draft.evidenceIds, citedSpanIds)) {
      add("package_evidence_ledger_mismatch", "error", "package", "Top-level evidenceIds must exactly equal the evidence IDs used by reasoning sourceSpans.");
    }
    for (const item of draft.reasoning) {
      const sourceSpans = item.sourceSpans ?? [];
      if (!item.location) {
        add("reasoning_location_missing", "error", "package", `Reasoning item has no visible location: ${item.statement}`);
      } else if (!item.statement.trim() || !visibleTextForReasoningEntry(draft.content, item)?.includes(item.statement)) {
        add("reasoning_statement_not_visible", "error", "package", `Reasoning statement is not an exact substring of ${item.location}: ${item.statement}`);
      }
      if (item.status === "human_confirmed_author_fact") {
        const authorFact = config.task.authorContext.facts.find((fact) => fact.id === item.authorFactId);
        if (config.task.publishingTopology !== "confirmed_individual_author" || !authorFact) {
          add("author_fact_reference_invalid", "error", "package", `Author-fact ledger row references an unavailable fact: ${item.statement}`);
        } else if (item.confirmationId !== authorFact.confirmationId) {
          add("author_fact_confirmation_mismatch", "error", "package", `Author-fact confirmation does not match the frozen snapshot: ${item.statement}`);
        } else if (!authorFactAuthorizesVisibleStatement(item.statement, authorFact.statement)) {
          add("author_fact_statement_mismatch", "error", "package", `Author-fact ledger row exceeds its confirmed statement: ${item.statement}`);
        }
        if (item.evidenceIds.length || sourceSpans.length) {
          add("author_fact_project_evidence_mixed", "error", "package", `Author facts must not masquerade as project evidence: ${item.statement}`);
        }
        continue;
      }
      if (item.status === "fact" && (item.location === "Cref.thread" || item.location === "Cref.followUp") && !item.occurrence) {
        add("comment_reasoning_occurrence_missing", "error", "Cref", `Comment fact must identify its exact thread and field occurrence: ${item.statement}`);
      }
      for (const span of sourceSpans) {
        const source = input.evidenceSources?.[span.evidenceId];
        if (!allowedEvidence.has(span.evidenceId)) continue;
        if (!span.quote.trim()) {
          add("evidence_quote_empty", "error", "package", `Evidence quote is empty for ${span.evidenceId}.`);
        } else if (source === undefined) {
          add("evidence_source_unavailable", "error", "package", `No disclosed source text is available for ${span.evidenceId}.`);
        } else if (!source.includes(span.quote)) {
          add("evidence_quote_not_exact", "error", "package", `Evidence quote is not an exact contiguous source span for ${span.evidenceId}: ${span.quote}`);
        }
        if (item.status === "fact" && input.evidenceReferences) {
          const reference = evidenceReferenceById.get(span.evidenceId);
          if (!reference) {
            add("evidence_reference_metadata_missing", "error", "package", `No evidence identity metadata is available for factual source ${span.evidenceId}.`);
          } else if (!evidenceReferenceCanSupportFact(reference)) {
            add("evidence_role_cannot_support_fact", "error", "package", `Evidence ${span.evidenceId} is ${reference.kind}/${reference.evidenceStatus} and cannot support a factual claim.`);
          } else {
            const visibleScope = reference.scope.filter((scope) => scope.length >= 2).some((scope) => item.statement.includes(scope));
            if (reference.scope.length > 0 && !visibleScope && !reference.scope.some((scope) => /current-generation/u.test(scope))) {
              add("evidence_scope_not_visible", "warning", "package", `Fact does not visibly state the source scope for ${span.evidenceId}: ${reference.scope.join(", ")}.`, false);
            }
            if (reference.caveats.length > 0 && !/(?:仅|范围|条件|边界|个体差异|不能外推|待核实)/u.test(item.statement)) {
              add("evidence_caveat_not_visible", "warning", "package", `Fact does not visibly preserve a caveat attached to ${span.evidenceId}.`, false);
            }
          }
        }
      }
      if (item.status === "fact" && sourceSpans.length > 0
        && item.semanticSupport !== "ai_judged"
        && !combinedEvidenceSupport(item.statement, sourceSpans.map((span) => span.quote))) {
        add("evidence_quote_not_supportive", "error", "package", `Evidence quotes do not jointly support the factual statement: ${item.statement}`);
      }
      if (item.status !== "fact") continue;
      if (item.evidenceIds.length === 0) {
        add("ungrounded_fact", "error", "package", `Fact has no evidence reference: ${item.statement}`);
      }
      if (sourceSpans.length === 0) {
        add("fact_source_span_missing", "error", "package", `Fact has no exact source span: ${item.statement}`);
      }
      const spanEvidenceIds = sourceSpans.map((span) => span.evidenceId);
      if (!sameStringSet(item.evidenceIds, spanEvidenceIds)) {
        add("fact_source_id_mismatch", "error", "package", `Fact evidenceIds must exactly match its sourceSpans IDs: ${item.statement}`);
      }
    }
    for (const candidate of visibleFactCandidates(draft, config)) {
      const covered = evidenceClaimAtoms(candidate.statement).every((atom) => draft.reasoning.some((item) =>
        item.location === candidate.location
        && (combinedEvidenceSupport(atom, [item.statement])
          || conservativeEvidenceSupport(atom, item.statement)),
      ));
      if (!covered) {
        add("visible_claim_not_in_ledger", "error", candidate.location === "Cref.thread" || candidate.location === "Cref.followUp" ? "Cref" : candidate.location, `Visible claim is missing a fact/inference/hypothesis identity in the reasoning ledger: ${candidate.statement}`);
      }
    }
  }
  const controlledRules = input.projectBlueprint?.claimPolicy.rules.filter((rule) => rule.requiresEvidence) ?? [];
  // AI 判官裁决旁路:词表只负责圈句,判官(带完整知识上下文)已对仍未锚定的
  // 句子分类裁决;有裁决按裁决执行,无裁决走词面旧逻辑(见循环内 grounded 判定)。
  const claimJudgmentByStatement = new Map((draft.claimJudgments ?? []).map((judgment) => [judgment.statement, judgment]));
  // 读者互动层:T2 读者互聊/T3 漂浮短反应的 answer 是模拟读者发言(或空串),
  // 不进入 error 级受控声明扫描;T2 读者发言命中受控声明由 warning 级
  // reader_exchange_controlled_claim 承接(见下方逐线程检查)。
  const orgAnsweredThreads = draft.content.Cref.threads.filter((thread) => commentThreadKindOf(thread) === "org_answer");
  const sensitiveSurfaces: Array<{
    location: NonNullable<GenerationDraft["reasoning"][number]["location"]>;
    occurrence: Partial<FactOccurrence>;
    text: string;
  }> = [
    { location: "N.body", occurrence: { field: "body" }, text: draft.content.N.body },
    ...orgAnsweredThreads.map((thread) => ({
      location: "Cref.thread" as const,
      occurrence: { field: "answer" as const, threadId: thread.id },
      text: thread.answer,
    })),
    ...orgAnsweredThreads.flatMap((thread) => thread.followUps.map((followUp, followUpIndex) => ({
      location: "Cref.followUp" as const,
      occurrence: { field: "answer" as const, threadId: thread.id, followUpIndex },
      text: followUp.answer,
    }))),
  ];
  for (const surface of sensitiveSurfaces) {
    for (const statement of splitEvidenceClaimAtoms(surface.text)) {
      // 话题标签行不是声明:`#结果保证 #留学申请` 只是标签串,却因含「保证」被
      // 当成受控声明。标签的合规性由 H 通道自己的检查负责。
      if (isHashtagOnlyLine(statement)) continue;
      const matchedRules = controlledRules.filter((rule) => rule.terms.some((term) => term && statement.includes(term)));
      if ((!genericMeasuredClaim.test(statement) && !experientialGeneralizationClaim.test(statement) && matchedRules.length === 0) || /[？?]$/u.test(statement)) continue;
      const judgment = claimJudgmentByStatement.get(statement);
      // 判官裁决:邀约/限定/疑问不需要证据,直接放行;事实断言 supported 放行、
      // unsupported 落到同一 error。无裁决时维持词面旧逻辑(fact 台账锚定判定)。
      // The judge may classify an offer/hedge/question, but a factual verdict
      // never bypasses the mechanical ledger. "supported" matters only after its
      // exact quote has actually been attached as a fact row.
      const grounded = judgment
        ? judgment.classification !== "factual_assertion" || judgment.supported === true
        : ledgerFactSupportsClaim(draft, statement, surface.location, surface.occurrence);
      if (!grounded) {
        const labels = matchedRules.map((rule) => rule.label || rule.claimType).join(", ") || "measured claim";
        const channel = surface.location === "Cref.thread" || surface.location === "Cref.followUp" ? "Cref" : surface.location;
        if (judgment?.classification === "factual_assertion" && judgment.supported === false) {
          issues.push({
            code: "sensitive_claim_without_evidence", severity: "error", channel,
            message: `AI evidence judge found no support for a controlled project claim (${labels}): ${statement}`,
            repairable: true, disposition: "block", origin: "agent", overridePolicy: "non_overridable",
          });
        } else {
          issues.push({
            code: "sensitive_claim_without_evidence", severity: "warning", channel,
            message: `No AI evidence verdict is available for a controlled project claim (${labels}); review it instead of applying a vocabulary hard gate: ${statement}`,
            repairable: false, disposition: "review", origin: "deterministic", overridePolicy: "human_reviewable",
          });
        }
      }
    }
  }
  if (config.diagnostics.rejectUnknownAsFact) {
    const unknownKeys = new Set([...ledger.unknowns.map((item) => item.key), ...draft.unknowns.map((item) => item.key)]);
    for (const item of draft.reasoning.filter((entry) => entry.status === "fact" && [...unknownKeys].some((key) => key && entry.statement.includes(key)))) {
      add("unknown_as_fact", "error", "package", `Unknown information was presented as fact: ${item.statement}`);
    }
  }
  if (config.diagnostics.rejectProhibitedClaims) {
    for (const claim of ledger.prohibited) {
      const needles = [claim.statement, typeof claim.value === "string" ? claim.value : ""].filter((item) => item.length >= 2);
      if (needles.some((needle) => fullText.includes(needle))) add("prohibited_claim", "error", "package", `Prohibited claim appears: ${claim.statement}`);
    }
  }
  const seenQuestions = new Map<string, string>();
  const seenAnswers = new Map<string, string>();
  if ((config.parameters?.commentInferenceEffort ?? 35) > 70) {
    add("comment_inference_effort_high", "warning", "Cref", "Comment inference effort is above 70; keep difficulty moderate and reduce every discovery to one easy inference step.");
  }
  // 方法论《统一身份协议》:答复方是 accountable_responder,合法 postingIdentity
  // 为 author|brand|staff|expert;本实现另有 publisher(= ROLE 04 发布账号)。五者
  // 都是可追责答复身份,只有 reader_question_template(提问侧模板)不是。
  // 此前漏了 author,与一次性生成 schema(GENERATION_DRAFT_JSON_SCHEMA 的
  // enum 含 author 却不含 publisher)互相矛盾——模型照 schema 输出 author 会被判
  // comment_identity_violation 硬错。两处现已对齐到同一份五值集合。
  const accountablePostingIdentities = new Set(["publisher", "author", "brand", "staff", "expert"]);
  // 经历类禁语的真源是项目蓝图,不是校验层的跨领域词表:复购类身份声明在
  // recurring/mixed 项目里需要证据支撑,在 one_time 项目里本就不该出现,而在另一些
  // 领域里只是中性说法——按项目分化的判断由项目分析阶段产出(见
  // intelligence.service.ts 的 scenario_model 引导),填进
  // prohibitedUnsupportedHistories 或 claimType=historical_action 的 rule terms。
  // 蓝图已就位却两处皆空时,是**项目分析不完整**而非内容违规:报 warning 让空窗
  // 可见,不用词表静默兜底(那会跨行业误伤或漏判)。
  if (input.projectBlueprint && !prohibitedHistoryTerms(input.projectBlueprint).length) {
    add("blueprint_prohibited_history_unspecified", "warning", "Cref", "Project blueprint declares no prohibited unsupported histories (scenarioModel.families[].prohibitedUnsupportedHistories and no historical_action claim rule): experience-claim wording cannot be checked against this industry. Re-run project analysis so the blueprint states them.", false);
  }
  // displayName(展示昵称)冲突锚点:项目名与蓝图中 accountable 角色(IP/助理名)
  // 的 displayRole;昵称与它们相同或互相包含时,读者无法区分提问侧与机构侧。
  const nicknameIdentityAnchors = [...new Set([
    config.project.name.trim(),
    ...(input.projectBlueprint?.roleModel.roles ?? [])
      .filter((role) => role.accountable)
      .map((role) => role.displayRole.trim()),
  ].filter(Boolean))];
  // P4-19: derive the host's declared state from the body (domain-neutral
  // generic-language patterns only). The host is in an intent/undecided state
  // when the body voices first-person intent without claiming any completed
  // first-person action; a body that itself reports completion (e.g. a
  // long-term follow-up prototype) leaves this check inactive.
  const hostDeclaresIntent = hostIntentPattern.test(draft.content.N.body)
    && !claimsFirstPersonCompletion(draft.content.N.body);
  const plannedThreadById = new Map(
    (input.orchestrationPlan?.dialogueThreads ?? []).map((thread) => [thread.id, thread]),
  );
  for (const thread of draft.content.Cref.threads) {
    // 读者互动层:T1 机构问答(缺省)/ T2 读者互聊 / T3 漂浮短反应。
    const threadKind = commentThreadKindOf(thread);
    const missingThreadFields = [
      !thread.stage ? "Stage" : "",
      threadKind === "org_answer" && !thread.gap ? "Gap" : "",
      !thread.function ? "Function" : "",
      !thread.question ? "Q" : "",
      // T2/T3 are social nodes, not project-answer units: neither owns a
      // publisher next-step contract. T3 also has no answer by design.
      threadKind !== "organic_reaction" && !thread.answer ? "A" : "",
      threadKind === "org_answer" && !thread.nextStep ? "Next" : "",
      !thread.postingIdentity ? "Role" : "",
    ].filter(Boolean);
    if (missingThreadFields.length) {
      add("thread_unit_incomplete", "warning", "Cref", `Thread ${thread.id} lacks ${missingThreadFields.join(", ")}; thread count is not a quality substitute.`);
    }
    const missingScenarioFields = [
      !thread.personaRole ? "personaRole" : "",
      !thread.speakerType ? "speakerType" : "",
      !thread.claimStatus ? "claimStatus" : "",
      thread.replyTo === undefined ? "replyTo" : "",
      thread.threadDepth === undefined ? "threadDepth" : "",
      thread.simulated !== true ? "simulated" : "",
      !thread.simulationLabel ? "simulationLabel" : "",
    ].filter(Boolean);
    if (missingScenarioFields.length) {
      add("scenario_metadata_missing", "warning", "Cref", `Thread ${thread.id} lacks simulated-scenario metadata: ${missingScenarioFields.join(", ")}.`);
    }
    if (thread.speakerType && thread.speakerType !== "simulated_reader") {
      add("invalid_scenario_speaker", "error", "Cref", `Thread ${thread.id} must identify the questioner as a simulated reader.`);
    }
    if (thread.postingIdentity === "reader_question_template") {
      add("unaccountable_answer_identity", "error", "Cref", `Thread ${thread.id} must use an accountable answer identity.`);
    }
    // P4-19: the answer side must carry an accountable publisher-side identity.
    if (!accountablePostingIdentities.has(thread.postingIdentity)) {
      add("comment_identity_violation", "error", "Cref", `Thread ${thread.id} posting identity "${thread.postingIdentity}" is not an accountable publisher-side identity (publisher/brand/staff/expert).`);
    }
    if (threadKind === "host_reply" && thread.postingIdentity !== "author") {
      add("host_reply_identity_violation", "error", "Cref", `Thread ${thread.id} host_reply must be answered only by the confirmed author.`);
    }
    if (threadKind === "org_answer" && !["publisher", "staff", "expert"].includes(thread.postingIdentity)) {
      add("org_answer_identity_violation", "error", "Cref", `Thread ${thread.id} org_answer must use publisher, staff or expert.`);
    }
    if (threadKind === "organic_reaction" && thread.answer.trim()) {
      add("organic_reaction_answer_violation", "error", "Cref", `Thread ${thread.id} organic_reaction must not contain an answer.`);
    }
    if ((threadKind === "org_answer" || threadKind === "host_reply") && !thread.answer.trim()) {
      add("comment_answer_unavailable", "error", "Cref", `Thread ${thread.id} requires an accountable answer, but the answer node is unavailable; generation must not synthesize fallback prose.`, false);
    }
    const expectedAnswerIdentity = threadKind === "reader_exchange"
      ? "simulated_reader"
      : threadKind === "organic_reaction" ? "none" : thread.postingIdentity;
    if (thread.answerIdentity && thread.answerIdentity !== expectedAnswerIdentity) {
      add("comment_answer_identity_mismatch", "error", "Cref", `Thread ${thread.id} answerIdentity "${thread.answerIdentity}" does not match ${threadKind} semantics (expected "${expectedAnswerIdentity}").`, false);
    }
    if (threadKind === "host_reply") {
      if (config.task.publishingTopology !== "confirmed_individual_author" || config.task.authorContext.status !== "confirmed") {
        add("host_reply_unconfirmed_author", "error", "Cref", `Thread ${thread.id} exposes a host reply without a confirmed individual-author topology.`);
      }
      if (thread.evidenceIds.length > 0) {
        add("host_reply_evidence_violation", "error", "Cref", `Thread ${thread.id} host reply must not carry project evidence IDs.`);
      }
      const allowedFacts = config.task.authorContext.facts.filter((fact) => (thread.authorFactIds ?? []).includes(fact.id));
      if (!allowedFacts.length || !allowedFacts.some((fact) => realizesText(thread.answer, fact.statement) || meaningfulTextOverlap(thread.answer, fact.statement, 0.35))) {
        add("host_reply_author_fact_mismatch", "error", "Cref", `Thread ${thread.id} host reply is not traceable to its allowed human-confirmed author facts.`);
      }
      const hostControlled = splitSensitiveStatements(thread.answer).find((statement) =>
        genericMeasuredClaim.test(statement)
        || marketingPromiseClaim.test(statement)
        || controlledRules.some((rule) => rule.claimType !== "historical_action" && rule.terms.some((term) => term && statement.includes(term)))
        || /(?:我们门诊|我们机构|我们项目|本店|预约|地址|价格|费用|适合|恢复|效果|风险|资质|复发)/u.test(statement));
      if (hostControlled) {
        add("host_reply_controlled_claim", "error", "Cref", `Thread ${thread.id} host reply crosses into a project-controlled claim: ${hostControlled}`);
      }
      if ((thread.followUps?.length ?? 0) > 0) {
        add("host_reply_followup_violation", "error", "Cref", `Thread ${thread.id} host reply must remain a single exchange until node-level identities exist.`);
      }
    }
    // publisher 是明确的项目方账号，不是正文叙事人物。历史错误合同曾把它强制
    // 显示成“楼主”，导致“我们是门诊 / 发照片评估”等机构话术看起来由普通
    // 消费者楼主说出。只要最终成品仍使用叙事身份别名，就直接阻断发布；上游路由、
    // 模型提示词或历史数据任何一层回归，都不能越过这道成品门禁。
    const replyDisplayRole = thread.surfaceRoleCard?.replyDisplayRole?.trim() ?? "";
    if (threadKind === "org_answer" && thread.postingIdentity === "publisher"
      && /^(?:楼主|楼主本人|博主|博主本人|作者本人)$/u.test(replyDisplayRole)) {
      add("publisher_narrative_identity_alias", "error", "Cref", `Thread ${thread.id} uses narrative-person alias “${replyDisplayRole}” for an institutional publisher answer; label it as an explicit project publishing account instead.`);
    }
    // 身份与角色在规划期已经冻结。成稿层只核对，不根据可见问题重新映射：
    // 任一模型阶段、修复阶段或历史兼容层改写 postingIdentity / replyDisplayRole，
    // 都必须阻断发布，而不是静默“修回去”后掩盖串台。
    const plannedThread = plannedThreadById.get(thread.id);
    if (plannedThread && thread.postingIdentity !== plannedThread.postingIdentity) {
      add("reply_identity_plan_drift", "error", "Cref", `Thread ${thread.id} changed frozen postingIdentity from “${plannedThread.postingIdentity}” to “${thread.postingIdentity}”.`);
    }
    const plannedReplyDisplayRole = plannedThread?.surfaceRoleCard?.replyDisplayRole?.trim() ?? "";
    if (plannedThread && replyDisplayRole !== plannedReplyDisplayRole) {
      add("reply_display_role_plan_drift", "error", "Cref", `Thread ${thread.id} changed frozen replyDisplayRole from “${plannedReplyDisplayRole || "(empty)"}” to “${replyDisplayRole || "(empty)"}”.`);
    }
    const plannedGap = input.orchestrationPlan?.gapPlanningCards?.find((card) => card.gapId === plannedThread?.primaryGapId);
    if (plannedThread && plannedGap && threadKind === "org_answer") {
      const guardedIdentities = guardedReplyIdentitiesForQuestion(
        thread.question,
        input.projectBlueprint?.claimPolicy.rules ?? [],
      );
      const introducesConflictingResponsibility = [...guardedIdentities]
        .some((identity) => identity !== plannedThread.postingIdentity);
      if (!questionMatchesPlannedGap(thread.question, plannedGap) || introducesConflictingResponsibility) {
        add("reply_question_plan_drift", "error", "Cref", `Thread ${thread.id} changed the frozen primary question responsibility for gap “${plannedGap.label}”; rewrite the question within the planned gap instead of changing the responder.`);
      }
    }
    // 追问层级(方法论《问题—答复—追问的最小结构》L0—L3):只做**结构**判断,
    // 不判断"这一轮是否真的在补条件"——那是语义,归模型。两条结构规则:
    //   1) 层级不得倒退或重复(L1→L2→L3 单向递进);模型漂移时按 warning 提示,
    //      不阻断——层级是可选标注,历史包与未标注的追问一律跳过。
    //   2) stopReason 只允许出现在最后一轮:它表示"这条线程到此为止",出现在
    //      中间轮却后面还有追问,等于自称停住又继续说。
    const leveledFollowUps = thread.followUps
      .map((followUp, index) => ({ level: followUp.level, index }))
      .filter((item): item is { level: NonNullable<typeof item.level>; index: number } => Boolean(item.level));
    for (let position = 1; position < leveledFollowUps.length; position += 1) {
      const previous = leveledFollowUps[position - 1]!;
      const current = leveledFollowUps[position]!;
      if (current.level <= previous.level) {
        add("comment_follow_up_level_not_ascending", "warning", "Cref", `Thread ${thread.id} follow-up ${current.index + 1} is marked ${current.level} after ${previous.level}; follow-up levels must ascend (L1 condition → L2 counterexample → L3 verification).`, false);
      }
    }
    const earlyStop = thread.followUps.findIndex((followUp) => followUp.stopReason);
    if (earlyStop >= 0 && earlyStop < thread.followUps.length - 1) {
      add("comment_follow_up_stop_not_final", "warning", "Cref", `Thread ${thread.id} follow-up ${earlyStop + 1} declares stopReason "${thread.followUps[earlyStop]!.stopReason}" but ${thread.followUps.length - earlyStop - 1} more follow-up(s) continue after it.`, false);
    }
    // displayName 是纯展示昵称(warning 级,不阻断):不得含机构感词,不得与
    // 项目名或蓝图 accountable 角色(IP/助理名)的 displayRole 相同或互相包含。
    const displayNameNodes: Array<{ label: string; name: string | undefined }> = [
      { label: "提问者", name: thread.displayName },
      ...thread.followUps.map((followUp, index) => ({ label: `第 ${index + 1} 个接话人`, name: followUp.displayName })),
    ];
    for (const node of displayNameNodes) {
      const nickname = node.name?.trim();
      if (!nickname) continue;
      if (INSTITUTIONAL_NICKNAME_TERMS.some((term) => nickname.includes(term))) {
        add("comment_display_name_institutional", "warning", "Cref", `Thread ${thread.id} ${node.label}昵称“${nickname}”含机构感词(${INSTITUTIONAL_NICKNAME_TERMS.join("/")}),易被误认为机构身份。`, false);
      }
      const clashingAnchor = nicknameIdentityAnchors.find((anchor) => nickname.includes(anchor) || anchor.includes(nickname));
      if (clashingAnchor) {
        add("comment_display_name_identity_clash", "warning", "Cref", `Thread ${thread.id} ${node.label}昵称“${nickname}”与可追责身份“${clashingAnchor}”相同或互相包含,读者无法区分提问侧与机构侧。`, false);
      }
    }
    if (threadKind === "org_answer") {
      const serviceSurfaces: Array<{
        location: "Cref.thread" | "Cref.followUp";
        text: string;
        followUpIndex?: number;
      }> = [
        { location: "Cref.thread", text: thread.answer },
        ...thread.followUps.map((followUp, followUpIndex) => ({
          location: "Cref.followUp" as const,
          text: followUp.answer,
          followUpIndex,
        })),
      ];
      for (const surface of serviceSurfaces) {
        const commitment = ungroundedOrganizationServiceCommitment(surface.text);
        if (!commitment) continue;
        // A location/price source does not authorize a new promise to reply,
        // arrange, book or send something later. The service action sentence
        // itself must be represented as a fact with an exact source span at the
        // same visible node.
        const groundedCommitment = ledgerFactSupportsClaim(
          draft,
          commitment,
          surface.location,
          { field: "answer", threadId: thread.id, followUpIndex: surface.followUpIndex },
        );
        if (!groundedCommitment) {
          issues.push({
            code: "ungrounded_organization_service_commitment",
            severity: "error",
            channel: "Cref",
            message: `Thread ${thread.id} promises a future organization action without evidence for that action; state the current unknown instead: ${commitment}`,
            repairable: true,
            disposition: "block",
            origin: "deterministic",
          });
          break;
        }
      }
    }
    // 双号运营:助理(staff)答复话术自由,但价格、数字与承诺类表述必须能锚定
    // 知识库。锚定判定沿用 sensitive_claim_without_evidence 的证据机制(fact
    // 台账 + sourceSpans + conservativeEvidenceSupport);不可锚定不阻断生成
    // (受控声明仍由 error 级 sensitive_claim_without_evidence 拦截),而是
    // warning 提示人工复核出处。读者互动层:T2/T3 的 answer 不是助理发言,
    // 其读者侧受控声明由 reader_exchange_controlled_claim 承接。
    if (threadKind === "org_answer" && thread.postingIdentity === "staff") {
      const staffSurfaces: Array<{
        location: "Cref.thread" | "Cref.followUp";
        occurrence: Partial<FactOccurrence>;
        text: string;
      }> = [
        { location: "Cref.thread", occurrence: { field: "answer", threadId: thread.id }, text: thread.answer },
        ...thread.followUps.map((followUp, followUpIndex) => ({
          location: "Cref.followUp" as const,
          occurrence: { field: "answer" as const, threadId: thread.id, followUpIndex },
          text: followUp.answer,
        })),
      ];
      for (const surface of staffSurfaces) {
        for (const statement of splitEvidenceClaimAtoms(surface.text)) {
          const marketingClaim = genericMeasuredClaim.test(statement)
            || marketingPromiseClaim.test(statement)
            || controlledRules.some((rule) => rule.terms.some((term) => term && statement.includes(term)));
          if (!marketingClaim || /[？?]$/u.test(statement)) continue;
          const grounded = ledgerFactSupportsClaim(draft, statement, surface.location, surface.occurrence);
          if (!grounded) {
            add("marketing_claim_grounding", "warning", "Cref", `Thread ${thread.id} staff answer makes a price/number/promise claim that cannot be anchored to the knowledge base; route to human review: ${statement}`, false);
          }
        }
      }
    }
    // 读者互动层:T2 读者互聊中,读者侧(A 开口、B 接话及后续读者发言)命中受控
    // 声明词表(价格/机构/效果类,即 requiresEvidence 规则词、度量数字、营销承诺
    // 词)→ warning 提示人工复核;证词形态(已完成项目动作 + 效果证词)→ error,
    // 复用 fabricated_operational_experience 语义。T3 漂浮短反应只查证词形态。
    if (threadKind === "reader_exchange" || threadKind === "organic_reaction") {
      const readerNodes = [
        thread.question,
        thread.answer,
        ...thread.followUps.flatMap((followUp) => [followUp.question, followUp.answer]),
      ];
      const readerTestimonial = readerNodes.find((node) =>
        /(?:我|本人).{0,12}(?:做了|做过|买过了?|用过|体验过).{0,12}(?:效果|恢复|满意|值|靠谱)/u.test(node)
        || /(?:效果(?:很好|真的不错|超预期)|恢复得(?:很好|很快)|亲测(?:有效|好用|靠谱))/u.test(node));
      if (readerTestimonial) {
        issues.push({
          code: "creative_persona_experience",
          severity: "warning",
          channel: "Cref",
          message: `A labelled simulated reader carries a consumer experience/testimonial scene; keep it creative and never count it as observed evidence: ${readerTestimonial}`,
          repairable: false,
          disposition: "advisory",
          origin: "deterministic",
        });
      }
      if (threadKind === "reader_exchange") {
        for (const node of readerNodes) {
          for (const statement of splitSensitiveStatements(node)) {
            const controlledHit = genericMeasuredClaim.test(statement)
              || marketingPromiseClaim.test(statement)
              || controlledRules.some((rule) => rule.terms.some((term) => term && statement.includes(term)));
            if (!controlledHit || /[？?]$/u.test(statement)) continue;
            add("reader_exchange_controlled_claim", "warning", "Cref", `Thread ${thread.id} reader-to-reader speech carries a controlled project claim (price/org/effect); a reader may only speak their own situation, feelings and questions — route to human review: ${statement}`, false);
          }
        }
      }
    }
    if (threadKind === "reader_exchange" && thread.question.trim() && thread.answer.trim()) {
      const anchorId = thread.topicAnchorGapId ?? thread.primaryGapId;
      const anchorCard = input.orchestrationPlan?.gapPlanningCards?.find((card) => card.gapId === anchorId);
      const exchanges: Array<{ from: string; to: string; label: string }> = [
        { from: thread.question, to: thread.answer, label: "root reply" },
      ];
      let previous = thread.answer;
      thread.followUps.forEach((followUp, followUpIndex) => {
        if (followUp.question.trim()) exchanges.push({
          from: previous,
          to: followUp.question,
          label: `follow-up ${followUpIndex + 1} question`,
        });
        if (followUp.question.trim() && followUp.answer.trim()) exchanges.push({
          from: followUp.question,
          to: followUp.answer,
          label: `follow-up ${followUpIndex + 1} answer`,
        });
        previous = followUp.answer.trim() || followUp.question.trim() || previous;
      });
      const drift = exchanges.find(({ from, to }) => {
        const continuesTopic = sharesConversationTopic(from, to);
        const pivotTail = to.split(/(?:不过|但是|可我|更想|最怕|话说回来)/u).at(-1)?.trim() ?? "";
        const pivotDrifts = pivotTail !== to.trim()
          && pivotTail.length >= 4
          && !sharesConversationTopic(from, pivotTail);
        return (!continuesTopic && !isPureShortConversationEcho(to)) || pivotDrifts;
      });
      // Reader-exchange roots may be a deliberately vague, noun-less echo
      // ("这个我也在纠结"). It introduces no competing responsibility and
      // therefore need not repeat the server-owned gap label. Any concrete root
      // still has to match the frozen anchor.
      const questionDriftsFromAnchor = Boolean(anchorCard
        && !isPureShortConversationEcho(thread.question)
        && !questionMatchesPlannedGap(thread.question, anchorCard));
      if (drift || questionDriftsFromAnchor) {
        issues.push({
          code: "comment_reply_topic_drift",
          severity: "warning",
          channel: "Cref",
          message: drift
            ? `Thread ${thread.id} ${drift.label} does not visibly continue the previous topic: ${drift.from} -> ${drift.to}`
            : `Thread ${thread.id} root question does not continue its frozen topic: ${thread.question}`,
          repairable: true,
          disposition: "review",
          origin: "deterministic",
        });
      }
    }

    // P4-19: while the body only declares host intent, the publisher answer
    // side must not claim a completed *personal* action. The question side of
    // simulated readers is covered by fabricated_operational_experience (same
    // host-state signal, question-side nodes only).
    //
    // 为什么只管 publisher:三档答复身份都是可追责答复方,都代表机构说话——所以
    // "代表机构"不是区分理由(旧注释按"publisher=顾客人设"写,已随身份翻转失效)。
    // 真正的理由是**声音连续性**:publisher 就是这篇帖子的发布账号,它的答复延续
    // 正文的语气与时序;正文只表达打算时,同一个账号在评论里说"我之前已经做过了"
    // 就是自相矛盾的时序漂移。staff/expert 是另外的公开身份,不承担正文时序。
    //
    // 机构第一人称复数("我们/我方/本店")由 claimsFirstPersonCompletion 排除:
    // 那是发布账号的正常人称("我们上周已经把当期价目更新了"),不是顾客完成时。
    // 读者互动层:T2/T3 的 answer 是模拟读者发言(或空串),不按发布账号声音校验。
    if (hostDeclaresIntent && threadKind === "org_answer" && thread.postingIdentity === "publisher") {
      const completionAnswer = [thread.answer, ...thread.followUps.map((followUp) => followUp.answer)]
        .find((answerText) => claimsFirstPersonCompletion(answerText));
      if (completionAnswer) {
        add("comment_host_state_inconsistency", "error", "Cref", `Thread ${thread.id} answer claims a completed first-person action while the body only declares intent; the host persona must stay consistent: ${completionAnswer}`);
      }
    }
    if (thread.claimStatus === "verified" && thread.evidenceIds.length === 0) {
      add("verified_claim_without_evidence", "error", "Cref", `Thread ${thread.id} marks its answer verified without evidence.`);
    }
    if (thread.claimStatus === "verified" && !draft.reasoning.some((item) =>
      item.status === "fact"
      && item.location === "Cref.thread"
      && item.occurrence?.threadId === thread.id
      && item.occurrence.field === "answer"
      && thread.answer.includes(item.statement)
      && item.evidenceIds.some((id) => thread.evidenceIds.includes(id)),
    )) {
      add("verified_thread_claim_not_mapped", "error", "Cref", `Thread ${thread.id} is verified but its visible answer has no fact-to-source reasoning entry.`);
    }
    const exactThreadEvidenceIds = draft.reasoning
      .filter((item) => item.status === "fact" && item.location === "Cref.thread" && item.occurrence?.threadId === thread.id)
      .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId));
    if (!sameStringSet(thread.evidenceIds, exactThreadEvidenceIds)) {
      add("thread_evidence_ledger_mismatch", "error", "Cref", `Thread ${thread.id} evidenceIds must exactly equal factual source spans cited in that thread.`);
    }
    for (const [followUpIndex, followUp] of thread.followUps.entries()) {
      const exactFollowUpEvidenceIds = draft.reasoning
        .filter((item) => item.status === "fact" && item.location === "Cref.followUp"
          && item.occurrence?.threadId === thread.id && item.occurrence.followUpIndex === followUpIndex)
        .flatMap((item) => (item.sourceSpans ?? []).map((span) => span.evidenceId));
      if (!sameStringSet(followUp.evidenceIds, exactFollowUpEvidenceIds)) {
        add("followup_evidence_ledger_mismatch", "error", "Cref", `Thread ${thread.id} follow-up ${followUpIndex} evidenceIds must exactly equal its factual source spans.`);
      }
    }
    const scenarioText = [thread.question, thread.answer, ...thread.followUps.flatMap((item) => [item.question, item.answer])].join("\n");
    if (/(?:\u6211|\u672c\u4eba|\u670b\u53cb|\u95fa\u871c|\u540c\u4e8b|\u7f51\u53cb).{0,16}(?:\u505a\u4e86|\u505a\u8fc7|\u4e70\u4e86|\u7528\u8fc7|\u4eb2\u6d4b|\u672f\u540e|\u6062\u590d|\u6548\u679c|\u4f53\u9a8c)/u.test(scenarioText)) {
      add(thread.simulated === true ? "creative_persona_experience" : "unlabelled_consumer_experience", thread.simulated === true ? "warning" : "error", "Cref", `Thread ${thread.id} contains a personified experience fragment; keep it labelled as creative reference and never count it as observed evidence.`, false);
    }
    if (/(?:\u7f51\u53cb|\u5927\u5bb6|\u5f88\u591a\u4eba|\u670b\u53cb|\u95fa\u871c|\u540c\u4e8b|\u7fa4\u91cc|\u5e73\u53f0\u4e0a).{0,16}(?:\u90fd\u8bf4|\u63a8\u8350|\u8bc4\u4ef7|\u53e3\u7891|\u53cd\u9988|\u4eb2\u6d4b|\u6709\u6548|\u5f88\u597d)/u.test(scenarioText)) {
      add(thread.simulated === true ? "creative_reputation_scene" : "unlabelled_third_party_reputation", thread.simulated === true ? "warning" : "error", "Cref", `Thread ${thread.id} contains a social/reputation scene; it is usable only as labelled creative reference, not independent proof.`, false);
    }
    if (thread.postingIdentity === "reader_question_template" && /(?:\u6211|\u672c\u4eba).{0,10}(?:\u505a\u4e86|\u505a\u5b8c|\u4eb2\u6d4b|\u672f\u540e|\u6548\u679c)/u.test(thread.answer)) {
      add("fabricated_testimonial", "error", "Cref", `Thread ${thread.id} uses a reader template to claim personal experience.`);
    }
    // M7 convergence (design 组件 E · E1/E2, densityProxy row): the density "contract" is
    // now anchored on roleCard + primaryGapId ONLY. densityProxy is downgraded to an
    // OPTIONAL audit field, so its presence no longer forms the contract and its absence no
    // longer triggers comment_density_metadata_incomplete. When densityProxy IS present it is
    // still audited for consistency (comment_density_proxy_mismatch); the real structural
    // constraint (缺口多路复用上限, comment_gap_multiplexing_exceeded) is retained.
    const hasDensityContract = Boolean(thread.roleCard || thread.primaryGapId);
    if (threadKind === "org_answer" && !thread.replyPlan) {
      add("comment_reply_plan_missing", "warning", "Cref", `Thread ${thread.id} has no structured replyPlan; historical content remains readable but cannot be fully audited.`);
    }
    if (threadKind === "org_answer" && !thread.discoveryPlan) {
      add("comment_discovery_plan_missing", "warning", "Cref", `Thread ${thread.id} has no same-thread discoveryPlan; historical content remains readable but cannot be fully audited.`);
    } else if (thread.discoveryPlan) {
      // M7: discoveryPlan is now optional/streamlined, so its scaffolding fields may be
      // absent. The three safety checks below are RETAINED at `error` level and stay
      // correct on streamlined plans — absent optional fields fold to "" and simply do
      // not trip a regex, while `boundary` (always present) still anchors false-closure.
      const discoveryText = `${thread.discoveryPlan.cue ?? ""}\n${thread.discoveryPlan.inferencePrompt ?? ""}\n${thread.discoveryPlan.reveal ?? ""}`;
      if (/(?:评论区再说|评论里再说|懂的都懂|先不说答案|答案先不说|留到评论|想知道.*(?:评论|留言))/u.test(discoveryText)) {
        add("comment_discovery_withholding", "error", "Cref", `Thread ${thread.id} deliberately withholds information instead of revealing it in the same thread.`);
      }
      const certainty = /(?:足以确定|完全确定|已经确定|一定适用|必然(?:适用|有效|正确)|毫无疑问|无需.{0,6}核实)/u.test(`${thread.discoveryPlan.reveal ?? ""}\n${thread.replyPlan?.directAnswer ?? ""}`);
      const unresolved = /(?:不足|不能确定|无法确定|未知|仍需|还需|缺少|不代填)/u.test(`${thread.discoveryPlan.boundary}\n${thread.replyPlan?.unknown ?? ""}\n${thread.discoveryPlan.selfCheck ?? ""}`);
      if (certainty && unresolved) {
        add("comment_discovery_false_closure", "error", "Cref", `Thread ${thread.id} turns a discovery cue into certainty despite an explicit unknown or boundary.`);
      }
      if (/(?:发现感|猜到|推断过程|互动感).{0,8}(?:就是|等于|证明|作为)证据/u.test(discoveryText)) {
        add("comment_discovery_as_evidence", "error", "Cref", `Thread ${thread.id} treats discovery or inference as evidence.`);
      }
    }
    if (hasDensityContract) {
      if (!thread.roleCard || !thread.primaryGapId) {
        add("comment_density_metadata_incomplete", "error", "Cref", `Thread ${thread.id} must include roleCard and one primaryGapId together.`);
      } else {
        if (thread.gap && thread.primaryGapId !== thread.gap) {
          add("comment_primary_gap_mismatch", "error", "Cref", `Thread ${thread.id} must have exactly one primary gap shared by gap and primaryGapId.`);
        }
        if (thread.roleCard.stage !== thread.stage) {
          add("comment_role_stage_mismatch", "error", "Cref", `Thread ${thread.id} roleCard.stage must match thread.stage.`);
        }
        const auxiliaryGapIds = thread.auxiliaryGapIds ?? [];
        const auxiliaryLimit = (config.parameters?.commentGapMultiplexing ?? 55) <= 35
          ? 0 : (config.parameters?.commentGapMultiplexing ?? 55) <= 70 ? 1 : 2;
        if (auxiliaryGapIds.length > auxiliaryLimit || auxiliaryGapIds.includes(thread.primaryGapId)) {
          add("comment_gap_multiplexing_exceeded", "error", "Cref", `Thread ${thread.id} may use one primary gap and at most ${auxiliaryLimit} distinct auxiliary dimensions.`);
        }
        // densityProxy is an OPTIONAL audit field (M7): validate its self-consistency only
        // when it is present. A missing densityProxy is no longer an incompleteness error.
        if (thread.densityProxy
          && (thread.densityProxy.primaryGapCount !== 1
            || thread.densityProxy.auxiliaryDimensionCount !== auxiliaryGapIds.length
            || thread.densityProxy.constraintCount !== thread.roleCard.constraints.length
            || thread.densityProxy.expectedReplyComponents !== 5)) {
          add("comment_density_proxy_mismatch", "error", "Cref", `Thread ${thread.id} densityProxy does not explain its actual structure.`);
        }
        const allowedRoleConstraints = new Set([
          ...config.informationWindow.boundaries,
          ...(config.task.city ? [`已披露地点范围：${config.task.city}`] : []),
        ]);
        // M7 per-mechanism ruling — 需求 7.6/7.7 / design 组件 E · E1: role grounding (角色接地)
        // is part of the persona-scene/dialogue (a)+(b) required backbone and is NOT downgraded.
        // A simulated role may only assert constraints that were disclosed or explicitly marked
        // for verification, so this stays an `error`-level hard gate.
        const unsafeConstraint = thread.roleCard.constraints.find((constraint) =>
          !allowedRoleConstraints.has(constraint)
          && !constraint.startsWith("待核实维度：")
          && /(?:\d+\s*(?:元|万元|天|公里|岁)|预算(?:是|为)|住在|职业(?:是|为)|我(?:已经|做过|用过))/u.test(constraint),
        );
        if (unsafeConstraint) {
          add("comment_role_constraint_ungrounded", "error", "Cref", `Thread ${thread.id} contains a role constraint that is neither disclosed nor marked for verification: ${unsafeConstraint}`);
        }
      }
    }
    const comparableQuestion = normalizedComparable(thread.question);
    const comparableAnswer = normalizedComparable(thread.answer);
    const priorQuestion = seenQuestions.get(comparableQuestion);
    const priorAnswer = seenAnswers.get(comparableAnswer);
    if (comparableQuestion.length >= 6 && priorQuestion) add("duplicate_comment_question", "error", "Cref", `Thread ${thread.id} repeats the question from ${priorQuestion}.`);
    if (comparableAnswer.length >= 12 && priorAnswer) add("duplicate_comment_answer", "error", "Cref", `Thread ${thread.id} repeats the answer from ${priorAnswer}.`);
    if (comparableQuestion) seenQuestions.set(comparableQuestion, thread.id);
    if (comparableAnswer) seenAnswers.set(comparableAnswer, thread.id);
    const visibleNodes = [
      thread.question,
      thread.answer,
      thread.boundary ?? "",
      thread.nextStep ?? "",
      ...thread.followUps.flatMap((item) => [item.question, item.answer, item.boundary ?? ""]),
    ];
    const leakedPlan = visibleNodes.find((node) => /(?:主问题原文|只可改成|不得增加其他主题|表达方式|像.{1,16}(?:一样|那样)[，,]?(?:只|先)|先指出.{0,24}(?:细节|可见)|用一句.{0,24}提醒|只问[“"][^”"]+[”"]里|顺势问[“"])/u.test(node));
    if (leakedPlan) {
      add("comment_plan_language_surface_leak", "error", "Cref", `A visible comment renders a writing instruction instead of a person speaking: ${leakedPlan}`);
    }
    const questionnaireQuestion = /(?:公开渠道(?:能|可)?(?:查到|看到|核验)的有哪些|有哪些(?:可公开|能公开|可以公开|可核验|能核验)(?:的)?(?:信息|内容)?|具体要看什么条件|需要核实哪些(?:条件|信息)|由哪个(?:明确)?身份(?:来)?确认|行动前还要再次确认哪些)/u.test(thread.question);
    if (questionnaireQuestion) {
      add("comment_questionnaire_voice", "warning", "Cref", `Thread ${thread.id} sounds like an interview checklist instead of its frozen reader persona: ${thread.question}`);
    }
    const prohibitedHistories = input.projectBlueprint
      ? prohibitedHistoryTerms(input.projectBlueprint)
      : [];
    // 模拟读者的经历表述走**标注制**,不走名额制——禁的是"被当成证据"
    // (generated_reference 升级为 observed / 独立口碑),不是"出现几条"。逐角色
    // 的"禁止代替的证据"(首次调研者不能说"我已经体验过"等)由读者侧角色卡在提
    // 示词里承担;此处只保留两条不可让位的硬门槛,按**任何可见节点**校验:
    //   1) 蓝图禁止的未完成经历(prohibitedHistories)——按项目/行业配出来的;
    //   2) 证词形态(第一人称完成 + 效果背书)——跨行业成立,"我做过效果很好"在
    //      任何行业都是独立口碑,不是处境。
    // 两条都覆盖答复侧:可追责身份(publisher/author/brand/staff/expert)同样不得
    // 冒充独立消费者,comment_host_state_inconsistency 只管 publisher 一档,不足
    // 以覆盖 staff/expert/brand 的答复。
    //
    // 这里**不再**放"老用户/回购/亲测"这类跨行业硬编码词表:那类说法是否构成
    // 不当身份声明取决于项目的服务模型与领域——recurring/mixed 项目里复购类身份
    // 声明需要证据支撑;one_time 项目里它本就不该出现;而另一些领域里它只是中性
    // 说法,一律判 error 就是误伤。判断权归项目分析
    // 阶段:蓝图按 serviceModel 与行业产出 prohibitedUnsupportedHistories /
    // claimType=historical_action 的 terms,本校验照真源生效,不另立第二套词表。

    // Build testimonial pattern dynamically from project blueprint to avoid industry-specific hardcodes.
    // Extract completion verbs from domain_model.actions and outcome terms from claim_policy.
    const buildTestimonialPattern = (blueprint?: ProjectCreativeBlueprint): RegExp => {
      if (!blueprint) {
        // Fallback to generic pattern when blueprint is unavailable
        return /(?:我|本人).{0,12}(?:做了|做过|买过了?|用过|体验过).{0,12}(?:效果|恢复|满意|值|靠谱)/u;
      }

      // Extract completion verbs from domain_model.actions (e.g. "装修" → "装修了|装修过")
      const actions = blueprint.domainModel.actions.filter((action) => /^[一-龥]{1,4}$/.test(action));
      const completionVerbs = actions.length
        ? actions.flatMap((action) => [`${action}了`, `${action}过`]).join('|')
        : '';

      // Extract prohibited histories that imply completion
      const prohibitedCompletions = blueprint.scenarioModel.families
        .flatMap((family) => family.prohibitedUnsupportedHistories ?? [])
        .filter((phrase) => /(?:了|过)/.test(phrase))
        .join('|');

      // Combine sources, fallback to generic verbs if both are empty
      const actionPattern = completionVerbs || prohibitedCompletions || '做了|做过|买过了?|用过|体验过';

      // Extract outcome terms from claim_policy outcome rules
      const outcomeRules = blueprint.claimPolicy.rules.filter((rule) => rule.claimType === 'outcome');
      const outcomeTerms = outcomeRules.length
        ? outcomeRules.flatMap((rule) => rule.terms).filter((term) => /^[一-龥]{1,6}$/.test(term)).join('|')
        : '';

      // Fallback to generic outcome terms
      const outcomePattern = outcomeTerms || '效果|恢复|满意|值|靠谱|有用';

      // Build first-person completion + outcome pattern
      const firstPersonPattern = `(?:我|本人).{0,12}(?:${actionPattern}).{0,12}(?:${outcomePattern})`;

      // Add standalone outcome testimonial pattern (no subject needed)
      const standalonePattern = `(?:效果(?:很好|真的不错|超预期)|恢复得(?:很好|很快)|亲测(?:有效|好用|靠谱))`;

      return new RegExp(`(?:${firstPersonPattern}|${standalonePattern})`, 'u');
    };

    const testimonialPattern = buildTestimonialPattern(input.projectBlueprint);
    // Consumer-side nodes are explicitly labelled creative scenarios. They may
    // contain completed experiences or subjective outcomes, but never become
    // observed evidence. Accountable organization answers are different: a
    // staff/expert/publisher speaking as a consumer is identity deception and
    // remains a hard publication block.
    const accountableAnswerNodes = threadKind === "org_answer"
      ? [thread.answer, ...thread.followUps.map((item) => item.answer)].filter(Boolean)
      : [];
    const accountableConsumerMasquerade = accountableAnswerNodes.find((node) => {
      const singularConsumerVoice = /(?:^|[^我])我(?!们|方)/u.test(node);
      if (!singularConsumerVoice) return false;
      return assertsProhibitedHistory(node, prohibitedHistories)
        || testimonialPattern.test(node)
        || claimsFirstPersonCompletion(node);
    });
    if (accountableConsumerMasquerade) {
      add("fabricated_operational_experience", "error", "Cref", `An accountable organization answer masquerades as a consumer experience: ${accountableConsumerMasquerade}`);
    }
  }
  // P4-21: an answer that substantially overlaps disclosed knowledge but has
  // no fact ledger entry is a bookkeeping gap, not a content violation — warn
  // so the claim gets recorded as fact with source spans (or stays visibly
  // bounded). Question-side nodes are not claims and are not scanned.
  const knowledgeQuotes = (input.evidenceReferences ?? [])
    .flatMap((reference) => [reference.quote, ...(reference.quotedSpans ?? [])])
    .filter((quote): quote is string => typeof quote === "string" && quote.trim().length >= 4);
  if (knowledgeQuotes.length) {
    // 读者互动层:只有 T1 机构问答的答复侧可能是知识口径声明;T2/T3 的
    // answer 是模拟读者发言(或空串),不参与知识重合记账复核。
    const answerSurfaces = draft.content.Cref.threads
      .filter((thread) => commentThreadKindOf(thread) === "org_answer")
      .flatMap((thread) => [
        { threadId: thread.id, occurrence: { field: "answer" as const, threadId: thread.id }, text: thread.answer },
        ...thread.followUps.map((followUp, followUpIndex) => ({
          threadId: thread.id,
          occurrence: { field: "answer" as const, threadId: thread.id, followUpIndex },
          text: followUp.answer,
        })),
      ]);
    const warnedSegments = new Set<string>();
    for (const surface of answerSurfaces) {
      const segments = surface.text
        .split(/(?<=[。！？!?；;\n])/u)
        .map((item) => item.trim())
        .filter((item) => item.length >= 4);
      for (const segment of segments) {
        if (/[？?]$/u.test(segment) || /(?:未知|待核实|不能确定|无法确定)/u.test(segment)) continue;
        if (warnedSegments.has(segment)) continue;
        const hitsKnowledge = knowledgeQuotes.some((quote) => meaningfulTextOverlap(segment, quote, 0.4));
        if (!hitsKnowledge) continue;
        const surfaceLocation = "followUpIndex" in surface.occurrence ? "Cref.followUp" : "Cref.thread";
        // Historical/read-only validation may explicitly disable exact evidence
        // references. In that compatibility mode this warning asks only whether
        // the whole visible statement was recorded as a fact. It must not silently
        // upgrade that legacy row to publication-grade grounding.
        const compatibilityRecorded = !config.diagnostics.requireEvidenceReferences
          && draft.reasoning.some((item) => item.status === "fact"
            // Historical rows may predate location/occurrence metadata. This is
            // only the bookkeeping reminder path; publication-grade checks never
            // accept a location-less row.
            && (!item.location || item.location === surfaceLocation)
            && (conservativeEvidenceSupport(segment, item.statement)
              || combinedEvidenceSupport(segment, [item.statement])));
        const recordedAsFact = compatibilityRecorded || evidenceClaimAtoms(segment).every((atom) =>
          ledgerFactSupportsClaim(draft, atom, surfaceLocation, surface.occurrence));
        if (recordedAsFact) continue;
        warnedSegments.add(segment);
        add("knowledge_backed_claim_unrecorded", "warning", "Cref", `Thread ${surface.threadId} answer overlaps disclosed knowledge but has no fact ledger entry; record it as fact with source spans or keep it visibly bounded: ${segment}`, false);
      }
    }
  }
  const plannedCoverage = input.orchestrationPlan?.gapCoverageLedger;
  if (!plannedCoverage || !input.orchestrationPlan) {
    add("comment_gap_coverage_ledger_missing", "warning", "Cref", "No global gap coverage ledger is available; historical content remains readable but silent gap loss cannot be audited.", false);
  } else {
    const coverage = evaluateGapCoverageRealization(draft, input.orchestrationPlan);
    const actualThreadIds = new Set(draft.content.Cref.threads.map((thread) => thread.id));
    if (coverage.effectiveThreadCount !== input.orchestrationPlan!.effectiveThreadCount
      || coverage.targetThreadCount !== input.orchestrationPlan!.targetThreadCount) {
      add("comment_coverage_capacity_mismatch", "error", "Cref", "Coverage ledger thread counts do not match the orchestration plan.", false);
    }
    const ledgerGapIds = new Set(coverage.entries.map((entry) => entry.gapId));
    const missingSelectedGapIds = input.orchestrationPlan!.selectedGapIds.filter((id) => !ledgerGapIds.has(id));
    if (coverage.uncoveredGapIds.length || missingSelectedGapIds.length || coverage.ledgerCompleteness !== 1) {
      const missing = [...new Set([...coverage.uncoveredGapIds, ...missingSelectedGapIds])];
      add("comment_gap_silently_dropped", "error", "Cref", `Coverage ledger is incomplete: ${missing.join(", ") || `ledgerCompleteness=${coverage.ledgerCompleteness}`}.`, false);
    }
    for (const entry of coverage.entries) {
      const correctlyBoundPrimaryIds = draft.content.Cref.threads
        .filter((thread) => thread.primaryGapId === entry.gapId && (!thread.gap || thread.gap === entry.gapId))
        .map((thread) => thread.id);
      if (entry.commentAllocated && correctlyBoundPrimaryIds.length === 0) {
        add("comment_gap_missing_primary", "error", "Cref", `Comment-owned gap ${entry.gapId} must appear as a primary gap at least once.`, false);
      }
      if (entry.auxiliaryThreadIds.length > 0 && entry.primaryThreadIds.length === 0 && (entry.status === "body_resolved" || entry.status === "thread_resolved")) {
        add("comment_auxiliary_false_resolution", "error", "Cref", `Gap ${entry.gapId} was marked resolved from auxiliary use only.`, false);
      }
      if (entry.required && entry.status === "explicitly_deferred") {
        add("comment_required_gap_deferred", "error", "Cref", `Required gap ${entry.gapId} cannot be explicitly deferred.`, false);
      }
      if (entry.status === "awaiting_user_input" && !entry.requiredInput) {
        add("comment_gap_input_unspecified", "error", "Cref", `Gap ${entry.gapId} awaits user input but does not name the needed input.`, false);
      }
      if (entry.status === "unknown_with_verification" && !entry.verificationPath) {
        add("comment_gap_verification_unspecified", "error", "Cref", `Gap ${entry.gapId} is unknown but has no verification path.`, false);
      }
      if (entry.status === "awaiting_user_input" || entry.status === "unknown_with_verification") {
        const card = input.orchestrationPlan!.gapPlanningCards?.find((item) => item.gapId === entry.gapId);
        if (entry.plannedPlacements.includes("N.body")
          && !realizesVisibleUnknownPath(draft.content.N.body, card, entry.status)) {
          add("allocated_unknown_path_not_visible", entry.required ? "error" : "warning", "N.body", `Allocated unknown gap ${entry.gapId} is not fully spelled out in the body; optional adjacent gaps may remain open when the complete post/comment network still makes the main task clear.`, entry.required);
        }
        if (entry.plannedPlacements.includes("Cref")) {
          const visibleThreads = draft.content.Cref.threads
            .filter((thread) => thread.primaryGapId === entry.gapId && (!thread.gap || thread.gap === entry.gapId))
            .map((thread) => `${thread.question}\n${thread.answer}\n${thread.nextStep ?? ""}`)
            .join("\n");
          if (!realizesVisibleUnknownPath(visibleThreads, card, entry.status, true)) {
            add("allocated_unknown_path_not_visible", entry.required ? "error" : "warning", "Cref", `Allocated unknown gap ${entry.gapId} is not fully closed in one primary thread; review its contribution across the visible comment network.`, entry.required);
          }
        }
      }
      if (entry.primaryThreadIds.some((id) => !actualThreadIds.has(id))) {
        add("comment_gap_primary_thread_missing", "error", "Cref", `Gap ${entry.gapId} references a primary thread that is absent from the output.`, false);
      }
      const wrongPrimaryThread = entry.primaryThreadIds.find((id) => {
        const actual = draft.content.Cref.threads.find((thread) => thread.id === id);
        return actual && (actual.primaryGapId !== entry.gapId || Boolean(actual.gap && actual.gap !== entry.gapId));
      });
      if (wrongPrimaryThread) {
        add("comment_gap_primary_thread_mismatch", "error", "Cref", `Thread ${wrongPrimaryThread} exists but is not bound to its planned primary gap ${entry.gapId}.`, false);
      }
      if (entry.status === "realization_failed") {
        const missing = [...new Set(entry.actualRealizations.flatMap((realization) => realization.missing))];
        add(
          "gap_resolution_not_realized",
          entry.required ? "error" : "warning",
          entry.plannedPlacements.includes("N.body") ? "N.body" : "Cref",
          `Gap ${entry.gapId} was planned as resolved but the final visible output is missing: ${missing.join(", ") || "verified realization"}.`,
          entry.required,
        );
      }
      if (entry.status === "body_resolved" && !entry.actualRealizations.some((item) => item.channel === "N.body" && item.resolved)) {
        add("body_gap_false_resolution", "error", "N.body", `Gap ${entry.gapId} cannot be marked body_resolved without a verified final-body realization.`, false);
      }
      const card = input.orchestrationPlan!.gapPlanningCards?.find((item) => item.gapId === entry.gapId);
      const hasGroundedResolution = Boolean(card && (card.answer || card.framework) && card.evidenceIds.length);
      /*
       * 这两条只在「计划了某通道但那里确实是空的」时报,不再重复播报
       * gap_resolution_not_realized 已经说过的事。
       *
       * 原实现的条件是 `!resolved`,而 resolved 是 5 个条件的合取(含依赖逐字
       * 包含的 answerRealized)。于是同一个 gap 只要词面对不上,就同时触发
       * gap_resolution_not_realized + planned_body_gap_not_realized +
       * planned_comment_gap_not_realized 三条——一份缺陷拆成三条提醒,实测三者
       * 命中率同为 83~84%,观感噪声放大三倍。
       *
       * 改判 findable:正文有没有写、线程有没有答复,这是能确定判定的事实。
       * 「写了但词面对不上」交给 gap_resolution_not_realized 一条播报。
       */
      if (hasGroundedResolution && entry.plannedPlacements.includes("N.body")
        && !entry.actualRealizations.some((item) => item.channel === "N.body" && item.findable)) {
        add("planned_body_gap_not_realized", entry.required ? "error" : "warning", "N.body", `Grounded gap ${entry.gapId} was assigned to the body but nothing addressing it is present there; optional adjacent information may move to the comment network.`, entry.required);
      }
      if (hasGroundedResolution && entry.plannedPlacements.includes("Cref")
        && !entry.actualRealizations.some((item) => item.channel === "Cref" && item.findable)) {
        add("planned_comment_gap_not_realized", entry.required ? "error" : "warning", "Cref", `Grounded gap ${entry.gapId} has no planned thread carrying an answer; optional information may be distributed across short social nodes.`, entry.required);
      }
    }
  }
  if (ledger.conflicts.length && draft.reasoning.some((item) => item.status === "fact" && ledger.conflicts.some((conflict) => item.statement.includes(conflict.key)))) {
    add("conflict_as_fact", "error", "package", "An unresolved conflicting key was presented as settled fact.");
  }
  if (config.diagnostics.warnDuplicateInformation) {
    for (const thread of draft.content.Cref.threads) {
      if (thread.answer.length >= 20 && draft.content.N.body.includes(thread.answer)) {
        add("duplicate_channel_information", "warning", "Cref", `Thread ${thread.id} duplicates a body passage verbatim.`);
      }
    }
  }
  if (input.orchestrationPlan) {
    const alignment = evaluatePlanToCopyAlignment(
      input.orchestrationPlan,
      draft.content,
      config.content.imageBriefEnabled,
    );
    if (alignment.status === "fail") {
      add(
        "plan_to_copy_alignment",
        "error",
        "N.imageBrief",
        `Plan-to-copy alignment found an explicit boundary contradiction: ${alignment.reasons.join(" ")}`,
      );
    } else if (alignment.status === "warn") {
      add(
        "plan_to_copy_alignment",
        "warning",
        "N.imageBrief",
        `Plan-to-copy alignment needs human review: ${alignment.reasons.join(" ")}`,
        false,
      );
    }
  }
  return issues.map(normalizeContentValidationIssue);
}

export function diagnosticsFromValidation(issues: ContentValidationIssue[]): ContentDiagnostic[] {
  const errors = issues.filter((item) => issueDisposition(item) === "block");
  const warnings = issues.filter((item) => issueDisposition(item) !== "block");
  return [
    {
      name: "hard_constraints",
      status: errors.length ? "fail" : "pass",
      explanation: errors.length ? `${errors.length} hard constraint issue(s) remain.` : "All hard constraints passed.",
      score: errors.length ? 0 : 1,
    },
    {
      name: "review_warnings",
      status: warnings.length ? "warn" : "pass",
      explanation: warnings.length ? `${warnings.length} non-blocking warning(s) remain.` : "No review warnings.",
      score: warnings.length ? Math.max(0, 1 - warnings.length * 0.1) : 1,
    },
  ];
}

export interface GenerationDraftPatch {
  H?: ContentPackageContent["H"];
  N?: Partial<ContentPackageContent["N"]>;
  Cref?: ContentPackageContent["Cref"];
  evidenceIds?: string[];
  reasoning?: GenerationDraft["reasoning"];
  unknowns?: UnknownItem[];
}

/**
 * P4-22: normalize full-width punctuation that models emit in JSON structural
 * positions (“ ” as string delimiters, ，：between tokens) without corrupting
 * the same characters inside string values. A small state machine tracks
 * whether each character sits inside a string literal and which delimiter
 * opened it. Implemented inside agent-core; the generation parse path stays
 * strict — only repair patches get this tolerance.
 */
function normalizePatchJsonDelimiters(input: string): string {
  const openQuotes = new Set(["“", "„", "‟"]);
  const closeQuotes = new Set(["”", "″", "‶"]);
  let out = "";
  let inString = false;
  let delimiter: "ascii" | "cjk" = "ascii";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (inString) {
      if (delimiter === "ascii") {
        if (character === "\\") {
          out += character + (input[index + 1] ?? "");
          index += 1;
          continue;
        }
        if (character === "\"") {
          out += "\"";
          inString = false;
          continue;
        }
        out += character;
        continue;
      }
      // Full-width delimited string: close only on a full-width close quote;
      // an ASCII quote inside is content and must be escaped.
      if (closeQuotes.has(character)) {
        out += "\"";
        inString = false;
        continue;
      }
      if (character === "\"") {
        out += "\\\"";
        continue;
      }
      out += character;
      continue;
    }
    if (character === "\"") {
      out += "\"";
      inString = true;
      delimiter = "ascii";
      continue;
    }
    if (openQuotes.has(character)) {
      out += "\"";
      inString = true;
      delimiter = "cjk";
      continue;
    }
    if (character === "，") {
      out += ",";
      continue;
    }
    if (character === "：") {
      out += ":";
      continue;
    }
    out += character;
  }
  return out;
}

/** Lenient patch-object read: strict first, full-width-normalized fallback. */
function parsePatchJsonObject(text: string): Record<string, unknown> {
  try {
    return parseJsonObject(text);
  } catch (strictError) {
    const normalized = normalizePatchJsonDelimiters(text);
    if (normalized === text) throw strictError;
    return parseJsonObject(normalized);
  }
}

export function parseGenerationPatch(text: string): GenerationDraftPatch {
  const value = parsePatchJsonObject(text);
  const patch: GenerationDraftPatch = {};
  if (isRecord(value.H)) {
    const hashtags = stringArray(value.H.hashtags);
    if (!hashtags) throw new Error("Repair patch H.hashtags must be a string array.");
    patch.H = { hashtags: [...new Set(hashtags.map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))] };
  }
  if (isRecord(value.N)) {
    patch.N = {};
    for (const key of ["imageBrief", "title", "body"] as const) {
      if (value.N[key] !== undefined) {
        if (typeof value.N[key] !== "string") throw new Error(`Repair patch N.${key} must be a string.`);
        patch.N[key] = value.N[key].trim();
      }
    }
  }
  if (isRecord(value.Cref)) {
    // P4-22: a Cref patch must restate the simulation disclaimer; silently
    // defaulting it hid malformed repair output behind a canned sentence.
    if (typeof value.Cref.disclaimer !== "string" || !value.Cref.disclaimer.trim()) {
      throw new Error("Repair patch Cref.disclaimer must be a non-empty string.");
    }
    patch.Cref = parseContent({ H: { hashtags: [] }, N: { imageBrief: "", title: "", body: "" }, Cref: value.Cref }).Cref;
  }
  if (value.evidenceIds !== undefined) {
    const ids = stringArray(value.evidenceIds);
    if (!ids) throw new Error("Repair patch evidenceIds must be a string array.");
    patch.evidenceIds = ids;
  }
  if (value.reasoning !== undefined || value.unknowns !== undefined) {
    const shell = JSON.stringify({
      content: { H: { hashtags: [] }, N: { imageBrief: "", title: "", body: "" }, Cref: { disclaimer: "reference", threads: [] } },
      evidenceIds: value.evidenceIds ?? [],
      reasoning: value.reasoning ?? [],
      unknowns: value.unknowns ?? [],
    });
    const parsed = parseGenerationDraft(shell);
    if (value.reasoning !== undefined) patch.reasoning = parsed.reasoning;
    if (value.unknowns !== undefined) patch.unknowns = parsed.unknowns;
  }
  if (!Object.keys(patch).length) throw new Error("Repair patch did not contain a recognized field.");
  return patch;
}

/**
 * P4-22: merge a visible-copy Cref patch into the current Cref keyed by
 * thread id. Out-of-order and partial patches are accepted — threads the
 * patch omits keep their current prose; a patch thread with no follow-ups
 * keeps the current follow-ups. Only genuinely unplanned thread ids fail
 * (caller converts that into a retryable repair issue). Cref-level contract
 * fields (ownedFirstComment/uncoveredGaps) always survive a prose patch.
 */
export function mergeCrefPatchById(
  current: ContentPackageContent["Cref"],
  patch: ContentPackageContent["Cref"],
): ContentPackageContent["Cref"] {
  const currentIds = new Set(current.threads.map((thread) => thread.id));
  const unplanned = patch.threads.find((thread) => !currentIds.has(thread.id));
  if (unplanned) {
    throw new Error(`Comment repair returned an unplanned thread id: ${unplanned.id}`);
  }
  const patchedById = new Map(patch.threads.map((thread) => [thread.id, thread]));
  return {
    ...current,
    disclaimer: patch.disclaimer,
    threads: current.threads.map((currentThread) => {
      const visibleThread = patchedById.get(currentThread.id);
      if (!visibleThread) return currentThread;
      return {
        ...currentThread,
        question: visibleThread.question,
        answer: visibleThread.answer,
        followUps: visibleThread.followUps.length
          ? visibleThread.followUps.map((visibleFollowUp, followUpIndex) => ({
            ...(currentThread.followUps[followUpIndex] ?? {
              personaRole: currentThread.personaRole,
              speakerType: "simulated_reader" as const,
              claimStatus: "hypothetical" as const,
              replyTo: currentThread.id,
              threadDepth: followUpIndex + 1,
              simulated: true,
              simulationLabel: "模拟潜在读者接话",
              evidenceIds: [],
            }),
            question: visibleFollowUp.question,
            answer: visibleFollowUp.answer,
            evidenceIds: [],
          }))
          : currentThread.followUps,
      };
    }),
  };
}

export function applyGenerationPatch(current: GenerationDraft, patch: GenerationDraftPatch): GenerationDraft {
  return {
    // Repair patches may change only the fields declared by GenerationDraftPatch.
    // Preserve side-channel audit artifacts (for example the comment editor's
    // assessment) across a focused copy repair. Claim judgments are safe to carry
    // here because the engine reruns the judge after every repair; that pass clears
    // stale judgments before recomputing them against the new visible statements.
    ...current,
    content: {
      H: patch.H ?? current.content.H,
      N: { ...current.content.N, ...patch.N },
      Cref: patch.Cref ?? current.content.Cref,
    },
    evidenceIds: patch.evidenceIds ?? current.evidenceIds,
    reasoning: patch.reasoning ?? current.reasoning,
    unknowns: patch.unknowns ?? current.unknowns,
  };
}

export function channelsForIssues(issues: ContentValidationIssue[]): ContentChannel[] {
  const channels = new Set<ContentChannel>();
  // Repair routing is broader than publication blocking: review-only quality
  // findings may still receive one bounded repair attempt.
  for (const issue of issues.filter((item) => item.repairable && issueDisposition(item) !== "advisory")) {
    if (issue.channel === "package") {
      channels.add("H");
      channels.add("N.body");
      channels.add("Cref");
    } else {
      channels.add(issue.channel);
    }
  }
  return [...channels];
}
