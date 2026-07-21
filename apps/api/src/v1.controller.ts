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
         WHERE k.deleted_at IS NULL AND p.deleted_at IS NULL
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
         WHERE p.deleted_at IS NULL
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
         WHERE c.id = ? AND p.deleted_at IS NULL`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('内容包不存在');
    if (!this.canReadProject(principal, row)) throw new ForbiddenException('无权读取该内容包');
    return {
      id: row.id,
      jobId: row.job_id,
      projectId: row.project_id,
      candidateIndex: row.candidate_index,
      content: normalizeContentPackageForApi(parseJson(row.content_json, {})),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
