import type {
  HarnessCandidate, HarnessClaimAudit, HarnessEvidenceSource, HarnessImageSource, HarnessPublicationCheck, HarnessValidationIssue,
} from "./types.js";
import { DEFAULT_HARNESS_SEEDING_MODE, HARNESS_BODY_LENGTH_TARGETS, HARNESS_PEER_BODY_MIN } from "./methods.js";
import type { HarnessSeedingMode } from "./methods.js";

/** Harness publication is permissive by default. Only mechanically verifiable
 * missing artifacts, public control-language leaks and fake evidence/assets can
 * block delivery. New validation codes default to review-only. */
export const NON_OVERRIDABLE_HARNESS_ISSUE_CODES = new Set<string>([
  "candidate_count", "candidate_index", "duplicate_candidate_index",
  "missing_title", "missing_body", "missing_account_identity",
  "audit_language_in_public_copy", "source_meta_in_public_copy", "planning_language_in_public_copy",
  "empty_citation_statement", "citation_not_visible", "citation_without_evidence",
  "unknown_evidence", "unread_evidence", "non_factual_evidence",
  "new_design_asset_id", "unknown_asset_decision", "image_sequence_asset",
]);

export function isNonOverridableHarnessIssueCode(code: string): boolean {
  return NON_OVERRIDABLE_HARNESS_ISSUE_CODES.has(code);
}

export function normalizeHarnessValidationIssue(issue: HarnessValidationIssue): HarnessValidationIssue {
  return isNonOverridableHarnessIssueCode(issue.code)
    ? { ...issue, severity: "error" }
    : { ...issue, severity: "warning" };
}

export function harnessValidationValid(issues: readonly HarnessValidationIssue[]): boolean {
  return !issues.some((issue) => isNonOverridableHarnessIssueCode(issue.code));
}

/*
 * 伪造口碑的营销话术。两种模式都是 ERROR。
 *
 * 实测 67 篇真实对标语料里这一支命中 0 篇 —— 真人不这么说话,
 * 「亲测」「真实顾客」是广告文案的措辞,该一直禁。
 */
const FABRICATED_TESTIMONIAL = /(亲测|我做过|我用过|我体验过|朋友做过|闺蜜做过|真实顾客|真实客户)/u;
/*
 * 第一人称时间线叙述。**只认「我」这一个主语。** peer_seeding 放开,brand_voice 仍 ERROR。
 *
 * 「我做完两天了」这类朴素叙述在 67 篇语料里命中 13 篇(19%),是这批内容的常态。
 * 放开的依据:内容由真人素人账号发布、经历真实,AI 只是代笔起草。
 * brand_voice 下保持阻断 —— 机构口吻不能假装自己是顾客。
 *
 * 为什么主语必须收窄到「我」(这里最容易被后人改回去):
 * 原正则把 朋友|闺蜜|同事|姐妹|家人 和「我」并列在一个字符组里,名字叫「第一人称」
 * 但 6 个主语里 5 个是别人。brand_voice 下无害(整条都 ERROR),可 peer_seeding 一旦
 * 整条豁免,「我闺蜜做完第二天就上班了」也跟着放行 —— 那是 AI 编造的第三方社会证明。
 * 放开的依据只覆盖「我」:发布人真的做过、真的用自己账号发。闺蜜同事没做过,也没人
 * 为那句话负责。所以第三方主语必须另判(见 THIRD_PARTY_EXPERIENCE),不能并回来。
 */
const FIRST_PERSON_TIMELINE = /我.{0,12}(?:刚做|做完|做了|做的|术后|恢复)/u;
/*
 * 第三方伪造经历。**两种模式都是 ERROR**,与文本来源无关。
 *
 * 「我闺蜜做完第二天就上班了」「同事术后第二天上班」这类句子是替不存在的第三方
 * 编造完成态经历,即伪造社会证明。它挂在真人账号上发出去,但没有任何真人为它负责,
 * 因此与「账号是真人」这个放开依据无关,peer_seeding 也不能放开。
 * 提示词本身已明令不得编造他人(BODY_VOICE_GUIDANCE.peer_seeding 的
 * "Never invent anyone else"),校验层的职责正是模型漂移时的最后一道兜底。
 *
 * FABRICATED_TESTIMONIAL 不兜底这一支:它只抓营销体措辞(「亲测」「闺蜜做过」),
 * 对「我闺蜜做完第二天就上班了」返回 false —— 实测确认。
 */
