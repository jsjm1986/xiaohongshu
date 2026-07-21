import { Controller, ForbiddenException, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from './audit.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';

@Controller('api/audit')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class AuditController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() request: Request, @Query('workspaceId') requested?: string, @Query('limit') rawLimit?: string) {
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const workspaceId = this.resources.inferWorkspace(principal, requested);
    if (principal.systemRole !== 'admin' && !this.permissions.hasPermission(principal.userId, workspaceId, 'audit.read')) {
      throw new ForbiddenException('缺少权限：audit.read');
    }
    return this.audit.list(workspaceId, Number.parseInt(rawLimit ?? '100', 10), principal.systemRole === 'admin');
  }
}
