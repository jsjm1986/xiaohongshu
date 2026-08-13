import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { CsrfGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { RegistrationService } from './registration.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { parseJson, requireObject } from './utils.js';

@Controller('api/admin')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class AdminController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RegistrationService) private readonly registration: RegistrationService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
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
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const result = await this.auth.createUser({
      username: body.username,
      password: body.password,
      systemRole: body.systemRole,
      userKind: body.userKind,
    }, (created) => {
      this.audit.record({
        userId: principal.userId,
        action: 'user.create',
        entityType: 'user',
        entityId: String(created.id),
        details: { username: created.username, systemRole: created.systemRole },
      });
    });
    return result;
  }

  /**
   * 生成一次性密码重置链接(无邮件通道的忘记密码方案)。
   * admin 把链接通过既有沟通渠道(微信/电话核身后)发给用户,24 小时有效、
   * 用一次即废;同用户再生成会作废旧链接。明文 token 只在本响应出现一次。
   */
  @Post('users/:userId/reset-link')
  createResetLink(@Req() request: Request, @Param('userId') userId: string) {
    this.requireSystemAdmin(request);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const { token, expiresAt } = this.auth.createPasswordResetToken(userId, principal.userId);
    this.audit.record({
      userId: principal.userId, action: 'user.reset-link', entityType: 'user', entityId: userId,
      details: { expiresAt },
    });
    // 相对路径由前端拼 window.origin:服务端不知道外部访问域名。
    return { resetPath: `/reset-password?token=${token}`, expiresAt };
  }

  @Get('registrations')
  registrations(@Req() request: Request, @Query('status') status?: string) {
    this.requireSystemAdmin(request);
    return this.registration.list(status || 'pending');
  }

  @Post('registrations/:id/approve')
  approveRegistration(@Req() request: Request, @Param('id') id: string) {
    this.requireSystemAdmin(request);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    return this.registration.approve(id, principal.userId);
  }

  @Post('registrations/:id/reject')
  rejectRegistration(@Req() request: Request, @Param('id') id: string, @Body() rawBody: unknown) {
    this.requireSystemAdmin(request);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const body = requireObject(rawBody);
    const reason = typeof body.reason === 'string' ? body.reason : '';
    this.registration.reject(id, principal.userId, reason);
    return { ok: true };
  }

  /**
   * 工作区全量数据导出(数据主权:「给我数据」)。
   *
   * 客户流失或迁移时的自助交付物:结构化 JSON 一次带走 workspace/项目/知识
   * (含盘上原文)/内容包/任务/额度流水。软删数据也导出——它们仍在库里,
   * 是客户资产的一部分。admin 专用;下载动作写审计。
   */
  @Get('workspaces/:workspaceId/export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="workspace-export.json"')
  exportWorkspace(@Req() request: Request, @Param('workspaceId') workspaceId: string) {
    this.requireSystemAdmin(request);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const workspace = this.database.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Record<string, unknown> | undefined;
    if (!workspace) throw new NotFoundException('工作区不存在');

    const projects = this.database.prepare('SELECT * FROM projects WHERE workspace_id = ?').all(workspaceId) as Record<string, unknown>[];
    const projectIds = projects.map((project) => String(project.id));
    const inProjects = projectIds.length ? `(${projectIds.map(() => '?').join(',')})` : '(NULL)';
    const knowledge = (this.database
      .prepare(`SELECT * FROM knowledge_files WHERE project_id IN ${inProjects}`)
      .all(...projectIds) as Record<string, unknown>[])
      .map((file) => ({
        ...file,
        // 盘上原文直接内联:knowledge_files 只存元数据,不带原文的导出恢复不出知识库。
        content: this.readKnowledgeContent(file.storage_path),
      }));
    const jobs = this.database
      .prepare(`SELECT * FROM generation_jobs WHERE project_id IN ${inProjects}`)
      .all(...projectIds) as Record<string, unknown>[];
    const packages = (this.database
      .prepare(`SELECT id, job_id, project_id, candidate_index, content_json, created_at, updated_at FROM content_packages WHERE project_id IN ${inProjects}`)
      .all(...projectIds) as Record<string, unknown>[])
      .map((row) => ({ ...row, content: parseJson(String(row.content_json), {}), content_json: undefined }));
    const ledger = this.database
      .prepare('SELECT * FROM quota_ledger WHERE workspace_id = ? ORDER BY id')
      .all(workspaceId) as Record<string, unknown>[];

    this.audit.record({
      workspaceId, userId: principal.userId, action: 'workspace.export',
      entityType: 'workspace', entityId: workspaceId,
      details: { projects: projects.length, knowledgeFiles: knowledge.length, contentPackages: packages.length },
    });
    return {
      exportedAt: new Date().toISOString(),
      workspace, projects, knowledgeFiles: knowledge, generationJobs: jobs,
      contentPackages: packages, quotaLedger: ledger,
    };
  }

  /**
   * 工作区物理清除(数据主权:「删我数据」)。
   *
   * 只对**已软删**的工作区执行——软删是回收站语义,物理清除是终局动作,
   * 二段式防误删。外键级联(PRAGMA foreign_keys=ON)删掉全部业务行,盘上
   * 知识原文逐个 unlink。审计日志刻意保留:删除动作本身必须留痕,
   * 且审计是行为记录而非内容资产。
   */
  @Delete('workspaces/:workspaceId/purge')
  purgeWorkspace(@Req() request: Request, @Param('workspaceId') workspaceId: string) {
    this.requireSystemAdmin(request);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const workspace = this.database.prepare('SELECT id, deleted_at FROM workspaces WHERE id = ?').get(workspaceId) as { id: string; deleted_at: string | null } | undefined;
    if (!workspace) throw new NotFoundException('工作区不存在');
    if (!workspace.deleted_at) throw new BadRequestException('只能物理清除已在回收站（软删）的工作区；请先删除工作区');

    const storagePaths = this.database
      .prepare(`SELECT k.storage_path FROM knowledge_files k
                JOIN projects p ON p.id = k.project_id WHERE p.workspace_id = ?`)
      .all(workspaceId) as Array<{ storage_path: string | null }>;

    const counts = this.database.transaction(() => {
      const projects = Number((this.database.prepare('SELECT COUNT(*) AS value FROM projects WHERE workspace_id = ?').get(workspaceId) as { value: number }).value);
      const removed = this.database.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('工作区不存在');
      // 审计写在同一事务:workspace 行已删,audit_logs.workspace_id 无外键,保留终局痕迹。
      this.audit.record({
        workspaceId, userId: principal.userId, action: 'workspace.purge',
        entityType: 'workspace', entityId: workspaceId,
        details: { projects, knowledgeFiles: storagePaths.length },
      });
      return { projects };
    });

    let filesRemoved = 0;
    for (const item of storagePaths) {
      if (!item.storage_path) continue;
      // storage_path 是相对 dataDir 的(knowledge.service 写入时 relative 化)。
      try { unlinkSync(resolve(this.options.dataDir, item.storage_path)); filesRemoved += 1; } catch { /* 文件已不存在:目标状态已达成 */ }
    }
    return { ok: true, projects: counts.projects, knowledgeFilesRemoved: filesRemoved };
  }

  private readKnowledgeContent(storagePath: unknown): string | null {
    if (typeof storagePath !== 'string' || !storagePath) return null;
    try {
      return readFileSync(resolve(this.options.dataDir, storagePath), 'utf8');
    } catch {
      return null;
    }
  }

  private requireSystemAdmin(rawRequest: Request): void {
    const request = rawRequest as unknown as AuthenticatedRequest;
    if ((request.principal as SessionPrincipal).systemRole !== 'admin') {
      throw new ForbiddenException('仅系统管理员可执行此操作');
    }
  }
}
