export type HarnessMethodId =
  | "real_minimal"
  | "first_research"
  | "rational_compare"
  | "hesitation_completion"
  | "local_choice"
  | "balanced_information"
  | "search_decision"
  | "minimal_body_conditional_comments"
  | "comparison_framework"
  | "state_experience_entry";

export type HarnessAudienceStage = "collecting" | "discovering" | "comparing" | "hesitating" | "ready";
export type HarnessEntryRoute = "search" | "recommendation" | "profile";
export type HarnessBodyLength = "short" | "medium" | "long";

/**
 * 内容形态模式。
 *
 * `peer_seeding`(默认):素人代发种草。内容由真人素人账号发布、经历真实,AI 只是
 * 代笔起草,所以允许第一人称时间线叙述,评论区以博主本人回复为主。
 * `brand_voice`:机构口吻。保留原有全部严格校验——机构不能假装自己是顾客。
 */
export type HarnessSeedingMode = "peer_seeding" | "brand_voice";

/** One authoritative body-length contract shared by prompts and validation. */
export const HARNESS_BODY_LENGTH_TARGETS: Readonly<Record<HarnessBodyLength, Readonly<{ min: number; max: number }>>> = Object.freeze({
  short: Object.freeze({ min: 60, max: 140 }),
  medium: Object.freeze({ min: 120, max: 260 }),
  long: Object.freeze({ min: 240, max: 500 }),
});

/**
 * A browser-safe, auditable translation of the ten established generation methods.
 * It carries semantic responsibilities, not the legacy parameter engine or planning chain.
 */
export interface HarnessMethodProfile {
  id: HarnessMethodId;
  label: string;
  description: string;
  noviceExplanation: string;
  recommended?: boolean;
  audienceStage: HarnessAudienceStage;
  entryRoute: HarnessEntryRoute;
  entryPoint: string;
  bodyLength: HarnessBodyLength;
  bodyRole: string;
  commentRole: string;
  boundaryPolicy: string;
  instructions: readonly string[];
  /** How this format advances reader intent without becoming a hard sell. */
  persuasionRole: string;
  /** Marketing is allowed, but must remain accountable and non-coercive. */
  softMarketingBoundary: string;
}

export const DEFAULT_HARNESS_METHOD_ID: HarnessMethodId = "state_experience_entry";

/**
 * 默认走素人代发。
 *
 * 这个通道的实际用途是给真人素人账号起草代发内容,默认关掉会让每次运行都要手动
 * 勾选。默认开,但保留 brand_voice 这条路——通道里有 brand 发布身份和偏机构口吻
 * 的写法,那些用法不该被强制伪造成素人。
 */
export const DEFAULT_HARNESS_SEEDING_MODE: HarnessSeedingMode = "peer_seeding";

