import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { CsrfGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { requireObject } from './utils.js';

@Controller('api/admin')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class AdminController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('users')
  users(@Req() request: Request) {
    this.requireSystemAdmin(request);
    return this.database
      .prepare(
        `SELECT id, username, system_role AS systemRole,
                must_change_password AS mustChangePassword,
                created_at AS createdAt, disabled_at AS disabledAt
         FROM users ORDER BY created_at`,
      )
      .all()
      .map((row) => ({
        ...(row as Record<string, unknown>),
        mustChangePassword: Boolean((row as Record<string, unknown>).mustChangePassword),
      }));
  }

  @Post('users')
  async createUser(@Req() request: Request, @Body() rawBody: unknown) {
    this.requireSystemAdmin(request);
    const body = requireObject(rawBody);
    const result = await this.auth.createUser({
      username: body.username,
      password: body.password,
      systemRole: body.systemRole,
    });
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    this.audit.record({ userId: principal.userId, action: 'user.create', entityType: 'user', entityId: String(result.id), details: { username: result.username, systemRole: result.systemRole } });
    return result;
  }

  private requireSystemAdmin(rawRequest: Request): void {
    const request = rawRequest as unknown as AuthenticatedRequest;
    if ((request.principal as SessionPrincipal).systemRole !== 'admin') {
      throw new ForbiddenException('仅系统管理员可执行此操作');
    }
  }
}
