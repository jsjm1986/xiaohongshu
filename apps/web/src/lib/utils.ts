import { resolveProductionArtifactView } from './image-production';
import {
  auditAnswerAttribution,
  commentNodeKindLabel,
  commentThreadKindLabel,
  commentThreadKindOf,
  deploymentSla,
  liveRoutingLines,
  postingIdentityText,
  uncoveredGapLabels,
} from './comment-cref';
import type { Candidate } from '../types';

export const formatDate = (value?: string, includeTime = false) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
};

export const formatBytes = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size > 10240 ? 0 : 1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const downloadText = (filename: string, content: string, type = 'text/plain;charset=utf-8') => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export const candidateToMarkdown = (candidate: Candidate) => {
  // Cref contract v1.1 candidates copy in the two-part executive + audit
  // appendix layout (same policy as the API export); historical candidates
  // keep the legacy single-flow markdown byte-for-byte.
  if (isCrefV11Candidate(candidate)) return candidateToV11TwoPartMarkdown(candidate);
  return legacyCandidateToMarkdown(candidate);
};

/**
 * Two-part layout gate mirroring the API export (Cref contract v1.1). The
 * Candidate projection carries no schemaVersion, so the layout flips only
 * when v1.1 Cref data is present: commentOwnedFirstComment /
 * commentUncoveredGaps, or any thread / followUp kind / answerKind /
 * boundary / nextStep / evidenceIds.
 */
const isCrefV11Candidate = (candidate: Candidate): boolean => {
  if (candidate.commentOwnedFirstComment) return true;
  if (candidate.commentUncoveredGaps !== undefined) return true;
  return candidate.comments.some((item) =>
    Boolean(item.kind || item.answerKind || item.boundary || item.nextStep)
    || Boolean(item.evidenceIds?.length)
    || (item.followUps || []).some((followUp) => Boolean(followUp.kind || followUp.boundary || followUp.evidenceIds?.length)));
};

/**
 * Two-part copy markdown for v1.1 candidates: an executive part the operator
 * can act on directly (publish copy, owned first comment, dialogue scripts,
 * aC operating rules), then a separated audit appendix with the full metadata
 * trail. Audit vocabulary (role cards, density proxies, reply plans,
 * discovery plans, evidence ids) stays out of the executive part.
 */
