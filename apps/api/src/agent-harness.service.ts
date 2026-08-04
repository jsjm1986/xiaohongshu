import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AGENT_HARNESS_PROFILE,
  DEFAULT_HARNESS_METHOD_ID,
  DEFAULT_HARNESS_SEEDING_MODE,
  getHarnessMethodProfile,
  HARNESS_SIMULATION_NOTICE,
  isHarnessMethodId,
  publicationChecklistFor,
  reviewHarnessCandidates,
  runAgentHarness,
  validateHarnessCandidates,
  type HarnessCandidate,
  type HarnessCandidateCheckpoint,
  type HarnessCandidateResult,
  type HarnessEvidenceSource,
  type HarnessImageSource,
  type HarnessModelProvider,
  type HarnessTask,
  type HarnessToolTrace,
} from '@content-agent/agent-harness-core';
import {
  ModelProviderError,
  OpenAICompatibleClient,
  evidenceIdForSection,
  indexKnowledgeSource,
  splitKnowledgeDocument,
  type EvidenceStatus,
  type KnowledgeDocument,
  type KnowledgeKind,
} from '@content-agent/agent-core';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import { heartbeatTask, reclaimStale, type ClaimTableSpec } from './job-claim.js';
import { assertKnowledgeContextBudget, assertKnowledgeRowsBudget } from './knowledge-budget.js';
import { classifyModelFailure } from './model-failure.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { createSafeModelFetch } from './safe-model-fetch.js';
import { modelOutputTokenLimit, SettingsService, type ResolvedProviderSettings } from './settings.service.js';
import { readStoredText } from './storage-file.js';
import { nowIso, parseJson, requireString, type Pagination } from './utils.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const MAX_PENDING_PER_USER = 4;
const MAX_PENDING_PER_PROJECT = 12;
const TRASH_RETENTION_DAYS = 30;

interface HarnessJobRow {
  id: string;
  project_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  topic: string;
  goal: string;
  task_json: string;
  runtime_snapshot_json: string;
  evidence_snapshot_json: string;
  image_snapshot_json: string;
  parent_job_id: string | null;
  run_kind: 'original' | 'retry' | 'revision';
  source_candidate_id: string | null;
  instruction: string;
  claim_audit_summary: string;
  decision_summary: string;
  review_summary: string;
  usage_json: string;
  error: string | null;
  attempt_count: number;
  quota_consumed_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  deleted_at: string | null;
  project_snapshot_json: string;
  provider_snapshot_json: string;
  source_candidate_job_id: string | null;
  failure_stage: string;
  partial_usage_json: string;
  provider_started_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  selected_candidate_id: string | null;
  approval_status: 'draft' | 'selected' | 'approved';
  approval_notes: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_content_hash: string;
  purge_after: string | null;
  review_status: 'pending' | 'running' | 'completed' | 'blocked';
  review_error: string;
  review_attempt_count: number;
  candidate_checkpoint_at: string | null;
  read_evidence_ids_json: string;
}

export const AGENT_HARNESS_JOBS_SPEC: ClaimTableSpec = {
  table: 'agent_harness_jobs',
  attemptColumn: 'attempt_count',
  softDelete: true,
  hasClaimedAt: true,
  resetColumns: 'progress=0, error=NULL, claimed_at=NULL',
  parentAlive:
    'EXISTS (SELECT 1 FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=agent_harness_jobs.project_id AND p.deleted_at IS NULL AND w.deleted_at IS NULL)',
};

class HarnessClaimLostError extends Error {
  constructor() {
    super('Agent Harness task claim lost');
    this.name = 'HarnessClaimLostError';
  }
}

