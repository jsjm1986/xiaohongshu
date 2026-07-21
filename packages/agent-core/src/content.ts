import type {
  ContentChannel,
  ContentDiagnostic,
  CommentGapCoverageLedger,
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
import { evaluatePlanToCopyAlignment } from "./artifacts.js";
import { conservativeEvidenceSupport } from "./knowledge.js";

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
  if (!isRecord(value) || value.revealTiming !== "same_thread" || !["low", "moderate"].includes(String(value.difficulty))) return undefined;
  const keys = ["cue", "inferencePrompt", "reveal", "selfCheck", "boundary"] as const;
  if (!keys.every((key) => typeof value[key] === "string" && (value[key] as string).trim())) return undefined;
  return {
    cue: (value.cue as string).trim(),
    inferencePrompt: (value.inferencePrompt as string).trim(),
    reveal: (value.reveal as string).trim(),
    selfCheck: (value.selfCheck as string).trim(),
    boundary: (value.boundary as string).trim(),
    revealTiming: "same_thread",
    difficulty: value.difficulty as "low" | "moderate",
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
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) continue;
      const score = modelObjectScore(parsed);
      if (score >= selectedScore) {
        selected = parsed;
        selectedScore = score;
      }
    } catch (error) {
      lastParseError = error;
    }
  }
  if (selected) return selected;
  if (candidates.length && lastParseError) {
    throw new Error(`Model output was not valid JSON: ${lastParseError instanceof Error ? lastParseError.message : String(lastParseError)}`);
  }
  throw new Error("Model output did not contain a complete JSON object.");
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

export interface StagedCommentCopy {
  disclaimer: string;
  threads: Array<{
    id: string;
    roleIndex?: number;
    question: string;
    answer: string;
    followUps: Array<{ question: string; answer: string }>;
  }>;
}

