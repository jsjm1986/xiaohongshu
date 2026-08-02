import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CsrfGuard, PermissionGuard, RequirePermission, SessionAuthGuard } from './guards.js';
import { IntelligenceEnrichService } from './intelligence-enrich.service.js';
import { parseDraftRequest, parseMergeRequest, parseSaveRequest } from './intelligence-enrich.types.js';
import { IntelligenceService } from './intelligence.service.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { parsePagination, requireObject } from './utils.js';

interface UploadedImage {
  originalname: string;
  buffer: Buffer;
}

@Controller('api/projects/:projectId')
@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)
export class IntelligenceController {
  constructor(
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
    @Inject(IntelligenceEnrichService) private readonly enrich: IntelligenceEnrichService,
  ) {}

  @Get('intelligence')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listIntelligence(@Param('projectId') projectId: string) {
    return this.intelligence.listIntelligence(projectId);
  }

  @Get('intelligence/analysis-tasks')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listTasks(@Param('projectId') projectId: string) {
    return this.intelligence.listTasks(projectId);
  }

  /*
   * 知识库 AI 补充:起草 → 合并预览 → 保存新版本。
   *
   * 路由注册在「intelligence/」下而不是「knowledge/」下,因为这三步全靠
   * information_gaps 驱动,而缺口是分析产物。
   */
  @Post('intelligence/enrich/draft')
  @RequirePermission({ permission: ['project.write', 'knowledge.read'], projectParam: 'projectId' })
  enrichDraft(@Req() request: Request, @Param('projectId') projectId: string, @Body() body?: unknown) {
    // body 可缺省:不带就整批起草,带 gapIds 就只补指定的几条(缺口池的单条精补)
    const { gapIds } = parseDraftRequest(body);
    return this.enrich.generateEnrichmentDraft(projectId, this.principal(request), gapIds);
  }

  @Post('intelligence/enrich/merge')
  @RequirePermission({ permission: ['project.write', 'knowledge.read'], projectParam: 'projectId' })
  enrichMerge(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const { items, targetFile } = parseMergeRequest(body);
    return this.enrich.mergeEnrichedKnowledge(projectId, items, targetFile, this.principal(request));
  }

  /*
   * save 判 knowledge.import,不判 project.write。
   *
   * 它写的是知识文件,和 KnowledgeController.handleUpload 是同一件事,必须同一把锁——
   * 否则会出现「没有上传知识库的权限,但能通过补充功能往知识库写入」的绕过。
   */
  @Post('intelligence/enrich/save')
  @RequirePermission({ permission: 'knowledge.import', projectParam: 'projectId' })
  enrichSave(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const { content, targetFile, baseFileId } = parseSaveRequest(body);
    return this.enrich.saveEnrichedKnowledge(projectId, content, targetFile, baseFileId, this.principal(request));
  }

  @Get('intelligence/analysis-tasks/:taskId')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getTask(@Param('projectId') projectId: string, @Param('taskId') taskId: string) {
    return this.intelligence.getTask(projectId, taskId);
  }

  @Post('intelligence')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createIntelligence(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.intelligence.createIntelligence(projectId, requireObject(body), this.principal(request));
  }

  @Post('intelligence/analyze')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  analyzeIntelligence(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = objectOrEmpty(body);
    return this.intelligence.analyzeProject(projectId, this.principal(request), input.force === true);
  }

  @Post('intelligence/analyses')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createAnalysis(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const input = objectOrEmpty(body);
    return this.intelligence.analyzeProject(projectId, this.principal(request), input.force === true);
  }

  @Get('intelligence/:id')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getIntelligence(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.getIntelligence(projectId, id);
  }

