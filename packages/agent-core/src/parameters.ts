import { createHash } from "node:crypto";
import {
  evaluateFormulaDefinition,
  F32_DIAGNOSTIC_CONTRACT,
  F33_DIAGNOSTIC_CONTRACT,
  resolveFormulaExecution,
} from "./formula.js";
import type {
  BodyDiagnosticDimension,
  BuiltInGenerationPreset,
  BuiltInStyleProfile,
  ChannelInformationAllocation,
  CommentDiagnosticDimension,
  ConfirmedSampleBaseline,
  ContentChannel,
  ContentDiagnostic,
  DiagnosticProxyComponent,
  DiagnosticProxyReport,
  FormulaDiagnosticContract,
  FormulaPrimitive,
  FormulaVersion,
  GenerationMethodParameters,
  GenerationParameterDefinition,
  GenerationParameterSelection,
  ParameterCompilationResult,
  ParameterImpactReport,
  ParameterImpactTrace,
  ParameterResolutionSnapshot,
  ParameterValue,
  ParameterValueSource,
  ResolvedGenerationConfig,
} from "./types.js";

const BODY_DIMENSIONS = F32_DIAGNOSTIC_CONTRACT.componentDefinitions.map(({ id, label, direction }) => ({ id, label, direction })) as Array<{
  id: BodyDiagnosticDimension; label: string; direction: DiagnosticProxyComponent["direction"];
}>;

const COMMENT_DIMENSIONS = F33_DIAGNOSTIC_CONTRACT.componentDefinitions.map(({ id, label, direction }) => ({ id, label, direction })) as Array<{
  id: CommentDiagnosticDimension; label: string; direction: DiagnosticProxyComponent["direction"];
}>;

function recordOf<Id extends string>(items: Array<{ id: Id }>, value: number): Record<Id, number> {
  return Object.fromEntries(items.map((item) => [item.id, value])) as Record<Id, number>;
}

export const DEFAULT_METHOD_PARAMETERS: GenerationMethodParameters = {
  informationBreadth: 65,
  decisionInformationDepth: 70,
  stateInformationStrength: 75,
  experienceInformationStrength: 72,
  bodyCompleteness: 42,
  commentExpansion: 70,
  commentConditionality: 75,
  commentRoleDiversity: 85,
  commentConstraintDensity: 55,
  commentGapMultiplexing: 55,
  commentReplyIncrement: 58,
  questionCompression: 78,
  commentPlatformRegister: 68,
  commentConversationRate: 48,
  commentBranchingStrength: 62,
  commentOrganicVariation: 58,
  commentDiscoveryStrength: 72,
  commentInferenceEffort: 35,
  commentSelfVerification: 70,
  commentFalseClosureGuard: 95,
  redundancyTolerance: 20,
  evidenceStrictness: 90,
  boundaryVisibility: 90,
  routeSpecificity: 65,
  noveltyAngle: 45,
  questionNaturalness: 75,
  titleTargetChars: 9,
  paragraphTarget: 2,
  bodyDiagnosticEmphasis: recordOf(BODY_DIMENSIONS, 50),
  commentDiagnosticEmphasis: recordOf(COMMENT_DIMENSIONS, 50),
};

const audienceOptions = [
  { value: "discovering", label: "刚发现问题", description: "用户刚意识到需求，先帮助命名问题。" },
  { value: "collecting", label: "正在收集信息", description: "用户在补资料和建立判断框架。" },
  { value: "comparing", label: "正在比较", description: "用户在比较方案、地点或服务者。" },
  { value: "hesitating", label: "正在犹豫", description: "用户已有候选，但风险或条件尚未闭合。" },
  { value: "ready", label: "准备行动", description: "用户需要核实行动条件与下一步。" },
];

const entryOptions = [
  { value: "search", label: "搜索", description: "读者主动带着问题进入。" },
  { value: "recommendation", label: "推荐流", description: "读者先被入口吸引，再判断是否相关。" },
  { value: "profile", label: "主页", description: "读者已有账号或项目上下文。" },
  { value: "return_visit", label: "再次访问", description: "读者已经接触过部分信息。" },
];

function slider(
  id: string,
  path: string,
  label: string,
  group: GenerationParameterDefinition["group"],
  noviceExplanation: string,
  increaseEffect: string,
  decreaseEffect: string,
  formulaIds: GenerationParameterDefinition["formulaIds"],
  channels: ContentChannel[],
  evidenceStatus: GenerationParameterDefinition["evidenceStatus"],
  evidenceNote: string,
  defaultValue = 50,
  unit = "%",
): GenerationParameterDefinition {
  return {
    id,
    path,
    label,
    group,
    control: { kind: "slider", min: 0, max: 100, step: 1, unit, simpleMode: false, advanced: true },
    defaultValue,
    noviceExplanation,
    increaseEffect,
    decreaseEffect,
    formulaIds,
    channels,
    evidenceStatus,
    evidenceNote,
  };
}