export const HARNESS_METHOD_PROFILES: readonly HarnessMethodProfile[] = Object.freeze([
  {
    id: "real_minimal", label: "真实极简", description: "用一个人物处境和一个窄问题起帖，评论区自然接住细节。",
    noviceExplanation: "适合求助卡和临时发问：正文只说清谁、为什么现在问、最怕什么。",
    audienceStage: "collecting", entryRoute: "recommendation", entryPoint: "推荐流中的真实处境切入", bodyLength: "short",
    bodyRole: "正文只建立一个人物处境、眼前限制和窄问题，不追加科普总结。",
    commentRole: "用不同生活位置的短互动补信息，不把每条回复写成完整 FAQ。",
    boundaryPolicy: "人物处境是创作载体，不得伪装成真实顾客经历。",
    instructions: ["正文只写一个可识别人物处境、一个眼前限制和一个窄问题。", "评论自然接住细节，允许短反应，不机械闭环。"],
    persuasionRole: "用处境让读者认出自己，再用一个更好的判断把项目价值留在心里。",
    softMarketingBoundary: "不能把虚构人物处境伪装成真实口碑，也不能用焦虑逼迫行动。",
  },
  {
    id: "first_research", label: "新手功课", description: "帮助刚开始了解的人建立问题清单和判断顺序。",
    noviceExplanation: "适合还不知道该问什么的读者：先解释问题范围，再建立可执行的判断顺序。",
    audienceStage: "discovering", entryRoute: "search", entryPoint: "新手搜索与初次做功课", bodyLength: "short",
    bodyRole: "正文把模糊担心变成一个最先影响行动的具体问题。",
    commentRole: "由不同身份逐步带出判断顺序、补充问题和下一步。",
    boundaryPolicy: "问题清单是判断辅助，不得包装成统一标准。",
    instructions: ["先帮助新手知道第一件该问什么。", "其余判断顺序放进自然问答，不堆成知识目录。"],
    persuasionRole: "把“我不知道怎么选”推进为“我知道先看哪个判断，并愿意继续了解承接它的项目”。",
    softMarketingBoundary: "不能把知识目录当种草，也不能用唯一标准替用户做决定。",
  },
  {
    id: "rational_compare", label: "理性比较", description: "不直接给唯一答案，重点解释方案差异和适用条件。",
    noviceExplanation: "适合已有多个候选方案的读者：先对齐比较口径，再判断什么条件下各自更合适。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "搜索中的方案比较", bodyLength: "medium",
    bodyRole: "正文说明已经比较过什么、卡在哪个差异、最在意什么。",
    commentRole: "把条件差异、经验分歧和反例拆到不同问答节点。",
    boundaryPolicy: "不替读者给唯一答案，适用性和取舍必须保留条件。",
    instructions: ["先对齐比较口径，再解释差异。", "不同经验和反例进入评论，不在正文伪造完整比较结论。"],
    persuasionRole: "让读者从比参数转向比适配逻辑，再自然看见项目差异。",
    softMarketingBoundary: "不能贬低竞品、伪造对比结论或把条件差异写成绝对优越。",
  },
  {
    id: "hesitation_completion", label: "犹豫补全", description: "承认不确定性，优先补风险、边界和下一步信息。",
    noviceExplanation: "适合已经有倾向但仍担心选错的读者：不催决定，先补齐会改变选择的信息。",
    audienceStage: "hesitating", entryRoute: "recommendation", entryPoint: "推荐流中的犹豫与复查", bodyLength: "short",
    bodyRole: "正文用具体时点和生活限制表现犹豫，不写成风险清单。",
    commentRole: "安排支持、反例和一个可行动承接，让读者看见分歧。",
    boundaryPolicy: "不利用焦虑催促行动；风险、未知和下一步核验必须可见。",
    instructions: ["承认不确定性，不催决定。", "优先补会改变选择的风险、边界和下一步信息。"],
    persuasionRole: "接住临门一脚的真实顾虑，用一个认知翻转降低决策摩擦。",
    softMarketingBoundary: "不能放大恐惧、制造稀缺或用风险焦虑催促成交。",
  },
  {
    id: "local_choice", label: "本地选择", description: "面向已准备行动的用户，补全城市、人物和筛选依据。",
    noviceExplanation: "适合准备筛选本地对象或服务者的读者：把地点和对象线索变成可核验的行动路径。",
    audienceStage: "ready", entryRoute: "profile", entryPoint: "主页或本地行动前复查", bodyLength: "short",
    bodyRole: "正文建立正在安排时间、地点或对象筛选的行动场景。",
    commentRole: "自然追问对象、地点、时间安排和选择理由。",
    boundaryPolicy: "地点、人物和服务信息只能来自本轮证据；缺失时保持未知。",
    instructions: ["把本地信息变成可核验的筛选路径。", "不得编造城市、门店、人员资质、档期或服务承诺。"],
    persuasionRole: "把行动欲望转成可核验选择，让项目成为值得进入下一步的对象。",
    softMarketingBoundary: "不能编造本地热度、档期、到店经历或人员背书。",
  },
  {
    id: "balanced_information", label: "均衡信息补全", description: "正文保留共同主线，评论展开条件分支。",
    noviceExplanation: "不知道怎么选时用它：先写清大家都要知道的，再把因人而异的问题放进问答。",
    audienceStage: "collecting", entryRoute: "search", entryPoint: "搜索与常规信息收集", bodyLength: "medium",
    bodyRole: "正文先让场景、共同主线和一个窄问题成立。",
    commentRole: "在短问短答、经验差异、条件分支和边界之间保持平衡。",
    boundaryPolicy: "共同事实进入正文，个体分支不被写成统一答案。",
    instructions: ["正文只承担共同主线。", "因人而异的条件、追问和边界交给评论展开。"],
    persuasionRole: "用共同欲望建立主线，再让项目差异承接一个新的判断标准。",
    softMarketingBoundary: "不能平均堆卖点或把因人而异的信息包装成统一结果。",
  },
  {
    id: "search_decision", label: "搜索决策补全", description: "主动搜索/比较，直接答疑、依据和经验方法。",
    noviceExplanation: "读者已经在找答案时，用清楚的判断办法减少他继续来回搜索。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "主动搜索与决策答疑", bodyLength: "medium",
    bodyRole: "标题命中搜索问题，正文给出判断办法和最关键依据。",
    commentRole: "依据、条件和经验方法由不同节点补充，避免一个账号包办全部信息。",
    boundaryPolicy: "搜索命中不等于平台触达保证；经验方法不能冒充项目事实。",
    instructions: ["直接回应搜索问题，但不要写成知识库目录。", "用不同问答节点补依据与条件。"],
    persuasionRole: "先回答搜索意图，再用关键判断让项目在比较中自然占位。",
    softMarketingBoundary: "不能关键词堆砌、硬插品牌或把搜索命中写成效果承诺。",
  },
  {
    id: "minimal_body_conditional_comments", label: "短正文＋条件问答", description: "正文保持最小充分，评论承担可查找的长尾分支。",
    noviceExplanation: "适合正文只讲主线、不同人答案不同的主题；短不等于空。",
    audienceStage: "collecting", entryRoute: "recommendation", entryPoint: "推荐流中的短正文入口", bodyLength: "short",
    bodyRole: "正文只留下一个能被评论自然接住的具体问题，不做答案摘要。",
    commentRole: "用条件问答、短反应和经验冲突逐层补全长尾分支。",
    boundaryPolicy: "安全和决策必需信息不能为了短而隐藏；模拟互动必须披露。",
    instructions: ["正文保持最小充分，不做答案总表。", "评论承担条件分支，但不制造虚假口碑。"],
    persuasionRole: "正文只种下一个值得记住的判断，评论继续降低具体顾虑。",
    softMarketingBoundary: "不能用空洞悬念诱导互动，也不能在评论伪造口碑。",
  },
  {
    id: "comparison_framework", label: "比较核验清单", description: "把模糊纠结变成可比较条件和筛选步骤。",
    noviceExplanation: "适合“怎么选、选谁、去哪做”这类问题，重点是教会读者比较。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "搜索中的比较与筛选", bodyLength: "medium",
    bodyRole: "正文说明比较到哪一步、卡住哪一项，并给出少量核心维度。",
    commentRole: "用不同条件、反例和追问逐步显出完整比较框架。",
    boundaryPolicy: "核验清单不能把不确定关系伪装成统一评分或合格线。",
    instructions: ["把比较框架放进真实纠结，而不是参数表。", "每个比较项写清对象、动作和边界。"],
    persuasionRole: "让读者换一套比较标准，并理解项目为何在该标准下值得继续看。",
    softMarketingBoundary: "不能做伪客观评分、踩一捧一或把项目参数堆成硬广。",
  },
  {
    id: "state_experience_entry", label: "状态/经历入口", description: "用有依据的状态和生活线索建立相关性，再进入判断信息。",
    noviceExplanation: "适合从“我正处在哪一步、生活哪里受影响”切入，但不能编第一人称经历。",
    recommended: true, audienceStage: "discovering", entryRoute: "recommendation", entryPoint: "推荐流中的状态与生活线索", bodyLength: "medium",
    bodyRole: "正文由真实发布账号从一个具体顾虑或生活观察切入，集中讲透一个项目价值点，短而有现场感。",
    commentRole: "用自然短问短答补充条件差异、证据边界与下一步，不把正文复述成 FAQ。",
    boundaryPolicy: "场景只能由发布账号观察或提问承载；不得编造第一人称体验、顾客反馈、朋友案例或真实互动。",
    instructions: ["用一个真实顾虑或生活观察建立相关性，在本轮所选篇幅内讲透一个证据支持的价值点。", "先接顾虑再讲项目差异，避免清单、教程、论文或合规说明书语气。"],
    persuasionRole: "从读者想要的生活结果和未说出口的顾虑切入，完成一次认知翻转，再让项目差异成为顺理成章的承接。",
    softMarketingBoundary: "不得冒充用户亲历；不得开头即报品牌卖点；不得用焦虑、保证、热度或虚假口碑推进转化。",
  },
] satisfies readonly HarnessMethodProfile[]);

const METHOD_BY_ID = new Map(HARNESS_METHOD_PROFILES.map((profile) => [profile.id, profile]));

export function isHarnessMethodId(value: unknown): value is HarnessMethodId {
  return typeof value === "string" && METHOD_BY_ID.has(value as HarnessMethodId);
}

export function getHarnessMethodProfile(id: HarnessMethodId = DEFAULT_HARNESS_METHOD_ID): HarnessMethodProfile {
  return METHOD_BY_ID.get(id)!;
}
