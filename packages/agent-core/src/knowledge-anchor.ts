import {
  commentThreadKindOf,
  genericMeasuredClaim,
  marketingPromiseClaim,
  splitEvidenceClaimAtoms,
  splitSensitiveStatements,
} from "./content.js";
import { combinedEvidenceSupport, conservativeEvidenceSupport, evidenceReferenceCanSupportFact, exactEvidenceSupportSpans } from "./knowledge.js";
import type {
  ClaimJudgment,
  ClaimJudgmentClassification,
  EvidenceReference,
  GenerationDraft,
  ProjectCreativeBlueprint,
} from "./types.js";

type ReasoningEntry = GenerationDraft["reasoning"][number];
type ReasoningLocation = NonNullable<ReasoningEntry["location"]>;
type ReasoningOccurrence = NonNullable<ReasoningEntry["occurrence"]>;

export interface KnowledgeAnchorContext {
  allowedEvidenceIds: string[];
  /** Exact disclosed source text keyed by allowed evidence ID. */
  evidenceSources: Record<string, string>;
  /** Source identity; when present, only kind=fact + observed/user_supplied sources may anchor a fact. */
  evidenceReferences?: EvidenceReference[];
  /** Controlled claim policy supplies the requiresEvidence rule terms. */
  projectBlueprint?: ProjectCreativeBlueprint;
}

/** 敏感面上命中受控声明、需要证据锚定的一句(机械与 AI 复核共用同一份扫描)。 */
export interface SensitiveClaimSurface {
  statement: string;
  location: ReasoningLocation;
  occurrence: ReasoningOccurrence;
}

/** 联合判官为 statements[statementIndex] 返回的一条可机械验证支撑。 */
export interface KnowledgeAnchorSelection {
  statementIndex: number;
  evidenceId?: string;
  quote?: string;
}

interface AnchorAddition {
  location: ReasoningLocation;
  occurrence: ReasoningOccurrence;
  evidenceId: string;
}

/** Find one or more exact source spans that jointly support a visible atom. */
function anchorQuotesInSource(statement: string, source: string): string[] {
  return exactEvidenceSupportSpans(statement, source);
}

/**
 * 锚定池与校验层证据角色闸门(evidence_role_cannot_support_fact /
 * evidence_reference_metadata_missing)严格一致;元数据整体缺省时校验层同样
 * 跳过角色检查,锚定器按同一口径放行。机械锚定与 AI 复核共用这一个池。
 */
export function knowledgeAnchorEvidencePool(
  context: KnowledgeAnchorContext,
): Array<{ evidenceId: string; quote: string }> {
  const referenceById = new Map((context.evidenceReferences ?? []).map((reference) => [reference.id, reference]));
  return context.allowedEvidenceIds
    .filter((evidenceId) => {
      if (!context.evidenceSources[evidenceId]) return false;
      if (!context.evidenceReferences) return true;
      const reference = referenceById.get(evidenceId);
      return Boolean(reference && evidenceReferenceCanSupportFact(reference));
    })
    .map((evidenceId) => ({ evidenceId, quote: context.evidenceSources[evidenceId]! }));
}

// 与 content.ts 校验段相同的 grounded 判定:同 location、status="fact"、
// 有 sourceSpans 且通过保守支持门。
function groundedFact(
  reasoning: ReasoningEntry[],
  statement: string,
  location: ReasoningLocation,
  occurrence: ReasoningOccurrence,
): boolean {
  return reasoning.some((item) => item.status === "fact"
    && item.location === location
    && item.occurrence?.field === occurrence.field
    && item.occurrence?.threadId === occurrence.threadId
    && item.occurrence?.followUpIndex === occurrence.followUpIndex
    && (item.sourceSpans?.length ?? 0) > 0
    // Directional visible-claim coverage: a prior “门诊在 X” row must not make
    // a later “我们在 X” occurrence disappear merely because they share X.
    && combinedEvidenceSupport(statement, [item.statement])
    && combinedEvidenceSupport(item.statement, (item.sourceSpans ?? []).map((span) => span.quote)));
}

