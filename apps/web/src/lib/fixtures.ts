import type { AppSettings, Candidate, FormulaVersion, GenerationJob, KnowledgeFile, Project, User } from '../types';
import { diagnosticsFromValidationIssues } from './generation-record';

export const demoUser: User = {
  id: 'demo-user',
  username: 'admin',
  displayName: '内容管理员',
  role: '工作区管理员',
};

export const demoProjects: Project[] = [
  {
    id: 'eyebag-default',
    name: '去眼袋项目',
    description: '面向正在了解去眼袋方案的小红书用户',
    domain: '医疗美容',
    status: 'active',
    knowledgeCount: 12,
    generationCount: 48,
    activeFormulaVersion: 'v3.1',
    updatedAt: '2026-07-12T08:30:00Z',
    cities: ['北京', '上海', '广州'],
    doctors: [{ name: '示例医生' }],
  },
  {
    id: 'skin-care',
    name: '皮肤管理内容库',
    description: '皮肤状态管理与项目选择内容',
    domain: '护肤',
    status: 'active',
    knowledgeCount: 7,
    generationCount: 19,
    activeFormulaVersion: 'v1.2',
    updatedAt: '2026-07-10T03:20:00Z',
  },
];

export const demoKnowledge: KnowledgeFile[] = [
  { id: 'k1', projectId: 'eyebag-default', name: 'INDEX.md', category: '知识地图', kind: '方法论推理', size: 4832, status: 'ready', version: 4, updatedAt: '2026-07-12T07:00:00Z', summary: '项目知识导航与渐进式阅读顺序' },
  { id: 'k2', projectId: 'eyebag-default', name: '项目信息.md', category: '产品与机构', kind: '已知事实', size: 18240, status: 'ready', version: 2, updatedAt: '2026-07-11T12:20:00Z', summary: '可用的项目特点、城市与医生信息' },
  { id: 'k3', projectId: 'eyebag-default', name: '70篇参考样本.md', category: '案例样本', kind: '案例样本', size: 215894, status: 'ready', version: 1, updatedAt: '2026-07-10T16:45:00Z', summary: '已采集内容的表达模式样本，不代表效果事实' },
  { id: 'k4', projectId: 'eyebag-default', name: '禁止表达.txt', category: '约束', kind: '禁止表达', size: 2630, status: 'ready', version: 3, updatedAt: '2026-07-09T08:15:00Z', summary: '风险词、不可承诺项与表达边界' },
];

export const demoFormulas: FormulaVersion[] = [
  { id: 'f31', projectId: 'eyebag-default', version: 'v3.1', name: '完整文案公式', description: '信息缺口 × 表达窗口 × 内容分配的当前稳定版', status: 'active', formulaCount: 37, createdAt: '2026-07-12T03:10:00Z', activatedAt: '2026-07-12T06:00:00Z' },
  { id: 'f30', projectId: 'eyebag-default', version: 'v3.0', name: '完整文案公式', description: '增加评论区信息补全与警惕性变化', status: 'archived', formulaCount: 34, createdAt: '2026-07-10T03:10:00Z', activatedAt: '2026-07-10T05:00:00Z' },
  { id: 'f32', projectId: 'eyebag-default', version: 'v3.2-draft', name: '完整文案公式', description: '正在验证标签入口和认知截断变量', status: 'draft', formulaCount: 39, createdAt: '2026-07-12T09:00:00Z' },
];

function demoValidation(warning?: string): Pick<Candidate, 'score' | 'validationHeuristic' | 'validation' | 'diagnostics'> {
  const warningCount = warning ? 1 : 0;
  const value = 100 - warningCount * 5;
  const issues: NonNullable<Candidate['validation']>['issues'] = warning
    ? [{ code: 'demo_manual_review', severity: 'warning', message: warning }]
    : [];
  return {
    score: value,
    validationHeuristic: {
      schemaVersion: '1.0', kind: 'validation_issue_count_heuristic', semantics: 'non_quality_score', status: 'computed', value, range: [0, 100],
      inputs: { errorCount: 0, warningCount, errorPenalty: 25, warningPenalty: 5 }, evidenceStatus: 'operational_heuristic', calibrated: false,
      predicts: { quality: false, effect: false }, excludes: { formulaIds: ['F32', 'F33'], diagnosticProxies: true, emphasis: true, missingValues: true },
      consumedBy: { generation: false, planning: false, selection: false, validation: false },
    },
    validation: { valid: true, repairAttempts: 0, issues },
    diagnostics: diagnosticsFromValidationIssues(issues),
  };
}

