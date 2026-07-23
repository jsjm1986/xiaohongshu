import { DynamicModule, Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AppController } from './placeholder.controller.js';
import { AuditService } from './audit.service.js';
import { AuditController } from './audit.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { APP_OPTIONS, type ApiOptionsInput, resolveOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import {
  CsrfGuard,
  PermissionGuard,
  ReadOnlyAuthGuard,
  SessionAuthGuard,
} from './guards.js';
import { HealthController } from './health.controller.js';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';
import { FormulaController } from './formula.controller.js';
import { FormulaService } from './formula.service.js';
import { GenerationController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';
import { KnowledgeController, ProjectKnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { ProjectController } from './project.controller.js';
import { PresetController } from './preset.controller.js';
import { RegistrationController } from './registration.controller.js';
import { RegistrationService } from './registration.service.js';
import { PresetService } from './preset.service.js';
import { ResourceService } from './resource.service.js';
import { ResearchController } from './research.controller.js';
import { ResearchService } from './research.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { V1Controller } from './v1.controller.js';
import { WorkspaceController } from './workspace.controller.js';

@Module({})
export class AppModule {
  static register(options: ApiOptionsInput = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AppController,
        AuthController,
        RegistrationController,
        AuditController,
        AdminController,
        WorkspaceController,
        ProjectController,
        IntelligenceController,
        PresetController,
        KnowledgeController,
        ProjectKnowledgeController,
        FormulaController,
        ResearchController,
        GenerationController,
        ExportController,
        SettingsController,
        V1Controller,
      ],
      providers: [
        { provide: APP_OPTIONS, useValue: resolveOptions(options) },
        DatabaseService,
        AuthService,
        AuditService,
        ResourceService,
        IntelligenceService,
        KnowledgeService,
        FormulaService,
        ResearchService,
        SettingsService,
        GenerationService,
        PresetService,
        ExportService,
        RegistrationService,
        SessionAuthGuard,
        CsrfGuard,
        ReadOnlyAuthGuard,
        PermissionGuard,
      ],
      exports: [
        APP_OPTIONS,
        DatabaseService,
        AuthService,
        AuditService,
        ResourceService,
        IntelligenceService,
        KnowledgeService,
        FormulaService,
        ResearchService,
        SettingsService,
        GenerationService,
        PresetService,
        ExportService,
        PermissionGuard,
      ],
    };
  }
}