const THIRD_PARTY_EXPERIENCE = /(?:朋友|闺蜜|同事|姐妹|家人|表姐|表妹|同学|亲戚).{0,12}(?:刚做|做完|做了|做的|术后|恢复)/u;
/*
 * 疑问标记:带疑问的小句不算经历断言,不拦。
 *
 * PEER_SEEDING_GUIDANCE 主动要求「模拟读者问哪个医生/哪家医院,由博主回答」——
 * 医生名字靠被问出来是这个模式的核心机制,而 thread.question 在两种模式下都算
 * restricted,于是「姐妹哪家医院做的」会被第三方分支误判。那里的「姐妹」是称呼博主
 * 本人,不是第三方主张。67 篇语料 13 处命中里有 3 处正是这种问法,拦掉就是误伤。
 *
 * 必须收口语变体:语料里真实那句是「姐妹 你做的咋样」,写的是「咋样」不是「怎么样」。
 * 只列书面疑问词会漏掉它,于是这句被当成第三方断言拦下 —— 实测出现过,故补「咋」。
 */
const QUESTION_MARKER = /[?？]|哪|几|多少|吗|呢|怎么样|怎样|咋样|咋|如何|有没有/u;
/** 小句切分:疑问要按小句判,否则一句陈述后面跟个问句就能把整段洗白。 */
const CLAUSE_BOUNDARY = /[，,。！!？?；;、\n]+/u;

/**
 * 是否存在「第三方主语 + 完成态断言」的小句。
 *
 * 逐小句判而非整段判:整段里只要有一个疑问词就豁免的话,
 * 「闺蜜做完第二天就上班了，哪家医院?」这种半陈述半提问会整段漏过。
 */
function hasThirdPartyExperienceClaim(text: string): boolean {
  return text.split(CLAUSE_BOUNDARY)
    .some((clause) => THIRD_PARTY_EXPERIENCE.test(clause) && !QUESTION_MARKER.test(clause));
}
const PUBLIC_AUDIT_LEAK = /(待人工审核|审核状态|证据编号|responseSla|\bSLA\b|发布计划|不代表已经发布|平台合规|终稿校对)/iu;
const PUBLIC_PLANNING_ARTIFACT = /(?:核验动作|信息边界|项目承接|认知翻转|读者欲望|隐藏卡点|低压力下一步|叙事路径)/u;
const PUBLIC_SOURCE_META = /(项目资料(?:显示|表明|支持|中的?)|现有资料(?:显示|表明|支持|中的?)|根据(?:项目)?知识库|证据(?:显示|表明|支持)|本轮证据|evidence_section_)/iu;
const UNSUPPORTED_POPULATION_LANGUAGE = /(很多人|大家都|最怕|最关心|普遍|通常用户|真实用户都)/u;
const EVIDENCE_ERROR_CODES = new Set(["claim_audit_incomplete", "claim_audit_not_visible", "undeclared_project_fact", "claim_audit_evidence_mismatch", "empty_citation_statement", "citation_not_visible", "citation_without_evidence", "unknown_evidence", "unread_evidence", "non_factual_evidence"]);
const ASSET_ERROR_CODES = new Set(["asset_decision_count", "asset_decision_duplicate", "unknown_asset_decision", "asset_decision_evidence", "asset_use_without_sequence", "asset_omit_still_used", "image_sequence_asset", "image_sequence_evidence"]);
const EXECUTION_ERROR_CODES = new Set(["missing_response_sla", "missing_live_question_routes", "incomplete_live_question_route", "missing_update_triggers", "missing_stop_rules"]);
/*
 * 软营销阻断码集合 —— 决定 soft_marketing 那一项显示 blocked 还是 ready。
 *
 * 这里原先列着 `marketing_bridge_without_reframe`:全仓只出现这一次,从来没有任何
 * 地方发出它。而**实际发出**的 `marketing_bridge_ungrounded`(项目承接没有出处)
 * 反倒不在集合里 —— 8a9e1aa 改了发出处的码名却没同步这个集合,于是它成了唯一
 * 无法把 soft_marketing 翻成 blocked 的软营销码。
 *
 * 本次改动把 `marketing_bridge_ungrounded` 提升成素人模式的核心诚实守卫(锚点可选,
 * 但一旦提到项目就必须有出处),偏偏它是显示不出来的那一个,所以必须一起修。
 * 顺带补上同样漏掉的 `marketing_narrative_path`。
 *
 * 这是显示层修正,不改阻断行为:导出本来就由 `severity: "error"` 挡住,
 * 这个集合只影响清单上那一行的文案。
 */
