import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { GenerationService } from './generation.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { requireObject } from './utils.js';

@Controller('api/generation-batches')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class GenerationBatchController {
  constructor(
    @Inject(GenerationService) private readonly generations: GenerationService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() request: Request, @Query('projectId') projectId?: string) {
    if (typeof projectId !== 'string' || !projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(request, projectId, 'project.read');
    return this.generations.listBatches(projectId);
  }

  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    const batch = this.generations.batchRow(id);
    this.assert(request, String(batch.project_id), 'project.read');
    return this.generations.getBatch(id);
  }

  @Post()
  create(@Req() request: Request, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    if (typeof body.projectId !== 'string') throw new BadRequestException('projectId 不能为空');
    this.assert(request, body.projectId, 'generation.run');
    return this.generations.createBatch(body, this.principal(request));
  }

  private assert(rawRequest: Request, projectId: string, permission: Permission): void {
    const principal = this.principal(rawRequest);
    const project = this.resources.projectRow(projectId);
    if (principal.systemRole !== 'admin' && !this.permissions.hasPermission(principal.userId, String(project.workspace_id), permission, projectId)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
