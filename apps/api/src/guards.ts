import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { DatabaseService } from './database.service.js';
import {
  parseStringArray,
  ROLE_PERMISSIONS,
  type AuthenticatedRequest,
  type Permission,
  type SessionPrincipal,
  type WorkspaceRole,
} from './models.js';
import { parseJson } from './utils.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>() as unknown as AuthenticatedRequest;
    request.principal = this.auth.authenticateSession(request.cookies?.ca_session);
    return true;
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>() as unknown as AuthenticatedRequest;
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const principal = request.principal as SessionPrincipal;
    const header = request.headers['x-csrf-token'];
    this.auth.validateCsrf(principal, Array.isArray(header) ? header[0] : header);
    if (
      principal.mustChangePassword &&
      !request.url.startsWith('/api/auth/change-password') &&
      !request.url.startsWith('/api/auth/logout')
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: '首次登录后必须修改密码',
      });
    }
    return true;
  }
}

@Injectable()
export class ReadOnlyAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>() as unknown as AuthenticatedRequest;
    const authorization = request.headers.authorization;
    const auth = Array.isArray(authorization) ? authorization[0] : authorization;
    if (auth?.startsWith('Bearer ')) {
      request.principal = this.auth.authenticateApiKey(auth.slice(7));
      if (!request.principal.permissions.includes('api.read')) {
        throw new ForbiddenException('API Key 缺少 api.read 权限');
      }
    } else {
      request.principal = this.auth.authenticateSession(request.cookies?.ca_session);
    }
    return true;
  }
}

export interface PermissionRequirement {
  permission: Permission;
  workspaceParam?: string;
  workspaceBody?: string;
  workspaceQuery?: string;
  projectParam?: string;
  projectBody?: string;
  projectQuery?: string;
}

export const REQUIRE_PERMISSION = 'content-agent:permission';
export const RequirePermission = (requirement: PermissionRequirement) =>
  SetMetadata(REQUIRE_PERMISSION, requirement);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRE_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!requirement) return true;

    const request = context.switchToHttp().getRequest<Request>() as unknown as AuthenticatedRequest;
    const principal = request.principal;
    if (principal.kind !== 'session') throw new UnauthorizedException();
    if (principal.systemRole === 'admin') return true;

    const body = request.body && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};
    let projectId =
      (requirement.projectParam && request.params[requirement.projectParam]) ||
      (requirement.projectBody && String(body[requirement.projectBody] ?? '')) ||
      (requirement.projectQuery && String(request.query[requirement.projectQuery] ?? '')) ||
      undefined;
    let workspaceId =
      (requirement.workspaceParam && request.params[requirement.workspaceParam]) ||
      (requirement.workspaceBody && String(body[requirement.workspaceBody] ?? '')) ||
      (requirement.workspaceQuery && String(request.query[requirement.workspaceQuery] ?? '')) ||
      undefined;

    if (projectId && !workspaceId) {
      const project = this.database
        .prepare('SELECT workspace_id FROM projects WHERE id = ? AND deleted_at IS NULL')
        .get(projectId) as { workspace_id: string } | undefined;
      workspaceId = project?.workspace_id;
    }
    if (!workspaceId) throw new ForbiddenException('无法确定权限作用域');
    if (!this.hasPermission(principal.userId, workspaceId, requirement.permission, projectId)) {
      throw new ForbiddenException(`缺少权限：${requirement.permission}`);
    }
    return true;
  }

  hasPermission(userId: string, workspaceId: string, permission: Permission, projectId?: string): boolean {
    const membership = this.database
      .prepare(
        `SELECT role, grants_json, denies_json FROM workspace_members
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, userId) as
      | { role: WorkspaceRole; grants_json: string; denies_json: string }
      | undefined;
    if (!membership) return false;

    const grants = new Set<Permission>([
      ...ROLE_PERMISSIONS[membership.role],
      ...parseStringArray(parseJson(membership.grants_json, [])),
    ]);
    const denies = new Set<Permission>(parseStringArray(parseJson(membership.denies_json, [])));
    if (projectId) {
      const acl = this.database
        .prepare('SELECT grants_json, denies_json FROM project_acl WHERE project_id = ? AND user_id = ?')
        .get(projectId, userId) as { grants_json: string; denies_json: string } | undefined;
      if (acl) {
        for (const item of parseStringArray(parseJson(acl.grants_json, []))) grants.add(item);
        for (const item of parseStringArray(parseJson(acl.denies_json, []))) denies.add(item);
      }
    }
    return grants.has(permission) && !denies.has(permission);
  }
}