  @Patch('intelligence/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateIntelligence(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateIntelligence(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('intelligence/:id/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveIntelligence(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.approveIntelligence(projectId, id, objectOrEmpty(body), this.principal(request));
  }

  @Delete('intelligence/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeIntelligence(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    this.intelligence.removeIntelligence(projectId, id, this.principal(request));
    return { ok: true };
  }

  @Get('blueprint-modules')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listBlueprintModules(@Param('projectId') projectId: string) {
    return this.intelligence.listBlueprintModules(projectId);
  }

  @Get('blueprint-modules/:id')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getBlueprintModule(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.getBlueprintModule(projectId, id);
  }

  @Patch('blueprint-modules/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateBlueprintModule(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateBlueprintModule(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('blueprint-modules/:id/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveBlueprintModule(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.approveBlueprintModule(projectId, id, objectOrEmpty(body), this.principal(request));
  }

  @Get('information-gaps')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listGaps(@Param('projectId') projectId: string) {
    return this.intelligence.listGaps(projectId);
  }

  @Post('information-gaps')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createGap(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.intelligence.createGap(projectId, requireObject(body), this.principal(request));
  }

  @Get('information-gaps/:id')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getGap(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.getGap(projectId, id);
  }

  @Patch('information-gaps/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateGap(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateGap(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('information-gaps/:id/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveGap(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.approveGap(projectId, id, objectOrEmpty(body), this.principal(request));
  }

  @Delete('information-gaps/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeGap(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    this.intelligence.removeGap(projectId, id, this.principal(request));
    return { ok: true };
  }

  @Get('expression-strategies')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listStrategies(@Param('projectId') projectId: string) {
    return this.intelligence.listStrategies(projectId);
  }

  @Post('expression-strategies')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createStrategy(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.intelligence.createStrategy(projectId, requireObject(body), this.principal(request));
  }

  @Get('expression-strategies/:id')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getStrategy(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.getStrategy(projectId, id);
  }

  @Patch('expression-strategies/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateStrategy(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateStrategy(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('expression-strategies/:id/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveStrategy(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.approveStrategy(projectId, id, objectOrEmpty(body), this.principal(request));
  }

  @Delete('expression-strategies/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeStrategy(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    this.intelligence.removeStrategy(projectId, id, this.principal(request));
    return { ok: true };
  }

  @Get('topic-opportunities')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listOpportunities(@Param('projectId') projectId: string) {
    return this.intelligence.listOpportunities(projectId);
  }

  @Post('topic-opportunities')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createOpportunity(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.intelligence.createOpportunity(projectId, requireObject(body), this.principal(request));
  }

  @Post('topic-opportunities/refresh')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  refreshOpportunities(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const b = requireObject(body ?? {});
    const userGuidance = typeof b.userGuidance === 'string' ? b.userGuidance : undefined;
    return this.intelligence.refreshTopicOpportunities(projectId, this.principal(request), { userGuidance });
  }

  @Get('topic-opportunities/:id')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getOpportunity(@Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.getOpportunity(projectId, id);
  }

  @Patch('topic-opportunities/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateOpportunity(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateOpportunity(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('topic-opportunities/:id/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveOpportunity(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.approveOpportunity(projectId, id, objectOrEmpty(body), this.principal(request));
  }

  @Post('topic-opportunities/:id/select')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  selectOpportunity(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.intelligence.selectOpportunity(projectId, id, this.principal(request));
  }

  @Delete('topic-opportunities/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeOpportunity(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    this.intelligence.removeOpportunity(projectId, id, this.principal(request));
    return { ok: true };
  }

  @Post('topic-opportunities/:id/collection')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  setOpportunityCollection(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    const b = requireObject(body);
    const status = b.status === 'collected' || b.status === 'archived' || b.status === 'active' ? b.status : undefined;
    if (!status) throw new BadRequestException('status 必须是 active/collected/archived');
    return this.intelligence.setOpportunityCollectionStatus(projectId, id, status, this.principal(request));
  }

  @Get('topic-opportunity-batches')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listOpportunityBatches(@Param('projectId') projectId: string) {
    return this.intelligence.listBatches(projectId);
  }

  @Get('opportunity-prompt-templates')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listPromptTemplates(@Param('projectId') projectId: string) {
    return this.intelligence.listPromptTemplates(projectId);
  }

  @Post('opportunity-prompt-templates')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createPromptTemplate(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const b = requireObject(body);
    return this.intelligence.createPromptTemplate(projectId, String(b.label ?? ''), String(b.guidance ?? ''), this.principal(request));
  }

  @Delete('opportunity-prompt-templates/:templateId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  deletePromptTemplate(@Req() request: Request, @Param('projectId') projectId: string, @Param('templateId') templateId: string) {
    this.intelligence.deletePromptTemplate(projectId, templateId, this.principal(request));
    return { ok: true };
  }

  @Get('image-assets')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listImages(
    @Param('projectId') projectId: string,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
    @Query('observationStatus') rawObservationStatus?: string,
  ) {
    if (rawObservationStatus !== undefined && rawObservationStatus !== 'approved') {
      throw new BadRequestException('observationStatus 只支持 approved');
    }
    return this.intelligence.listImages(
      projectId,
      parsePagination(rawLimit, rawOffset),
      rawObservationStatus,
    );
  }

  @Post('image-assets')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 4, parts: 5, fieldSize: 16 * 1024 },
  }))
  uploadImage(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @UploadedFile() file?: UploadedImage,
  ) {
    if (!file?.buffer || !file.originalname) throw new BadRequestException('A multipart image file is required.');
    return this.intelligence.uploadImage({ projectId, filename: file.originalname, buffer: file.buffer, principal: this.principal(request) });
  }

  @Get('image-assets/:assetId/content')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  @Header('Cache-Control', 'private, max-age=3600')
  async imageContent(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intelligence.imageContent(projectId, assetId);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    return new StreamableFile(result.buffer);
  }

  @Get('image-assets/:assetId')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  getImage(@Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    return this.intelligence.getImage(projectId, assetId);
  }

  @Delete('image-assets/:assetId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeImage(@Req() request: Request, @Param('projectId') projectId: string, @Param('assetId') assetId: string) {
    this.intelligence.removeImage(projectId, assetId, this.principal(request));
    return { ok: true };
  }

  @Get('image-assets/:assetId/analyses')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  imageAnalyses(
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Query('limit') rawLimit?: string,
    @Query('offset') rawOffset?: string,
  ) {
    return this.intelligence.listImageAnalyses(projectId, assetId, parsePagination(rawLimit, rawOffset));
  }

  @Post('image-assets/:assetId/analyze')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  analyzeImage(@Req() request: Request, @Param('projectId') projectId: string, @Param('assetId') assetId: string, @Body() body: unknown) {
    const input = objectOrEmpty(body);
    return this.intelligence.analyzeImage(projectId, assetId, this.principal(request), input.force === true);
  }

  @Post('image-assets/:assetId/analyses')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createImageAnalysis(@Req() request: Request, @Param('projectId') projectId: string, @Param('assetId') assetId: string, @Body() body: unknown) {
    const input = objectOrEmpty(body);
    return this.intelligence.analyzeImage(projectId, assetId, this.principal(request), input.force === true);
  }

  @Post('image-assets/:assetId/analyses/:analysisId/approve')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  approveImageAnalysis(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Param('analysisId') analysisId: string,
    @Body() body: unknown,
  ) {
    return this.intelligence.approveImageAnalysis(projectId, assetId, analysisId, objectOrEmpty(body), this.principal(request));
  }

  @Patch('image-assets/:assetId/analyses/:analysisId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateImageAnalysis(@Req() request: Request, @Param('projectId') projectId: string, @Param('assetId') assetId: string, @Param('analysisId') analysisId: string, @Body() body: unknown) {
    return this.intelligence.updateImageAnalysis(projectId, assetId, analysisId, requireObject(body), this.principal(request));
  }

  @Get('coverage')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listCoverage(@Param('projectId') projectId: string) {
    return this.intelligence.listCoverage(projectId);
  }

  @Post('coverage')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createCoverage(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.intelligence.createCoverage(projectId, requireObject(body), this.principal(request));
  }

  @Patch('coverage/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  updateCoverage(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.intelligence.updateCoverage(projectId, id, requireObject(body), this.principal(request));
  }

  @Delete('coverage/:id')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  removeCoverage(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    this.intelligence.removeCoverage(projectId, id, this.principal(request));
    return { ok: true };
  }

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireObject(value);
}
