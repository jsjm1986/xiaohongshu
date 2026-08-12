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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { FormulaService } from './formula.service.js';
import { IntelligenceService } from './intelligence.service.js';
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
} from './models.js';
import { ResourceService } from './resource.service.js';
import { ResearchService } from './research.service.js';
import { SettingsService } from './settings.service.js';
import { nowIso, optionalString, requireObject, requireString } from './utils.js';

@Controller('api/projects')
@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)
export class ProjectController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(ResearchService) private readonly research: ResearchService,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  @Get()
  list(@Req() rawRequest: Request, @Query('workspaceId') workspaceId?: string) {
    return this.resources.projectsFor(this.principal(rawRequest), workspaceId);
  }

  @Post()
  create(@Req() rawRequest: Request, @Body() rawBody: unknown) {
    const principal = this.principal(rawRequest);
    const body = requireObject(rawBody);
    const workspaceId = this.resources.inferWorkspace(principal, body.workspaceId);
    const name = requireString(body.name, 'name', { max: 120 });
    const requestedSlug = typeof body.slug === 'string' ? body.slug : name;
    const description = optionalString(body.description, 'description', 2_000) ?? '';
    const profile = this.profileFromBody(body);
    const id = randomUUID();
    const now = nowIso();
    return this.database.transaction(() => {
      this.resources.workspaceRow(workspaceId);
      this.assertCurrentPermission(principal, workspaceId, 'project.write');
      const slug = this.resources.uniqueSlug('projects', requestedSlug, workspaceId);
      this.database
        .prepare(
          `INSERT INTO projects
             (id, workspace_id, slug, name, description, profile_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, workspaceId, slug, name, description, JSON.stringify(profile), principal.userId, now, now);
      this.formulas.ensureDefault(id, principal);
      this.research.bootstrapProject(id, principal.userId);
      this.audit.record({ workspaceId, userId: principal.userId, action: 'project.create', entityType: 'project', entityId: id });
      return this.resources.mapProject(this.resources.projectRow(id));
    });
  }

  @Get(':projectId')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  get(@Param('projectId') projectId: string) {
    return this.resources.mapProject(this.resources.projectRow(projectId));
  }

  @Patch(':projectId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  update(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Body() rawBody: unknown,
  ) {
    const body = requireObject(rawBody);
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      const row = this.resources.projectRow(projectId);
      this.assertCurrentPermission(
        principal,
        String(row.workspace_id),
        'project.write',
        projectId,
      );
      const name = optionalString(body.name, 'name', 120) ?? String(row.name);
      const description = optionalString(body.description, 'description', 2_000) ?? String(row.description);
      const storedProfile = JSON.parse(String(row.profile_json)) as Record<string, unknown>;
      const profile = body.profile !== undefined
        ? this.profileFromBody(body)
        : this.hasProfileFields(body)
          ? { ...storedProfile, ...this.profileFromBody(body) }
          : storedProfile;
      const updated = this.database
        .prepare(
          `UPDATE projects SET name = ?, description = ?, profile_json = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(name, description, JSON.stringify(profile), nowIso(), projectId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('项目不存在');
      this.intelligence.markProjectStale(projectId);
      this.audit.record({
        workspaceId: String(row.workspace_id),
        userId: principal.userId,
        action: 'project.update',
        entityType: 'project',
        entityId: projectId,
      });
      return this.resources.mapProject(this.resources.projectRow(projectId));
    });
  }

  @Delete(':projectId')
  @RequirePermission({ permission: 'project.delete', projectParam: 'projectId' })
  remove(@Req() rawRequest: Request, @Param('projectId') projectId: string) {
    const now = nowIso();
    const principal = this.principal(rawRequest);
    this.database.transaction(() => {
      const row = this.resources.projectRow(projectId);
      const workspaceId = String(row.workspace_id);
      this.assertCurrentPermission(principal, workspaceId, 'project.delete', projectId);
      const activeRevisionQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(r.quota_consumed_count), 0) AS value
             FROM revision_tasks r
             JOIN generation_jobs j ON j.id = r.job_id
            WHERE j.project_id = ? AND r.status IN ('queued', 'running')`,
        )
        .get(projectId) as { value: number };
      const activeAnalysisQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(quota_consumed_count), 0) AS value
             FROM analysis_tasks
            WHERE project_id = ? AND status IN ('queued', 'running')`,
        )
        .get(projectId) as { value: number };
      // 排队/在跑的生成任务被删除终止 = 零产出,入队扣款一并退还(与改稿/分析同权)。
      const activeGenerationQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(quota_consumed_count), 0) AS value
             FROM generation_jobs
            WHERE project_id = ? AND status IN ('queued', 'running') AND deleted_at IS NULL`,
        )
        .get(projectId) as { value: number };
      // Harness 沿用它自己的可退语义:provider 已启动的运行成本已经发生,不退。
      const activeHarnessQuota = this.database
        .prepare(
          `SELECT COALESCE(SUM(quota_consumed_count), 0) AS value
             FROM agent_harness_jobs
            WHERE project_id = ? AND status IN ('queued', 'running')
              AND provider_started_at IS NULL AND deleted_at IS NULL`,
        )
        .get(projectId) as { value: number };
      const quotaRefund = Number(activeRevisionQuota.value) + Number(activeAnalysisQuota.value)
        + Number(activeGenerationQuota.value) + Number(activeHarnessQuota.value);
      if (quotaRefund > 0) {
        this.settings.refundPlatformQuota(workspaceId, quotaRefund, {
          reason: 'project_delete_refund', entityType: 'project', entityId: projectId,
        });
      }

      const stoppedMessage = '项目已删除，任务已停止';
      this.database
        .prepare(
          `UPDATE revision_tasks
              SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running')
              AND job_id IN (SELECT id FROM generation_jobs WHERE project_id = ?)`,
        )
        .run(stoppedMessage, now, now, projectId);
      this.database
        .prepare(
          `UPDATE generation_jobs
              SET status='failed', progress=100, error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running') AND project_id = ?`,
        )
        .run(stoppedMessage, now, now, projectId);
      this.database
        .prepare(
          `UPDATE analysis_tasks
              SET status='failed', error=?, completed_at=?, updated_at=?,
                  claimed_by=NULL, heartbeat_at=NULL, quota_consumed_count=0
            WHERE status IN ('queued', 'running') AND project_id = ?`,
        )
        .run(stoppedMessage, now, now, projectId);
      // 此前删除项目对 harness 只靠 ON DELETE CASCADE(物理删才生效),软删后
      // 排队/在跑的 harness 任务无人终止:占队列名额、被回收循环反复重试,额度
      // 也永久挂账。这里与其余任务同一事务结清。
      this.database
        .prepare(
          `UPDATE agent_harness_jobs
              SET status='failed', error=?, failure_stage='cancelled', completed_at=?, updated_at=?,
                  claimed_by=NULL, claimed_at=NULL, heartbeat_at=NULL, quota_consumed_count=0,
                  cancelled_at=?, cancelled_by=?
            WHERE status IN ('queued', 'running') AND project_id = ? AND deleted_at IS NULL`,
        )
        .run(stoppedMessage, now, now, now, principal.userId, projectId);
      const removed = this.database
        .prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(now, now, projectId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('项目不存在');
      this.audit.record({
        workspaceId,
        userId: principal.userId,
        action: 'project.delete',
        entityType: 'project',
        entityId: projectId,
      });
    });
    return { ok: true };
  }

  @Get(':projectId/acl')
  @RequirePermission({ permission: 'member.manage', projectParam: 'projectId' })
  listAcl(@Param('projectId') projectId: string) {
    this.resources.projectRow(projectId);
    return this.database
      .prepare(
        `SELECT a.project_id, a.user_id, u.username, a.grants_json, a.denies_json, a.updated_at
         FROM project_acl a JOIN users u ON u.id = a.user_id
         WHERE a.project_id = ? ORDER BY u.username`,
      )
      .all(projectId)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          projectId: value.project_id,
          userId: value.user_id,
          username: value.username,
          grants: JSON.parse(String(value.grants_json)),
          denies: JSON.parse(String(value.denies_json)),
          updatedAt: value.updated_at,
        };
      });
  }

  @Put(':projectId/acl/:userId')
  @RequirePermission({ permission: 'member.manage', projectParam: 'projectId' })
  setAcl(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() rawBody: unknown,
  ) {
    const body = requireObject(rawBody);
    const grants = parseStringArray(body.grants);
    const denies = parseStringArray(body.denies);
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      const project = this.resources.projectRow(projectId);
      const workspaceId = String(project.workspace_id);
      this.assertCurrentPermission(principal, workspaceId, 'member.manage', projectId);
      if (
        this.database
          .prepare('SELECT 1 FROM workspaces WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
          .get(workspaceId, userId)
      ) {
        throw new ConflictException('工作区所有者不能设置项目权限覆盖');
      }
      if (
        !this.database
          .prepare(
            `SELECT 1 FROM workspace_members wm
             JOIN users u ON u.id = wm.user_id
             WHERE wm.workspace_id = ? AND wm.user_id = ? AND u.disabled_at IS NULL`,
          )
          .get(workspaceId, userId)
      ) {
        throw new ConflictException('用户不是该工作区的有效成员');
      }
      this.database
        .prepare(
          `INSERT INTO project_acl (project_id, user_id, grants_json, denies_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, user_id) DO UPDATE SET
             grants_json = excluded.grants_json,
             denies_json = excluded.denies_json,
             updated_at = excluded.updated_at`,
        )
        .run(projectId, userId, JSON.stringify(grants), JSON.stringify(denies), nowIso());
      this.audit.record({
        workspaceId,
        userId: principal.userId,
        action: 'project-acl.upsert',
        entityType: 'user',
        entityId: userId,
        details: { projectId, grants, denies },
      });
      return { projectId, userId, grants, denies };
    });
  }

  @Delete(':projectId/acl/:userId')
  @RequirePermission({ permission: 'member.manage', projectParam: 'projectId' })
  deleteAcl(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const principal = this.principal(rawRequest);
    return this.database.transaction(() => {
      const project = this.resources.projectRow(projectId);
      this.assertCurrentPermission(
        principal,
        String(project.workspace_id),
        'member.manage',
        projectId,
      );
      const removed = this.database
        .prepare('DELETE FROM project_acl WHERE project_id = ? AND user_id = ?')
        .run(projectId, userId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('项目权限覆盖不存在');
      this.audit.record({
        workspaceId: String(project.workspace_id),
        userId: principal.userId,
        action: 'project-acl.delete',
        entityType: 'user',
        entityId: userId,
        details: { projectId },
      });
      return { ok: true };
    });
  }

  private profileFromBody(body: Record<string, unknown>): Record<string, unknown> {
    if (body.profile !== undefined) {
      if (!body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) {
        throw new ConflictException('profile 必须是对象');
      }
      return body.profile as Record<string, unknown>;
    }
    const profile: Record<string, unknown> = {};
    for (const key of ['domain', 'productPoints', 'organizationPoints', 'cities', 'doctors']) {
      if (body[key] !== undefined) profile[key] = body[key];
    }
    return profile;
  }

  private hasProfileFields(body: Record<string, unknown>): boolean {
    return ['domain', 'productPoints', 'organizationPoints', 'cities', 'doctors'].some(
      (key) => body[key] !== undefined,
    );
  }

  private assertCurrentPermission(
    principal: SessionPrincipal,
    workspaceId: string,
    permission: Permission,
    projectId?: string,
  ): void {
    if (principal.systemRole === 'admin') return;
    if (!this.permissions.hasPermission(principal.userId, workspaceId, permission, projectId)) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