const demoCandidates = [
  {
    id: 'c1', label: '信息补全型', title: '去眼袋之前，我最想问清的其实是这 5 件事', ...demoValidation(),
    body: '一开始我也以为，去眼袋只要问“做哪种”就够了。\n\n真正开始收集信息后，才发现自己缺的不是一个答案，而是一套判断顺序：眼下问题属于哪种情况、适合什么方案、恢复期如何安排、哪些风险需要提前确认。\n\n与其只看一个结果，不如先把这些信息问全。每个人的情况不同，具体方案还是需要专业评估。',
    tags: ['#去眼袋', '#眼袋改善', '#项目功课', '#术前准备'],
    comments: [{ question: '面诊的时候最应该先问什么？', answer: '可以先确认问题类型和判断依据，再问可选方案与各自边界。', purpose: '补全决策顺序' }, { question: '恢复期怎么留时间比较稳妥？', answer: '不同方案差异较大，建议把工作强度、重要日期一起告诉医生后再计划。', purpose: '补全时间成本' }],
    imageBrief: '首图用清楚的“5 个必问问题”大字卡，配一张自然光正面照。',
    sources: [{ name: '项目信息.md', detail: '项目边界与面诊要点' }, { name: '禁止表达.txt', detail: '承诺词边界' }], unknowns: ['用户具体眼下状态未知'], conflicts: [],
  },
  {
    id: 'c2', label: '经历叙事型', title: '做功课的第 12 天，我终于不再只看前后对比', ...demoValidation(),
    body: '连续看了很多笔记之后，我发现最容易忽略的，是照片之外的信息。\n\n对比图能让人快速建立期待，却不能替我判断：自己是否适合、会经历什么、选择依据是什么。\n\n所以我重新做了一张问题清单。先判断，再比较，最后才决定。如果你也正在做功课，评论区里我把问题顺序整理了一下。',
    tags: ['#去眼袋功课', '#医美小白', '#我的功课记录'],
    comments: [{ question: '你的问题清单有哪些？', answer: '我按“判断依据—可选方案—恢复安排—风险边界”四类来问。', purpose: '承接正文悬念' }],
    imageBrief: '手写功课清单与电脑桌面的真实感画面，不使用夸张对比。', sources: [{ name: '70篇参考样本.md', detail: '经历叙事表达参考' }], unknowns: [], conflicts: [],
  },
  {
    id: 'c3', label: '认知重构型', title: '别急着问“哪个方案好”，你可能少了前面这一步', ...demoValidation('正文略偏理性，可增加一个具体场景'),
    body: '很多选择困难，不是因为方案太多，而是问题还没被说清楚。\n\n当我们直接比较方案，实际上默认了“自己已经知道问题是什么”。但眼下外观可能由不同因素共同造成，个体差异也会影响选择。\n\n更有用的顺序是：先把当下情况判断清楚，再讨论可选路径。这不会立刻给你一个答案，却会让后面的每个问题都更准。',
    tags: ['#去眼袋怎么选', '#眼周问题', '#理性做功课'],
    comments: [{ question: '怎么判断自己属于哪种情况？', answer: '网络内容可以用来建立问题清单，但不适合替代个体评估。可以请专业人员说明判断依据。', purpose: '明确自测边界' }],
    imageBrief: '用简洁的流程图表达“判断 → 比较 → 决定”，留白充足。', sources: [{ name: 'INDEX.md', detail: '判断先于方案比较' }], unknowns: ['对应用户的具体问题类型未知'], conflicts: [],
  },
];

export const demoGenerations: GenerationJob[] = [
  { id: 'g-demo', projectId: 'eyebag-default', projectName: '去眼袋项目', topic: '第一次做去眼袋功课应该问什么', goal: '帮助犹豫期用户建立判断顺序', mode: 'simple', status: 'completed', progress: 100, seed: '823591', formulaVersion: 'v3.1', createdAt: '2026-07-12T08:34:00Z', completedAt: '2026-07-12T08:35:24Z', candidates: demoCandidates },
  { id: 'g2', projectId: 'eyebag-default', projectName: '去眼袋项目', topic: '恢复期的信息补全', mode: 'advanced', status: 'completed', progress: 100, seed: '129883', formulaVersion: 'v3.1', createdAt: '2026-07-11T11:12:00Z', completedAt: '2026-07-11T11:13:36Z', candidates: demoCandidates },
  { id: 'g3', projectId: 'skin-care', projectName: '皮肤管理内容库', topic: '第一次项目前的准备', mode: 'simple', status: 'failed', progress: 41, createdAt: '2026-07-10T04:00:00Z', error: '模型请求超时' },
];

export const demoSettings: AppSettings = {
  providerMode: 'platform', provider: 'OpenAI Compatible', model: 'gpt-5', monthlyQuota: 500, quotaUsed: 138, defaultTemperature: 0.75,
};