function stringList(value: unknown, field: string, limit = 30): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${field} 必须是字符串数组`);
  if (value.length > limit) throw new BadRequestException(`${field} 最多 ${limit} 项`);
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string') throw new BadRequestException(`${field} 必须是字符串数组`);
    return item.trim().slice(0, 300);
  }).filter(Boolean))];
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length > max) throw new BadRequestException(`${field} 最长 ${max} 个字符`);
  return text || undefined;
}

function publicationCheckLabel(key: string): string {
  return ({
    soft_marketing: '软营销心智链',
    evidence: '事实与证据',
    simulation_disclosure: '模拟互动披露',
    execution_plan: '真实问题承接',
    asset_authorization: '图片素材授权',
    platform_compliance: '平台合规',
    final_proofread: '终稿校对',
  } as Record<string, string>)[key] ?? key;
}

function publicationCheckStatus(status: string): string {
  return ({ ready: '已就绪', blocked: '阻断', manual_review: '人工复核' } as Record<string, string>)[status] ?? status;
}

function narrativePathLabel(value?: string): string {
  return value ? ({
    tension_first: '顾虑切入',
    observation_first: '观察切入',
    question_first: '问题切入',
  } as Record<string, string>)[value] ?? value : '旧运行未记录';
}


function publicFailure(error: unknown, mode: 'platform' | 'byok', refunded: boolean): string {
  const settlement = mode === 'platform'
    ? (refunded ? '本次未产生候选，平台额度已退还。' : '供应商调用已经开始，本次平台额度按已发生调用结算。')
    : '本次未扣平台额度；第三方费用以供应商账单为准。';
  switch (classifyModelFailure(error)) {
    case 'unavailable': return `Agent 模型服务暂时不可用。${settlement}请稍后重试。`;
    case 'credentials': return `Agent 模型凭据异常。${settlement}请检查模型设置。`;
    case 'incomplete': return `Agent 返回的工具动作或候选不完整。${settlement}请重试。`;
    default: return `Agent Harness 运行失败。${settlement}请重试。`;
  }
}

function safeTrace(trace: HarnessToolTrace): { input: Record<string, unknown>; output: Record<string, unknown> } {
  if (trace.action === 'search_knowledge') {
    const results = Array.isArray(trace.output.results)
      ? trace.output.results.map((item) => {
          const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
          return {
            evidenceId: value.evidenceId,
            path: value.path,
            heading: value.heading,
            evidenceStatus: value.evidenceStatus,
            rank: value.rank,
          };
        })
      : [];
    return {
      input: { action: trace.action, query: trace.input.query, rationale: trace.input.rationale },
      // Search previews are runtime-only evidence disclosure. Persist identifiers
      // and ranking metadata, never source excerpts, in the audit/API projection.
      output: { results, resultCount: trace.output.resultCount },
    };
  }
  if (trace.action === 'read_evidence') {
    const evidence = Array.isArray(trace.output.evidence)
      ? trace.output.evidence.map((item) => {
          const value = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
          return {
            evidenceId: value.evidenceId,
            path: value.path,
            heading: value.heading,
            kind: value.kind,
            evidenceStatus: value.evidenceStatus,
            sourceType: value.sourceType,
            assetId: value.assetId,
          };
        })
      : [];
    return {
      input: { action: trace.action, evidenceIds: trace.input.evidenceIds, rationale: trace.input.rationale },
      output: { evidence },
    };
  }
  return {
    input: { action: trace.action, candidateCount: Array.isArray(trace.input.candidates) ? trace.input.candidates.length : 0 },
    output: { acceptedForReview: true, candidateCount: trace.output.candidateCount },
  };
}

@Injectable()
export class AgentHarnessService implements OnModuleInit, OnModuleDestroy {
  private activeJobs = 0;
  private stopped = false;
  private reclaimTimer?: NodeJS.Timeout;
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  onModuleInit(): void {
    this.reclaimAndDrain();
    this.reclaimTimer = setInterval(() => this.tick(() => this.reclaimAndDrain()), this.options.jobHeartbeatMs);
    this.reclaimTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    for (const controller of this.abortControllers.values()) controller.abort(new Error('Agent Harness service stopped'));
    this.abortControllers.clear();
  }

  async create(raw: Record<string, unknown>, principal: SessionPrincipal): Promise<Record<string, unknown>> {
    const projectId = requireString(raw.projectId, 'projectId', { max: 200 });
    const topicMode = raw.topicMode === 'user_defined' ? 'user_defined' : 'agent_discovery';
    const creativeIntent = optionalText(raw.creativeIntent, 'creativeIntent', 100);
    const requestedMethodId = raw.methodProfileId ?? DEFAULT_HARNESS_METHOD_ID;
    if (!isHarnessMethodId(requestedMethodId)) throw new BadRequestException('不支持的成品写法');
    const methodProfile = structuredClone(getHarnessMethodProfile(requestedMethodId));
    const audienceStage = optionalText(raw.audienceStage, 'audienceStage', 100) ?? methodProfile.audienceStage;
    const suppliedTopic = optionalText(raw.topic, 'topic', 500);
    if (topicMode === 'user_defined' && !suppliedTopic) {
      throw new BadRequestException('选择明确主题时，主题不能为空');
    }
    const topic = suppliedTopic ?? `由 Agent 从项目资料中自主发现选题${creativeIntent ? ` · ${creativeIntent}` : ''}`;
    const audience = optionalText(raw.audience, 'audience', 500);
    const entryPoint = optionalText(raw.entryPoint, 'entryPoint', 100) ?? methodProfile.entryPoint;
    const tone = optionalText(raw.tone, 'tone', 300);
    const accountIdentity = optionalText(raw.accountIdentity, 'accountIdentity', 300);
    const callToAction = optionalText(raw.callToAction, 'callToAction', 500);
    const publishingNotes = optionalText(raw.publishingNotes, 'publishingNotes', 1_000);
    const notes = optionalText(raw.notes, 'notes', 2_000);
    let bodyLength: 'short' | 'medium' | 'long' = methodProfile.bodyLength;
    if (raw.bodyLength !== undefined) {
      if (raw.bodyLength !== 'short' && raw.bodyLength !== 'medium' && raw.bodyLength !== 'long') {
        throw new BadRequestException('bodyLength 只支持 short、medium 或 long');
      }
      bodyLength = raw.bodyLength;
    }
    const task: HarnessTask = {
      topic,
      goal: optionalText(raw.goal, 'goal', 1_000) ?? '',
      topicMode,
      ...(creativeIntent ? { creativeIntent } : {}),
      methodProfileId: methodProfile.id,
      methodProfile,
      ...(audienceStage ? { audienceStage } : {}),
      mustInclude: stringList(raw.mustInclude, 'mustInclude'),
      forbidden: stringList(raw.forbidden, 'forbidden'),
      imageAssetIds: stringList(raw.imageAssetIds, 'imageAssetIds', 12),
      ...(audience ? { audience } : {}),
      entryPoint,
      ...(tone ? { tone } : {}),
      bodyLength,
      ...(accountIdentity ? { accountIdentity } : {}),
      ...(callToAction ? { callToAction } : {}),
      ...(publishingNotes ? { publishingNotes } : {}),
      ...(notes ? { notes } : {}),
      allowUngrounded: raw.allowUngrounded === true,
    };
    return this.enqueue({ projectId, task, principal, runKind: 'original' });
  }

  async retry(id: string, principal: SessionPrincipal): Promise<Record<string, unknown>> {
    const source = this.jobRow(id);
    if (!['completed', 'failed'].includes(source.status)) throw new BadRequestException('运行结束后才能重试');
    const task = parseJson<HarnessTask>(source.task_json, {
      topic: source.topic, goal: source.goal, mustInclude: [], forbidden: [], imageAssetIds: [],
    });
    if (source.run_kind === 'revision') {
      if (!source.source_candidate_id || !source.instruction) throw new BadRequestException('历史改稿运行缺少源候选或修改要求，无法按原语义重试');
      return this.enqueue({
        projectId: source.project_id, task, principal, runKind: 'revision', parentJobId: id,
        sourceCandidateId: source.source_candidate_id,
        sourceCandidateJobId: source.source_candidate_job_id ?? source.parent_job_id ?? undefined,
        instruction: source.instruction,
      });
    }
    return this.enqueue({ projectId: source.project_id, task, principal, runKind: 'retry', parentJobId: id });
  }

  retryReview(id: string, principal: SessionPrincipal): Record<string, unknown> {
    const row = this.jobRow(id);
    if (row.status !== 'completed' || row.review_status !== 'blocked' || !row.candidate_checkpoint_at) {
      throw new BadRequestException('只有已保留候选且复核被阻断的运行可以单独重试复核');
    }
    const candidateCount = Number((this.database.prepare(
      'SELECT COUNT(*) AS value FROM agent_harness_candidates WHERE job_id=?',
    ).get(id) as { value: number }).value);
    if (!candidateCount) throw new BadRequestException('当前运行没有可复核的候选');
    const project = this.resources.projectRow(row.project_id);
    const workspaceId = String(project.workspace_id);
    const settings = this.settings.provider(workspaceId, principal.userId);
    if (!settings.apiKey) throw new BadRequestException('请先配置模型 API Key，再重试复核。');
    const now = nowIso();
    this.database.transaction(() => {
      const pendingUser = Number((this.database.prepare(
        `SELECT COUNT(*) AS value FROM agent_harness_jobs
         WHERE created_by=? AND status IN ('queued','running') AND deleted_at IS NULL`,
      ).get(principal.userId) as { value: number }).value);
      const pendingProject = Number((this.database.prepare(
        `SELECT COUNT(*) AS value FROM agent_harness_jobs
         WHERE project_id=? AND status IN ('queued','running') AND deleted_at IS NULL`,
      ).get(row.project_id) as { value: number }).value);
      if (pendingUser >= MAX_PENDING_PER_USER) throw new ConflictException('你的 Agent 队列已满，请稍后再重试复核');
      if (pendingProject >= MAX_PENDING_PER_PROJECT) throw new ConflictException('当前项目的 Agent 队列已满，请稍后再重试复核');
      if (settings.mode === 'platform') this.settings.consumePlatformQuota(workspaceId);
      const updated = this.database.prepare(
        `UPDATE agent_harness_jobs SET status='queued', progress=75, review_status='pending', review_error='',
           error=NULL, failure_stage='', completed_at=NULL, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL,
           provider_started_at=NULL, quota_consumed_count=?, updated_at=?
         WHERE id=? AND status='completed' AND review_status='blocked' AND deleted_at IS NULL`,
      ).run(settings.mode === 'platform' ? 1 : 0, now, id);
      if (updated.changes !== 1) {
        if (settings.mode === 'platform') this.settings.refundPlatformQuota(workspaceId);
        throw new ConflictException('该运行状态已变化，请刷新后重试');
      }
      this.audit.record({ workspaceId, userId: principal.userId,
        action: 'agent-harness.review-retry', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id, candidateCount, previousReviewAttempts: row.review_attempt_count } });
    });
    this.drainQueue();
    return this.get(id);
  }

  async revise(
    id: string,
    candidateId: string,
    instruction: string,
    principal: SessionPrincipal,
  ): Promise<Record<string, unknown>> {
    const source = this.jobRow(id);
    if (source.status !== 'completed') throw new BadRequestException('只有已完成的 Agent 运行可以改稿');
    const row = this.database.prepare(
      'SELECT content_json FROM agent_harness_candidates WHERE id=? AND job_id=?',
    ).get(candidateId, id) as { content_json: string } | undefined;
    if (!row) throw new NotFoundException('Agent 候选不存在');
    const normalizedInstruction = requireString(instruction, 'instruction', { max: 2_000 });
    const original = parseJson<HarnessTask>(source.task_json, {
      topic: source.topic, goal: source.goal, mustInclude: [], forbidden: [], imageAssetIds: [],
    });
    const task: HarnessTask = {
      ...original,
      notes: [original.notes, `本轮改稿要求：${normalizedInstruction}`].filter(Boolean).join('\n'),
    };
    return this.enqueue({
      projectId: source.project_id, task, principal, runKind: 'revision', parentJobId: id,
      sourceCandidateId: candidateId, sourceCandidateJobId: id, instruction: normalizedInstruction,
    });
  }

  softDelete(id: string, principal: SessionPrincipal): Record<string, unknown> {
    const row = this.jobRow(id, true);
    const project = this.resources.projectRow(row.project_id);
    if (row.deleted_at) return { id, topic: row.topic, alreadyDeleted: true };
    const now = nowIso();
    const purgeAfter = new Date(Date.now() + TRASH_RETENTION_DAYS * 86_400_000).toISOString();
    const refundable = row.quota_consumed_count > 0 && !row.provider_started_at;
    this.database.transaction(() => {
      if (refundable) this.settings.refundPlatformQuota(String(project.workspace_id), row.quota_consumed_count);
      this.database.prepare(
        `UPDATE agent_harness_jobs SET deleted_at=?, purge_after=?, updated_at=?,
           status=CASE WHEN status IN ('queued','running') THEN 'failed' ELSE status END,
           error=CASE WHEN status IN ('queued','running') THEN '任务已由用户取消并删除' ELSE error END,
           failure_stage=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE failure_stage END,
           cancelled_at=CASE WHEN status IN ('queued','running') THEN ? ELSE cancelled_at END,
           cancelled_by=CASE WHEN status IN ('queued','running') THEN ? ELSE cancelled_by END,
           quota_consumed_count=0, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
         WHERE id=? AND deleted_at IS NULL`,
      ).run(now, purgeAfter, now, now, principal.userId, id);
      this.audit.record({
        workspaceId: String(project.workspace_id), userId: principal.userId,
        action: 'agent-harness.delete', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id, previousStatus: row.status, providerStarted: Boolean(row.provider_started_at), quotaRefunded: refundable, purgeAfter },
      });
    });
    this.abortControllers.get(id)?.abort(new Error('Agent Harness run cancelled by user'));
    return { id, topic: row.topic, alreadyDeleted: false, quotaRefunded: refundable, purgeAfter };
  }

  restore(id: string, principal: SessionPrincipal): Record<string, unknown> {
    const row = this.jobRow(id, true);
    if (!row.deleted_at) return this.get(id);
    const project = this.resources.projectRow(row.project_id);
    this.database.transaction(() => {
      this.database.prepare(
        'UPDATE agent_harness_jobs SET deleted_at=NULL, purge_after=NULL, updated_at=? WHERE id=?',
      ).run(nowIso(), id);
      this.audit.record({
        workspaceId: String(project.workspace_id), userId: principal.userId,
        action: 'agent-harness.restore', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id },
      });
    });
    return this.get(id);
  }

  selectCandidate(id: string, candidateId: string, principal: SessionPrincipal): Record<string, unknown> {
    const row = this.jobRow(id);
    if (row.status !== 'completed') throw new BadRequestException('只有已完成运行可以选择候选');
    const candidate = this.database.prepare(
      'SELECT validation_json FROM agent_harness_candidates WHERE id=? AND job_id=?',
    ).get(candidateId, id) as { validation_json: string } | undefined;
    if (!candidate) throw new NotFoundException('Agent 候选不存在');
    if (parseJson<{ valid?: boolean }>(candidate.validation_json, {}).valid !== true) throw new BadRequestException('被阻断候选不能进入人工批准流程');
    const project = this.resources.projectRow(row.project_id);
    const now = nowIso();
    this.database.transaction(() => {
      this.database.prepare(
        `UPDATE agent_harness_jobs SET selected_candidate_id=?, approval_status='selected', approval_notes='',
          approved_by=NULL, approved_at=NULL, approved_content_hash='', updated_at=? WHERE id=?`,
      ).run(candidateId, now, id);
      this.audit.record({ workspaceId: String(project.workspace_id), userId: principal.userId,
        action: 'agent-harness.select', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id, candidateId } });
    });
    return this.get(id);
  }

  approve(id: string, notes: string, principal: SessionPrincipal): Record<string, unknown> {
    const row = this.jobRow(id);
    if (!row.selected_candidate_id) throw new BadRequestException('请先选择一个通过自动校验的候选');
    const candidate = this.database.prepare(
      'SELECT content_json, validation_json FROM agent_harness_candidates WHERE id=? AND job_id=?',
    ).get(row.selected_candidate_id, id) as { content_json: string; validation_json: string } | undefined;
    if (!candidate || parseJson<{ valid?: boolean }>(candidate.validation_json, {}).valid !== true) throw new BadRequestException('所选候选已不可批准');
    const normalizedNotes = optionalText(notes, 'notes', 2_000) ?? '';
    const contentHash = createHash('sha256').update(candidate.content_json).digest('hex');
    const project = this.resources.projectRow(row.project_id);
    const now = nowIso();
    this.database.transaction(() => {
      this.database.prepare(
        `UPDATE agent_harness_jobs SET approval_status='approved', approval_notes=?, approved_by=?,
          approved_at=?, approved_content_hash=?, updated_at=? WHERE id=?`,
      ).run(normalizedNotes, principal.userId, now, contentHash, now, id);
      this.audit.record({ workspaceId: String(project.workspace_id), userId: principal.userId,
        action: 'agent-harness.approve', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id, candidateId: row.selected_candidate_id, contentHash } });
    });
    return this.get(id);
  }

  purge(id: string, principal: SessionPrincipal): { id: string; purged: true } {
    const row = this.jobRow(id, true);
    if (!row.deleted_at) throw new BadRequestException('只能永久删除回收站中的运行');
    const project = this.resources.projectRow(row.project_id);
    this.database.transaction(() => {
      this.audit.record({ workspaceId: String(project.workspace_id), userId: principal.userId,
        action: 'agent-harness.purge', entityType: 'agent_harness_job', entityId: id,
        details: { projectId: row.project_id, deletedAt: row.deleted_at } });
      this.database.prepare('DELETE FROM agent_harness_jobs WHERE id=? AND deleted_at IS NOT NULL').run(id);
    });
    return { id, purged: true };
  }

  private taskContractMarkdown(task: HarnessTask): string {
    const method = task.methodProfile;
    const bodyLength = task.bodyLength === 'short' ? '短正文' : task.bodyLength === 'long' ? '长正文' : task.bodyLength === 'medium' ? '中正文' : '未记录';
    const audienceStage = ({ collecting: '正在收集信息', discovering: '刚开始了解', comparing: '正在比较判断', hesitating: '有倾向但仍在犹豫', ready: '准备采取下一步' } as Record<string, string>)[task.audienceStage ?? ''] ?? task.audienceStage ?? '未记录';
    return [
      '## 本次冻结的创作合同', '',
      `- 选题方式：${task.topicMode === 'user_defined' ? '用户明确主题' : task.topicMode === 'agent_discovery' ? 'Agent 自主找题' : '未记录'}`,
      `- 成品方法：${method?.label ?? task.methodProfileId ?? '未记录'}`,
      `- 读者阶段：${audienceStage}`,
      `- 内容入口：${task.entryPoint ?? '未记录'}`,
      `- 正文篇幅：${bodyLength}`,
      `- 正文职责：${method?.bodyRole ?? '未记录'}`,
      `- 评论职责：${method?.commentRole ?? '未记录'}`,
      `- 真实性边界：${method?.boundaryPolicy ?? '未记录'}`,
      `- 必须包含：${task.mustInclude.join('、') || '无'}`,
      `- 禁止出现：${task.forbidden.join('、') || '无'}`,
      `- 已批准图片：${task.imageAssetIds?.length ?? 0} 张`,
    ].join('\n');
  }

  exportCandidate(jobId: string, candidateId: string, format: 'markdown' | 'json'): { buffer: Buffer; filename: string; mediaType: string } {
    const job = this.jobRow(jobId);
    const row = this.database.prepare(
      'SELECT content_json, validation_json FROM agent_harness_candidates WHERE id=? AND job_id=?',
    ).get(candidateId, jobId) as { content_json: string; validation_json: string } | undefined;
    if (!row) throw new NotFoundException('Agent 候选不存在');
    const candidate = parseJson<HarnessCandidate>(row.content_json, {} as HarnessCandidate);
    const validation = parseJson<{ valid?: boolean; issues?: unknown[] }>(row.validation_json, {});
    const task = parseJson<HarnessTask>(job.task_json, { topic: job.topic, goal: job.goal, mustInclude: [], forbidden: [] });
    const runtimeContract = parseJson<Record<string, unknown>>(job.runtime_snapshot_json, {});
    if (validation.valid !== true) throw new BadRequestException('候选未通过硬校验，禁止导出');
    const title = String(((candidate.content as Record<string, any> | undefined)?.N as Record<string, unknown> | undefined)?.title ?? 'agent-candidate');
    const safeTitle = title.replace(/[\\/:*?"<>|\r\n]/gu, '_').slice(0, 60) || 'agent-candidate';
    if (format === 'json') {
      return {
        buffer: Buffer.from(`${JSON.stringify({ jobId, taskContract: task, runtimeContract, ...candidate, validation }, null, 2)}\n`, 'utf8'),
        filename: `${safeTitle}.json`, mediaType: 'application/json; charset=utf-8',
      };
    }
    return {
      buffer: Buffer.from(`# 运行输入与边界\n\n${this.taskContractMarkdown(task)}\n\n${this.candidateMarkdown(candidate, validation)}`, 'utf8'),
      filename: `${safeTitle}.md`, mediaType: 'text/markdown; charset=utf-8',
    };
  }

  exportRun(jobId: string, format: 'markdown' | 'json'): { buffer: Buffer; filename: string; mediaType: string } {
    const job = this.jobRow(jobId);
    if (job.status !== 'completed') throw new BadRequestException('只有已完成的运行可以整次导出');
    const rows = this.database.prepare(
      'SELECT content_json, validation_json FROM agent_harness_candidates WHERE job_id=? ORDER BY candidate_index',
    ).all(jobId) as unknown as Array<{ content_json: string; validation_json: string }>;
    const candidates = rows.map((row) => ({
      candidate: parseJson<HarnessCandidate>(row.content_json, {} as HarnessCandidate),
      validation: parseJson<{ valid?: boolean; issues?: unknown[] }>(row.validation_json, {}),
    }));
    if (!candidates.length) throw new BadRequestException('本次运行没有候选');
    if (candidates.some((item) => item.validation.valid !== true)) {
      throw new BadRequestException('整次导出要求所有候选通过硬校验');
    }
    const safeTopic = job.topic.replace(/[\\/:*?"<>|\r\n]/gu, '_').slice(0, 60) || 'agent-harness-run';
    const taskContract = parseJson<HarnessTask>(job.task_json, { topic: job.topic, goal: job.goal, mustInclude: [], forbidden: [] });
    const runtimeContract = parseJson<Record<string, unknown>>(job.runtime_snapshot_json, {});
    if (format === 'json') {
      const payload = {
        jobId,
        topic: job.topic,
        goal: job.goal,
        runKind: job.run_kind,
        taskContract,
        runtimeContract,
        decisionSummary: job.decision_summary,
        reviewSummary: job.review_summary,
        claimAuditSummary: job.claim_audit_summary,
        candidates: candidates.map(({ candidate, validation }) => ({ ...candidate, validation })),
      };
      return {
        buffer: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
        filename: `${safeTopic}-完整运行.json`,
        mediaType: 'application/json; charset=utf-8',
      };
    }
    const sections = candidates.map(
      ({ candidate, validation }, index) => `# 候选 ${index + 1}\n\n${this.candidateMarkdown(candidate, validation).trim()}`,
    );
    const header = [
      `# ${job.topic}`,
      '',
      `> 运行类型：${job.run_kind}`,
      '',
      this.taskContractMarkdown(taskContract),
      '',
      '## 运行时合同',
      '',
      `- 版本：${String(runtimeContract.version ?? '未记录')}`,
      `- 摘要：${String(runtimeContract.digest ?? '未记录')}`,
      `- 模型：${String(runtimeContract.model ?? '未记录')}`,
      '',
      '## 创作决策摘要',
      '',
      job.decision_summary || '未提供',
      '',
      '## 最终复核摘要',
      '',
      job.review_summary || '未提供',
      '',
      '## 事实盘点摘要',
      '',
      job.claim_audit_summary || '未提供',
    ].join('\n');
    return {
      buffer: Buffer.from(`${header}\n\n${sections.join('\n\n---\n\n')}\n`, 'utf8'),
      filename: `${safeTopic}-完整运行.md`,
      mediaType: 'text/markdown; charset=utf-8',
    };
  }

  private async enqueue(input: {
    projectId: string;
    task: HarnessTask;
    principal: SessionPrincipal;
    runKind: HarnessJobRow['run_kind'];
    parentJobId?: string;
    sourceCandidateId?: string;
    sourceCandidateJobId?: string;
    instruction?: string;
  }): Promise<Record<string, unknown>> {
    const project = this.resources.projectRow(input.projectId);
    const settings = this.settings.provider(String(project.workspace_id), input.principal.userId);
    if (!settings.apiKey) throw new BadRequestException('请先配置模型 API Key，再运行 Agent Harness。');
    const [evidence, images] = await Promise.all([
      this.buildEvidenceSnapshot(input.projectId, input.task),
      this.buildImageSnapshot(input.projectId, input.task.imageAssetIds ?? []),
    ]);
    const evidenceSourceCount = evidence.length + images.length;
    if (!evidenceSourceCount && !input.task.allowUngrounded) {
      throw new BadRequestException('当前项目没有可用事实证据。如需仅生成通用建议，请明确确认无项目证据运行。');
    }
    const id = randomUUID();
    const now = nowIso();
    const projectSnapshot = { id: input.projectId, name: String(project.name), description: String(project.description ?? ''), profile: parseJson<Record<string, unknown>>(String(project.profile_json ?? '{}'), {}), capturedAt: now };
    const providerSnapshot = { mode: settings.mode, provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, transport: settings.transport, configVersion: settings.configVersion };
    const runtimeSnapshot = {
      ...AGENT_HARNESS_PROFILE,
      channel: 'agent_harness', source: 'neutral_project_evidence_and_approved_image_observations',
      excludes: ['project_intelligence', 'project_blueprint_modules', 'information_gaps', 'expression_strategies', 'topic_opportunities', 'coverage_records', 'planning_context'],
      model: settings.model, providerMode: settings.mode, providerConfigVersion: settings.configVersion,
      fixedStages: ['search', 'read_deterministic', 'body_draft', 'package_candidate_1', 'package_candidate_2', 'package_candidate_3', 'final_review'],
      evidenceReadiness: evidenceSourceCount ? 'grounded' : 'no_project_evidence', evidenceSourceCount,
    };
    this.database.transaction(() => {
      // Capacity check, quota reservation and INSERT share one write transaction.
      // Concurrent submitters therefore cannot all observe the same final slot.
      const pendingUser = Number((this.database.prepare(
        `SELECT COUNT(*) AS value FROM agent_harness_jobs
         WHERE created_by=? AND status IN ('queued','running') AND deleted_at IS NULL`,
      ).get(input.principal.userId) as { value: number }).value);
      const pendingProject = Number((this.database.prepare(
        `SELECT COUNT(*) AS value FROM agent_harness_jobs
         WHERE project_id=? AND status IN ('queued','running') AND deleted_at IS NULL`,
      ).get(input.projectId) as { value: number }).value);
      if (pendingUser >= MAX_PENDING_PER_USER) {
        throw new ConflictException(`你已有 ${pendingUser} 个 Agent 任务在排队或运行，请等待完成后再提交`);
      }
      if (pendingProject >= MAX_PENDING_PER_PROJECT) {
        throw new ConflictException('当前项目的 Agent 队列已满，请稍后再试');
      }
      if (input.parentJobId && input.runKind !== 'original') {
        const active = this.database.prepare(
          `SELECT id FROM agent_harness_jobs
           WHERE parent_job_id=? AND run_kind=? AND status IN ('queued','running')
             AND deleted_at IS NULL
             AND (? <> 'revision' OR source_candidate_id=?)
           LIMIT 1`,
        ).get(
          input.parentJobId,
          input.runKind,
          input.runKind,
          input.sourceCandidateId ?? null,
        ) as { id: string } | undefined;
        if (active) {
          throw new ConflictException(
            input.runKind === 'revision'
              ? '该候选已有进行中的改稿运行，请等待完成后再试'
              : '该运行已有进行中的重试，请等待完成后再试',
          );
        }
      }
      if (settings.mode === 'platform') this.settings.consumePlatformQuota(String(project.workspace_id));
      this.database.prepare(
        `INSERT INTO agent_harness_jobs
         (id, project_id, status, progress, topic, goal, task_json, runtime_snapshot_json,
          evidence_snapshot_json, image_snapshot_json, project_snapshot_json, provider_snapshot_json,
          parent_job_id, run_kind, source_candidate_id, source_candidate_job_id, instruction,
          quota_consumed_count, created_by, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.projectId, input.task.topic, input.task.goal, JSON.stringify(input.task),
        JSON.stringify(runtimeSnapshot), JSON.stringify(evidence), JSON.stringify(images),
        JSON.stringify(projectSnapshot), JSON.stringify(providerSnapshot),
        input.parentJobId ?? null, input.runKind, input.sourceCandidateId ?? null,
        input.sourceCandidateJobId ?? input.parentJobId ?? null, input.instruction ?? '', settings.mode === 'platform' ? 1 : 0,
        input.principal.userId, now, now,
      );
      const auditBase = {
        workspaceId: String(project.workspace_id), userId: input.principal.userId,
        entityType: 'agent_harness_job', entityId: id,
        details: { projectId: input.projectId, topic: input.task.topic, parentJobId: input.parentJobId, profileVersion: AGENT_HARNESS_PROFILE.version },
      };
      if (input.runKind === 'revision') {
        this.audit.record({ ...auditBase, action: 'agent-harness.revise' });
      } else if (input.runKind === 'retry') {
        this.audit.record({ ...auditBase, action: 'agent-harness.retry' });
      } else {
        this.audit.record({ ...auditBase, action: 'agent-harness.create' });
      }
    });
    this.drainQueue();
    return this.get(id);
  }

  list(projectId: string, pagination: Pagination): { items: Record<string, unknown>[]; total: number; limit: number; offset: number } {
    this.resources.projectRow(projectId);
    const total = Number((this.database.prepare(
      'SELECT COUNT(*) AS value FROM agent_harness_jobs WHERE project_id=? AND deleted_at IS NULL',
    ).get(projectId) as { value: number }).value);
    const items = (this.database.prepare(
      `SELECT * FROM agent_harness_jobs
       WHERE project_id=? AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(projectId, pagination.limit, pagination.offset) as unknown as HarnessJobRow[])
      .map((row) => this.mapJob(row, false));
    return { items, total, ...pagination };
  }

  listDeleted(projectId: string, pagination: Pagination): { items: Record<string, unknown>[]; total: number; limit: number; offset: number } {
    this.resources.projectRow(projectId);
    const total = Number((this.database.prepare(
      'SELECT COUNT(*) AS value FROM agent_harness_jobs WHERE project_id=? AND deleted_at IS NOT NULL',
    ).get(projectId) as { value: number }).value);
    const items = (this.database.prepare(
      `SELECT * FROM agent_harness_jobs
       WHERE project_id=? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(projectId, pagination.limit, pagination.offset) as unknown as HarnessJobRow[])
      .map((row) => ({ ...this.mapJob(row, false), deletedAt: row.deleted_at }));
    return { items, total, ...pagination };
  }

  get(id: string): Record<string, unknown> {
    return this.mapJob(this.jobRow(id), true);
  }

  jobRow(id: string, includeDeleted = false): HarnessJobRow {
    const row = this.database.prepare(
      `SELECT * FROM agent_harness_jobs WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    ).get(id) as unknown as HarnessJobRow | undefined;
    if (!row) throw new NotFoundException('Agent Harness 任务不存在');
    return row;
  }

  private tick(fn: () => void): void {
    if (this.stopped) return;
    try { fn(); } catch { /* next heartbeat will retry */ }
  }

  private reclaimAndDrain(): void {
    this.database.prepare(`DELETE FROM agent_harness_jobs WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after<=?`).run(nowIso());
    reclaimStale(
      this.database,
      AGENT_HARNESS_JOBS_SPEC,
      nowIso(),
      this.options.jobClaimTimeoutMs,
      (attempts) => `Agent Harness 被反复打断（${attempts} 次），已停止自动重跑。`,
      (id) => this.refundOutstandingQuota(id),
    );
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.stopped) return;
    while (this.activeJobs < MAX_ACTIVE_JOBS) {
      const id = this.claimNextFair();
      if (!id) break;
      this.activeJobs += 1;
      setImmediate(() => void this.process(id).finally(() => {
        this.activeJobs -= 1;
        this.drainQueue();
      }));
    }
  }

  private claimNextFair(): string | undefined {
    const now = nowIso();
    const claimed = this.database.prepare(
      `UPDATE agent_harness_jobs SET status='running', claimed_by=?, claimed_at=?, heartbeat_at=?, updated_at=?
       WHERE id=(
         SELECT queued.id FROM agent_harness_jobs queued
         JOIN projects p ON p.id=queued.project_id JOIN workspaces w ON w.id=p.workspace_id
         WHERE queued.status='queued' AND queued.deleted_at IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL
         ORDER BY (SELECT COUNT(*) FROM agent_harness_jobs active
                   WHERE active.created_by=queued.created_by AND active.status='running' AND active.deleted_at IS NULL),
                  queued.created_at, queued.id LIMIT 1
       ) AND status='queued' AND deleted_at IS NULL RETURNING id`,
    ).get(this.options.instanceId, now, now, now) as { id: string } | undefined;
    return claimed?.id;
  }

  private startHeartbeat(id: string): void {
    const timer = setInterval(() => this.tick(() => {
      if (!heartbeatTask(this.database, AGENT_HARNESS_JOBS_SPEC, id, this.options.instanceId, nowIso())) {
        this.stopHeartbeat(id);
      }
    }), this.options.jobHeartbeatMs);
    timer.unref();
    this.heartbeats.set(id, timer);
  }

  private stopHeartbeat(id: string): void {
    const timer = this.heartbeats.get(id);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(id);
  }

  private progress(id: string, value: number): void {
    if (this.stopped) throw new HarnessClaimLostError();
    const result = this.database.prepare(
      `UPDATE agent_harness_jobs SET progress=?, heartbeat_at=?, updated_at=?
       WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).run(value, nowIso(), nowIso(), id, this.options.instanceId);
    if (result.changes !== 1) throw new HarnessClaimLostError();
  }

  private recordTrace(jobId: string, trace: HarnessToolTrace): void {
    const safe = safeTrace(trace);
    const now = nowIso();
    const owned = this.database.prepare(
      `SELECT 1 FROM agent_harness_jobs
       WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
    ).get(jobId, this.options.instanceId);
    if (!owned) throw new HarnessClaimLostError();
    this.database.prepare(
      `INSERT INTO agent_harness_tool_calls
       (id, job_id, sequence, action, input_json, output_json, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), jobId, trace.sequence, trace.action,
      JSON.stringify(safe.input), JSON.stringify(safe.output), trace.summary.slice(0, 1_000), now,
    );
  }

  private candidateContext(job: HarnessJobRow, project: Record<string, unknown>): {
    project: { id: string; name: string; description: string; profile: Record<string, unknown> };
    task: HarnessTask;
    evidence: HarnessEvidenceSource[];
    images: HarnessImageSource[];
    sourceCandidate?: HarnessCandidate;
  } {
    const frozenProject = parseJson<{ id?: string; name?: string; description?: string; profile?: Record<string, unknown> }>(job.project_snapshot_json, {});
    return {
      project: {
        id: job.project_id,
        name: frozenProject.name ?? String(project.name),
        description: frozenProject.description ?? String(project.description ?? ''),
        profile: frozenProject.profile ?? parseJson<Record<string, unknown>>(String(project.profile_json ?? '{}'), {}),
      },
      task: parseJson<HarnessTask>(job.task_json, { topic: job.topic, goal: job.goal, mustInclude: [], forbidden: [] }),
      evidence: parseJson<HarnessEvidenceSource[]>(job.evidence_snapshot_json, []),
      images: parseJson<HarnessImageSource[]>(job.image_snapshot_json, []),
      ...(job.source_candidate_id ? {
        sourceCandidate: this.sourceCandidate(job.source_candidate_id, job.source_candidate_job_id ?? job.parent_job_id),
      } : {}),
    };
  }

  private checkpointResults(
    job: HarnessJobRow,
    checkpoint: HarnessCandidateCheckpoint,
    context: ReturnType<AgentHarnessService['candidateContext']>,
  ): HarnessCandidateResult[] {
    const audit = { complete: false, summary: '候选已生成，等待独立事实复核。', claims: [] };
    const disclosed = new Set(checkpoint.readEvidenceIds);
    const issues = validateHarnessCandidates(checkpoint.candidates, context.evidence, disclosed, {
      mustInclude: context.task.mustInclude,
      forbidden: context.task.forbidden,
      claimAudit: audit,
      expectedCandidateCount: job.run_kind === 'revision' ? 1 : 3,
      runMode: job.run_kind,
      sourceCandidateIndex: context.sourceCandidate?.candidateIndex,
      revisionInstruction: job.run_kind === 'revision' ? job.instruction : undefined,
      selectedImages: context.images,
      /*
       * 下面三个此前漏传,必须与 runner 生成时那处保持同一套约束。
       *
       * bodyLength 是既有缺陷:不传则校验器落到 medium,于是同一份候选在断点恢复
       * 读结果时按 medium 判长度,而生成时按项目真实档位判 —— 界面显示合格、导出
       * 却被拦,反过来也会发生,极难查。
       * seedingMode 显式写出默认值而不是靠省略:这条路径上没有调用方能指定模式,
       * 写出来让「按素人代发判定」在代码里可见,不必回到校验器才知道默认是什么。
       * projectName 直接传 context.project.name,空白名交给校验器自己跳过品牌词
       * 检查(它有 .trim() 守卫),这里不编默认值 —— 猜出来的项目名会造成误报。
       */
      bodyLength: context.task.bodyLength ?? context.task.methodProfile?.bodyLength,
      seedingMode: DEFAULT_HARNESS_SEEDING_MODE,
      projectName: context.project.name,
    });
    return checkpoint.candidates.map((candidate) => {
      const candidateIssues = issues.filter((issue) => issue.candidateIndex === candidate.candidateIndex || issue.candidateIndex === -1);
      return {
        ...candidate,
        claimAudit: [],
        publicationChecklist: publicationChecklistFor(candidate, candidateIssues),
        validation: { valid: false, issues: candidateIssues },
      };
    });
  }

  private persistCandidates(jobId: string, projectId: string, candidates: HarnessCandidateResult[], now: string): void {
    const upsert = this.database.prepare(
      `INSERT INTO agent_harness_candidates
       (id, job_id, project_id, candidate_index, content_json, validation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, candidate_index) DO UPDATE SET
         content_json=excluded.content_json, validation_json=excluded.validation_json, updated_at=excluded.updated_at`,
    );
    for (const candidate of candidates) {
      const { validation, ...content } = candidate;
      upsert.run(randomUUID(), jobId, projectId, candidate.candidateIndex, JSON.stringify(content), JSON.stringify(validation), now, now);
    }
  }

  private persistedCandidates(jobId: string): HarnessCandidate[] {
    return (this.database.prepare(
      'SELECT content_json FROM agent_harness_candidates WHERE job_id=? ORDER BY candidate_index',
    ).all(jobId) as Array<{ content_json: string }>).map((row) => parseJson<HarnessCandidate>(row.content_json, {} as HarnessCandidate));
  }

  private mergeUsage(
    base: { modelCalls?: number; inputTokens?: number; outputTokens?: number; toolCalls?: number; replans?: number },
    added: { modelCalls?: number; inputTokens?: number; outputTokens?: number; toolCalls?: number; replans?: number },
  ): { modelCalls: number; inputTokens: number; outputTokens: number; toolCalls: number; replans: number } {
    return {
      modelCalls: (base.modelCalls ?? 0) + (added.modelCalls ?? 0),
      inputTokens: (base.inputTokens ?? 0) + (added.inputTokens ?? 0),
      outputTokens: (base.outputTokens ?? 0) + (added.outputTokens ?? 0),
      toolCalls: (base.toolCalls ?? 0) + (added.toolCalls ?? 0),
      replans: (base.replans ?? 0) + (added.replans ?? 0),
    };
  }

  private async process(id: string): Promise<void> {
    // The job can be soft-deleted after claimNextFair() schedules this callback but
    // before setImmediate runs. Treat that narrow race as a cancelled claim rather
    // than allowing jobRow() to reject outside the process settlement boundary.
    const job = this.database.prepare(
      'SELECT * FROM agent_harness_jobs WHERE id=? AND deleted_at IS NULL',
    ).get(id) as unknown as HarnessJobRow | undefined;
    if (!job) return;
    const project = this.resources.projectRow(job.project_id);
    const workspaceId = String(project.workspace_id);
    const controller = new AbortController();
    this.abortControllers.set(id, controller);
    let failureStage = 'initializing';
    let hasCheckpoint = Boolean(job.candidate_checkpoint_at && this.persistedCandidates(id).length);
    try {
      this.startHeartbeat(id);
      this.progress(id, hasCheckpoint ? 78 : 8);

      failureStage = 'provider_contract';
      const settings = this.settings.provider(workspaceId, job.created_by);
      if (!settings.apiKey) throw new BadRequestException('模型 API Key 已不可用。');
      const frozenProvider = parseJson<Record<string, unknown>>(job.provider_snapshot_json, {});
      if (frozenProvider.configVersion && frozenProvider.configVersion !== settings.configVersion) {
        throw new ConflictException('模型配置在排队期间发生变化，本次未调用模型，请重新提交运行。');
      }
      const context = this.candidateContext(job, project);
      const provider = this.modelProvider(settings, id);
      let result: Awaited<ReturnType<typeof runAgentHarness>>;

      if (hasCheckpoint) {
        failureStage = 'final_review';
        const candidates = this.persistedCandidates(id);
        const started = nowIso();
        const marked = this.database.prepare(
          `UPDATE agent_harness_jobs SET review_status='running', review_error='', review_attempt_count=review_attempt_count+1,
             progress=88, failure_stage='final_review', updated_at=?
           WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
        ).run(started, id, this.options.instanceId);
        if (marked.changes !== 1) throw new HarnessClaimLostError();
        const reviewed = await reviewHarnessCandidates({
          jobId: id, ...context, runMode: job.run_kind,
          revisionInstruction: job.run_kind === 'revision' ? job.instruction : undefined,
          candidates, readEvidenceIds: parseJson<string[]>(job.read_evidence_ids_json, []),
          provider, signal: controller.signal, onProgress: (value) => this.progress(id, value),
          // 模式显式写出而不是靠省略取默认:省略时「这条路走的是哪个模式」只能去读
          // 校验器内部的 ?? 才知道,而它和 checkpointResults 那处必须始终是同一个值。
          seedingMode: DEFAULT_HARNESS_SEEDING_MODE,
        });
        const priorUsage = parseJson<Record<string, number>>(job.usage_json, {});
        result = {
          ...reviewed,
          traces: [], decisionSummary: job.decision_summary,
          sourceEvidenceIds: context.evidence.map((item) => item.evidenceId),
          usage: this.mergeUsage(priorUsage, reviewed.usage),
        };
      } else {
        this.database.prepare(
          `DELETE FROM agent_harness_tool_calls WHERE job_id=?
            AND EXISTS (SELECT 1 FROM agent_harness_jobs j
              WHERE j.id=? AND j.status='running' AND j.claimed_by=? AND j.deleted_at IS NULL)`,
        ).run(id, id, this.options.instanceId);
        failureStage = 'agent_runtime';
        result = await runAgentHarness({
          jobId: id, ...context, runMode: job.run_kind,
          revisionInstruction: job.run_kind === 'revision' ? job.instruction : undefined,
          // 与断点恢复那条路走同一个模式,否则同一个任务两次运行的判定标准不同。
          seedingMode: DEFAULT_HARNESS_SEEDING_MODE,
          provider, signal: controller.signal,
          onProgress: (value) => this.progress(id, value),
          onTrace: (trace) => this.recordTrace(id, trace),
          onCandidates: (checkpoint) => {
            const now = nowIso();
            const blocked = this.checkpointResults(job, checkpoint, context);
            this.database.transaction(() => {
              const owned = this.database.prepare(
                `SELECT 1 FROM agent_harness_jobs WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
              ).get(id, this.options.instanceId);
              if (!owned) throw new HarnessClaimLostError();
              this.persistCandidates(id, job.project_id, blocked, now);
              const updated = this.database.prepare(
                `UPDATE agent_harness_jobs SET candidate_checkpoint_at=COALESCE(candidate_checkpoint_at, ?),
                   read_evidence_ids_json=?, decision_summary=?, usage_json=?, review_status='running', review_error='',
                   review_attempt_count=review_attempt_count+1, progress=75, failure_stage='final_review', updated_at=?
                 WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
              ).run(now, JSON.stringify(checkpoint.readEvidenceIds), checkpoint.decisionSummary,
                JSON.stringify(checkpoint.usage), now, id, this.options.instanceId);
              if (updated.changes !== 1) throw new HarnessClaimLostError();
            });
            hasCheckpoint = true;
          },
        });
      }

      failureStage = 'persisting';
      const now = nowIso();
      this.database.transaction(() => {
        this.persistCandidates(id, job.project_id, result.candidates, now);
        const completed = this.database.prepare(
          `UPDATE agent_harness_jobs SET status='completed', progress=100, decision_summary=?,
             review_summary=?, claim_audit_summary=?, review_status=?, review_error=?, usage_json=?,
             partial_usage_json=?, error=NULL, failure_stage='', quota_consumed_count=0,
             completed_at=?, updated_at=?, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
           WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
        ).run(result.decisionSummary, result.reviewSummary, result.claimAuditSummary, result.reviewStatus,
          result.reviewError ?? '', JSON.stringify(result.usage),
          (this.database.prepare('SELECT partial_usage_json FROM agent_harness_jobs WHERE id=?').get(id) as { partial_usage_json: string }).partial_usage_json,
          now, now, id, this.options.instanceId);
        if (completed.changes !== 1) throw new HarnessClaimLostError();
        this.audit.record({ workspaceId, userId: job.created_by, action: 'agent-harness.complete',
          entityType: 'agent_harness_job', entityId: id, details: { projectId: job.project_id,
            candidateCount: result.candidates.length, validCandidateCount: result.candidates.filter((item) => item.validation.valid).length,
            reviewStatus: result.reviewStatus, modelCalls: result.usage.modelCalls, toolCalls: result.usage.toolCalls } });
      });
    } catch (error) {
      if (error instanceof HarnessClaimLostError) return;
      const now = nowIso();
      try {
        this.database.transaction(() => {
          const current = this.database.prepare(
            `SELECT quota_consumed_count, provider_started_at, candidate_checkpoint_at FROM agent_harness_jobs
             WHERE id=? AND status='running' AND claimed_by=?`,
          ).get(id, this.options.instanceId) as { quota_consumed_count: number; provider_started_at: string | null; candidate_checkpoint_at: string | null } | undefined;
          if (!current) throw new HarnessClaimLostError();
          const refundable = current.quota_consumed_count > 0 && !current.provider_started_at;
          if (refundable) this.settings.refundPlatformQuota(workspaceId, current.quota_consumed_count);
          const message = error instanceof BadRequestException || error instanceof ConflictException
            ? error.message
            : publicFailure(error, parseJson<{ mode?: 'platform' | 'byok' }>(job.provider_snapshot_json, {}).mode ?? 'platform', refundable);
          const preserve = Boolean(current.candidate_checkpoint_at) && !controller.signal.aborted;
          const settled = this.database.prepare(
            `UPDATE agent_harness_jobs SET status=?, progress=100, error=?, failure_stage=?,
               review_status=CASE WHEN ? THEN 'blocked' ELSE review_status END,
               review_error=CASE WHEN ? THEN ? ELSE review_error END,
               quota_consumed_count=0, completed_at=?, updated_at=?, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
             WHERE id=? AND status='running' AND claimed_by=?`,
          ).run(preserve ? 'completed' : 'failed', preserve ? null : message,
            controller.signal.aborted ? 'cancelled' : failureStage, preserve ? 1 : 0, preserve ? 1 : 0,
            preserve ? message : '', now, now, id, this.options.instanceId);
          if (settled.changes !== 1) throw new HarnessClaimLostError();
          const auditDetails = { projectId: job.project_id, failureStage,
            candidatesPreserved: preserve, cancelled: controller.signal.aborted, quotaRefunded: refundable };
          if (preserve) {
            this.audit.record({ workspaceId, userId: job.created_by, action: 'agent-harness.review-blocked',
              entityType: 'agent_harness_job', entityId: id, details: auditDetails });
          } else {
            this.audit.record({ workspaceId, userId: job.created_by, action: 'agent-harness.fail',
              entityType: 'agent_harness_job', entityId: id, details: auditDetails });
          }
        });
      } catch (settleError) {
        if (settleError instanceof HarnessClaimLostError) return;
        throw settleError;
      }
    } finally {
      this.abortControllers.delete(id);
      this.stopHeartbeat(id);
    }
  }

  private refundOutstandingQuota(id: string): void {
    const row = this.database.prepare(
      `SELECT j.quota_consumed_count, j.provider_started_at, p.workspace_id
       FROM agent_harness_jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=?`,
    ).get(id) as { quota_consumed_count: number; provider_started_at: string | null; workspace_id: string } | undefined;
    if (!row?.quota_consumed_count) return;
    // A stale lease may have died after dispatch. Once dispatch started, supplier
    // cost is possible and the platform charge must remain settled.
    if (!row.provider_started_at) this.settings.refundPlatformQuota(row.workspace_id, row.quota_consumed_count);
    this.database.prepare(
      'UPDATE agent_harness_jobs SET quota_consumed_count=0 WHERE id=?',
    ).run(id);
  }

  private async buildEvidenceSnapshot(projectId: string, task: HarnessTask): Promise<HarnessEvidenceSource[]> {
    const rows = this.database.prepare(
      `WITH ranked AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY filename ORDER BY version DESC, created_at DESC, id DESC
         ) AS version_rank
         FROM knowledge_files WHERE project_id=? AND deleted_at IS NULL
       )
       SELECT * FROM ranked WHERE version_rank=1 AND category<>'reference-corpus' ORDER BY filename`,
    ).all(projectId) as unknown as Record<string, unknown>[];
    assertKnowledgeRowsBudget('Agent Harness', rows);
    const documents: KnowledgeDocument[] = [];
    let totalBytes = 0;
    for (const row of rows) {
      const content = await readStoredText({
        dataDir: this.database.options.dataDir,
        projectDir: join(this.database.knowledgeDir, projectId),
        storagePath: String(row.storage_path),
      }, MAX_FILE_BYTES);
      totalBytes += Buffer.byteLength(content, 'utf8');
      assertKnowledgeContextBudget({ operation: 'Agent Harness', fileCount: rows.length, totalBytes });
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      documents.push(indexKnowledgeSource({
        id: String(row.id), projectId, path: String(row.filename), content,
        version: String(row.version), importedAt: String(row.created_at),
        metadata: {
          title: typeof metadata.title === 'string' ? metadata.title : String(row.filename),
          kind: this.knowledgeKind(String(metadata.kind ?? row.category)),
          evidenceStatus: this.evidenceStatus(String(row.evidence_status)),
          keywords: Array.isArray(metadata.keywords) ? metadata.keywords.map(String) : [],
          scope: Array.isArray(metadata.scope) ? metadata.scope.map(String) : [],
          caveats: Array.isArray(metadata.caveats) ? metadata.caveats.map(String) : [],
        },
      }));
    }
    if (!documents.length) return [];
    const documentsById = new Map(documents.map((document) => [document.id, document]));
    // Freeze every section. The model receives only the inventory initially; search
    // and read_evidence disclose bodies on demand. This preserves autonomous discovery
    // without pre-filtering valuable sources by a generic queue-time query.
    return documents.flatMap((document) => splitKnowledgeDocument(document).map((section): HarnessEvidenceSource => ({
      evidenceId: evidenceIdForSection(section),
      documentId: section.documentId,
      path: section.path,
      heading: section.heading ?? 'document',
      content: section.content,
      kind: documentsById.get(section.documentId)?.metadata.kind ?? 'unknown',
      evidenceStatus: documentsById.get(section.documentId)?.metadata.evidenceStatus ?? 'unknown',
      caveats: documentsById.get(section.documentId)?.metadata.caveats ?? [],
    })));
  }

  private buildImageSnapshot(projectId: string, assetIds: string[]): HarnessImageSource[] {
    if (!assetIds.length) return [];
    const unique = [...new Set(assetIds)];
    if (unique.length > 12) throw new BadRequestException('图片素材最多选择 12 张');
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.database.prepare(
      `SELECT a.id, a.filename, a.media_type, a.width, a.height,
              v.id AS analysis_id, v.observation_json, v.approved_at
         FROM image_assets a
         JOIN image_analysis_versions v ON v.id=(
           SELECT selected.id FROM image_analysis_versions selected
            WHERE selected.image_asset_id=a.id AND selected.project_id=a.project_id
              AND selected.status='approved' AND selected.deleted_at IS NULL
            ORDER BY selected.version DESC LIMIT 1
         )
        WHERE a.project_id=? AND a.deleted_at IS NULL AND a.id IN (${placeholders})`,
    ).all(projectId, ...unique) as unknown as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const missing = unique.filter((id) => !byId.has(id));
    if (missing.length) throw new BadRequestException('所选图片必须属于当前项目，且已有已批准的观察版本');
    return unique.map((assetId) => {
      const row = byId.get(assetId)!;
      const observation = parseJson<Record<string, unknown>>(row.observation_json, {});
      const evidenceId = `evidence_image_${createHash('sha256')
        .update(`${assetId}:${String(row.analysis_id)}:${JSON.stringify(observation)}`, 'utf8')
        .digest('hex').slice(0, 20)}`;
      return {
        assetId,
        evidenceId,
        filename: String(row.filename),
        mediaType: String(row.media_type),
        width: Number(row.width) || undefined,
        height: Number(row.height) || undefined,
        observation,
        analysisId: String(row.analysis_id),
        ...(row.approved_at ? { approvedAt: String(row.approved_at) } : {}),
      };
    });
  }

  private sourceCandidate(candidateId: string, sourceJobId: string | null): HarnessCandidate | undefined {
    if (!sourceJobId) return undefined;
    const row = this.database.prepare(
      'SELECT content_json FROM agent_harness_candidates WHERE id=? AND job_id=?',
    ).get(candidateId, sourceJobId) as { content_json: string } | undefined;
    return row ? parseJson<HarnessCandidate | undefined>(row.content_json, undefined) : undefined;
  }

  private threadStopReasonLabel(value: string): string {
    return ({ answered: '问题已充分回答', no_new_gap: '没有新增缺口', evidence_boundary: '到达证据边界', professional_review: '需转专业复核' } as Record<string, string>)[value] ?? value;
  }

  private routeOwnerLabel(value: string): string {
    return ({ publisher: '发布账号', staff: '项目人员', expert: '专业人员' } as Record<string, string>)[value] ?? value;
  }

  private candidateMarkdown(candidate: HarnessCandidate, validation: { valid?: boolean; issues?: unknown[] }): string {
    const { N, H, Cref, publishing } = candidate.content;
    const lines = [
      `# ${N.title}`, '', `> 创意命题：${candidate.concept}`, '',
      ...(candidate.marketingStrategy ? [
        '## 软营销心智链', '',
        `叙事路径：${narrativePathLabel(candidate.marketingStrategy.narrativePath)}`,
        `用户欲望：${candidate.marketingStrategy.readerDesire}`,
        `隐藏卡点：${candidate.marketingStrategy.hiddenTension}`,
        `认知翻转：${candidate.marketingStrategy.oldJudgment} → ${candidate.marketingStrategy.newJudgment}`,
        `项目承接：${candidate.marketingStrategy.projectBridge}`,
        `低压力下一步：${candidate.marketingStrategy.lowPressureNextStep}`, '',
      ] : []),
      '## 封面', '', `主文案：${N.coverHeadline}`, `副文案：${N.coverSubheadline}`, '',
      '## 逐图脚本', '', `总任务：${N.imageBrief}`, '',
      ...N.imageSequence.flatMap((item) => [
        `### 图 ${item.sequence} · ${item.role}`, '',
        `来源：${item.source === 'selected_asset' ? `已选素材 ${item.assetId}` : '新设计'}`,
        `画面/制作方向：${item.direction}`, `叠字：${item.overlayText || '无'}`,
        `证据：${item.evidenceIds.join('、') || '无'}`, '',
      ]),
      '## 发布正文', '', N.body, '', `行动引导：${N.callToAction}`, '',
      '## 标签', '', H.hashtags.join(' '), '',
      '## 账号首评', '', Cref.ownedFirstComment, '',
      // 提示语取自常量而非候选数据:它是给操盘手看的标注，不是要粘贴进评论区的内容。
      // 导出件是内部工作文档，这句话该留；改成常量后也不会因模型漏写而消失。
      '## 模拟问答参考', '', HARNESS_SIMULATION_NOTICE, '',
    ];
    for (const thread of Cref.threads) {
      const kind = thread.threadKind ?? 'org_answer';
      if (kind === 'organic_reaction') {
        lines.push(`**短反应 · ${thread.displayName || '模拟读者'}**`, '', thread.question, '');
        continue;
      }
      if (kind === 'reader_exchange') {
        lines.push(`**读者接话 · ${thread.displayName || '模拟读者 A'}**`, '', thread.question, '', `${thread.replyDisplayName || '模拟读者 B'}：${thread.answer}`, '');
        for (const followUp of thread.followUps) lines.push(`${followUp.kind === 'counterexample' ? '反例' : '接着聊'}：${followUp.question}`, followUp.answer, '');
        continue;
      }
      lines.push(`**${thread.displayName || '模拟读者'}问：${thread.question}**`, '', `${this.routeOwnerLabel(thread.postingIdentity === 'staff' || thread.postingIdentity === 'expert' ? thread.postingIdentity : 'publisher')}答：${thread.answer}`, '');
      for (const followUp of thread.followUps) lines.push(`${followUp.kind === 'counterexample' ? '反例' : '追问'}：${followUp.question}`, `答：${followUp.answer}`, '');
      if (thread.clarification) lines.push(`澄清：${thread.clarification}`, '');
      if (thread.nextStep) lines.push(`下一步：${thread.nextStep}`, '');
      if (thread.boundary) lines.push(`边界：${thread.boundary}`, '');
      if (thread.stopReason) lines.push(`停止原因：${this.threadStopReasonLabel(thread.stopReason)}`, '');
    }
    lines.push(
      '## 发布说明', '', `入口：${publishing.entryPoint}`, `发布身份：${publishing.accountIdentity}`,
      `时机说明：${publishing.timingNote}`, `互动目标：${publishing.interactionGoal}`, '',
      '## aC · 真实问题承接计划（计划，非已执行）', '',
      `首次响应：${publishing.responseSla || '旧运行未记录'}`, '',
      '### 问题分流', '',
      ...((publishing.liveQuestionRoutes ?? []).length ? (publishing.liveQuestionRoutes ?? []).map((route) => `- 当${route.when} → ${this.routeOwnerLabel(route.owner)}：${route.action}`) : ['- 旧运行未记录']), '',
      '### 更新触发', '', ...((publishing.updateTriggers ?? []).length ? (publishing.updateTriggers ?? []).map((item) => `- ${item}`) : ['- 旧运行未记录']), '',
      '### 停止规则', '', ...((publishing.stopRules ?? []).length ? (publishing.stopRules ?? []).map((item) => `- ${item}`) : ['- 旧运行未记录']), '',
      '## 所选素材决策', '',
      ...candidate.assetDecisions.flatMap((item) => [
        `- ${item.assetId}：${item.decision === 'use' ? '使用' : '舍弃'}；${item.rationale}（证据：${item.evidenceIds.join('、') || '无'}）`,
      ]), '',
      '## 发布前检查', '',
      ...((candidate as HarnessCandidate & { publicationChecklist?: Array<{ key: string; status: string; note: string }> }).publicationChecklist ?? [])
        .map((item) => `- ${publicationCheckLabel(item.key)} · ${publicationCheckStatus(item.status)}：${item.note}`), '',
      `硬校验：${validation.valid === true ? '通过' : '未通过'}`, '',
      '## 未知与自评', '', ...candidate.unknowns.map((item) => `- ${item}`), '', candidate.selfReview,
    );
    if (candidate.revisionNotes.instructionApplied.length || candidate.revisionNotes.preservedElements.length) {
      lines.push('', '## 定向改稿记录', '', `已落实：${candidate.revisionNotes.instructionApplied.join('；')}`, `已保留：${candidate.revisionNotes.preservedElements.join('；')}`);
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }

  private modelProvider(settings: ResolvedProviderSettings, jobId: string): HarnessModelProvider {
    const client = new OpenAICompatibleClient({
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      transport: settings.transport,
      structuredOutput: settings.mode === 'byok' || settings.provider.toLowerCase().includes('compatible')
        ? 'json_object' : 'json_schema',
      includeTemperature: true,
      fetch: settings.mode === 'byok'
        ? createSafeModelFetch({
            allowHttp: this.options.byokAllowHttp,
            allowPrivateNetwork: this.options.byokAllowPrivateNetwork,
          })
        : undefined,
      maxOutputTokenLimit: modelOutputTokenLimit(settings),
      timeoutMs: Math.max(10_000, Math.min(300_000, this.options.modelRequestTimeoutMs)),
    });
    return {
      generate: async (request) => {
        let lastError: unknown;
        const maxAttempts = request.metadata.purpose === 'agent_harness_final_review'
          ? 1
          : this.options.modelRetryAttempts;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          try {
            const startedAt = nowIso();
            const owned = this.database.prepare(
              `UPDATE agent_harness_jobs SET provider_started_at=COALESCE(provider_started_at, ?), failure_stage='provider_request', updated_at=?
               WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
            ).run(startedAt, startedAt, jobId, this.options.instanceId);
            if (owned.changes !== 1) throw new HarnessClaimLostError();
            const before = parseJson<{ modelCalls?: number; inputTokens?: number; outputTokens?: number }>(
              (this.database.prepare('SELECT partial_usage_json FROM agent_harness_jobs WHERE id=?').get(jobId) as { partial_usage_json: string } | undefined)?.partial_usage_json ?? '{}', {},
            );
            this.database.prepare('UPDATE agent_harness_jobs SET partial_usage_json=?, updated_at=? WHERE id=?').run(JSON.stringify({
              modelCalls: (before.modelCalls ?? 0) + 1,
              inputTokens: before.inputTokens ?? 0,
              outputTokens: before.outputTokens ?? 0,
            }), nowIso(), jobId);
            const result = await client.generate({ ...request, signal: request.signal });
            const afterDispatch = parseJson<{ modelCalls?: number; inputTokens?: number; outputTokens?: number }>(
              (this.database.prepare('SELECT partial_usage_json FROM agent_harness_jobs WHERE id=?').get(jobId) as { partial_usage_json: string } | undefined)?.partial_usage_json ?? '{}', {},
            );
            this.database.prepare('UPDATE agent_harness_jobs SET partial_usage_json=?, updated_at=? WHERE id=?').run(JSON.stringify({
              modelCalls: afterDispatch.modelCalls ?? 1,
              inputTokens: (afterDispatch.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0),
              outputTokens: (afterDispatch.outputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
            }), nowIso(), jobId);
            return { text: result.text, usage: result.usage };
          } catch (error) {
            lastError = error;
            const status = error instanceof ModelProviderError ? error.status : undefined;
            if (classifyModelFailure(error) === 'incomplete') throw error;
            if (status !== undefined && status !== 429 && status < 500) throw error;
            if (attempt < maxAttempts - 1) {
              await this.abortableDelay(this.options.modelRetryBaseDelayMs * 2 ** attempt, request.signal);
            }
          }
        }
        throw lastError;
      },
    };
  }

  private mapJob(row: HarnessJobRow, includeDetails: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: row.id,
      projectId: row.project_id,
      channel: 'agent_harness',
      status: row.status,
      progress: Number(row.progress),
      topic: row.topic,
      goal: row.goal,
      runKind: row.run_kind,
      parentJobId: row.parent_job_id,
      sourceCandidateId: row.source_candidate_id,
      instruction: row.instruction || undefined,
      error: row.error,
      attemptCount: Number(row.attempt_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      failureStage: row.failure_stage || undefined,
      reviewStatus: row.review_status,
      reviewError: row.review_error || undefined,
      reviewAttemptCount: Number(row.review_attempt_count),
      candidateCheckpointAt: row.candidate_checkpoint_at,
      queuePosition: row.status === 'queued' ? this.queuePosition(row) : undefined,
      queueLength: row.status === 'queued' ? this.queueLength() : undefined,
      cancelledAt: row.cancelled_at,
      selectedCandidateId: row.selected_candidate_id,
      approvalStatus: row.approval_status,
      approvalNotes: row.approval_notes || undefined,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      approvedContentHash: row.approved_content_hash || undefined,
      purgeAfter: row.purge_after,
      parentDeleted: row.parent_job_id ? Boolean((this.database.prepare('SELECT deleted_at FROM agent_harness_jobs WHERE id=?').get(row.parent_job_id) as { deleted_at: string | null } | undefined)?.deleted_at) : false,
    };
    if (!includeDetails) return base;
    const candidates = (this.database.prepare(
      'SELECT * FROM agent_harness_candidates WHERE job_id=? ORDER BY candidate_index',
    ).all(row.id) as unknown as Array<Record<string, unknown>>).map((candidate) => ({
      id: candidate.id,
      ...parseJson<Record<string, unknown>>(candidate.content_json, {}),
      validation: parseJson(candidate.validation_json, {}),
    }));
    const traces = (this.database.prepare(
      'SELECT * FROM agent_harness_tool_calls WHERE job_id=? ORDER BY sequence',
    ).all(row.id) as unknown as Array<Record<string, unknown>>).map((trace) => ({
      sequence: Number(trace.sequence),
      action: trace.action,
      input: parseJson(trace.input_json, {}),
      output: parseJson(trace.output_json, {}),
      summary: trace.summary,
      createdAt: trace.created_at,
    }));
    return {
      ...base,
      task: parseJson(row.task_json, {}),
      runtimeSnapshot: parseJson(row.runtime_snapshot_json, {}),
      projectSnapshot: parseJson(row.project_snapshot_json, {}),
      providerSnapshot: parseJson(row.provider_snapshot_json, {}),
      evidenceInventory: parseJson<HarnessEvidenceSource[]>(row.evidence_snapshot_json, []).map((item) => ({
        evidenceId: item.evidenceId,
        path: item.path,
        heading: item.heading,
        kind: item.kind,
        evidenceStatus: item.evidenceStatus,
        caveats: item.caveats,
      })),
      imageSnapshot: parseJson<HarnessImageSource[]>(row.image_snapshot_json, []).map((image) => ({
        assetId: image.assetId,
        evidenceId: image.evidenceId,
        filename: image.filename,
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        analysisId: image.analysisId,
        approvedAt: image.approvedAt,
      })),
      decisionSummary: row.decision_summary,
      reviewSummary: row.review_summary,
      claimAuditSummary: row.claim_audit_summary,
      usage: parseJson(row.usage_json, {}),
      partialUsage: parseJson(row.partial_usage_json, {}),
      candidates,
      traces,
      derivedRuns: (this.database.prepare(
        `SELECT * FROM agent_harness_jobs WHERE parent_job_id=? AND deleted_at IS NULL ORDER BY created_at DESC`,
      ).all(row.id) as unknown as HarnessJobRow[]).map((child) => this.mapJob(child, false)),
    };
  }

  private queuePosition(row: HarnessJobRow): number {
    const activeFor = (createdBySql: string) =>
      `(SELECT COUNT(*) FROM agent_harness_jobs active
         WHERE active.created_by=${createdBySql} AND active.status='running' AND active.deleted_at IS NULL)`;
    const currentActive = activeFor('?');
    const queuedActive = activeFor('queued.created_by');
    return 1 + Number((this.database.prepare(
      `SELECT COUNT(*) AS value FROM agent_harness_jobs queued
       WHERE queued.status='queued' AND queued.deleted_at IS NULL AND queued.id<>?
         AND (${queuedActive} < ${currentActive}
           OR (${queuedActive} = ${currentActive}
             AND (queued.created_at < ? OR (queued.created_at = ? AND queued.id < ?))))`,
    ).get(row.id, row.created_by, row.created_by, row.created_at, row.created_at, row.id) as { value: number }).value);
  }

  private queueLength(): number {
    return Number((this.database.prepare(
      `SELECT COUNT(*) AS value FROM agent_harness_jobs WHERE status='queued' AND deleted_at IS NULL`,
    ).get() as { value: number }).value);
  }

  private abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('Agent Harness run cancelled'));
      const timer = setTimeout(done, ms);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error('Agent Harness run cancelled')); };
      function cleanup() { signal?.removeEventListener('abort', onAbort); }
      function done() { cleanup(); resolve(); }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Keep this mapping byte-compatible with KnowledgeService: persisted rows use
  // Chinese product labels (for example “已知事实” and “猜想”), while agent-core
  // consumes the normalized English union. Falling unknown here silently strips
  // every project selling point from the Harness.
  private knowledgeKind(value: string): KnowledgeKind {
    const lower = value.toLowerCase();
    if (/禁止|prohibit|forbidden/u.test(lower)) return 'prohibited';
    if (/未知|unknown|不足/u.test(lower)) return 'unknown';
    if (/猜想|hypothesis/u.test(lower)) return 'hypothesis';
    if (/推理|inference/u.test(lower)) return 'inference';
    if (/方法|formula|method|prompt|提示词|evaluation|评分/u.test(lower)) return 'methodology';
    if (/案例|样本|case|sample|reference|corpus|对标/u.test(lower)) return 'case';
    if (/用户|观点|user/u.test(lower)) return 'user_view';
    return 'fact';
  }

  private evidenceStatus(value: string): EvidenceStatus {
    if (/observed|核验|已知事实/u.test(value)) return 'observed';
    if (/inferred|推理|猜想/u.test(value)) return 'inferred';
    if (/unknown|未知|不足/u.test(value)) return 'unknown';
    return 'user_supplied';
  }
}
