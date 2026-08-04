import type {
  HarnessCandidate, HarnessClaimAudit, HarnessEvidenceSource, HarnessImageSource, HarnessPublicationCheck, HarnessValidationIssue,
} from "./types.js";
import { DEFAULT_HARNESS_SEEDING_MODE, HARNESS_BODY_LENGTH_TARGETS } from "./methods.js";
import type { HarnessSeedingMode } from "./methods.js";

/*
 * 伪造口碑的营销话术。两种模式都是 ERROR。
 *
 * 实测 67 篇真实对标语料里这一支命中 0 篇 —— 真人不这么说话,
 * 「亲测」「真实顾客」是广告文案的措辞,该一直禁。
 */
const FABRICATED_TESTIMONIAL = /(亲测|我做过|我用过|我体验过|朋友做过|闺蜜做过|真实顾客|真实客户)/u;
/*
 * 第一人称时间线叙述。peer_seeding 放开,brand_voice 仍 ERROR。
 *
 * 「我做完两天了」这类朴素叙述在 67 篇语料里命中 13 篇(19%),是这批内容的常态。
 * 放开的依据:内容由真人素人账号发布、经历真实,AI 只是代笔起草。
 * brand_voice 下保持阻断 —— 机构口吻不能假装自己是顾客。
 */
const FIRST_PERSON_TIMELINE = /(?:我|朋友|闺蜜|同事|姐妹|家人).{0,12}(?:刚做|做完|做了|做的|术后|恢复)/u;
const PUBLIC_AUDIT_LEAK = /(待人工审核|审核状态|证据编号|responseSla|\bSLA\b|发布计划|不代表已经发布|平台合规|终稿校对)/iu;
const PUBLIC_SOURCE_META = /(项目资料(?:显示|表明|支持|中的?)|现有资料(?:显示|表明|支持|中的?)|根据(?:项目)?知识库|证据(?:显示|表明|支持)|本轮证据|evidence_section_)/iu;
const UNSUPPORTED_POPULATION_LANGUAGE = /(很多人|大家都|最怕|最关心|普遍|通常用户|真实用户都)/u;
const EVIDENCE_ERROR_CODES = new Set(["claim_audit_incomplete", "claim_audit_not_visible", "undeclared_project_fact", "claim_audit_evidence_mismatch", "empty_citation_statement", "citation_not_visible", "citation_without_evidence", "unknown_evidence", "unread_evidence", "non_factual_evidence"]);
const ASSET_ERROR_CODES = new Set(["asset_decision_count", "asset_decision_duplicate", "unknown_asset_decision", "asset_decision_evidence", "asset_use_without_sequence", "asset_omit_still_used", "image_sequence_asset", "image_sequence_evidence"]);
const EXECUTION_ERROR_CODES = new Set(["missing_response_sla", "missing_live_question_routes", "incomplete_live_question_route", "missing_update_triggers", "missing_stop_rules"]);
const SOFT_MARKETING_ERROR_CODES = new Set([
  "missing_marketing_strategy", "marketing_strategy_incomplete", "marketing_anchor_missing",
  "marketing_anchor_order", "marketing_anchor_duplicate", "marketing_judgment_unchanged",
  "marketing_bridge_without_reframe", "hard_sell_language",
]);
const HARD_SELL_LANGUAGE = /(限时|最后机会|赶紧|立刻下单|马上抢|错过(?:就|再等)|闭眼入|无脑冲|必做|必须做|不做就|全网最低|名额仅剩)/u;

export function visibleCandidateText(candidate: HarnessCandidate): string {
  return [
    candidate.content.N.coverHeadline, candidate.content.N.coverSubheadline,
    ...candidate.content.N.imageSequence.map((item) => item.overlayText),
    candidate.content.N.title, candidate.content.N.body, candidate.content.N.callToAction,
    ...candidate.content.H.hashtags, candidate.content.Cref.ownedFirstComment,
    ...candidate.content.Cref.threads.flatMap((thread) => [thread.question, thread.answer, ...thread.followUps.flatMap((item) => [item.question, item.answer])]),
  ].join("\n");
}

