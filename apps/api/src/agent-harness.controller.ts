import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentHarnessService } from './agent-harness.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { parsePagination, requireObject } from './utils.js';

@Controller('api/agent-harness')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class AgentHarnessController {
  constructor(
    @Inject(AgentHarnessService) private readonly harness: AgentHarnessService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
    @Inject(RateLimitService) private readonly rateLimits: RateLimitService,
  ) {}

  @Get()
  list(
    @Req() request: Request,
    @Query('projectId') projectId?: string,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
  ) {
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(request, projectId, 'project.read');
    return this.harness.list(projectId, parsePagination(rawLimit, rawOffset, { defaultLimit: 30 }));
  }

  @Get('trash')
  trash(
    @Req() request: Request,
    @Query('projectId') projectId?: string,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
  ) {
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(request, projectId, 'project.read');
    return this.harness.listDeleted(projectId, parsePagination(rawLimit, rawOffset, { defaultLimit: 30 }));
  }

  @Get('capabilities')
  capabilities(@Req() request: Request, @Query('projectId') projectId?: string) {
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(request, projectId, 'project.read');
    const principal = this.principal(request);
    const project = this.resources.projectRow(projectId);
    const workspaceId = String(project.workspace_id);
    const has = (permission: Permission) => principal.systemRole === 'admin'
      || this.permissions.hasPermission(principal.userId, workspaceId, permission, projectId);
    return {
      projectId,
      canRun: has('generation.run'),
      canRevise: has('generation.chat'),
      canEdit: has('generation.edit'),
      canExport: has('generation.export'),
    };
  }

  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'project.read');
    return this.harness.get(id);
  }

  @Post()
  async create(@Req() request: Request, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    if (typeof body.projectId !== 'string') throw new BadRequestException('projectId 不能为空');
    this.assert(request, body.projectId, 'generation.run');
    const principal = this.principal(request);
    this.consumeSubmission(principal, body.projectId);
    return this.harness.create(body, principal);
  }


  @Post(':id/retry')
  async retry(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.run');
    const principal = this.principal(request);
    this.consumeSubmission(principal, row.project_id);
    return this.harness.retry(id, principal);
  }

  @Post(':id/retry-review')
  retryReview(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.run');
    const principal = this.principal(request);
    this.consumeSubmission(principal, row.project_id);
    return this.harness.retryReview(id, principal);
  }

  @Post(':id/revise')
  async revise(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.chat');
    if (typeof body.candidateId !== 'string' || typeof body.instruction !== 'string') {
      throw new BadRequestException('candidateId 和 instruction 不能为空');
    }
    const principal = this.principal(request);
    this.consumeSubmission(principal, row.project_id);
    return this.harness.revise(id, body.candidateId, body.instruction, principal);
  }

  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id, true);
    this.assert(request, row.project_id, 'generation.edit');
    return this.harness.softDelete(id, this.principal(request));
  }

  @Post(':id/restore')
  restore(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id, true);
    this.assert(request, row.project_id, 'generation.edit');
    return this.harness.restore(id, this.principal(request));
  }

  @Post(':id/select')
  select(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.edit');
    if (typeof body.candidateId !== 'string') throw new BadRequestException('candidateId 不能为空');
    return this.harness.selectCandidate(id, body.candidateId, this.principal(request));
  }

  @Post(':id/approve')
  approve(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.export');
    if (body.notes !== undefined && typeof body.notes !== 'string') throw new BadRequestException('notes 必须是字符串');
    return this.harness.approve(id, typeof body.notes === 'string' ? body.notes : '', this.principal(request));
  }

  @Delete(':id/purge')
  purge(@Req() request: Request, @Param('id') id: string) {
    const row = this.harness.jobRow(id, true);
    this.assert(request, row.project_id, 'generation.edit');
    return this.harness.purge(id, this.principal(request));
  }

  @Get(':id/export')
  exportRun(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') id: string,
    @Query('format') rawFormat = 'markdown',
  ) {
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.export');
    const format = rawFormat === 'md' ? 'markdown' : rawFormat;
    if (format !== 'markdown' && format !== 'json') {
      throw new BadRequestException('format 只支持 markdown、md 或 json');
    }
    const result = this.harness.exportRun(id, format);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    response.setHeader('Content-Length', String(result.buffer.byteLength));
    response.send(result.buffer);
  }

  @Get(':id/candidates/:candidateId/export')
  exportCandidate(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
    @Query('format') rawFormat = 'markdown',
  ) {
    const row = this.harness.jobRow(id);
    this.assert(request, row.project_id, 'generation.export');
    const format = rawFormat === 'md' ? 'markdown' : rawFormat;
    if (format !== 'markdown' && format !== 'json') {
      throw new BadRequestException('format 只支持 markdown、md 或 json');
    }
    const result = this.harness.exportCandidate(id, candidateId, format);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    response.setHeader('Content-Length', String(result.buffer.byteLength));
    response.send(result.buffer);
  }

  private consumeSubmission(principal: SessionPrincipal, projectId: string): void {
    this.rateLimits.consume('agent-harness.submit', `${principal.userId}:${projectId}`, {
      maxAttempts: 8, windowMs: 60_000, message: 'Agent 任务提交过于频繁，请稍后再试',
    });
  }

  private assert(rawRequest: Request, projectId: string, permission: Permission): void {
    const principal = this.principal(rawRequest);
    const project = this.resources.projectRow(projectId);
    if (principal.systemRole !== 'admin'
      && !this.permissions.hasPermission(principal.userId, String(project.workspace_id), permission, projectId)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
