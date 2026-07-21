import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { GenerationService } from './generation.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { requireObject } from './utils.js';

@Controller('api/generations')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class GenerationController {
  constructor(
    @Inject(GenerationService) private readonly generations: GenerationService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() request: Request, @Query('projectId') projectId?: string) {
    if (projectId) this.assert(request, projectId, 'project.read');
    return this.generations.list(projectId).filter((job) => {
      if (projectId) return true;
      try { this.assert(request, String(job.projectId), 'project.read'); return true; } catch { return false; }
    });
  }

  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'project.read');
    return this.generations.get(id);
  }

  @Post()
  create(@Req() request: Request, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    if (typeof body.projectId !== 'string') throw new BadRequestException('projectId 不能为空');
    this.assert(request, body.projectId, 'generation.run');
    return this.generations.create(body, this.principal(request));
  }

  @Post(':id/revise')
  async revise(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'generation.chat');
    if (typeof body.candidateId !== 'string' || typeof body.instruction !== 'string') throw new BadRequestException('candidateId 和 instruction 不能为空');
    return this.generations.revise(id, body.candidateId, body.instruction, this.principal(request));
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
