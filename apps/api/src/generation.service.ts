import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ContentGenerationAgent,
  GENERATION_PARAMETER_REGISTRY,
  ModelProviderError,
  OpenAICompatibleClient,
  indexKnowledgeSource,
  type ContentPackage,
  type FormulaVersion,
  type GenerationParameterSelection,
  type KnowledgeDocument,
  type KnowledgeKind,
  type ModelProvider,
  type ParameterImpactReport,
  type ParameterResolutionSnapshot,
  type PlanningContext,
  type ResolvedGenerationConfig,
} from '@content-agent/agent-core';
import {
  BadRequestException, HttpException, Inject, Injectable, NotFoundException,
  type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import {
  diagnosticProxiesFromImpactReport,
  normalizeContentPackageForApi,
  normalizeDiagnosticForApi,
  normalizeImpactReportForApi,
} from './diagnostic-contract.js';
import { FormulaService } from './formula.service.js';
import { readerView } from './generation-reader-view.js';
import {
  claimNext,
  claimNextJob,
  heartbeatJob,
  heartbeatTask,
  queuedJobCount,
  queuedJobPosition,
  reclaimStale,
  reclaimStaleJobs,
  REVISION_TASKS_SPEC,
} from './job-claim.js';
import { classifyModelFailure, modelFailureMessage } from './model-failure.js';
import { detectProviderOutage } from './provider-outage.js';
import { IntelligenceService } from './intelligence.service.js';
import {
  assertKnowledgeContextBudget,
  assertKnowledgeRowsBudget,
} from './knowledge-budget.js';
import type { SessionPrincipal } from './models.js';
import { PresetService } from './preset.service.js';
import { ResourceService } from './resource.service.js';
import { ResearchService } from './research.service.js';
import { RevisionService } from './revision.service.js';
import { createSafeModelFetch } from './safe-model-fetch.js';
import { SettingsService } from './settings.service.js';
import { readStoredText } from './storage-file.js';
import { nowIso, parseJson } from './utils.js';

const MAX_KNOWLEDGE_BYTES = 2 * 1024 * 1024;

interface JobRow {
  id: string;
  project_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  config_json: string;
  seed: string;
  formula_version_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  topic: string;
  goal: string;
  mode: 'simple' | 'advanced';
  progress: number;
  error: string | null;
  completed_at: string | null;
  /** 软删时间戳;非空表示已从列表中移除(记录与内容包仍在,可撤销) */
  deleted_at: string | null;
  knowledge_context_json: string;
  preset_id: string | null;
  style_profile_version: number;
  resolution_snapshot_json: string;
  config_impact_json: string;
  opportunity_id: string | null;
  opportunity_snapshot_json: string;
  planning_context_json: string;
  image_context_json: string;
  release_manifest_id: string | null;
  research_snapshot_json: string;
  quality_status: 'unknown' | 'passed' | 'needs_review';
  /** 批次归属;单篇生成恒为 null(迁移 v12 加入) */
  batch_id: string | null;
}

interface PackageRow {
  id: string;
  job_id: string;
  project_id: string;
  candidate_index: number;
  content_json: string;
  created_at: string;
  updated_at: string;
}

interface ModelProviderRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

/** 任务已被回收、接管或删除；旧执行者必须丢弃本轮结果。 */
class ClaimLostError extends Error {
  constructor(readonly taskKind: 'generation' | 'revision') {
    super(`${taskKind} task claim lost`);
    this.name = 'ClaimLostError';
  }
}

function publicHttpExceptionMessage(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') return response.slice(0, 1_000);
  if (response && typeof response === 'object') {
    const value = (response as { message?: unknown }).message;
    if (typeof value === 'string') return value.slice(0, 1_000);
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string').join('；');
      if (joined) return joined.slice(0, 1_000);
    }
  }
  return error.message.slice(0, 1_000);
}

/** Initial generation is charged when accepted, so failure text must not promise a refund. */
function generationFailureMessage(error: unknown): string {
  if (error instanceof HttpException) return publicHttpExceptionMessage(error);
  switch (classifyModelFailure(error)) {
    case 'unavailable':
      return '模型服务暂时不可用，内容生成没有完成。请稍后重试；若持续失败请联系客服。';
    case 'credentials':
      return '模型服务凭据异常，内容生成没有完成。请检查模型设置或联系客服处理。';
    case 'incomplete':
      return '模型这次返回的结果不完整，内容生成没有完成。请重试；若持续失败请联系客服。';
    default:
      return '内容生成失败，未完成本次操作。请重试；若持续失败请联系客服。';
  }
}

export function retryModelProvider(
  provider: ModelProvider,
  options: ModelProviderRetryOptions = {},
): ModelProvider {
  const requestedAttempts = options.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.min(8, Math.floor(requestedAttempts)))
    : 3;
  // 退避窗口要跨过中继的**错误簇**,不是单次抖动。实测(kirostudio 40 分钟日志,
  // 37 个簇):502「读取响应失败」成簇发生,持续 0-410 秒,中位约 16-20 秒。旧配置
  // (baseDelay=300/1000 × 4 次)累计只等 2-7 秒,整段落在簇内必然全败——实测同一篇
  // 生成里 generate_comment_readers 两个候选把 4 次尝试全部耗尽。这解释了台账阶段
  // 100% 失败:它是最后一个阶段,前面每步都在消耗时间与运气。
  // 生产默认 6 次 × 4000ms = 4+8+16+32+64 = 124 秒;上限放宽到 8 次以覆盖长尾。
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 4_000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  return {
    generate: async (request) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await provider.generate(request);
        } catch (error) {
          lastError = error;
          const status = error instanceof ModelProviderError ? error.status : undefined;
          // 可选诊断:确认重试是否真的发生、每次 status 是什么。定位台账 100% 失败
          // 时靠它拿到了"两个候选把 4 次尝试全部耗尽"这一关键证据。
          if (process.env.CONTENT_AGENT_DEBUG_RETRY) {
            const purpose = typeof request.metadata?.purpose === 'string'
              ? request.metadata.purpose.replace(/[^0-9A-Za-z_.:-]/gu, '_').slice(0, 80)
              : 'unknown';
            // Provider messages can contain response bodies, endpoints or
            // tenant data. Diagnostics retain only bounded non-secret fields.
            console.error(`[retry] purpose=${purpose} attempt=${attempt + 1}/${maxAttempts} status=${status ?? 'network'}`);
          }
          if (status !== undefined && status !== 429 && status < 500) throw error;
          if (attempt < maxAttempts - 1) await sleep(baseDelayMs * 2 ** attempt);
        }
      }
      throw lastError;
    },
  };
}

export function serializeModelProvider(provider: ModelProvider): ModelProvider {
  let tail: Promise<void> = Promise.resolve();
  return {
    generate: (request) => {
      const result = tail.then(() => provider.generate(request));
      // Keep the internal tail fulfilled so one failed request cannot poison the queue.
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export function limitModelProvider(provider: ModelProvider, requestedConcurrency = 2): ModelProvider {
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(8, Math.floor(requestedConcurrency)))
    : 2;
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolveWaiter) => waiters.push(() => { active += 1; resolveWaiter(); }));
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  return {
    generate: async (request) => {
      await acquire();
      try {
        return await provider.generate(request);
      } finally {
        release();
      }
    },
  };
}

export type ImageBriefKind = 'generation_brief' | 'disabled' | 'absent' | 'unknown';

export interface ValidationIssueCountHeuristic {
  schemaVersion: '1.0';
  kind: 'validation_issue_count_heuristic';
  semantics: 'non_quality_score';
  status: 'computed';
  value: number;
  range: [0, 100];
  inputs: {
    errorCount: number;
    warningCount: number;
    errorPenalty: 25;
    warningPenalty: 5;
  };
  evidenceStatus: 'operational_heuristic';
  calibrated: false;
  predicts: { quality: false; effect: false };
  excludes: {
    formulaIds: ['F32', 'F33'];
    diagnosticProxies: true;
    emphasis: true;
    missingValues: true;
  };
  consumedBy: {
    generation: false;
    planning: false;
    selection: false;
    validation: false;
  };
}

export function classifyImageBriefKind(actualImageBrief: string, artifactStatus?: string): ImageBriefKind {
  if (artifactStatus === 'disabled') return 'disabled';
  if (artifactStatus === 'absent') return 'absent';
  if (actualImageBrief.trim()) return 'generation_brief';
  if (artifactStatus === 'drafted' || artifactStatus === 'contract_validated') return 'absent';
  return 'unknown';
}

