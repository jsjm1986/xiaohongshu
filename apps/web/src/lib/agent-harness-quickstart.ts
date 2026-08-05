import { DEFAULT_HARNESS_METHOD_ID, HARNESS_METHOD_PROFILES, getHarnessMethodProfile, type HarnessMethodId } from '@content-agent/agent-harness-core/methods';
import type { AgentHarnessCreateInput } from '../types.js';

/*
 * 创作体裁。取自用户 67 篇真实对标语料(按笔记链接去重)的实测形态分布,
 * 不是方法论推演出来的分类。
 *
 * 换掉旧四项(decision / misunderstanding / checklist / project_value)的原因:
 * 那四项全是方法论导向 —— checklist 的 CTA 直接写着「邀请读者保存清单,并从第一项
 * 开始核验」,而语料里「清单/核验/避坑/对照/思路」在标题与正文合计只命中 1 篇
 * (那 1 篇是正文里的「攻略」),没有一篇是清单帖。意图本身在要求方法论,
 * 所以下游放开多少约束都没用。
 *
 * 语料实测占比(按标题+正文特征归类,n=67):
 *   求助/讨论 15%、面诊/记录 10%、劝退/被拒 7%、结果/感受 7%,其余约 60% 是日常记录。
 * 日常记录这一档占比最大却在前一版方案里没有对应项,故单独立项 —— 否则最常见的
 * 那种形态没有入口可选。
 */
export type HarnessIntentId = 'ask_peers' | 'consult_log' | 'turned_away' | 'after_feeling' | 'daily_log';
export type HarnessAudienceStageId = 'collecting' | 'discovering' | 'comparing' | 'hesitating' | 'ready';

export interface HarnessQuickOption<T extends string> {
  id: T;
  title: string;
  description: string;
  recommended?: boolean;
}

export const HARNESS_INTENTS: readonly HarnessQuickOption<HarnessIntentId>[] = [
  { id: 'ask_peers', title: '求问过来人', description: '用一个具体的窄问题起帖，答案留给评论区补', recommended: true },
  { id: 'consult_log', title: '面诊/看诊记录', description: '记录去了哪、聊了什么、当场判断了什么' },
  { id: 'turned_away', title: '被劝退或没做', description: '本来要做却被拦下来，用真实经过反向说明判断' },
  { id: 'after_feeling', title: '做完的感受', description: '一个具体生活片段里的变化，不写方法不写参数' },
  { id: 'daily_log', title: '日常记录', description: '就记一笔当天的状态或一个小场景，不给结论' },
] as const;

export const HARNESS_AUDIENCE_STAGES: readonly HarnessQuickOption<HarnessAudienceStageId>[] = [
  { id: 'collecting', title: '正在收集信息', description: '已经注意到问题，想先把共同信息和条件补齐', recommended: true },
  { id: 'discovering', title: '刚开始了解', description: '还不知道该先看什么，需要建立基本判断框架' },
  { id: 'comparing', title: '正在比较判断', description: '已经知道一些信息，但拿不准差异和取舍' },
  { id: 'hesitating', title: '有倾向但还在犹豫', description: '担心选错，需要补风险、边界和会改变决定的信息' },
  { id: 'ready', title: '准备采取下一步', description: '需要行动前核验路径，降低实际选择成本' },
] as const;

/*
 * 每个体裁的目标/语气/收尾。
 *
 * callToAction 一律不含「保存清单/逐项核验/对照着问」这类措辞:67 篇语料里
 * 「清单」「核验」「对照」「避坑」「思路」「标准」出现 0 次(只有「攻略」1 次,
 * 且在正文而非标题)。原 checklist 意图的收尾直接写着「邀请读者保存清单，并从第一项
 * 开始核验」,那是产出读起来像策划案的直接来源之一。
 */
const INTENT_SETTINGS: Record<HarnessIntentId, Pick<AgentHarnessCreateInput, 'goal' | 'tone' | 'callToAction'>> = {
  ask_peers: {
    goal: '用一个具体的窄问题起帖，让有经验的人在评论区把答案补出来。',
    tone: '口语、短、像随手发的，一句话说清自己卡在哪。',
    callToAction: '自然收尾，可以直接把问题再问一次，不引导保存或收藏。',
  },
  consult_log: {
    goal: '记录一次面诊或看诊的真实经过：去了哪、对方说了什么、自己当场怎么想。',
    tone: '像发日记，按时间顺序说，细节具体但不做总结。',
    callToAction: '停在还没决定的地方，不给行动清单。',
  },
  turned_away: {
    goal: '写一次本来要做却没做成的经过，让读者自己看出判断标准。',
    tone: '有情绪但不抱怨，讲事实不讲道理。',
    callToAction: '停在自己也还没想明白的地方，不替读者下结论。',
  },
  after_feeling: {
    goal: '从一个具体生活片段切入，讲状态变化，不讲方法和参数。',
    tone: '轻、具体、有画面，像随手记一笔。',
    callToAction: '一句自然的感受收尾，不邀请咨询也不引导互动。',
  },
  daily_log: {
    goal: '记一笔当天的真实状态或一个小场景，不追求完整，也不给读者结论。',
    tone: '短、随手、有当天的具体细节，像发给熟人看的。',
    callToAction: '写完就停，不总结也不邀请任何动作。',
  },
};

