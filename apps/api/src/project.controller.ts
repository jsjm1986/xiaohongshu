import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
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
import { parseStringArray, type AuthenticatedRequest, type SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { ResearchService } from './research.service.js';
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
    this.resources.workspaceRow(workspaceId);
    if (
      principal.systemRole !== 'admin' &&
      !this.permissions.hasPermission(principal.userId, workspaceId, 'project.write')
    ) {
      throw new ForbiddenException('缺少权限：project.write');
    }

    const name = requireString(body.name, 'name', { max: 120 });
    const slug = this.resources.uniqueSlug(
      'projects',
      typeof body.slug === 'string' ? body.slug : name,
      workspaceId,
    );
    const description = optionalString(body.description, 'description', 2_000) ?? '';
    const profile = this.profileFromBody(body);
    const id = randomUUID();
    const now = nowIso();
    this.database.transaction(() => {
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
    });
    return this.resources.mapProject(this.resources.projectRow(id));
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
    const row = this.resources.projectRow(projectId);
    const body = requireObject(rawBody);
    const name = optionalString(body.name, 'name', 120) ?? String(row.name);
    const description = optionalString(body.description, 'description', 2_000) ?? String(row.description);
    const profile = body.profile !== undefined || this.hasProfileFields(body)
      ? this.profileFromBody(body)
      : JSON.parse(String(row.profile_json));
    const now = nowIso();
    this.database
      .prepare('UPDATE projects SET name = ?, description = ?, profile_json = ?, updated_at = ? WHERE id = ?')
      .run(name, description, JSON.stringify(profile), now, projectId);
    this.audit.record({ workspaceId: String(row.workspace_id), userId: this.principal(rawRequest).userId, action: 'project.update', entityType: 'project', entityId: projectId });
    this.intelligence.markProjectStale(projectId);
    return this.resources.mapProject(this.resources.projectRow(projectId));
  }

  @Delete(':projectId')
  @RequirePermission({ permission: 'project.delete', projectParam: 'projectId' })
  remove(@Req() rawRequest: Request, @Param('projectId') projectId: string) {
    const row = this.resources.projectRow(projectId);
    const now = nowIso();
    this.database.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, projectId);
    this.audit.record({ workspaceId: String(row.workspace_id), userId: this.principal(rawRequest).userId, action: 'project.delete', entityType: 'project', entityId: projectId });
    return { ok: true };
  }

  @Get(':projectId/acl')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
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
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  setAcl(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() rawBody: unknown,
  ) {
    const project = this.resources.projectRow(projectId);
    const body = requireObject(rawBody);
    const grants = parseStringArray(body.grants);
    const denies = parseStringArray(body.denies);
    if (
      !this.database
        .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .get(project.workspace_id as string, userId)
    ) {
      throw new ConflictException('用户不是该工作区成员');
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
    this.audit.record({ workspaceId: String(project.workspace_id), userId: this.principal(rawRequest).userId, action: 'project-acl.upsert', entityType: 'user', entityId: userId, details: { projectId, grants, denies } });
    return { projectId, userId, grants, denies };
  }

  @Delete(':projectId/acl/:userId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  deleteAcl(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
  ) {
    const project = this.resources.projectRow(projectId);
    this.database.prepare('DELETE FROM project_acl WHERE project_id = ? AND user_id = ?').run(projectId, userId);
    this.audit.record({ workspaceId: String(project.workspace_id), userId: this.principal(rawRequest).userId, action: 'project-acl.delete', entityType: 'user', entityId: userId, details: { projectId } });
    return { ok: true };
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

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
