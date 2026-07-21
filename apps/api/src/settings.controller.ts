import { Body, Controller, ForbiddenException, Get, Inject, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { SettingsService } from './settings.service.js';
import { requireObject } from './utils.js';

@Controller('api/settings')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class SettingsController {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  get(@Req() request: Request, @Query('workspaceId') requested?: string) {
    const principal = this.principal(request);
    const workspaceId = this.resources.inferWorkspace(principal, requested);
    if (principal.systemRole !== 'admin' && !this.permissions.hasPermission(principal.userId, workspaceId, 'project.read')) {
      throw new ForbiddenException('无权读取该工作区设置');
    }
    return this.settings.publicSettings(workspaceId, principal.userId);
  }

  @Patch()
  update(@Req() request: Request, @Body() rawBody: unknown) {
    const principal = this.principal(request);
    const body = requireObject(rawBody);
    const workspaceId = this.resources.inferWorkspace(principal, body.workspaceId);
    this.assert(principal, workspaceId, 'provider.manage');
    if (typeof body.monthlyQuota === 'number') this.assert(principal, workspaceId, 'quota.manage');
    return this.settings.update(workspaceId, body, principal);
  }

  private assert(principal: SessionPrincipal, workspaceId: string, permission: 'provider.manage' | 'quota.manage'): void {
    if (principal.systemRole !== 'admin' && !this.permissions.hasPermission(principal.userId, workspaceId, permission)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
