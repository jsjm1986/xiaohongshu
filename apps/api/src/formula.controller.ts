import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { FormulaService } from './formula.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { requireObject } from './utils.js';

@Controller('api/formulas')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class FormulaController {
  constructor(
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() request: Request, @Query('projectId') projectId?: string) {
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(request, projectId, 'formula.read');
    return this.formulas.list(projectId);
  }

  @Post('projects/:projectId/ensure-reviewed-defaults')
  @HttpCode(200)
  ensureReviewedDefaults(@Req() request: Request, @Param('projectId') projectId: string) {
    this.assert(request, projectId, 'formula.manage');
    const beforeActive = this.formulas.list(projectId).find((item) => item.status === 'active');
    const version = this.formulas.ensureDefault(projectId, this.principal(request));
    return {
      projectId,
      formulaVersionId: version.id,
      formulaVersionDigest: version.digest,
      changed: beforeActive?.id !== version.id,
      operation: 'ensure_reviewed_defaults',
    };
  }

  @Post()
  create(@Req() request: Request, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    if (typeof body.projectId !== 'string') throw new BadRequestException('projectId 不能为空');
    this.assert(request, body.projectId, 'formula.manage');
    return this.formulas.create(body.projectId, body, this.principal(request));
  }

  @Post(':id/activate')
  activate(@Req() request: Request, @Param('id') id: string) {
    const item = this.formulas.get(id);
    this.assert(request, item.row.project_id, 'formula.activate');
    return this.formulas.activate(id, this.principal(request));
  }

  @Post(':versionId/:formulaId/calculate')
  @HttpCode(200)
  calculate(
    @Req() request: Request,
    @Param('versionId') versionId: string,
    @Param('formulaId') formulaId: string,
    @Body() rawBody: unknown,
  ) {
    const item = this.formulas.get(versionId);
    this.assert(request, item.row.project_id, 'formula.read');
    const body = requireObject(rawBody);
    if (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables)) {
      throw new BadRequestException('variables 必须是 JSON 对象');
    }
    return this.formulas.calculate(versionId, formulaId, body.variables as Record<string, unknown>);
  }

  private assert(rawRequest: Request, projectId: string, permission: Permission): void {
    if (!this.can(rawRequest, projectId, permission)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private can(rawRequest: Request, projectId: string, permission: Permission): boolean {
    const principal = this.principal(rawRequest);
    const project = this.resources.projectRow(projectId);
    return principal.systemRole === 'admin'
      || this.permissions.hasPermission(principal.userId, String(project.workspace_id), permission, projectId);
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
