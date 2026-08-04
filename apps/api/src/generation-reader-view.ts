import type { ContentPackage } from '@content-agent/agent-core';

/**
 * 阅读投影:极简创作「查看」真正要读的字段,一个不多。
 *
 * 起因是实测:GET /api/generations/:id 单任务 1.05 MB(3 候选 × 234 KB),其中
 * trace(61 KB)+ parameterImpactReport(53 KB)+ orchestrationSnapshot 全量
 * (25 KB)占了 90%,而极简创作一个都不渲染。同时反过来,界面真正需要的判断依据
 * ——reasoning(句子级事实/假设标注)、gapCoverageLedger(缺口落地台账)、
 * strategy(候选之间到底哪里不同)——旧接口压根不返回。
 *
 * 所以不是「裁剪旧接口」,而是另开一条只读投影:完整版工作台继续用 :id 拿全量
 * (它要参数影响报告和 trace),极简创作用 :id/reader。字段集由
 * generation-reader-view.test.ts 白名单锁死,加字段必须连测试一起改。
 *
 * 投影后实测每任务中位 36 KB、最大 68 KB。
 */

/** 一条句子级标注:这句话是事实还是假设,落在哪个通道。 */
export interface ReaderReasoningEntry {
  statement: string;
  status: string;
  location?: string;
  field?: string;
  threadId?: string;
  followUpIndex?: number;
  evidenceIds: string[];
}

/** 评论线程:除了问答,还要说清谁在说、承担哪个缺口。 */
export interface ReaderComment {
  id?: string;
  question: string;
  answer: string;
  function?: string;
  /**
   * 线程互动形态。必须下发到前端:只有 org_answer 的 answer 才是可追责身份的
   * 答复,reader_exchange/organic_reaction 的 answer 是**模拟读者接话**。缺这个
   * 字段时前端只能按 postingIdentity 打标签,于是把读者互聊标成「员工身份」
   * ——实测三篇 20/20 条非 org_answer 线程全部被错标。
   */
  threadKind?: string;
  postingIdentity?: string;
  /** Minimal answer-side display role needed to render staff/expert/host correctly. */
  surfaceRoleCard?: { replyDisplayRole?: string };
  /** Human-confirmed author facts referenced by host_reply; IDs only, never project evidence. */
  authorFactIds?: string[];
  /** Social-topic anchor; never a project-gap ownership claim. */
  topicAnchorGapId?: string;
  personaRole?: string;
  stage?: string;
  gap?: string;
  boundary?: string;
  nextStep?: string;
  simulated?: boolean;
  displayName?: string;
  followUps: Array<{ question: string; answer: string; boundary?: string }>;
}

/** 候选之间真正不同的表达轴。prototype 是封闭枚举,其余是开放词表(含模型产出的中文自由文本)。 */
export interface ReaderStrategy {
  label?: string;
  prototype?: string;
  openingMode?: string;
  narrativeMode?: string;
  bodyRole?: string;
  commentMode?: string;
  voice?: string;
}

export interface ReaderCandidate {
  id: string;
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
  validation: ContentPackage['validation'];
  reasoning: ReaderReasoningEntry[];
  gapLedger?: {
    entries: Array<{
      gapId: string;
      label: string;
      status: string;
      required: boolean;
      plannedPlacements: string[];
      reason?: string;
      requiredInput?: string;
      verificationPath?: string;
      realizations: Array<{
        channel: string;
        threadId?: string;
        resolved: boolean;
        missing: string[];
      }>;
    }>;
    realizationStatus?: string;
  };
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
  deploymentPlan?: ContentPackage['deploymentPlan'];
}

/**
 * 未定义的可选字段一律不写进对象,让 JSON 里干脆没有这个键。
 *
 * 用 object 而不是 Record<string, unknown> 作约束:接口类型没有索引签名,
 * 用后者会让每个调用点都要断言一次。
 */
function compact<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}