// 幂等护栏:同一定位下 statement 已有等价 fact 记录(即便暂无 sourceSpans)
// 时不重复挂,也不覆盖模型已写的台账。
function recordedFact(
  reasoning: ReasoningEntry[],
  statement: string,
  location: ReasoningLocation,
  occurrence: ReasoningOccurrence,
): boolean {
  return reasoning.some((item) => item.status === "fact"
    && item.location === location
    && item.occurrence?.field === occurrence.field
    && item.occurrence?.threadId === occurrence.threadId
    && item.occurrence?.followUpIndex === occurrence.followUpIndex
    && item.statement === statement);
}

// 敏感面与 sensitive_claim_without_evidence 完全同构:N.body + T1 机构问答
// (threadKind 缺省按 org_answer)线程 answer + 其 followUp answer;T2/T3 的
// answer 是模拟读者发言,不锚定。命中受控声明且不以问号结尾的句子才需要锚定。
function controlledClaimSurfaces(
  draft: GenerationDraft,
  controlledRules: Array<{ terms: string[] }>,
): SensitiveClaimSurface[] {
  const claims: SensitiveClaimSurface[] = [];
  const collect = (text: string, location: ReasoningLocation, occurrence: ReasoningOccurrence): void => {
    for (const statement of splitEvidenceClaimAtoms(text)) {
      const controlledHit = genericMeasuredClaim.test(statement)
        || marketingPromiseClaim.test(statement)
        || controlledRules.some((rule) => rule.terms.some((term) => term && statement.includes(term)));
      if (!controlledHit || /[？?]$/u.test(statement)) continue;
      claims.push({ statement, location, occurrence });
    }
  };
  collect(draft.content.N.body, "N.body", { field: "body" });
  for (const thread of draft.content.Cref.threads) {
    if (commentThreadKindOf(thread) !== "org_answer") continue;
    collect(thread.answer, "Cref.thread", { field: "answer", threadId: thread.id });
    thread.followUps.forEach((followUp, followUpIndex) => {
      collect(followUp.answer, "Cref.followUp", { field: "answer", threadId: thread.id, followUpIndex });
    });
  }
  return claims;
}

// 台账一致性:thread/followUp/顶层 evidenceIds 与 reasoning sourceSpans 保持
// 同一集合(thread_evidence_ledger_mismatch / followup_evidence_ledger_mismatch /
// package_evidence_ledger_mismatch 均为精确相等判定);bind 后集合本已一致,
// 这里只做增量并集。
function commitAnchorAdditions(
  draft: GenerationDraft,
  reasoning: ReasoningEntry[],
  additions: AnchorAddition[],
): GenerationDraft {
  const addedIdsFor = (location: ReasoningLocation, threadId: string, followUpIndex?: number): string[] =>
    [...new Set(additions
      .filter((addition) => addition.location === location
        && addition.occurrence.threadId === threadId
        && addition.occurrence.followUpIndex === followUpIndex)
      .map((addition) => addition.evidenceId))];
  const threads = draft.content.Cref.threads.map((thread) => {
    const threadIds = addedIdsFor("Cref.thread", thread.id);
    const followUps = thread.followUps.map((followUp, followUpIndex) => {
      const followUpIds = addedIdsFor("Cref.followUp", thread.id, followUpIndex);
      return followUpIds.length
        ? { ...followUp, evidenceIds: [...new Set([...followUp.evidenceIds, ...followUpIds])] }
        : followUp;
    });
    const followUpsChanged = followUps.some((followUp, index) => followUp !== thread.followUps[index]);
    return threadIds.length || followUpsChanged
      ? { ...thread, evidenceIds: [...new Set([...thread.evidenceIds, ...threadIds])], followUps }
      : thread;
  });
  return {
    ...draft,
    content: { ...draft.content, Cref: { ...draft.content.Cref, threads } },
    evidenceIds: [...new Set([...draft.evidenceIds, ...additions.map((addition) => addition.evidenceId)])],
    reasoning,
  };
}

