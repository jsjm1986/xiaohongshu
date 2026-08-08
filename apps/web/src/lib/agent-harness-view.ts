import { harnessValidationValid, normalizeHarnessValidationIssue } from '@content-agent/agent-harness-core/validation';
import type { AgentHarnessJob, AgentHarnessValidationIssue } from '../types';

export type HarnessRunFilter = 'all' | 'active' | 'completed' | 'failed';
export type HarnessCompletedResultState = 'not_completed' | 'missing_candidates' | 'all_blocked' | 'ready';

export const HARNESS_POLL_WARNING_THRESHOLD = 3;

export function harnessCandidateDeliverable(candidate: { validation: { valid: boolean; issues: AgentHarnessValidationIssue[] } }): boolean {
  return harnessValidationValid(candidate.validation.issues.map(normalizeHarnessValidationIssue));
}

export function shouldWarnHarnessPolling(consecutiveFailures: number): boolean {
  return Number.isFinite(consecutiveFailures) && consecutiveFailures >= HARNESS_POLL_WARNING_THRESHOLD;
}

export function harnessCompletedResultState(job: AgentHarnessJob | null | undefined): HarnessCompletedResultState {
  if (!job || job.status !== 'completed') return 'not_completed';
  const candidates = job.candidates ?? [];
  if (candidates.length === 0) return 'missing_candidates';
  return candidates.some(harnessCandidateDeliverable) ? 'ready' : 'all_blocked';
}


export function harnessReviewBlocked(job: AgentHarnessJob | null | undefined): boolean {
  return job?.status === 'completed'
    && job.reviewStatus === 'blocked'
    && Boolean(job.candidateCheckpointAt)
    && Boolean(job.candidates?.length);
}

export function canExportHarnessRun(job: AgentHarnessJob | null | undefined): boolean {
  const candidates = job?.candidates ?? [];
  return job?.status === 'completed'
    && candidates.length > 0
    && candidates.every(harnessCandidateDeliverable);
}

export interface HarnessTaskContractView {
  methodLabel: string;
  topicMode: string;
  audienceStage: string;
  entryPoint: string;
  bodyLength: string;
  bodyRole: string;
  commentRole: string;
  boundaryPolicy: string;
  mustInclude: string[];
  forbidden: string[];
  imageCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

export function harnessTaskContract(task: AgentHarnessJob['task']): HarnessTaskContractView {
  const raw = record(task);
  const method = record(raw.methodProfile);
  const bodyLength = raw.bodyLength === 'short' ? '短正文' : raw.bodyLength === 'long' ? '长正文' : raw.bodyLength === 'medium' ? '中正文' : '未记录';
  const topicMode = raw.topicMode === 'user_defined' ? '用户明确主题' : raw.topicMode === 'agent_discovery' ? 'Agent 自主找题' : '旧运行未记录';
  const audienceStage = ({ discovering: '刚开始了解', collecting: '正在收集信息', comparing: '正在比较判断', hesitating: '有倾向但仍在犹豫', ready: '准备采取下一步' } as Record<string, string>)[String(raw.audienceStage ?? '')] ?? (typeof raw.audienceStage === 'string' && raw.audienceStage.trim() ? raw.audienceStage : '旧运行未记录');
  return {
    methodLabel: typeof method.label === 'string' && method.label.trim() ? method.label : typeof raw.methodProfileId === 'string' ? raw.methodProfileId : '旧运行未记录',
    topicMode,
    audienceStage,
    entryPoint: typeof raw.entryPoint === 'string' && raw.entryPoint.trim() ? raw.entryPoint : '旧运行未记录',
    bodyLength,
    bodyRole: typeof method.bodyRole === 'string' && method.bodyRole.trim() ? method.bodyRole : '旧运行未记录',
    commentRole: typeof method.commentRole === 'string' && method.commentRole.trim() ? method.commentRole : '旧运行未记录',
    boundaryPolicy: typeof method.boundaryPolicy === 'string' && method.boundaryPolicy.trim() ? method.boundaryPolicy : '旧运行未记录',
    mustInclude: strings(raw.mustInclude),
    forbidden: strings(raw.forbidden),
    imageCount: strings(raw.imageAssetIds).length,
  };
}

export function filterHarnessRuns(jobs: AgentHarnessJob[], query: string, filter: HarnessRunFilter): AgentHarnessJob[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  return jobs.filter((job) => {
    const statusMatches = filter === 'all'
      || (filter === 'active' && (job.status === 'queued' || job.status === 'running'))
      || job.status === filter;
    if (!statusMatches) return false;
    if (!needle) return true;
    return `${job.topic}\n${job.goal}\n${job.instruction ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle);
  });
}

export interface HarnessFailureGuidance {
  message: string;
  action: 'settings' | 'retry';
  actionLabel: string;
}

export function harnessFailureGuidance(error?: string | null): HarnessFailureGuidance {
  const raw = error?.trim() || '本次运行没有留下可用结果。';
  if (/(凭据|密钥|API\s*Key|余额|额度)/iu.test(raw)) {
    return { message: raw, action: 'settings', actionLabel: '先检查模型与额度设置' };
  }
  return { message: raw, action: 'retry', actionLabel: '创建独立重试运行' };
}
