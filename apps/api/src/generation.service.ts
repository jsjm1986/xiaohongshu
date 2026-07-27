import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  BadRequestException, Inject, Injectable, NotFoundException,
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
import { classifyModelFailure, modelFailureMessage, shouldRefundQuota } from './model-failure.js';
import { detectProviderOutage } from './provider-outage.js';
import { IntelligenceService } from './intelligence.service.js';
import type { SessionPrincipal } from './models.js';
import { PresetService } from './preset.service.js';
import { ResourceService } from './resource.service.js';
import { ResearchService } from './research.service.js';
import { RevisionService } from './revision.service.js';
import { SettingsService } from './settings.service.js';
import { nowIso, parseJson } from './utils.js';

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
            const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
            console.error(`[retry] purpose=${String(request.metadata?.purpose)} attempt=${attempt + 1}/${maxAttempts} status=${status} ${detail}`);
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
    const revisionResult = reclaimStale(
      this.database, REVISION_TASKS_SPEC, nowIso(), this.options.jobClaimTimeoutMs,
      (attempts) => `修改被反复打断（${attempts} 次），已停止自动重跑，请重新提交修改要求`,
    );
    for (const id of revisionResult.requeued) {
      const task = this.revisions.row(id);
      if (task) this.event(task.job_id, 'revision_requeued', { revisionId: id, reason: 'claim_timeout' });
    }
    for (const id of revisionResult.failed) {
      const task = this.revisions.row(id);
      if (task) this.event(task.job_id, 'revision_failed', { revisionId: id, message: '修改被反复打断，已停止自动重跑' });
    }
    this.drainRevisions();
  }

  create(raw: Record<string, unknown>, principal: SessionPrincipal): Record<string, unknown> {
    const id = this.insertJob(raw, principal, null);
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
   * 痕迹;而且付费产品里「删错了」必须有退路。已扣的额度不退——记录还在才解释得清账。
   */
  softDelete(jobId: string): Record<string, unknown> {
    const row = this.jobRow(jobId);
    if (row.deleted_at) return { id: row.id, topic: row.topic, alreadyDeleted: true };
    // 队列在 DB 里,而领取与位次查询都带 deleted_at IS NULL,所以软删本身就让它
    // 不再被 drainQueue 捞起来跑——不需要额外摘队列。这比原来只摘本实例内存队列
    // 更可靠:多实例下别的实例照样不会捞它。
    const wasQueued = row.status === 'queued';
    // 独立语句而不是扩展 updateJob:后者一次性重写 status/progress/error 等七个字段,
    // 让它顺带管软删会把"删除"和"改状态"这两件事纠缠在一起。
    const now = nowIso();
    this.database.prepare('UPDATE generation_jobs SET deleted_at=?, updated_at=? WHERE id=?').run(now, now, jobId);
    this.event(jobId, 'deleted', { removedFromQueue: wasQueued });
    return { id: row.id, topic: row.topic, alreadyDeleted: false };
  }

  /** 撤销软删。 */
  restore(jobId: string): Record<string, unknown> {
    const row = this.jobRow(jobId);
    if (!row.deleted_at) return { id: row.id, topic: row.topic, alreadyActive: true };
    /*
     * 只清 deleted_at,不重新入队。
     *
     * 被删的任务如果当时还在排队,软删已经把它摘出内存队列了;撤销时重新入队看似
     * 对称,实则危险——用户删掉一个排队任务往往正是为了让它别跑(省额度、改主意)。
     * 恢复出来的记录停在 queued 状态,由「按同款重试」显式重发,而不是悄悄开跑。
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
    const cleared = this.database
      .prepare("SELECT id FROM generation_jobs WHERE project_id=? AND status='queued' AND deleted_at IS NULL")
      .all(projectId) as unknown as Array<{ id: string }>;
    if (!cleared.length) return 0;
    for (const row of cleared) {
      this.updateJob(row.id, { status: 'failed', error: reason, progress: 100, completedAt: nowIso() });
      this.event(row.id, 'failed', { message: reason, providerOutage: true });
    }
    return cleared.length;
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

  /** 本实例是否仍持有这个修改任务。收尾写库前必查:心跳断过就可能已被接管。 */
  private stillOwnsRevision(revisionId: string): boolean {
    if (this.stopped) return false;
    try {
      const row = this.database.prepare('SELECT claimed_by FROM revision_tasks WHERE id=?').get(revisionId) as
        { claimed_by: string | null } | undefined;
      return row?.claimed_by === this.options.instanceId;
    } catch {
      // 关停竞态:连接已关闭。当作不再持有,放弃写入。
      return false;
    }
  }

  /** 推进进度。已不持有则静默放弃,不覆盖接管者的进度。 */
  private revisionProgress(revisionId: string, value: number): void {
    if (!this.stillOwnsRevision(revisionId)) return;
    try {
      this.database
        .prepare('UPDATE revision_tasks SET progress=?, updated_at=? WHERE id=?')
        .run(value, nowIso(), revisionId);
    } catch { /* 关停竞态:任务留在 running,由回收接管 */ }
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

  /**
   * 推进进度。关停途中静默跳过:进度只是 UI 反馈,而 process 的 await 之间可能
   * 跨过 app.close(),这时写库会撞上已关闭的连接。
   */
  private progress(jobId: string, value: number, knowledgeContext?: unknown): void {
    if (this.stopped) return;
    try {
      this.updateJob(jobId, knowledgeContext === undefined
        ? { progress: value }
        : { progress: value, knowledgeContext });
    } catch { /* 关停竞态:任务留在 running,由回收接管 */ }
  }

  /**
   * 本实例是否仍应该写这个任务的结果。收尾写库前确认一次。
   *
   * 两种情况要停手:(a) 已关停——连接可能已经关闭,继续写会撞上「database is not
   * open」并冒成 unhandledRejection;任务留在 running,心跳停更后由下一个实例回收。
   * (b) 归属已易主——任务被回收并被别的实例接管重跑,再写就会与接管者互相覆盖,
   * 同一个 job 出现两套 content_packages。
   */
  private stillOwns(jobId: string): boolean {
    if (this.stopped) return false;
    try {
      const row = this.database
        .prepare('SELECT claimed_by FROM generation_jobs WHERE id=?')
        .get(jobId) as { claimed_by: string | null } | undefined;
      return row?.claimed_by === this.options.instanceId;
    } catch {
      // 关停竞态:连接已关闭。当作不再持有,放弃写入。
      return false;
    }
  }

  private async process(jobId: string): Promise<void> {
    const job = this.jobRow(jobId);
    // status 已由 claimNextJob 原子置为 running,这里只推进进度。
    this.updateJob(jobId, { progress: 12, error: null });
    this.startHeartbeat(jobId);
    this.event(jobId, 'running', {});
    // process 的每个 await 之间都可能跨过 app.close()。收尾写入靠 stillOwns 挡,
    // 中途的进度更新靠 progress() 挡,失败路径也检查 stillOwns。

    try {
      const config = parseJson<ResolvedGenerationConfig>(job.config_json, {} as ResolvedGenerationConfig);
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
      const knowledge = await this.loadKnowledge(job.project_id);
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
      // 收尾前确认所有权:若本实例的心跳曾经断掉、任务已被别的实例接管并重跑,
      // 这里再写产出就会与接管者互相覆盖(同一 job 出现两套 content_packages)。
      // 放弃写入而不是抛错:接管者会完整跑完,用户拿到的仍是一份正常产出。
      if (!this.stillOwns(jobId)) {
        this.event(jobId, 'claim_lost', { message: '任务已被其他实例接管，本次结果丢弃' });
        return;
      }
      this.progress(jobId, 88, result.knowledgeContext);
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
        if (Object.keys(realizedOpportunitySnapshot).length) {
          this.database.prepare(
            'UPDATE generation_jobs SET opportunity_snapshot_json=?, updated_at=? WHERE id=?',
          ).run(JSON.stringify(realizedOpportunitySnapshot), nowIso(), jobId);
        }
        if (result.resolutionSnapshot || result.impactReport) {
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
          this.database
            .prepare(
              `UPDATE generation_jobs SET resolution_snapshot_json=?, config_impact_json=?, updated_at=?
               WHERE id=?`,
            )
            .run(
              JSON.stringify(mergedResolution),
              JSON.stringify(mergedImpact),
              nowIso(),
              jobId,
            );
        }
        this.updateJob(jobId, { status: 'completed', qualityStatus, progress: 100, completedAt: result.completedAt });
      });
      this.event(jobId, 'completed', {
        candidateCount: result.packages.length,
        validCandidateCount,
        qualityStatus,
        knowledgeMode: result.knowledgeContext.mode,
        selectedDocuments: result.knowledgeContext.selectedDocumentIds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      // 已被接管的任务不写失败态:接管者可能正跑得好好的,把它标 failed 是覆盖
      // 别人的正确结果。本次失败只记事件,不改状态。
      if (this.stillOwns(jobId)) {
        this.updateJob(jobId, { status: 'failed', error: message, progress: 100, completedAt: nowIso() });
      }
      this.event(jobId, 'failed', { message });
      // 供应商级故障(余额不足/无可用账号/凭据冷却):后面排队的注定同样失败,
      // 立刻判掉而不是每篇再花 16 分钟撞一次同一面墙。单篇级错误不触发。
      const outage = detectProviderOutage(message);
      if (outage) {
        const cleared = this.failQueuedForOutage(job.project_id, outage.reason);
        if (cleared > 0) {
          this.event(jobId, 'provider_outage', { kind: outage.kind, clearedQueuedJobs: cleared });
        }
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
    this.startRevisionHeartbeat(revisionId);
    this.event(task.job_id, 'revision_running', { revisionId });

    let quotaConsumed = false;
    // workspaceId 在 try 内才拿得到,但 catch 里要用它退额度。先置空:退额度只在
    // quotaConsumed 为真时发生,而那一定意味着 workspaceId 已经取到了。
    let workspaceId = '';
    try {
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
      const providerSettings = this.settings.provider(workspaceId, task.created_by);
      // 扣额度的时机与原同步实现一致(调用模型前),只是补上失败退还。
      if (providerSettings.mode === 'platform' && providerSettings.apiKey) {
        this.settings.consumePlatformQuota(workspaceId);
        quotaConsumed = true;
      }

      this.revisionProgress(revisionId, 25);
      const knowledge = await this.loadKnowledge(job.project_id);
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
      const agent = new ContentGenerationAgent({ modelProvider: this.modelProvider(providerSettings) });
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

      // 收尾前确认所有权:心跳断过、任务已被接管并重跑时,再写就会两边互相覆盖。
      if (!this.stillOwnsRevision(revisionId)) {
        this.event(task.job_id, 'revision_claim_lost', { revisionId, message: '任务已被其他实例接管，本次结果丢弃' });
        return;
      }
      const now = nowIso();
      this.database.transaction(() => {
        this.database
          .prepare('UPDATE content_packages SET id=?, content_json=?, updated_at=? WHERE id=?')
          .run(result.package.id, JSON.stringify(result.package), now, packageRow.id);
        this.database
          .prepare(
            `UPDATE revision_tasks
                SET status='completed', progress=100, error=NULL, rerun_channels_json=?,
                    result_package_id=?, completed_at=?, updated_at=?
              WHERE id=?`,
          )
          .run(JSON.stringify(result.dependency.rerunChannels), result.package.id, now, now, revisionId);
      });
      this.event(task.job_id, 'revised', {
        revisionId,
        candidateId: task.candidate_id,
        rerunChannels: result.dependency.rerunChannels,
        approvedSourceImageAnalysisCount: hydrated?.imageAnalyses?.length ?? 0,
      });
      this.audit.record({
        workspaceId, userId: task.created_by, action: 'generation.revise',
        entityType: 'content_package', entityId: result.package.id,
        details: { jobId: task.job_id, candidateId: task.candidate_id, rerunChannels: result.dependency.rerunChannels },
      });
    } catch (error) {
      const kind = classifyModelFailure(error);
      const raw = error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
      /*
       * 只在「确认无产出」时退额度(shouldRefundQuota:other 类不退)。校验不通过一类
       * 消耗了真实算力并产出了可判定结果,退它等于白送一次。
       *
       * 与分析路径的分歧,已由人类裁定并有意保留:intelligence.service 的
       * analyzeWithCurrentModel 对**任何**错误都退额度。那是既有的历史行为,改它会让
       * 现有用户的额度账目发生变化,所以只有 revise 这条新路径用新真源。两处不一致是
       * 明知的、不是遗漏。
       */
      if (quotaConsumed && shouldRefundQuota(kind)) this.settings.refundPlatformQuota(workspaceId);
      if (!this.stillOwnsRevision(revisionId)) return;
      const now = nowIso();
      this.database
        .prepare("UPDATE revision_tasks SET status='failed', progress=100, error=?, completed_at=?, updated_at=? WHERE id=?")
        .run(modelFailureMessage(kind, '修改', raw), now, now, revisionId);
      this.event(task.job_id, 'revision_failed', { revisionId, message: raw });
    }
  }

  private async loadKnowledge(projectId: string): Promise<KnowledgeDocument[]> {
    const rows = this.database
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
    return Promise.all(rows.map(async (row) => {
      const content = await readFile(resolve(this.database.options.dataDir, String(row.storage_path)), 'utf8');
      const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json), {});
      return indexKnowledgeSource({
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
      });
    }));
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
      timeoutMs: Number.isFinite(this.options.modelRequestTimeoutMs)
        ? Math.max(10_000, Math.min(300_000, this.options.modelRequestTimeoutMs))
        : 90_000,
    });
    return limitModelProvider(
      retryModelProvider(client, { maxAttempts: this.options.modelRetryAttempts }),
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

  private updateJob(jobId: string, input: { status?: string; qualityStatus?: JobRow['quality_status']; progress?: number; error?: string | null; completedAt?: string; knowledgeContext?: unknown }): void {
    const row = this.jobRow(jobId);
    const status = input.status ?? row.status;
    // 终态清空归属与心跳:留着会让已完成的任务看起来仍被某个实例持有,回收扫描
    // 也得多筛一层。清掉之后「claimed_by 非空」就精确等于「有实例正在跑」。
    const terminal = status === 'completed' || status === 'failed';
    this.database
      .prepare(
        `UPDATE generation_jobs
            SET status=?, quality_status=?, progress=?, error=?, completed_at=?, knowledge_context_json=?, updated_at=?
                ${terminal ? ', claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL' : ''}
          WHERE id=?`,
      )
      .run(status, input.qualityStatus ?? row.quality_status, input.progress ?? row.progress, input.error === undefined ? row.error : input.error, input.completedAt ?? row.completed_at, input.knowledgeContext === undefined ? row.knowledge_context_json : JSON.stringify(input.knowledgeContext), nowIso(), jobId);
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
