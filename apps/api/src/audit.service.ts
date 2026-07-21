import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { nowIso } from './utils.js';

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  record(input: {
    workspaceId?: string;
    userId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    details?: Record<string, unknown>;
  }): void {
    this.database
      .prepare(
        `INSERT INTO audit_logs
           (workspace_id, user_id, action, entity_type, entity_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.workspaceId ?? null,
        input.userId ?? null,
        input.action,
        input.entityType,
        input.entityId ?? null,
        JSON.stringify(input.details ?? {}),
        nowIso(),
      );
  }

  list(workspaceId: string, limit = 100, includeSystem = false): Record<string, unknown>[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.database
      .prepare(
        `SELECT a.id, a.workspace_id, a.user_id, u.username, a.action,
                a.entity_type, a.entity_id, a.details_json, a.created_at
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.workspace_id = ? OR (? = 1 AND a.workspace_id IS NULL)
         ORDER BY a.id DESC LIMIT ?`,
      )
      .all(workspaceId, includeSystem ? 1 : 0, safeLimit)
      .map((row) => {
        const value = row as Record<string, unknown>;
        return {
          id: value.id,
          workspaceId: value.workspace_id,
          userId: value.user_id,
          username: value.username,
          action: value.action,
          entityType: value.entity_type,
          entityId: value.entity_id,
          details: JSON.parse(String(value.details_json ?? '{}')),
          createdAt: value.created_at,
        };
      });
  }
}
