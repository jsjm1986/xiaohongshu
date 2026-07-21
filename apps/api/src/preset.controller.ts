import {
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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard, PermissionGuard, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, Permission, SessionPrincipal } from './models.js';
import { PresetService } from './preset.service.js';
import { ResourceService } from './resource.service.js';
import { requireObject } from './utils.js';

@Controller('api')
@UseGuards(SessionAuthGuard, CsrfGuard)
export class PresetController {
  constructor(
    @Inject(PresetService) private readonly presets: PresetService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(PermissionGuard) private readonly permissions: PermissionGuard,
  ) {}

  @Get('generation-parameters/schema')
  schema(@Req() request: Request, @Query('projectId') projectId?: string) {
    if (projectId) this.assert(request, projectId, 'project.read');
    return this.presets.schema(projectId);
  }

  @Get('projects/:projectId/presets')
  list(@Req() request: Request, @Param('projectId') projectId: string) {
    this.assert(request, projectId, 'project.read');
    return this.presets.list(projectId);
  }

  @Get('projects/:projectId/presets/:presetId')
  get(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('presetId') presetId: string,
  ) {
    this.assert(request, projectId, 'project.read');
    return this.presets.get(projectId, presetId);
  }

  @Post('projects/:projectId/presets')
  create(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() rawBody: unknown,
  ) {
    this.assert(request, projectId, 'project.write');
    return this.presets.create(projectId, requireObject(rawBody), this.principal(request));
  }

  @Patch('projects/:projectId/presets/:presetId')
  update(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('presetId') presetId: string,
    @Body() rawBody: unknown,
  ) {
    this.assert(request, projectId, 'project.write');
    return this.presets.update(projectId, presetId, requireObject(rawBody), this.principal(request));
  }

  @Delete('projects/:projectId/presets/:presetId')
  remove(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('presetId') presetId: string,
  ) {
    this.assert(request, projectId, 'project.write');
    this.presets.remove(projectId, presetId, this.principal(request));
    return { ok: true };
  }

  @Post('projects/:projectId/presets/:presetId/copy')
  copy(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('presetId') presetId: string,
    @Body() rawBody: unknown,
  ) {
    this.assert(request, projectId, 'project.write');
    return this.presets.copy(projectId, presetId, requireObject(rawBody), this.principal(request));
  }

  @Post('projects/:projectId/presets/:presetId/default')
  setDefault(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Param('presetId') presetId: string,
  ) {
    this.assert(request, projectId, 'project.write');
    return this.presets.setDefault(projectId, presetId, this.principal(request));
  }

  @Get('projects/:projectId/style-profile')
  styleProfile(@Req() request: Request, @Param('projectId') projectId: string) {
    this.assert(request, projectId, 'project.read');
    return this.presets.styleProfile(projectId);
  }

  @Patch('projects/:projectId/style-profile')
  updateStyleProfile(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() rawBody: unknown,
  ) {
    this.assert(request, projectId, 'project.write');
    return this.presets.updateStyleProfile(projectId, requireObject(rawBody), this.principal(request));
  }

  @Post('projects/:projectId/resolve-config')
  resolveConfig(
    @Req() request: Request,
    @Param('projectId') projectId: string,
    @Body() rawBody: unknown,
  ) {
    this.assert(request, projectId, 'project.read');
    const result = this.presets.resolve(projectId, requireObject(rawBody), this.principal(request));
    const impacts = result.impactPreview.map((impact) => ({
      parameterId: String(impact.parameterId ?? impact.path ?? 'parameter'),
      label: String(impact.label ?? impact.parameterId ?? '参数'),
      value: impact.value,
      direction: impact.direction ?? 'changed',
      summary: String(impact.summary ?? impact.directive ?? '该参数已参与最终配置。'),
      affects: Array.isArray(impact.channels)
        ? impact.channels
        : Array.isArray(impact.affectedPaths)
          ? impact.affectedPaths
          : typeof impact.path === 'string'
            ? [impact.path]
            : [],
      risk: typeof impact.risk === 'string' ? impact.risk : undefined,
    }));
    const warningMessages = [...new Set([
      ...result.warnings,
      ...(Array.isArray(result.impactReport.warnings) ? result.impactReport.warnings : []),
    ])];
    return {
      schemaVersion: result.schemaVersion,
      preset: result.preset,
      parameterValues: result.parameterValues,
      resolvedConfig: result.resolvedConfig,
      formulaVersion: result.formulaVersion.id,
      formulaVersionDetail: {
        id: result.formulaVersion.id,
        version: result.formulaVersion.version,
        digest: result.formulaVersion.digest,
      },
      styleProfileVersion: result.styleProfileVersion,
      conflicts: result.conflicts.map((conflict) => ({
        severity: conflict.severity ?? 'warning',
        title: conflict.title ?? conflict.code ?? '配置冲突',
        message: conflict.message ?? '',
        ...conflict,
      })),
      warnings: warningMessages.map((message) => ({
        severity: 'warning',
        title: '配置提示',
        message,
      })),
      sourceMap: result.sourceMap,
      directives: result.directives,
      impacts,
      impactReport: impacts,
      impactPreview: impacts,
      parameterImpactReport: result.impactReport,
    };
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

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