/**
 * 证据自动锚定:敏感面(N.body + T1 机构问答线程 answer + 其 followUp answer)
 * 上命中受控声明却缺少 fact 台账的句子,在已披露证据源中检索精确连续片段,
 * 命中则补一条 statement=原句、status="fact"、带 occurrence 定位与 sourceSpans
 * 的台账记录,并同步 thread/followUp/顶层 evidenceIds。
 *
 * 自动锚定只补机械链接,不替模型编证据:片段必须逐字存在于证据源、来源必须
 * 满足 evidence_role 要求(kind=fact、status∈{observed,user_supplied})、且通过
 * conservativeEvidenceSupport 保守支持门;找不到即不挂,error 仍由校验层
 * (sensitive_claim_without_evidence)照旧报出,诚实闸门不松。
 *
 * 纯函数:不修改入参,无新增锚定时返回原 draft 引用;同一 draft 重复执行
 * 幂等,已存在的模型台账记录不被覆盖。
 */
export function attachKnowledgeAnchors(draft: GenerationDraft, context: KnowledgeAnchorContext): GenerationDraft {
  const controlledRules = context.projectBlueprint?.claimPolicy.rules.filter((rule) => rule.requiresEvidence) ?? [];
  const pool = knowledgeAnchorEvidencePool(context);
  if (!pool.length) return draft;

  const reasoning = [...draft.reasoning];
  const additions: AnchorAddition[] = [];
  for (const claim of controlledClaimSurfaces(draft, controlledRules)) {
    if (groundedFact(reasoning, claim.statement, claim.location, claim.occurrence)
      || recordedFact(reasoning, claim.statement, claim.location, claim.occurrence)) continue;
    for (const source of pool) {
      const quotes = anchorQuotesInSource(claim.statement, source.quote);
      if (!quotes.length) continue;
      reasoning.push({
        statement: claim.statement,
        status: "fact",
        evidenceIds: [source.evidenceId],
        location: claim.location,
        occurrence: claim.occurrence,
        sourceSpans: quotes.map((quote) => ({ evidenceId: source.evidenceId, quote })),
      });
      additions.push({ location: claim.location, occurrence: claim.occurrence, evidenceId: source.evidenceId });
      break;
    }
  }
  if (!additions.length) return draft;
  return commitAnchorAdditions(draft, reasoning, additions);
}

/**
 * 机械锚定未命中的敏感声明:未 grounded、未记录,且锚定池中检索不到精确
 * 片段。AI 复核兜底只对这份清单发起;为空时引擎不发起模型调用(零成本)。
 */
export function collectUnanchoredSensitiveClaims(
  draft: GenerationDraft,
  context: KnowledgeAnchorContext,
): SensitiveClaimSurface[] {
  const controlledRules = context.projectBlueprint?.claimPolicy.rules.filter((rule) => rule.requiresEvidence) ?? [];
  const pool = knowledgeAnchorEvidencePool(context);
  return controlledClaimSurfaces(draft, controlledRules).filter((claim) => {
    if (groundedFact(draft.reasoning, claim.statement, claim.location, claim.occurrence)
      || recordedFact(draft.reasoning, claim.statement, claim.location, claim.occurrence)) return false;
    return !pool.some((source) => anchorQuotesInSource(claim.statement, source.quote).length > 0);
  });
}

/**
 * 挂载联合判官的证据选择。这里做系统机械校验——证据必须在
 * 锚定池内(角色合规)、quote 必须是源文本逐字连续片段(source.includes)、
 * 且通过 conservativeEvidenceSupport 保守支持门;任一不过即作废不挂,
 * error 照旧由校验层报出。幂等:已 grounded/已记录的句子不重复挂。
 */
export function attachKnowledgeAnchorSelections(
  draft: GenerationDraft,
  context: KnowledgeAnchorContext,
  claims: SensitiveClaimSurface[],
  selections: KnowledgeAnchorSelection[],
): GenerationDraft {
  const poolById = new Map(knowledgeAnchorEvidencePool(context).map((source) => [source.evidenceId, source.quote]));
  if (!poolById.size || !selections.length) return draft;

  const reasoning = [...draft.reasoning];
  const additions: AnchorAddition[] = [];
  for (const selection of selections) {
    const claim = claims[selection.statementIndex];
    if (!claim) continue;
    const source = selection.evidenceId ? poolById.get(selection.evidenceId) : undefined;
    const quote = selection.quote?.trim();
    if (!source || !quote || !source.includes(quote)) continue;
    if (!conservativeEvidenceSupport(claim.statement, quote)) continue;
    if (groundedFact(reasoning, claim.statement, claim.location, claim.occurrence)
      || recordedFact(reasoning, claim.statement, claim.location, claim.occurrence)) continue;
    reasoning.push({
      statement: claim.statement,
      status: "fact",
      evidenceIds: [selection.evidenceId!],
      location: claim.location,
      occurrence: claim.occurrence,
      sourceSpans: [{ evidenceId: selection.evidenceId!, quote }],
    });
    additions.push({ location: claim.location, occurrence: claim.occurrence, evidenceId: selection.evidenceId! });
  }
  if (!additions.length) return draft;
  return commitAnchorAdditions(draft, reasoning, additions);
}