/**
 * 可见文本按来源分区。
 *
 * peer_seeding 放开的是「博主本人叙述自己的时间线」,不是「谁都能编经历」。
 * 但 visibleCandidateText 把正文、博主回复和模拟读者的话拼成一整段,拿它做
 * FIRST_PERSON_TIMELINE 判断就成了无差别放开 —— 模拟读者也能说「我同事上个月
 * 做了」。所以按来源分开:
 *   authorOwned  发布账号自己的话(正文、首评、author 身份的答复)
 *   simulated    虚构读者的话(reader_exchange 双方、organic_reaction、非 author 答复)
 * 时间线叙述只在 authorOwned 里被允许;simulated 里出现照旧是 ERROR。
 */
export function candidateTextByOrigin(candidate: HarnessCandidate): { authorOwned: string[]; restricted: string[] } {
  const authorOwned: string[] = [
    candidate.content.N.coverHeadline, candidate.content.N.coverSubheadline,
    ...candidate.content.N.imageSequence.map((item) => item.overlayText),
    candidate.content.N.title, candidate.content.N.body, candidate.content.N.callToAction,
    ...candidate.content.H.hashtags, candidate.content.Cref.ownedFirstComment,
  ];
  const restricted: string[] = [];
  for (const thread of candidate.content.Cref.threads) {
    const kind = thread.threadKind ?? "org_answer";
    // 读者提问一律算模拟读者的话,与身份无关 —— 提问的是虚构昵称。
    restricted.push(thread.question);
    for (const followUp of thread.followUps) restricted.push(followUp.question);
    // 答复按身份归属:author 是博主本人在回自己的帖,其余(staff/expert/brand/publisher)
    // 是机构口吻,reader_exchange 的 answer 是第二位虚构读者。
    const answerIsAuthor = kind === "org_answer" && thread.postingIdentity === "author";
    (answerIsAuthor ? authorOwned : restricted).push(thread.answer);
    for (const followUp of thread.followUps) (answerIsAuthor ? authorOwned : restricted).push(followUp.answer);
  }
  return { authorOwned, restricted };
}

export function publicationChecklistFor(candidate: HarnessCandidate, issues: HarnessValidationIssue[]): HarnessPublicationCheck[] {
  const errorCodes = new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.code));
  const evidenceBlocked = [...errorCodes].some((code) => EVIDENCE_ERROR_CODES.has(code));
  const assetBlocked = [...errorCodes].some((code) => ASSET_ERROR_CODES.has(code));
  const executionBlocked = [...errorCodes].some((code) => EXECUTION_ERROR_CODES.has(code));
  const softMarketingBlocked = [...errorCodes].some((code) => SOFT_MARKETING_ERROR_CODES.has(code));
  const simulationBlocked = [
    // comment_disclaimer 已删:披露语不再是模型产出的交付字段,改为界面/导出固定携带。
    "missing_owned_first_comment", "empty_thread", "missing_thread_clarification",
    "missing_thread_next_step", "missing_thread_boundary", "missing_thread_stop_reason", "comment_thread_count",
    "comment_topology", "comment_growth", "missing_thread_display_name", "reader_exchange_incomplete",
    "organic_reaction_overbuilt", "organic_reaction_too_long",
  ].some((code) => errorCodes.has(code));
  return [
    { key: "soft_marketing", status: softMarketingBlocked ? "blocked" : "ready", note: softMarketingBlocked ? "用户欲望、认知翻转或项目承接没有形成完整软营销推进。" : "正文已形成顾虑进入、认知翻转、项目承接与低压力余味。" },
    { key: "evidence", status: evidenceBlocked ? "blocked" : "ready", note: evidenceBlocked ? "事实或证据绑定仍有阻断项。" : "可见事实已通过本轮证据校验。" },
    { key: "simulation_disclosure", status: simulationBlocked ? "blocked" : "ready", note: simulationBlocked ? "模拟互动披露或评论结构不完整。" : "首评归属与模拟问答披露已明确。" },
    { key: "execution_plan", status: executionBlocked ? "blocked" : "ready", note: executionBlocked ? "真实问题响应、分流、更新或停止规则不完整。" : "真实问题承接的响应、分流、更新与停止规则已齐备。" },
    { key: "asset_authorization", status: assetBlocked ? "blocked" : "ready", note: assetBlocked ? "所选图片的使用/舍弃与证据绑定不完整。" : "每张所选图片已有可追溯使用或舍弃决定。" },
    { key: "platform_compliance", status: "manual_review", note: "平台规则、敏感词和账号资质必须在实际发布前由人工按当时规则复核。" },
    { key: "final_proofread", status: issues.some((issue) => issue.severity === "error") ? "blocked" : "manual_review", note: issues.some((issue) => issue.severity === "error") ? "先解决硬校验阻断，再进行终稿校对。" : "发布前仍需人工核对最终排版、素材授权、链接与时效信息。" },
  ];
}