export function parseStagedCommentCopy(text: string): StagedCommentCopy {
  const value = parseJsonObject(text);
  const content = isRecord(value.content) ? value.content : undefined;
  const container = content && isRecord(content.Cref)
    ? content.Cref
    : isRecord(value.Cref) ? value.Cref : value;
  if (!Array.isArray(container.threads)) throw new Error("Staged comment output must include a threads array.");
  const threads = container.threads.map((thread, index) => {
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
      return { question: followQuestion.trim(), answer: followAnswer.trim() };
    });
    const roleIndex = typeof thread.roleIndex === "number" && Number.isInteger(thread.roleIndex) && thread.roleIndex >= 0
      ? thread.roleIndex
      : undefined;
    return { id: thread.id, roleIndex, question: question.trim(), answer: answer.trim(), followUps };
  });
  return {
    disclaimer: typeof container.disclaimer === "string"
      ? container.disclaimer.trim()
      : "以下为多角色评论情景演练与发布者答疑参考模板，不代表真实用户发言、亲历口碑或已经发生的互动。",
    threads,
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
        ...scenarioMetadata(followUp),
      };
    });
    const postingIdentity = ["author", "brand", "staff", "expert", "reader_question_template"].includes(String(thread.postingIdentity))
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
      stage: typeof thread.stage === "string" ? thread.stage : undefined,
      gap: typeof thread.gap === "string" ? thread.gap : undefined,
      function: ["surface_gap", "answer", "clarify", "counterexample", "verification", "next_step"].includes(String(thread.function))
        ? thread.function as ContentPackageContent["Cref"]["threads"][number]["function"]
        : undefined,
      nextStep: typeof thread.nextStep === "string" ? thread.nextStep : undefined,
      roleCard: roleCard(thread.roleCard),
      primaryGapId: typeof thread.primaryGapId === "string" ? thread.primaryGapId : undefined,
      auxiliaryGapIds: stringArray(thread.auxiliaryGapIds),
      densityProxy: densityProxy(thread.densityProxy),
      replyPlan: replyPlan(thread.replyPlan),
      discoveryPlan: discoveryPlan(thread.discoveryPlan),
      ...scenarioMetadata(thread),
    };
  });
  return {
    H: { hashtags: [...new Set(hashtags.map((tag) => tag.trim().replace(/^#+/u, "")).filter(Boolean))] },
    N: { imageBrief: imageBrief.trim(), title: value.N.title.trim(), body: value.N.body.trim() },
    Cref: { disclaimer: disclaimer.trim(), threads },
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
    ...content.Cref.threads.flatMap((thread) => [thread.question, thread.answer, ...thread.followUps.flatMap((item) => [item.question, item.answer])]),
  ].join("\n");
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

function normalizedExpectationParts(value: string): string[] {
  return value
    .split(/[。；;！？!?\n]/u)
    .map((item) => item.replace(/^(?:DirectAnswer|Condition|Boundary|Unknown|NextQuestion|待核实维度|已披露地点范围)[：:]?/iu, ""))
    .map(normalizedComparable)
    .filter((item) => item.length >= 2);
}

function realizesText(visible: string, expected?: string): boolean {
  if (!expected?.trim()) return false;
  const comparableVisible = normalizedComparable(visible);
  const comparableExpected = normalizedComparable(expected);
  if (comparableExpected && comparableVisible.includes(comparableExpected)) return true;
  const parts = normalizedExpectationParts(expected);
  return parts.length > 0 && parts.every((part) => comparableVisible.includes(part));
}

function realizesVisibleUnknownPath(
  visible: string,
  card: InformationGapPlanningCard | undefined,
  status: "awaiting_user_input" | "unknown_with_verification",
): boolean {
  if (!card || !visible.trim()) return false;
  const comparable = normalizedComparable(visible);
  const namesGap = [card.label, card.question]
    .map(normalizedComparable)
    .filter((item) => item.length >= 2)
    .some((item) => comparable.includes(item));
  const preservesUnknown = /(?:未知|待核实|不能确定|无法确定|资料不足|缺少|未覆盖|不代填|还需|仍需|还没弄清|还没问明白|没问清|拿不准)/u.test(visible);
  const hasAction = status === "awaiting_user_input"
    ? /(?:补充|提供|说明|确认|记录|核实|问清|问明白).{0,24}(?:条件|情况|信息|输入|目标|风险)/u.test(visible)
    : /(?:核实|查证|查看|回到|补充|提供|确认|问清|问明白).{0,24}(?:来源|证据|资料|条件|范围|信息|情况)/u.test(visible);
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

function bodyEvidenceRealized(draft: GenerationDraft, card: InformationGapPlanningCard): boolean {
  const expected = card.answer ?? card.framework;
  if (!expected || card.evidenceIds.length === 0) return false;
  const expectedEvidence = new Set(card.evidenceIds);
  return draft.reasoning.some((item) =>
    item.status === "fact"
    && item.location === "N.body"
    && draft.content.N.body.includes(item.statement)
    && item.evidenceIds.some((id) => expectedEvidence.has(id))
    && (item.sourceSpans ?? []).some((span) => expectedEvidence.has(span.evidenceId))
    && realizesText(item.statement, expected),
  );
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
      const answerRealized = realizesText(draft.content.N.body, expectedAnswer);
      const conditionOrBoundaryRealized = card.boundary ? realizesText(draft.content.N.body, card.boundary) : true;
      const evidenceRealized = bodyEvidenceRealized(draft, card);
      const findable = answerRealized;
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
      const plannedThreads = orchestrationPlan.dialogueThreads.filter((thread) => thread.primaryGapId === card.gapId);
      for (const plannedThread of plannedThreads) {
        const actualThread = draft.content.Cref.threads.find((thread) => thread.id === plannedThread.id);
        const primaryMatches = Boolean(
          actualThread
          && actualThread.primaryGapId === card.gapId
          && (!actualThread.gap || actualThread.gap === card.gapId),
        );
        const answerRealized = Boolean(actualThread && realizesText(actualThread.answer, expectedAnswer));
        const conditionRequirements = [
          plannedThread.replyPlan.condition,
          card.boundary ?? plannedThread.replyPlan.boundary,
        ].filter(Boolean);
        const conditionOrBoundaryRealized = Boolean(
          actualThread
          && conditionRequirements.every((requirement) => realizesText(actualThread.answer, requirement)),
        );
        const expectedEvidence = new Set(card.evidenceIds);
        const claimMappedToSource = Boolean(actualThread && draft.reasoning.some((item) =>
          item.status === "fact"
          && item.location === "Cref.thread"
          && actualThread.answer.includes(item.statement)
          && realizesText(item.statement, expectedAnswer)
          && (item.sourceSpans ?? []).some((span) => expectedEvidence.has(span.evidenceId)),
        ));
        const evidenceRealized = Boolean(
          actualThread
          && expectedEvidence.size > 0
          && actualThread.evidenceIds.some((id) => expectedEvidence.has(id))
          && claimMappedToSource,
        );
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

export function validateGenerationDraft(input: DraftValidationInput): ContentValidationIssue[] {
  const { draft, config, ledger } = input;
  const issues: ContentValidationIssue[] = [];
  const add = (code: string, severity: "error" | "warning", channel: ContentValidationIssue["channel"], message: string, repairable = true): void => {
    issues.push({ code, severity, channel, message, repairable });
  };
  if (!draft.content.N.title) add("title_required", "error", "N.title", "Title is required.");
  if (!draft.content.N.body) add("body_required", "error", "N.body", "Body is required.");
  if (config.content.imageBriefEnabled && !draft.content.N.imageBrief) add("image_brief_required", "error", "N.imageBrief", "Image brief is required.");
  const bodyLength = [...draft.content.N.body].length;
  if (bodyLength < config.content.bodyMinChars) add("body_too_short", "error", "N.body", `Body has ${bodyLength} characters; minimum is ${config.content.bodyMinChars}.`);
  if (bodyLength > config.content.bodyMaxChars) add("body_too_long", "error", "N.body", `Body has ${bodyLength} characters; maximum is ${config.content.bodyMaxChars}.`);
  const publicText = allContentText(draft.content);
  if (/\bevidence_[\w:.-]+\b|(?:sourceClusterId|reasoning|replyPlan|discoveryPlan)|(?:本线程|该线程|线程内)/iu.test(publicText)) {
    add("internal_audit_artifact_visible", "error", "package", "User-visible copy contains an internal evidence ID, audit field or thread-control phrase.");
  }
  if (/(?:只回应.{0,18}不承担.{0,8}答题|AI\s*不便|后台(?:库存|任务|参数)|内容任务|写作任务|人物设定|提示词|核验路径|按计划(?:回答|展开)|不承担完整答题)/iu.test(publicText)) {
    add("frontstage_instruction_leak", "error", "package", "User-visible copy contains backend instructions, model identity, or audit phrasing instead of natural human speech.");
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
  if (surfacePlan) {
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
    const visibleCommentChars = visibleCommentNodes.reduce((total, value) => total + [...value.replace(/\s/gu, "")].length, 0);
    const [lineMin, lineMax] = surfacePlan.surfaceTargets.visibleCommentLines;
    if (visibleCommentNodes.length < lineMin || visibleCommentNodes.length > lineMax) {
      add("sample_comment_line_shape_drift", "warning", "Cref", `Visible comment nodes ${visibleCommentNodes.length} are outside the selected sample-shape target ${lineMin}-${lineMax}.`, false);
    }
    if (visibleCommentChars > 650) {
      add("comment_network_overexpanded", "error", "Cref", `Visible comment text has ${visibleCommentChars} characters; the reference-corpus p75 is about 155 and max is 482, so this is still an article/FAQ rather than a comment network.`);
    } else if (visibleCommentChars > 360) {
      add("comment_network_length_drift", "warning", "Cref", `Visible comment text has ${visibleCommentChars} characters and is much denser than the reference-corpus median of about 107.`, false);
    }
    const surfaceCopyText = [
      draft.content.H.hashtags.join(" "),
      draft.content.N.title,
      draft.content.N.body,
      ...draft.content.Cref.threads.flatMap((thread) => [thread.question, thread.answer, ...thread.followUps.flatMap((item) => [item.question, item.answer])]),
    ].join("\n");
    const visibleAuditTerms = surfaceCopyText.match(/(?:核实|边界|资料(?:未覆盖|显示|里)|不能下结论|适用条件|证据来源|判断框架|判断口径|有效报价单|项目说明)/gu)?.length ?? 0;
    if (visibleAuditTerms >= 7) {
      add("audit_language_surface_leak", "error", "package", `Visible copy repeats audit/formula language ${visibleAuditTerms} times; internal reasoning has leaked into the product surface.`);
    } else if (visibleAuditTerms >= 4) {
      add("audit_language_surface_drift", "warning", "package", `Visible copy uses audit/formula language ${visibleAuditTerms} times; rewrite it into role-specific everyday speech before publishing.`, false);
    }
    const visibleRoles = new Set(draft.content.Cref.threads.map((thread) => thread.surfaceRoleCard?.displayRole).filter(Boolean));
    if (threadCount >= 3 && visibleRoles.size < 3) {
      add("comment_surface_roles_flat", "warning", "Cref", "Fewer than three distinct visible social positions were realized; the comments may still sound like one FAQ author.", false);
    }
    const metaQuestionPattern = /(?:你最想问什么|你最关心(?:哪一点|什么)|还有什么想了解(?:的)?|有什么问题(?:都)?可以问|欢迎(?:留言|评论|私信)(?:咨询|提问)?)/u;
    const metaQuestion = visibleCommentNodes.find((node) => metaQuestionPattern.test(node));
    if (metaQuestion) {
      add("comment_host_meta_question", "error", "Cref", `A visible comment uses host/interviewer wording instead of speaking from a real social position: ${metaQuestion}`);
    }
    const [targetGrowingMin, targetGrowingMax] = surfacePlan.commentNetwork.multiTurnTarget;
    const effectiveGrowingMin = Math.min(threadCount, targetGrowingMin);
    const effectiveGrowingMax = Math.min(threadCount, Math.max(effectiveGrowingMin, targetGrowingMax));
    const actualGrowingThreads = draft.content.Cref.threads.filter((thread) => thread.followUps.length > 0).length;
    if (actualGrowingThreads < effectiveGrowingMin) {
      add("comment_network_under_grown", "warning", "Cref", `The comment-network distribution expected ${effectiveGrowingMin}-${effectiveGrowingMax} naturally growing roots, but only ${actualGrowingThreads} grew. Do not fill a quota mechanically; review whether useful triggers were missed.`, false);
    } else if (actualGrowingThreads > effectiveGrowingMax) {
      add("comment_network_over_grown", "warning", "Cref", `The comment-network distribution expected ${effectiveGrowingMin}-${effectiveGrowingMax} naturally growing roots, but ${actualGrowingThreads} grew. Review whether every continuation is actually triggered by the previous line.`, false);
    }
    const optionalRegisterTerms = input.projectBlueprint?.surfaceLanguage.optionalColloquialisms ?? [];
    const overloadedRegisterNode = visibleCommentNodes.find((node) =>
      optionalRegisterTerms.filter((term) => term && node.includes(term)).length >= 3,
    );
    if (overloadedRegisterNode) {
      add("comment_platform_register_overloaded", "warning", "Cref", `One comment stacks too many platform-register markers and may sound performed: ${overloadedRegisterNode}`, false);
    }
    const rootQuestions = draft.content.Cref.threads.map((thread) => thread.question.trim()).filter(Boolean);
    if (rootQuestions.length >= 3 && rootQuestions.every((question) => /[？?]$/u.test(question))) {
      add("comment_network_all_questions", "warning", "Cref", "Every root node is formatted as a question; add a reaction, experience fragment, observation or disagreement so the section does not read as an FAQ.", false);
    }
    const answerOpenings = draft.content.Cref.threads.map((thread) => [...thread.answer.replace(/^[，。！？\s]+/u, "")].slice(0, 4).join(""));
    const repeatedAnswerOpening = answerOpenings.find((opening) => opening && answerOpenings.filter((item) => item === opening).length >= 3);
    if (repeatedAnswerOpening) {
      add("comment_reply_voice_repetition", "warning", "Cref", `At least three replies begin with “${repeatedAnswerOpening}”; the characters may still share one model voice.`, false);
    }
    const rootLengths = draft.content.Cref.threads.map((thread) => [...thread.question.replace(/\s/gu, "")].length);
    const answerLengths = draft.content.Cref.threads.map((thread) => [...thread.answer.replace(/\s/gu, "")].length);
    const narrowSpread = (values: number[]) => values.length >= 4 && Math.max(...values) - Math.min(...values) <= 4;
    if (narrowSpread(rootLengths) && narrowSpread(answerLengths)) {
      add("comment_network_symmetric_shape", "warning", "Cref", "Root comments and replies are nearly identical in length across the whole section; this often indicates slot-filling rather than independent social voices.", false);
    }
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
        } else if (item.status === "fact" && !conservativeEvidenceSupport(item.statement, span.quote)) {
          add("evidence_quote_not_supportive", "error", "package", `Evidence quote has no sufficient lexical connection to the factual statement: ${item.statement}`);
        }
        if (item.status === "fact" && input.evidenceReferences) {
          const reference = evidenceReferenceById.get(span.evidenceId);
          if (!reference) {
            add("evidence_reference_metadata_missing", "error", "package", `No evidence identity metadata is available for factual source ${span.evidenceId}.`);
          } else if (reference.kind !== "fact" || !["observed", "user_supplied"].includes(reference.evidenceStatus)) {
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
      const covered = draft.reasoning.some((item) =>
        item.location === candidate.location
        && conservativeEvidenceSupport(candidate.statement, item.statement),
      );
      if (!covered) {
        add("visible_claim_not_in_ledger", "error", candidate.location === "Cref.thread" || candidate.location === "Cref.followUp" ? "Cref" : candidate.location, `Visible claim is missing a fact/inference/hypothesis identity in the reasoning ledger: ${candidate.statement}`);
      }
    }
  }
  const controlledRules = input.projectBlueprint?.claimPolicy.rules.filter((rule) => rule.requiresEvidence) ?? [];
  const genericMeasuredClaim = /\d+(?:\.\d+)?\s*(?:%|％|k|K|元|万|天|周|月|年|次|个|套|人|毫米|厘米|mm|cm)/iu;
  const sensitiveSurfaces: Array<{ location: NonNullable<GenerationDraft["reasoning"][number]["location"]>; text: string }> = [
    { location: "N.body", text: draft.content.N.body },
    ...draft.content.Cref.threads.map((thread) => ({ location: "Cref.thread" as const, text: thread.answer })),
    ...draft.content.Cref.threads.flatMap((thread) => thread.followUps.map((followUp) => ({ location: "Cref.followUp" as const, text: followUp.answer }))),
  ];
  for (const surface of sensitiveSurfaces) {
    for (const statement of surface.text.split(/(?<=[。！？!?；;])|\n+/u).map((item) => item.trim()).filter(Boolean)) {
      const matchedRules = controlledRules.filter((rule) => rule.terms.some((term) => term && statement.includes(term)));
      if ((!genericMeasuredClaim.test(statement) && matchedRules.length === 0) || /[？?]$/u.test(statement)) continue;
      const grounded = draft.reasoning.some((item) => item.status === "fact"
        && item.location === surface.location
        && (item.sourceSpans?.length ?? 0) > 0
        && conservativeEvidenceSupport(statement, item.statement));
      if (!grounded) {
        const labels = matchedRules.map((rule) => rule.label || rule.claimType).join(", ") || "measured claim";
        add("sensitive_claim_without_evidence", "error", surface.location === "Cref.thread" || surface.location === "Cref.followUp" ? "Cref" : surface.location, `A controlled project claim (${labels}) is visible without factual evidence: ${statement}`);
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
  const bodyComparable = normalizedComparable(draft.content.N.body);
  if ((config.parameters?.commentInferenceEffort ?? 35) > 70) {
    add("comment_inference_effort_high", "warning", "Cref", "Comment inference effort is above 70; keep difficulty moderate and reduce every discovery to one easy inference step.");
  }
  for (const thread of draft.content.Cref.threads) {
    const missingThreadFields = [
      !thread.stage ? "Stage" : "",
      !thread.gap ? "Gap" : "",
      !thread.function ? "Function" : "",
      !thread.question ? "Q" : "",
      !thread.answer ? "A" : "",
      !thread.nextStep ? "Next" : "",
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
    const hasDensityContract = Boolean(thread.roleCard || thread.primaryGapId || thread.densityProxy);
    if (!thread.replyPlan) {
      add("comment_reply_plan_missing", "warning", "Cref", `Thread ${thread.id} has no structured replyPlan; historical content remains readable but cannot be fully audited.`);
    }
    if (!thread.discoveryPlan) {
      add("comment_discovery_plan_missing", "warning", "Cref", `Thread ${thread.id} has no same-thread discoveryPlan; historical content remains readable but cannot be audited for timely reveal.`);
    } else {
      const discoveryText = `${thread.discoveryPlan.cue}\n${thread.discoveryPlan.inferencePrompt}\n${thread.discoveryPlan.reveal}`;
      if (/(?:评论区再说|评论里再说|懂的都懂|先不说答案|答案先不说|留到评论|想知道.*(?:评论|留言))/u.test(discoveryText)) {
        add("comment_discovery_withholding", "error", "Cref", `Thread ${thread.id} deliberately withholds information instead of revealing it in the same thread.`);
      }
      const certainty = /(?:足以确定|完全确定|已经确定|一定适用|必然(?:适用|有效|正确)|毫无疑问|无需.{0,6}核实)/u.test(`${thread.discoveryPlan.reveal}\n${thread.replyPlan?.directAnswer ?? ""}`);
      const unresolved = /(?:不足|不能确定|无法确定|未知|仍需|还需|缺少|不代填)/u.test(`${thread.discoveryPlan.boundary}\n${thread.replyPlan?.unknown ?? ""}\n${thread.discoveryPlan.selfCheck}`);
      if (certainty && unresolved) {
        add("comment_discovery_false_closure", "error", "Cref", `Thread ${thread.id} turns a discovery cue into certainty despite an explicit unknown or boundary.`);
      }
      if (/(?:发现感|猜到|推断过程|互动感).{0,8}(?:就是|等于|证明|作为)证据/u.test(discoveryText)) {
        add("comment_discovery_as_evidence", "error", "Cref", `Thread ${thread.id} treats discovery or inference as evidence.`);
      }
    }
    if (hasDensityContract) {
      if (!thread.roleCard || !thread.primaryGapId || !thread.densityProxy) {
        add("comment_density_metadata_incomplete", "error", "Cref", `Thread ${thread.id} must include roleCard, one primaryGapId and densityProxy together.`);
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
        if (thread.densityProxy.primaryGapCount !== 1
          || thread.densityProxy.auxiliaryDimensionCount !== auxiliaryGapIds.length
          || thread.densityProxy.constraintCount !== thread.roleCard.constraints.length
          || thread.densityProxy.expectedReplyComponents !== 5) {
          add("comment_density_proxy_mismatch", "error", "Cref", `Thread ${thread.id} densityProxy does not explain its actual structure.`);
        }
        const allowedRoleConstraints = new Set([
          ...config.informationWindow.boundaries,
          ...(config.task.city ? [`已披露地点范围：${config.task.city}`] : []),
        ]);
        const unsafeConstraint = thread.roleCard.constraints.find((constraint) =>
          !allowedRoleConstraints.has(constraint)
          && !constraint.startsWith("待核实维度：")
          && /(?:\d+\s*(?:元|万元|天|公里|岁)|预算(?:是|为)|住在|职业(?:是|为)|我(?:已经|做过|用过))/u.test(constraint),
        );
        if (unsafeConstraint) {
          add("comment_role_constraint_ungrounded", "error", "Cref", `Thread ${thread.id} contains a role constraint that is neither disclosed nor marked for verification: ${unsafeConstraint}`);
        }
        const actualQuestionTarget = thread.surfaceRoleCard?.targetChars[1] ?? thread.densityProxy.questionTargetChars;
        if ([...thread.question].length > actualQuestionTarget * 1.5) {
          add("comment_question_not_compressed", "warning", "Cref", `Thread ${thread.id} question exceeds its explainable compression target.`, false);
        }
      }
    }
    const questionFragments = thread.question.split(/[、，,\/|]/u).map((item) => item.trim()).filter(Boolean);
    if (questionFragments.length >= 4 && !/(?:怎么|怎样|什么|哪些|是否|能否|该不该|要不要|会不会|如何|判断|核实|比较)/u.test(thread.question)) {
      add("comment_keyword_pile", "error", "Cref", `Thread ${thread.id} piles keywords instead of asking one natural primary-gap question.`);
    }
    const comparableQuestion = normalizedComparable(thread.question);
    const comparableAnswer = normalizedComparable(thread.answer);
    const priorQuestion = seenQuestions.get(comparableQuestion);
    const priorAnswer = seenAnswers.get(comparableAnswer);
    const priorSemanticAnswer = [...seenAnswers.entries()].find(([answer]) => meaningfulTextOverlap(comparableAnswer, answer, 0.92));
    if (comparableQuestion.length >= 6 && priorQuestion) add("duplicate_comment_question", "error", "Cref", `Thread ${thread.id} repeats the question from ${priorQuestion}.`);
    if (comparableAnswer.length >= 12 && priorAnswer) add("duplicate_comment_answer", "error", "Cref", `Thread ${thread.id} repeats the answer from ${priorAnswer}.`);
    else if (comparableAnswer.length >= 20 && priorSemanticAnswer) add("near_duplicate_comment_answer", "error", "Cref", `Thread ${thread.id} is semantically too close to ${priorSemanticAnswer[1]} and does not add enough information.`);
    if (comparableQuestion) seenQuestions.set(comparableQuestion, thread.id);
    if (comparableAnswer) seenAnswers.set(comparableAnswer, thread.id);
    if (hasDensityContract && comparableAnswer.length >= 12 && bodyComparable.includes(comparableAnswer)) {
      add("comment_repeats_body", "error", "Cref", `Thread ${thread.id} repeats body information instead of adding a conditional answer.`);
    }
    const visibleNodes = [thread.question, thread.answer, ...thread.followUps.flatMap((item) => [item.question, item.answer])];
    const leakedPlan = visibleNodes.find((node) => /(?:像.{1,16}(?:一样|那样)[，,]?(?:只|先)|先指出.{0,24}(?:细节|可见)|用一句.{0,24}提醒|只问[“"][^”"]+[”"]里|顺势问[“"])/u.test(node));
    if (leakedPlan) {
      add("comment_plan_language_surface_leak", "error", "Cref", `A visible comment renders a writing instruction instead of a person speaking: ${leakedPlan}`);
    }
    const prohibitedHistories = [
      ...(input.projectBlueprint?.scenarioModel.families.flatMap((family) => family.prohibitedUnsupportedHistories) ?? []),
      ...(input.projectBlueprint?.claimPolicy.rules
        .filter((rule) => rule.claimType === "historical_action")
        .flatMap((rule) => rule.terms) ?? []),
    ].filter(Boolean);
    const fabricatedAction = visibleNodes.find((node) => {
      if (/(?:老用户|回购|亲测|亲身经历|我朋友|我同事|朋友说|同事说)/u.test(node)) return true;
      const firstPersonCompleted = /(?:^|[，。！？!?\s])我.{0,28}(?:已经|刚|上周|昨天|之前|过|完|了)/u.test(node);
      return firstPersonCompleted && prohibitedHistories.some((term) => node.includes(term));
    });
    if (fabricatedAction) {
      add("fabricated_operational_experience", "error", "Cref", `A simulated role claims an unsupported completed project action or testimonial: ${fabricatedAction}`);
    }
    const auditLeak = visibleNodes.find((node) => /(?:源资料|资料参考|参考资料|可用证据|知识库里|项目资料里)/u.test(node));
    if (auditLeak) {
      add("comment_source_language_surface_leak", "error", "Cref", `A visible comment exposes source/audit language instead of speaking naturally: ${auditLeak}`);
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
          if (!realizesVisibleUnknownPath(visibleThreads, card, entry.status)) {
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
          false,
        );
      }
      if (entry.status === "body_resolved" && !entry.actualRealizations.some((item) => item.channel === "N.body" && item.resolved)) {
        add("body_gap_false_resolution", "error", "N.body", `Gap ${entry.gapId} cannot be marked body_resolved without a verified final-body realization.`, false);
      }
      const card = input.orchestrationPlan!.gapPlanningCards?.find((item) => item.gapId === entry.gapId);
      const hasGroundedResolution = Boolean(card && (card.answer || card.framework) && card.evidenceIds.length);
      if (hasGroundedResolution && entry.plannedPlacements.includes("N.body")
        && !entry.actualRealizations.some((item) => item.channel === "N.body" && item.resolved)) {
        add("planned_body_gap_not_realized", entry.required ? "error" : "warning", "N.body", `Grounded gap ${entry.gapId} was assigned to the body but is not fully realized; optional adjacent information may move to the comment network.`, entry.required);
      }
      if (hasGroundedResolution && entry.plannedPlacements.includes("Cref")
        && !entry.actualRealizations.some((item) => item.channel === "Cref" && item.resolved)) {
        add("planned_comment_gap_not_realized", entry.required ? "error" : "warning", "Cref", `Grounded gap ${entry.gapId} is not closed inside one thread; optional information may be distributed across short social nodes.`, entry.required);
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
  return issues;
}

export function diagnosticsFromValidation(issues: ContentValidationIssue[]): ContentDiagnostic[] {
  const errors = issues.filter((item) => item.severity === "error");
  const warnings = issues.filter((item) => item.severity === "warning");
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

export function parseGenerationPatch(text: string): GenerationDraftPatch {
  const value = parseJsonObject(text);
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

export function applyGenerationPatch(current: GenerationDraft, patch: GenerationDraftPatch): GenerationDraft {
  return {
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
  for (const issue of issues.filter((item) => item.repairable && item.severity === "error")) {
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
