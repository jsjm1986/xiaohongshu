import { BadRequestException, Controller, ForbiddenException, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ExportService, type ExportFormat } from './export.service.js';
import { GenerationService } from './generation.service.js';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';

const TYPES: Record<ExportFormat, string> = {
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

const EXTENSIONS: Record<ExportFormat, string> = { markdown: 'md', json: 'json', docx: 'docx', pdf: 'pdf' };

@Controller('api/generations')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class ExportController {
  constructor(
    @Inject(GenerationService) private readonly generations: GenerationService,
    @Inject(ExportService) private readonly exporter: ExportService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get(':jobId/candidates/:candidateId/export')
  async download(
    @Req() request: Request,
    @Res() response: Response,
    @Param('jobId') jobId: string,
    @Param('candidateId') candidateId: string,
    @Query('format') rawFormat = 'markdown',
  ) {
    const format = (rawFormat === 'md' ? 'markdown' : rawFormat) as ExportFormat;
    if (!Object.hasOwn(TYPES, format)) throw new BadRequestException('format 只支持 markdown、json、docx、pdf');
    const job = this.generations.jobRow(jobId);
    const principal = (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
    const project = this.resources.projectRow(job.project_id);
    if (principal.systemRole !== 'admin' && !this.permissions.hasPermission(principal.userId, String(project.workspace_id), 'generation.export', job.project_id)) {
      throw new ForbiddenException('缺少权限：generation.export');
    }
    const content = this.generations.contentPackage(jobId, candidateId);
    const confirmation = this.generations.manualDeliveryConfirmation(content.id, principal.userId);
    const buffer = await this.exporter.exportPackage(content, format, {
      manualDeliveryConfirmation: confirmation ? {
        ...confirmation,
        jobId,
        candidateId: content.candidateId,
      } : undefined,
    });
    const title = content.content.N.title.replace(/[\\/:*?"<>|\r\n]/gu, '_').slice(0, 60) || 'content-package';
    const filename = `${title}.${EXTENSIONS[format]}`;
    response.setHeader('Content-Type', TYPES[format]);
    response.setHeader('Content-Disposition', `attachment; filename="content-package.${EXTENSIONS[format]}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    response.setHeader('Content-Length', String(buffer.byteLength));
    response.send(buffer);
  }
}
