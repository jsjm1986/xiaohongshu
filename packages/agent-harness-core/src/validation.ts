import type {
  HarnessCandidate, HarnessClaimAudit, HarnessEvidenceSource, HarnessImageSource, HarnessPublicationCheck, HarnessValidationIssue,
} from "./types.js";

const EXPERIENCE_CLAIM = /(亲测|我做过|我用过|我体验过|朋友做过|闺蜜做过|真实顾客|真实客户)/u;
const EVIDENCE_ERROR_CODES = new Set(["claim_audit_incomplete", "claim_audit_not_visible", "undeclared_project_fact", "claim_audit_evidence_mismatch", "empty_citation_statement", "citation_not_visible", "citation_without_evidence", "unknown_evidence", "unread_evidence", "non_factual_evidence"]);
const ASSET_ERROR_CODES = new Set(["asset_decision_count", "asset_decision_duplicate", "unknown_asset_decision", "asset_decision_evidence", "asset_use_without_sequence", "asset_omit_still_used", "image_sequence_asset", "image_sequence_evidence"]);
const EXECUTION_ERROR_CODES = new Set(["missing_response_sla", "missing_live_question_routes", "incomplete_live_question_route", "missing_update_triggers", "missing_stop_rules"]);

export function visibleCandidateText(candidate: HarnessCandidate): string {
  return [
    candidate.content.N.coverHeadline, candidate.content.N.coverSubheadline, candidate.content.N.imageBrief,
    ...candidate.content.N.imageSequence.flatMap((item) => [item.overlayText, item.direction]),
    candidate.content.N.title, candidate.content.N.body, candidate.content.N.callToAction,
    ...candidate.content.H.hashtags, candidate.content.Cref.ownedFirstComment,
    ...candidate.content.Cref.threads.flatMap((thread) => [thread.question, thread.answer, thread.clarification ?? "", thread.nextStep ?? "", thread.boundary ?? "", ...thread.followUps.flatMap((item) => [item.question, item.answer])]),
    candidate.content.publishing.entryPoint, candidate.content.publishing.accountIdentity,
    candidate.content.publishing.timingNote, candidate.content.publishing.interactionGoal,
    candidate.content.publishing.responseSla ?? "",
    ...(candidate.content.publishing.liveQuestionRoutes ?? []).flatMap((route) => [route.when, route.action]),
    ...(candidate.content.publishing.updateTriggers ?? []), ...(candidate.content.publishing.stopRules ?? []),
  ].join("\n");
}

export function publicationChecklistFor(candidate: HarnessCandidate, issues: HarnessValidationIssue[]): HarnessPublicationCheck[] {
  const errorCodes = new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.code));
  const evidenceBlocked = [...errorCodes].some((code) => EVIDENCE_ERROR_CODES.has(code));
  const assetBlocked = [...errorCodes].some((code) => ASSET_ERROR_CODES.has(code));
  const executionBlocked = [...errorCodes].some((code) => EXECUTION_ERROR_CODES.has(code));
  const simulationBlocked = ["comment_disclaimer", "missing_owned_first_comment", "empty_thread", "missing_thread_clarification", "missing_thread_next_step", "missing_thread_stop_reason"].some((code) => errorCodes.has(code));
  return [
    { key: "evidence", status: evidenceBlocked ? "blocked" : "ready", note: evidenceBlocked ? "事实或证据绑定仍有阻断项。" : "可见事实已通过本轮证据校验。" },
    { key: "simulation_disclosure", status: simulationBlocked ? "blocked" : "ready", note: simulationBlocked ? "模拟互动披露或评论结构不完整。" : "首评归属与模拟问答披露已明确。" },
    { key: "execution_plan", status: executionBlocked ? "blocked" : "ready", note: executionBlocked ? "真实问题响应、分流、更新或停止规则不完整。" : "真实问题承接的响应、分流、更新与停止规则已齐备。" },
    { key: "asset_authorization", status: assetBlocked ? "blocked" : "ready", note: assetBlocked ? "所选图片的使用/舍弃与证据绑定不完整。" : "每张所选图片已有可追溯使用或舍弃决定。" },
    { key: "platform_compliance", status: "manual_review", note: "平台规则、敏感词和账号资质必须在实际发布前由人工按当时规则复核。" },
    { key: "final_proofread", status: issues.some((issue) => issue.severity === "error") ? "blocked" : "manual_review", note: issues.some((issue) => issue.severity === "error") ? "先解决硬校验阻断，再进行终稿校对。" : "发布前仍需人工核对最终排版、素材授权、链接与时效信息。" },
  ];
}