const SOFT_MARKETING_ERROR_CODES = new Set([
  "missing_marketing_strategy", "marketing_strategy_incomplete", "marketing_anchor_missing",
  "marketing_anchor_order", "marketing_anchor_duplicate", "marketing_judgment_unchanged",
  "marketing_bridge_ungrounded", "marketing_narrative_path", "hard_sell_language",
]);
const HARD_SELL_LANGUAGE = /(限时|最后机会|赶紧|立刻下单|马上抢|错过(?:就|再等)|闭眼入|无脑冲|必做|必须做|不做就|全网最低|名额仅剩)/u;
/*
 * 成品形状偏离。三条都是 WARNING,只在 peer_seeding 下加。
 *
 * 为什么一律 WARNING 而不是 ERROR:形状是偏好,不是诚实边界。语料本身就有越界的
 * 个例(见下面各条的实测命中),用 ERROR 会让整批候选不可导出,而形状问题人眼一看
 * 就能判断。诚实性边界(伪造经历、硬推销、审核语泄漏)才用 ERROR,那些在上面。
 *
 * 三条的依据全部来自用户 67 篇真实对标语料(按笔记链接去重,原文件 70 行含 3 组重复),
 * 三个数字是我自己跑出来的,不是估计:
 *   PLANNING_VOCABULARY  标题+正文合计命中 1/67 篇(1.5%),命中的是正文里的「攻略」
 *   READER_QUESTION_ENDING  去掉行尾话题标记后命中 4/67 篇(6%);不去标记时是 1 篇
 *   INDUSTRY_HASHTAG  317 个真实标签里命中 0 个
 */
const PLANNING_VOCABULARY = /(清单|核验|攻略|避坑|对照|思路|三类|第一项)/u;
/*
 * 行业口吻标签。
 *
 * 「面诊」**故意不在**这个表里:语料里 4 个标签用了它(「#眼袋面诊」「#面诊眼袋」
 * 「#面诊」),把它列进来会误伤真实形态。医美/轻医美/手术/整形/面诊攻略这五个才是
 * 317 个标签里 0 命中的。
 */
const INDUSTRY_HASHTAG = /(医美|轻医美|手术|整形|面诊攻略)/u;
/*
 * 结尾反问读者。
 *
 * 必须允许行尾挂话题标记后再判:语料正文普遍以「#成都眼袋[话题]#」这类串收尾,
 * 直接用 /[？?]\s*$/ 判原始正文只会命中 1 篇 —— 那不是「语料不这么写」,而是问号
 * 被标签挡住了没看见。剥掉行尾标记后真实命中 4 篇(6%),这才是可比的数字。
 * 生成内容的标签不写在正文里,所以剥离对它无副作用。
 */
