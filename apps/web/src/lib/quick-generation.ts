import type { Candidate, CommentThread, GenerateInput, GenerationJob, Project } from '../types';
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
}

function mapComment(thread: CommentThread): QuickComment {
  return {
    question: thread.question,
    answer: thread.answer,
    boundary: thread.boundary,
    nextStep: thread.nextStep,
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
  const maxPolls = args.maxPolls ?? 100;
  const d = args.deps ?? (await defaultDeps());
  const projectId = project.id;

  // 1. 审批蓝图（仅未审批项）
  const modules = await d.api.blueprintModules.list(projectId);
  await Promise.all(
    modules
      .filter((m) => m.status !== 'approved')
      .map((m) => d.api.blueprintModules.approve(projectId, m.id)),
  );

  // 2. 定位机会及其依赖
  const opps = await d.api.opportunities.list(projectId);
  const opportunity = opps.items.find((o) => o.id === opportunityId);
  if (!opportunity) throw new Error('选题不存在或已过期，请换一个选题');

  // 3. 审批依赖 gaps / strategies
  const [gaps, strategies] = await Promise.all([
    d.api.informationGaps.list(projectId),
    d.api.expressionStrategies.list(projectId),
  ]);
  const neededGapIds = new Set(opportunity.gapIds ?? []);
  const neededStrategyIds = new Set(
    [opportunity.strategyId, ...(opportunity.compatibleStrategyIds ?? [])].filter(Boolean) as string[],
  );
  await Promise.all([
    ...gaps.items
      .filter((g) => neededGapIds.has(g.id) && g.status !== 'approved')
      .map((g) => d.api.informationGaps.approve(projectId, g.id)),
    ...strategies.items
      .filter((s) => neededStrategyIds.has(s.id) && s.status !== 'approved')
      .map((s) => d.api.expressionStrategies.approve(projectId, s.id)),
  ]);

  // 4. 审批 intelligence（必须在机会之前：selectOpportunity 会校验
  // project_intelligence 及其蓝图模块已审批，否则拒绝选中机会）。
  // 注：ProjectIntelligence 的审批态记录在 approvalStatus（status 联合类型不含 'approved'）。
  const intelligence = await d.api.intelligence.get(projectId);
  if (intelligence?.id && intelligence.approvalStatus !== 'approved') {
    await d.api.intelligence.approve(projectId, intelligence.id);
  }

  // 5. 审批机会（依赖 intelligence 已审批）
  await d.api.opportunities.approve(projectId, opportunity.id);

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
    if (polls >= maxPolls) throw new Error('生成超时，请稍后重试');
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

// 按意见局部重生成:后端 revise 目前同步返回更新后的 job,仍沿用与
// autoApproveAndGenerate 相同的轮询模式兜底(若未来改为异步任务,调用方不用改)。
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
  const maxPolls = args.maxPolls ?? 100;
  const d = args.deps ?? (await defaultDeps());

  let job = await d.api.generations.revise(jobId, candidateId, instruction);
  args.onProgress?.(job);
  let polls = 0;
  while (job.status === 'queued' || job.status === 'running') {
    if (polls >= maxPolls) throw new Error('修改超时，请稍后重试');
    await sleep(pollIntervalMs);
    job = await d.api.generations.get(jobId);
    args.onProgress?.(job);
    polls += 1;
  }
  if (job.status === 'failed') throw new Error(job.error || '修改失败，请重试');
  return job;
}
