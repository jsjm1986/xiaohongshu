import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { isNonOverridableContentIssueCode, resolveCandidateQualityStatus } from '@content-agent/agent-core';
import type { Request } from 'express';
import { DatabaseService } from './database.service.js';
import { normalizeContentPackageForApi, normalizeImpactReportForApi } from './diagnostic-contract.js';
import { PermissionGuard, ReadOnlyAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Principal, SessionPrincipal } from './models.js';
import { parseJson } from './utils.js';

@Controller('v1')
@UseGuards(ReadOnlyAuthGuard)
export class V1Controller {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get('projects')
  projects(
    @Req() rawRequest: Request,
    @Query('workspaceId') workspaceId?: string,
  ): Record<string, unknown>[] {
    const principal = this.principal(rawRequest);
    const effectiveWorkspace = this.effectiveWorkspace(principal, workspaceId);
    const rows = this.database
      .prepare(
        `SELECT p.* FROM projects p JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (? IS NULL OR p.workspace_id = ?)
         ORDER BY p.updated_at DESC`,
      )
      .all(effectiveWorkspace ?? null, effectiveWorkspace ?? null) as unknown as Record<string, unknown>[];
    return rows
      .filter((row) => this.canReadProject(principal, row))
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        profile: parseJson(row.profile_json, {}),
        updatedAt: row.updated_at,
      }));
  }

  @Get('knowledge/files')
  knowledgeFiles(
    @Req() rawRequest: Request,
    @Query('workspaceId') workspaceId?: string,
    @Query('projectId') projectId?: string,
  ): Record<string, unknown>[] {
    const principal = this.principal(rawRequest);
    const effectiveWorkspace = this.effectiveWorkspace(principal, workspaceId);
    const rows = this.database
      .prepare(
        `SELECT k.*, p.workspace_id FROM knowledge_files k
         JOIN projects p ON p.id = k.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE k.deleted_at IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (? IS NULL OR p.workspace_id = ?)
           AND (? IS NULL OR k.project_id = ?)
         ORDER BY k.created_at DESC`,
      )
      .all(
        effectiveWorkspace ?? null,
        effectiveWorkspace ?? null,
        projectId ?? null,
        projectId ?? null,
      ) as unknown as Record<string, unknown>[];
    return rows
      .filter((row) => this.canReadKnowledge(principal, row))
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        filename: row.filename,
        mediaType: row.media_type,
        bytes: row.bytes,
        sha256: row.sha256,
        version: row.version,
        category: row.category,
        evidenceStatus: row.evidence_status,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  @Get('generation-jobs')
  generationJobs(
    @Req() rawRequest: Request,
    @Query('workspaceId') workspaceId?: string,
    @Query('projectId') projectId?: string,
  ): Record<string, unknown>[] {
    const principal = this.principal(rawRequest);
    const effectiveWorkspace = this.effectiveWorkspace(principal, workspaceId);
    const rows = this.database
      .prepare(
        `SELECT j.*, p.workspace_id FROM generation_jobs j
         JOIN projects p ON p.id = j.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE j.deleted_at IS NULL AND p.deleted_at IS NULL AND w.deleted_at IS NULL
           AND (? IS NULL OR p.workspace_id = ?)
           AND (? IS NULL OR j.project_id = ?)
         ORDER BY j.created_at DESC`,
      )
      .all(
        effectiveWorkspace ?? null,
        effectiveWorkspace ?? null,
        projectId ?? null,
        projectId ?? null,
      ) as unknown as Record<string, unknown>[];
    return rows
      .filter((row) => this.canReadProject(principal, row))
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        status: row.status,
        config: parseJson(row.config_json, {}),
        seed: row.seed,
        formulaVersionId: row.formula_version_id,
        presetId: row.preset_id,
        styleProfileVersion: row.style_profile_version,
        resolutionSnapshot: parseJson(row.resolution_snapshot_json, {}),
        parameterImpactReport: normalizeImpactReportForApi(parseJson(row.config_impact_json, {})),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  @Get('content-packages/:id')
  contentPackage(@Req() rawRequest: Request, @Param('id') id: string): Record<string, unknown> {
    const principal = this.principal(rawRequest);
    const row = this.database
      .prepare(
        `SELECT c.*, p.workspace_id FROM content_packages c
         JOIN projects p ON p.id = c.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE c.id = ? AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('内容包不存在');
    if (!this.canReadProject(principal, row)) throw new ForbiddenException('无权读取该内容包');
    const pkg = normalizeContentPackageForApi(parseJson(row.content_json, {})) as Record<string, unknown>;
    const validation = pkg.validation as {
      valid?: boolean;
      qualityStatus?: unknown;
      issues?: Array<{ code?: string; severity?: 'error' | 'warning'; disposition?: 'block' | 'review' | 'advisory' }>;
    } | undefined;
    const qualityStatus = resolveCandidateQualityStatus(validation);
    // 交付门禁在所有出口一致:Web 复制门控与后端导出都拒绝 blocked 候选,
    // 只读 API 曾无条件放行全文——程序化集成(自动发布工具)恰是最需要门控的
    // 出口。与 export.service.validatePackage 同一判定:确定性预览、不可交付
    // 产物、不可覆盖硬门禁,一律不提供可见文案。needs_review(可人工覆盖的
    // 缺陷)照常返回,由响应里的 qualityStatus 交给集成方判断。
    if (qualityStatus === 'blocked' || this.deliveryBlocked(pkg)) {
      throw new ForbiddenException({
        message: '该候选未通过交付硬门禁（确定性预览/来源真实性/保密/身份或必要结构），只读 API 不提供其可见文案；请在产品内修复或重新生成。',
        code: 'CONTENT_PACKAGE_DELIVERY_BLOCKED',
      });
    }
    return {
      id: row.id,
      jobId: row.job_id,
      projectId: row.project_id,
      candidateIndex: row.candidate_index,
      // 集成方必须能不解析全部 issues 就判断「可直接交付」还是「需人工复核」。
      qualityStatus,
      content: pkg,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 与 export.service.validatePackage 的硬门禁判定同一条线,只判定不抛错。 */
  private deliveryBlocked(pkg: Record<string, unknown>): boolean {
    if (pkg.generationMode === 'deterministic_preview') return true;
    const realization = pkg.artifactRealization as { deliverability?: string } | undefined;
    if (realization?.deliverability === 'non_deliverable') return true;
    const validation = pkg.validation as { issues?: Array<{ code?: string }> } | undefined;
    return (validation?.issues ?? []).some((issue) =>
      typeof issue?.code === 'string' && isNonOverridableContentIssueCode(issue.code));
  }

  private effectiveWorkspace(principal: Principal, requested?: string): string | undefined {
    if (principal.kind === 'apiKey') {
      if (requested && requested !== principal.workspaceId) {
        throw new ForbiddenException('API Key 不能跨工作区访问');
      }
      return principal.workspaceId;
    }
    return requested;
  }

  private canReadProject(principal: Principal, row: Record<string, unknown>): boolean {
    if (principal.kind === 'apiKey') return row.workspace_id === principal.workspaceId;
    if (principal.systemRole === 'admin') return true;
    return this.permissions.hasPermission(
      principal.userId,
      String(row.workspace_id),
      'project.read',
      String(row.project_id ?? row.id),
    );
  }

  private canReadKnowledge(principal: Principal, row: Record<string, unknown>): boolean {
    if (principal.kind === 'apiKey') return row.workspace_id === principal.workspaceId;
    if (principal.systemRole === 'admin') return true;
    return this.permissions.hasPermission(
      principal.userId,
      String(row.workspace_id),
      'knowledge.read',
      String(row.project_id),
    );
  }

  private principal(rawRequest: Request): Principal {
    return (rawRequest as unknown as AuthenticatedRequest).principal;
  }
}