const TRAILING_HASHTAGS = /(?:[#＃][^#＃\n]*[#＃]?|\[话题\]|\s)+$/u;
const READER_QUESTION_ENDING = /[？?]\s*$/u;

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
 *   authorOwned  发布账号自己的话(正文、首评、org_answer + author 身份的答复)
 *   restricted   虚构读者的话(读者提问、reader_exchange 双方、organic_reaction、非 author 答复)
 * 时间线叙述只在 authorOwned 里被允许;restricted 里出现照旧是 ERROR。
 *
 * 返回逐节点数组而不是拼好的整段:把提问和答复拼起来会跨边界拼出假时间线
 * (例如「我...?」+「要,...做...」),按节点分别匹配才不误报。
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

/**
 * 发布前清单。
 *
 * `seedingMode` 是**可选**第三参:缺省走 DEFAULT_HARNESS_SEEDING_MODE。做成可选是
 * 为了不动红线外的调用点(apps/api 那处靠缺省保持现状),而不是因为它不重要。
 *
 * 为什么必须传:soft_marketing 那一行的 ready 文案原先写死「正文已形成顾虑进入、
 * 认知翻转、项目承接与低压力余味」。素人模式下认知翻转与项目承接已改为可选,
 * 于是一篇合格的裸提问帖(只有处境加一个窄问题)会被这行文案说成「已形成认知翻转
 * 与项目承接」—— 那是假话,而且是操盘手唯一会读的那句话。
 */
export function publicationChecklistFor(
  candidate: HarnessCandidate,
  issues: HarnessValidationIssue[],
  seedingMode: HarnessSeedingMode = DEFAULT_HARNESS_SEEDING_MODE,
): HarnessPublicationCheck[] {
  const allCodes = new Set(issues.map((issue) => issue.code));
  const hardCodes = new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.code));
  const statusFor = (codes: ReadonlySet<string>): HarnessPublicationCheck["status"] =>
    [...hardCodes].some((code) => codes.has(code)) ? "blocked"
      : [...allCodes].some((code) => codes.has(code)) ? "manual_review" : "ready";
  const simulationCodes = new Set([
    // comment_disclaimer 已删:披露语不再是模型产出的交付字段,改为界面/导出固定携带。
    "missing_owned_first_comment", "empty_thread", "missing_thread_clarification",
    "missing_thread_next_step", "missing_thread_boundary", "missing_thread_stop_reason", "comment_thread_count",
    "comment_topology", "comment_growth", "missing_thread_display_name", "reader_exchange_incomplete",
    "organic_reaction_overbuilt", "organic_reaction_too_long",
  ]);
  const softStatus = statusFor(SOFT_MARKETING_ERROR_CODES);
  const evidenceStatus = statusFor(EVIDENCE_ERROR_CODES);
  const simulationStatus = statusFor(simulationCodes);
  const executionStatus = statusFor(EXECUTION_ERROR_CODES);
  const assetStatus = statusFor(ASSET_ERROR_CODES);
  return [
    {
      key: "soft_marketing", status: softStatus,
      note: softStatus === "blocked"
        ? "软营销文案命中机械硬门禁。"
        : softStatus === "manual_review"
          ? "软营销推进存在体裁、顺序或表达提醒；候选仍可用，请按项目语境人工判断。"
          : (seedingMode === "peer_seeding"
            ? "正文按素人自述成立：有顾虑入口与低压力余味；未强制认知翻转与项目承接，若提到项目则已绑定出处。"
            : "正文已形成顾虑进入、认知翻转、项目承接与低压力余味。"),
    },
    { key: "evidence", status: evidenceStatus, note: evidenceStatus === "blocked" ? "证据 ID、可见引用或来源状态存在机械硬门禁。" : evidenceStatus === "manual_review" ? "事实盘点或证据语义仍需人工复核；不阻止使用候选。" : "可见事实已通过本轮证据校验。" },
    { key: "simulation_disclosure", status: simulationStatus, note: simulationStatus === "blocked" ? "模拟互动存在机械硬门禁。" : simulationStatus === "manual_review" ? "模拟互动结构有完整度提醒，请发布前复核。" : "首评归属与模拟问答披露已明确。" },
    { key: "execution_plan", status: executionStatus, note: executionStatus === "blocked" ? "执行计划存在机械硬门禁。" : executionStatus === "manual_review" ? "真实问题响应、分流、更新或停止规则有完整度提醒。" : "真实问题承接的响应、分流、更新与停止规则已齐备。" },
    { key: "asset_authorization", status: assetStatus, note: assetStatus === "blocked" ? "素材引用或授权绑定存在机械硬门禁。" : assetStatus === "manual_review" ? "所选图片的使用、舍弃或证据绑定仍需人工复核。" : "每张所选图片已有可追溯使用或舍弃决定。" },
    { key: "platform_compliance", status: "manual_review", note: "平台规则、敏感词和账号资质必须在实际发布前由人工按当时规则复核。" },
    { key: "final_proofread", status: hardCodes.size ? "blocked" : "manual_review", note: hardCodes.size ? "先解决机械硬门禁，再进行终稿校对。" : "发布前仍需人工核对最终排版、素材授权、链接与时效信息。" },
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
    /** 本轮项目名。只用于 peer_seeding 下提示标签堆了品牌词;缺省则跳过该检查。 */
    projectName?: string;
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
      /*
       * 软营销骨架按模式分叉。
       *
       * 原先四条 marketing_anchor_* 不分模式,它们联手只允许一种正文形状:
       * 必须完成认知翻转(旧判断 ≠ 新判断)、必须有项目承接锚点、承接必须与带证据的
       * 引用重叠、翻转必须早于承接。满足这四条,写出来必然是「我原以为 X,其实是 Y,
       * 而这家正好符合 Y」—— 实跑三篇候选形状完全一样,正是这个原因。
       *
       * 依据来自用户 67 篇真实对标语料(按笔记链接去重)。稳健且三次独立测量一致的
       * 那个数字是:**同时满足「有认知翻转」和「有带引用的项目承接」的样本为 0 篇** ——
       * 也就是没有一篇真实内容能通过原校验。绝大多数样本两样都没有。
       * (这里不写各分支的具体百分比:命中要靠关键词启发式判定,三次独立测量用了不同
       * 词表,百分比各不相同、没人复现得出同一组数。写一个复现不出来的数字会让后来者
       * 以为自己算错了。0 这个结论在三次测量下都成立,才是可靠的审计线索。)
       * 用户要的讨论帖、劝退帖、案例贴图三类,没有一类符合原校验。
       *
       * 所以 peer_seeding 下这两个锚点降为可选。代价已确认接受:单篇可以不承载任何
       * 卖点,只做占位和铺量。brand_voice 一个字节不放宽 —— 那边是机构以自己的口吻
       * 种草,认知翻转和项目承接照旧是硬要求。
       */
      const optionalStrategyFields: readonly string[] = peerSeeding
        ? ["oldJudgment", "newJudgment", "projectBridge", "reframeAnchor", "projectBridgeAnchor"]
        : [];
      /*
       * 必填字段集必须跟着分叉,否则放宽等于没做。
       *
       * 这一条原先要求 strategy 的**每个**字段非空,于是 peer_seeding 下允许
       * reframeAnchor 为空之后,它会立刻替 marketing_anchor_missing 报错 ——
       * 只是换个 code,产出照旧被逼成软文。
       * 剩下的字段(readerDesire / hiddenTension / lowPressureNextStep 等)仍必须非空:
       * 它们与体裁无关,是「这篇在对谁说、卡在哪、下一步是什么」。
       */
      const incompleteFields = Object.entries(strategy)
        .filter(([field]) => !optionalStrategyFields.includes(field))
        .filter(([, value]) => !String(value ?? "").trim());
      if (incompleteFields.length) add(index, "marketing_strategy_incomplete", "error", peerSeeding
        ? "软营销策略必须写清用户欲望、隐藏卡点和低压力下一步（素人模式下认知翻转与项目承接可留空）。"
        : "软营销策略必须写清用户欲望、隐藏卡点、旧判断、新判断、项目承接和低压力下一步。");
      if (!["tension_first", "observation_first", "question_first"].includes(strategy.narrativePath)) add(index, "marketing_narrative_path", "error", "软营销策略必须声明有效的叙事路径。");
      /*
       * 去重只对非空锚点做。
       *
       * peer_seeding 下两个锚点可能都是空字符串,拿四个锚点比 Set 大小时
       * Set 只有 3 个元素 —— 「合法地不写翻转」会被判成「重复用了同一句话」。
       */
      const anchors = [strategy.tensionAnchor, strategy.reframeAnchor, strategy.projectBridgeAnchor, strategy.openLoopAnchor]
        .filter((anchor) => anchor.trim());
      if (new Set(anchors).size !== anchors.length) add(index, "marketing_anchor_duplicate", "error", "软营销四个正文锚点必须各自承担不同推进职责，不能重复一句话。");
      const frozenEntryCopy = [n.coverHeadline, n.coverSubheadline, n.title, n.body].join("\n");
      const frozenOpenCopy = [n.body, n.callToAction].join("\n");
      const reframePosition = strategy.reframeAnchor ? n.body.indexOf(strategy.reframeAnchor) : -1;
      const bridgePosition = strategy.projectBridgeAnchor ? n.body.indexOf(strategy.projectBridgeAnchor) : -1;
      /*
       * tensionAnchor 与 openLoopAnchor 两种模式都必需:一篇总得有个切入点和一个
       * 不逼人的收尾,那两条与体裁无关。翻转与承接在素人模式下可以整个不写,
       * 但一旦写了就仍必须逐字落在正文里 —— 可选是「可以不写」,不是「写了可以不落地」。
       */
      const reframeMissing = peerSeeding && !strategy.reframeAnchor.trim() ? false : reframePosition < 0;
      const bridgeMissing = peerSeeding && !strategy.projectBridgeAnchor.trim() ? false : bridgePosition < 0;
      if (!strategy.tensionAnchor || !frozenEntryCopy.includes(strategy.tensionAnchor)
        || reframeMissing || bridgeMissing
        || !strategy.openLoopAnchor || !frozenOpenCopy.includes(strategy.openLoopAnchor)) {
        add(index, "marketing_anchor_missing", "error", peerSeeding
          ? "顾虑入口和开放余味必须逐字落在各自允许的公开文案位置；写了认知翻转或项目承接时，它们也必须逐字出现在正文里。"
          : "顾虑入口、认知翻转、项目承接和开放余味必须逐字落在各自允许的公开文案位置。");
      } else if (reframePosition >= 0 && bridgePosition >= 0 && reframePosition >= bridgePosition) {
        // 顺序只在两个锚点都非空且都能在正文里定位时才检查:缺一个就没有先后可言。
        add(index, "marketing_anchor_order", "error", "正文中的认知翻转必须早于项目承接，不能先卖项目再补判断标准。");
      }
      /*
       * 承接为空时跳过出处检查;非空时**两种模式都照旧要求**与一条引用逐字重叠。
       * 这是本次放开的边界:可选不等于可以无出处地吹。
       */
      if (strategy.projectBridgeAnchor.trim()) {
        const bridgeGrounded = candidate.citations.some((citation) => citation.statement.includes(strategy.projectBridgeAnchor)
          || strategy.projectBridgeAnchor.includes(citation.statement));
        if (!bridgeGrounded) add(index, "marketing_bridge_ungrounded", "error", "项目承接必须与一条逐字证据声明重叠，不能用无引用的泛化卖点承接认知翻转。");
      }
      const normalizedOld = strategy.oldJudgment.replace(/[\s\p{P}\p{S}]+/gu, "");
      const normalizedNew = strategy.newJudgment.replace(/[\s\p{P}\p{S}]+/gu, "");
      /*
       * peer_seeding 下两者**都为空**时不报:那是「这个体裁不需要翻转」。
       * 非空且相同时仍报 —— 写了却没变化是敷衍,和体裁不需要是两件事。
       */
      const judgmentExempt = peerSeeding && !normalizedOld && !normalizedNew;
      if (!judgmentExempt && (!normalizedOld || normalizedOld === normalizedNew)) add(index, "marketing_judgment_unchanged", "error", "种草正文必须完成一次真实的判断变化，不能只换句话重复原认知。");
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
    /*
     * 标签堆品牌词只给 WARNING,不阻断。
     *
     * 依据:67 篇真实对标语料里无一篇标签带品牌名,全是「#成都眼袋」这类品类词加城市词。
     * 品牌词一出现,帖子立刻不像素人发的。
     *
     * 判据拿本轮项目名做子串比对,不维护关键词表 —— 表会过期,而项目名一定是当前的。
     * 用 WARNING 而非 ERROR 的理由:项目名可能恰好含通用品类词(项目就叫「眼袋」的情况),
     * 子串比对会把正常的品类标签误判成品牌堆砌。给提示、让人自己判断,比硬拦误伤更划算。
     *
     * 子串比对的盲点:只能抓到完整包含项目名的标签。项目名叫「星零感微孔去眼袋」时,
     * 单独的「#星零感」不会命中。这是有意保守 —— 与 WARNING 的定位一致:宁可漏报,
     * 不要靠拆词猜简称去误伤正常标签。漏掉的那部分由人工复核兜。
     *
     * `.trim()` 不只是整理空白,它是这里的必要守卫:项目名为 "" 或纯空格时,
     * `tag.includes("")` 对任何字符串都为真,会把每一条标签都标成品牌词。
     * 拿不到有效项目名就整段跳过,不猜。
     *
     * brand_voice 不查:机构以自己的口吻发布时,标签带品牌名是正常且应当的。
     */
    if (peerSeeding && constraints.projectName?.trim()) {
      const projectName = constraints.projectName.trim();
      const branded = candidate.content.H.hashtags.filter((tag) => tag.includes(projectName));
      if (branded.length) {
        add(index, "brand_hashtag", "warning", `标签里出现了项目名（${branded.join("、")}）。素人代发的标签更接近品类词和城市词，品牌词会让帖子显得像官方账号发的。`);
      }
    }
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
    // 逐个说话节点单独匹配:把提问和答复拼成一段会跨边界拼出假时间线
    // (例如「我...?」+「要，...做...」),那是误报。
    const timelineViolation = timelineNodes.some((text) => FIRST_PERSON_TIMELINE.test(text));
    /*
     * 第三方伪造经历:两种模式、全部来源一起查,不受 peerSeeding 豁免。
     * 「我」的时间线可以放开(真人自己的事,自己负责),别人的经历不行 ——
     * 没有任何真人为「我闺蜜做完第二天就上班了」负责,那是伪造社会证明。
     * 同样逐节点判,不拼整段:避免跨说话人拼出假断言。
     */
    const thirdPartyViolation = [...origin.authorOwned, ...origin.restricted]
      .some((text) => hasThirdPartyExperienceClaim(text));
    if (FABRICATED_TESTIMONIAL.test(visible) || timelineViolation || thirdPartyViolation) {
      add(index, "fabricated_experience", "error", peerSeeding
        ? "可见内容出现伪造口碑措辞，或模拟读者声称了未经证实的体验时间线。"
        : "可见内容包含可能伪装真实经历或口碑的措辞。");
    }
    if (PUBLIC_AUDIT_LEAK.test(visible)) add(index, "audit_language_in_public_copy", "error", "公开文案混入了审核、SLA 或发布计划等后台语言，请只保留可直接阅读的成品表达。");
    if (PUBLIC_PLANNING_ARTIFACT.test(visible)) add(index, "planning_language_in_public_copy", "error", "公开文案混入了核验动作、信息边界或认知翻转等内部策划标签，请改成读者会自然说的话。");
    if (PUBLIC_SOURCE_META.test(visible)) add(index, "source_meta_in_public_copy", "error", "公开文案混入了“项目资料/证据”后台口吻，请直接自然表达已支持的项目事实。");
    if (UNSUPPORTED_POPULATION_LANGUAGE.test(visible)) add(index, "unsupported_population_language", "warning", "公开文案使用了“很多人/最怕”等群体判断；没有总体证据时应改成直接问题或有边界的具体顾虑。");
    if (HARD_SELL_LANGUAGE.test(visible)) add(index, "hard_sell_language", "error", "公开文案出现催促、稀缺或强迫成交措辞，不符合软营销边界。");
    const effectiveLength = constraints.bodyLength ?? "medium";
    const bodyChars = [...n.body.replace(/\s+/gu, "")].length;
    const titleChars = [...n.title.replace(/\s+/gu, "")].length;
    if (titleChars > 22) add(index, "title_shape_drift", "warning", "标题明显长于 70 篇参考语料的常见形态，请优先压缩到一个直接钩子。");
    const bodyTarget = HARNESS_BODY_LENGTH_TARGETS[effectiveLength];
    /*
     * 下限按模式取,上限两种模式一致。
     *
     * peer_seeding 用 HARNESS_PEER_BODY_MIN(30)而不是共用常量的 min:实测 67 篇
     * 真实语料正文中位数 74 字,27 篇(40%)短于 short 档的 60 字下限,语料里 36 字
     * 的帖子是常态形态。共用常量不动,brand_voice 的契约因此一个字节没变。
     *
     * 只降下限的理由:上限防的是把评论区该承担的信息(价格、恢复期、麻醉方式)
     * 全塞进正文 —— 那是产出读起来像广告的另一半原因。放宽上限只会让软文更长。
     *
     * `Math.min` 而不是直接取常量:medium/long 档的 min 本就大于 30,直接覆盖会把
     * 长篇的下限也砸到 30。取两者较小值保证只在下限确实更严时才放宽。
     */
    const bodyMin = peerSeeding ? Math.min(bodyTarget.min, HARNESS_PEER_BODY_MIN) : bodyTarget.min;
    if (bodyChars < bodyMin || bodyChars > bodyTarget.max) add(index, "body_shape_drift", "warning", `正文为 ${bodyChars} 字，偏离${effectiveLength === "short" ? "短" : effectiveLength === "medium" ? "中" : "长"}篇 ${bodyMin}—${bodyTarget.max} 字的统一目标。`);
    /*
     * 三条成品形状偏离,只在 peer_seeding 下检查。
     *
     * brand_voice 一条都不加:机构以自己的口吻发布时,讲清判断标准、给核验路径、
     * 用行业标签都是正常且应当的,那边的既有契约一个字节不动。
     */
    if (peerSeeding) {
      const planningHit = PLANNING_VOCABULARY.exec(`${n.title}\n${n.body}`);
      if (planningHit) {
        add(index, "planning_vocabulary_in_copy", "warning", `标题或正文出现了策划口吻的词（${planningHit[0]}）。67 篇真实语料里这类词合计只命中 1 篇，读者一眼能看出是策划出来的，不是随手发的。`);
      }
      // 与语料测量同一套剥离逻辑:先去掉行尾话题标记再判,否则问号会被标签挡住。
      if (READER_QUESTION_ENDING.test(n.body.trim().replace(TRAILING_HASHTAGS, ""))) {
        add(index, "reader_question_ending", "warning", "正文以反问读者收尾。67 篇真实语料里只有 4 篇这么写（6%），而实测生成内容 100% 这么写——这是最容易被认出是生成文案的一处。");
      }
      const industryTags = candidate.content.H.hashtags.filter((tag) => INDUSTRY_HASHTAG.test(tag));
      if (industryTags.length) {
        add(index, "industry_register_hashtag", "warning", `标签用了行业口吻词（${industryTags.join("、")}）。317 个真实标签里 0 个这么用，素人的标签是品类词加城市词加生活词。`);
      }
    }
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
  return issues.map(normalizeHarnessValidationIssue);
}
