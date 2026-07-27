import type { Candidate, CommentThread, GenerateInput, GenerationJob, Project, TopicOpportunity } from '../types';
import { isRevisionInFlight } from './revision-progress';
import { buildSimpleGenerateInput, resolveSimpleGenerationSettings } from './simple-generation';
import type { SimpleSettingOverrides } from './simple-generation';

// `./api` reads document.cookie / sessionStorage at module load, so it is
// browser-only and must not be imported eagerly (it crashes under the Node test
// runner). We reference its type via `typeof import(...)` and load the real
// implementation lazily inside defaultDeps, which only runs when no deps are
// injected. Tests inject deps and therefore never touch the real api module.
type ApiClient = typeof import('./api')['api'];

export interface QuickComment {
  question: string;
  answer: string;
  boundary?: string;
  nextStep?: string;
  /**
   * 线程互动形态。必须带上:只有 org_answer 的 answer 出自可追责身份,
   * reader_exchange/organic_reaction 的 answer 是模拟读者接话。丢掉这个字段,
   * 展示层只能一律按 org_answer 渲染,于是读者互聊被署名成机构发言——
   * 这正是方法论禁止的假冒消费者。
   */
  threadKind?: string;
  /** 提问者展示昵称(模型产出的真实昵称,如「打呼的小海豹」);历史包可能没有。 */
  displayName?: string;
  /** T2 接话读者 B 的展示昵称;仅 reader_exchange 线程出现。 */
  replyDisplayName?: string;
  followUps?: Array<{ question: string; answer: string; boundary?: string }>;
}

export interface QuickCandidateView {
  id: string;
  label?: string;
  publishable: boolean;
  title: string;
  body: string;
  tags: string[];
  imageBrief?: string;
  commentDisclaimer?: string;
  commentOwnedFirstComment?: string;
  commentUncoveredGaps?: string[];
  comments: QuickComment[];
  /** 校验未通过项的 code 列表(仅 code,不带系统原文 message),用于一句话结论 */
  issueCodes?: string[];
  /**
   * 完整校验结论。必须带 severity——只留 issueCodes 会把 error/warning 的区别丢掉,
   * 而实测 129 个未通过候选里 110 个的首条 code 是 warning,据此下结论必然报错重点。
   */
  validation?: Candidate['validation'];
  /**
   * 发布执行方案与仍然未知。原样透传,不在这里整理——展示层由
   * deploymentPlanView 负责。带上它们是为了创作区生成完就能看到「下一步做什么」,
   * 不必先去产出区。
   */
  deploymentPlan?: Candidate['deploymentPlan'];
  unknowns?: Candidate['unknowns'];
}

function mapComment(thread: CommentThread): QuickComment {
  return {
    question: thread.question,
    answer: thread.answer,
    boundary: thread.boundary,
    nextStep: thread.nextStep,
    // 身份三字段原样透传:创作区的仿真预览要靠它们区分「机构答复」与「读者接话」。
    // 原来这里把它们丢掉了,而丢掉的后果不是少个徽标,是署名错位。
    threadKind: thread.threadKind,
    displayName: thread.displayName,
    replyDisplayName: thread.replyDisplayName,
    followUps: thread.followUps?.map((f) => ({
      question: f.question,
      answer: f.answer,
      boundary: f.boundary,
    })),
  };
}

export function quickCandidateFields(candidate: Candidate): QuickCandidateView {
  return {
    id: candidate.id,
    label: candidate.label,
    publishable: candidate.validation?.valid === true,
    title: candidate.title,
    body: candidate.body,
    tags: candidate.tags ?? [],
    imageBrief: candidate.imageBrief,
    commentDisclaimer: candidate.commentDisclaimer,
    commentOwnedFirstComment: candidate.commentOwnedFirstComment,
    commentUncoveredGaps: candidate.commentUncoveredGaps,
    comments: (candidate.comments ?? []).map(mapComment),
    issueCodes: candidate.validation?.issues
      .map((issue) => issue.code)
      .filter((code): code is string => Boolean(code)),
    validation: candidate.validation,
    deploymentPlan: candidate.deploymentPlan,
    unknowns: candidate.unknowns,
  };
}