@Injectable()
export class GenerationService implements OnModuleInit, OnModuleDestroy {
  /**
   * 本实例正在跑的任务数。队列本身在 DB 里(status='queued'),这里只留本地计数——
   * 它约束的是**本实例**的并发度(内存、本地 CPU),不是全局资源。真正需要全局
   * 约束的模型并发由 modelMaxConcurrentRequests 与中继侧的凭据池负责。
   */
  private activeJobs = 0;
  private readonly maxConcurrentJobs = 2;
  /** 在跑任务的心跳定时器,按 jobId 索引;任务收尾时清掉。 */
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  /** 在跑的修改任务数。与生成任务分开计:改稿是交互式操作,用户在等,不该被排队的批量生成挡住;反过来也不该占满名额饿死新生成。 */
  private activeRevisions = 0;
  private readonly maxConcurrentRevisions = 2;
  /** 修改任务的心跳定时器,按 revisionId 索引。 */
  private readonly revisionHeartbeats = new Map<string, NodeJS.Timeout>();
  /** 孤儿回收的周期扫描。只在启动时回收不够:实例中途崩掉,它的任务要等下次有人启动才被收回。 */
  private reclaimTimer?: NodeJS.Timeout;
  /** 已关停。定时器回调据此静默放弃,避免撞上已关闭的数据库连接。 */
  private stopped = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PresetService) private readonly presets: PresetService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
    @Inject(ResearchService) private readonly research: ResearchService,
    @Inject(RevisionService) private readonly revisions: RevisionService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  onModuleInit(): void {
    this.reclaimAndDrain();
    // unref:定时器不该阻止进程退出,否则测试里 app.close() 之后进程挂着不走。
    this.reclaimTimer = setInterval(() => this.tick(() => this.reclaimAndDrain()), this.options.jobHeartbeatMs);
    this.reclaimTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    for (const timer of this.revisionHeartbeats.values()) clearInterval(timer);
    this.revisionHeartbeats.clear();
  }

  /**
   * 定时器回调的统一护栏。
   *
   * 关停时 Nest 可能先销毁 DatabaseService、后触发本服务的 onModuleDestroy(销毁
   * 顺序按依赖图,不保证定时器先停),这一拍回调就会撞上「database is not open」
   * 并冒成 unhandledRejection——实测 research 测试因此变红。定时任务全是可跳过的
   * 周期性工作,关停途中静默放弃是正确行为,不需要报错。
   */
  private tick(fn: () => void): void {
    if (this.stopped) return;
    try { fn(); } catch { /* 关停竞态或瞬时锁冲突:下一拍再来 */ }
  }

  /**
   * 回收心跳超时的孤儿任务,然后领取。
   *
   * 回收只看心跳、不看归属:instanceId 含 pid 与随机后缀,重启后是新身份,所以
   * 「心跳新鲜」就等于「有活着的实例在跑」,不论那是谁。这是修掉误杀的关键——原
   * 实现在这里把别的实例正在跑的任务抢回队列,导致同一任务被并发执行、三轮后
   * 触顶判 failed。
   */
  private reclaimAndDrain(): void {
    const result = reclaimStaleJobs(this.database, nowIso(), this.options.jobClaimTimeoutMs);
    for (const jobId of result.requeued) {
      this.event(jobId, 'requeued', { reason: 'claim_timeout' });
    }
    for (const jobId of result.failed) {
      this.event(jobId, 'failed', { message: '任务被反复打断，已停止自动重跑' });
    }
    this.drainQueue();

    // 修改任务走同一份认领/回收实现,但队列名额独立(见 maxConcurrentRevisions)。
    const refundedByRevision = new Map<string, number>();
    const revisionResult = reclaimStale(
      this.database, REVISION_TASKS_SPEC, nowIso(), this.options.jobClaimTimeoutMs,
      (attempts) => `修改被反复打断（${attempts} 次），已停止自动重跑，请重新提交修改要求`,
      (id) => {
        const workspaceId = this.requiredWorkspaceIdForRevision(id);
        const refunded = this.settleRevisionQuota(id, workspaceId, 0);
        refundedByRevision.set(id, refunded);
        if (refunded) {
          this.database
            .prepare('UPDATE revision_tasks SET error = error || ?, updated_at=? WHERE id=?')
            .run(`；已退还本次修改消耗的额度（${refunded} 次）。`, nowIso(), id);
        }
      },
    );
    for (const id of revisionResult.requeued) {
      const task = this.revisions.row(id);
      if (task) this.event(task.job_id, 'revision_requeued', { revisionId: id, reason: 'claim_timeout' });
    }
    for (const id of revisionResult.failed) {
      const task = this.revisions.row(id);
      if (!task) continue;
      const refunded = refundedByRevision.get(id) ?? 0;
      this.event(task.job_id, 'revision_failed', {
        revisionId: id, message: '修改被反复打断，已停止自动重跑', refundedQuota: refunded,
      });
    }
    this.drainRevisions();
  }

  create(raw: Record<string, unknown>, principal: SessionPrincipal): Record<string, unknown> {
    // 扣额度、任务、queued 事件和审计必须同生共死。批量入口已有外层事务；
    // 单篇也显式包裹，避免插入失败或进程在两条语句间退出后留下“扣费但无任务”。
    const id = this.database.transaction(() => this.insertJob(raw, principal, null));
    this.enqueue(id);
    return this.get(id);
  }

  private insertJob(raw: Record<string, unknown>, principal: SessionPrincipal, batchId: string | null): string {
    const projectId = this.requiredString(raw.projectId, 'projectId');
    const project = this.resources.projectRow(projectId);
    this.research.bootstrapProject(projectId, principal.userId);
    const releaseSnapshot = this.research.activeRuntimeSnapshot(projectId);
    const releaseFormulaId = typeof releaseSnapshot.id === 'string' && typeof releaseSnapshot.formulaVersionId === 'string'
      ? releaseSnapshot.formulaVersionId
      : undefined;
    const legacyConfig = isRecord(raw.config) ? raw.config : {};
    const requestedFormulaId = typeof raw.formulaVersion === 'string'
      ? raw.formulaVersion
      : typeof legacyConfig.formulaVersion === 'string'
        ? legacyConfig.formulaVersion
        : undefined;
    if (releaseFormulaId
      && requestedFormulaId
      && !['active', '项目默认'].includes(requestedFormulaId)
      && requestedFormulaId !== releaseFormulaId) {
      throw new BadRequestException({
        message: '正式生成只能使用 active release 绑定的公式版本',
        code: 'RELEASE_FORMULA_CONFLICT',
        releaseFormulaVersionId: releaseFormulaId,
        requestedFormulaVersionId: requestedFormulaId,
      });
    }
    const releaseParameterOverrides = isRecord(releaseSnapshot.parameterOverrides)
      ? releaseSnapshot.parameterOverrides
      : {};
    const planning = this.intelligence.prepareGeneration(projectId, raw);
    const topic = planning.topic;
    const normalizedRaw = {
      ...raw,
      ...(releaseFormulaId ? { formulaVersion: releaseFormulaId } : {}),
      topic,
      parameterValues: {
        ...releaseParameterOverrides,
        ...(isRecord(raw.parameterValues) ? raw.parameterValues : {}),
      },
    };
    const workspaceId = String(project.workspace_id);
    const resolution = this.presets.resolve(projectId, normalizedRaw, principal);
    const formulaVersion = resolution.formulaVersion;
    if (releaseFormulaId && formulaVersion.id !== releaseFormulaId) {
      throw new BadRequestException({
        message: '生成公式与 active release 不一致',
        code: 'RELEASE_FORMULA_CONFLICT',
        releaseFormulaVersionId: releaseFormulaId,
        resolvedFormulaVersionId: formulaVersion.id,
      });
    }
    const config = resolution.resolvedConfig;
    this.assertLatestSelectedKnowledge(projectId, config.knowledge.selectedFileIds);
    this.assertGenerationKnowledgeBudget(projectId, config.knowledge, '内容生成');
    const provider = this.settings.provider(workspaceId, principal.userId);
    if (provider.mode === 'platform' && provider.apiKey) this.settings.consumePlatformQuota(workspaceId);

    const id = randomUUID();
    const now = nowIso();
    const mode = raw.mode === 'advanced' ? 'advanced' : 'simple';
    this.database
      .prepare(
        `INSERT INTO generation_jobs
          (id, project_id, status, config_json, seed, formula_version_id, created_by,
           created_at, updated_at, topic, goal, mode, progress, knowledge_context_json,
           preset_id, style_profile_version, resolution_snapshot_json, config_impact_json,
           opportunity_id, opportunity_snapshot_json, planning_context_json, image_context_json,
           release_manifest_id, research_snapshot_json, batch_id)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        JSON.stringify(config),
        String(config.generation.baseSeed),
        formulaVersion.id,
        principal.userId,
        now,
        now,
        topic,
        config.task.goal,
        mode,
        resolution.preset.id,
        resolution.styleProfileVersion,
        JSON.stringify({
          ...resolution.resolutionSnapshot,
          parameterSelection: resolution.parameterSelection,
          preset: resolution.preset,
          sourceMap: resolution.sourceMap,
          directives: resolution.directives,
          conflicts: resolution.conflicts,
          warnings: resolution.warnings,
          requestOverrides: resolution.requestOverrides,
        }),
        JSON.stringify(resolution.impactReport),
        planning.opportunityId ?? null,
        JSON.stringify(planning.opportunitySnapshot),
        JSON.stringify(planning.planningContext),
        JSON.stringify(planning.imageContext),
        typeof releaseSnapshot.id === 'string' ? releaseSnapshot.id : null,
        JSON.stringify(releaseSnapshot),
        batchId,
      );
    this.event(id, 'queued', {
      providerMode: provider.mode,
      hasProviderKey: Boolean(provider.apiKey),
      presetId: resolution.preset.id,
      styleProfileVersion: resolution.styleProfileVersion,
      opportunityId: planning.opportunityId,
      imageAssetCount: planning.imageContext.length,
      changedParameters: resolution.impactPreview.filter((item) => item.source !== 'default').length,
      releaseManifestId: typeof releaseSnapshot.id === 'string' ? releaseSnapshot.id : null,
      batchId,
    });
    this.audit.record({ workspaceId, userId: principal.userId, action: 'generation.create', entityType: 'generation_job', entityId: id, details: { projectId, mode, presetId: resolution.preset.id, styleProfileVersion: resolution.styleProfileVersion, releaseManifestId: typeof releaseSnapshot.id === 'string' ? releaseSnapshot.id : null, batchId } });
    return id;
  }

  createBatch(raw: { projectId?: unknown; name?: unknown; jobs?: unknown }, principal: SessionPrincipal): Record<string, unknown> {
    const projectId = this.requiredString(raw.projectId, 'projectId');
    const jobs = Array.isArray(raw.jobs) ? raw.jobs.filter(isRecord) : [];
    if (!jobs.length) throw new BadRequestException('批量任务不能为空');
    if (jobs.length > 60) throw new BadRequestException('单批任务不能超过 60 篇');
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
    const batchId = randomUUID();
    const now = nowIso();
    // 先建批次账本(queued),再逐个插 job;任一 job 校验失败则整批回滚。
    const jobIds = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO generation_batches
            (id, project_id, name, status, total_jobs, config_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(batchId, projectId, name, jobs.length, JSON.stringify({ count: jobs.length }), principal.userId, now, now);
      return jobs.map((job) => this.insertJob({ ...job, projectId }, principal, batchId));
    });
    // 事务提交后再入队(enqueue 触发异步 process,不能在事务里跑)
    for (const id of jobIds) this.enqueue(id);
    return this.getBatch(batchId);
  }

  batchRow(id: string): Record<string, unknown> {
    const row = this.database.prepare('SELECT * FROM generation_batches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('批次不存在');
    return row;
  }

  getBatch(id: string): Record<string, unknown> {
    const batch = this.batchRow(id);
    const jobRows = this.database.prepare('SELECT * FROM generation_jobs WHERE batch_id = ? ORDER BY created_at').all(id) as unknown as JobRow[];
    // 与列表同一套轻量投影:批次看板读的字段和列表页一样(状态、进度、topic、
    // 配方回填),不需要 planningContext/configImpact 那些重字段。改前实测单个
    // 任务 35 个键,一个 10 篇批次就带上十份重复的影响报告。
    const jobs = jobRows.map((row) => this.mapJobForList(row));
    const status = computeBatchStatus(jobRows.map((row) => row.status));
    // 状态漂移时惰性回写(含 completed_at)。回写后必须回传新值:batch 行是回写前读的,
    // 直接用 batch.completed_at 会让「批次刚好在本次请求收敛到终态」的那一次响应
    // 拿到 status=completed 但 completedAt=undefined(前端看板据此显示耗时/完成时间)。
    let completedAt = (batch.completed_at as string | null) ?? null;
    if (status !== batch.status) {
      completedAt = (status === 'completed' || status === 'failed' || status === 'partial') ? nowIso() : null;
      this.database.prepare('UPDATE generation_batches SET status=?, completed_at=?, updated_at=? WHERE id=?')
        .run(status, completedAt, nowIso(), id);
    }
    return {
      id: batch.id,
      projectId: batch.project_id,
      name: batch.name,
      status,
      totalJobs: batch.total_jobs,
      createdAt: batch.created_at,
      completedAt: completedAt ?? undefined,
      jobs,
    };
  }

  listBatches(projectId: string): Record<string, unknown>[] {
    const rows = this.database.prepare('SELECT id FROM generation_batches WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Array<{ id: string }>;
    return rows.map((row) => this.getBatch(row.id));
  }

  /**
   * 任务列表。已软删的一律不返回(deleted_at IS NULL)。
   *
   * 单条 GET /:id 与 /:id/reader 不加这个过滤:删除后地址可能还在别人的收藏里,
   * 让它继续读得到比 404 更少惊吓——列表里看不见就够了。
   */
  list(projectId?: string): Record<string, unknown>[] {
    const rows = (projectId
      ? this.database.prepare('SELECT * FROM generation_jobs WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(projectId)
      : this.database.prepare('SELECT * FROM generation_jobs WHERE deleted_at IS NULL ORDER BY created_at DESC').all()) as unknown as JobRow[];
    return rows.map((row) => this.mapJobForList(row));
  }

  /**
   * 软删一条产出。返回撤销所需的信息。
   *
   * 不物理删:内容包、生成事件、批次都靠 job_id 外键挂着,物理删会连带清掉审计
   * 痕迹;而且付费产品里「删错了」必须有退路。生成本身已扣的额度不退——记录还在
   * 才解释得清账;但尚未交付结果的改稿必须结清余额,否则删除会让任务失去父级、余额
   * 永久挂账。
   */
  softDelete(jobId: string): Record<string, unknown> {
    const row = this.jobRow(jobId);
    if (row.deleted_at) return { id: row.id, topic: row.topic, alreadyDeleted: true };
    const now = nowIso();
    const stoppedRevisionIds: string[] = [];
    const deleted = this.database.transaction(() => {
      const current = this.database
        .prepare('SELECT status, deleted_at FROM generation_jobs WHERE id=?')
        .get(jobId) as { status: JobRow['status']; deleted_at: string | null } | undefined;
      if (!current) throw new NotFoundException('生成任务不存在');
      if (current.deleted_at) return false;

      const workspaceId = String(this.resources.projectRow(row.project_id).workspace_id);
      const activeRevisionQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(quota_consumed_count), 0) AS value
             FROM revision_tasks
            WHERE job_id=? AND status IN ('queued', 'running')`,
        )
        .get(jobId) as { value: number };
      const revisionRefund = Number(activeRevisionQuota.value);
      if (revisionRefund > 0) this.settings.refundPlatformQuota(workspaceId, revisionRefund);

      const stoppedMessage = '生成任务已删除，任务已停止';
      const revisions = this.database
        .prepare(
          `UPDATE revision_tasks
              SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE job_id=? AND status IN ('queued', 'running')
            RETURNING id`,
        )
        .all(stoppedMessage, now, now, jobId) as unknown as Array<{ id: string }>;
      stoppedRevisionIds.push(...revisions.map((item) => item.id));
      this.database
        .prepare(
          `UPDATE generation_jobs
              SET deleted_at=?, updated_at=?,
                  status=CASE WHEN status IN ('queued', 'running') THEN 'failed' ELSE status END,
                  progress=CASE WHEN status IN ('queued', 'running') THEN 100 ELSE progress END,
                  error=CASE WHEN status IN ('queued', 'running') THEN ? ELSE error END,
                  completed_at=CASE WHEN status IN ('queued', 'running') THEN ? ELSE completed_at END,
                  claimed_by=CASE WHEN status IN ('queued', 'running') THEN NULL ELSE claimed_by END,
                  claimed_at=CASE WHEN status IN ('queued', 'running') THEN NULL ELSE claimed_at END,
                  heartbeat_at=CASE WHEN status IN ('queued', 'running') THEN NULL ELSE heartbeat_at END
            WHERE id=? AND deleted_at IS NULL`,
        )
        .run(now, now, stoppedMessage, now, jobId);
      this.event(jobId, 'deleted', {
        removedFromQueue: current.status === 'queued',
        stoppedRevisions: stoppedRevisionIds.length,
        refundedRevisionQuota: revisionRefund,
      });
      return true;
    });
    if (!deleted) return { id: row.id, topic: row.topic, alreadyDeleted: true };
    this.stopHeartbeat(jobId);
    for (const revisionId of stoppedRevisionIds) this.stopRevisionHeartbeat(revisionId);
    return { id: row.id, topic: row.topic, alreadyDeleted: false };
  }

  /** 撤销软删。 */
  restore(jobId: string): Record<string, unknown> {
    const row = this.jobRow(jobId);
    if (!row.deleted_at) return { id: row.id, topic: row.topic, alreadyActive: true };
    /*
     * 只清 deleted_at,不重新入队。
     *
     * 删除时 queued/running 已明确结为 failed,所以清掉 deleted_at 只恢复可见性。
     * 用户要再次执行必须走「按同款重试」显式新建任务,不会悄悄开跑旧记录。
     */
    this.database.prepare('UPDATE generation_jobs SET deleted_at=NULL, updated_at=? WHERE id=?').run(nowIso(), jobId);
    this.event(jobId, 'restored', {});
    return { id: row.id, topic: row.topic, alreadyActive: false };
  }

  /**
   * 列表投影:只给列表页真正读到的字段。
   *
   * mapJob(row, false) 的 includeCandidates=false 只省掉候选,planningContext、
   * researchSnapshot、configImpact(同一份内容重复三个键)等仍然全量返回。实测
   * 26 个任务的列表响应 10.5 MB、单条 366 KB,而列表页一个重字段都用不到。
   *
   * 字段集是极简创作产出区与完整版历史页两边需求的并集,由
   * generation-list-projection.test.ts 逐字段锁死——加字段要连测试一起改,
   * 免得又悄悄长回去。需要完整数据的一律走 GET /api/generations/:id。
   *
   * opportunitySnapshot 与 resolvedConfig.task 保留:「再来一篇同款」的配方回填
   * (extractRecipe)靠它们,而且体积可控。
   */
  private mapJobForList(row: JobRow): Record<string, unknown> {
    const project = this.resources.projectRow(row.project_id);
    const config = parseJson<ResolvedGenerationConfig | null>(row.config_json, null);
    const opportunitySnapshot = parseJson<Record<string, unknown>>(row.opportunity_snapshot_json, {});
    const imageContext = parseJson<Array<Record<string, unknown>>>(row.image_context_json, []);
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: project.name,
      topic: row.topic,
      goal: row.goal,
      mode: row.mode,
      status: row.status,
      qualityStatus: row.quality_status,
      progress: row.progress,
      seed: row.seed,
      // formula 可能缺失(历史任务或异常数据)。原来 mapJob 写的是
      // config?.formula.versionId——只保护了 config,任何缺 formula 的行都会让
      // 整个列表接口 500。这里两级都用可选链。
      formulaVersion: config?.formula?.versionId,
      presetId: row.preset_id,
      styleProfileVersion: row.style_profile_version,
      opportunityId: row.opportunity_id ?? undefined,
      // 只留 id:整份快照有 37 个字段、单条 14 KB,而消费方(quick-recipe 的
      // extractRecipe)只在 opportunityId 缺失时用它兜底取一个 id;完整版历史页
      // 根本不读。保留这两个键是为了不打断老任务的兜底路径。
      opportunitySnapshot: {
        id: opportunitySnapshot.id,
        opportunityId: opportunitySnapshot.opportunityId,
      },
      batchId: row.batch_id ?? undefined,
      // 配方回填只读 resolvedConfig.task,不需要整份 config
      resolvedConfig: config ? { task: (config as unknown as Record<string, unknown>).task } : undefined,
      imageContext,
      createdAt: row.created_at,
      // 未完成任务用 undefined 而非 null,与同族可选字段(error/batchId/opportunityId)
      // 一致:前端对这些字段一律用 ?. 读,混着 null 容易多出意外分支。
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      // 排队位次 + 队列总长:进度条在 queued 阶段恒为 0,这两个值是用户唯一能
      // 判断"在排队"而非"卡死"的依据。running 及终态天然拿不到位次(不在队列里),
      // 这时连 queueLength 也不给——已完成的任务带一个全局队列长度只是噪声。
      ...this.queueView(row.id),
    };
  }

  get(id: string): Record<string, unknown> {
    const row = this.jobRow(id);
    return this.mapJob(row, true);
  }

  jobRow(id: string): JobRow {
    const row = this.database.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    if (!row) throw new NotFoundException('生成任务不存在');
    return row;
  }

  /**
   * 阅读投影:极简创作「查看」用的轻量视图(字段集见 generation-reader-view.ts)。
   *
   * 不是 get() 的裁剪版而是独立一条:完整版工作台要 trace/参数影响报告,极简创作
   * 要的是判断依据(句子级标注、缺口落地台账、候选表达轴)——后者旧接口压根不返回。
   * 实测同一任务 1.10 MB → 35 KB。
   */
  readerView(jobId: string): Record<string, unknown> {
    const row = this.jobRow(jobId);
    return {
      id: row.id,
      projectId: row.project_id,
      topic: row.topic,
      goal: row.goal,
      status: row.status,
      qualityStatus: row.quality_status,
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      // 与 mapJob 同源同语义:改稿期间 job.status 保持 completed,阅读页要靠这个
      // 字段才知道「在改」——否则它那个受 inFlight 门控的 3 秒轮询根本不启动,
      // 用户看到的是「点了没反应、稍后自己变了」。终态也带出来,用于显示上一次失败。
      activeRevision: this.revisions.activeFor(row.id) ?? this.revisions.latestFor(row.id),
      // 只有 completed 才有候选;其余状态给空数组,前端不用分支判 undefined。
      candidates: row.status === 'completed'
        ? this.packageRows(jobId).map((item) =>
            readerView(normalizeContentPackageForApi(parseJson<ContentPackage>(item.content_json, {} as ContentPackage))),
          )
        : [],
    };
  }

  /** 受理修改请求并立即返回;执行由 RevisionService 的队列负责。 */
  enqueueRevision(jobId: string, candidateId: string, instruction: string, principal: SessionPrincipal): Record<string, unknown> {
    const task = this.revisions.enqueue(jobId, candidateId, instruction, principal);
    this.event(jobId, 'revision_queued', { revisionId: task.id, candidateId });
    // 立刻(下一拍)尝试领取,新任务不必等下一个回收定时器周期。
    //
    // 推到 setImmediate 而不是就地调用:claimNext 是同步的,就地调用会在本次响应
    // 组装之前把状态改成 running,于是「受理」的返回体里 activeRevision 已经是
    // running——用户按下按钮那一刻拿到的应当是 queued。延后一拍不影响启动速度。
    setImmediate(() => this.tick(() => this.drainRevisions()));
    // 返回完整 job:前端拿到的 candidates 仍是旧版本,activeRevision 告诉它在改。
    return this.get(jobId);
  }

  contentPackage(jobId: string, candidateId: string): ContentPackage {
    const job = this.jobRow(jobId);
    const opportunitySnapshot = parseJson<Record<string, unknown>>(job.opportunity_snapshot_json, {});
    for (const row of this.packageRows(jobId)) {
      const value = parseJson<ContentPackage | null>(row.content_json, null);
      if (value && (value.candidateId === candidateId || value.id === candidateId)) {
        const record = value as unknown as Record<string, unknown>;
        if (!isRecord(record.opportunitySnapshot) && Object.keys(opportunitySnapshot).length) {
          record.opportunitySnapshot = opportunitySnapshot;
        }
        return normalizeContentPackageForApi(value);
      }
    }
    throw new NotFoundException('候选内容不存在');
  }

  /**
   * 任务在排队里的位次(1 起)。不在队列返回 undefined——不是 0 也不是 -1,
   * 前端一律用 `if (pos)` 判存在,0 会被当成"没有位次"。
   *
   * 并发上限 2、单次批量可提 24 篇,实测批量任务平均 56 分钟才收敛。进度条在
   * queued 阶段恒为 0,用户无法区分"排队中"和"卡死",所以把位次露出来。
   */
  queuePosition(jobId: string): number | undefined {
    return queuedJobPosition(this.database, jobId);
  }

  /** 当前排队总数,让前端能说"第 3/24 位"而不是光一个 3。 */
  queueLength(): number {
    return queuedJobCount(this.database);
  }

  /** 两个映射(列表/详情)共用的排队字段,只在真的排队时出现。 */
  private queueView(jobId: string): { queuePosition?: number; queueLength?: number } {
    const position = this.queuePosition(jobId);
    return position === undefined ? {} : { queuePosition: position, queueLength: this.queueLength() };
  }

  /**
   * 触发领取。任务插入时已经是 status='queued',DB 本身就是队列,所以这里不再
   * 往内存数组里 push——多实例下内存队列会让位次失真、让 outage 清理漏掉别的
   * 实例上的任务。
   */
  private enqueue(_jobId: string): void {
    this.drainQueue();
  }

  /**
   * 供应商级故障时,把同项目仍在排队的任务直接判失败。
   *
   * 实测:42 篇失败是同一个 Insufficient Balance,集中在 4 个批次(各 10 篇全灭),
   * 每篇要先跑完知识加载/规划/写作、平均 983 秒才撞上那个错误。余额既然已经耗尽,
   * 后面每一篇都注定失败,没有理由各花 16 分钟去证明一次。
   *
   * 只清同一个项目:多租户下另一个项目可能用的是自己的 BYOK 密钥,不该被牵连。
   * 已扣的配额保持不变(创建时计费),用户充值后到产出区批量重试即可 —— 那条路
   * 已经存在(retry-plan / planBatchRetry)。
   *
   * 返回被清掉的任务数,供调用方写审计。
   */
  private failQueuedForOutage(projectId: string, reason: string): number {
    // 直接按项目 + status 清库,覆盖所有实例上的排队任务。原来只遍历本实例内存
    // 队列,多实例下别的实例上同项目的任务不会被清——而这个函数存在的全部意义
    // 就是避免每篇再花 16 分钟撞同一面墙。
    return this.database.transaction(() => {
      const now = nowIso();
      const cleared = this.database
        .prepare(
          `UPDATE generation_jobs
              SET status='failed', error=?, progress=100, completed_at=?, updated_at=?,
                  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
            WHERE project_id=? AND status='queued' AND deleted_at IS NULL
            RETURNING id`,
        )
        .all(reason, now, now, projectId) as unknown as Array<{ id: string }>;
      for (const row of cleared) {
        this.event(row.id, 'failed', { message: reason, providerOutage: true });
      }
      return cleared.length;
    });
  }

  private drainQueue(): void {
    // 关停途中不再领新活:领了也跑不完,而且 process 会在连接关闭后继续写库。
    // 已领的任务留在 running,心跳停更后由下一个实例(或本实例重启后)回收。
    if (this.stopped) return;
    while (this.activeJobs < this.maxConcurrentJobs) {
      // 领取是原子的:changes===1 才拿到,两个实例不可能都领到同一条。
      const jobId = claimNextJob(this.database, this.options.instanceId, nowIso());
      if (!jobId) return;
      this.activeJobs += 1;
      setImmediate(() => {
        void this.process(jobId)
          .catch(() => undefined)
          .finally(() => {
            this.stopHeartbeat(jobId);
            this.activeJobs -= 1;
            this.drainQueue();
          });
      });
    }
  }

  /**
   * 领取修改任务。名额与 drainQueue 分开:改稿是交互式操作、用户在等,不该被排队的
   * 批量生成挡住;反过来也不该占满生成名额饿死新生成。
   */
  private drainRevisions(): void {
    // 关停途中不再领新活:领了也跑不完,而且写库会撞上已关闭的连接。
    if (this.stopped) return;
    while (this.activeRevisions < this.maxConcurrentRevisions) {
      const revisionId = claimNext(this.database, REVISION_TASKS_SPEC, this.options.instanceId, nowIso());
      if (!revisionId) return;
      this.activeRevisions += 1;
      setImmediate(() => {
        void this.processRevision(revisionId)
          .catch(() => undefined)
          .finally(() => {
            this.stopRevisionHeartbeat(revisionId);
            this.activeRevisions -= 1;
            this.drainRevisions();
          });
      });
    }
  }

  private startRevisionHeartbeat(revisionId: string): void {
    this.stopRevisionHeartbeat(revisionId);
    const timer = setInterval(() => this.tick(() => {
      if (!heartbeatTask(this.database, REVISION_TASKS_SPEC, revisionId, this.options.instanceId, nowIso())) {
        this.stopRevisionHeartbeat(revisionId);
      }
    }), this.options.jobHeartbeatMs);
    timer.unref();
    this.revisionHeartbeats.set(revisionId, timer);
  }

  private stopRevisionHeartbeat(revisionId: string): void {
    const timer = this.revisionHeartbeats.get(revisionId);
    if (timer) clearInterval(timer);
    this.revisionHeartbeats.delete(revisionId);
  }

  /**
   * 修改任务所属的 workspace。这里故意不筛软删除:项目即使刚被软删,历史扣款仍要退。
   * 查不到说明任务链已经被级联删除或数据损坏,必须抛错让外层事务整体回滚。
   */
  private requiredWorkspaceIdForRevision(revisionId: string): string {
    const row = this.database
      .prepare(
        `SELECT p.workspace_id AS workspace_id
           FROM revision_tasks r
           JOIN generation_jobs j ON j.id = r.job_id
           JOIN projects p ON p.id = j.project_id
          WHERE r.id = ?`,
      )
      .get(revisionId) as { workspace_id: string } | undefined;
    if (!row) throw new Error('修改任务所属工作区不存在');
    return String(row.workspace_id);
  }

  /**
   * 结清一条修改任务的额度账。keep 是允许留下的扣款次数:交付了产出留 1,零产出留 0。
   *
   * 为什么需要它:扣额度在**每次**执行调模型之前发生,而重试靠孤儿回收重新入队,所以
   * `kill -9` 或心跳失速三轮会扣三次,最终由 reclaimStale 判 failed——用户零产出、被扣
   * 三次。原实现的 failed 分支只写了一个事件,一次都不退。
   *
   * 判据是「交付了几次产出」,不是「执行了几次」:被打断的那些执行按定义什么都没交付,
   * 所以成功收尾也要把之前打断掉的那几次退回去,只留成功这一次。
   *
   * 本方法不自行开事务,调用方必须把它放在任务终态事务里。任务余额与 workspace
   * 额度要么同时更新、要么同时回滚,不能出现任务账归零但用户额度没退的状态。
   */
  private settleRevisionQuota(revisionId: string, workspaceId: string, keep: 0 | 1): number {
    const row = this.database
      .prepare('SELECT quota_consumed_count FROM revision_tasks WHERE id=?')
      .get(revisionId) as { quota_consumed_count: number } | undefined;
    if (!row) throw new Error('修改任务不存在，无法结清额度');
    const consumed = Number(row.quota_consumed_count);
    const refund = Math.max(0, consumed - keep);
    if (!refund) return 0;
    const result = this.database
      .prepare('UPDATE revision_tasks SET quota_consumed_count=? WHERE id=? AND quota_consumed_count=?')
      .run(consumed - refund, revisionId, consumed);
    if (result.changes !== 1) throw new Error('修改任务额度余额发生并发变化');
    this.settings.refundPlatformQuota(workspaceId, refund);
    return refund;
  }

  /** 推进改稿进度。CAS 未命中说明归属已易主,旧执行者必须立即停手。 */
  private revisionProgress(revisionId: string, value: number): void {
    if (this.stopped) throw new ClaimLostError('revision');
    const result = this.database
      .prepare(
        `UPDATE revision_tasks SET progress=?, updated_at=?
          WHERE id=? AND status='running' AND claimed_by=?`,
      )
      .run(value, nowIso(), revisionId, this.options.instanceId);
    if (result.changes !== 1) throw new ClaimLostError('revision');
  }

  /**
   * 心跳续约。返回 false 表示本实例已丢失这个任务的所有权(被回收或被接管),
   * 调用方必须停手——否则两个实例会同时写同一个任务的产出。
   */
  private startHeartbeat(jobId: string): void {
    const timer = setInterval(() => this.tick(() => {
      if (!heartbeatJob(this.database, jobId, this.options.instanceId, nowIso())) this.stopHeartbeat(jobId);
    }), this.options.jobHeartbeatMs);
    timer.unref();
    this.heartbeats.set(jobId, timer);
  }

  private stopHeartbeat(jobId: string): void {
    const timer = this.heartbeats.get(jobId);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(jobId);
  }

  /** 推进生成进度。条件与心跳一致,不能用无归属守卫的更新。 */
  private progress(jobId: string, value: number): void {
    if (this.stopped) throw new ClaimLostError('generation');
    const result = this.database
      .prepare(
        `UPDATE generation_jobs SET progress=?, updated_at=?
          WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
      )
      .run(value, nowIso(), jobId, this.options.instanceId);
    if (result.changes !== 1) throw new ClaimLostError('generation');
  }

  private async process(jobId: string): Promise<void> {
    const job = this.jobRow(jobId);
    try {
      // 领取已把 status 原子置为 running。启动进度与事件也必须同生共死，并再次
      // 校验归属：领取后到 setImmediate 执行前，任务可能已经被回收或软删。
      this.database.transaction(() => {
        const started = this.database
          .prepare(
            `UPDATE generation_jobs SET progress=12, error=NULL, updated_at=?
              WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
          )
          .run(nowIso(), jobId, this.options.instanceId);
        if (started.changes !== 1) throw new ClaimLostError('generation');
        this.event(jobId, 'running', {});
      });
      this.startHeartbeat(jobId);

      const config = parseJson<ResolvedGenerationConfig>(job.config_json, {} as ResolvedGenerationConfig);
      this.normalizeStoredKnowledgeConfig(config);
      const storedResolution = parseJson<Record<string, unknown>>(job.resolution_snapshot_json, {});
      const parameterSelection = isRecord(storedResolution.parameterSelection)
        ? storedResolution.parameterSelection as GenerationParameterSelection
        : undefined;
      const storedImpact = parseJson<ParameterImpactReport | undefined>(job.config_impact_json, undefined);
      const storedPlanningContext = parseJson<PlanningContext | undefined>(job.planning_context_json, undefined);
      const formula = this.formulas.get(job.formula_version_id).version;
      const project = this.resources.projectRow(job.project_id);
      const providerSettings = this.settings.provider(String(project.workspace_id), job.created_by);
      this.progress(jobId, 28);
      const knowledge = await this.loadKnowledge(job.project_id, config.knowledge, '内容生成');
      this.progress(jobId, 44);
      const planningContext = await this.intelligence.hydratePlanningContext(job.project_id, storedPlanningContext);
      const agent = new ContentGenerationAgent({ modelProvider: this.modelProvider(providerSettings) });
      const result = await agent.generate({ jobId, config, formulaVersion: formula, knowledge, parameterSelection, planningContext });
      const storedOpportunitySnapshot = parseJson<Record<string, unknown>>(job.opportunity_snapshot_json, {});
      const coreSelectionAudit = result.packages
        .map((content) => content.orchestrationSnapshot?.opportunitySelectionAudit)
        .find((audit) => Boolean(audit));
      const selectedOpportunity = coreSelectionAudit?.selectionMode === 'heuristic_ranked'
        ? storedPlanningContext?.opportunities?.find((item) => item.id === coreSelectionAudit.selectedOpportunityId)
        : undefined;
      const selectedOpportunitySnapshot = selectedOpportunity
        ? structuredClone(selectedOpportunity) as unknown as Record<string, unknown>
        : undefined;
      if (selectedOpportunitySnapshot) delete selectedOpportunitySnapshot.score;
      const realizedOpportunitySnapshot: Record<string, unknown> = coreSelectionAudit
        ? {
          ...(selectedOpportunitySnapshot ?? storedOpportunitySnapshot),
          opportunitySelectionAudit: structuredClone(coreSelectionAudit),
        }
        : storedOpportunitySnapshot;
      const resolutionSnapshot = result.resolutionSnapshot
        ?? (isRecord(storedResolution.values) ? storedResolution as unknown as ParameterResolutionSnapshot : undefined);
      const impactReport = result.impactReport ?? storedImpact;
      const validCandidateCount = result.packages.filter((content) => content.validation.valid).length;
      const qualityStatus = deriveQualityStatus(result.packages);
      const mergedResolution = result.resolutionSnapshot
        ? { ...storedResolution, ...result.resolutionSnapshot }
        : storedResolution;
      const mergedImpact = result.impactReport
        ? {
            ...(storedImpact ?? {}),
            ...result.impactReport,
            compatibilityTraces: isRecord(storedImpact) ? storedImpact.compatibilityTraces : undefined,
          }
        : storedImpact ?? {};

      // 88% 只表示模型阶段结束。知识上下文不能在这里提前持久化：若最终 CAS
      // 失败，它必须和内容包、coverage、快照一起完整回滚。
      this.progress(jobId, 88);
      this.database.transaction(() => {
        for (const content of result.packages) {
          if (resolutionSnapshot && !content.resolutionSnapshot) content.resolutionSnapshot = resolutionSnapshot;
          if (impactReport && !content.impactReport) content.impactReport = impactReport;
          if (Object.keys(realizedOpportunitySnapshot).length) {
            (content as unknown as Record<string, unknown>).opportunitySnapshot = structuredClone(realizedOpportunitySnapshot);
          }
          this.database
            .prepare(
              `INSERT INTO content_packages
                (id, job_id, project_id, candidate_index, content_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(content.id, jobId, job.project_id, content.candidateIndex, JSON.stringify(content), content.createdAt, content.createdAt);
          this.intelligence.recordGenerationCoverage({
            projectId: job.project_id,
            jobId,
            opportunityId: job.opportunity_id,
            packageId: content.id,
            candidateIndex: content.candidateIndex,
            signature: content.coverageSignature,
            fallback: {
              topicKey: job.topic,
              title: content.content.N.title,
              hashtags: content.content.H.hashtags,
              imageRole: content.imagePlan?.role,
            },
            createdBy: job.created_by,
          });
        }

        // 终态 CAS 放在所有产物写入之后。若归属已易主，抛错会回滚本事务内
        // 的全部内容包、coverage 和快照，旧执行者不留下任何痕迹。
        const completed = this.database
          .prepare(
            `UPDATE generation_jobs
                SET status='completed', quality_status=?, progress=100, error=NULL, completed_at=?,
                    knowledge_context_json=?, opportunity_snapshot_json=?, resolution_snapshot_json=?,
                    config_impact_json=?, updated_at=?, claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
              WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
          )
          .run(
            qualityStatus,
            result.completedAt,
            JSON.stringify(result.knowledgeContext),
            JSON.stringify(realizedOpportunitySnapshot),
            JSON.stringify(mergedResolution),
            JSON.stringify(mergedImpact),
            nowIso(),
            jobId,
            this.options.instanceId,
          );
        if (completed.changes !== 1) throw new ClaimLostError('generation');
        this.event(jobId, 'completed', {
          candidateCount: result.packages.length,
          validCandidateCount,
          qualityStatus,
          knowledgeMode: result.knowledgeContext.mode,
          selectedDocuments: result.knowledgeContext.selectedDocumentIds,
        });
      });
    } catch (error) {
      // 易主、软删与关停都不是本轮执行的失败。接管者拥有唯一写权，旧实例必须
      // 完全静默：不改状态、不记事件、不退款，也不触发供应商熔断。
      if (error instanceof ClaimLostError) return;
      const raw = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      // Outage detection still uses the private provider detail, but neither
      // task state nor events persist that response body.
      const outage = detectProviderOutage(raw);
      const message = outage?.reason ?? generationFailureMessage(error);
      try {
        this.database.transaction(() => {
          const now = nowIso();
          const failed = this.database
            .prepare(
              `UPDATE generation_jobs
                  SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                      claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL
                WHERE id=? AND status='running' AND claimed_by=? AND deleted_at IS NULL`,
            )
            .run(message, now, now, jobId, this.options.instanceId);
          if (failed.changes !== 1) throw new ClaimLostError('generation');
          this.event(jobId, 'failed', { message });
        });
      } catch (settleError) {
        if (settleError instanceof ClaimLostError) return;
        // 失败态或事件无法原子提交时保留 running，让心跳停止后的孤儿回收重试；
        // 此时不能清理队列，否则会在根因尚未落账时扩大副作用。
        throw settleError;
      }
      // 供应商级故障(余额不足/无可用账号/凭据冷却):后面排队的注定同样失败,
      // 立刻判掉而不是每篇再花 16 分钟撞一次同一面墙。单篇级错误不触发。
      if (outage) {
        const cleared = this.failQueuedForOutage(job.project_id, outage.reason);
        // Record every task that actually observed the provider outage. This
        // retains diagnosis and call-count evidence without storing raw bodies.
        this.event(jobId, 'provider_outage', { kind: outage.kind, clearedQueuedJobs: cleared });
      }
    }
  }

  /**
   * 执行一次修改。
   *
   * 进度里程碑按 agent.revise 的真实阶段划,不做均匀插值:所以进度可能从 40 直接
   * 跳到 95。这是真实情况,不为「平滑」而假装经过。
   *
   * 写库只在最后一步、单事务内完成:失败则内容包一个字节都不动。原同步实现是
   * UPDATE content_packages SET id=?, content_json=? 原地覆盖,异步化后若在写库
   * 阶段失败会留下半个包。
   */
  private async processRevision(revisionId: string): Promise<void> {
    const task = this.revisions.row(revisionId);
    if (!task) return;
    let workspaceId = '';
    // 只描述当前进程是否真正完成过本轮平台扣款事务。历史中断遗留的余额由
    // quota_consumed_count 记录，不能把它误当成本轮扣款。
    let chargedThisAttempt = false;
    let modelInvoked = false;
    try {
      this.database.transaction(() => {
        const started = this.database
          .prepare(
            `UPDATE revision_tasks SET progress=5, error=NULL, updated_at=?
              WHERE id=? AND status='running' AND claimed_by=?`,
          )
          .run(nowIso(), revisionId, this.options.instanceId);
        if (started.changes !== 1) throw new ClaimLostError('revision');
        this.event(task.job_id, 'revision_running', { revisionId });
      });
      this.startRevisionHeartbeat(revisionId);

      // jobRow / projectRow 也在 try 内:项目或任务被软删时它们抛 NotFoundException,
      // 放在 try 外会被 drainRevisions 的 .catch(() => undefined) 吞掉,任务就停在
      // running——没有 failed、没有事件,还占着那条部分唯一索引的名额,只能等回收
      // 跑满 3 轮(每轮 jobClaimTimeoutMs)才收敛。
      const job = this.jobRow(task.job_id);
      const project = this.resources.projectRow(job.project_id);
      workspaceId = String(project.workspace_id);
      this.revisionProgress(revisionId, 10);
      const packageRow = this.database
        .prepare('SELECT id, content_json FROM content_packages WHERE id=?')
        .get(task.package_id) as { id: string; content_json: string } | undefined;
      if (!packageRow) throw new Error('候选内容已不存在，可能已被删除');
      const current = parseJson<ContentPackage | null>(packageRow.content_json, null);
      if (!current) throw new Error('候选内容无法解析');

      const formula = this.formulas.get(job.formula_version_id).version;
      const config = parseJson<ResolvedGenerationConfig>(job.config_json, {} as ResolvedGenerationConfig);
      this.normalizeStoredKnowledgeConfig(config);
      const providerSettings = this.settings.provider(workspaceId, task.created_by);
      // Knowledge is validated and loaded before platform quota is charged. A
      // context-size or storage failure therefore cannot consume a paid call.
      const knowledge = await this.loadKnowledge(job.project_id, config.knowledge, '内容修改');
      /*
       * 扣额度的时机与原同步实现一致(调用模型前),但每次扣都记账。
       *
       * 记账是必需的:重试靠孤儿回收重新入队,所以一条任务可能被执行 N 次、扣 N 次,
       * 最终由 reclaimStale 判 failed。那一侧要退,就必须知道退几次——退 1 次会少退,
       * 固定退 3 次会在只扣过 1 次时白送。quota_consumed_count 就是「已扣未退」余额。
      */
      if (providerSettings.mode === 'platform' && providerSettings.apiKey) {
        this.database.transaction(() => {
          this.settings.consumePlatformQuota(workspaceId);
          const recorded = this.database
            .prepare(
              `UPDATE revision_tasks
                  SET quota_consumed_count=quota_consumed_count + 1, updated_at=?
                WHERE id=? AND status='running' AND claimed_by=?`,
            )
            .run(nowIso(), revisionId, this.options.instanceId);
          if (recorded.changes !== 1) throw new ClaimLostError('revision');
        });
        // 只在扣款和任务账都提交之后置位。事务抛错时额度自增会一并回滚。
        chargedThisAttempt = true;
      }

      this.revisionProgress(revisionId, 25);
      const jobResolution = parseJson<Record<string, unknown>>(job.resolution_snapshot_json, {});
      const parameterSelection = isRecord(jobResolution.parameterSelection)
        ? jobResolution.parameterSelection as GenerationParameterSelection
        : undefined;
      const storedPlanningContext = parseJson<PlanningContext | undefined>(job.planning_context_json, undefined);
      const storedImageAnalyses = parseJson<PlanningContext['imageAnalyses']>(job.image_context_json, []);
      const revisionPlanningContext: PlanningContext = {
        ...(storedPlanningContext ?? {}),
        imageAnalyses: Array.isArray(storedPlanningContext?.imageAnalyses) && storedPlanningContext.imageAnalyses.length
          ? storedPlanningContext.imageAnalyses
          : storedImageAnalyses,
      };
      const hydrated = await this.intelligence.hydratePlanningContext(job.project_id, revisionPlanningContext);

      this.revisionProgress(revisionId, 40);
      const provider = this.modelProvider(providerSettings);
      const trackedProvider: ModelProvider | undefined = provider ? {
        generate: (request) => {
          modelInvoked = true;
          return provider.generate(request);
        },
      } : undefined;
      const agent = new ContentGenerationAgent({ modelProvider: trackedProvider });
      const result = await agent.revise({
        package: current,
        instruction: task.instruction,
        formulaVersion: formula,
        knowledge,
        parameterSelection,
        imageAnalyses: hydrated?.imageAnalyses,
        planningContext: hydrated,
      });

      this.revisionProgress(revisionId, 95);
      // 继承原实现的字段回填:局部重跑不会重算这些,缺了会让产出看起来"丢东西"。
      if (!result.package.resolutionSnapshot && current.resolutionSnapshot) {
        result.package.resolutionSnapshot = current.resolutionSnapshot;
      }
      if (!result.package.impactReport && current.impactReport) {
        result.package.impactReport = current.impactReport;
      }
      for (const field of ['imagePlan', 'dialogueThreads', 'deploymentPlan', 'orchestrationSnapshot', 'coverageSignature', 'productionArtifacts', 'opportunitySnapshot']) {
        const revised = result.package as unknown as Record<string, unknown>;
        const previous = current as unknown as Record<string, unknown>;
        if (!revised[field] && previous[field]) revised[field] = previous[field];
      }

      const now = nowIso();
      this.database.transaction(() => {
        this.database
          .prepare('UPDATE content_packages SET id=?, content_json=?, updated_at=? WHERE id=?')
          .run(result.package.id, JSON.stringify(result.package), now, packageRow.id);
        // 平台模式本轮确实扣过一次时保留这一次；BYOK 或本轮没扣款时一笔不留，
        // 顺便退清历史中断遗留的余额。
        const refundedOnSuccess = this.settleRevisionQuota(
          revisionId,
          workspaceId,
          chargedThisAttempt ? 1 : 0,
        );
        const completed = this.database
          .prepare(
            `UPDATE revision_tasks
                SET status='completed', progress=100, error=NULL, rerun_channels_json=?,
                    result_package_id=?, completed_at=?, updated_at=?,
                    claimed_by=NULL, heartbeat_at=NULL
              WHERE id=? AND status='running' AND claimed_by=?`,
          )
          .run(
            JSON.stringify(result.dependency.rerunChannels),
            result.package.id,
            now,
            now,
            revisionId,
            this.options.instanceId,
          );
        if (completed.changes !== 1) throw new ClaimLostError('revision');
        if (refundedOnSuccess) {
          this.event(task.job_id, 'revision_quota_refunded', {
            revisionId, refunded: refundedOnSuccess, reason: 'interrupted_attempts',
          });
        }
        this.event(task.job_id, 'revised', {
          revisionId,
          candidateId: task.candidate_id,
          rerunChannels: result.dependency.rerunChannels,
          approvedSourceImageAnalysisCount: hydrated?.imageAnalyses?.length ?? 0,
        });
        this.audit.record({
          workspaceId, userId: task.created_by, action: 'generation.revise',
          entityType: 'content_package', entityId: result.package.id,
          details: {
            jobId: task.job_id,
            candidateId: task.candidate_id,
            rerunChannels: result.dependency.rerunChannels,
          },
        });
      });
    } catch (error) {
      if (error instanceof ClaimLostError) return;
      const kind = classifyModelFailure(error);
      const raw = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      const message = !modelInvoked && error instanceof HttpException
        ? publicHttpExceptionMessage(error)
        : modelFailureMessage(kind, '修改', raw);
      this.database.transaction(() => {
        const settleWorkspaceId = workspaceId || this.requiredWorkspaceIdForRevision(revisionId);
        // other 只有在本轮确实发生了平台模型调用时才保留一次扣款；其余情况零
        // 产出，退清本轮及历史中断余额。
        const keep = kind === 'other' && chargedThisAttempt ? 1 : 0;
        const refunded = this.settleRevisionQuota(revisionId, settleWorkspaceId, keep);
        const now = nowIso();
        const failed = this.database
          .prepare(
            `UPDATE revision_tasks
                SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                    claimed_by=NULL, heartbeat_at=NULL
              WHERE id=? AND status='running' AND claimed_by=?`,
          )
          .run(
            message,
            now,
            now,
            revisionId,
            this.options.instanceId,
          );
        if (failed.changes !== 1) throw new ClaimLostError('revision');
        this.event(task.job_id, 'revision_failed', { revisionId, message, refundedQuota: refunded });
      });
    }
  }

  private latestKnowledgeRows(projectId: string): Record<string, unknown>[] {
    return this.database
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY filename
             ORDER BY version DESC, created_at DESC, id DESC
           ) AS version_rank
           FROM knowledge_files
           WHERE project_id=? AND deleted_at IS NULL
         )
         SELECT * FROM ranked WHERE version_rank=1 ORDER BY filename`,
      )
      .all(projectId) as unknown as Record<string, unknown>[];
  }

  private selectedKnowledgeRows(
    projectId: string,
    config?: ResolvedGenerationConfig['knowledge'],
  ): Record<string, unknown>[] {
    const excluded = new Set(Array.isArray(config?.excludedFileIds) ? config.excludedFileIds : []);
    const selected = new Set(Array.isArray(config?.selectedFileIds) ? config.selectedFileIds : []);
    return this.latestKnowledgeRows(projectId).filter((row) => {
      const id = String(row.id);
      if (excluded.has(id)) return false;
      // Style corpora are analysis/calibration material and never writer context.
      if (String(row.category) === 'reference-corpus') return false;
      return selected.size === 0 || selected.has(id);
    });
  }

  private normalizeStoredKnowledgeConfig(config: ResolvedGenerationConfig): void {
    if (!isRecord(config.knowledge)) throw new Error('生成任务知识配置无效');
    config.knowledge.selectedFileIds = Array.isArray(config.knowledge.selectedFileIds)
      ? config.knowledge.selectedFileIds.filter((id): id is string => typeof id === 'string')
      : [];
    config.knowledge.excludedFileIds = Array.isArray(config.knowledge.excludedFileIds)
      ? config.knowledge.excludedFileIds.filter((id): id is string => typeof id === 'string')
      : [];
  }

  private assertGenerationKnowledgeBudget(
    projectId: string,
    config: ResolvedGenerationConfig['knowledge'],
    operation: string,
  ): void {
    assertKnowledgeRowsBudget(operation, this.selectedKnowledgeRows(projectId, config));
  }

  private async loadKnowledge(
    projectId: string,
    config?: ResolvedGenerationConfig['knowledge'],
    operation = '知识加载',
  ): Promise<KnowledgeDocument[]> {
    const rows = this.selectedKnowledgeRows(projectId, config);
    assertKnowledgeRowsBudget(operation, rows);
    const documents: KnowledgeDocument[] = [];
    let totalBytes = 0;
    for (const row of rows) {
      const content = await readStoredText({
        dataDir: this.database.options.dataDir,
        projectDir: join(this.database.knowledgeDir, projectId),
        storagePath: String(row.storage_path),
      }, MAX_KNOWLEDGE_BYTES);
      totalBytes += Buffer.byteLength(content, 'utf8');
      // Database byte metadata is only a preflight hint. Recheck actual bytes
      // while reading so stale or tampered rows cannot bypass the shared cap.
      assertKnowledgeContextBudget({ operation, fileCount: rows.length, totalBytes });
      const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json), {});
      documents.push(indexKnowledgeSource({
        id: String(row.id),
        projectId,
        path: String(row.filename),
        content,
        version: String(row.version),
        importedAt: String(row.created_at),
        metadata: {
          title: typeof metadata.title === 'string' ? metadata.title : String(row.filename),
          kind: this.knowledgeKind(String(metadata.kind ?? row.category)),
          evidenceStatus: this.evidenceStatus(String(row.evidence_status)),
          keywords: Array.isArray(metadata.keywords) ? metadata.keywords.map(String) : [],
          scope: [
            ...(Array.isArray(metadata.scope) ? metadata.scope.map(String) : []),
            ...(String(row.category) === 'reference-corpus' ? ['style-analysis-only'] : []),
          ].filter((value, index, all) => all.indexOf(value) === index),
          caveats: Array.isArray(metadata.caveats) ? metadata.caveats.map(String) : [],
        },
      }));
    }
    return documents;
  }

  private assertLatestSelectedKnowledge(projectId: string, selectedFileIds: readonly string[]): void {
    const ids = [...new Set(selectedFileIds.filter((id) => id && id !== '__empty_knowledge_scope__'))];
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.database.prepare(
      `SELECT selected.id, selected.filename, selected.version,
              (SELECT MAX(latest.version) FROM knowledge_files latest
               WHERE latest.project_id=selected.project_id
                 AND latest.filename=selected.filename
                 AND latest.deleted_at IS NULL) AS latest_version
       FROM knowledge_files selected
       WHERE selected.project_id=? AND selected.deleted_at IS NULL
         AND selected.id IN (${placeholders})`,
    ).all(projectId, ...ids) as Array<{ id: string; filename: string; version: number; latest_version: number }>;
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException({
        message: '所选知识文件不存在、已删除或不属于当前项目',
        code: 'KNOWLEDGE_SELECTION_INVALID',
        fileIds: missing,
      });
    }
    const stale = rows.filter((row) => Number(row.version) !== Number(row.latest_version));
    if (stale.length) {
      throw new BadRequestException({
        message: '所选知识文件不是最新版本，请重新选择后生成',
        code: 'KNOWLEDGE_VERSION_STALE',
        files: stale.map((row) => ({
          id: row.id,
          filename: row.filename,
          selectedVersion: Number(row.version),
          latestVersion: Number(row.latest_version),
        })),
      });
    }
  }

  private modelProvider(settings: ReturnType<SettingsService['provider']>): ModelProvider | undefined {
    if (!settings.apiKey) return undefined;
    const client = new OpenAICompatibleClient({
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      transport: settings.transport,
      // BYOK 几乎总是第三方 OpenAI 兼容网关（maycran/deepseek/one-api 等），它们只支持 json_object；
      // 仅 platform 模式直连官方 OpenAI，才支持 json_schema。
      structuredOutput: settings.mode === 'byok' || settings.provider.toLowerCase().includes('compatible') ? 'json_object' : 'json_schema',
      includeTemperature: true,
      fetch: settings.mode === 'byok'
        ? createSafeModelFetch({
            allowHttp: this.options.byokAllowHttp,
            allowPrivateNetwork: this.options.byokAllowPrivateNetwork,
          })
        : undefined,
      timeoutMs: Number.isFinite(this.options.modelRequestTimeoutMs)
        ? Math.max(10_000, Math.min(300_000, this.options.modelRequestTimeoutMs))
        : 90_000,
    });
    return limitModelProvider(
      retryModelProvider(client, {
        maxAttempts: this.options.modelRetryAttempts,
        baseDelayMs: this.options.modelRetryBaseDelayMs,
      }),
      this.options.modelMaxConcurrentRequests,
    );
  }

  private mapJob(row: JobRow, includeCandidates: boolean): Record<string, unknown> {
    const project = this.resources.projectRow(row.project_id);
    const config = parseJson<ResolvedGenerationConfig | null>(row.config_json, null);
    const resolutionSnapshot = parseJson<Record<string, unknown>>(row.resolution_snapshot_json, {});
    const parameterImpactReport = normalizeImpactReportForApi(
      parseJson<ParameterImpactReport | Record<string, unknown>>(row.config_impact_json, {}),
    );
    const impacts = publicImpacts(parameterImpactReport);
    const diagnosticProxies = diagnosticProxiesFromImpactReport(parameterImpactReport);
    const warnings = Array.isArray(resolutionSnapshot.warnings) ? resolutionSnapshot.warnings : [];
    const conflicts = Array.isArray(resolutionSnapshot.conflicts) ? resolutionSnapshot.conflicts : [];
    const sourceImageContext = parseJson<Array<Record<string, unknown>>>(row.image_context_json, []);
    const opportunitySnapshot = parseJson<Record<string, unknown>>(row.opportunity_snapshot_json, {});
    const opportunitySelectionAudit = isRecord(opportunitySnapshot.opportunitySelectionAudit)
      ? opportunitySnapshot.opportunitySelectionAudit
      : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      projectName: project.name,
      topic: row.topic,
      goal: row.goal,
      mode: row.mode,
      status: row.status,
      qualityStatus: row.quality_status,
      progress: row.progress,
      ...this.queueView(row.id),
      candidates: includeCandidates && row.status === 'completed' ? this.packageRows(row.id).map((item) => this.mapCandidate(parseJson<ContentPackage>(item.content_json, {} as ContentPackage))) : undefined,
      seed: row.seed,
      formulaVersion: config?.formula.versionId,
      presetId: row.preset_id,
      styleProfileVersion: row.style_profile_version,
      opportunityId: row.opportunity_id ?? undefined,
      opportunitySnapshot,
      opportunitySelectionAudit,
      planningContext: parseJson(row.planning_context_json, {}),
      imageContext: sourceImageContext,
      imageContextKind: sourceImageContext.length ? 'approved_source_observations' : 'none',
      releaseManifestId: row.release_manifest_id ?? undefined,
      researchSnapshot: parseJson(row.research_snapshot_json, {}),
      sourceImageAssets: sourceImageContext.map((analysis) => ({
        assetId: analysis.sourceAssetId ?? analysis.assetId,
        analysisVersionId: analysis.analysisVersionId,
        assetKind: 'source_material',
        lifecycleStage: 'source_observation',
        isFinalAsset: false,
      })),
      resolvedConfig: config,
      resolutionSnapshot,
      impactReport: impacts,
      impacts,
      impactPreview: impacts,
      parameterImpactReport,
      diagnosticProxies,
      configImpact: parameterImpactReport,
      configImpactReport: parameterImpactReport,
      configPreview: {
        resolvedConfig: config,
        conflicts,
        warnings: warnings.map((message) => ({ severity: 'warning', title: '配置提示', message })),
        impacts,
        formulaVersion: config?.formula.versionId,
        knowledgeMode: config?.knowledge.mode,
        knowledgeFiles: config?.knowledge.selectedFileIds.length,
      },
      knowledgeContext: parseJson(row.knowledge_context_json, {}),
      createdAt: row.created_at,
      completedAt: row.completed_at,
      error: row.error ?? undefined,
      // 改稿期间 status 仍是 completed(前端 10 处按它判定能否查看产出),所以
      // 「有没有在改」由这个字段单独回答。终态任务也带出来,前端才能显示
      // 「上一次修改失败了」。
      activeRevision: this.revisions.activeFor(row.id) ?? this.revisions.latestFor(row.id),
    };
  }

  private mapCandidate(content: ContentPackage): Record<string, unknown> {
    const errors = content.validation.issues.filter((item) => item.severity === 'error').length;
    const warnings = content.validation.issues.filter((item) => item.severity === 'warning').length;
    const score = Math.max(0, Math.round(100 - errors * 25 - warnings * 5));
    const validationHeuristic = validationIssueCountHeuristic(errors, warnings, score);
    const normalizedImpactReport = content.impactReport
      ? normalizeImpactReportForApi(content.impactReport)
      : undefined;
    const productionArtifacts = content.productionArtifacts ?? content.orchestrationSnapshot?.productionArtifacts;
    return {
      id: content.candidateId,
      packageId: content.id,
      label: '随机候选',
      title: content.content.N.title,
      body: content.content.N.body,
      tags: content.content.H.hashtags.map((tag) => tag.startsWith('#') ? tag : `#${tag}`),
      comments: content.content.Cref.threads.map((thread, index) => {
        const planned = content.dialogueThreads?.find((item) => item.id === thread.id) ?? content.dialogueThreads?.[index];
        const personaRole = thread.personaRole ?? planned?.personaRole;
        const speakerType = thread.speakerType ?? planned?.speakerType;
        const claimStatus = thread.claimStatus ?? planned?.claimStatus;
        const simulated = thread.simulated ?? planned?.simulated;
        const simulationLabel = thread.simulationLabel ?? planned?.simulationLabel;
        const roleCard = thread.roleCard ?? planned?.roleCard;
        const primaryGapId = thread.primaryGapId ?? planned?.primaryGapId;
        const auxiliaryGapIds = thread.auxiliaryGapIds ?? planned?.auxiliaryGapIds;
        const densityProxy = thread.densityProxy ?? planned?.densityProxy;
        const replyPlan = thread.replyPlan ?? planned?.replyPlan;
        const discoveryPlan = thread.discoveryPlan ?? planned?.discoveryPlan;
        const surfaceRoleCard = thread.surfaceRoleCard ?? planned?.surfaceRoleCard;
        const conversationPlan = thread.conversationPlan ?? planned?.conversationPlan;
        return {
          id: thread.id,
          gap: thread.gap,
          function: thread.function,
          // 展示昵称(纯展示元数据);历史包缺失时保持缺省,前端不出空徽标。
          displayName: thread.displayName ?? planned?.displayName,
          // Cref contract v1.1 node metadata; absent on historical packages.
          kind: thread.kind,
          answerKind: thread.answerKind,
          boundary: thread.boundary,
          postingIdentity: thread.postingIdentity,
          sourceClusterIds: thread.sourceClusterIds,
          evidenceIds: thread.evidenceIds,
          stage: thread.stage,
          nextStep: thread.nextStep,
          personaRole,
          speakerType,
          claimStatus,
          replyTo: thread.replyTo ?? planned?.replyTo,
          threadDepth: thread.threadDepth ?? planned?.threadDepth,
          simulated,
          simulationLabel,
          roleCard,
          primaryGapId,
          auxiliaryGapIds,
          densityProxy,
          replyPlan,
          discoveryPlan,
          surfaceRoleCard,
          conversationPlan,
          question: thread.question,
          answer: thread.answer,
          followUps: thread.followUps,
          purpose: `${simulationLabel || "模拟潜在读者情景"} · ${thread.postingIdentity} 可追责答复`,
        };
      }),
      commentDisclaimer: content.content.Cref.disclaimer,
      // Cref contract v1.1 package-level fields; absent on historical packages.
      commentOwnedFirstComment: content.content.Cref.ownedFirstComment,
      commentUncoveredGaps: content.content.Cref.uncoveredGaps,
      imageBrief: content.content.N.imageBrief,
      imageBriefKind: classifyImageBriefKind(content.content.N.imageBrief, productionArtifacts?.imageBrief.status),
      imagePlan: content.imagePlan,
      imagePlanKind: content.imagePlan ? 'planned_visual_instruction' : 'absent',
      dialogueThreads: content.dialogueThreads,
      gapCoverageLedger: content.orchestrationSnapshot?.gapCoverageLedger,
      targetThreadCount: content.orchestrationSnapshot?.targetThreadCount,
      effectiveThreadCount: content.orchestrationSnapshot?.effectiveThreadCount,
      capacityWarning: content.orchestrationSnapshot?.capacityWarning,
      deploymentPlan: content.deploymentPlan,
      deploymentPlanKind: content.deploymentPlan ? 'operational_plan' : 'absent',
      productionArtifacts,
      orchestrationSnapshot: content.orchestrationSnapshot,
      opportunitySnapshot: (content as unknown as Record<string, unknown>).opportunitySnapshot,
      coverageSignature: content.coverageSignature,
      // Transport compatibility only. New clients must read the exact
      // validationHeuristic contract and must never label this as quality.
      score,
      validationHeuristic,
      diagnostics: content.diagnostics.map((item) => {
        const diagnostic = normalizeDiagnosticForApi(item);
        return { ...diagnostic, message: diagnostic.explanation };
      }),
      sources: content.evidence.map((item) => ({ fileId: item.documentId, name: item.path, detail: `${item.kind} · ${item.evidenceStatus}` })),
      unknowns: content.unknowns.map((item) => item.question),
      conflicts: content.conflicts.map((item) => `${item.key}：存在 ${item.alternatives.length} 种未解决说法`),
      seed: content.seed,
      validation: content.validation,
      revisions: content.revisions,
      resolutionSnapshot: content.resolutionSnapshot,
      impactReport: normalizedImpactReport ? publicImpacts(normalizedImpactReport) : undefined,
      diagnosticProxies: normalizedImpactReport
        ? diagnosticProxiesFromImpactReport(normalizedImpactReport)
        : [],
      parameterImpactReport: normalizedImpactReport,
      trace: content.resolutionSnapshot || normalizedImpactReport
        ? { resolutionSnapshot: content.resolutionSnapshot, impactReport: normalizedImpactReport }
        : undefined,
    };
  }

  private packageRows(jobId: string): PackageRow[] {
    return this.database.prepare('SELECT * FROM content_packages WHERE job_id = ? ORDER BY candidate_index').all(jobId) as unknown as PackageRow[];
  }

  private event(jobId: string, event: string, details: Record<string, unknown>): void {
    this.database.prepare('INSERT INTO generation_events (job_id, event, details_json, created_at) VALUES (?, ?, ?, ?)').run(jobId, event, JSON.stringify(details), nowIso());
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${name} 不能为空`);
    return value.trim();
  }

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

  private evidenceStatus(value: string): 'observed' | 'user_supplied' | 'inferred' | 'unknown' {
    if (/observed|核验|已知事实/u.test(value)) return 'observed';
    if (/inferred|推理|猜想/u.test(value)) return 'inferred';
    if (/unknown|未知|不足/u.test(value)) return 'unknown';
    return 'user_supplied';
  }
}

function validationIssueCountHeuristic(
  errorCount: number,
  warningCount: number,
  value: number,
): ValidationIssueCountHeuristic {
  return {
    schemaVersion: '1.0',
    kind: 'validation_issue_count_heuristic',
    semantics: 'non_quality_score',
    status: 'computed',
    value,
    range: [0, 100],
    inputs: {
      errorCount,
      warningCount,
      errorPenalty: 25,
      warningPenalty: 5,
    },
    evidenceStatus: 'operational_heuristic',
    calibrated: false,
    predicts: { quality: false, effect: false },
    excludes: {
      formulaIds: ['F32', 'F33'],
      diagnosticProxies: true,
      emphasis: true,
      missingValues: true,
    },
    consumedBy: {
      generation: false,
      planning: false,
      selection: false,
      validation: false,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 质量状态判定。
 *
 * 台账失败已从 error 降为 warning（可发布但事实锚定不完整，定级依据见 engine.ts）。
 * 降级后它不再拖垮 validation.valid，但也不该无声通过——quality_status 只有
 * passed/needs_review 两档，所以这里显式把「锚定受损」并入 needs_review：人工复核
 * 的信号保留，同时让完全正常的候选能真正 passed。
 *
 * 改这条之前，判定只看「有无 error」，于是中继一抖动就把整批打成 needs_review：
 * 实测 18 篇产出零 passed 全由台账那一条决定，质量信号完全失去区分度。
 */
export function deriveQualityStatus(
  packages: Array<{ validation: { valid: boolean; issues: Array<{ code: string }> } }>,
): 'passed' | 'needs_review' {
  const hasValidCandidate = packages.some((content) => content.validation.valid);
  const anchoringDegraded = packages.some((content) => content.validation.issues
    .some((issue) => issue.code === 'model_ledger_failed'));
  return hasValidCandidate && !anchoringDegraded ? 'passed' : 'needs_review';
}

export function computeBatchStatus(jobStatuses: string[]): 'queued' | 'running' | 'completed' | 'failed' | 'partial' {
  if (!jobStatuses.length) return 'completed';
  const anyActive = jobStatuses.some((s) => s === 'queued' || s === 'running');
  if (anyActive) {
    // 全部还没开始 → queued;否则 running
    return jobStatuses.every((s) => s === 'queued') ? 'queued' : 'running';
  }
  const anyOk = jobStatuses.some((s) => s === 'completed');
  const anyFail = jobStatuses.some((s) => s === 'failed');
  if (anyOk && anyFail) return 'partial';
  if (anyFail) return 'failed';
  return 'completed';
}

function publicImpacts(report: unknown): Array<Record<string, unknown>> {
  if (!isRecord(report)) return [];
  const defaults = new Map(GENERATION_PARAMETER_REGISTRY.map((definition) => [definition.id, definition.defaultValue]));
  const core = Array.isArray(report.parameterTraces) ? report.parameterTraces : [];
  const compatibility = Array.isArray(report.compatibilityTraces) ? report.compatibilityTraces : [];
  const projected: Array<Record<string, unknown>> = core
    .filter(isRecord)
    .filter((trace) => {
      const source = isRecord(trace.source) ? trace.source.source : trace.source;
      return source === 'preset' || source === 'style_profile' || source === 'override';
    })
    .map((trace) => {
      const source = isRecord(trace.source) ? trace.source : {};
      const baseline = defaults.get(String(trace.parameterId));
      const direction = typeof trace.value === 'number' && typeof baseline === 'number'
        ? trace.value > baseline ? 'higher' : trace.value < baseline ? 'lower' : 'default'
        : JSON.stringify(trace.value) === JSON.stringify(baseline) ? 'default' : 'changed';
      const instructions = Array.isArray(trace.behaviorInstructions)
        ? trace.behaviorInstructions.map(String)
        : [];
      // 空转参数不能用"已参与最终配置"兜底——那正是用户反复填了参数却看不出
      // 差别的原因。有 inertReason 就如实说明它当前为什么不影响产出。
      const inertReason = typeof trace.inertReason === 'string' && trace.inertReason ? trace.inertReason : undefined;
      return {
        parameterId: String(trace.parameterId ?? trace.path ?? 'parameter'),
        label: String(trace.label ?? trace.path ?? '参数'),
        value: trace.value,
        direction,
        summary: inertReason ?? (instructions.join('；') || '该参数已参与最终配置。'),
        ...(inertReason ? { inertReason, effective: false } : {}),
        affects: Array.isArray(trace.channels) ? trace.channels.map(String) : [],
        risk: typeof trace.evidenceNote === 'string' ? trace.evidenceNote : undefined,
        source: source.sourceId ? `${String(source.source)}:${String(source.sourceId)}` : source.source,
        formulaIds: Array.isArray(trace.formulaIds) ? trace.formulaIds : [],
      };
    });
  for (const raw of compatibility.filter(isRecord)) {
    projected.push({
      parameterId: String(raw.parameterId ?? raw.path ?? 'compatibility'),
      label: String(raw.label ?? raw.parameterId ?? '兼容参数'),
      value: raw.value,
      direction: 'changed',
      summary: String(raw.directive ?? raw.summary ?? '兼容参数已映射到底层配置。'),
      affects: typeof raw.path === 'string' ? [raw.path] : [],
      source: raw.source,
    });
  }
  return projected;
}