const AUDIENCE_SETTINGS: Record<HarnessAudienceStageId, Pick<AgentHarnessCreateInput, 'audience'>> = {
  collecting: { audience: '正在收集信息、希望先补齐共同事实与条件的读者' },
  discovering: { audience: '刚开始了解、还不知道先看什么的读者' },
  comparing: { audience: '正在比较信息、拿不准差异和取舍的读者' },
  hesitating: { audience: '已经有倾向但担心选错、需要补风险与边界的读者' },
  ready: { audience: '准备采取下一步、需要行动前核验的读者' },
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** 可编辑组合框的推荐值；选中后仍由普通输入框承载，不形成封闭枚举。 */
export const HARNESS_FINE_TUNE_SUGGESTIONS = Object.freeze({
  goals: unique(Object.values(INTENT_SETTINGS).map((item) => item.goal ?? '').filter(Boolean)),
  audiences: unique(Object.values(AUDIENCE_SETTINGS).map((item) => item.audience ?? '').filter(Boolean)),
  entryPoints: unique([
    ...HARNESS_METHOD_PROFILES.map((item) => item.entryPoint),
    '搜索或比较决策场景', '推荐流中的首次触达', '主页承接与行动前复查',
  ]),
  accountIdentities: ['品牌官方账号', '项目官方账号', '主理人账号', '专业人员账号', '内容编辑 / 运营账号'],
  tones: unique(Object.values(INTENT_SETTINGS).map((item) => item.tone ?? '').filter(Boolean)),
  callsToAction: unique(Object.values(INTENT_SETTINGS).map((item) => item.callToAction ?? '').filter(Boolean)),
  publishingNotes: [
    '优先形成一个无需额外解释即可审阅的完整发布包；平台合规与终稿校对保留人工复核。',
    '正文先讲共同主线，个体条件与追问放到评论区展开。',
    '不设置明确排期；信息仍有效且完成终稿复核后再发布。',
    '互动目标是收集读者仍未解决的具体问题，不诱导虚假互动。',
  ],
});

export interface ResolveHarnessQuickStartInput {
  projectId: string;
  intentId?: HarnessIntentId;
  methodProfileId?: HarnessMethodId;
  audienceStageId?: HarnessAudienceStageId;
  customTopic?: string;
  useCustomTopic?: boolean;
  approvedImageAssetIds?: readonly string[];
  useApprovedImages?: boolean;
  overrides?: Partial<AgentHarnessCreateInput>;
}

export function resolveHarnessQuickStart(input: ResolveHarnessQuickStartInput): AgentHarnessCreateInput {
  const intentId = input.intentId ?? 'ask_peers';
  const methodProfile = getHarnessMethodProfile(input.methodProfileId ?? DEFAULT_HARNESS_METHOD_ID);
  const audienceStageId = input.audienceStageId ?? methodProfile.audienceStage;
  const intent = HARNESS_INTENTS.find((item) => item.id === intentId)!;
  const customTopic = input.customTopic?.trim();
  const topic = input.useCustomTopic && customTopic ? customTopic : undefined;
  return {
    projectId: input.projectId,
    ...(topic ? { topic } : {}),
    topicMode: input.useCustomTopic && customTopic ? 'user_defined' : 'agent_discovery',
    creativeIntent: intentId,
    methodProfileId: methodProfile.id,
    audienceStage: audienceStageId,
    entryPoint: methodProfile.entryPoint,
    /*
     * 五个体裁一律走 short，不再按方法档取值。
     *
     * 依据：67 篇语料正文（去空白后）中位 74 字，落在 short 档；
     * 换成 medium/long 会把下限抬到 120 字以上，模型只能靠补方法论段落填满，
     * 那恰好是本次要消掉的形状。
     */
    bodyLength: 'short',
    publishingNotes: '主文案必须是短、口语、有发布感的成品；SLA、证据编号、审核状态和运营规则只放审计字段，不写进标题、正文、图片叠字或 CTA。',
    ...INTENT_SETTINGS[intentId],
    ...AUDIENCE_SETTINGS[audienceStageId],
    imageAssetIds: input.useApprovedImages === false ? [] : [...(input.approvedImageAssetIds ?? [])].slice(0, 12),
    ...input.overrides,
  };
}