/** AI 判官对 statements[statementIndex] 的原始裁决(分类 + 支持判断 + 可选引文)。 */
export interface ClaimJudgeVerdict {
  statementIndex: number;
  classification: ClaimJudgmentClassification;
  supported?: boolean;
  evidenceId?: string;
  quote?: string;
}

const CLAIM_JUDGE_CLASSIFICATIONS = new Set<ClaimJudgmentClassification>([
  "factual_assertion", "service_offer", "hedge", "question",
]);

/**
 * 解析判官模型输出({judgments:[{statementIndex,classification,supported,quote}]})。
 * 形状异常、编号越界/重复、未知分类、事实断言缺 supported 的条目一律丢弃;整体
 * 不可解析时返回空数组——引擎按"无裁决"安全降级,校验层走词面旧逻辑。
 */
export function parseClaimJudgeVerdicts(value: unknown, statementCount: number): ClaimJudgeVerdict[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).judgments;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const verdicts: ClaimJudgeVerdict[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const statementIndex = record.statementIndex;
    if (typeof statementIndex !== "number" || !Number.isInteger(statementIndex)
      || statementIndex < 0 || statementIndex >= statementCount || seen.has(statementIndex)) continue;
    if (!CLAIM_JUDGE_CLASSIFICATIONS.has(record.classification as ClaimJudgmentClassification)) continue;
    const classification = record.classification as ClaimJudgmentClassification;
    if (classification === "factual_assertion" && typeof record.supported !== "boolean") continue;
    seen.add(statementIndex);
    if (classification !== "factual_assertion") {
      verdicts.push({ statementIndex, classification });
      continue;
    }
    const evidenceId = typeof record.evidenceId === "string" && record.evidenceId.trim() ? record.evidenceId : undefined;
    const quote = typeof record.quote === "string" && record.quote.trim() ? record.quote : undefined;
    // A positive factual verdict is actionable only with a source identity and
    // exact quote. Missing provenance is converted to unsupported, never trusted.
    if (record.supported === true && (!evidenceId || !quote)) {
      verdicts.push({ statementIndex, classification, supported: false });
      continue;
    }
    verdicts.push({ statementIndex, classification, supported: record.supported as boolean, evidenceId, quote });
  }
  return verdicts;
}

/**
 * 裁决落盘前的机械校验(防 AI 幻觉的唯一系统职责):事实断言附了引文,引文就
 * 必须是某一证据源内的逐字连续片段,不过则改判无据(supported=false)。邀约/
 * 限定/疑问不带支持判断,直接按分类落盘。返回按句面文本匹配的裁决清单,并入
 * draft.claimJudgments 供校验层消费。
 */
export function resolveClaimJudgments(
  claims: SensitiveClaimSurface[],
  verdicts: ClaimJudgeVerdict[],
  evidencePool: Array<{ evidenceId: string; quote: string }>,
): ClaimJudgment[] {
  const judgments: ClaimJudgment[] = [];
  for (const verdict of verdicts) {
    const claim = claims[verdict.statementIndex];
    if (!claim) continue;
    if (verdict.classification !== "factual_assertion") {
      judgments.push({ statement: claim.statement, classification: verdict.classification });
      continue;
    }
    const source = verdict.evidenceId
      ? evidencePool.find((candidate) => candidate.evidenceId === verdict.evidenceId)
      : undefined;
    const supported = verdict.supported === true
      && Boolean(source && verdict.quote
        && source.quote.includes(verdict.quote)
        && conservativeEvidenceSupport(claim.statement, verdict.quote));
    judgments.push({ statement: claim.statement, classification: "factual_assertion", supported });
  }
  return judgments;
}
