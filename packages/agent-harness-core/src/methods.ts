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
  bodyLength: "short" | "medium" | "long";
  bodyRole: string;
  commentRole: string;
  boundaryPolicy: string;
  instructions: readonly string[];
}

export const DEFAULT_HARNESS_METHOD_ID: HarnessMethodId = "balanced_information";

export const HARNESS_METHOD_PROFILES: readonly HarnessMethodProfile[] = Object.freeze([
  {
    id: "real_minimal", label: "真实极简", description: "用一个人物处境和一个窄问题起帖，评论区自然接住细节。",
    noviceExplanation: "适合求助卡和临时发问：正文只说清谁、为什么现在问、最怕什么。",
    audienceStage: "collecting", entryRoute: "recommendation", entryPoint: "推荐流中的真实处境切入", bodyLength: "short",
    bodyRole: "正文只建立一个人物处境、眼前限制和窄问题，不追加科普总结。",
    commentRole: "用不同生活位置的短互动补信息，不把每条回复写成完整 FAQ。",
    boundaryPolicy: "人物处境是创作载体，不得伪装成真实顾客经历。",
    instructions: ["正文只写一个可识别人物处境、一个眼前限制和一个窄问题。", "评论自然接住细节，允许短反应，不机械闭环。"],
  },
  {
    id: "first_research", label: "新手功课", description: "帮助刚开始了解的人建立问题清单和判断顺序。",
    noviceExplanation: "适合还不知道该问什么的读者：先解释问题范围，再建立可执行的判断顺序。",
    audienceStage: "discovering", entryRoute: "search", entryPoint: "新手搜索与初次做功课", bodyLength: "short",
    bodyRole: "正文把模糊担心变成一个最先影响行动的具体问题。",
    commentRole: "由不同身份逐步带出判断顺序、补充问题和下一步。",
    boundaryPolicy: "问题清单是判断辅助，不得包装成统一标准。",
    instructions: ["先帮助新手知道第一件该问什么。", "其余判断顺序放进自然问答，不堆成知识目录。"],
  },
  {
    id: "rational_compare", label: "理性比较", description: "不直接给唯一答案，重点解释方案差异和适用条件。",
    noviceExplanation: "适合已有多个候选方案的读者：先对齐比较口径，再判断什么条件下各自更合适。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "搜索中的方案比较", bodyLength: "medium",
    bodyRole: "正文说明已经比较过什么、卡在哪个差异、最在意什么。",
    commentRole: "把条件差异、经验分歧和反例拆到不同问答节点。",
    boundaryPolicy: "不替读者给唯一答案，适用性和取舍必须保留条件。",
    instructions: ["先对齐比较口径，再解释差异。", "不同经验和反例进入评论，不在正文伪造完整比较结论。"],
  },
  {
    id: "hesitation_completion", label: "犹豫补全", description: "承认不确定性，优先补风险、边界和下一步信息。",
    noviceExplanation: "适合已经有倾向但仍担心选错的读者：不催决定，先补齐会改变选择的信息。",
    audienceStage: "hesitating", entryRoute: "recommendation", entryPoint: "推荐流中的犹豫与复查", bodyLength: "short",
    bodyRole: "正文用具体时点和生活限制表现犹豫，不写成风险清单。",
    commentRole: "安排支持、反例和一个可行动承接，让读者看见分歧。",
    boundaryPolicy: "不利用焦虑催促行动；风险、未知和下一步核验必须可见。",
    instructions: ["承认不确定性，不催决定。", "优先补会改变选择的风险、边界和下一步信息。"],
  },
  {
    id: "local_choice", label: "本地选择", description: "面向已准备行动的用户，补全城市、人物和筛选依据。",
    noviceExplanation: "适合准备筛选本地对象或服务者的读者：把地点和对象线索变成可核验的行动路径。",
    audienceStage: "ready", entryRoute: "profile", entryPoint: "主页或本地行动前复查", bodyLength: "short",
    bodyRole: "正文建立正在安排时间、地点或对象筛选的行动场景。",
    commentRole: "自然追问对象、地点、时间安排和选择理由。",
    boundaryPolicy: "地点、人物和服务信息只能来自本轮证据；缺失时保持未知。",
    instructions: ["把本地信息变成可核验的筛选路径。", "不得编造城市、门店、人员资质、档期或服务承诺。"],
  },
  {
    id: "balanced_information", label: "均衡信息补全", description: "正文保留共同主线，评论展开条件分支。",
    noviceExplanation: "不知道怎么选时用它：先写清大家都要知道的，再把因人而异的问题放进问答。",
    recommended: true, audienceStage: "collecting", entryRoute: "search", entryPoint: "搜索与常规信息收集", bodyLength: "medium",
    bodyRole: "正文先让场景、共同主线和一个窄问题成立。",
    commentRole: "在短问短答、经验差异、条件分支和边界之间保持平衡。",
    boundaryPolicy: "共同事实进入正文，个体分支不被写成统一答案。",
    instructions: ["正文只承担共同主线。", "因人而异的条件、追问和边界交给评论展开。"],
  },
  {
    id: "search_decision", label: "搜索决策补全", description: "主动搜索/比较，直接答疑、依据和经验方法。",
    noviceExplanation: "读者已经在找答案时，用清楚的判断办法减少他继续来回搜索。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "主动搜索与决策答疑", bodyLength: "medium",
    bodyRole: "标题命中搜索问题，正文给出判断办法和最关键依据。",
    commentRole: "依据、条件和经验方法由不同节点补充，避免一个账号包办全部信息。",
    boundaryPolicy: "搜索命中不等于平台触达保证；经验方法不能冒充项目事实。",
    instructions: ["直接回应搜索问题，但不要写成知识库目录。", "用不同问答节点补依据与条件。"],
  },
  {
    id: "minimal_body_conditional_comments", label: "短正文＋条件问答", description: "正文保持最小充分，评论承担可查找的长尾分支。",
    noviceExplanation: "适合正文只讲主线、不同人答案不同的主题；短不等于空。",
    audienceStage: "collecting", entryRoute: "recommendation", entryPoint: "推荐流中的短正文入口", bodyLength: "short",
    bodyRole: "正文只留下一个能被评论自然接住的具体问题，不做答案摘要。",
    commentRole: "用条件问答、短反应和经验冲突逐层补全长尾分支。",
    boundaryPolicy: "安全和决策必需信息不能为了短而隐藏；模拟互动必须披露。",
    instructions: ["正文保持最小充分，不做答案总表。", "评论承担条件分支，但不制造虚假口碑。"],
  },
  {
    id: "comparison_framework", label: "比较核验清单", description: "把模糊纠结变成可比较条件和筛选步骤。",
    noviceExplanation: "适合“怎么选、选谁、去哪做”这类问题，重点是教会读者比较。",
    audienceStage: "comparing", entryRoute: "search", entryPoint: "搜索中的比较与筛选", bodyLength: "medium",
    bodyRole: "正文说明比较到哪一步、卡住哪一项，并给出少量核心维度。",
    commentRole: "用不同条件、反例和追问逐步显出完整比较框架。",
    boundaryPolicy: "核验清单不能把不确定关系伪装成统一评分或合格线。",
    instructions: ["把比较框架放进真实纠结，而不是参数表。", "每个比较项写清对象、动作和边界。"],
  },
  {
    id: "state_experience_entry", label: "状态/经历入口", description: "用有依据的状态和生活线索建立相关性，再进入判断信息。",
    noviceExplanation: "适合从“我正处在哪一步、生活哪里受影响”切入，但不能编第一人称经历。",
    audienceStage: "discovering", entryRoute: "recommendation", entryPoint: "推荐流中的状态与生活线索", bodyLength: "medium",
    bodyRole: "正文用普通生活瞬间承载主题，再进入一个判断问题。",
    commentRole: "用身份关系和自然接话补充状态差异与行动条件。",
    boundaryPolicy: "场景只是创作载体；不得编造第一人称经历、顾客反馈或真实互动。",
    instructions: ["用生活线索建立相关性，但只采用证据支持的状态。", "人物时序、动作和评论关系必须自洽。"],
  },
] satisfies readonly HarnessMethodProfile[]);

const METHOD_BY_ID = new Map(HARNESS_METHOD_PROFILES.map((profile) => [profile.id, profile]));

export function isHarnessMethodId(value: unknown): value is HarnessMethodId {
  return typeof value === "string" && METHOD_BY_ID.has(value as HarnessMethodId);
}

export function getHarnessMethodProfile(id: HarnessMethodId = DEFAULT_HARNESS_METHOD_ID): HarnessMethodProfile {
  return METHOD_BY_ID.get(id)!;
}
