import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import { KnowledgeService } from './knowledge.service.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';

interface UploadedKnowledgeFile {
  originalname: string;
  buffer: Buffer;
}

interface KnowledgeUploadBody {
  projectId?: string;
  filename?: string;
  content?: string;
  category?: string;
  evidenceStatus?: string;
  metadata?: string | Record<string, unknown>;
}

// multer/Express decodes multipart originalname as Latin-1, mangling UTF-8
// (non-ASCII) filenames. Re-decode the raw bytes as UTF-8 to restore them.
function decodeMultipartFilename(originalname: string): string {
  const utf8 = Buffer.from(originalname, 'latin1').toString('utf8');
  return utf8.includes('�') ? originalname : utf8;
}

@Controller('api/knowledge')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class KnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() rawRequest: Request, @Query('projectId') projectId?: string) {
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(rawRequest, projectId, 'knowledge.read');
    return this.knowledge.list(projectId);
  }

  @Get(':fileId')
  async get(@Req() rawRequest: Request, @Param('fileId') fileId: string) {
    const row = this.knowledge.row(fileId);
    this.assert(rawRequest, String(row.project_id), 'knowledge.read');
    return this.knowledge.getWithContent(fileId);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async upload(
    @Req() rawRequest: Request,
    @Body() body: KnowledgeUploadBody,
    @UploadedFile() file?: UploadedKnowledgeFile,
  ) {
    return this.handleUpload(rawRequest, body, file);
  }

  /** 重新归类。与项目内嵌路由同一实现;前端用的是这条扁平路由。 */
  @Patch(':fileId')
  recategorize(
    @Req() rawRequest: Request,
    @Param('fileId') fileId: string,
    @Body() body: { category?: string; evidenceStatus?: string },
  ) {
    const row = this.knowledge.row(fileId);
    this.assert(rawRequest, String(row.project_id), 'knowledge.import');
    return this.knowledge.recategorize(fileId, body ?? {}, this.principal(rawRequest));
  }

  @Delete(':fileId')
  async remove(@Req() rawRequest: Request, @Param('fileId') fileId: string) {
    const row = this.knowledge.row(fileId);
    this.assert(rawRequest, String(row.project_id), 'knowledge.delete');
    await this.knowledge.remove(fileId, this.principal(rawRequest));
    return { ok: true };
  }

  private async handleUpload(
    rawRequest: Request,
    body: KnowledgeUploadBody,
    file?: UploadedKnowledgeFile,
    forcedProjectId?: string,
  ) {
    const projectId = forcedProjectId ?? body.projectId;
    if (!projectId) throw new BadRequestException('projectId 不能为空');
    this.assert(rawRequest, projectId, 'knowledge.import');
    const filename = file ? decodeMultipartFilename(file.originalname) : body.filename;
    const content = file?.buffer ?? body.content;
    if (!filename || (typeof content !== 'string' && !Buffer.isBuffer(content))) {
      throw new BadRequestException('请提供 file，或 filename + content');
    }
    let metadata: Record<string, unknown> = {};
    if (typeof body.metadata === 'string' && body.metadata) {
      try {
        metadata = JSON.parse(body.metadata) as Record<string, unknown>;
      } catch {
        throw new BadRequestException('metadata 必须是有效 JSON');
      }
    } else if (body.metadata && typeof body.metadata === 'object') {
      metadata = body.metadata;
    }
    return this.knowledge.import({
      projectId,
      filename,
      content,
      category: body.category,
      evidenceStatus: body.evidenceStatus,
      metadata,
      principal: this.principal(rawRequest),
    });
  }

  private assert(rawRequest: Request, projectId: string, permission: Permission): void {
    const principal = this.principal(rawRequest);
    const project = this.resources.projectRow(projectId);
    if (
      principal.systemRole !== 'admin' &&
      !this.permissions.hasPermission(principal.userId, String(project.workspace_id), permission, projectId)
    ) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}

@Controller('api/projects/:projectId/knowledge')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class ProjectKnowledgeController {
  constructor(
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  list(@Req() rawRequest: Request, @Param('projectId') projectId: string) {
    this.assert(rawRequest, projectId, 'knowledge.read');
    return this.knowledge.list(projectId);
  }

  @Get('index')
  index(@Req() rawRequest: Request, @Param('projectId') projectId: string) {
    this.assert(rawRequest, projectId, 'knowledge.read');
    return { projectId, content: this.knowledge.index(projectId) };
  }

  @Get('evidence-sections')
  evidenceSections(@Req() rawRequest: Request, @Param('projectId') projectId: string) {
    this.assert(rawRequest, projectId, 'project.read');
    return this.knowledge.evidenceSections(projectId);
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async upload(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Body() body: KnowledgeUploadBody,
    @UploadedFile() file?: UploadedKnowledgeFile,
  ) {
    this.assert(rawRequest, projectId, 'knowledge.import');
    const filename = file ? decodeMultipartFilename(file.originalname) : body.filename;
    const content = file?.buffer ?? body.content;
    if (!filename || (typeof content !== 'string' && !Buffer.isBuffer(content))) {
      throw new BadRequestException('请提供 file，或 filename + content');
    }
    let metadata: Record<string, unknown> = {};
    if (typeof body.metadata === 'string' && body.metadata) {
      try {
        metadata = JSON.parse(body.metadata) as Record<string, unknown>;
      } catch {
        throw new BadRequestException('metadata 必须是有效 JSON');
      }
    } else if (body.metadata && typeof body.metadata === 'object') {
      metadata = body.metadata;
    }
    return this.knowledge.import({
      projectId,
      filename,
      content,
      category: body.category,
      evidenceStatus: body.evidenceStatus,
      metadata,
      principal: this.principal(rawRequest),
    });
  }

  @Get(':fileId')
  async get(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
  ) {
    const row = this.knowledge.row(fileId);
    if (row.project_id !== projectId) throw new BadRequestException('文件不属于该项目');
    this.assert(rawRequest, projectId, 'knowledge.read');
    return this.knowledge.getWithContent(fileId);
  }

  /**
   * 重新归类:改分类或证据类型,不必删除后重传。
   * 权限沿用 knowledge.import——它改的是资料如何参与生成,与导入同权重。
   */
  @Patch(':fileId')
  recategorize(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Body() body: { category?: string; evidenceStatus?: string },
  ) {
    const row = this.knowledge.row(fileId);
    if (row.project_id !== projectId) throw new BadRequestException('文件不属于该项目');
    this.assert(rawRequest, projectId, 'knowledge.import');
    return this.knowledge.recategorize(fileId, body ?? {}, this.principal(rawRequest));
  }

  @Delete(':fileId')
  async remove(
    @Req() rawRequest: Request,
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
  ) {
    const row = this.knowledge.row(fileId);
    if (row.project_id !== projectId) throw new BadRequestException('文件不属于该项目');
    this.assert(rawRequest, projectId, 'knowledge.delete');
    await this.knowledge.remove(fileId, this.principal(rawRequest));
    return { ok: true };
  }

  private assert(rawRequest: Request, projectId: string, permission: Permission): void {
    const principal = this.principal(rawRequest);
    const project = this.resources.projectRow(projectId);
    if (
      principal.systemRole !== 'admin' &&
      !this.permissions.hasPermission(principal.userId, String(project.workspace_id), permission, projectId)
    ) {
      throw new ForbiddenException(`缺少权限：${permission}`);
    }
  }

  private principal(rawRequest: Request): SessionPrincipal {
    return (rawRequest as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
