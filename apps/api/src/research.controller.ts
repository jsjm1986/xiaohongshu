import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CsrfGuard, PermissionGuard, RequirePermission, SessionAuthGuard } from './guards.js';
import type { AuthenticatedRequest, SessionPrincipal } from './models.js';
import { ResearchService } from './research.service.js';
import { requireObject } from './utils.js';

@Controller('api/projects/:projectId/research')
@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)
export class ResearchController {
  constructor(@Inject(ResearchService) private readonly research: ResearchService) {}

  @Get('overview')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  overview(@Req() request: Request, @Param('projectId') projectId: string) {
    return this.research.overview(projectId, this.principal(request));
  }

  @Get('claims')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  claims(@Param('projectId') projectId: string) { return this.research.listClaims(projectId); }

  @Post('claims')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createClaim(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createClaim(projectId, requireObject(body), this.principal(request));
  }

  @Post('claims/:id/review')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  reviewClaim(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewClaim(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('claims/:id/evidence-links')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  linkEvidence(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.linkEvidence(projectId, id, requireObject(body), this.principal(request));
  }

  @Get('evidence-sources')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  sources(@Param('projectId') projectId: string) { return this.research.listSources(projectId); }

  @Post('evidence-sources')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createSource(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createSource(projectId, requireObject(body), this.principal(request));
  }

  @Post('evidence-sources/:id/review')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  reviewSource(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewSource(projectId, id, requireObject(body), this.principal(request));
  }

  @Get('datasets')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  datasets(@Param('projectId') projectId: string) { return this.research.listDatasets(projectId); }

  @Post('datasets')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createDataset(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createDataset(projectId, requireObject(body), this.principal(request));
  }

  @Post('datasets/:id/review')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  reviewDataset(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewDataset(projectId, id, requireObject(body), this.principal(request));
  }

  @Get('experiments')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  experiments(@Param('projectId') projectId: string) { return this.research.listExperiments(projectId); }

  @Post('experiments')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createExperiment(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createExperiment(projectId, requireObject(body), this.principal(request));
  }

  @Post('experiments/:id/transition')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  transitionExperiment(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.transitionExperiment(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('experiments/:id/results')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createResult(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.createExperimentResult(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('experiment-results/:id/review')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  reviewResult(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewExperimentResult(projectId, id, requireObject(body), this.principal(request));
  }

  @Get('calibrations')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  calibrations(@Param('projectId') projectId: string) { return this.research.listCalibrations(projectId); }

  @Post('calibrations')
  @RequirePermission({ permission: 'research.write', projectParam: 'projectId' })
  createCalibration(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createCalibration(projectId, requireObject(body), this.principal(request));
  }

  @Post('calibrations/:id/review')
  @RequirePermission({ permission: 'research.approve', projectParam: 'projectId' })
  reviewCalibration(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewCalibration(projectId, id, requireObject(body), this.principal(request));
  }

  @Get('releases')
  @RequirePermission({ permission: 'research.read', projectParam: 'projectId' })
  releases(@Param('projectId') projectId: string) { return this.research.listReleases(projectId); }

  @Post('releases')
  @RequirePermission({ permission: 'release.manage', projectParam: 'projectId' })
  createRelease(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    return this.research.createRelease(projectId, requireObject(body), this.principal(request));
  }

  @Post('releases/:id/review')
  @RequirePermission({ permission: 'release.manage', projectParam: 'projectId' })
  reviewRelease(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.research.reviewRelease(projectId, id, requireObject(body), this.principal(request));
  }

  @Post('releases/:id/activate')
  @RequirePermission({ permission: 'release.manage', projectParam: 'projectId' })
  activateRelease(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string) {
    return this.research.activateRelease(projectId, id, this.principal(request));
  }

  private principal(request: Request): SessionPrincipal {
    return (request as unknown as AuthenticatedRequest).principal as SessionPrincipal;
  }
}
