import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
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
    const items = this.generations.list(projectId).filter((job) => {
      if (projectId) return true;
      try { this.assert(request, String(job.projectId), 'project.read'); return true; } catch { return false; }
    });
    return { items, total: items.length };
  }

  @Get(':id')
  get(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'project.read');
    return this.generations.get(id, this.principal(request).userId);
  }

  /**
   * 传统生成的安全执行轨迹。只返回服务端白名单投影后的阶段、耗时、
   * Token、重试与校验/修复元数据，不返回 Prompt、正文或模型原始响应。
   */
  @Get(':id/trace')
  trace(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'project.read');
    return this.generations.trace(id);
  }

  /**
   * 阅读投影。极简创作「查看」走这条,完整版工作台继续走 :id。
   * 权限与 :id 完全一致(project.read),只是返回的字段集不同。
   */
  @Get(':id/reader')
  reader(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'project.read');
    return this.generations.readerView(id, this.principal(request).userId);
  }

  @Post()
  create(@Req() request: Request, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    if (typeof body.projectId !== 'string') throw new BadRequestException('projectId 不能为空');
    this.assert(request, body.projectId, 'generation.run');
    return this.generations.create(body, this.principal(request));
  }

  /**
   * 软删一条产出。
   *
   * 权限用 generation.edit(ContentEditor 就有),而不是 project.delete——删的是自己
   * 的一篇产出,不是整个项目;要求项目级删除权会把普通创作者挡在外面。
   */
  @Delete(':id')
  remove(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'generation.edit');
    return this.generations.softDelete(id);
  }

  /** 撤销软删(「删错了」的退路)。 */
  @Post(':id/restore')
  restore(@Req() request: Request, @Param('id') id: string) {
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'generation.edit');
    return this.generations.restore(id);
  }

  @Post(':id/candidates/:candidateId/manual-delivery-confirmation')
  confirmManualDelivery(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
    @Body() rawBody: unknown,
  ) {
    const body = requireObject(rawBody);
    if (body.acknowledged !== true) throw new BadRequestException('必须明确确认已逐条核对事实、证据、身份与风险');
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'generation.export');
    return this.generations.confirmManualDelivery(id, candidateId, this.principal(request));
  }

  /**
   * 受理一次修改请求。入队即返回,不同步等模型——改稿耗时是分钟级,公网下会撞上
   * Cloudflare 约 100 秒超时。执行由 RevisionService 的队列负责。
   */
  @Post(':id/revise')
  revise(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    const body = requireObject(rawBody);
    const job = this.generations.jobRow(id);
    this.assert(request, job.project_id, 'generation.chat');
    if (typeof body.candidateId !== 'string' || typeof body.instruction !== 'string') throw new BadRequestException('candidateId 和 instruction 不能为空');
    return this.generations.enqueueRevision(id, body.candidateId, body.instruction, this.principal(request));
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
