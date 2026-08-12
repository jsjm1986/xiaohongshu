import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
  type Permission,
  type SessionPrincipal,
  type WorkspaceRole,
} from './models.js';
import { ResourceService } from './resource.service.js';
import { SettingsService } from './settings.service.js';
import { nowIso, optionalString, requireObject, requireString } from './utils.js';

const ROLES: WorkspaceRole[] = ['Owner', 'Admin', 'KnowledgeEditor', 'ContentEditor', 'Viewer'];

@Controller('api/workspaces')
@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)
export class WorkspaceController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
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
    const id = randomUUID();
    const requestedSlug = typeof body.slug === 'string' ? body.slug : name;
    const now = nowIso();
    return this.database.transaction(() => {
      if (!this.database.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(ownerId)) {
        throw new NotFoundException('所有者账号不存在');
      }
      const slug = this.resources.uniqueSlug('workspaces', requestedSlug);
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
      this.audit.record({ workspaceId: id, userId: principal.userId, action: 'workspace.create', entityType: 'workspace', entityId: id });
      return this.resources.mapWorkspace(this.resources.workspaceRow(id));
    });
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
    const body = requireObject(rawBody);
    const name = optionalString(body.name, 'name', 100);
    if (!name) throw new ConflictException('没有可更新字段');
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'workspace.manage');
      const updated = this.database
        .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(name, nowIso(), workspaceId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('工作区不存在');
      this.audit.record({ workspaceId, userId: principal.userId, action: 'workspace.update', entityType: 'workspace', entityId: workspaceId });
      return this.resources.mapWorkspace(this.resources.workspaceRow(workspaceId));
    });
  }

  @Delete(':workspaceId')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  remove(@Req() rawRequest: Request, @Param('workspaceId') workspaceId: string) {
    const now = nowIso();
    const principal = this.principal(rawRequest);
    this.database.transaction(() => {
      this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'workspace.manage');
      const activeRevisionQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(r.quota_consumed_count), 0) AS value
             FROM revision_tasks r
             JOIN generation_jobs j ON j.id = r.job_id
             JOIN projects p ON p.id = j.project_id
            WHERE p.workspace_id = ? AND r.status IN ('queued', 'running')`,
        )
        .get(workspaceId) as { value: number };
      const revisionRefund = Number(activeRevisionQuota.value);
      if (revisionRefund > 0) this.settings.refundPlatformQuota(workspaceId, revisionRefund);
      const activeAnalysisQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(t.quota_consumed_count), 0) AS value
             FROM analysis_tasks t
             JOIN projects p ON p.id = t.project_id
            WHERE p.workspace_id = ? AND t.status IN ('queued', 'running')
              AND t.deleted_at IS NULL`,
        )
        .get(workspaceId) as { value: number };
      const analysisRefund = Number(activeAnalysisQuota.value);
      if (analysisRefund > 0) this.settings.refundPlatformQuota(workspaceId, analysisRefund);
      // 排队/在跑的生成任务被删除终止 = 零产出,入队扣款退还;工作区可恢复,
      // 账目必须在删除时刻就是对的。
      const activeGenerationQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(j.quota_consumed_count), 0) AS value
             FROM generation_jobs j
             JOIN projects p ON p.id = j.project_id
            WHERE p.workspace_id = ? AND j.status IN ('queued', 'running')
              AND j.deleted_at IS NULL`,
        )
        .get(workspaceId) as { value: number };
      const generationRefund = Number(activeGenerationQuota.value);
      if (generationRefund > 0) this.settings.refundPlatformQuota(workspaceId, generationRefund);
      // Harness 沿用它自己的可退语义:provider 已启动的运行成本已经发生,不退。
      const activeHarnessQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(h.quota_consumed_count), 0) AS value
             FROM agent_harness_jobs h
             JOIN projects p ON p.id = h.project_id
            WHERE p.workspace_id = ? AND h.status IN ('queued', 'running')
              AND h.provider_started_at IS NULL AND h.deleted_at IS NULL`,
        )
        .get(workspaceId) as { value: number };
      const harnessRefund = Number(activeHarnessQuota.value);
      if (harnessRefund > 0) this.settings.refundPlatformQuota(workspaceId, harnessRefund);

      const stoppedMessage = '工作区已删除，任务已停止';
      this.database
        .prepare(
          `UPDATE revision_tasks
              SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running')
              AND job_id IN (
                SELECT j.id FROM generation_jobs j
                JOIN projects p ON p.id = j.project_id
                WHERE p.workspace_id = ?
              )`,
        )
        .run(stoppedMessage, now, now, workspaceId);
      this.database
        .prepare(
          `UPDATE generation_jobs
              SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running')
              AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`,
        )
        .run(stoppedMessage, now, now, workspaceId);
      this.database
        .prepare(
          `UPDATE analysis_tasks
              SET status='failed', error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running')
              AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`,
        )
        .run(stoppedMessage, now, now, workspaceId);
      // 与项目删除同理:软删工作区后 harness 任务不再有 CASCADE 兜底,必须显式结清,
      // 否则排队/在跑的运行占着队列名额、额度永久挂账。
      this.database
        .prepare(
          `UPDATE agent_harness_jobs
              SET status='failed', error=?, failure_stage='cancelled', completed_at=?, updated_at=?,
                  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, quota_consumed_count=0,
                  cancelled_at=?, cancelled_by=?
            WHERE status IN ('queued', 'running') AND deleted_at IS NULL
              AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`,
        )
        .run(stoppedMessage, now, now, now, principal.userId, workspaceId);
      const removed = this.database
        .prepare('UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(now, now, workspaceId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('工作区不存在');
      this.database
        .prepare('UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL')
        .run(now, workspaceId);
      this.audit.record({ workspaceId, userId: principal.userId, action: 'workspace.delete', entityType: 'workspace', entityId: workspaceId });
    });
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
    const body = requireObject(rawBody);
    const role = requireString(body.role, 'role') as WorkspaceRole;
    if (!ROLES.includes(role)) throw new ConflictException('无效的工作区角色');
    const grants = parseStringArray(body.grants);
    const denies = parseStringArray(body.denies);
    const now = nowIso();
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      const workspace = this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'member.manage');
      if (!this.database.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL').get(userId)) {
        throw new NotFoundException('用户不存在');
      }
      const ownerId = String(workspace.owner_id);
      if (userId === ownerId && role !== 'Owner') {
        throw new ConflictException('不能降级工作区所有者；所有权转移必须使用专用流程');
      }
      if (userId !== ownerId && role === 'Owner') {
        throw new ConflictException('不能通过成员角色隐式转移工作区所有权');
      }
      if (userId === ownerId && (grants.length > 0 || denies.length > 0)) {
        throw new ConflictException('工作区所有者不能设置权限覆盖');
      }
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
      this.audit.record({ workspaceId, userId: principal.userId, action: 'member.upsert', entityType: 'user', entityId: userId, details: { role, grants, denies } });
      const row = this.database
        .prepare(
          `SELECT wm.*, u.username FROM workspace_members wm JOIN users u ON u.id = wm.user_id
           WHERE wm.workspace_id = ? AND wm.user_id = ?`,
        )
        .get(workspaceId, userId) as Record<string, unknown>;
      return this.resources.mapMember(row);
    });
  }

  @Delete(':workspaceId/members/:userId')
  @RequirePermission({ permission: 'member.manage', workspaceParam: 'workspaceId' })
  deleteMember(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      const workspace = this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'member.manage');
      if (String(workspace.owner_id) === userId) throw new ConflictException('不能移除工作区所有者');
      const removed = this.database
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(workspaceId, userId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('工作区成员不存在');
      this.database
        .prepare(
          `DELETE FROM project_acl
           WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?)`,
        )
        .run(userId, workspaceId);
      this.audit.record({ workspaceId, userId: principal.userId, action: 'member.delete', entityType: 'user', entityId: userId });
      return { ok: true };
    });
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
    const body = requireObject(rawBody);
    const name = requireString(body.name, 'name', { max: 100 });
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'workspace.manage');
      const key = this.auth.createApiKey(workspaceId, name, principal.userId);
      this.audit.record({ workspaceId, userId: principal.userId, action: 'api-key.create', entityType: 'api-key', entityId: String(key.id) });
      return key;
    });
  }

  @Delete(':workspaceId/api-keys/:keyId')
  @RequirePermission({ permission: 'workspace.manage', workspaceParam: 'workspaceId' })
  revokeApiKey(
    @Req() rawRequest: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('keyId') keyId: string,
  ) {
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'workspace.manage');
      const revoked = this.database
        .prepare(
          `UPDATE api_keys SET revoked_at = ?
           WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL`,
        )
        .run(nowIso(), keyId, workspaceId);
      if (Number(revoked.changes) !== 1) throw new NotFoundException('有效 API Key 不存在');
      this.audit.record({ workspaceId, userId: principal.userId, action: 'api-key.revoke', entityType: 'api-key', entityId: keyId });
      return { ok: true };
    });
  }

  private assertCurrentPermission(
    principal: SessionPrincipal,
    workspaceId: string,
    permission: Permission,
  ): void {
    if (principal.systemRole === 'admin') return;
    if (!this.permissions.hasPermission(principal.userId, workspaceId, permission)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