function readerComments(pkg: ContentPackage): ReaderComment[] {
  const planned = pkg.dialogueThreads ?? [];
  return (pkg.content?.Cref?.threads ?? []).map((thread, index) => {
    // 线程元数据在成稿线程上可能缺失,规划线程里有;与 mapCandidate 同一套回落顺序。
    const plan = planned.find((item) => item.id === thread.id) ?? planned[index];
    return compact<ReaderComment>({
      id: thread.id,
      question: thread.question,
      answer: thread.answer,
      function: thread.function,
      // 成稿线程可能缺 threadKind(旧包),规划线程里有;与其他元数据同一套回落。
      threadKind: thread.threadKind ?? plan?.threadKind,
      postingIdentity: thread.postingIdentity,
      surfaceRoleCard: thread.surfaceRoleCard ?? plan?.surfaceRoleCard,
      authorFactIds: thread.authorFactIds ?? plan?.authorFactIds,
      topicAnchorGapId: thread.topicAnchorGapId ?? plan?.topicAnchorGapId,
      personaRole: thread.personaRole ?? plan?.personaRole,
      stage: thread.stage,
      gap: thread.gap,
      boundary: thread.boundary,
      nextStep: thread.nextStep,
      simulated: thread.simulated ?? plan?.simulated,
      displayName: thread.displayName ?? plan?.displayName,
      followUps: (thread.followUps ?? []).map((f) =>
        compact({ question: f.question, answer: f.answer, boundary: f.boundary }),
      ),
    });
  });
}

function readerReasoning(pkg: ContentPackage): ReaderReasoningEntry[] {
  // sourceSpans 故意丢掉:里面是整段证据原文(单条可达数 KB),而界面只需要
  // 「这句话有没有证据」这个结论,证据编号已经在 evidenceIds 里。
  return (pkg.reasoning ?? []).map((entry) =>
    compact<ReaderReasoningEntry>({
      statement: entry.statement,
      status: entry.status,
      location: entry.location,
      field: entry.occurrence?.field,
      threadId: entry.occurrence?.threadId,
      followUpIndex: entry.occurrence?.followUpIndex,
      evidenceIds: entry.evidenceIds ?? [],
    }),
  );
}

function readerGapLedger(pkg: ContentPackage): ReaderCandidate['gapLedger'] {
  const ledger = pkg.orchestrationSnapshot?.gapCoverageLedger;
  if (!ledger) return undefined;
  return {
    entries: (ledger.entries ?? []).map((entry) =>
      compact({
        gapId: entry.gapId,
        label: entry.label,
        status: entry.status,
        required: entry.required,
        plannedPlacements: entry.plannedPlacements ?? [],
        reason: entry.reason,
        requiredInput: entry.requiredInput,
        verificationPath: entry.verificationPath,
        realizations: (entry.actualRealizations ?? []).map((r) =>
          compact({
            channel: r.channel,
            threadId: r.threadId,
            resolved: r.resolved,
            missing: r.missing ?? [],
          }),
        ),
      }),
    ),
    realizationStatus: ledger.realizationStatus,
  };
}

export function readerView(pkg: ContentPackage): ReaderCandidate {
  const strategy = pkg.orchestrationSnapshot?.strategy;
  return compact<ReaderCandidate>({
    id: pkg.candidateId,
    packageId: pkg.id,
    candidateIndex: pkg.candidateIndex,
    seed: pkg.seed,
    title: pkg.content?.N?.title ?? '',
    body: pkg.content?.N?.body ?? '',
    tags: (pkg.content?.H?.hashtags ?? []).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)),
    imageBrief: pkg.content?.N?.imageBrief,
    commentDisclaimer: pkg.content?.Cref?.disclaimer,
    commentOwnedFirstComment: pkg.content?.Cref?.ownedFirstComment,
    commentUncoveredGaps: pkg.content?.Cref?.uncoveredGaps,
    comments: readerComments(pkg),
    validation: pkg.validation,
    reasoning: readerReasoning(pkg),
    gapLedger: readerGapLedger(pkg),
    gapCards: (pkg.orchestrationSnapshot?.gapPlanningCards ?? []).map((card) =>
      compact({
        gapId: card.gapId,
        label: card.label,
        question: card.question,
        required: card.required,
        priority: card.priority,
        boundary: card.boundary,
        plannedPlacements: card.plannedPlacements ?? [],
      }),
    ),
    sources: (pkg.evidence ?? []).map((item) =>
      compact({
        name: item.path,
        kind: item.kind,
        evidenceStatus: item.evidenceStatus,
        section: item.section,
      }),
    ),
    unknowns: (pkg.unknowns ?? []).map((item) =>
      compact({ question: item.question, impact: item.impact, reason: item.reason }),
    ),
    strategy: strategy
      ? compact<ReaderStrategy>({
          label: strategy.label,
          prototype: strategy.prototype,
          openingMode: strategy.openingMode,
          narrativeMode: strategy.narrativeMode,
          bodyRole: strategy.bodyRole,
          commentMode: strategy.commentMode,
          voice: strategy.voice,
        })
      : undefined,
    deploymentPlan: pkg.deploymentPlan,
  });
}