const candidateToV11TwoPartMarkdown = (candidate: Candidate) => {
  // 展示昵称前缀(纯展示元数据):提问/接话侧带昵称,答复侧带机构名;
  // 历史包没有 displayName / surfaceRoleCard 时保持原格式,不加空前缀。
  const nicknamePrefix = (name?: string) => (name?.trim() ? `${name.trim()}：` : '');
  const replyOrgName = (item: Candidate['comments'][number]): string => {
    const raw = item.surfaceRoleCard?.replyDisplayRole?.trim() ?? '';
    if (!raw) return '';
    // assistant_account / host_account 这类内部 id 形态只显示通用文案,不裸露内部 id。
    if (/^[a-z][a-z0-9_]*$/.test(raw)) return item.postingIdentity === 'staff' ? '机构助理' : '机构 IP';
    return raw;
  };
  const ownedFirstComment = candidate.commentOwnedFirstComment
    ? `## 可发布首评参考\n\n> 【可发布首评参考】由发布账号（publisher）身份发布：${candidate.commentOwnedFirstComment}\n\n`
    : '';
  const disclaimer = candidate.commentDisclaimer || '以下仅演练潜在读者问题与可追责答复。';
  const scripts = candidate.comments.map((item, index) => {
    // 读者互动层:T2 读者互聊的「回复」位是读者 B 接话;T3 漂浮短反应无回答
    // 需求;T1(含历史包缺省)维持机构问答格式。
    const threadKind = commentThreadKindOf(item);
    if (threadKind === 'organic_reaction') {
      return [
        `### 话术 ${index + 1}（漂浮短反应）\n`,
        `- 漂浮反应：${nicknamePrefix(item.displayName)}${item.question}`,
        `- 无需机构回复（4-20 字短共鸣，机构不出现）`,
      ].filter(Boolean).join('\n');
    }
    if (threadKind === 'reader_exchange') {
      return [
        `### 话术 ${index + 1}（读者互聊）\n`,
        `- 提问：${nicknamePrefix(item.displayName)}${item.question}`,
        `- 读者接话：${nicknamePrefix(item.replyDisplayName)}${item.followUps?.length ? item.answer.split(/\n\n追问：/u)[0] || item.answer : item.answer}`,
        `- 互动类型：读者互聊（模拟读者之间接话，不谈项目事实；真实问题由${postingIdentityText(item.postingIdentity) || '可追责发布者'}承接）`,
        item.boundary ? `- 答复边界：${item.boundary}` : '',
        item.nextStep ? `- 下一步：${item.nextStep}` : '',
        ...(item.followUps || []).map((followUp) => `  - 追问：${nicknamePrefix(followUp.displayName)}${followUp.question}\n  - 补充：${followUp.answer}`),
      ].filter(Boolean).join('\n');
    }
    return [
      `### 话术 ${index + 1}\n`,
      `- 提问：${nicknamePrefix(item.displayName)}${item.question}`,
      `- 回复：${replyOrgName(item) ? `${replyOrgName(item)}：` : ''}${item.followUps?.length ? item.answer.split(/\n\n追问：/u)[0] || item.answer : item.answer}`,
      `- 可追责答复身份：${postingIdentityText(item.postingIdentity) || '可追责发布者'}`,
      item.boundary ? `- 答复边界：${item.boundary}` : '',
      item.nextStep ? `- 下一步：${item.nextStep}` : '',
      ...(item.followUps || []).map((followUp) => `  - 追问：${nicknamePrefix(followUp.displayName)}${followUp.question}\n  - 补充：${followUp.answer}`),
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const appendixImagePlan = candidate.imagePlan
    ? `### 图片计划（规划信息，非最终图片）\n\n${imagePlanMarkdown(candidate)}\n\n`
    : '';
  const coverage = coverageLedgerMarkdown(candidate);
  return `# ${candidate.title}\n\n## 发布内容\n\n### 图片简报（实际 imageBrief，非最终图片）\n\n${candidate.imageBrief || '暂无'}\n\n### 正文\n\n${candidate.body}\n\n### 标签\n\n> 标签只表达主题与入口规划，不证明进入热点榜或热议话题，也不保证曝光、推荐或合格触达。\n\n${candidate.tags.join(' ')}\n\n${ownedFirstComment}## 问答话术（模拟情景演练，非真实评论）\n\n> 【模拟情景，非真实评论】${disclaimer}\n\n${scripts || '_未提供问答话术_'}\n\n## aC · 评论运营规则（运营动作计划，非已执行）\n\n${deploymentExecutionMarkdown(candidate)}\n\n---\n\n# 审计附录（非发布素材）\n\n## 发布规划元数据\n\n${appendixImagePlan}### 图片产物状态账本\n\n${productionLedgerMarkdown(candidate)}\n\n## 评论线程完整元数据\n\n${commentThreadAuditMarkdown(candidate) || '_无评论线程_'}${uncoveredGapProjectionMarkdown(candidate)}\n\n${coverage}${coverage ? '\n' : ''}`;
};

const legacyCandidateToMarkdown = (candidate: Candidate) => {
  const image = imagePlanMarkdown(candidate);
  const productionLedger = productionLedgerMarkdown(candidate);
  const execution = deploymentExecutionMarkdown(candidate);
  const coverageSection = coverageLedgerMarkdown(candidate);
  const comments = commentThreadAuditMarkdown(candidate);
  const ownedFirstComment = candidate.commentOwnedFirstComment
    ? `**可发布首评参考（由发布账号身份发布）：${candidate.commentOwnedFirstComment}**\n\n`
    : '';
  const uncoveredGaps = uncoveredGapProjectionMarkdown(candidate);
  return `# ${candidate.title}\n\n## H · 标签入口\n\n> 标签只表达主题与入口规划，不证明进入热点榜或热议话题，也不保证曝光、推荐或合格触达。\n\n${candidate.tags.join(' ')}\n\n## N · 图片计划 / imageBrief（非最终图片）\n\n${image}\n\n### 图片产物状态账本\n\n${productionLedger}\n\n## N · 正文\n\n${candidate.body}\n\n## Cref · 评论区模拟情景参考\n\n> 【模拟情景，非真实评论】${candidate.commentDisclaimer || '以下仅演练潜在读者问题与可追责答复。'}\n\n${ownedFirstComment}${comments}${uncoveredGaps}\n\n${coverageSection}\n## aC · 部署计划（非部署记录）\n\n${execution}\n`;
};

/** Full per-thread audit metadata, shared by the legacy flow and the v1.1 audit appendix. */
const commentThreadAuditMarkdown = (candidate: Candidate) => candidate.comments.map((item) => [
  `> 【${item.simulated ? item.simulationLabel || '模拟潜在读者情景' : '历史内容，模拟字段未标注'}】${item.simulated ? '不代表真实评论、消费经历或第三方口碑。' : ''}`,
  `**评论：${item.question}**`,
  `> 角色：${commentPersonaLabel(item.personaRole)}；提问方：${commentSpeakerLabel(item.speakerType)}；声明：${commentClaimLabel(item.claimStatus)}；答复身份：${auditAnswerAttribution(item).identity}`,
  item.threadKind ? `> 互动类型：${commentThreadKindLabel(item.threadKind)}${item.threadKind === 'reader_exchange' && item.replyDisplayName ? `（${item.displayName || '读者A'} → ${item.replyDisplayName}）` : ''}` : '',
  item.kind || item.answerKind ? `> 节点类型：提问=${item.kind ? commentNodeKindLabel(item.kind) : '问题（默认）'}；答复=${item.answerKind ? commentNodeKindLabel(item.answerKind) : '回答（默认）'}` : '',
  item.boundary ? `> 答复边界：${item.boundary}` : '',
  item.evidenceIds?.length ? `> 证据引用：${item.evidenceIds.join('、')}` : '',
  item.surfaceRoleCard ? `> 可见人物：${item.surfaceRoleCard.displayRole}；与楼主关系=${item.surfaceRoleCard.relationToHost}；身份线索=${item.surfaceRoleCard.identityCue}；处境线索=${item.surfaceRoleCard.situationCue}；说话习惯=${item.surfaceRoleCard.speechPattern}；可选语域=${item.surfaceRoleCard.lexicalCues?.join('、') || '普通口语'}；接话钩子=${item.surfaceRoleCard.interactionHook || '按上一句里的具体细节自然接话'}；知识边界=${item.surfaceRoleCard.knowledgePosition}` : '',
  item.roleCard ? `> 后台决策状态：阶段=${item.roleCard.stage}；已有知识=${item.roleCard.knowledge.join('、') || '未标注'}；现实约束=${item.roleCard.constraints.join('、') || '无'}；决策任务=${item.roleCard.decisionTask}；证据态度=${commentEvidenceStanceLabel(item.roleCard.evidenceStance)}` : '',
  item.densityProxy ? `> 信息密度代理：1个主缺口＋${item.densityProxy.auxiliaryDimensionCount}个辅助维度；${item.densityProxy.constraintCount}个约束；短问软目标约${item.densityProxy.questionTargetChars}字（非效果分）` : '',
  `${auditAnswerAttribution(item).label}：${item.followUps?.length ? item.answer.split(/\n\n追问：/u)[0] || item.answer : item.answer}`,
  item.replyPlan ? `> 后台答复库存（按人物与关系择需使用，不要求全部写出）：直接回答=${item.replyPlan.directAnswer}；条件=${item.replyPlan.condition}；边界=${item.replyPlan.boundary}；未知=${item.replyPlan.unknown}；下一问=${item.replyPlan.nextQuestion}` : '',
  item.discoveryPlan ? `> 发现式路径：线索=${item.discoveryPlan.cue}；一步推断=${item.discoveryPlan.inferencePrompt}；同线程揭示=${item.discoveryPlan.reveal}；自检=${item.discoveryPlan.selfCheck}；边界=${item.discoveryPlan.boundary}；难度=${item.discoveryPlan.difficulty === 'low' ? '低' : '中等'}` : '',
  item.conversationPlan ? `> 对话拓扑：${item.conversationPlan.topology}；目标接话=${item.conversationPlan.targetFollowUps}；延展=${item.conversationPlan.extensionMove}` : '',
  ...(item.followUps || []).map((followUp) => [
    `接话：${followUp.question}\n\n回复：${followUp.answer}`,
    followUp.kind ? `> 接话节点类型：${commentNodeKindLabel(followUp.kind)}` : '',
    followUp.boundary ? `> 接话边界：${followUp.boundary}` : '',
    followUp.evidenceIds?.length ? `> 接话证据引用：${followUp.evidenceIds.join('、')}` : '',
  ].filter(Boolean).join('\n\n')),
  item.nextStep ? `下一步：${item.nextStep}` : '',
].filter(Boolean).join('\n\n')).join('\n\n');

const imagePlanMarkdown = (candidate: Candidate) => {
  const imagePlan = candidate.imagePlan;
  return [
    imagePlan?.role ? `- 图片计划职责：${imagePlan.role}` : '',
    imagePlan?.composition ? `- 构图：${imagePlan.composition}` : '',
    imagePlan?.sourceAssetId || imagePlan?.primaryAssetId ? `- 计划参考源素材：${imagePlan.sourceAssetId || imagePlan.primaryAssetId}` : '',
    imagePlan?.coverText ? `- 封面文字：${imagePlan.coverText}` : '',
    imagePlan?.frames?.length ? `- 画面顺序：${imagePlan.frames.join(' → ')}` : '',
    imagePlan?.boundaries?.length ? `- 图片边界：${imagePlan.boundaries.join('；')}` : '',
    !imagePlan ? candidate.imageBrief || '暂无' : '',
  ].filter(Boolean).join('\n');
};

const productionLedgerMarkdown = (candidate: Candidate) => {
  const production = resolveProductionArtifactView(candidate);
  return [
    ...production.stages.map((item) => `- ${item.label}：${item.status}；${item.explanation}`),
    ...production.alignments.map((item) => `- ${item.label}：${item.status}；evaluated=${item.evaluated}`),
  ].join('\n');
};

const deploymentExecutionMarkdown = (candidate: Candidate) => {
  const deployment = candidate.deploymentPlan;
  return deployment ? [
    `- 发布身份：${postingIdentityText(deployment.postingIdentity) || '可追责发布者'}`,
    `- 自有首评：${typeof deployment.ownedFirstComment === 'boolean' ? (deployment.ownedFirstComment ? '需要' : '不需要') : deployment.ownedFirstComment || '按实际情况'}`,
    deploymentSla(deployment) ? `- 答复时效：${deploymentSla(deployment)}` : '',
    deployment.pinPriority?.length ? `- 置顶优先级：${deployment.pinPriority.join('、')}` : '',
    ...liveRoutingLines(deployment.liveRouting).map((line) => `- 真实评论路由：${line}`),
    ...(deployment.updatePolicy || []).map((item) => `- 更新政策：${item}`),
    deployment.stopRules?.length ? `- 停止规则：${deployment.stopRules.join('；')}` : '',
  ].filter(Boolean).join('\n') : '暂无单独执行方案。';
};

const coverageLedgerMarkdown = (candidate: Candidate) => {
  const coverage = candidate.gapCoverageLedger;
  const ledgerCompleteness = coverage ? coverage.ledgerCompleteness ?? coverage.closureRate : null;
  const realizedResolvedRate = coverage?.realizationStatus === 'evaluated'
    ? coverage.realizedResolvedRate ?? coverage.resolvedRate
    : coverage?.realizedResolvedRate != null ? coverage.realizedResolvedRate : null;
  return coverage ? [
    '## 信息闭合台账',
    '',
    `- 台账完整度：${Math.round((ledgerCompleteness ?? 0) * 100)}%（只表示选中缺口均已归档，不代表已经解决）`,
    `- 最终实际解决率：${realizedResolvedRate == null ? '待评估' : `${Math.round(realizedResolvedRate * 100)}%`}`,
    `- 线程可读性目标 / 实际：${coverage.targetThreadCount} / ${coverage.effectiveThreadCount}`,
    coverage.capacityWarning ? `- 容量提示：${coverage.capacityWarning}` : '',
    ...coverage.entries.map((entry) => `- ${entry.label}（${entry.gapId}）：${coverageStatusLabel(entry.status)}；${entry.reason}${entry.plannedPlacements?.length ? `；计划位置=${entry.plannedPlacements.join('/')}` : ''}${entry.actualRealizations?.length ? `；实际核验=${entry.actualRealizations.map((item) => `${item.channel}:${item.resolved ? '完整实现' : `缺少${item.missing.map(realizationMissingLabel).join('、')}`}`).join('；')}` : ''}${entry.requiredInput ? `；待补输入=${entry.requiredInput}` : ''}${entry.verificationPath ? `；核验路径=${entry.verificationPath}` : ''}`),
    '',
  ].filter(Boolean).join('\n') : '';
};

const uncoveredGapProjectionMarkdown = (candidate: Candidate) => candidate.commentUncoveredGaps
  ? `\n\n> 本篇未展开缺口（规划期投影，非遗漏错误）：${uncoveredGapLabels(candidate.commentUncoveredGaps, candidate.orchestrationSnapshot?.gapPlanningCards).join('、') || '无；所有选中缺口已由评论线程或正文承担。'}`
  : '';

const coverageStatusLabel = (value: string) => ({
  planned_for_body: '计划由正文回答', planned_for_thread: '计划由评论回答',
  body_resolved: '正文已解决', thread_resolved: '评论线程已解决', awaiting_user_input: '等待用户输入',
  realization_failed: '最终实现不完整', unknown_with_verification: '未知但有核验路径', explicitly_deferred: '有理由延后',
}[value] || value);

const realizationMissingLabel = (value: string) => ({
  answer: '答案/框架', condition_or_boundary: '条件或边界', evidence: '证据映射', findability: '可找到位置',
}[value] || value);

const commentPersonaLabel = (value?: string) => ({
  first_time_researcher: '初次做功课', information_collector: '信息收集者', comparison_decider: '比较决策者',
  risk_concerned: '风险顾虑者', local_action_seeker: '本地行动者', skeptical_returning_reader: '审慎回访者',
}[value || ''] || value || '未标注');

const commentSpeakerLabel = (value?: string) => ({
  simulated_reader: '模拟读者', accountable_responder: '可追责答复者',
}[value || ''] || value || '未标注');

const commentClaimLabel = (value?: string) => ({
  verified: '有证据支持', bounded: '有边界回答', unknown: '保留未知', hypothetical: '假设情景',
}[value || ''] || value || '未标注');

const commentEvidenceStanceLabel = (value?: string) => ({
  evidence_first: '证据优先', verification_seeking: '主动核验', boundary_sensitive: '边界敏感', unknown_aware: '保留未知',
}[value || ''] || value || '未标注');
