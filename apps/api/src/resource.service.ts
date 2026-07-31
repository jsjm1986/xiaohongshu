import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { PermissionGuard } from './guards.js';
import type { Permission, SessionPrincipal, WorkspaceRole } from './models.js';
import { nowIso, parseJson, slugify } from './utils.js';

@Injectable()
export class ResourceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  workspacesFor(principal: SessionPrincipal): Record<string, unknown>[] {
    const rows = principal.systemRole === 'admin'
      ? this.database
          .prepare(
            `SELECT w.*, wm.role FROM workspaces w
             LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ?
             WHERE w.deleted_at IS NULL ORDER BY w.created_at`,
          )
          .all(principal.userId)
      : this.database
          .prepare(
            `SELECT w.*, wm.role FROM workspaces w
             JOIN workspace_members wm ON wm.workspace_id = w.id
             WHERE wm.user_id = ? AND w.deleted_at IS NULL ORDER BY w.created_at`,
          )
          .all(principal.userId);
    return rows.map((row) => this.mapWorkspace(row as Record<string, unknown>));
  }

  projectsFor(principal: SessionPrincipal, workspaceId?: string): Record<string, unknown>[] {
    const params: (string | number)[] = [];
    const conditions = ['p.deleted_at IS NULL', 'w.deleted_at IS NULL'];
    if (workspaceId) {
      conditions.push('p.workspace_id = ?');
      params.push(workspaceId);
    }
    if (principal.systemRole !== 'admin') {
      conditions.push('wm.user_id = ?');
      params.push(principal.userId);
    }
    const rows = this.database
      .prepare(
        `SELECT p.*, w.name AS workspace_name,
                (SELECT COUNT(*) FROM knowledge_files k WHERE k.project_id = p.id AND k.deleted_at IS NULL) AS knowledge_count,
                (SELECT COUNT(*) FROM generation_jobs g WHERE g.project_id = p.id AND g.deleted_at IS NULL) AS generation_count,
                (SELECT version FROM formula_versions f WHERE f.project_id = p.id AND f.status = 'active' ORDER BY version DESC LIMIT 1) AS active_formula_version
         FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
         WHERE ${conditions.join(' AND ')}
         GROUP BY p.id ORDER BY p.updated_at DESC`,
      )
      .all(...params);
    return rows
      .filter((row) =>
        principal.systemRole === 'admin' ||
        this.permissions.hasPermission(
          principal.userId,
          String((row as Record<string, unknown>).workspace_id),
          'project.read',
          String((row as Record<string, unknown>).id),
        ),
      )
      .map((row) => this.mapProject(row as Record<string, unknown>));
  }

  inferWorkspace(principal: SessionPrincipal, requested: unknown): string {
    if (typeof requested === 'string' && requested) {
      return String(this.workspaceRow(requested).id);
    }
    const workspaces = this.workspacesFor(principal);
    if (workspaces.length !== 1) throw new ConflictException('请明确指定 workspaceId');
    return String(workspaces[0]?.id);
  }

  projectRow(projectId: string): Record<string, unknown> {
    const row = this.database
      .prepare(
        `SELECT p.* FROM projects p
         JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.id = ? AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
      )
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('项目不存在');
    return row;
  }

  workspaceRow(workspaceId: string): Record<string, unknown> {
    const row = this.database
      .prepare('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL')
      .get(workspaceId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('工作区不存在');
    return row;
  }

  uniqueSlug(table: 'workspaces' | 'projects', base: string, workspaceId?: string): string {
    let candidate = slugify(base);
    let suffix = 2;
    while (true) {
      const existing = table === 'workspaces'
        ? this.database.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(candidate)
        : this.database
            .prepare('SELECT 1 FROM projects WHERE workspace_id = ? AND slug = ?')
            .get(workspaceId ?? '', candidate);
      if (!existing) return candidate;
      candidate = `${slugify(base).slice(0, 56)}-${suffix++}`;
    }
  }

  mapWorkspace(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      ownerId: row.owner_id,
      role: row.role ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapProject(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      slug: row.slug,
      name: row.name,
      description: row.description,
      profile: parseJson(row.profile_json, {}),
      styleProfile: parseJson(row.style_profile_json, {}),
      styleProfileVersion: Number(row.style_profile_version ?? 1),
      styleProfileUpdatedAt: row.style_profile_updated_at ?? null,
      knowledgeCount: Number(row.knowledge_count ?? 0),
      generationCount: Number(row.generation_count ?? 0),
      activeFormulaVersion: row.active_formula_version ? `${row.active_formula_version}.0.0` : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  mapMember(row: Record<string, unknown>): Record<string, unknown> {
    return {
      userId: row.user_id,
      username: row.username,
      role: row.role as WorkspaceRole,
      grants: parseJson<Permission[]>(row.grants_json, []),
      denies: parseJson<Permission[]>(row.denies_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
