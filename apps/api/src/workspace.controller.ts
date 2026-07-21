import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { AuditService } from './audit.service.js';
import { AuthService } from './auth.service.js';
import { DatabaseService } from './database.service.js';
import {
  CsrfGuard,
  PermissionGuard,
  RequirePermission,
  SessionAuthGuard,
} from './guards.js';
import {
  parseStringArray,
  type AuthenticatedRequest,
  type SessionPrincipal,
  type WorkspaceRole,
} from './models.js';
import { ResourceService } from './resource.service.js';
import { nowIso, optionalString, requireObject, requireString } from './utils.js';

const ROLES: WorkspaceRole[] = ['Owner', 'Admin', 'KnowledgeEditor', 'ContentEditor', 'Viewer'];

@Controller('api/workspaces')
@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)
export class WorkspaceController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() rawRequest: Request) {
    return this.resources.workspacesFor(this.principal(rawRequest));
  }

  @Post()
  create(@Req() rawRequest: Request, @Body() rawBody: unknown) {
    const principal = this.principal(rawRequest);
    if (principal.systemRole !== 'admin') throw new ConflictException('仅系统管理员可创建工作区');
    const body = requireObject(rawBody);
    const name = requireString(body.name, 'name', { max: 100 });
    const ownerId = typeof body.ownerUserId === 'string' ? body.ownerUserId : principal.userId;
    if (!this.database.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(ownerId)) {
      throw new NotFoundException('所有者账号不存在');
    }
    const id = randomUUID();
    const slug = this.resources.uniqueSlug(
      'workspaces',
      typeof body.slug === 'string' ? body.slug : name,
    );
    const now = nowIso();
    this.database.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO workspaces (id, slug, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, slug, name, ownerId, now, now);
      this.database
        .prepare(
          `INSERT INTO workspace_members
             (workspace_id, user_id, role, created_at, updated_at)
           VALUES (?, ?, 'Owner', ?, ?)`,
        )
        .run(id, ownerId, now, now);
    });
    this.audit.record({ workspaceId: id, userId: principal.userId, action: 'workspace.create', entityType: 'workspace', entityId: id });
    return this.resources.mapWorkspace(this.resources.workspaceRow(id));
  }

  @Get(':workspaceId')
  @RequirePermission({ permission: 'project.read', workspaceParam: 'workspaceId' })
  get(@Param('workspaceId') workspaceId: string) {
    return this.resources.mapWorkspace(this.resources.workspaceRow(workspaceId));
  }

  @Patch(':workspaceId')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  update(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() rawBody: unknown,
  ) {
    this.resources.workspaceRow(workspaceId);
    const body = requireObject(rawBody);
    const name = optionalString(body.name, 'name', 100);
    if (!name) throw new ConflictException('没有可更新字段');
    this.database
      .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, nowIso(), workspaceId);
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'workspace.update', entityType: 'workspace', entityId: workspaceId });
    return this.resources.mapWorkspace(this.resources.workspaceRow(workspaceId));
  }

  @Delete(':workspaceId')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  remove(@Req() rawRequest: Request, @Param('workspaceId') workspaceId: string) {
    this.resources.workspaceRow(workspaceId);
    this.database.prepare('UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), workspaceId);
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'workspace.delete', entityType: 'workspace', entityId: workspaceId });
    return { ok: true };
  }

  @Get(':workspaceId/members')
  @RequirePermission({ permission: 'member.manage', workspaceParam: 'workspaceId' })
  members(@Param('workspaceId') workspaceId: string) {
    this.resources.workspaceRow(workspaceId);
    return this.database
      .prepare(
        `SELECT wm.*, u.username FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY wm.created_at`,
      )
      .all(workspaceId)
      .map((row) => this.resources.mapMember(row as Record<string, unknown>));
  }

  @Put(':workspaceId/members/:userId')
  @RequirePermission({ permission: 'member.manage', workspaceParam: 'workspaceId' })
  upsertMember(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() rawBody: unknown,
  ) {
    this.resources.workspaceRow(workspaceId);
    if (!this.database.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(userId)) {
      throw new NotFoundException('用户不存在');
    }
    const body = requireObject(rawBody);
    const role = requireString(body.role, 'role') as WorkspaceRole;
    if (!ROLES.includes(role)) throw new ConflictException('无效的工作区角色');
    const grants = parseStringArray(body.grants);
    const denies = parseStringArray(body.denies);
    const now = nowIso();
    this.database
      .prepare(
        `INSERT INTO workspace_members
           (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET
           role = excluded.role, grants_json = excluded.grants_json,
           denies_json = excluded.denies_json, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, userId, role, JSON.stringify(grants), JSON.stringify(denies), now, now);
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'member.upsert', entityType: 'user', entityId: userId, details: { role, grants, denies } });
    const row = this.database
      .prepare(
        `SELECT wm.*, u.username FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ? AND wm.user_id = ?`,
      )
      .get(workspaceId, userId) as Record<string, unknown>;
    return this.resources.mapMember(row);
  }

  @Delete(':workspaceId/members/:userId')
  @RequirePermission({ permission: 'member.manage', workspaceParam: 'workspaceId' })
  deleteMember(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    const workspace = this.resources.workspaceRow(workspaceId);
    if (workspace.owner_id === userId) throw new ConflictException('不能移除工作区所有者');
    this.database.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'member.delete', entityType: 'user', entityId: userId });
    return { ok: true };
  }

  @Get(':workspaceId/api-keys')
  @RequirePermission({ permission: 'api.read', workspaceParam: 'workspaceId' })
  apiKeys(@Param('workspaceId') workspaceId: string) {
    return this.database
      .prepare(
        `SELECT id, name, key_prefix AS prefix, created_at AS createdAt,
                last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC`,
      )
      .all(workspaceId);
  }

  @Post(':workspaceId/api-keys')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  createApiKey(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Body() rawBody: unknown,
  ) {
    this.resources.workspaceRow(workspaceId);
    const body = requireObject(rawBody);
    const key = this.auth.createApiKey(
      workspaceId,
      requireString(body.name, 'name', { max: 100 }),
      this.principal(rawRequest).userId,
    );
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'api-key.create', entityType: 'api-key', entityId: String(key.id) });
    return key;
  }

  @Delete(':workspaceId/api-keys/:keyId')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  revokeApiKey(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
  ) {
    this.database
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ?')
      .run(nowIso(), keyId, workspaceId);
    this.audit.record({ workspaceId, userId: this.principal(rawRequest).userId, action: 'api-key.revoke', entityType: 'api-key', entityId: keyId });
    return { ok: true };
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
