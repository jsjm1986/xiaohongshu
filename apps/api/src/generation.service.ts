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
import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
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
import { recoverInterruptedJobs } from './generation-restart-recovery.js';
import { detectProviderOutage } from './provider-outage.js';
import { IntelligenceService } from './intelligence.service.js';
import type { SessionPrincipal } from './models.js';
import { PresetService } from './preset.service.js';
import { ResourceService } from './resource.service.js';
import { ResearchService } from './research.service.js';
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
export class GenerationService implements OnModuleInit {
  private readonly queue: string[] = [];
  private activeJobs = 0;
  private readonly maxConcurrentJobs = 2;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(PresetService) private readonly presets: PresetService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
    @Inject(ResearchService) private readonly research: ResearchService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  onModuleInit(): void {
    const recovered = recoverInterruptedJobs(this.database);
    for (const jobId of recovered) this.enqueue(jobId);
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

  list(projectId?: string): Record<string, unknown>[] {
    const rows = (projectId
      ? this.database.prepare('SELECT * FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : this.database.prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC').all()) as unknown as JobRow[];
    return rows.map((row) => this.mapJobForList(row));
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
      // 只有 completed 才有候选;其余状态给空数组,前端不用分支判 undefined。
      candidates: row.status === 'completed'
        ? this.packageRows(jobId).map((item) =>
            readerView(normalizeContentPackageForApi(parseJson<ContentPackage>(item.content_json, {} as ContentPackage))),
          )
        : [],
    };
  }

  async revise(jobId: string, candidateId: string, instruction: string, principal: SessionPrincipal): Promise<Record<string, unknown>> {
    if (!instruction.trim()) throw new BadRequestException('修改要求不能为空');
    const job = this.jobRow(jobId);
    if (job.status !== 'completed') throw new BadRequestException('只有已完成任务可以修改');
    const rows = this.packageRows(jobId);
    const selected = rows
      .map((row) => ({ row, content: parseJson<ContentPackage | null>(row.content_json, null) }))
      .find((item) => item.content?.candidateId === candidateId || item.content?.id === candidateId);
    if (!selected?.content) throw new NotFoundException('候选内容不存在');
    const formula = this.formulas.get(job.formula_version_id).version;
    const knowledge = await this.loadKnowledge(job.project_id);
    const project = this.resources.projectRow(job.project_id);
    const providerSettings = this.settings.provider(String(project.workspace_id), principal.userId);
    if (providerSettings.mode === 'platform' && providerSettings.apiKey) this.settings.consumePlatformQuota(String(project.workspace_id));
    const agent = new ContentGenerationAgent({ modelProvider: this.modelProvider(providerSettings) });
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
    const hydratedRevisionContext = await this.intelligence.hydratePlanningContext(job.project_id, revisionPlanningContext);
    const result = await agent.revise({
      package: selected.content,
      instruction: instruction.trim().slice(0, 2_000),
      formulaVersion: formula,
      knowledge,
      parameterSelection,
      imageAnalyses: hydratedRevisionContext?.imageAnalyses,
      planningContext: hydratedRevisionContext,
    });
    if (!result.package.resolutionSnapshot && selected.content.resolutionSnapshot) {
      result.package.resolutionSnapshot = selected.content.resolutionSnapshot;
    }
    if (!result.package.impactReport && selected.content.impactReport) {
      result.package.impactReport = selected.content.impactReport;
    }
    for (const field of ['imagePlan', 'dialogueThreads', 'deploymentPlan', 'orchestrationSnapshot', 'coverageSignature', 'productionArtifacts', 'opportunitySnapshot']) {
      const revisedPackage = result.package as unknown as Record<string, unknown>;
      const selectedPackage = selected.content as unknown as Record<string, unknown>;
      if (!revisedPackage[field] && selectedPackage[field]) {
        revisedPackage[field] = selectedPackage[field];
      }
    }
    const now = nowIso();
    this.database
      .prepare('UPDATE content_packages SET id = ?, content_json = ?, updated_at = ? WHERE id = ?')
      .run(result.package.id, JSON.stringify(result.package), now, selected.row.id);
    this.event(jobId, 'revised', {
      candidateId,
      rerunChannels: result.dependency.rerunChannels,
      revisionId: result.package.revisions.at(-1)?.id,
      approvedSourceImageAnalysisCount: hydratedRevisionContext?.imageAnalyses?.length ?? 0,
    });
    this.audit.record({ workspaceId: String(project.workspace_id), userId: principal.userId, action: 'generation.revise', entityType: 'content_package', entityId: result.package.id, details: { jobId, candidateId, rerunChannels: result.dependency.rerunChannels } });
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
    const index = this.queue.indexOf(jobId);
    return index === -1 ? undefined : index + 1;
  }

  /** 当前排队总数,让前端能说"第 3/24 位"而不是光一个 3。 */
  queueLength(): number {
    return this.queue.length;
  }

  /** 两个映射(列表/详情)共用的排队字段,只在真的排队时出现。 */
  private queueView(jobId: string): { queuePosition?: number; queueLength?: number } {
    const position = this.queuePosition(jobId);
    return position === undefined ? {} : { queuePosition: position, queueLength: this.queue.length };
  }

  private enqueue(jobId: string): void {
    this.queue.push(jobId);
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
    const remaining: string[] = [];
    const cleared: string[] = [];
    for (const queuedId of this.queue) {
      let row: JobRow | undefined;
      try { row = this.jobRow(queuedId); } catch { row = undefined; }
      // 读不到行的一律留在队列里:宁可多跑一篇,也不要凭猜测判死任务
      if (row?.project_id === projectId) cleared.push(queuedId);
      else remaining.push(queuedId);
    }
    if (cleared.length === 0) return 0;
    // 原地替换队列内容(queue 是 readonly 引用,位次计算依赖同一个数组)
    this.queue.length = 0;
    this.queue.push(...remaining);
    for (const clearedId of cleared) {
      this.updateJob(clearedId, { status: 'failed', error: reason, progress: 100, completedAt: nowIso() });
      this.event(clearedId, 'failed', { message: reason, providerOutage: true });
    }
    return cleared.length;
  }

  private drainQueue(): void {
    while (this.activeJobs < this.maxConcurrentJobs && this.queue.length) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      this.activeJobs += 1;
      setImmediate(() => {
        void this.process(jobId)
          .catch(() => undefined)
          .finally(() => {
            this.activeJobs -= 1;
            this.drainQueue();
          });
      });
    }
  }

  private async process(jobId: string): Promise<void> {
    const job = this.jobRow(jobId);
    this.updateJob(jobId, { status: 'running', progress: 12, error: null });
    this.event(jobId, 'running', {});
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
      this.updateJob(jobId, { progress: 28 });
      const knowledge = await this.loadKnowledge(job.project_id);
      this.updateJob(jobId, { progress: 44 });
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
      this.updateJob(jobId, { progress: 88, knowledgeContext: result.knowledgeContext });
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
      this.updateJob(jobId, { status: 'failed', error: message, progress: 100, completedAt: nowIso() });
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
    this.database
      .prepare('UPDATE generation_jobs SET status=?, quality_status=?, progress=?, error=?, completed_at=?, knowledge_context_json=?, updated_at=? WHERE id=?')
      .run(input.status ?? row.status, input.qualityStatus ?? row.quality_status, input.progress ?? row.progress, input.error === undefined ? row.error : input.error, input.completedAt ?? row.completed_at, input.knowledgeContext === undefined ? row.knowledge_context_json : JSON.stringify(input.knowledgeContext), nowIso(), jobId);
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
