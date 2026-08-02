import { DEFAULT_HARNESS_METHOD_ID, HARNESS_METHOD_PROFILES, getHarnessMethodProfile, type HarnessMethodId } from '@content-agent/agent-harness-core/methods';
import type { AgentHarnessCreateInput } from '../types.js';

export type HarnessIntentId = 'decision' | 'misunderstanding' | 'checklist' | 'project_value';
export type HarnessAudienceStageId = 'collecting' | 'discovering' | 'comparing' | 'hesitating' | 'ready';

export interface HarnessQuickOption<T extends string> {
  id: T;
  title: string;
  description: string;
  recommended?: boolean;
}

export const HARNESS_INTENTS: readonly HarnessQuickOption<HarnessIntentId>[] = [
  { id: 'decision', title: '帮读者做决定', description: '讲清影响判断的条件，让读者知道下一步先核验什么', recommended: true },
  { id: 'misunderstanding', title: '讲清一个误区', description: '从常见误解切入，给出更稳妥的判断方式' },
  { id: 'checklist', title: '给一份行动清单', description: '把复杂问题拆成可以逐项照着做的步骤' },
  { id: 'project_value', title: '讲出项目价值', description: '从真实资料里找一个具体特色，不写空泛宣传' },
] as const;

export const HARNESS_AUDIENCE_STAGES: readonly HarnessQuickOption<HarnessAudienceStageId>[] = [
  { id: 'collecting', title: '正在收集信息', description: '已经注意到问题，想先把共同信息和条件补齐', recommended: true },
  { id: 'discovering', title: '刚开始了解', description: '还不知道该先看什么，需要建立基本判断框架' },
  { id: 'comparing', title: '正在比较判断', description: '已经知道一些信息，但拿不准差异和取舍' },
  { id: 'hesitating', title: '有倾向但还在犹豫', description: '担心选错，需要补风险、边界和会改变决定的信息' },
  { id: 'ready', title: '准备采取下一步', description: '需要行动前核验路径，降低实际选择成本' },
] as const;

const INTENT_SETTINGS: Record<HarnessIntentId, Pick<AgentHarnessCreateInput, 'goal' | 'tone' | 'callToAction'>> = {
  decision: {
    goal: '帮助读者看懂会改变判断的关键条件，并知道下一步先核验什么。',
    tone: '口语、克制、具体，不制造焦虑，不替读者下结论。',
    callToAction: '引导读者对照自身情况，先补齐一个会改变决定的关键信息。',
  },
  misunderstanding: {
    goal: '指出一个有资料依据的常见误区，并给出更可靠的判断方法。',
    tone: '反常识但不夸张，先共情再纠偏，不制造对立。',
    callToAction: '邀请读者先检查自己是否忽略了关键条件，再继续判断。',
  },
  checklist: {
    goal: '把复杂问题整理成读者可以直接照着核验的行动清单。',
    tone: '清楚、简洁、有步骤感，每一步都能执行。',
    callToAction: '邀请读者保存清单，并从第一项开始核验。',
  },
  project_value: {
    goal: '从项目真实资料中找到一个具体、有证据支持且对读者有用的价值点。',
    tone: '真实、具体、少形容词，不写无法证明的优势或效果。',
    callToAction: '引导读者围绕这个价值点提出自己的具体条件或问题。',
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
  const intentId = input.intentId ?? 'decision';
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
    bodyLength: methodProfile.bodyLength,
    publishingNotes: '优先形成一个无需额外解释即可审阅的完整发布包；平台合规与终稿校对保留人工复核。',
    ...INTENT_SETTINGS[intentId],
    ...AUDIENCE_SETTINGS[audienceStageId],
    imageAssetIds: input.useApprovedImages === false ? [] : [...(input.approvedImageAssetIds ?? [])].slice(0, 12),
    ...input.overrides,
  };
}