export function validateHarnessCandidates(
  candidates: HarnessCandidate[],
  evidence: HarnessEvidenceSource[],
  disclosedEvidenceIds: ReadonlySet<string>,
  constraints: {
    mustInclude?: readonly string[]; forbidden?: readonly string[]; claimAudit?: HarnessClaimAudit;
    expectedCandidateCount?: number; runMode?: "original" | "retry" | "revision"; sourceCandidateIndex?: number;
    revisionInstruction?: string; selectedImages?: readonly HarnessImageSource[];
  } = {},
): HarnessValidationIssue[] {
  const issues: HarnessValidationIssue[] = []; const knownEvidence = new Map(evidence.map((item) => [item.evidenceId, item]));
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
    const disclaimer = candidate.content.Cref.disclaimer;
    if (!/(参考|模板)/u.test(disclaimer) || !/(模拟|不代表.{0,8}真实)/u.test(disclaimer)) add(index, "comment_disclaimer", "error", "评论区必须明确标为模拟问答参考，不代表真实互动。");
    const visible = visibleCandidateText(candidate);
    const audited = constraints.claimAudit?.claims.filter((claim) => claim.candidateIndex === candidate.candidateIndex) ?? [];
    for (const claim of audited) {
      if (!claim.statement || !visible.includes(claim.statement)) { add(index, "claim_audit_not_visible", "error", "事实盘点返回的声明无法在可见内容中精确定位。"); continue; }
      if (claim.classification !== "project_fact") continue;
      const declared = candidate.citations.find((citation) => citation.statement === claim.statement);
      if (!declared) { add(index, "undeclared_project_fact", "error", `可见项目事实未在证据声明中登记：${claim.statement}`); continue; }
      const declaredIds = new Set(declared.evidenceIds);
      if (!claim.evidenceIds.length || claim.evidenceIds.some((id) => !declaredIds.has(id))) add(index, "claim_audit_evidence_mismatch", "error", `项目事实的盘点证据与候选声明不一致：${claim.statement}`);
    }
    for (const required of constraints.mustInclude ?? []) if (required && !visible.includes(required)) add(index, "required_content_missing", "error", `用户要求的内容未出现：${required}`);
    for (const prohibited of constraints.forbidden ?? []) if (prohibited && visible.includes(prohibited)) add(index, "forbidden_content", "error", `出现了用户禁止的内容：${prohibited}`);
    if (EXPERIENCE_CLAIM.test(visible)) add(index, "fabricated_experience", "error", "可见内容包含可能伪装真实经历或口碑的措辞。");
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
    const threadIds = new Set<string>();
    for (const thread of candidate.content.Cref.threads) {
      if (!thread.id.trim() || threadIds.has(thread.id)) add(index, "thread_id", "error", "评论线程 ID 必须非空且唯一。");
      threadIds.add(thread.id);
      if (!thread.question.trim() || !thread.answer.trim()) add(index, "empty_thread", "error", "评论线程必须包含问题与直接回答。");
      if (!thread.clarification?.trim()) add(index, "missing_thread_clarification", "error", "评论线程必须说明澄清内容或不可判断范围。");
      if (!thread.nextStep?.trim()) add(index, "missing_thread_next_step", "error", "评论线程必须给出可核验的下一步。");
      if (!thread.stopReason) add(index, "missing_thread_stop_reason", "error", "评论线程必须说明停止原因，避免机械追加追问。");
      for (const followUp of thread.followUps) {
        if (!followUp.kind) add(index, "missing_follow_up_kind", "error", "追问必须标明是新增追问还是反例。");
        if (!followUp.question.trim() || !followUp.answer.trim()) add(index, "empty_follow_up", "error", "追问或反例必须包含问题与答复。");
      }
      for (const evidenceId of thread.evidenceIds) if (!knownEvidence.has(evidenceId) || !disclosedEvidenceIds.has(evidenceId)) add(index, "thread_evidence", "error", `评论线程引用了未读取证据 ${evidenceId}。`);
    }
  }
  return issues;
}