export function quickCandidateToMarkdown(view: QuickCandidateView): string {
  const parts: string[] = [];
  parts.push(`# ${view.title}`);
  parts.push('');
  parts.push(view.body);
  if (view.tags.length) {
    parts.push('');
    parts.push(view.tags.map((t) => `#${t}`).join(' '));
  }
  if (view.imageBrief) {
    parts.push('');
    parts.push(`## 图片简报`);
    parts.push(view.imageBrief);
  }
  if (view.commentOwnedFirstComment) {
    parts.push('');
    parts.push(`## 可发布首评`);
    parts.push(view.commentOwnedFirstComment);
  }
  if (view.comments.length) {
    parts.push('');
    parts.push(`## 问答话术`);
    if (view.commentDisclaimer) {
      parts.push('');
      parts.push(`免责声明: ${view.commentDisclaimer}`);
    }
    for (const c of view.comments) {
      parts.push('');
      parts.push(`Q: ${c.question}`);
      parts.push(`A: ${c.answer}`);
      if (c.boundary) parts.push(`边界: ${c.boundary}`);
      if (c.nextStep) parts.push(`下一步: ${c.nextStep}`);
      for (const f of c.followUps ?? []) {
        parts.push(`  · 追问: ${f.question}`);
        parts.push(`    回应: ${f.answer}`);
      }
    }
  }
  if (view.commentUncoveredGaps?.length) {
    parts.push('');
    parts.push(`## 未展开缺口`);
    for (const gap of view.commentUncoveredGaps) parts.push(`- ${gap}`);
  }
  return parts.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 前端停止轮询,但后端任务还活着。
 *
 * 后端 process() 由 setImmediate 独立驱动(generation.service.ts:510),既不看
 * 也不需要 HTTP 连接,所以轮询上限到了只是「我们不再等」,不是「任务没了」。
 * 任务始终在 GET /api/generations?projectId= 里,产出区能查到、能展开候选。
 * 单独立一个错误类型,让调用方把文案说对:别劝用户重试(会派出重复任务),
 * 而是指向产出区。jobId 带出去,好让 UI 直接定位到那一条。
 */
export class GenerationStillRunningError extends Error {
  readonly jobId: string;
  constructor(jobId: string, action: '生成' | '修改') {
    super(`${action}耗时较长，任务仍在后台继续。请到「产出」区查看进度，不用重新提交。`);
    this.name = 'GenerationStillRunningError';
    this.jobId = jobId;
  }
}

interface AutoDeps {
  api: ApiClient;
  buildInput: typeof buildSimpleGenerateInput;
  resolveSettings: typeof resolveSimpleGenerationSettings;
}

const defaultDeps = async (): Promise<AutoDeps> => ({
  api: (await import('./api')).api,
  buildInput: buildSimpleGenerateInput,
  resolveSettings: resolveSimpleGenerationSettings,
});

interface ApproveDeps {
  api: ApiClient;
}

/**
 * 批量/单篇共用的审批段:把一批选题连同其依赖(蓝图、缺口、表达策略、项目情报)
 * 推到已审批态,并返回定位到的选题对象。
 *
 * 后端 selectOpportunity 会校验 project_intelligence 及其蓝图模块已审批,
 * 因此 intelligence 必须在任何 opportunities.approve 之前完成。
 */
export async function approveOpportunitiesForBatch(args: {
  project: Project;
  opportunityIds: string[];
  deps?: ApproveDeps;
}): Promise<TopicOpportunity[]> {
  const projectId = args.project.id;
  const d = args.deps ?? (await defaultDeps());

  // 1. 审批蓝图（仅未审批项，与选题数无关，只做一次）
  const modules = await d.api.blueprintModules.list(projectId);
  await Promise.all(
    modules
      .filter((m) => m.status !== 'approved')
      .map((m) => d.api.blueprintModules.approve(projectId, m.id)),
  );

  // 2. 定位全部目标选题（任一缺失即整批拒绝，不做静默丢弃）
  const opps = await d.api.opportunities.list(projectId);
  const targets = args.opportunityIds.map((id) => {
    const found = opps.items.find((o) => o.id === id);
    if (!found) throw new Error('选题不存在或已过期，请换一个选题');
    return found;
  });

  // 3. 审批全部选题合并后的依赖 gaps / strategies（去重，一轮批准）
  const [gaps, strategies] = await Promise.all([
    d.api.informationGaps.list(projectId),
    d.api.expressionStrategies.list(projectId),
  ]);
  const neededGapIds = new Set(targets.flatMap((o) => o.gapIds ?? []));
  const neededStrategyIds = new Set(
    targets
      .flatMap((o) => [o.strategyId, ...(o.compatibleStrategyIds ?? [])])
      .filter(Boolean) as string[],
  );
  await Promise.all([
    ...gaps.items
      .filter((g) => neededGapIds.has(g.id) && g.status !== 'approved')
      .map((g) => d.api.informationGaps.approve(projectId, g.id)),
    ...strategies.items
      .filter((s) => neededStrategyIds.has(s.id) && s.status !== 'approved')
      .map((s) => d.api.expressionStrategies.approve(projectId, s.id)),
  ]);

  // 4. 审批 intelligence（必须早于任何选题审批）
  const intelligence = await d.api.intelligence.get(projectId);
  if (intelligence?.id && intelligence.approvalStatus !== 'approved') {
    await d.api.intelligence.approve(projectId, intelligence.id);
  }

  // 5. 逐个审批选题
  for (const target of targets) {
    await d.api.opportunities.approve(projectId, target.id);
  }

  return targets;
}

export async function autoApproveAndGenerate(args: {
  project: Project;
  opportunityId: string;
  presetId?: string;
  overrides?: SimpleSettingOverrides;
  imageAssetIds?: string[];
  onProgress?: (job: GenerationJob) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
  deps?: AutoDeps;
}): Promise<GenerationJob> {
  const { project, opportunityId, presetId, overrides } = args;
  const pollIntervalMs = args.pollIntervalMs ?? 1800;
  // 一次生成要跑完知识加载、规划、写作、校验,实测 2-4 分钟,原来 100 次 ×1.8s
  // = 3 分钟经常在最后一步前就放弃。放到 10 分钟做真正的兜底上限,不是常规超时。
  const maxPolls = args.maxPolls ?? 333;
  const d = args.deps ?? (await defaultDeps());
  const projectId = project.id;

  // 1-5. 审批链（与批量提交共用同一实现，避免两份逻辑漂移）
  const [opportunity] = await approveOpportunitiesForBatch({
    project,
    opportunityIds: [opportunityId],
    deps: d,
  });
  if (!opportunity) throw new Error('选题不存在或已过期，请换一个选题');

  // 6. 解析预设 + 构建输入
  let preset;
  if (presetId) {
    const presets = await d.api.presets.list(projectId);
    preset = presets.items.find((p) => p.id === presetId);
  }
  const settings = d.resolveSettings({ project, preset, opportunity, overrides });
  const input: GenerateInput = d.buildInput({
    projectId,
    opportunity,
    settings,
    imageAssetIds: args.imageAssetIds ?? [],
    lockedGapIds: [],
    presetId,
    localFieldsEnabled: false,
    overrides: overrides as Record<string, unknown> | undefined,
    randomizationDimensions: [],
  });

  // 7. 发起生成
  const created = await d.api.generations.create(input);
  args.onProgress?.(created);

  // 8. 轮询
  let job = created;
  let polls = 0;
  while (job.status === 'queued' || job.status === 'running') {
    if (polls >= maxPolls) throw new GenerationStillRunningError(created.id, '生成');
    await sleep(pollIntervalMs);
    job = await d.api.generations.get(created.id);
    args.onProgress?.(job);
    polls += 1;
  }
  if (job.status === 'failed') throw new Error(job.error || '生成失败，请重试');
  return job;
}

interface ReviseDeps {
  api: ApiClient;
}

/**
 * 按意见局部重生成。
 *
 * revise 已改为异步任务:POST 立即返回,执行在服务端队列里。轮询依据是
 * job.activeRevision 而不是 job.status——改稿期间 job.status 保持 completed
 * (前端多处按它判定能否查看产出),用它判断会一次都不轮询就返回旧内容。
 *
 * 这段循环在同步实现时代是死代码:那时 revise 返回的 job 已是 completed,
 * 条件从不成立。现在它才真的开始工作。
 *
 * 只认本候选的任务:后端 activeFor(jobId) 是**任务级**的,而入队互斥是
 * per package_id(revision.service.ts),同一个 job 的两个候选能并发改稿。不过滤
 * 就会等别人的任务、抛别人的失败原因、把别人的进度画到这里。与 Task 6 的
 * revisionBoxState(job, candidateId) 同一口径。
 */
export async function reviseCandidate(args: {
  jobId: string;
  candidateId: string;
  instruction: string;
  pollIntervalMs?: number;
  maxPolls?: number;
  onProgress?: (job: GenerationJob) => void;
  deps?: ReviseDeps;
}): Promise<GenerationJob> {
  const { jobId, candidateId, instruction } = args;
  const pollIntervalMs = args.pollIntervalMs ?? 1800;
  // 与 autoApproveAndGenerate 同一个兜底上限:局部重生成同样要走写作与校验,
  // 没道理给它更短的耐心。
  const maxPolls = args.maxPolls ?? 333;
  const d = args.deps ?? (await defaultDeps());

  // 本次请求的任务;不是我的就当"我的已经不在跑"处理,而不是去等别人的。
  // 比对口径:revision_tasks.candidate_id 存的是用户传入的原值,所以直接比参数。
  const mine = (j: GenerationJob) =>
    j.activeRevision?.candidateId === candidateId ? j.activeRevision : undefined;

  let job = await d.api.generations.revise(jobId, candidateId, instruction);
  args.onProgress?.(job);
  let polls = 0;
  while (isRevisionInFlight(mine(job))) {
    if (polls >= maxPolls) throw new GenerationStillRunningError(jobId, '修改');
    await sleep(pollIntervalMs);
    job = await d.api.generations.get(jobId);
    args.onProgress?.(job);
    polls += 1;
  }
  const settled = mine(job);
  if (settled?.status === 'failed') {
    throw new Error(settled.error || '修改失败，请重试');
  }
  return job;
}