function normalizedSimilarityTerms(value: string): Set<string> {
  const normalized = value.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function jaccardSimilarity(left: string, right: string): number {
  const a = normalizedSimilarityTerms(left); const b = normalizedSimilarityTerms(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function validateHarnessCandidates(
  candidates: HarnessCandidate[],
  evidence: HarnessEvidenceSource[],
  disclosedEvidenceIds: ReadonlySet<string>,
  constraints: {
    mustInclude?: readonly string[]; forbidden?: readonly string[]; claimAudit?: HarnessClaimAudit;
    expectedCandidateCount?: number; runMode?: "original" | "retry" | "revision"; sourceCandidateIndex?: number;
    revisionInstruction?: string; selectedImages?: readonly HarnessImageSource[]; bodyLength?: "short" | "medium" | "long";
    /** 素人代发种草模式。缺省走 DEFAULT_HARNESS_SEEDING_MODE(peer_seeding)。 */
    seedingMode?: HarnessSeedingMode;
  } = {},
): HarnessValidationIssue[] {
  const issues: HarnessValidationIssue[] = []; const knownEvidence = new Map(evidence.map((item) => [item.evidenceId, item]));
  const seedingMode = constraints.seedingMode ?? DEFAULT_HARNESS_SEEDING_MODE;
  const peerSeeding = seedingMode === "peer_seeding";
  const expectedCount = constraints.expectedCandidateCount ?? 3;
  const add = (candidateIndex: number, code: string, severity: "error" | "warning", message: string) => issues.push({ candidateIndex, code, severity, message });
  if (candidates.length !== expectedCount) add(-1, "candidate_count", "error", `本轮必须提交恰好 ${expectedCount} 个候选。`);
  if (!constraints.claimAudit?.complete) add(-1, "claim_audit_incomplete", "error", "独立事实盘点未确认完整，所有候选暂不可导出。");
  const titles = new Set<string>(); const indexes = new Set<number>();
  for (const candidate of candidates) {
    const index = Number(candidate.candidateIndex);
    if (![0, 1, 2].includes(index)) add(index, "candidate_index", "error", "候选编号必须为 0、1、2。");
    if (indexes.has(index)) add(index, "duplicate_candidate_index", "error", "本轮候选编号必须唯一。");
    indexes.add(index);
    if (constraints.runMode === "revision" && index !== constraints.sourceCandidateIndex) add(index, "revision_candidate_index", "error", "定向改稿必须保留所选候选编号。");
    if (constraints.runMode === "revision") {
      if (!constraints.revisionInstruction?.trim()) add(index, "revision_instruction_missing", "error", "定向改稿缺少修改要求。");
      if (!candidate.revisionNotes.instructionApplied.length) add(index, "revision_application_missing", "error", "改稿结果没有逐项说明修改要求如何落实。");
      if (!candidate.revisionNotes.preservedElements.length) add(index, "revision_preservation_missing", "error", "改稿结果没有说明保留了原候选的哪些内容。");
    } else if (candidate.revisionNotes.instructionApplied.length || candidate.revisionNotes.preservedElements.length) {
      add(index, "unexpected_revision_notes", "warning", "非改稿运行不应伪装成定向修订记录。");
    }
    if (!candidate.concept.trim()) add(index, "missing_concept", "error", "缺少可审阅的创意命题。");
    const n = candidate.content.N;
    const strategy = candidate.marketingStrategy;
    if (!strategy) {
      add(index, "missing_marketing_strategy", "error", "缺少可审阅的软营销心智策略。");
    } else {
      const strategyValues = Object.values(strategy).map((value) => value.trim());
      if (strategyValues.some((value) => !value)) add(index, "marketing_strategy_incomplete", "error", "软营销策略必须写清用户欲望、隐藏卡点、旧判断、新判断、项目承接和低压力下一步。");
      if (!["tension_first", "observation_first", "question_first"].includes(strategy.narrativePath)) add(index, "marketing_narrative_path", "error", "软营销策略必须声明有效的叙事路径。");
      const anchors = [strategy.tensionAnchor, strategy.reframeAnchor, strategy.projectBridgeAnchor, strategy.openLoopAnchor];
      if (new Set(anchors).size !== anchors.length) add(index, "marketing_anchor_duplicate", "error", "软营销四个正文锚点必须各自承担不同推进职责，不能重复一句话。");
      const frozenEntryCopy = [n.coverHeadline, n.coverSubheadline, n.title, n.body].join("\n");
      const frozenOpenCopy = [n.body, n.callToAction].join("\n");
      const reframePosition = strategy.reframeAnchor ? n.body.indexOf(strategy.reframeAnchor) : -1;
      const bridgePosition = strategy.projectBridgeAnchor ? n.body.indexOf(strategy.projectBridgeAnchor) : -1;
      if (!strategy.tensionAnchor || !frozenEntryCopy.includes(strategy.tensionAnchor)
        || reframePosition < 0 || bridgePosition < 0
        || !strategy.openLoopAnchor || !frozenOpenCopy.includes(strategy.openLoopAnchor)) {
        add(index, "marketing_anchor_missing", "error", "顾虑入口、认知翻转、项目承接和开放余味必须逐字落在各自允许的公开文案位置。");
      } else if (reframePosition >= bridgePosition) {
        add(index, "marketing_anchor_order", "error", "正文中的认知翻转必须早于项目承接，不能先卖项目再补判断标准。");
      }
      const bridgeGrounded = candidate.citations.some((citation) => citation.statement.includes(strategy.projectBridgeAnchor)
        || strategy.projectBridgeAnchor.includes(citation.statement));
      if (!bridgeGrounded) add(index, "marketing_bridge_ungrounded", "error", "项目承接必须与一条逐字证据声明重叠，不能用无引用的泛化卖点承接认知翻转。");
      const normalizedOld = strategy.oldJudgment.replace(/[\s\p{P}\p{S}]+/gu, "");
      const normalizedNew = strategy.newJudgment.replace(/[\s\p{P}\p{S}]+/gu, "");
      if (!normalizedOld || normalizedOld === normalizedNew) add(index, "marketing_judgment_unchanged", "error", "种草正文必须完成一次真实的判断变化，不能只换句话重复原认知。");
    }
    for (const [code, value, label] of [
      ["missing_cover_headline", n.coverHeadline, "封面主文案"], ["missing_cover_subheadline", n.coverSubheadline, "封面副文案"],
      ["missing_image_brief", n.imageBrief, "图片总任务"], ["missing_title", n.title, "标题"],
      ["missing_body", n.body, "正文"], ["missing_call_to_action", n.callToAction, "行动引导"],
      ["missing_owned_first_comment", candidate.content.Cref.ownedFirstComment, "账号首评"],
      ["missing_entry_point", candidate.content.publishing.entryPoint, "发布入口"],
      ["missing_account_identity", candidate.content.publishing.accountIdentity, "发布身份"],
      ["missing_timing_note", candidate.content.publishing.timingNote, "发布时间说明"],
      ["missing_interaction_goal", candidate.content.publishing.interactionGoal, "互动目标"],
      ["missing_response_sla", candidate.content.publishing.responseSla ?? "", "真实问题响应时效"],
    ] as const) if (!value.trim()) add(index, code, "error", `缺少${label}。`);
    if (!n.imageSequence.length) add(index, "missing_image_sequence", "error", "缺少可执行的逐图脚本。");
    const sequences = new Set<number>();
    for (const item of n.imageSequence) {
      if (!Number.isInteger(item.sequence) || item.sequence < 1 || sequences.has(item.sequence)) add(index, "image_sequence_order", "error", "逐图脚本序号必须从 1 起且不重复。");
      sequences.add(item.sequence);
      if (!item.role.trim() || !item.direction.trim()) add(index, "image_sequence_incomplete", "error", "每张图必须说明角色和制作/使用方向。");
      if (item.source === "new_design" && item.assetId) add(index, "new_design_asset_id", "error", "新设计图片不能伪装成已有素材。");
    }
    const execution = candidate.content.publishing;
    if (!(execution.liveQuestionRoutes?.length)) add(index, "missing_live_question_routes", "error", "缺少真实问题分流规则。");
    for (const route of execution.liveQuestionRoutes ?? []) {
      if (!route.when.trim() || !route.action.trim()) add(index, "incomplete_live_question_route", "error", "每条真实问题分流必须写清触发条件、负责人和动作。");
    }
    if (!(execution.updateTriggers?.length) || execution.updateTriggers.some((item) => !item.trim())) add(index, "missing_update_triggers", "error", "缺少发布后更新触发条件。");
    if (!(execution.stopRules?.length) || execution.stopRules.some((item) => !item.trim())) add(index, "missing_stop_rules", "error", "缺少停止答复或转人工处理的规则。");
    if (!candidate.content.H.hashtags.length) add(index, "missing_hashtags", "error", "缺少发布标签。");
    if (!candidate.content.Cref.threads.length) add(index, "missing_comment_threads", "error", "缺少模拟问答线程。");
    const normalizedTitle = n.title.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
    if (expectedCount > 1 && normalizedTitle && titles.has(normalizedTitle)) add(index, "duplicate_title", "error", "多个候选不能使用相同标题。");
    titles.add(normalizedTitle);
    /*
     * 这里原先校验 Cref.disclaimer 必须写明「模拟问答参考、不代表真实互动」。
     * 删掉不是放宽诚实性要求,而是把这句话搬出了交付字段:它住在 Cref 里时会被
     * 用户连同评论一起粘贴到小红书,而它的读者本来是操盘手。现在改由界面提示条与
     * 导出文档从 HARNESS_SIMULATION_NOTICE 固定呈现,披露反而更稳——不会因模型
     * 某次漏写而消失。评论区结构与首评归属仍由下面其余的 code 阻断。
     */
    const visible = visibleCandidateText(candidate);
    const audited = constraints.claimAudit?.claims.filter((claim) => claim.candidateIndex === candidate.candidateIndex) ?? [];
    for (const claim of audited) {
      // The review model is instructed to copy exact spans. Compatible providers
      // occasionally paraphrase despite that contract; a paraphrase is not a new
      // visible claim and must not invalidate otherwise exact deterministic citations.
      if (!claim.statement || !visible.includes(claim.statement)) {
        const claimEvidence = [...new Set(claim.evidenceIds)].sort();
        const matchesDeclaredCitation = claim.classification === "project_fact" && candidate.citations.some((citation) => {
          const citationEvidence = [...new Set(citation.evidenceIds)].sort();
          return visible.includes(citation.statement)
            && claimEvidence.length > 0
            && claimEvidence.length === citationEvidence.length
            && claimEvidence.every((id, position) => id === citationEvidence[position]);
        });
        if (matchesDeclaredCitation) {
          add(index, "claim_audit_paraphrase_ignored", "warning", "事实复核改写了已登记声明，已按相同证据集合回落到候选的逐字证据声明。");
        } else {
          add(index, "claim_audit_not_visible", "error", "事实盘点返回的声明无法在可见内容中精确定位，且不能对应到相同证据集合的候选声明。");
        }
        continue;
      }
      if (claim.classification !== "project_fact") continue;
      const declared = candidate.citations.find((citation) => citation.statement === claim.statement);
      if (!declared) { add(index, "undeclared_project_fact", "error", `可见项目事实未在证据声明中登记：${claim.statement}`); continue; }
      const declaredIds = new Set(declared.evidenceIds);
      if (!claim.evidenceIds.length || claim.evidenceIds.some((id) => !declaredIds.has(id))) add(index, "claim_audit_evidence_mismatch", "error", `项目事实的盘点证据与候选声明不一致：${claim.statement}`);
    }
    for (const required of constraints.mustInclude ?? []) if (required && !visible.includes(required)) add(index, "required_content_missing", "error", `用户要求的内容未出现：${required}`);
    for (const prohibited of constraints.forbidden ?? []) if (prohibited && visible.includes(prohibited)) add(index, "forbidden_content", "error", `出现了用户禁止的内容：${prohibited}`);
    const origin = candidateTextByOrigin(candidate);
    /*
     * 口碑话术两种模式都禁,不分来源。
     * 时间线叙述:brand_voice 下全禁(机构不能假装自己是顾客);peer_seeding 下只允许
     * 出现在博主自己的话里 —— 模拟读者被编造经历仍然是 ERROR,那是伪造社会证明。
     */
    const timelineNodes = peerSeeding
      ? origin.restricted
      : [...origin.authorOwned, ...origin.restricted];
    // Test each speaker node independently. Joining question and answer text can
    // create a false timeline across the boundary (for example “我...?” + “要，...做...”).
    const timelineViolation = timelineNodes.some((text) => FIRST_PERSON_TIMELINE.test(text));
    if (FABRICATED_TESTIMONIAL.test(visible) || timelineViolation) {
      add(index, "fabricated_experience", "error", peerSeeding
        ? "可见内容出现伪造口碑措辞，或模拟读者声称了未经证实的体验时间线。"
        : "可见内容包含可能伪装真实经历或口碑的措辞。");
    }
    if (PUBLIC_AUDIT_LEAK.test(visible)) add(index, "audit_language_in_public_copy", "error", "公开文案混入了审核、SLA 或发布计划等后台语言，请只保留可直接阅读的成品表达。");
    if (PUBLIC_SOURCE_META.test(visible)) add(index, "source_meta_in_public_copy", "error", "公开文案混入了“项目资料/证据”后台口吻，请直接自然表达已支持的项目事实。");
    if (UNSUPPORTED_POPULATION_LANGUAGE.test(visible)) add(index, "unsupported_population_language", "warning", "公开文案使用了“很多人/最怕”等群体判断；没有总体证据时应改成直接问题或有边界的具体顾虑。");
    if (HARD_SELL_LANGUAGE.test(visible)) add(index, "hard_sell_language", "error", "公开文案出现催促、稀缺或强迫成交措辞，不符合软营销边界。");
    const effectiveLength = constraints.bodyLength ?? "medium";
    const bodyChars = [...n.body.replace(/\s+/gu, "")].length;
    const titleChars = [...n.title.replace(/\s+/gu, "")].length;
    if (titleChars > 22) add(index, "title_shape_drift", "warning", "标题明显长于 70 篇参考语料的常见形态，请优先压缩到一个直接钩子。");
    const bodyTarget = HARNESS_BODY_LENGTH_TARGETS[effectiveLength];
    if (bodyChars < bodyTarget.min || bodyChars > bodyTarget.max) add(index, "body_shape_drift", "warning", `正文为 ${bodyChars} 字，偏离${effectiveLength === "short" ? "短" : effectiveLength === "medium" ? "中" : "长"}篇 ${bodyTarget.min}—${bodyTarget.max} 字的统一目标。`);
    for (const citation of candidate.citations) {
      if (!citation.statement.trim()) add(index, "empty_citation_statement", "error", "引用必须对应明确声明。");
      else if (!visible.includes(citation.statement)) add(index, "citation_not_visible", "error", `证据声明无法在可见内容中精确定位：${citation.statement}`);
      if (!citation.evidenceIds.length) add(index, "citation_without_evidence", "error", `声明“${citation.statement}”没有证据 ID。`);
      for (const evidenceId of citation.evidenceIds) {
        const source = knownEvidence.get(evidenceId);
        if (!source) add(index, "unknown_evidence", "error", `引用了不存在的证据 ${evidenceId}。`);
        else if (!disclosedEvidenceIds.has(evidenceId)) add(index, "unread_evidence", "error", `引用了 Agent 未读取的证据 ${evidenceId}。`);
        else if (!["observed", "user_supplied"].includes(source.evidenceStatus)) add(index, "non_factual_evidence", "error", `声明引用的 ${evidenceId} 不是可支持项目事实的证据状态。`);
      }
    }
    const selected = new Map((constraints.selectedImages ?? []).map((image) => [image.assetId, image]));
    const decisions = new Map<string, typeof candidate.assetDecisions[number]>();
    for (const decision of candidate.assetDecisions) {
      if (decisions.has(decision.assetId)) add(index, "asset_decision_duplicate", "error", `图片 ${decision.assetId} 出现重复使用决策。`);
      decisions.set(decision.assetId, decision);
      const image = selected.get(decision.assetId);
      if (!image) { add(index, "unknown_asset_decision", "error", `素材决策引用了本轮未选择的图片 ${decision.assetId}。`); continue; }
      if (!decision.rationale.trim() || !decision.evidenceIds.includes(image.evidenceId) || !disclosedEvidenceIds.has(image.evidenceId)) add(index, "asset_decision_evidence", "error", `图片 ${decision.assetId} 的使用/舍弃决定必须绑定已读的批准观察证据。`);
      const used = n.imageSequence.some((item) => item.source === "selected_asset" && item.assetId === decision.assetId);
      if (decision.decision === "use" && !used) add(index, "asset_use_without_sequence", "error", `决定使用的图片 ${decision.assetId} 未进入逐图脚本。`);
      if (decision.decision === "omit" && used) add(index, "asset_omit_still_used", "error", `决定舍弃的图片 ${decision.assetId} 仍出现在逐图脚本中。`);
    }
    if (decisions.size !== selected.size || [...selected.keys()].some((assetId) => !decisions.has(assetId))) add(index, "asset_decision_count", "error", "每张所选图片都必须有且仅有一个使用或舍弃决定。");
    for (const item of n.imageSequence.filter((plan) => plan.source === "selected_asset")) {
      const image = selected.get(item.assetId);
      if (!image) add(index, "image_sequence_asset", "error", `逐图脚本引用了未选择的图片 ${item.assetId}。`);
      else if (!item.evidenceIds.includes(image.evidenceId) || !disclosedEvidenceIds.has(image.evidenceId)) add(index, "image_sequence_evidence", "error", `逐图脚本中的图片 ${item.assetId} 必须绑定已读批准观察证据。`);
    }
    const typedThreads = candidate.content.Cref.threads.filter((thread) => thread.threadKind);
    if (typedThreads.length) {
      const kindCount = (kind: string) => typedThreads.filter((thread) => thread.threadKind === kind).length;
      if (candidate.content.Cref.threads.length < 4 || candidate.content.Cref.threads.length > 6) add(index, "comment_thread_count", "error", "新评论关系网每套应有 4—6 条线程，避免只有一条 FAQ 或机械灌水。");
      /*
       * 拓扑要求按模式分叉。
       *
       * brand_voice 保持原样：至少 2 条机构答疑。
       * peer_seeding 改成至少 2 条**博主本人回复**（org_answer + postingIdentity==='author'），
       * 机构答疑 0 条也合格。依据：67 篇真实语料里博主回复 187 行，带机构口吻的只有 1 行，
       * 而原规则强制 ≥2 条机构答疑，正是产出像客服话术的直接原因。
       */
      const authorReplies = typedThreads.filter((item) => item.threadKind === "org_answer" && item.postingIdentity === "author").length;
      const accountableAnswers = typedThreads.filter((item) => item.threadKind === "org_answer" && item.postingIdentity !== "author").length;
      const answerShortfall = peerSeeding ? authorReplies < 2 : accountableAnswers < 2;
      if (typedThreads.length !== candidate.content.Cref.threads.length || answerShortfall || kindCount("reader_exchange") < 1 || kindCount("organic_reaction") < 1) {
        add(index, "comment_topology", "error", peerSeeding
          ? "素人种草评论区必须混排至少 2 条博主本人回复、1 条读者接话和 1 条短反应。"
          : "新评论关系网必须混排至少 2 条机构答疑、1 条读者接话和 1 条短反应。");
      }
      if (!typedThreads.some((thread) => thread.threadKind !== "organic_reaction" && thread.followUps.length > 0)) add(index, "comment_growth", "error", "评论关系网至少应有一个由具体话头自然长出的二轮接话。");
    }
    const threadIds = new Set<string>();
    for (const thread of candidate.content.Cref.threads) {
      const threadKind = thread.threadKind ?? "org_answer";
      if (!thread.id.trim() || threadIds.has(thread.id)) add(index, "thread_id", "error", "评论线程 ID 必须非空且唯一。");
      threadIds.add(thread.id);
      if (!thread.question.trim()) add(index, "empty_thread", "error", "评论线程必须包含可见内容。");
      if (thread.threadKind && !thread.displayName?.trim()) add(index, "missing_thread_display_name", "error", "新评论线程需要一个仅用于展示的模拟读者昵称。");
      if (threadKind === "org_answer") {
        if (!thread.answer.trim()) add(index, "empty_thread", "error", "机构答疑必须包含直接回答。");
        /*
         * 澄清/下一步/边界/停止原因只对**可追责的机构身份**强制。
         *
         * peer_seeding 下博主以 author 身份回复自己的帖子,那是朋友聊天的口气
         * (「是哪个白白哦？」→「老朱，朱冠锋呀」),硬塞这四样就会写成客服话术。
         * 但机构一开口仍然全部要求 —— 换模式不该让机构失去边界。
         */
        const accountable = !(peerSeeding && thread.postingIdentity === "author");
        if (accountable) {
          if (!thread.clarification?.trim()) add(index, "missing_thread_clarification", "error", "机构答疑必须说明澄清内容或不可判断范围。");
          if (!thread.nextStep?.trim()) add(index, "missing_thread_next_step", "error", "机构答疑必须给出可核验的下一步。");
          if (!thread.boundary?.trim()) add(index, "missing_thread_boundary", "error", "机构答疑必须在相关结论附近显示边界。");
          if (!thread.stopReason) add(index, "missing_thread_stop_reason", "error", "机构答疑必须说明停止原因，避免机械追加追问。");
        }
      } else if (threadKind === "reader_exchange") {
        if (!thread.answer.trim() || !thread.replyDisplayName?.trim()) add(index, "reader_exchange_incomplete", "error", "读者接话必须包含第二位模拟读者的昵称和接话内容。");
      } else {
        if (thread.answer.trim() || thread.followUps.length || thread.clarification?.trim() || thread.nextStep?.trim() || thread.boundary?.trim() || thread.replyDisplayName?.trim() || thread.evidenceIds.length) {
          add(index, "organic_reaction_overbuilt", "error", "短反应只能保留一句模拟读者反应，不得伪造机构答复、证据或完整问答链。");
        }
        if ([...thread.question.replace(/\s+/gu, "")].length > 20) add(index, "organic_reaction_too_long", "error", "短反应应控制在 4—20 个字符左右。");
      }
      for (const followUp of thread.followUps) {
        if (!followUp.kind) add(index, "missing_follow_up_kind", "error", "追问必须标明是新增追问还是反例。");
        if (!followUp.question.trim() || !followUp.answer.trim()) add(index, "empty_follow_up", "error", "追问或反例必须包含问题与答复。");
      }
      for (const evidenceId of thread.evidenceIds) if (!knownEvidence.has(evidenceId) || !disclosedEvidenceIds.has(evidenceId)) add(index, "thread_evidence", "error", `评论线程引用了未读取证据 ${evidenceId}。`);
    }
  }
  if (expectedCount > 1 && candidates.length > 1) {
    const narrativePaths = new Map<string, number>();
    for (const candidate of candidates) {
      const prior = narrativePaths.get(candidate.marketingStrategy?.narrativePath);
      if (prior !== undefined) add(candidate.candidateIndex, "candidate_narrative_path_overlap", "error", `候选 ${prior + 1} 与候选 ${candidate.candidateIndex + 1} 使用了相同叙事路径。三套原稿必须分别从顾虑、观察和决策问题切入。`);
      else narrativePaths.set(candidate.marketingStrategy?.narrativePath, candidate.candidateIndex);
    }
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const left = candidates[leftIndex]!; const right = candidates[rightIndex]!;
        const leftJudgment = left.marketingStrategy?.newJudgment.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
        const rightJudgment = right.marketingStrategy?.newJudgment.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
        if (leftJudgment && leftJudgment === rightJudgment) {
          add(right.candidateIndex, "candidate_judgment_overlap", "warning", `候选 ${left.candidateIndex + 1} 与候选 ${right.candidateIndex + 1} 使用了相同认知翻转，三套方案的判断标准区分度不足。`);
        }
        const leftBridge = left.marketingStrategy?.projectBridge.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
        const rightBridge = right.marketingStrategy?.projectBridge.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
        if (leftBridge && leftBridge === rightBridge) {
          add(right.candidateIndex, "candidate_bridge_overlap", "warning", `候选 ${left.candidateIndex + 1} 与候选 ${right.candidateIndex + 1} 承接了同一个项目价值点，请人工确认是否只是换写法。`);
        }
        const similarity = jaccardSimilarity(left.content.N.body, right.content.N.body);
        if (similarity >= 0.72) {
          add(right.candidateIndex, "candidate_body_similarity", "warning", `候选 ${left.candidateIndex + 1} 与候选 ${right.candidateIndex + 1} 正文相似度偏高（${Math.round(similarity * 100)}%），建议保留读者欲望或判断标准差异更大的版本。`);
        }
      }
    }
  }
  return issues;
}