const CORE_PARAMETERS: GenerationParameterDefinition[] = [
  {
    id: "audience_stage", path: "task.audienceStage", label: "用户决策阶段", group: "reader",
    control: { kind: "select", options: audienceOptions, simpleMode: true, advanced: false }, defaultValue: "collecting",
    noviceExplanation: "不是给用户贴永久人设，而是说明他看到内容前正走到哪一步。",
    increaseEffect: "阶段越接近行动，越应补行动条件、风险和下一步。", decreaseEffect: "阶段越靠前，越应先解释问题和判断框架。",
    changeEffect: "切换阶段会同时改变标题承诺、正文主线和评论区问题。", formulaIds: ["F12", "F13", "F24"],
    channels: ["N.title", "N.body", "Cref"], evidenceStatus: "hypothesis", evidenceNote: "读者状态是条件化潜变量，当前没有平台级分布。",
  },
  {
    id: "entry_route", path: "task.entry", label: "内容入口", group: "reader",
    control: { kind: "select", options: entryOptions, simpleMode: true, advanced: false }, defaultValue: "search",
    noviceExplanation: "同一个人从搜索、推荐流或主页进入，最先需要看懂的信息不同。",
    increaseEffect: "主动入口更强调直接答题和可查找性。", decreaseEffect: "被动入口更强调先建立相关性。",
    changeEffect: "切换入口会改变标签路由、标题预览和开头方式。", formulaIds: ["F12", "F19", "F20", "F24"],
    channels: ["H", "N.imageBrief", "N.title", "N.body"], evidenceStatus: "architecture_definition", evidenceNote: "入口条件化是设计变量，不代表已知推荐机制。",
  },
  {
    id: "information_gaps", path: "informationWindow.gaps", label: "要补的信息缺口", group: "information",
    control: { kind: "text_list", placeholder: "例如：怎样判断是否适合自己", simpleMode: true, advanced: false }, defaultValue: [],
    noviceExplanation: "先列用户真正缺什么，再决定写在哪，不是先想漂亮句子。",
    increaseEffect: "增加缺口会扩大候选信息面，但也增加筛选与阅读成本。", decreaseEffect: "减少缺口会更聚焦，但可能漏掉决策必要条件。",
    formulaIds: ["F04", "F06", "F09", "F26"], channels: ["N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "缺口清单是生产对象；具体缺口是否重要仍需项目知识。",
  },
  {
    id: "information_boundaries", path: "informationWindow.boundaries", label: "结论适用边界", group: "evidence",
    control: { kind: "text_list", placeholder: "例如：具体条件需向可追责来源核实", simpleMode: false, advanced: true }, defaultValue: [],
    noviceExplanation: "告诉读者这句话在什么条件下才成立，以及哪里还不能确定。",
    increaseEffect: "增加边界能减少误解，但表达会更长。", decreaseEffect: "减少边界会更利落，但更容易制造错误确定感。",
    formulaIds: ["F04", "F06", "F14", "F25"], channels: ["N.body", "Cref"], evidenceStatus: "normative_boundary", evidenceNote: "关键边界不可被效果目标抵消。",
  },
  {
    id: "expression_voice", path: "expressionWindow.voice", label: "表达口吻", group: "expression",
    control: { kind: "text", placeholder: "自然、克制、可核验", simpleMode: false, advanced: true }, defaultValue: "自然、克制、可核验",
    noviceExplanation: "规定这个人物怎样说话；它必须和身份、事件、关系及当前情绪一致。",
    increaseEffect: "更鲜明的口吻会增加辨识度，也可能增加广告感。", decreaseEffect: "更中性的口吻更稳妥，但可能缺少记忆点。",
    formulaIds: ["F05", "F25", "F32"], channels: ["N.title", "N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "口吻属于表达窗口；效果方向未标定。",
  },
  {
    id: "body_min_chars", path: "content.bodyMinChars", label: "正文最少字数", group: "channel",
    control: { kind: "number", min: 0, max: 5000, step: 10, unit: "字", simpleMode: false, advanced: true }, defaultValue: 100,
    noviceExplanation: "只控制长度下限，不代表写到这个长度就有信息。",
    increaseEffect: "提高下限会容纳更多解释，也会增加阅读成本。", decreaseEffect: "降低下限会更像短说明，但必须保留最小充分信息。",
    formulaIds: ["F17", "F18", "F32"], channels: ["N.body"], evidenceStatus: "operational_default", evidenceNote: "字数是约束，不是质量或平台规律。",
  },
  {
    id: "body_max_chars", path: "content.bodyMaxChars", label: "正文最多字数", group: "channel",
    control: { kind: "number", min: 1, max: 10000, step: 10, unit: "字", simpleMode: false, advanced: true }, defaultValue: 280,
    noviceExplanation: "给正文设上限，迫使内容区分主线与条件分支。",
    increaseEffect: "提高上限允许更完整解释，也更容易堆积信息。", decreaseEffect: "降低上限要求更强取舍，不能删掉关键风险。",
    formulaIds: ["F09", "F17", "F32"], channels: ["N.body"], evidenceStatus: "operational_default", evidenceNote: "上限是生产约束，不是成功阈值。",
  },
  {
    id: "hashtag_count_min", path: "content.hashtagMin", label: "标签数量下限", group: "channel",
    control: { kind: "number", min: 0, max: 30, step: 1, unit: "个", simpleMode: false, advanced: true }, defaultValue: 4,
    noviceExplanation: "标签用于表达主题、地点或人群线索，不是流量咒语。",
    increaseEffect: "增加标签可能覆盖更多路由线索，也会增加噪声和错位。", decreaseEffect: "减少标签更聚焦，但可能缺少必要入口说明。",
    formulaIds: ["F19", "F20", "F31"], channels: ["H"], evidenceStatus: "unvalidated_proxy", evidenceNote: "没有平台全量搜索或推荐数据，数量效果未知；标签数量不是 TrendFit 输入。",
  },
  {
    id: "hashtag_count_max", path: "content.hashtagMax", label: "标签数量上限", group: "channel",
    control: { kind: "number", min: 0, max: 30, step: 1, unit: "个", simpleMode: false, advanced: true }, defaultValue: 8,
    noviceExplanation: "限制标签堆叠，优先保留与任务真正相关的词。",
    increaseEffect: "提高上限允许更多路由尝试，但相关性风险上升。", decreaseEffect: "降低上限促使聚焦，但需保留主题和地域等关键线索。",
    formulaIds: ["F20", "F31"], channels: ["H"], evidenceStatus: "unvalidated_proxy", evidenceNote: "热点和标签收益是时变外部输入；标签上限不是 TrendFit 或触达公式。",
  },
  {
    id: "comment_thread_min", path: "content.commentThreadMin", label: "问答线程下限", group: "channel",
    control: { kind: "number", min: 0, max: 30, step: 1, unit: "条", simpleMode: false, advanced: true }, defaultValue: 3,
    noviceExplanation: "这里控制根评论分支，不是评论总行数；短反应、回复和追问会在分支内自然展开。",
    increaseEffect: "增加线程可覆盖更多条件分支，也会增加打开和查找成本。", decreaseEffect: "减少线程更易查找，但可能漏掉长尾问题。",
    formulaIds: ["F09", "F10", "F22", "F33"], channels: ["Cref"], evidenceStatus: "operational_default", evidenceNote: "现有数据不支持条数越多越好。",
  },
  {
    id: "comment_thread_max", path: "content.commentThreadMax", label: "问答线程可读性目标", group: "channel",
    control: { kind: "number", min: 0, max: 50, step: 1, unit: "条", simpleMode: false, advanced: true }, defaultValue: 6,
    noviceExplanation: "这是期望的可读线程数量，不是截断缺口的硬上限；闭合主缺口需要更多线程时系统会扩容并警告。",
    increaseEffect: "提高目标能容纳更多独立主问题，但不等于更高质量。", decreaseEffect: "降低目标会更紧凑；系统仍不会静默删除未闭合缺口。",
    formulaIds: ["F10", "F22", "F33"], channels: ["Cref"], evidenceStatus: "operational_default", evidenceNote: "数量与高低分在现有样本中区分度很弱。",
  },
  {
    id: "follow_up_depth", path: "content.followUpDepth", label: "追问深度", group: "channel",
    control: { kind: "number", min: 0, max: 6, step: 1, unit: "轮", simpleMode: false, advanced: true }, defaultValue: 2,
    noviceExplanation: "第一次回答后仍有条件没说清时，再追问；不是为了制造热闹。",
    increaseEffect: "增加深度有利于暴露条件和反例，也提高阅读成本。", decreaseEffect: "减少深度更简洁，但第一次回答必须足够直接。",
    formulaIds: ["F09", "F10", "F33"], channels: ["Cref"], evidenceStatus: "architecture_definition", evidenceNote: "追问用于残余缺口展开，效果权重未标定。",
  },
  slider("information_breadth", "parameters.informationBreadth", "信息窗口广度", "information", "先看见多少种有价值的缺口，再筛掉无关和不可答的。", "提高会扩大缺口候选面，但必须加强证据与优先级筛选。", "降低会聚焦最重要问题，但可能漏掉用户不知道该问的事。", ["F04", "F06", "F26", "F28"], ["N.body", "Cref"], "architecture_definition", "两窗口是生产坐标系；更多信息不保证更好。", DEFAULT_METHOD_PARAMETERS.informationBreadth),
  slider("decision_information_depth", "parameters.decisionInformationDepth", "决策信息深度", "information", "答案是否进一步给出依据、判断办法和适用条件。", "提高会补更多判断依据和可复用方法，也增加篇幅。", "降低会更偏状态表达，但可能无法帮助比较。", ["F04", "F15", "F17", "F32"], ["N.body", "Cref"], "normative_boundary", "用户价值以减少错误决策损失为方向，具体权重未知。", DEFAULT_METHOD_PARAMETERS.decisionInformationDepth),
  slider("state_information_strength", "parameters.stateInformationStrength", "人物处境可见度", "information", "让人从几个词看出是谁、处在哪一步、为什么现在开口。", "提高会强化身份、关系、阶段和限制，但应通过动作和口吻体现，不列标签。", "降低只保留一个必要身份线索，更适合极短打卡。", ["F12", "F13", "F32"], ["N.title", "N.body", "Cref"], "hypothesis", "样本常出现状态信息，但具体效果尚未验证。", DEFAULT_METHOD_PARAMETERS.stateInformationStrength),
  slider("experience_information_strength", "parameters.experienceInformationStrength", "生活事件承载强度", "information", "控制正文用多少时间、地点、动作、摩擦和情绪余味来承载主题。", "提高会形成更完整的生活切片；人物时序必须自洽，创作场景不能当项目证据。", "降低只保留一个微动作或现场痕迹。", ["F07", "F13", "F32"], ["N.imageBrief", "N.body"], "hypothesis", "生活化是样本形态观察，不代表虚构细节越多越真实。", DEFAULT_METHOD_PARAMETERS.experienceInformationStrength),
  slider("body_completeness", "parameters.bodyCompleteness", "正文主线完整度", "channel", "决定多少共同前提和关键答案直接放正文，多少条件分支留给评论问答。", "提高会把更多共同答案前置，降低评论打开依赖。", "降低会让正文更轻，但仍必须满足最小充分和风险边界。", ["F04", "F09", "F17", "F32"], ["N.body", "Cref"], "architecture_definition", "通道分工是架构，不是短正文必然更好的规律。", DEFAULT_METHOD_PARAMETERS.bodyCompleteness),
  slider("comment_expansion", "parameters.commentExpansion", "评论区展开力度", "channel", "把正文后的条件问题展开成可查找的问答线程。", "提高会展开更多残余缺口和下一步，也增加杂乱成本。", "降低会保留少量高优先级问答。", ["F09", "F10", "F22", "F23", "F33"], ["Cref"], "hypothesis", "评论常出现新增话题是样本观察，不证明打开或转化效果。", DEFAULT_METHOD_PARAMETERS.commentExpansion),
  slider("comment_conditionality", "parameters.commentConditionality", "条件化回答程度", "channel", "答案依赖个人条件时先澄清，而不是给所有人同一个结论。", "提高会增加澄清问题、分支和边界。", "降低会更直接，但更容易过度概括。", ["F10", "F13", "F22", "F33"], ["Cref"], "normative_boundary", "条件化用于防止错误外推。", DEFAULT_METHOD_PARAMETERS.commentConditionality),
  slider("comment_role_diversity", "parameters.commentRoleDiversity", "评论人物与关系丰富度", "channel", "交叉控制评论者的身份位置、与楼主关系、现场、动机、已知范围和说话习惯。", "提高会加入同需求者、经验碎片、反例、同城追问、共鸣者和服务承接等不同节点。", "降低会集中在少数关系，适合窄主题，但要避免所有人同一种FAQ腔。", ["F10", "F12", "F13", "F33"], ["Cref"], "architecture_definition", "角色差异是表达结构，不代表生成了真实多人证据。", DEFAULT_METHOD_PARAMETERS.commentRoleDiversity),
  slider("comment_constraint_density", "parameters.commentConstraintDensity", "现实约束密度", "channel", "每个问题带入多少个由任务或资料支持、确实会改变答案的限制条件。", "提高会让问题更贴近具体决策，但只能使用已提供的边界与条件。", "降低会让问题更通用、更短，但条件分支可能不够清楚。", ["F04", "F10", "F13", "F22"], ["Cref"], "normative_boundary", "约束只能来自已披露信息，不能为增加真实感而编造。", DEFAULT_METHOD_PARAMETERS.commentConstraintDensity),
  slider("comment_gap_multiplexing", "parameters.commentGapMultiplexing", "单问缺口复合度", "channel", "每条问题固定一个主缺口，再允许带入少量辅助判断维度。", "提高可在一个自然问题里联动一到两个辅助维度，但不能堆关键词。", "降低会严格一问一事，清楚但可能增加线程数量。", ["F04", "F09", "F10", "F33"], ["Cref"], "architecture_definition", "主缺口恒为一个；辅助维度只是结构上限，不是质量分。", DEFAULT_METHOD_PARAMETERS.commentGapMultiplexing),
  slider("comment_reply_increment", "parameters.commentReplyIncrement", "答复新增信息强度", "channel", "回答相对正文和提问新增多少可行动信息，按直接回答、条件、边界、未知和下一问组织。", "提高会补足更多依据与核验动作，但不能重复正文或越过证据。", "降低会更简短，仍需保留五项回答契约的最低信息。", ["F09", "F10", "F22", "F33", "F34"], ["Cref"], "normative_boundary", "新增量以结构代理检查，尚无转化效果权重。", DEFAULT_METHOD_PARAMETERS.commentReplyIncrement),
  slider("question_compression", "parameters.questionCompression", "短句隐含信息强度", "expression", "用身份词、时间词、动作和关系称呼，让一句短话同时暗示多个维度。", "提高会删掉解释性铺垫，但必须保留自然谓语和人物口吻。", "降低允许多半句生活上下文，适合复杂纠结。", ["F05", "F10", "F18", "F33"], ["Cref"], "unvalidated_proxy", "短句高信息是形态代理，不等于字越少效果越好。", DEFAULT_METHOD_PARAMETERS.questionCompression),
  slider("comment_platform_register", "parameters.commentPlatformRegister", "平台语域浓度", "expression", "控制评论里项目语言模块提供的日常称呼、轻口语和圈内说法的出现概率。", "提高会允许少量项目已审核语域线索，但每个人不能共用同一套词。", "降低会使用更普通的互联网口语，适合严肃主题或缺少可靠语料的项目。", ["F05", "F10", "F13", "F33"], ["Cref"], "sample_observation", "语域词必须来自项目创作模型，会随平台与行业变化；不能把热词密度当作效果规律，也不使用规避审核的故意错字。", DEFAULT_METHOD_PARAMETERS.commentPlatformRegister),
  slider("comment_conversation_rate", "parameters.commentConversationRate", "评论接话比例", "channel", "控制多少根评论自然长出第二轮或第三人接话，而不是全部停在一问一答。", "提高会增加有触发原因的多轮分支；仍受总行数与追问深度约束。", "降低会保留更多独立短评和一次回复，阅读更轻。", ["F09", "F10", "F22", "F33"], ["Cref"], "architecture_definition", "该值是编排比例，不是平台真实回复率；样本只证明评论形态中同时存在单轮与多轮。", DEFAULT_METHOD_PARAMETERS.commentConversationRate),
  slider("comment_branching_strength", "parameters.commentBranchingStrength", "对话延展强度", "information", "控制多轮对话是否由上一句话里的新条件，自然带出相邻知识点、好奇点或图片细节。", "提高会从主缺口延伸一个有因果触发的辅助点，不允许突然换题或一次塞满。", "降低会围绕原问题继续澄清，结构更聚焦。", ["F04", "F09", "F10", "F22"], ["Cref"], "hypothesis", "延展有助于信息补全是生产假设，尚未证明能提高互动或转化。", DEFAULT_METHOD_PARAMETERS.commentBranchingStrength),
  slider("comment_organic_variation", "parameters.commentOrganicVariation", "评论有机扰动", "expression", "允许少量共鸣、质疑、看图反应、轻跑题和不完全闭合，让评论关系网不呈现整齐销售漏斗。", "提高会增加非对称节点和声音冲突，但仍不能制造虚假口碑或破坏必要信息。", "降低会更聚焦、更像标准答疑，适合高风险说明。", ["F08", "F10", "F13", "F33"], ["Cref"], "hypothesis", "“更自然”是待验证的形态假设；扰动不是随机胡说，也不保证平台表现。", DEFAULT_METHOD_PARAMETERS.commentOrganicVariation),
  slider("comment_discovery_strength", "parameters.commentDiscoveryStrength", "发现式问答强度", "expression", "用已披露线索引导读者做一次容易推断，并在同一线程立即揭示答案。", "提高会更明显地组织线索、推断和自检，但不得故意扣留必要信息。", "降低会更直接给答案，发现过程更弱。", ["F10", "F22", "F33"], ["Cref"], "hypothesis", "发现感是表达结构假设，不是效果规律，也不能替代证据。", DEFAULT_METHOD_PARAMETERS.commentDiscoveryStrength),
  slider("comment_inference_effort", "parameters.commentInferenceEffort", "评论推断难度", "expression", "读者从线索得到揭示前需要付出多少思考；只允许低或中等难度。", "提高会增加一步比较或条件判断；过高会产生警告并增加误解风险。", "降低会让推断更直接，适合新手或高风险信息。", ["F05", "F10", "F18", "F33"], ["Cref"], "unvalidated_proxy", "推断负荷未标定；系统禁止把困难等同于深刻。", DEFAULT_METHOD_PARAMETERS.commentInferenceEffort),
  slider("comment_self_verification", "parameters.commentSelfVerification", "读者自检强度", "channel", "揭示答案后给读者一个可复用的自检问题或核验动作。", "提高会加入更明确的证据核验和反例检查。", "降低只保留最低必要自检，不能删除事实边界。", ["F10", "F17", "F22", "F33"], ["Cref"], "architecture_definition", "自检用于降低错误外推，不代表用户一定会执行。", DEFAULT_METHOD_PARAMETERS.commentSelfVerification),
  slider("comment_false_closure_guard", "parameters.commentFalseClosureGuard", "假闭合防护", "evidence", "防止把容易猜到、听起来有发现感的内容误写成已证实结论。", "提高会更显式保留未知、所需输入和核验路径。", "降低只减少重复提醒；无证据结论仍不能写成事实。", ["F06", "F10", "F25", "F34"], ["Cref"], "normative_boundary", "这是硬安全边界；发现感、互动感和推断过程都不是证据。", DEFAULT_METHOD_PARAMETERS.commentFalseClosureGuard),
  slider("redundancy_tolerance", "parameters.redundancyTolerance", "跨通道重复容忍", "channel", "同一事实在标签、正文和评论中允许重复到什么程度。", "提高会增强呼应，也会产生重复和广告感。", "降低会强调各通道新增信息，但关键承诺仍需一致。", ["F08", "F20", "F32", "F33", "F34"], ["H", "N.title", "N.body", "Cref"], "architecture_definition", "同一证据只能算一次信息增量。", DEFAULT_METHOD_PARAMETERS.redundancyTolerance),
  slider("evidence_strictness", "parameters.evidenceStrictness", "证据严格度", "evidence", "决定模型遇到资料不足时有多坚决地保留 unknown。", "提高会减少无依据断言，也可能留下更多未知。", "降低会让表达更顺，但幻觉和错判风险上升。", ["F06", "F25", "F34"], ["N.imageBrief", "N.title", "N.body", "Cref"], "normative_boundary", "未知不得按中间值或常识补齐。", DEFAULT_METHOD_PARAMETERS.evidenceStrictness),
  slider("boundary_visibility", "parameters.boundaryVisibility", "边界可见度", "evidence", "让限制条件在正文或回答里有多显眼。", "提高会前置限制与反例，降低虚假确定感。", "降低会更流畅，但关键边界仍不可隐藏。", ["F04", "F06", "F14", "F25"], ["N.body", "Cref"], "normative_boundary", "决策关键边界属于硬约束。", DEFAULT_METHOD_PARAMETERS.boundaryVisibility),
  slider("route_specificity", "parameters.routeSpecificity", "入口路由具体度", "channel", "标签和标题对主题、地点、阶段说得多具体。", "提高会更贴近明确查询，也可能缩小适用人群。", "降低会更宽泛，但可能无法让需要的人识别相关性。", ["F12", "F19", "F20", "F24"], ["H", "N.title"], "unvalidated_proxy", "缺少平台搜索量与曝光数据，路由收益未知；该参数不是 TrendFit 手工评分。", DEFAULT_METHOD_PARAMETERS.routeSpecificity),
  slider("novelty_angle", "parameters.noveltyAngle", "信息角度新颖度", "information", "是否寻找普遍内容没有讲清、但项目知识能证明的角度。", "提高会更积极寻找反常识或未覆盖角度，也更需证据。", "降低会采用熟悉框架，辨识度可能较弱。", ["F28", "F29", "F31"], ["H", "N.title", "N.body"], "unvalidated_proxy", "没有完整竞品和热点数据时只能作启发式；它不代填 F30 的热点来源与三项手工输入。", DEFAULT_METHOD_PARAMETERS.noveltyAngle),
  slider("question_naturalness", "parameters.questionNaturalness", "提问自然度", "expression", "问题是否像这个阶段的人真的会问，并准确暴露缺口。", "提高会采用具体情境和自然追问，不能伪造已发生互动。", "降低会更像标准FAQ，清楚但可能生硬。", ["F10", "F33"], ["Cref"], "unvalidated_proxy", "自然度是待验证代理，不等于真实用户评论。", DEFAULT_METHOD_PARAMETERS.questionNaturalness),
  {
    id: "title_target_chars", path: "parameters.titleTargetChars", label: "标题目标长度", group: "expression",
    control: { kind: "number", min: 1, max: 60, step: 1, unit: "字", simpleMode: false, advanced: true }, defaultValue: DEFAULT_METHOD_PARAMETERS.titleTargetChars,
    noviceExplanation: "这是创作目标，不是硬截断；标题首先要准确表达入口承诺。",
    increaseEffect: "增加可容纳更多条件，但入口预览更重。", decreaseEffect: "减少会更利落，也更容易丢失限定条件。",
    formulaIds: ["F19", "F20", "F32"], channels: ["N.title"], evidenceStatus: "operational_default", evidenceNote: "70篇长度分布仅作描述参照，不证明效果。",
  },
  {
    id: "paragraph_target", path: "parameters.paragraphTarget", label: "正文目标段落数", group: "expression",
    control: { kind: "number", min: 1, max: 20, step: 1, unit: "段", simpleMode: false, advanced: true }, defaultValue: DEFAULT_METHOD_PARAMETERS.paragraphTarget,
    noviceExplanation: "帮助手机阅读分段，不要求每篇机械写成固定段数。",
    increaseEffect: "增加段落能拆开逻辑，也可能显得碎。", decreaseEffect: "减少段落更紧凑，但可能形成文字墙。",
    formulaIds: ["F05", "F18", "F32"], channels: ["N.body"], evidenceStatus: "operational_default", evidenceNote: "样本段落中位数只描述体裁，不是最优值。",
  },
];

const EXTRA_PARAMETERS: GenerationParameterDefinition[] = [
  {
    id: "must_mention", path: "task.mustMention", label: "必须出现的信息", group: "information",
    control: { kind: "text_list", placeholder: "每行一项", simpleMode: true, advanced: false }, defaultValue: [],
    noviceExplanation: "无论采用哪种风格，都必须在可见内容里交代的项目事实或提示。",
    increaseEffect: "增加会占用正文空间，并提高冲突检查范围。", decreaseEffect: "减少会给表达更多自由，但不要删掉决策必要信息。",
    formulaIds: ["F04", "F25"], channels: ["N.body", "Cref"], evidenceStatus: "user_choice", evidenceNote: "用户要求仍受知识可行域和硬约束限制。",
  },
  {
    id: "forbidden_phrases", path: "task.forbidden", label: "禁止表达", group: "evidence",
    control: { kind: "text_list", placeholder: "每行一项", simpleMode: true, advanced: false }, defaultValue: [],
    noviceExplanation: "明确不能出现的词、承诺或说法。",
    increaseEffect: "增加会收紧候选空间并触发更多修复。", decreaseEffect: "减少会扩大表达空间，但系统硬性安全边界仍有效。",
    formulaIds: ["F25", "F27"], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "normative_boundary", evidenceNote: "禁止项属于硬约束，不能用效果抵消。",
  },
  {
    id: "information_answers", path: "informationWindow.answers", label: "已有答案", group: "information",
    control: { kind: "text_list", placeholder: "与缺口按顺序对应", simpleMode: false, advanced: true }, defaultValue: [],
    noviceExplanation: "知识库已经能够回答哪些缺口；没有答案不要让模型猜。",
    increaseEffect: "增加可确认答案会提高直接信息量，也必须同步来源。", decreaseEffect: "减少意味着更多问题保持未知或只给核验路径。",
    formulaIds: ["F04", "F06", "F09"], channels: ["N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "答案必须属于知识可行域。",
  },
  {
    id: "evidence_requirements", path: "informationWindow.evidenceRequirements", label: "证据要求", group: "evidence",
    control: { kind: "text_list", placeholder: "例如：价格必须来自当前项目资料", simpleMode: false, advanced: true }, defaultValue: [],
    noviceExplanation: "规定某类结论至少需要什么来源才能写成事实。",
    increaseEffect: "增加会减少无依据输出，也可能留下更多unknown。", decreaseEffect: "减少会降低核验成本，但不能越过事实红线。",
    formulaIds: ["F06", "F25", "F34"], channels: ["N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "normative_boundary", evidenceNote: "证据身份与范围是事实输出门槛。",
  },
  {
    id: "reusable_frameworks", path: "informationWindow.reusableFrameworks", label: "可复用判断框架", group: "information",
    control: { kind: "text_list", placeholder: "例如：先条件、再证据、后比较", simpleMode: false, advanced: true }, defaultValue: [],
    noviceExplanation: "不只给这次答案，也告诉读者以后怎样自己核实。",
    increaseEffect: "增加会提升方法信息，也可能使正文更像教程。", decreaseEffect: "减少会更贴近当下问题，但迁移价值降低。",
    formulaIds: ["F04", "F15", "F17"], channels: ["N.body", "Cref"], evidenceStatus: "normative_boundary", evidenceNote: "判断框架服务于减少错误决策，不保证业务结果。",
  },
  {
    id: "information_priorities", path: "informationWindow.priorities", label: "信息优先级", group: "information",
    control: { kind: "text_list", placeholder: "从最重要到次要", simpleMode: false, advanced: true }, defaultValue: [],
    noviceExplanation: "空间不够时先保留什么，避免按模型随机关联决定顺序。",
    increaseEffect: "增加明确优先级会让取舍更稳定。", decreaseEffect: "减少会给模型更多编排自由，也更难解释为什么遗漏。",
    formulaIds: ["F04", "F17", "F27"], channels: ["N.title", "N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "优先级是任务输入，具体效果权重未标定。",
  },
  {
    id: "enabled_channels", path: "expressionWindow.channels", label: "启用表达通道", group: "channel",
    control: { kind: "multi_select", options: [
      { value: "hashtags", label: "标签", description: "入口路由线索" }, { value: "image", label: "图片方向", description: "视觉承接" },
      { value: "title", label: "标题", description: "入口承诺" }, { value: "body", label: "正文", description: "共同主线" },
      { value: "comments", label: "评论问答", description: "条件分支" },
    ], simpleMode: false, advanced: true }, defaultValue: ["hashtags", "image", "title", "body", "comments"],
    noviceExplanation: "决定完整内容包里哪些位置实际承担信息；即使保留空结构，也不能把信息分给未启用通道。",
    increaseEffect: "增加通道会扩大表达路径，也提高一致性检查成本。", decreaseEffect: "减少通道更简单，但剩余通道要承接必要信息。",
    formulaIds: ["F01", "F05", "F08", "F26"], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "通道联合设计是架构，不是效果定律。",
  },
  {
    id: "expression_forms", path: "expressionWindow.forms", label: "表达形式", group: "expression",
    control: { kind: "text_list", placeholder: "问题、清单、对比", simpleMode: false, advanced: true }, defaultValue: ["问题", "清单", "条件化回答"],
    noviceExplanation: "同一信息可用问题、清单、对比或反例表达，但不能只是换皮重复。",
    increaseEffect: "增加形式会扩大候选表达，也可能让结构混杂。", decreaseEffect: "减少形式会更统一，但变化度下降。",
    formulaIds: ["F05", "F08", "F26"], channels: ["N.title", "N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "表达形式属于W_X，具体效果未知。",
  },
  {
    id: "expression_sequence", path: "expressionWindow.sequence", label: "信息顺序", group: "expression",
    control: { kind: "text_list", placeholder: "入口承诺→共同前提→条件问答", simpleMode: false, advanced: true }, defaultValue: ["入口承诺", "正文解释", "评论区补全"],
    noviceExplanation: "规定读者先看到什么、后看到什么，避免答案和前提倒置。",
    increaseEffect: "增加步骤会更精细，也提高消费成本。", decreaseEffect: "减少步骤更直接，但需保留因果和条件顺序。",
    formulaIds: ["F05", "F19", "F21"], channels: ["N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "architecture_definition", evidenceNote: "顺序路径存在损耗，但概率参数未知。",
  },
  {
    id: "thread_style", path: "expressionWindow.threadStyle", label: "问答线程结构", group: "expression",
    control: { kind: "text", placeholder: "问题—回答—追问—边界", simpleMode: false, advanced: true }, defaultValue: "问题—回答—追问—边界",
    noviceExplanation: "规定一条问答怎样推进；仍需逐项具备Stage/Gap/Function/Q/A/Follow-up/Next/Role/Source。",
    increaseEffect: "更复杂结构能容纳条件和反例，也增加阅读成本。", decreaseEffect: "更简单结构更快，但可能遗漏下一步。",
    formulaIds: ["F10", "F22", "F33"], channels: ["Cref"], evidenceStatus: "architecture_definition", evidenceNote: "线程结构用于信息补全，不代表真实互动。",
  },
  {
    id: "image_brief_enabled", path: "content.imageBriefEnabled", label: "生成图片方向", group: "channel",
    control: { kind: "toggle", simpleMode: false, advanced: true }, defaultValue: true,
    noviceExplanation: "只生成图片应承担的信息任务，不会把建议当成实际图片证据。",
    increaseEffect: "开启后检查图、标题、正文是否同一承诺。", decreaseEffect: "关闭后不能依赖图片补足正文必要信息。",
    formulaIds: ["F07", "F19", "F32"], channels: ["N.imageBrief"], evidenceStatus: "architecture_definition", evidenceNote: "图片方向是计划对象，不是已观察图片。",
  },
  {
    id: "comment_multi_turn_growth", path: "content.commentMultiTurnGrowthEnabled", label: "评论多轮接龙生长", group: "channel",
    control: { kind: "toggle", simpleMode: false, advanced: true }, defaultValue: false,
    noviceExplanation: "这是一个额外的多轮接龙生成步骤：先写根评论，再让被上一句具体词真正触发的少数线程长出追问；关闭时根评论直接成稿，同样是有效输出。",
    increaseEffect: "开启后评论区可出现有触发原因的多轮接话；仍受追问深度与总行数约束。", decreaseEffect: "关闭后所有线程停在一问一答，多轮目标按零计算，不会再产生欠生长提示。",
    costNotice: {
      headline: "开启会增加生成开销，且实际接话条数由评论行数预算决定，不由本开关或接话比例决定。",
      extraModelCalls: "多 1 次接龙生成调用（阶段 2.2），若长出的追问落在机构问答线程上，再按答复身份追加最多 3 次答复调用（阶段 2.3）。",
      measuredImpact: "实测：开启后单篇 10–14 分钟，关闭时 10–18 分钟，同项目同预设下未见明显变慢（样本 4 篇，不足以定论）。",
      dependsOn: [
        "追问深度（follow_up_depth）必须大于 0，否则本开关不生效。",
        "评论接话比例（comment_conversation_rate）必须大于 0，否则本开关不生效。",
        "实际条数受可见评论行数上限约束：行数上限 13、根评论 5 条时只容得下 1 条追问，此时把接话比例从 48 调到 75 不会产生更多接话。",
      ],
    },
    formulaIds: ["F09", "F10", "F33"], channels: ["Cref"], evidenceStatus: "operational_default",
    evidenceNote: "M7 决策：多轮生长无效果证据，作为保守默认可选步骤保留，默认开启与否由运营选择；形态动机是描述性结构（真实评论区同时存在单轮与多轮），不是效果承诺。",
  },
  {
    id: "knowledge_mode", path: "knowledge.mode", label: "知识披露模式", group: "operation",
    control: { kind: "select", options: [
      { value: "auto", label: "自动", description: "能放下则全量，否则渐进披露" },
      { value: "full", label: "优先全量", description: "预算允许时全量注入" },
      { value: "progressive", label: "强制渐进", description: "先索引再按任务披露" },
    ], simpleMode: false, advanced: true }, defaultValue: "auto",
    noviceExplanation: "控制知识如何进入模型，不改变知识本身的真假。",
    increaseEffect: "更多全文能保留上下文，也占用更多模型窗口。", decreaseEffect: "更多渐进披露更省上下文，但可能遗漏低匹配资料。",
    formulaIds: ["F06", "F25", "F36"], channels: ["N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "operational_default", evidenceNote: "不使用向量；选择依据是索引、元数据和任务关键词。",
  },
  {
    id: "model_temperature", path: "model.temperature", label: "模型随机性", group: "operation",
    control: { kind: "slider", min: 0, max: 2, step: 0.1, unit: "temperature", simpleMode: false, advanced: true }, defaultValue: 0.8,
    noviceExplanation: "提高会让表达变化更大，不会让事实范围变大。",
    increaseEffect: "候选措辞和结构更分散，也可能增加不稳定。", decreaseEffect: "输出更稳定，也可能更相似。",
    formulaIds: ["F25", "F26", "F27"], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "operational_default", evidenceNote: "随机性只作用于候选采样，知识和硬约束不随之放松。",
  },
  {
    id: "max_output_tokens", path: "model.maxOutputTokens", label: "模型输出预算", group: "operation",
    control: { kind: "number", min: 256, max: 100000, step: 256, unit: "tokens", simpleMode: false, advanced: true }, defaultValue: 8000,
    noviceExplanation: "限制一次模型最多能返回多少内容，和正文目标字数不是同一个单位。",
    increaseEffect: "提高可容纳更完整JSON，也增加成本。", decreaseEffect: "降低成本，但可能截断完整内容包。",
    formulaIds: ["F01", "F25"], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "operational_default", evidenceNote: "这是执行预算，不是内容效果参数。",
  },
  {
    id: "repair_attempts", path: "generation.maxRepairAttempts", label: "最多局部修复次数", group: "operation",
    control: { kind: "number", min: 0, max: 2, step: 1, unit: "次", simpleMode: false, advanced: true }, defaultValue: 2,
    noviceExplanation: "校验失败后只重写受影响通道，最多两次。",
    increaseEffect: "增加会提高修复机会，也增加调用成本。", decreaseEffect: "减少更快，但可能保留可修复错误。",
    formulaIds: ["F25", "F36"], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"], evidenceStatus: "operational_default", evidenceNote: "两次是工程上限，不是效果规律。",
  },
  ...([
    ["require_evidence_references", "diagnostics.requireEvidenceReferences", "要求事实引用证据", true, "事实没有来源ID时判为错误。", ["F06", "F34"]],
    ["reject_unknown_as_fact", "diagnostics.rejectUnknownAsFact", "禁止未知冒充事实", true, "unknown键被写成事实时判为错误。", ["F06", "F14", "F25"]],
    ["reject_prohibited_claims", "diagnostics.rejectProhibitedClaims", "拒绝禁止声明", true, "命中项目禁止项时判为错误。", ["F25"]],
    ["warn_duplicate_information", "diagnostics.warnDuplicateInformation", "提示跨通道重复", true, "正文和评论逐字重复时给出警告。", ["F08", "F32", "F33"]],
  ] as const).map(([id, path, label, defaultValue, noviceExplanation, formulaIds]) => ({
    id, path, label, group: "diagnostic" as const,
    control: { kind: "toggle" as const, simpleMode: false, advanced: true }, defaultValue,
    noviceExplanation, increaseEffect: "开启会加强相应检查并可能触发局部修复。", decreaseEffect: "关闭只移除该可选检查，系统硬边界仍保留。",
    formulaIds: [...formulaIds], channels: ["H", "N.imageBrief", "N.title", "N.body", "Cref"] as ContentChannel[],
    evidenceStatus: "normative_boundary" as const, evidenceNote: "这是可审计检查开关，不是质量权重。",
  })),
];

const DIAGNOSTIC_PARAMETERS: GenerationParameterDefinition[] = [
  ...BODY_DIMENSIONS.map((dimension) => slider(
    `body_diagnostic_${dimension.id}`,
    `parameters.bodyDiagnosticEmphasis.${dimension.id}`,
    `正文人工检查优先级：${dimension.label}`,
    "diagnostic",
    `只控制“${dimension.label}”在检查清单中的显示顺序和人工复核优先级，不是分项值或经过标定的权重。`,
    "提高会把该分项排得更靠前，便于人工先看；不会改变阈值、状态、结论或生成内容。",
    "降低只会把该分项在人工清单中后移；本参数不调度系统检查，独立硬校验和安全门槛不变。",
    ["F32"], ["N.imageBrief", "N.title", "N.body"], "unvalidated_proxy",
    "正文分项没有校准观测，value=null/status=unknown；emphasis 仅用于显示排序，禁止合成总分。",
    50,
    "优先级",
  )),
  ...COMMENT_DIMENSIONS.map((dimension) => slider(
    `comment_diagnostic_${dimension.id}`,
    `parameters.commentDiagnosticEmphasis.${dimension.id}`,
    `评论人工检查优先级：${dimension.label}`,
    "diagnostic",
    `只控制“${dimension.label}”在检查清单中的显示顺序和人工复核优先级，不是分项值或经过标定的权重。`,
    "提高会把该分项排得更靠前，便于人工先看；不会改变阈值、状态、结论或线程内容。",
    "降低只会把该分项在人工清单中后移；本参数不调度系统检查，独立硬校验和安全门槛不变。",
    ["F33"], ["Cref"], "unvalidated_proxy",
    "评论分项没有校准观测，value=null/status=unknown；emphasis 仅用于显示排序，禁止合成总分。",
    50,
    "优先级",
  )),
];

/**
 * 评论参数的单一真源:声明每个作用于 Cref 通道的写作行为参数注入哪个评论阶段。
 * reader=读者提问侧(2A-R)、answer=机构答复侧(2A-O/2B-O)、both=两侧都注入。
 * engine.ts 按此字段把参数的 behaviorInstructions 分侧注入——只注入写作指令文本,
 * 绝不连带角色身份/口径/task_data(那是旧串台根因)。此处是唯一归属声明,禁止在
 * engine/planning 里再维护第二份归属表。规划层已消化的形态参数(platformRegister /
 * conversationRate / branchingStrength / organicVariation / roleDiversity 等,见
 * planning.ts buildPersonaScenePlan)不在此表——它们经 personaScenePlan 分侧投影,
 * 不走提示词文本注入,避免双真源冲突。
 */
const COMMENT_STAGE_BY_ID: Record<string, GenerationParameterDefinition["commentStage"]> = {
  // 读者提问侧:决定"读者问什么、怎么问"。
  audience_stage: "reader",
  comment_constraint_density: "reader",
  comment_gap_multiplexing: "reader",
  question_compression: "reader",
  question_naturalness: "reader",
  state_information_strength: "reader",
  experience_information_strength: "reader",
  // 机构答复侧:决定"怎么答"。comment_conditionality 本轮从空转接通到答复侧。
  comment_reply_increment: "answer",
  comment_conditionality: "answer",
  comment_self_verification: "answer",
  comment_discovery_strength: "answer",
  comment_inference_effort: "answer",
  decision_information_depth: "answer",
  information_boundaries: "answer",
  // 两侧:结构/展开/安全边界,提问与答复都受约束。
  information_breadth: "both",
  comment_thread_min: "both",
  comment_thread_max: "both",
  follow_up_depth: "both",
  comment_expansion: "both",
  redundancy_tolerance: "both",
  evidence_strictness: "both",
  boundary_visibility: "both",
  comment_false_closure_guard: "both",
  information_gaps: "both",
};

/**
 * 逐参数执行强度(单一真源)。语义见 GenerationParameterDefinition.enforcement。
 *
 * 这张表是**按代码实际消费路径**逐个核对得出的,不是按参数名猜的:
 *  - validated: 有确定性推导 + content.ts 校验(违反可进 repair)
 *  - derived:   planning/engine 真的读值改结构,但校验层不复核结果
 *  - guidance:  只有 explicitBehavior 一句提示词,无任何代码消费
 * 未列出的参数缺省按 guidance 理解;诊断强调滑杆在下方统一置 display。
 *
 * 维护约定:给某个参数新增推导或校验时,同步更新这里——否则 UI 会对用户说谎。
 */
const ENFORCEMENT_BY_ID: Record<string, NonNullable<GenerationParameterDefinition["enforcement"]>> = {
  // 结构硬约束:推导 + 校验
  body_min_chars: "validated", body_max_chars: "validated",
  hashtag_count_min: "validated", hashtag_count_max: "validated",
  comment_thread_min: "validated", comment_thread_max: "validated",
  must_mention: "validated", forbidden_phrases: "validated",
  image_brief_enabled: "validated",
  information_gaps: "validated", information_boundaries: "validated",
  information_answers: "validated",
  comment_gap_multiplexing: "validated", comment_inference_effort: "validated",
  require_evidence_references: "validated", reject_unknown_as_fact: "validated",
  reject_prohibited_claims: "validated", warn_duplicate_information: "validated",
  // 确定性推导,无校验复核
  audience_stage: "derived", entry_route: "derived",
  follow_up_depth: "derived", comment_multi_turn_growth: "derived",
  information_breadth: "derived", decision_information_depth: "derived",
  comment_expansion: "derived", comment_conditionality: "derived",
  comment_role_diversity: "derived", comment_constraint_density: "derived",
  comment_reply_increment: "derived", question_compression: "derived",
  comment_platform_register: "derived", comment_conversation_rate: "derived",
  comment_branching_strength: "derived", comment_organic_variation: "derived",
  comment_discovery_strength: "derived", comment_self_verification: "derived",
  comment_false_closure_guard: "derived", question_naturalness: "derived",
  title_target_chars: "derived", paragraph_target: "derived",
  reusable_frameworks: "derived",
  // enabled_channels 在 parameters.ts channelAllocation 与 planning.ts 都真的
  // 按值改变通道分配,但校验层不因这个值本身报错,故为 derived 而非 validated。
  enabled_channels: "derived",
  knowledge_mode: "derived", model_temperature: "derived",
  max_output_tokens: "derived", repair_attempts: "derived",
  // 仅提示词引导:系统不做结构性保证(逐个实测确认无代码消费)
  state_information_strength: "guidance", experience_information_strength: "guidance",
  body_completeness: "guidance", redundancy_tolerance: "guidance",
  evidence_strictness: "guidance", boundary_visibility: "guidance",
  route_specificity: "guidance", novelty_angle: "guidance",
  evidence_requirements: "guidance", information_priorities: "guidance",
  thread_style: "guidance",
  // expressionWindow 的这三项只出现在 explicitBehavior 的提示词文本里,
  // planning/engine/content 都不读 config.expressionWindow.{voice,forms,sequence}
  // ——注意别被 strategy.voice / strategy.sequence 误导,那是规划层自己的字段。
  expression_voice: "guidance", expression_forms: "guidance", expression_sequence: "guidance",
};

export const GENERATION_PARAMETER_REGISTRY: readonly GenerationParameterDefinition[] = Object.freeze(
  [
    ...CORE_PARAMETERS,
    ...EXTRA_PARAMETERS,
    ...DIAGNOSTIC_PARAMETERS,
  ].map((definition) => {
    const commentStage = COMMENT_STAGE_BY_ID[definition.id];
    const enforcement = definition.id.startsWith("body_diagnostic_") || definition.id.startsWith("comment_diagnostic_")
      ? "display" as const
      : ENFORCEMENT_BY_ID[definition.id] ?? "guidance" as const;
    return Object.freeze({
      ...definition,
      ...(commentStage ? { commentStage } : {}),
      enforcement,
    });
  }),
);

export const CONFIRMED_REFERENCE_SAMPLE_BASELINE: ConfirmedSampleBaseline = {
  id: "reference_copy_70_descriptive_v1",
  label: "70篇参考内容的描述性形态基线",
  evidenceStatus: "sample_observation",
  metrics: [
    { id: "title_chars", label: "标题长度", unit: "characters", sampleSize: 70, statistics: { min: 1, p25: 5, median: 8.5, p75: 13, max: 22 } },
    { id: "body_chars_without_hashtags", label: "正文净文字长度（去标签）", unit: "characters", sampleSize: 70, statistics: { min: 0, p25: 36, median: 77, p75: 143, max: 267 } },
    { id: "comment_total_chars_without_role_prefix", label: "评论区净文字总长", unit: "characters", sampleSize: 70, statistics: { min: 3, p25: 61.5, median: 109.5, p75: 160.3, max: 486 } },
    { id: "comment_line_chars", label: "单条评论/回复长度", unit: "characters", sampleSize: 689, statistics: { min: 1, p25: 6, median: 10, p75: 15, max: 95 } },
    { id: "comment_lines", label: "评论转录行数", unit: "lines", sampleSize: 70, statistics: { min: 1, p25: 6, median: 10, p75: 14, max: 20 } },
    { id: "image_count", label: "图片数量", unit: "images", sampleSize: 70, statistics: { min: 1, p25: 1, median: 1, p75: 3, max: 5 } },
  ],
  caveats: [
    "这些数值只描述被采集的70篇参考内容，不是高质量阈值、因果规律或平台推荐规则。",
    "样本缺少完整曝光、点击、收藏、咨询和失败对照，不能用长度或行数推断效果。",
    "正文统计已去除话题标签，评论统计已去除“评1/博主回”等转录前缀；70行中含空正文、重复记录和人工提炼误差。",
    "评论转录行数不等于有效线程数；约10行描述的是长短不齐的评论节点，不应机械翻译为10个完整FAQ线程。",
    "系统不会把70篇原文注入提示词，只会暴露这里列出的聚合统计与边界。",
  ],
};

const COMMENT_METHOD_PRESET_BASE = {
  /**
   * 十个可见预设统一开启多轮生长(stage 2B)。
   *
   * 该开关的 registry 默认值保持 false(保守默认,给不需要额外一次模型调用的调用
   * 方),但**预设是"这张卡承诺什么形态"的声明**:卡片文案写着「评论区自然接住细
   * 节」「承担可查找的长尾分支」「评论展开条件分支」,而 comment_conversation_rate
   * 的全部读取路径都在这个开关之后——关着它,10 个预设精心设置的 48–75 接话比例
   * 全是死值,multiTurnTarget 恒为 [0,0],评论永远停在一问一答,文案成了兑现不了
   * 的承诺(实测 26 篇持久化数据 followUps 全空)。
   *
   * 代价是每篇多一次生长模型调用。欠生长只作 warning、不触发 repair(见
   * content.ts comment_network_under_grown),所以"没有可接的话头就不接"仍是合法
   * 输出,不会逼模型机械凑配额。
   */
  comment_multi_turn_growth: true,
  comment_role_diversity: 65,
  comment_constraint_density: 60,
  comment_gap_multiplexing: 55,
  comment_reply_increment: 70,
  question_compression: 60,
  comment_platform_register: 68,
  comment_conversation_rate: 48,
  comment_branching_strength: 62,
  comment_organic_variation: 58,
  comment_discovery_strength: 65,
  comment_inference_effort: 35,
  comment_self_verification: 70,
  comment_false_closure_guard: 95,
} as const;

const GENERATION_PRESET_DATA: BuiltInGenerationPreset[] = [
  {
    id: "real_minimal", label: "真实极简", description: "用一个人物处境和一个窄问题起帖，评论区自然接住细节。",
    noviceExplanation: "适合求助卡和临时发问：正文只说清谁、为什么现在问、最怕什么。",
    parameterValues: {
      ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 92, comment_constraint_density: 55, comment_gap_multiplexing: 45, comment_reply_increment: 55, question_compression: 92, comment_platform_register: 82, comment_conversation_rate: 60, comment_branching_strength: 65, comment_organic_variation: 85,
      audience_stage: "collecting", entry_route: "recommendation", information_breadth: 50, decision_information_depth: 55,
      state_information_strength: 85, experience_information_strength: 75, body_completeness: 32, comment_expansion: 88,
      comment_conditionality: 85, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 90,
      question_naturalness: 95, title_target_chars: 9, paragraph_target: 1, body_min_chars: 25, body_max_chars: 75,
      comment_thread_min: 3, comment_thread_max: 5,
    },
    behaviorInstructions: ["正文只写一个可识别人物处境、一个眼前限制和一个窄问题，不追加科普总结。", "评论用不同生活位置的短互动补信息，不能把每条回复写成完整FAQ。"],
    evidenceStatus: "hypothesis",
  },
  {
    id: "first_research", label: "新手功课", description: "帮助刚开始了解的人建立问题清单和判断顺序。",
    noviceExplanation: "适合还不知道该问什么的读者：先解释问题范围，再建立可执行的判断顺序。",
    parameterValues: {
      ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 75, comment_constraint_density: 55, comment_gap_multiplexing: 35, comment_reply_increment: 80, question_compression: 65, comment_platform_register: 58, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 45,
      audience_stage: "discovering", entry_route: "search", information_breadth: 85, decision_information_depth: 72,
      state_information_strength: 80, experience_information_strength: 55, body_completeness: 38, comment_expansion: 78,
      comment_conditionality: 75, redundancy_tolerance: 15, evidence_strictness: 90, boundary_visibility: 90,
      route_specificity: 80, novelty_angle: 35, question_naturalness: 95, title_target_chars: 10, paragraph_target: 2,
      body_min_chars: 30, body_max_chars: 95, comment_thread_min: 3, comment_thread_max: 5,
    },
    behaviorInstructions: ["把新手的模糊担心拟人成一个具体生活问题，正文只问一个最先影响行动的点。", "评论里再由过来人、同需求者和服务身份逐步带出判断顺序。"],
    evidenceStatus: "architecture_definition",
  },
  {
    id: "rational_compare", label: "理性比较", description: "不直接给唯一答案，重点解释方案差异和适用条件。",
    noviceExplanation: "适合已有多个候选方案的读者：先对齐比较口径，再判断什么条件下各自更合适。",
    parameterValues: {
      ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 60, comment_reply_increment: 90, question_compression: 55, comment_platform_register: 45, comment_conversation_rate: 65, comment_branching_strength: 85, comment_organic_variation: 55,
      audience_stage: "comparing", entry_route: "search", information_breadth: 80, decision_information_depth: 92,
      state_information_strength: 75, experience_information_strength: 55, body_completeness: 52, comment_expansion: 76,
      comment_conditionality: 92, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 98,
      route_specificity: 85, novelty_angle: 45, question_naturalness: 90, title_target_chars: 12, paragraph_target: 3,
      body_min_chars: 55, body_max_chars: 150, comment_thread_min: 3, comment_thread_max: 5,
    },
    behaviorInstructions: ["用一个已经做过功课的人来表达比较：说清看过什么、卡在哪个差异、自己最在意什么。", "不同经验和反例放进评论对话，不在正文列完整比较表。"],
    evidenceStatus: "normative_boundary",
  },
  {
    id: "hesitation_completion", label: "犹豫补全", description: "承认不确定性，优先补风险、边界和下一步信息。",
    noviceExplanation: "适合已经有倾向但仍担心选错的读者：不催决定，先补齐会改变选择的信息。",
    parameterValues: {
      ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 85, comment_constraint_density: 90, comment_gap_multiplexing: 55, comment_reply_increment: 92, question_compression: 70, comment_platform_register: 65, comment_conversation_rate: 75, comment_branching_strength: 80, comment_organic_variation: 65,
      audience_stage: "hesitating", entry_route: "recommendation", information_breadth: 68, decision_information_depth: 85,
      state_information_strength: 88, experience_information_strength: 68, body_completeness: 42, comment_expansion: 86,
      comment_conditionality: 95, redundancy_tolerance: 15, evidence_strictness: 95, boundary_visibility: 100,
      route_specificity: 65, novelty_angle: 35, question_naturalness: 95, title_target_chars: 11, paragraph_target: 2,
      body_min_chars: 40, body_max_chars: 120, comment_thread_min: 3, comment_thread_max: 5, follow_up_depth: 2,
    },
    behaviorInstructions: ["让犹豫通过一个具体时点和生活限制表现出来，不写成风险清单。", "评论安排支持、反例和一个可行动的承接，让读者自己看见分歧。"],
    evidenceStatus: "normative_boundary",
  },
  {
    id: "local_choice", label: "本地选择", description: "面向已准备行动的用户，补全城市、人物和筛选依据。",
    noviceExplanation: "适合准备筛选本地对象或服务者的读者：把地点和对象线索变成可核验的行动路径。",
    parameterValues: {
      ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 80, comment_constraint_density: 85, comment_gap_multiplexing: 65, comment_reply_increment: 90, question_compression: 70, comment_platform_register: 72, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 55,
      audience_stage: "ready", entry_route: "profile", information_breadth: 75, decision_information_depth: 90,
      state_information_strength: 85, experience_information_strength: 72, body_completeness: 45, comment_expansion: 82,
      comment_conditionality: 90, redundancy_tolerance: 15, evidence_strictness: 98, boundary_visibility: 98,
      route_specificity: 100, novelty_angle: 35, question_naturalness: 95, title_target_chars: 10, paragraph_target: 2,
      body_min_chars: 30, body_max_chars: 110, comment_thread_min: 3, comment_thread_max: 5,
    },
    behaviorInstructions: ["正文写一个正在赶路、等待、安排时间或刚获得新信息的人；地点和对象只使用任务及项目模型已有值。", "评论自然追问对象、地点、时间安排和一个选择理由，不写行动清单。"],
    evidenceStatus: "normative_boundary",
  },
  {
    id: "balanced_information", label: "均衡信息补全", description: "正文保留共同主线，评论展开条件分支。",
    noviceExplanation: "不知道怎么选时用它：先写清大家都要知道的，再把因人而异的问题放进问答。",
    // 其余 9 张卡都显式声明阶段/入口,这张原先漏了 audience_stage、entry_route、
    // question_naturalness、redundancy_tolerance、novelty_angle、route_specificity
    // 六项,静默落到 registry 默认并与 real_minimal 阶段撞车。「均衡」的定位是
    // 收集期 + 搜索入口的中间档,各项取十卡中位,不走任何极端。
    parameterValues: { ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 85, comment_reply_increment: 58, question_compression: 78, audience_stage: "collecting", entry_route: "search", information_breadth: 65, decision_information_depth: 70, state_information_strength: 75, experience_information_strength: 72, body_completeness: 45, comment_expansion: 78, comment_conditionality: 75, redundancy_tolerance: 15, evidence_strictness: 90, boundary_visibility: 90, route_specificity: 70, novelty_angle: 45, question_naturalness: 90, title_target_chars: 10, paragraph_target: 2, body_min_chars: 40, body_max_chars: 140, comment_thread_min: 3, comment_thread_max: 5 },
    behaviorInstructions: ["正文先让人物、现场和窄问题成立；知识只选一项自然进入。", "评论在短问短答、经验差异、人物路由和边界之间保持平衡。"],
    evidenceStatus: "operational_default",
  },
  {
    id: "search_decision", label: "搜索决策补全", description: "主动搜索/比较，直接答疑、依据和经验方法。",
    noviceExplanation: "读者已经在找答案时，用清楚的判断办法减少他继续来回搜索。",
    parameterValues: { ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 88, comment_constraint_density: 70, comment_reply_increment: 62, question_compression: 80, audience_stage: "comparing", entry_route: "search", information_breadth: 80, decision_information_depth: 90, state_information_strength: 72, experience_information_strength: 58, body_completeness: 52, comment_expansion: 78, route_specificity: 95, novelty_angle: 40, comment_conditionality: 85, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 92, title_target_chars: 12, paragraph_target: 3, body_min_chars: 55, body_max_chars: 155, comment_thread_min: 3, comment_thread_max: 5 },
    behaviorInstructions: ["标题命中搜索问题，但正文仍由一个正在比较的人来讲，不写知识库目录。", "依据和条件分别由不同评论节点补充，避免单个楼主回复包办全部信息。"],
    evidenceStatus: "architecture_definition",
  },
  {
    id: "minimal_body_conditional_comments", label: "短正文＋条件问答", description: "正文保持最小充分，评论承担可查找的长尾分支。",
    noviceExplanation: "适合正文只讲主线、不同人答案不同的主题；短不等于空。",
    parameterValues: { ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 95, comment_constraint_density: 55, comment_gap_multiplexing: 50, comment_reply_increment: 55, question_compression: 95, audience_stage: "collecting", entry_route: "recommendation", information_breadth: 65, state_information_strength: 88, experience_information_strength: 72, body_completeness: 28, comment_expansion: 92, comment_conditionality: 82, decision_information_depth: 65, redundancy_tolerance: 10, evidence_strictness: 95, boundary_visibility: 90, question_naturalness: 98, title_target_chars: 8, paragraph_target: 1, body_min_chars: 20, body_max_chars: 70, comment_thread_min: 3, comment_thread_max: 5, follow_up_depth: 2 },
    behaviorInstructions: ["正文只留下一个可以被评论自然接住的具体问题，不做答案摘要。", "评论以人物关系网逐层补全，允许短反应和经验冲突，不要求每条完整闭环。"],
    evidenceStatus: "hypothesis",
  },
  {
    id: "comparison_framework", label: "比较核验清单", description: "把模糊纠结变成可比较条件和筛选步骤。",
    noviceExplanation: "适合“怎么选、选谁、去哪做”这类问题，重点是教会读者比较。",
    parameterValues: { ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 88, comment_constraint_density: 75, comment_gap_multiplexing: 65, comment_reply_increment: 65, question_compression: 72, audience_stage: "comparing", entry_route: "search", decision_information_depth: 95, information_breadth: 75, state_information_strength: 72, experience_information_strength: 55, body_completeness: 55, comment_expansion: 82, comment_conditionality: 90, redundancy_tolerance: 10, route_specificity: 95, novelty_angle: 55, evidence_strictness: 95, boundary_visibility: 95, question_naturalness: 90, title_target_chars: 12, paragraph_target: 3, body_min_chars: 65, body_max_chars: 165, comment_thread_min: 3, comment_thread_max: 5 },
    behaviorInstructions: ["把比较清单隐藏在一个真实纠结里：正文只说比较到哪一步和卡住的一项。", "评论用不同人的条件、反例和追问逐步显出比较维度。"],
    evidenceStatus: "normative_boundary",
  },
  {
    id: "state_experience_entry", label: "状态/经历入口", description: "用有依据的状态和生活线索建立相关性，再进入判断信息。",
    noviceExplanation: "适合从“我正处在哪一步、生活哪里受影响”切入，但不能编第一人称经历。",
    parameterValues: { ...COMMENT_METHOD_PRESET_BASE, comment_role_diversity: 85, comment_constraint_density: 55, comment_gap_multiplexing: 40, comment_reply_increment: 55, question_compression: 82, audience_stage: "discovering", entry_route: "recommendation", information_breadth: 55, state_information_strength: 95, experience_information_strength: 95, decision_information_depth: 55, body_completeness: 48, comment_expansion: 72, comment_conditionality: 70, redundancy_tolerance: 20, evidence_strictness: 95, boundary_visibility: 90, route_specificity: 55, novelty_angle: 50, question_naturalness: 92, title_target_chars: 11, paragraph_target: 3, body_min_chars: 70, body_max_chars: 190, comment_thread_min: 3, comment_thread_max: 5 },
    behaviorInstructions: ["用项目场景模块提供的身份关系和普通生活瞬间承载主题，不从预设猜测具体行业动作。", "场景是创作载体而不是项目证据；人物时序、动作和评论回复必须自洽。"],
    evidenceStatus: "hypothesis",
  },
];

const COMMENT_NETWORK_PRESET_OVERRIDES: Record<string, Record<string, number>> = {
  real_minimal: { comment_platform_register: 82, comment_conversation_rate: 60, comment_branching_strength: 65, comment_organic_variation: 85 },
  first_research: { comment_platform_register: 58, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 45 },
  rational_compare: { comment_platform_register: 45, comment_conversation_rate: 65, comment_branching_strength: 85, comment_organic_variation: 55 },
  hesitation_completion: { comment_platform_register: 65, comment_conversation_rate: 75, comment_branching_strength: 80, comment_organic_variation: 65 },
  local_choice: { comment_platform_register: 72, comment_conversation_rate: 55, comment_branching_strength: 70, comment_organic_variation: 55 },
  balanced_information: { comment_platform_register: 68, comment_conversation_rate: 48, comment_branching_strength: 62, comment_organic_variation: 58 },
  search_decision: { comment_platform_register: 55, comment_conversation_rate: 60, comment_branching_strength: 80, comment_organic_variation: 45 },
  minimal_body_conditional_comments: { comment_platform_register: 85, comment_conversation_rate: 70, comment_branching_strength: 72, comment_organic_variation: 88 },
  comparison_framework: { comment_platform_register: 45, comment_conversation_rate: 65, comment_branching_strength: 88, comment_organic_variation: 55 },
  state_experience_entry: { comment_platform_register: 75, comment_conversation_rate: 50, comment_branching_strength: 65, comment_organic_variation: 80 },
};

export const BUILT_IN_GENERATION_PRESETS: readonly BuiltInGenerationPreset[] = Object.freeze(
  GENERATION_PRESET_DATA.map((preset) => ({
    ...preset,
    parameterValues: { ...preset.parameterValues, ...(COMMENT_NETWORK_PRESET_OVERRIDES[preset.id] ?? {}) },
  })),
);

const STYLE_PROFILE_DATA: BuiltInStyleProfile[] = [
  {
    id: "natural_concise", label: "自然简洁", description: "短句、少套话、先说重点。", noviceExplanation: "像正常解释问题，不故意装网友，也不写广告金句。",
    parameterValues: { title_target_chars: 12, paragraph_target: 3, question_naturalness: 75, redundancy_tolerance: 15 },
    behaviorInstructions: ["使用自然短句，删除不产生信息的铺垫。", "允许符合人物身份的口语和样本已有平台语域，但不为装网感堆砌黑话、不造规避审核的错别字，也不伪造生活经历。"],
    evidenceStatus: "operational_default", safetyBoundary: "口语质感不得被用来伪装消费者身份或真实经历。",
  },
  {
    id: "calm_explanatory", label: "克制说明", description: "结论、依据、条件分层解释。", noviceExplanation: "适合风险较高或容易误解的主题，语气稳但不写成论文。",
    parameterValues: { title_target_chars: 16, paragraph_target: 5, decision_information_depth: 85, boundary_visibility: 95, question_naturalness: 60 },
    behaviorInstructions: ["先给可确认结论，再给依据、条件和未知。", "不用绝对词，不用恐惧或过度承诺推动行动。"],
    evidenceStatus: "normative_boundary", safetyBoundary: "专业口吻不等于专业资质，不得越过知识来源。",
  },
  {
    id: "question_driven", label: "问题驱动", description: "用目标阶段的真实疑问推进信息。", noviceExplanation: "每个问题都要揭示一个缺口，并在回答后说明下一步。",
    parameterValues: { question_naturalness: 95, comment_expansion: 85, comment_conditionality: 90, paragraph_target: 4 },
    behaviorInstructions: ["问题要具体到阶段、条件或选择，不写空泛的“有人知道吗”。", "回答后检查残余缺口：追问、澄清、反例或下一步至少承担一种功能。"],
    evidenceStatus: "unvalidated_proxy", safetyBoundary: "问题是内容模板，不得表述成已发生的真实互动。",
  },
  {
    id: "checklist_direct", label: "清单直给", description: "用少量明确检查项帮助比较。", noviceExplanation: "适合步骤、准备事项和核验问题，不适合把复杂结论硬切成口号。",
    parameterValues: { decision_information_depth: 85, body_completeness: 80, paragraph_target: 5, redundancy_tolerance: 10 },
    behaviorInstructions: ["每个清单项写清对象、判断动作和边界。", "相邻条目不能只是同一句话换词。"],
    evidenceStatus: "architecture_definition", safetyBoundary: "清单不能把不确定关系伪装为统一标准。",
  },
  {
    id: "reference_compact_70", label: "70篇样本中段形态（描述性）", description: "仅模拟样本长度分布中段，不代表更优。",
    noviceExplanation: "想测试接近参考样本的短标题、短正文形态时使用；它不是爆款公式。",
    parameterValues: { title_target_chars: 9, paragraph_target: 2, body_min_chars: 36, body_max_chars: 143 },
    behaviorInstructions: ["在当前70篇样本正文净文字的四分位区间约36—143字内保持一个人物事件和窄任务；空间不足时减少话题，不删除必要风险。", "标题样本中位数约8.5字只是描述性参照，准确性优先于凑字数。"],
    evidenceStatus: "sample_observation", safetyBoundary: "不得把样本分位数解释为质量阈值、平台偏好或推荐规律。",
  },
];

export const BUILT_IN_STYLE_PROFILES: readonly BuiltInStyleProfile[] = Object.freeze(STYLE_PROFILE_DATA);

const UNSAFE_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (UNSAFE_PATH_PARTS.has(part) || !isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(root: Record<string, unknown>, path: string, value: ParameterValue): void {
  const parts = path.split(".");
  let current = root;
  parts.forEach((part, index) => {
    if (UNSAFE_PATH_PARTS.has(part)) throw new Error(`Unsafe parameter path: ${path}`);
    if (index === parts.length - 1) current[part] = structuredClone(value);
    else {
      if (!isRecord(current[part])) current[part] = {};
      current = current[part] as Record<string, unknown>;
    }
  });
}

function assertParameterValue(definition: GenerationParameterDefinition, value: unknown): asserts value is ParameterValue {
  const kind = definition.control.kind;
  if ((kind === "slider" || kind === "number") && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${definition.id} must be a finite number.`);
  if ((kind === "slider" || kind === "number") && definition.control.min !== undefined && (value as number) < definition.control.min) throw new Error(`${definition.id} is below ${definition.control.min}.`);
  if ((kind === "slider" || kind === "number") && definition.control.max !== undefined && (value as number) > definition.control.max) throw new Error(`${definition.id} exceeds ${definition.control.max}.`);
  if (kind === "toggle" && typeof value !== "boolean") throw new Error(`${definition.id} must be boolean.`);
  if ((kind === "text" || kind === "select") && typeof value !== "string") throw new Error(`${definition.id} must be text.`);
  if ((kind === "text_list" || kind === "multi_select") && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) throw new Error(`${definition.id} must be a string array.`);
  if (kind === "select" && definition.control.options && !definition.control.options.some((option) => option.value === value)) throw new Error(`${definition.id} has an unsupported option.`);
}

function parameterMap(): Map<string, GenerationParameterDefinition> {
  return new Map(GENERATION_PARAMETER_REGISTRY.map((definition) => [definition.id, definition]));
}

function applyValues(
  config: Record<string, unknown>,
  values: Record<string, ParameterValue>,
  source: ParameterValueSource,
  sourceByParameter: Record<string, ParameterValueSource>,
): void {
  const definitions = parameterMap();
  for (const [id, value] of Object.entries(values)) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`Unknown generation parameter: ${id}`);
    assertParameterValue(definition, value);
    setPath(config, definition.path, value);
    sourceByParameter[id] = source;
  }
}

function findPreset(id: string | undefined): BuiltInGenerationPreset | undefined {
  if (!id) return undefined;
  const preset = BUILT_IN_GENERATION_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(`Unknown built-in generation preset: ${id}`);
  return preset;
}

function findStyle(id: string | undefined): BuiltInStyleProfile | undefined {
  if (!id) return undefined;
  const style = BUILT_IN_STYLE_PROFILES.find((item) => item.id === id);
  if (!style) throw new Error(`Unknown built-in style profile: ${id}`);
  return style;
}

/**
 * 当前配置下参数值不影响产出的确定性原因;不适用时返回 undefined。
 *
 * 只覆盖能从 config 100% 判定的情形,不做"大概没用"的猜测。语义边界:
 *  - 空转 ≠ 参数写错。滑杆本身接线正确,是上游开关或上下限把它的作用域压成了零。
 *  - 这里**不产生校验 error**。开关关闭时要求模型做多轮生长必然是假阳性
 *    (见 content.ts 的 P2-11 注释),所以空转只作为诚实告知,不作为约束。
 */
function inertReasonFor(id: string, config: ResolvedGenerationConfig): string | undefined {
  // 诊断强调滑杆按设计只排序人工检查清单,不进模型上下文也不进校验
  // (prompt.ts 的 isDisplayOnlyDiagnosticParameter 显式剔除)。
  if (id.startsWith("body_diagnostic_") || id.startsWith("comment_diagnostic_")) {
    return "仅控制人工检查清单的显示顺序，不进入模型上下文，也不参与校验。";
  }
  // 多轮生长三重门:engine.ts shouldGrowComments = 开关 && followUpDepth>0 && rate>0。
  const growthOff = config.content.commentMultiTurnGrowthEnabled !== true;
  const noFollowUp = config.content.followUpDepth <= 0;
  if (id === "comment_conversation_rate") {
    if (growthOff) return "「评论多轮接龙生长」开关关闭，多轮目标恒为 0，本滑杆当前不影响产出。";
    if (noFollowUp) return "追问深度为 0，没有可生长的轮次，本滑杆当前不影响产出。";
  }
  if (id === "comment_branching_strength" && (growthOff || noFollowUp)) {
    return "多轮接话未启用（生长开关关闭或追问深度为 0），延展强度当前没有作用对象。";
  }
  if (id === "follow_up_depth" && growthOff) {
    return "「评论多轮接龙生长」开关关闭，所有线程停在一问一答，追问深度当前不影响产出。";
  }
  if (id === "comment_expansion" && config.content.commentThreadMax - config.content.commentThreadMin <= 0) {
    return "问答线程上下限相同，展开力度没有可调空间，线程数已被上下限固定。";
  }
  return undefined;
}

function explicitBehavior(id: string, value: ParameterValue, config: ResolvedGenerationConfig): string[] {
  const numeric = typeof value === "number" ? value : undefined;
  switch (id) {
    case "audience_stage": return [`按“${config.task.audienceStage}”这一送达前阶段组织问题，不把它写成固定人格。`];
    case "entry_route": return [config.task.entry === "search" ? "搜索入口：标题和正文开头直接回应查询，不绕圈。" : "非搜索入口：先让读者识别与自己的相关性，再展开答案。"]; 
    case "information_gaps": return [`围绕 ${config.informationWindow.gaps.length || 1} 个明确缺口规划信息；每个缺口都要判断是否可答、是否有证据、放在哪个通道。`];
    case "must_mention": return [`必须在可见内容中准确包含：${config.task.mustMention.length ? config.task.mustMention.join("；") : "无额外指定项"}。`];
    case "forbidden_phrases": return [`所有通道禁止出现：${config.task.forbidden.length ? config.task.forbidden.join("；") : "无项目追加禁词"}。`];
    case "information_answers": return [`已有 ${config.informationWindow.answers.length} 条可用答案；只把能与缺口和来源对应的答案写成事实。`];
    case "evidence_requirements": return [`逐条执行证据要求：${config.informationWindow.evidenceRequirements.length ? config.informationWindow.evidenceRequirements.join("；") : "使用通用证据红线"}。`];
    case "reusable_frameworks": return [config.informationWindow.reusableFrameworks.length ? `在不挤压直接答案的前提下提供判断框架：${config.informationWindow.reusableFrameworks.join("；")}。` : "未指定额外判断框架，优先直接回答缺口。"]; 
    case "information_priorities": return [config.informationWindow.priorities.length ? `信息按以下优先顺序编排：${config.informationWindow.priorities.join("→")}。` : "按决策相关性、可答性和风险边界确定信息顺序。"]; 
    // 随实际边界条数分档:边界越多越要交代清楚放在哪儿,一条也没有时不能假装有。
    case "information_boundaries": return [config.informationWindow.boundaries.length === 0
      ? "本次没有额外披露的适用边界；不得自行编造限制条件，遇到无法判断的情形按未知处理。"
      : config.informationWindow.boundaries.length >= 3
        ? `需要交代 ${config.informationWindow.boundaries.length} 条适用条件与未知边界：逐条落在依赖它的结论附近，关键风险不得只藏在评论。`
        : "把适用条件和未知边界写进正文或对应回答；关键风险不得只藏在评论。"];
    case "expression_voice": return [`全篇使用“${config.expressionWindow.voice}”的口吻，但口吻不能改变证据身份。`];
    case "enabled_channels": return [`本次启用通道：${config.expressionWindow.channels.join("、")}；未启用的可选通道不分配信息，标题与正文为完整包必需。`];
    case "expression_forms": return [`优先使用这些表达形式：${config.expressionWindow.forms.join("、")}；不同形式不能重复计算同一信息。`];
    case "expression_sequence": return [`按“${config.expressionWindow.sequence.join("→")}”组织消费顺序，前提应出现在依赖它的结论之前。`];
    case "thread_style": return [`评论关系网参考“${config.expressionWindow.threadStyle}”，但可见层允许短反应、经验碎片、未回复评论和不对称分支；Stage/Gap/Source只留在后台。`];
    case "image_brief_enabled": return [config.content.imageBriefEnabled ? "生成图片信息任务并检查图题文承诺一致；图片建议不算已发生证据。" : "不生成图片方向，正文不能依赖图片补足必要信息。"]; 
    case "knowledge_mode": return [`知识上下文采用 ${config.knowledge.mode} 模式；无论披露多少，未进入上下文的事实都不能猜。`];
    case "model_temperature": return [`模型随机性为 ${config.model.temperature}；只允许表达变化，事实与硬约束保持一致。`];
    case "max_output_tokens": return [`模型完整JSON输出预算为 ${config.model.maxOutputTokens} tokens，不能把该预算当成正文长度目标。`];
    case "repair_attempts": return [`校验失败时最多局部修复 ${config.generation.maxRepairAttempts} 次，只重算受影响通道。`];
    case "require_evidence_references": return [config.diagnostics.requireEvidenceReferences ? "事实推理必须附可用evidenceId。" : "未强制每条事实带ID，但无依据内容仍不能写成事实。"]; 
    case "reject_unknown_as_fact": return [config.diagnostics.rejectUnknownAsFact ? "unknown不得以事实身份出现。" : "即使关闭自动拒绝，也必须显式标记未知身份。"]; 
    case "reject_prohibited_claims": return [config.diagnostics.rejectProhibitedClaims ? "命中禁止声明时拒绝候选并局部修复。" : "项目禁用检查关闭，但系统安全红线仍生效。"]; 
    case "warn_duplicate_information": return [config.diagnostics.warnDuplicateInformation ? "检查正文与评论逐字重复，跨通道呼应必须承担不同功能。" : "不做逐字重复警告，但同一证据仍只能计算一次增量。"]; 
    case "body_min_chars":
    case "body_max_chars": return [`正文控制在 ${config.content.bodyMinChars}—${config.content.bodyMaxChars} 字；字数只约束形态，不作为质量分。`];
    case "hashtag_count_min":
    case "hashtag_count_max": return [`输出 ${config.content.hashtagMin}—${config.content.hashtagMax} 个相关标签，只使用真实主题、地点或人群线索。`];
    case "comment_thread_min":
    case "comment_thread_max": return [`评论可读性目标为 ${config.content.commentThreadMin}—${config.content.commentThreadMax} 条；若独立PrimaryGap覆盖需要更多线程，按gapCoverageLedger扩容并给出capacityWarning，禁止截断缺口。`];
    case "follow_up_depth": return [`每条线程最多按目标深度 ${config.content.followUpDepth} 展开；只有残余缺口或新条件才追问。`];
    case "comment_multi_turn_growth": return [config.content.commentMultiTurnGrowthEnabled === true
      ? "允许被上一句具体词触发的线程生长追问；无自然话头不续。"
      : "根评论直接成稿。"];
    case "information_breadth": return [numeric! >= 70 ? "先广泛列出跨类别缺口，再只保留重要、可证、可回答的项；更多不是更好。" : numeric! <= 35 ? "集中解决最高优先级缺口，另列未覆盖项，不假装已经完整。" : "覆盖主缺口和少量长尾缺口，并按决策相关性筛选。"]; 
    case "decision_information_depth": return [numeric! >= 70 ? "重要答案同时给出依据、用户可复用的判断方法和适用边界。" : "优先给直接答案与最低必要依据，复杂分支放到条件问答。"]; 
    case "state_information_strength": return [numeric! >= 70 ? "用personaScenePlan的人物身份、阶段、关系和现实限制让读者一眼知道‘谁在什么处境’，不要把这些维度列成说明。" : "只露出一个最能解释当前行为的身份或阶段线索。"]; 
    case "experience_information_strength": return [numeric! >= 70 ? "用personaScenePlan中的普通事件、微动作、生活摩擦和情绪余味承载表达；创作场景不计作项目证据，且全篇时序自洽。" : "只保留一个生活动作或现场痕迹，不展开完整故事。"]; 
    case "body_completeness": return [numeric! >= 70 ? "正文把本篇人物事件讲完整，但仍只推进一个窄任务；项目知识不等于都要写进正文。" : numeric! <= 45 ? "正文只建立可识别人物、当下事件和一个可回答缺口；相邻信息由评论自然接住。" : "正文完成一条生活主线，评论展开人物、条件和选择细节。"]; 
    case "comment_expansion": return [numeric! >= 70 ? "评论参考范式覆盖正文后的主要残余缺口，每条回答相对正文必须有新增信息。" : "评论只保留少量高优先级条件问题，避免百科式堆叠。"]; 
    case "comment_conditionality": return [numeric! >= 70 ? "答案依赖个人情况时先问澄清条件，再给分支答案、反例或核验路径。" : "回答尽量直接，但明确哪些条件会改变结论。"]; 
    case "comment_role_diversity": return [numeric! >= 70 ? "从personaScenePlan.commentCast交叉选择同需求者、经验碎片者、谨慎反例、同城追问、共鸣者和服务承接者；让身份、关系、场景、动机和说话习惯真正改变句子。" : "保留少量社会位置差异，至少让提问者、经验者和楼主的声音可区分。"]; 
    case "comment_constraint_density": return [numeric! >= 70 ? "每个问题优先带入一至两个已披露且会改变答案的现实约束；没有来源就不添加。" : "每个问题最多保留一个必要约束，避免用假细节制造真实感。"]; 
    case "comment_gap_multiplexing": return [numeric! >= 70 ? "线程缺口公式：Gap=1×PrimaryGap＋Aux(0…2)；用完整口语句连接辅助维度，禁止关键词堆叠。" : numeric! <= 35 ? "线程缺口公式：Gap=1×PrimaryGap＋0×Aux，严格一问一事。" : "线程缺口公式：Gap=1×PrimaryGap＋Aux(0…1)，必要时只联动一个辅助维度。"]; 
    case "comment_reply_increment": return [numeric! >= 70 ? "评论整体必须持续新增信息，但单条回复只承担一个主要增量：答案、条件、反例、人物线索或下一步任选其一到两项；禁止每条装满五字段。" : "回复优先像真实接话，可只有确认、追问或半句条件，不用强行收束。"]; 
    case "question_compression": return [numeric! >= 70 ? "压缩的是surfaceRoleCard已经暗示的维度：让身份、场景和关系通过几个词被推断出来，而不是删掉人味后留下抽象关键词。" : "问题可多带半句生活上下文，但保持一个主要意思。"]; 
    case "comment_platform_register": return [numeric! >= 70 ? "平台语域偏强：按人物选择一处样本已有的自然称呼、语气词或圈内简称，不能每行都塞热词，也不能用规避审核的故意错字。" : numeric! <= 30 ? "平台语域偏弱：使用普通互联网口语，不强行加入圈内词；仍禁止FAQ和客服腔。" : "平台语域适中：少数角色可自然使用称呼、语气词或行动短语，其余人保持各自日常说法。"]; 
    case "comment_conversation_rate": return [`多轮目标：约 ${numeric}% 的根评论长出自然接话；这是整片评论区的分布范围，由已出现的话头决定具体线程，禁止逐条机械配额。`];
    case "comment_branching_strength": return [numeric! >= 70 ? "多轮接话可由上一句暴露的条件延伸一个相邻缺口、图片细节或现实安排；新点必须能指出触发词，不能凭空换题。" : "多轮接话主要澄清原问题，只在已有明显触发时延伸一个相邻点。"]; 
    case "comment_organic_variation": return [numeric! >= 70 ? "允许一至两个不承担答题的共鸣、质疑、看图反应或轻微岔开节点；评论顺序和长度保持不对称，避免整齐销售漏斗。" : "评论以信息补全为主，只保留少量自然反应；不要把每个节点都写成同构问答。"]; 
    case "comment_discovery_strength": return [numeric! >= 70 ? "把人物线索、经验差异和路由信息分散在不同评论节点，让读者通过浏览关系网自己拼出答案；必要风险仍直接说，不用统一Reveal模板。" : "以自然问答为主，只安排少量可以从上下文发现的线索。"]; 
    case "comment_inference_effort": return [numeric! > 70 ? "推断负荷过高：只允许moderate并输出warning；必须把推断简化为一步条件判断，避免让读者猜隐藏答案。" : numeric! >= 40 ? "推断难度为moderate：只做一步比较或条件判断，并在同线程揭示。" : "推断难度为low：线索后给出容易完成的一步判断，并立即揭示。"]; 
    case "comment_self_verification": return [numeric! >= 70 ? "揭示后给出具体SelfCheck：核对来源、适用条件、反例或仍缺输入，不能只问“懂了吗”。" : "揭示后保留一个最低必要自检问题或核验动作。"]; 
    // 硬约束本身恒定(发现感≠证据,任何档位不降低——方法论 §1726 独立硬约束),
    // 只有"未知要交代到多细"随值分档,否则滑杆对模型完全无信号。
    case "comment_false_closure_guard": return [numeric! >= 70
      ? "假闭合硬约束：发现感≠证据；缺答案或个体输入时只能标为awaiting_user_input/unknown_with_verification，并显式写出所需输入或核验路径。"
      : "假闭合硬约束：发现感≠证据；无证据结论仍不能写成事实，未知可用更简短的方式交代，不必每处重复核验路径。"];
    case "redundancy_tolerance": return [numeric! <= 30 ? "标签负责路由、正文负责共同前提、评论负责条件答案；同一证据不跨通道原样重复。" : "允许关键承诺跨通道呼应，但每次出现必须承担不同功能。"]; 
    case "evidence_strictness": return [numeric! >= 70 ? "只有知识库支持的内容可写成事实；缺证据就标为推理、猜想或unknown。" : "仍禁止无依据事实；可用更概括的措辞表达低风险推理并明确身份。"]; 
    case "boundary_visibility": return [numeric! >= 70 ? "限制条件、反例和信息不足要在相关结论附近可见，不放到读者难以找到的位置。" : "保留全部关键边界，非关键 caveat 可压缩表达。"]; 
    case "route_specificity": return [numeric! >= 70 ? "标签和标题明确主题、入口阶段及已知地点/对象，不碰无关热点。" : "路由表达保持较宽，但必须让目标读者识别主题。"]; 
    case "novelty_angle": return [numeric! >= 70 ? "优先寻找重要、可证且普遍内容没讲清的角度；无竞品证据时只称候选角度。" : "采用熟悉判断框架，避免为了不同而制造反常识结论。"]; 
    case "question_naturalness": return [numeric! >= 70 ? "先决定是谁、刚看到什么、为什么此刻开口，再写他会说的那一句；允许省略、语气词和不完整反应，禁止标准FAQ腔。" : "问法保持清楚，但仍与当前人物和场景一致。"]; 
    case "title_target_chars": return [`标题目标约 ${numeric} 字；准确表达入口承诺优先，不机械截断。`];
    case "paragraph_target": return [`正文目标约 ${numeric} 段，按逻辑换段，不为凑段数拆碎句子。`];
    default:
      if (id.startsWith("body_diagnostic_") || id.startsWith("comment_diagnostic_")) return [`“${id.replace(/^(body|comment)_diagnostic_/u, "")}”的显示/人工检查优先级为 ${numeric}；只改变清单排序，不改变阈值、状态、结论或生成内容。`];
      return [];
  }
}

function formulaContext(variables: Record<string, FormulaPrimitive>): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(variables)) {
    const parts = path.split(".");
    let current = context;
    parts.forEach((part, index) => {
      if (UNSAFE_PATH_PARTS.has(part)) return;
      if (index === parts.length - 1) current[part] = value;
      else {
        if (!isRecord(current[part])) current[part] = {};
        current = current[part] as Record<string, unknown>;
      }
    });
  }
  return context;
}

function compileFormulaResults(config: ResolvedGenerationConfig, version: FormulaVersion): ParameterImpactReport["formulaResults"] {
  const context = formulaContext(config.formula.variables);
  return version.formulas.filter((formula) => {
    if (!formula.expression) return false;
    const resolution = resolveFormulaExecution(formula, config.formula.enabledFormulaIds);
    return resolution.handlerState === "enabled" && resolution.effectiveHandlers.calculator.length > 0;
  }).map((formula) => {
    const result = evaluateFormulaDefinition(formula, context);
    const validationFailed = result.warnings.some((warning) => warning.startsWith("Validation error:"));
    return {
      formulaId: formula.id,
      title: formula.title,
      value: result.value,
      unknownPaths: result.unknownPaths,
      warnings: result.warnings,
      evidenceStatus: formula.evidenceStatus,
      ...(result.calculatorContract ? { calculatorContract: structuredClone(result.calculatorContract) } : {}),
      interpretation: result.value === null
        ? validationFailed
          ? "公式输入未通过校验，结果保持 unknown；请修正单位、范围、枚举、非空或类型问题后再进行手工情景计算。"
          : "公式输入不足，结果保持 unknown；不得用0.5、中间值或常识自动补齐。"
        : formula.id === "F30"
          ? `TrendFit 手工情景值为 ${String(result.value)}；它只表示当前所填热点对象下的未标定匹配情景，不参与生成、规划、选稿或校验，也不输出 qualifiedIncrementalReach。标签和热点词不能保证触达。`
          : `手工情景计算值为 ${String(result.value)}；它不参与生成、规划或选稿，也不自动等同于流量、质量或转化效果。`,
    };
  });
}

function hasEnabledHandler(
  version: FormulaVersion,
  enabledIds: readonly string[],
  formulaIds: readonly `F${string}`[],
  kind: "parameter" | "diagnostic",
): boolean {
  const byId = new Map(version.formulas.map((formula) => [formula.id, formula]));
  return formulaIds.some((formulaId) => {
    const formula = byId.get(formulaId);
    if (!formula) return false;
    const resolution = resolveFormulaExecution(formula, enabledIds);
    return resolution.handlerState === "enabled" && resolution.effectiveHandlers[kind].length > 0;
  });
}

function channelAllocation(config: ResolvedGenerationConfig): ParameterImpactReport["advisoryAllocationPreview"] {
  const rawGaps = config.informationWindow.gaps.length ? [...config.informationWindow.gaps] : [config.task.theme];
  const priority = config.informationWindow.priorities;
  const gaps = [
    ...priority.filter((item) => rawGaps.includes(item)),
    ...rawGaps.filter((item) => !priority.includes(item)),
  ];
  const completeness = config.parameters?.bodyCompleteness ?? DEFAULT_METHOD_PARAMETERS.bodyCompleteness;
  const commentsEnabled = config.expressionWindow.channels.includes("comments");
  const ratio = commentsEnabled ? (completeness >= 70 ? 0.75 : completeness <= 45 ? 0.35 : 0.55) : 1;
  const bodyCount = Math.max(1, Math.min(gaps.length, Math.ceil(gaps.length * ratio)));
  const bodyGaps = gaps.slice(0, bodyCount);
  const commentGaps = gaps.slice(bodyCount);
  const allocation = (channel: ContentChannel, purpose: string, constraints: string[]): ChannelInformationAllocation => ({ channel, purpose, information: [], constraints });
  const result: Record<ContentChannel, ChannelInformationAllocation> = {
    H: allocation("H", "帮助入口识别主题、地点和需求，不承担完整答案。", ["只用相关标签", "无实时平台数据时不承诺热点收益", "标签数量不是流量公式"]),
    "N.imageBrief": allocation("N.imageBrief", "让图片、标题和正文承诺一致，并承接可见证据。", ["不得建议伪造前后对比", "未知视觉事实不得生成", "图片方向不是实际图片证据"]),
    "N.title": allocation("N.title", "在入口预览中说清主问题或主承诺。", ["不夸大正文能回答的范围", "保留必要限定", "准确优先于目标字数"]),
    "N.body": allocation("N.body", "提供所有读者都需要的共同前提、核心答案和关键边界。", ["最小充分=Specific∧DecisionRelevant∧Answerable∧Findable", "关键风险不得故意留到评论", "状态真实感不等于低信息"]),
    Cref: allocation("Cref", "按需展开正文后的条件信息、长尾问题和比较分支。", ["最小线程=Stage/Gap/Function/Q/A/Follow-up/Next/Role/Source", "每条回答相对正文产生新增信息", "问答是参考模板，不伪装真实互动"]),
  };
  [config.task.theme, config.task.city, config.task.doctor, config.project.domain].filter((item): item is string => Boolean(item)).forEach((information) => result.H.information.push({ information, reason: "入口路由线索", critical: false, formulaIds: ["F19", "F20"] }));
  result["N.title"].information.push({ information: bodyGaps[0] ?? config.task.theme, reason: "入口首先承诺回答最高优先级缺口", critical: true, formulaIds: ["F04", "F19"] });
  result["N.imageBrief"].information.push({ information: `用可核验画面承接“${bodyGaps[0] ?? config.task.theme}”`, reason: "图、题、正文联合一致", critical: false, formulaIds: ["F07", "F19"] });
  bodyGaps.forEach((gap) => {
    const originalIndex = config.informationWindow.gaps.indexOf(gap);
    const answer = originalIndex >= 0 ? config.informationWindow.answers[originalIndex] : undefined;
    result["N.body"].information.push({ information: answer ? `${gap} → ${answer}` : gap, reason: "共同主线或高优先级缺口", critical: true, formulaIds: ["F04", "F09"] });
  });
  config.task.mustMention.forEach((information) => result["N.body"].information.push({ information, reason: "用户明确要求必须出现", critical: true, formulaIds: ["F25"] }));
  config.informationWindow.boundaries.forEach((information) => result["N.body"].information.push({ information, reason: "防止结论脱离适用范围", critical: true, formulaIds: ["F04", "F25"] }));
  config.informationWindow.reusableFrameworks.forEach((information) => result["N.body"].information.push({ information, reason: "帮助读者复用判断方法", critical: false, formulaIds: ["F04", "F17"] }));
  if (commentsEnabled) (commentGaps.length ? commentGaps : gaps.slice(-1)).forEach((gap) => {
    const originalIndex = config.informationWindow.gaps.indexOf(gap);
    const answer = originalIndex >= 0 ? config.informationWindow.answers[originalIndex] : undefined;
    result.Cref.information.push({ information: answer ? `${gap} → ${answer}` : gap, reason: "正文后的条件化残余缺口", critical: false, formulaIds: ["F09", "F10", "F22"] });
  });
  if (config.informationWindow.evidenceRequirements.length) {
    const requirement = `证据门槛：${config.informationWindow.evidenceRequirements.join("；")}`;
    result["N.body"].constraints.push(requirement);
    result.Cref.constraints.push(requirement);
  }
  return result;
}

function diagnosticReports(
  parameters: GenerationMethodParameters,
  version: FormulaVersion,
  enabledIds: readonly string[],
): DiagnosticProxyReport[] {
  const orderedComponents = (
    contract: FormulaDiagnosticContract,
    emphasisById: Record<string, number>,
  ): DiagnosticProxyComponent[] => {
    const canonicalOrder = new Map(contract.componentDefinitions.map((component, index) => [component.id, index]));
    const sorted = contract.componentDefinitions
      .map((component) => {
        const emphasis = emphasisById[component.id];
        if (typeof emphasis !== "number" || !Number.isFinite(emphasis)) {
          throw new Error(`Missing diagnostic display emphasis for ${component.id}; it cannot be coerced to zero.`);
        }
        return { component, emphasis };
      })
      .sort((left, right) => right.emphasis - left.emphasis
        || (canonicalOrder.get(left.component.id) ?? 0) - (canonicalOrder.get(right.component.id) ?? 0));
    let previousEmphasis: number | undefined;
    let manualReviewRank = 0;
    return sorted.map(({ component, emphasis }, index) => {
      if (previousEmphasis === undefined || emphasis !== previousEmphasis) manualReviewRank = index + 1;
      previousEmphasis = emphasis;
      return {
        id: component.id,
        label: component.label,
        emphasis,
        displayOrder: index + 1,
        manualReviewRank,
        emphasisSemantics: contract.emphasis.semantics,
        direction: component.direction,
        status: "unknown",
        evaluationStatus: "not_evaluated",
        value: null,
        source: { kind: "not_observed", reference: null },
        evidenceStatus: component.evidenceStatus,
        boundary: component.boundary,
      };
    });
  };
  const seeds = [
    {
      formulaId: "F32" as const,
      name: "正文分项检查清单",
      emphasisById: parameters.bodyDiagnosticEmphasis,
      warning: "正文分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分。",
    },
    {
      formulaId: "F33" as const,
      name: "评论分项检查清单",
      emphasisById: parameters.commentDiagnosticEmphasis,
      warning: "评论分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分；线程数和规则通过数不是质量分。",
    },
  ];
  const formulaById = new Map(version.formulas.map((formula) => [formula.id, formula]));
  return seeds.flatMap((seed): DiagnosticProxyReport[] => {
    const formula = formulaById.get(seed.formulaId);
    if (!formula?.diagnosticContract) return [];
    const resolution = resolveFormulaExecution(formula, enabledIds);
    if (resolution.handlerState !== "enabled" || resolution.effectiveHandlers.diagnostic.length === 0) return [];
    const contract = formula.diagnosticContract;
    return [{
      formulaId: seed.formulaId,
      formulaSemanticFingerprint: resolution.semanticFingerprint,
      name: seed.name,
      semantics: contract.semantics,
      status: "unknown",
      evaluationStatus: contract.evaluationStatus,
      aggregateValue: contract.aggregateValue,
      scoreProduced: contract.scoreProduced,
      evidenceStatus: "unvalidated_proxy",
      aggregation: contract.aggregation,
      components: orderedComponents(contract, seed.emphasisById),
      warning: seed.warning,
      diagnosticContract: structuredClone(contract),
    }];
  });
}

export function compileGenerationParameters(
  inputConfig: ResolvedGenerationConfig,
  formulaVersion: FormulaVersion,
  selection: GenerationParameterSelection = {},
): ParameterCompilationResult {
  const config = structuredClone(inputConfig);
  const configRecord = config as unknown as Record<string, unknown>;
  const sourceByParameter: Record<string, ParameterValueSource> = {};
  for (const definition of GENERATION_PARAMETER_REGISTRY) {
    const existing = getPath(configRecord, definition.path);
    if (existing === undefined) {
      setPath(configRecord, definition.path, definition.defaultValue);
      sourceByParameter[definition.id] = { source: "default" };
    } else {
      assertParameterValue(definition, existing);
      sourceByParameter[definition.id] = { source: "config" };
    }
  }
  const preset = findPreset(selection.presetId);
  const style = findStyle(selection.styleProfileId);
  if (preset) applyValues(configRecord, preset.parameterValues, { source: "preset", sourceId: preset.id }, sourceByParameter);
  if (style) applyValues(configRecord, style.parameterValues, { source: "style_profile", sourceId: style.id }, sourceByParameter);
  if (selection.overrides) applyValues(configRecord, selection.overrides, { source: "override" }, sourceByParameter);
  const enabledChannels = new Set(config.expressionWindow.channels);
  if (!enabledChannels.has("title") || !enabledChannels.has("body")) throw new Error("Complete content packages require title and body channels.");
  if (!enabledChannels.has("hashtags")) {
    config.content.hashtagMin = 0;
    config.content.hashtagMax = 0;
  }
  if (!enabledChannels.has("image")) config.content.imageBriefEnabled = false;
  if (!enabledChannels.has("comments")) {
    config.content.commentThreadMin = 0;
    config.content.commentThreadMax = 0;
  }
  if (config.content.bodyMinChars > config.content.bodyMaxChars) throw new Error("Compiled bodyMinChars cannot exceed bodyMaxChars.");
  if (config.content.hashtagMin > config.content.hashtagMax) throw new Error("Compiled hashtagMin cannot exceed hashtagMax.");
  if (config.content.commentThreadMin > config.content.commentThreadMax) throw new Error("Compiled commentThreadMin cannot exceed commentThreadMax.");
  const values: Record<string, ParameterValue> = {};
  const traces: ParameterImpactTrace[] = GENERATION_PARAMETER_REGISTRY.map((definition) => {
    const value = getPath(configRecord, definition.path);
    assertParameterValue(definition, value);
    values[definition.id] = structuredClone(value);
    const inertReason = inertReasonFor(definition.id, config);
    return {
      parameterId: definition.id,
      path: definition.path,
      label: definition.label,
      value: structuredClone(value),
      source: sourceByParameter[definition.id] ?? { source: "default" },
      ...(inertReason ? { inertReason } : {}),
      // 空转参数不再下发写作指令:开关关闭时告诉模型"约 60% 的根评论要长出接话"
      // 是一句它无法执行的话,只会稀释上下文。原因改由 inertReason 诚实告知用户。
      behaviorInstructions: inertReason === undefined && hasEnabledHandler(
        formulaVersion,
        config.formula.enabledFormulaIds,
        definition.formulaIds,
        "parameter",
      ) ? explicitBehavior(definition.id, value, config) : [],
      formulaIds: definition.formulaIds,
      channels: definition.channels,
      evidenceStatus: definition.evidenceStatus,
      evidenceNote: definition.evidenceNote,
    };
  });
  const resolutionSnapshot: ParameterResolutionSnapshot = {
    schemaVersion: "1.0",
    presetId: preset?.id,
    styleProfileId: style?.id,
    values,
    sourceByParameter,
  };
  // Preset/style prose is a drafting instruction, so it follows the direct
  // prompt dispatcher rather than becoming active because an unrelated
  // calculator or diagnostic happens to be enabled.
  const hasExecutablePromptMethod = formulaVersion.formulas.some((formula) => {
    const resolution = resolveFormulaExecution(formula, config.formula.enabledFormulaIds);
    return resolution.handlerState === "enabled" && resolution.effectiveHandlers.prompt.length > 0;
  });
  const behaviorInstructions = [
    ...(hasExecutablePromptMethod ? (preset?.behaviorInstructions ?? []) : []),
    ...(hasExecutablePromptMethod ? (style?.behaviorInstructions ?? []) : []),
    ...(hasExecutablePromptMethod && style ? [style.safetyBoundary] : []),
    ...traces.flatMap((trace) => trace.behaviorInstructions),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const impactReport: ParameterImpactReport = {
    schemaVersion: "1.0",
    behaviorInstructions,
    formulaResults: compileFormulaResults(config, formulaVersion),
    advisoryAllocationPreview: channelAllocation(config),
    parameterTraces: traces,
    diagnosticProxies: diagnosticReports(config.parameters!, formulaVersion, config.formula.enabledFormulaIds),
    baselineReferences: [structuredClone(CONFIRMED_REFERENCE_SAMPLE_BASELINE)],
    warnings: [
      "70篇统计只描述样本形态，不是质量、推荐或转化规律；提示词不包含70篇原文。",
      "F32/F33 只输出有来源边界的 unknown/null 分项，并按显示/人工检查优先级排序；不计算总分。",
      "通道分配是可解释的生产规则，不是已验证的因果最优解。",
      ...(config.parameters!.commentInferenceEffort > 70
        ? ["评论推断难度高于70：只能按moderate执行并简化为一步推断；高难度不等于高质量。"]
        : []),
    ],
  };
  return { config, resolutionSnapshot, impactReport };
}

export function buildParameterDiagnostics(report: ParameterImpactReport): ContentDiagnostic[] {
  return report.diagnosticProxies.map((proxy) => ({
    formulaId: proxy.formulaId,
    formulaSemanticFingerprint: proxy.formulaSemanticFingerprint,
    name: proxy.name,
    status: "unknown",
    explanation: proxy.warning,
    semantics: proxy.semantics,
    evaluationStatus: proxy.evaluationStatus,
    aggregateValue: proxy.aggregateValue,
    scoreProduced: proxy.scoreProduced,
    parameterIds: proxy.components.map((component) => `${proxy.formulaId === "F32" ? "body" : "comment"}_diagnostic_${component.id}`),
    channels: proxy.formulaId === "F32" ? ["N.imageBrief", "N.title", "N.body"] : ["Cref"],
    evidenceStatus: proxy.evidenceStatus,
    aggregation: "components_only",
    components: proxy.components,
    diagnosticContract: proxy.diagnosticContract,
  }));
}

export function parameterInstructionsForChannels(report: ParameterImpactReport, channels: ContentChannel[]): string[] {
  const selected = new Set(channels);
  return report.parameterTraces
    .filter((trace) => trace.channels.some((channel) => selected.has(channel)))
    .flatMap((trace) => trace.behaviorInstructions)
    .filter((value, index, all) => all.indexOf(value) === index);
}

/** parameterId → commentStage 的归属索引(单一真源是 COMMENT_STAGE_BY_ID)。 */
const COMMENT_STAGE_BY_PARAMETER_ID = new Map(
  GENERATION_PARAMETER_REGISTRY
    .filter((definition) => definition.commentStage)
    .map((definition) => [definition.id, definition.commentStage!]),
);

/**
 * 评论阶段的参数行为指令(2A-R 读者侧 / 2A-O·2B-O 答复侧)。
 *
 * 只取 trace 级的逐参数执行指令,**不含 preset/style 散文**——散文是整篇作文的
 * 编排口径,天然跨身份(例如 search_decision 预设里有"避免单个楼主回复包办全部
 * 信息"),把它塞进单一身份的调用等于把另一侧的角色概念漏过去,正是旧串台根因。
 *
 * 归属只认 commentStage,不叠加"channels 含 Cref":两者正交。channels 决定"指令
 * 在哪个通道展示",commentStage 决定"注入哪个评论子阶段"。experience_information_
 * strength 的 channels 是 [N.imageBrief, N.body] 却属读者侧,按 channel 过滤会漏。
 *
 * 计划语言脱敏:指令原文含 personaScenePlan / surfaceRoleCard 这类内部字段名
 * (state_information_strength、experience_information_strength、question_
 * compression 在默认档位就命中)。stage1 有全量 task_data,字段名在那里是有效
 * 指代;但隔离的评论调用刻意不给这些结构,把字段名递进去等于把计划语言交给模型
 * ——comment_plan_language_surface_leak / internal_audit_artifact_visible 两个
 * 校验器存在的理由正是模型会照抄它们。因此只在评论阶段这条路径上换成人话指代。
 */
const PLAN_LANGUAGE_SUBSTITUTIONS: ReadonlyArray<[RegExp, string]> = [
  [/personaScenePlan(?:中|的)?/gu, "所分配人物"],
  [/surfaceRoleCard(?:中|的)?/gu, "所分配人物"],
  [/commentCast(?:中|的)?/gu, "角色池"],
];

function withoutPlanLanguage(instruction: string): string {
  return PLAN_LANGUAGE_SUBSTITUTIONS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    instruction,
  );
}

export function commentStageInstructions(
  report: ParameterImpactReport | undefined,
  stage: "reader" | "answer",
): string[] {
  return (report?.parameterTraces ?? [])
    .filter((trace) => {
      const owner = COMMENT_STAGE_BY_PARAMETER_ID.get(trace.parameterId);
      return owner === stage || owner === "both";
    })
    .flatMap((trace) => trace.behaviorInstructions)
    .map(withoutPlanLanguage)
    .filter((value, index, all) => all.indexOf(value) === index);
}

/** Immutable runtime snapshot identity used by release manifests. */
export const PARAMETER_POLICY_VERSION = "1.0.0";
export const PARAMETER_POLICY_DIGEST = createHash("sha256")
  .update(JSON.stringify({
    version: PARAMETER_POLICY_VERSION,
    registry: GENERATION_PARAMETER_REGISTRY,
    presets: BUILT_IN_GENERATION_PRESETS,
    styleProfiles: BUILT_IN_STYLE_PROFILES,
    defaults: DEFAULT_METHOD_PARAMETERS,
  }), "utf8")
  .digest("hex");
