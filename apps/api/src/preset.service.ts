import { randomBytes, randomUUID } from 'node:crypto';
import {
  BUILT_IN_GENERATION_PRESETS,
  BUILT_IN_STYLE_PROFILES,
  CONFIRMED_REFERENCE_SAMPLE_BASELINE,
  GENERATION_PARAMETER_REGISTRY,
  compileGenerationParameters,
  createDefaultGenerationConfig,
  resolveGenerationConfig,
  type FormulaVersion,
  type GenerationParameterSelection,
  type ParameterImpactReport,
  type ParameterResolutionSnapshot,
  type ParameterValue,
  type ResolvedGenerationConfig,
} from '@content-agent/agent-core';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { APP_OPTIONS, type ApiOptions } from './config.js';
import { DatabaseService } from './database.service.js';
import { FormulaService } from './formula.service.js';
import {
  GENERATION_PARAMETERS,
  normalizeParameterValues,
  parameterSchema,
} from './generation-parameters.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { SettingsService } from './settings.service.js';
import { nowIso, parseJson, requireString } from './utils.js';

interface PresetRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  base_preset_id: string;
  values_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface PublicPreset {
  id: string;
  projectId: string;
  name: string;
  description: string;
  source: 'builtin' | 'custom';
  isDefault: boolean;
  values: Record<string, ParameterValue>;
  basePresetId?: string;
  difference?: Record<string, ParameterValue>;
  instructions?: string[];
  evidenceStatus?: string;
  noviceExplanation?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConfigResolutionResult {
  schemaVersion: '1.0';
  formulaVersion: FormulaVersion;
  preset: PublicPreset;
  parameterValues: Record<string, ParameterValue>;
  parameterSelection: GenerationParameterSelection;
  resolvedConfig: ResolvedGenerationConfig;
  resolutionSnapshot: ParameterResolutionSnapshot;
  conflicts: Array<Record<string, unknown>>;
  warnings: string[];
  sourceMap: Record<string, string>;
  directives: string[];
  impactReport: ParameterImpactReport & Record<string, unknown>;
  impactPreview: Array<Record<string, unknown>>;
  styleProfileVersion: number;
  styleProfile: Record<string, unknown>;
  requestOverrides: Record<string, unknown>;
}

const CORE_PARAMETER_IDS = new Set(GENERATION_PARAMETER_REGISTRY.map((item) => item.id));
const BUILTIN_PRESET_MAP = new Map(BUILT_IN_GENERATION_PRESETS.map((item) => [item.id, item]));
const BUILTIN_STYLE_MAP = new Map(BUILT_IN_STYLE_PROFILES.map((item) => [item.id, item]));
const DEFAULT_PRESET_ID = 'balanced_information';

@Injectable()
export class PresetService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_OPTIONS) private readonly options: ApiOptions,
  ) {}

  schema(projectId?: string): Record<string, unknown> {
    const schema = parameterSchema();
    const response: Record<string, unknown> = {
      ...schema,
      presets: BUILT_IN_GENERATION_PRESETS.map((preset) => ({
        id: preset.id,
        name: preset.label,
        description: preset.description,
        values: structuredClone(preset.parameterValues),
        noviceExplanation: preset.noviceExplanation,
        evidenceStatus: preset.evidenceStatus,
      })),
      styleProfiles: BUILT_IN_STYLE_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.label,
        description: profile.description,
        values: structuredClone(profile.parameterValues),
        noviceExplanation: profile.noviceExplanation,
        evidenceStatus: profile.evidenceStatus,
        safetyBoundary: profile.safetyBoundary,
      })),
      sampleBaseline: structuredClone(CONFIRMED_REFERENCE_SAMPLE_BASELINE),
    };
    if (!projectId) return response;
    this.resources.projectRow(projectId);
    response.knowledgeFiles = this.database
      .prepare(
        `SELECT id AS value, filename AS label, category, evidence_status AS evidenceStatus
         FROM knowledge_files WHERE project_id=? AND deleted_at IS NULL
         ORDER BY filename, version DESC`,
      )
      .all(projectId);
    response.formulaVersions = this.database
      .prepare(
        `SELECT id AS value, '公式 v' || version || ' · ' || status AS label, status
         FROM formula_versions WHERE project_id=? ORDER BY version DESC`,
      )
      .all(projectId);
    return response;
  }

  list(projectId: string): PublicPreset[] {
    this.resources.projectRow(projectId);
    const defaultId = this.defaultId(projectId);
    const builtins = BUILT_IN_GENERATION_PRESETS.map((preset) => this.publicBuiltin(projectId, preset.id, defaultId));
    const custom = (this.database
      .prepare(
        `SELECT * FROM generation_presets
         WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC`,
      )
      .all(projectId) as unknown as PresetRow[]).map((row) => this.publicCustom(row, defaultId));
    return [...builtins, ...custom];
  }

  get(projectId: string, presetId: string): PublicPreset {
    this.resources.projectRow(projectId);
    if (BUILTIN_PRESET_MAP.has(presetId)) return this.publicBuiltin(projectId, presetId, this.defaultId(projectId));
    return this.publicCustom(this.row(projectId, presetId), this.defaultId(projectId));
  }

  create(projectId: string, body: Record<string, unknown>, principal: SessionPrincipal): PublicPreset {
    const project = this.resources.projectRow(projectId);
    const name = requireString(body.name, 'name', { max: 100 });
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
    const requestedBase = typeof body.basePresetId === 'string' ? body.basePresetId : DEFAULT_PRESET_ID;
    const base = this.get(projectId, requestedBase);
    const inputValues = normalizeParameterValues(body.values, {
      partial: true,
      rejectUnknown: true,
    }).values;
    const basePresetId = base.source === 'builtin' ? base.id : base.basePresetId ?? DEFAULT_PRESET_ID;
    const baseValues = this.publicBuiltin(projectId, basePresetId, '').values;
    const target = { ...base.values, ...inputValues };
    const difference = differenceFrom(baseValues, target);
    const id = randomUUID();
    const now = nowIso();
    this.database
      .prepare(
        `INSERT INTO generation_presets
          (id, project_id, name, description, base_preset_id, values_json,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, name, description, basePresetId, JSON.stringify(difference), principal.userId, now, now);
    this.record(project, principal, 'preset.create', id, { projectId, basePresetId });
    return this.get(projectId, id);
  }

  update(
    projectId: string,
    presetId: string,
    body: Record<string, unknown>,
    principal: SessionPrincipal,
  ): PublicPreset {
    const project = this.resources.projectRow(projectId);
    const row = this.row(projectId, presetId);
    const current = this.publicCustom(row, this.defaultId(projectId));
    const name = typeof body.name === 'string' ? requireString(body.name, 'name', { max: 100 }) : row.name;
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : row.description;
    const incoming = body.values === undefined
      ? {}
      : normalizeParameterValues(body.values, { partial: true, rejectUnknown: true }).values;
    const baseValues = this.publicBuiltin(projectId, row.base_preset_id, '').values;
    const target = body.replaceValues === true ? { ...baseValues, ...incoming } : { ...current.values, ...incoming };
    const difference = differenceFrom(baseValues, target);
    this.database
      .prepare(
        `UPDATE generation_presets SET name=?, description=?, values_json=?, updated_at=?
         WHERE id=? AND project_id=?`,
      )
      .run(name, description, JSON.stringify(difference), nowIso(), presetId, projectId);
    this.record(project, principal, 'preset.update', presetId, { projectId });
    return this.get(projectId, presetId);
  }

  copy(
    projectId: string,
    presetId: string,
    body: Record<string, unknown>,
    principal: SessionPrincipal,
  ): PublicPreset {
    const source = this.get(projectId, presetId);
    return this.create(projectId, {
      name: typeof body.name === 'string' ? body.name : `${source.name} 副本`,
      description: typeof body.description === 'string' ? body.description : `复制自 ${source.name}`,
      basePresetId: source.basePresetId ?? (source.source === 'builtin' ? source.id : DEFAULT_PRESET_ID),
      values: source.values,
    }, principal);
  }

  setDefault(projectId: string, presetId: string, principal: SessionPrincipal): PublicPreset {
    const project = this.resources.projectRow(projectId);
    this.get(projectId, presetId);
    this.database
      .prepare(
        `INSERT INTO project_preset_defaults (project_id, preset_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET preset_id=excluded.preset_id,
           updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      )
      .run(projectId, presetId, principal.userId, nowIso());
    this.record(project, principal, 'preset.set-default', presetId, { projectId });
    return this.get(projectId, presetId);
  }

  remove(projectId: string, presetId: string, principal: SessionPrincipal): void {
    if (BUILTIN_PRESET_MAP.has(presetId)) throw new BadRequestException('内置预设不能删除，可以复制后修改');
    const project = this.resources.projectRow(projectId);
    this.row(projectId, presetId);
    const now = nowIso();
    this.database.transaction(() => {
      this.database
        .prepare('UPDATE generation_presets SET deleted_at=?, updated_at=? WHERE id=? AND project_id=?')
        .run(now, now, presetId, projectId);
      this.database
        .prepare('DELETE FROM project_preset_defaults WHERE project_id=? AND preset_id=?')
        .run(projectId, presetId);
    });
    this.record(project, principal, 'preset.delete', presetId, { projectId });
  }

  styleProfile(projectId: string): Record<string, unknown> {
    const project = this.resources.projectRow(projectId);
    const values = parseJson<Record<string, unknown>>(project.style_profile_json, {});
    const parameters = isRecord(values.parameterValues) ? values.parameterValues : {};
    return {
      projectId,
      version: Number(project.style_profile_version ?? 1),
      values,
      preferredTone: values.preferredTone ?? parameters.expression_voice,
      preferredStructures: Array.isArray(values.preferredStructures) ? values.preferredStructures : [],
      avoidedPatterns: Array.isArray(values.avoidedPatterns) ? values.avoidedPatterns : [],
      examples: Array.isArray(values.examples) ? values.examples : [],
      updatedAt: project.style_profile_updated_at ?? null,
      availableProfiles: BUILT_IN_STYLE_PROFILES.map((profile) => ({
        id: profile.id,
        name: profile.label,
        description: profile.description,
        values: profile.parameterValues,
        safetyBoundary: profile.safetyBoundary,
      })),
    };
  }

  updateStyleProfile(
    projectId: string,
    body: Record<string, unknown>,
    principal: SessionPrincipal,
  ): Record<string, unknown> {
    const project = this.resources.projectRow(projectId);
    const raw = isRecord(body.values) ? body.values : body;
    const current = parseJson<Record<string, unknown>>(project.style_profile_json, {});
    const baseStyleProfileId = typeof raw.baseStyleProfileId === 'string'
      ? raw.baseStyleProfileId
      : typeof raw.styleProfileId === 'string'
        ? raw.styleProfileId
        : typeof current.baseStyleProfileId === 'string'
          ? current.baseStyleProfileId
          : undefined;
    if (baseStyleProfileId && !BUILTIN_STYLE_MAP.has(baseStyleProfileId)) {
      throw new BadRequestException('未知的内置风格画像');
    }
    const parameterInput = isRecord(raw.parameterValues)
      ? raw.parameterValues
      : Object.fromEntries(Object.entries(raw).filter(([key]) => CORE_PARAMETER_IDS.has(key)));
    const incomingParameterValues = normalizeParameterValues(parameterInput, {
      partial: true,
      rejectUnknown: true,
    }).values;
    const currentParameterValues = normalizeParameterValues(current.parameterValues, {
      partial: true,
      clamp: true,
    }).values;
    const parameterValues = { ...currentParameterValues, ...incomingParameterValues };
    if (typeof raw.preferredTone === 'string' && raw.preferredTone.trim()) {
      parameterValues.expression_voice = raw.preferredTone.trim().slice(0, 1_000);
    }
    const config = isRecord(raw.config)
      ? safeCoreOverrides(raw.config)
      : isRecord(current.config)
        ? current.config
        : {};
    const next = {
      baseStyleProfileId,
      parameterValues,
      config,
      preferredTone: typeof raw.preferredTone === 'string' ? raw.preferredTone.trim().slice(0, 1_000) : current.preferredTone,
      preferredStructures: raw.preferredStructures === undefined ? stringArray(current.preferredStructures) : stringArray(raw.preferredStructures),
      avoidedPatterns: raw.avoidedPatterns === undefined ? stringArray(current.avoidedPatterns) : stringArray(raw.avoidedPatterns),
      examples: raw.examples === undefined ? stringArray(current.examples) : stringArray(raw.examples),
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2_000) : current.notes,
      updatedBy: principal.userId,
    };
    const now = nowIso();
    this.database
      .prepare(
        `UPDATE projects SET style_profile_json=?, style_profile_version=style_profile_version+1,
          style_profile_updated_at=?, updated_at=? WHERE id=?`,
      )
      .run(JSON.stringify(next), now, now, projectId);
    this.record(project, principal, 'style-profile.update', projectId, {
      previousVersion: Number(project.style_profile_version ?? 1), baseStyleProfileId,
    });
    return this.styleProfile(projectId);
  }

  resolve(projectId: string, raw: Record<string, unknown>, principal: SessionPrincipal): ConfigResolutionResult {
    const projectRow = this.resources.projectRow(projectId);
    const presetId = typeof raw.presetId === 'string' && raw.presetId ? raw.presetId : this.defaultId(projectId);
    const preset = this.get(projectId, presetId);
    const styleProfile = parseJson<Record<string, unknown>>(projectRow.style_profile_json, {});
    const warnings: string[] = [];
    const conflicts: Array<Record<string, unknown>> = [];
    const sourceMap: Record<string, string> = {};
    const legacyConfig = isRecord(raw.config) ? raw.config : {};

    const formulaVersion = this.formulaForRequest(projectId, raw, legacyConfig);
    const defaults = createDefaultGenerationConfig(projectForConfig(projectRow), formulaVersion);
    defaults.task.theme = typeof raw.topic === 'string' && raw.topic.trim()
      ? raw.topic.trim().slice(0, 500)
      : '配置预览主题';
    defaults.knowledge.maxInputTokens = Math.max(8_000, this.options.knowledgeContextTokens);
    const formulaConfig = safeCoreOverrides(this.formulas.get(formulaVersion.id).config ?? {});
    const workspaceId = String(projectRow.workspace_id);
    const workspaceConfig = this.settings.workspaceConfig(workspaceId);
    const providerDefaults = this.settings.provider(workspaceId, principal.userId);
    let config = resolveGenerationConfig(defaults, {
      system: {
        ...formulaConfig,
        knowledge: {
          ...(isRecord(formulaConfig.knowledge) ? formulaConfig.knowledge : {}),
          maxInputTokens: this.options.knowledgeContextTokens,
        },
      },
      workspace: {
        ...workspaceConfig,
        model: {
          ...(isRecord(workspaceConfig.model) ? workspaceConfig.model : {}),
          temperature: providerDefaults.temperature,
        },
      },
      project: this.settings.projectConfig(projectId),
    });
    if (isRecord(styleProfile.config)) {
      config = resolveGenerationConfig(config, { task: safeCoreOverrides(styleProfile.config) });
    }

    const legacy = legacyParameterValues(raw, legacyConfig, warnings);
    const presetDifference = preset.source === 'custom' ? preset.difference ?? {} : {};
    const styleValues = normalizeParameterValues(styleProfile.parameterValues, { partial: true, clamp: true });
    warnings.push(...styleValues.warnings);
    const configValues = normalizeParameterValues(legacyConfig.parameterValues, { partial: true, clamp: true });
    warnings.push(...configValues.warnings);
    const explicitValues = normalizeParameterValues(raw.parameterValues, { partial: true, clamp: true });
    warnings.push(...explicitValues.warnings);
    const topOverrides = isRecord(raw.overrides) ? raw.overrides : {};
    const coreOverrideLayers = [
      isRecord(legacyConfig.overrides) ? safeCoreOverrides(legacyConfig.overrides) : {},
      safeCoreOverrides(Object.fromEntries(Object.entries(topOverrides).filter(([key]) => !CORE_PARAMETER_IDS.has(key)))),
      isRecord(raw.configOverrides) ? safeCoreOverrides(raw.configOverrides) : {},
    ];
    const topParameterValues = normalizeParameterValues(
      Object.fromEntries(Object.entries(topOverrides).filter(([key]) => CORE_PARAMETER_IDS.has(key))),
      { partial: true, clamp: true },
    );
    warnings.push(...topParameterValues.warnings);

    const parameterOverrides: Record<string, ParameterValue> = {};
    applyValues(parameterOverrides, presetDifference, preset.source === 'custom' ? 'custom-preset' : 'preset', sourceMap);
    applyValues(parameterOverrides, styleValues.values, 'style-profile', sourceMap);
    applyValues(parameterOverrides, legacy.values, 'legacy-config', sourceMap);
    applyValues(parameterOverrides, configValues.values, 'config-parameter-values', sourceMap);
    applyValues(parameterOverrides, explicitValues.values, 'parameter-values', sourceMap);
    applyValues(parameterOverrides, topParameterValues.values, 'task-overrides', sourceMap);
    const corePathValues = normalizeParameterValues(parametersFromCoreLayers(coreOverrideLayers), {
      partial: true,
      clamp: true,
    });
    warnings.push(...corePathValues.warnings);
    applyValues(parameterOverrides, corePathValues.values, 'core-overrides', sourceMap);
    // Top-level task fields are the human's per-run choices. Apply them after
    // every preset/style/compatibility layer so the final compilation cannot
    // silently restore a saved preset value over the current request.
    const directTaskValues = directTaskParameterValues(raw, warnings);
    applyValues(parameterOverrides, directTaskValues.values, 'task-request', sourceMap);

    const presetBaseId = preset.source === 'builtin' ? preset.id : preset.basePresetId ?? DEFAULT_PRESET_ID;
    const requestedStyleId = typeof raw.styleProfileId === 'string'
      ? raw.styleProfileId
      : typeof styleProfile.baseStyleProfileId === 'string'
        ? styleProfile.baseStyleProfileId
        : undefined;
    if (requestedStyleId && !BUILTIN_STYLE_MAP.has(requestedStyleId)) {
      throw new BadRequestException('未知的内置风格画像');
    }
    const parameterSelection: GenerationParameterSelection = {
      presetId: presetBaseId,
      styleProfileId: requestedStyleId,
      overrides: parameterOverrides,
    };
    let compiled;
    try {
      compiled = compileGenerationParameters(config, formulaVersion, parameterSelection);
    } catch (error) {
      throw new BadRequestException({
        message: '生成参数解析失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    config = compiled.config;

    const compatibility = this.compatibilityLayer(projectId, raw, legacyConfig, config, warnings, conflicts);
    if (Object.keys(compatibility.layer).length) {
      config = resolveGenerationConfig(config, { task: compatibility.layer });
    }
    for (const layer of coreOverrideLayers) {
      if (Object.keys(layer).length) config = resolveGenerationConfig(config, { task: layer });
    }
    config = resolveGenerationConfig(config, { task: taskLayer(raw, config) });
    try {
      compiled = compileGenerationParameters(config, formulaVersion, parameterSelection);
      config = compiled.config;
    } catch (error) {
      throw new BadRequestException({
        message: '最终生成参数解析失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    applyDirectTaskTextOverrides(config, raw);
    applyDirectReaderTaskOverrides(config, raw);
    normalizeReaderTaskFields(config);
    validateResolved(config, conflicts, warnings);

    for (const [id, source] of Object.entries(compiled.resolutionSnapshot.sourceByParameter)) {
      if (!sourceMap[id]) sourceMap[id] = source.sourceId ? `${source.source}:${source.sourceId}` : source.source;
    }
    const impactReport = {
      ...compiled.impactReport,
      warnings: [...compiled.impactReport.warnings, ...warnings],
      compatibilityTraces: compatibility.traces,
      conflicts,
    };
    const directives = [
      ...compiled.impactReport.behaviorInstructions,
      ...compatibility.traces.map((trace) => String(trace.directive)),
    ].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
    const impactPreview = [
      ...compiled.impactReport.parameterTraces
        .filter((trace) => {
          const definition = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === trace.parameterId);
          const source = sourceMap[trace.parameterId] ?? trace.source.source;
          return JSON.stringify(trace.value) !== JSON.stringify(definition?.defaultValue)
            || !['default', 'config'].includes(source);
        })
        .map((trace) => ({
        parameterId: trace.parameterId,
        path: trace.path,
        label: trace.label,
        value: trace.value,
        source: sourceMap[trace.parameterId] ?? trace.source.source,
        directive: trace.behaviorInstructions.join('；'),
        formulaIds: trace.formulaIds,
        risk: trace.evidenceStatus,
        channels: trace.channels,
        })),
      ...compatibility.traces,
    ];
    return {
      schemaVersion: '1.0',
      formulaVersion,
      preset,
      parameterValues: compiled.resolutionSnapshot.values,
      parameterSelection,
      resolvedConfig: config,
      resolutionSnapshot: compiled.resolutionSnapshot,
      conflicts,
      warnings,
      sourceMap,
      directives,
      impactReport,
      impactPreview,
      styleProfileVersion: Number(projectRow.style_profile_version ?? 1),
      styleProfile,
      requestOverrides: {
        parameterValues: explicitValues.values,
        overrides: topOverrides,
        legacyConfig,
      },
    };
  }

  private compatibilityLayer(
    projectId: string,
    raw: Record<string, unknown>,
    legacyConfig: Record<string, unknown>,
    config: ResolvedGenerationConfig,
    warnings: string[],
    conflicts: Array<Record<string, unknown>>,
  ): { layer: Record<string, unknown>; traces: Array<Record<string, unknown>> } {
    const layer: Record<string, unknown> = {};
    const traces: Array<Record<string, unknown>> = [];
    const scope = typeof legacyConfig.knowledgeScope === 'string'
      ? legacyConfig.knowledgeScope
      : typeof raw.knowledgeScope === 'string'
        ? raw.knowledgeScope
        : undefined;
    if (scope) {
      const selected = Array.isArray(raw.selectedFileIds)
        ? raw.selectedFileIds.map(String)
        : Array.isArray(legacyConfig.selectedFileIds)
          ? legacyConfig.selectedFileIds.map(String)
          : [];
      let ids = selected;
      if (scope === 'facts') ids = this.factFileIds(projectId);
      if ((scope === 'facts' || scope === 'selected') && ids.length === 0) {
        conflicts.push({ code: 'EMPTY_KNOWLEDGE_SCOPE', parameterId: 'knowledgeScope', message: '所选知识范围没有可用文件。' });
        ids = ['__empty_knowledge_scope__'];
      }
      layer.knowledge = {
        mode: scope === 'auto' ? 'auto' : 'full',
        selectedFileIds: scope === 'all' || scope === 'auto' ? [] : ids,
      };
      traces.push({ parameterId: 'knowledgeScope', path: 'knowledge', value: scope, source: 'legacy-compatible', directive: `知识范围使用 ${scope}，选中文件 ${ids.length} 个。` });
    }

    const titleStyle = typeof legacyConfig.titleStyle === 'string' ? legacyConfig.titleStyle : undefined;
    if (titleStyle) {
      const titleDirective = titleDirectiveFor(titleStyle);
      layer.expressionWindow = {
        ...config.expressionWindow,
        forms: [...new Set([titleDirective, ...config.expressionWindow.forms])],
        sequence: [titleDirective, ...config.expressionWindow.sequence.filter((item) => item !== titleDirective)],
      };
      traces.push({ parameterId: 'titleStyle', path: 'expressionWindow.forms', value: titleStyle, source: 'legacy-config', directive: titleDirective });
    }
    if (!config.informationWindow.gaps.length) {
      const breadth = config.parameters?.informationBreadth ?? 65;
      layer.informationWindow = {
        ...config.informationWindow,
        gaps: defaultGaps(breadth),
        boundaries: config.informationWindow.boundaries.length
          ? config.informationWindow.boundaries
          : defaultBoundaries(config.parameters?.boundaryVisibility ?? 90),
      };
      traces.push({ parameterId: 'information_breadth', path: 'informationWindow.gaps', value: breadth, source: 'compiled-derivation', directive: `按信息广度形成 ${defaultGaps(breadth).length} 类待补缺口。` });
    }

    const modelLayer: Record<string, unknown> = {};
    if (typeof legacyConfig.model === 'string' && legacyConfig.model !== '项目默认') modelLayer.model = legacyConfig.model;
    if (typeof legacyConfig.temperature === 'number') modelLayer.temperature = clamp(legacyConfig.temperature, 0, 2);
    if (typeof legacyConfig.maxOutputTokens === 'number') modelLayer.maxOutputTokens = Math.floor(clamp(legacyConfig.maxOutputTokens, 1_000, 32_000));
    if (Object.keys(modelLayer).length) {
      layer.model = modelLayer;
      traces.push({ parameterId: 'model-runtime', path: 'model', value: modelLayer, source: 'legacy-config', directive: '运行时模型参数已真实写入底层配置。' });
    }
    if (legacyConfig.repairRounds === 0 || legacyConfig.repairRounds === 1 || legacyConfig.repairRounds === 2) {
      layer.generation = { maxRepairAttempts: legacyConfig.repairRounds };
      traces.push({ parameterId: 'repairRounds', path: 'generation.maxRepairAttempts', value: legacyConfig.repairRounds, source: 'legacy-config', directive: `最多自动修复 ${legacyConfig.repairRounds} 轮。` });
    }
    if (legacyConfig.evidenceMode === 'strict' || legacyConfig.evidenceMode === 'balanced' || legacyConfig.evidenceMode === 'creative') {
      layer.diagnostics = {
        ...config.diagnostics,
        requireEvidenceReferences: legacyConfig.evidenceMode !== 'creative',
        rejectUnknownAsFact: true,
        rejectProhibitedClaims: true,
      };
    }
    if (typeof legacyConfig.knowledgeScope === 'string' && !['all', 'auto', 'facts', 'selected'].includes(legacyConfig.knowledgeScope)) {
      warnings.push(`未知 knowledgeScope：${legacyConfig.knowledgeScope}，已沿用默认知识范围。`);
    }
    return { layer, traces };
  }

  private factFileIds(projectId: string): string[] {
    return (this.database
      .prepare(
        `WITH ranked AS (
           SELECT id, filename, category, metadata_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY filename
                    ORDER BY version DESC, created_at DESC, id DESC
                  ) AS version_rank
           FROM knowledge_files
           WHERE project_id=? AND deleted_at IS NULL
         )
         SELECT id, category, metadata_json FROM ranked
         WHERE version_rank=1 ORDER BY filename`,
      )
      .all(projectId) as unknown as Array<Record<string, unknown>>)
      .filter((row) => {
        const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
        return /fact|事实|constraint|约束|prohibit|禁止/u.test(`${row.category} ${metadata.kind ?? ''}`.toLowerCase());
      })
      .map((row) => String(row.id));
  }

  private formulaForRequest(
    projectId: string,
    raw: Record<string, unknown>,
    legacyConfig: Record<string, unknown>,
  ): FormulaVersion {
    const id = typeof raw.formulaVersion === 'string'
      ? raw.formulaVersion
      : typeof legacyConfig.formulaVersion === 'string'
        ? legacyConfig.formulaVersion
        : '';
    if (!id || id === 'active' || id === '项目默认') return this.formulas.active(projectId);
    const stored = this.formulas.get(id);
    if (stored.row.project_id !== projectId) throw new BadRequestException('公式版本不属于当前项目');
    return stored.version;
  }

  private publicBuiltin(projectId: string, presetId: string, defaultId: string): PublicPreset {
    const preset = BUILTIN_PRESET_MAP.get(presetId);
    if (!preset) throw new NotFoundException('内置预设不存在');
    return {
      id: preset.id,
      projectId,
      name: preset.label,
      description: preset.description,
      source: 'builtin',
      isDefault: preset.id === defaultId,
      values: structuredClone(preset.parameterValues),
      instructions: [...preset.behaviorInstructions],
      evidenceStatus: preset.evidenceStatus,
      noviceExplanation: preset.noviceExplanation,
    };
  }

  private publicCustom(row: PresetRow, defaultId: string): PublicPreset {
    const base = BUILTIN_PRESET_MAP.get(row.base_preset_id) ?? BUILTIN_PRESET_MAP.get(DEFAULT_PRESET_ID)!;
    const difference = parseJson<Record<string, ParameterValue>>(row.values_json, {});
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description,
      source: 'custom',
      isDefault: row.id === defaultId,
      values: { ...structuredClone(base.parameterValues), ...difference },
      basePresetId: base.id,
      difference,
      instructions: [...base.behaviorInstructions],
      evidenceStatus: 'user_choice',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private defaultId(projectId: string): string {
    const row = this.database
      .prepare('SELECT preset_id FROM project_preset_defaults WHERE project_id=?')
      .get(projectId) as { preset_id: string } | undefined;
    if (!row) return DEFAULT_PRESET_ID;
    if (BUILTIN_PRESET_MAP.has(row.preset_id)) return row.preset_id;
    const exists = this.database
      .prepare('SELECT 1 FROM generation_presets WHERE id=? AND project_id=? AND deleted_at IS NULL')
      .get(row.preset_id, projectId);
    return exists ? row.preset_id : DEFAULT_PRESET_ID;
  }

  private row(projectId: string, presetId: string): PresetRow {
    const row = this.database
      .prepare(
        `SELECT * FROM generation_presets
         WHERE id=? AND project_id=? AND deleted_at IS NULL`,
      )
      .get(presetId, projectId) as unknown as PresetRow | undefined;
    if (!row) throw new NotFoundException('预设不存在');
    return row;
  }

  private record(
    project: Record<string, unknown>,
    principal: SessionPrincipal,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): void {
    this.audit.record({
      workspaceId: String(project.workspace_id),
      userId: principal.userId,
      action,
      entityType: action.startsWith('style-profile') ? 'project' : 'generation_preset',
      entityId,
      details,
    });
  }
}

function legacyParameterValues(
  raw: Record<string, unknown>,
  config: Record<string, unknown>,
  warnings: string[],
): { values: Record<string, ParameterValue> } {
  const values: Record<string, ParameterValue> = {};
  const setNumber = (legacy: string, target: string, transform: (value: number) => number = (value) => value) => {
    if (typeof config[legacy] === 'number' && Number.isFinite(config[legacy])) values[target] = transform(config[legacy] as number);
  };
  setNumber('informationBreadth', 'information_breadth', (value) => clamp(value, 0, 100));
  setNumber('informationDepth', 'decision_information_depth', (value) => clamp(value, 0, 100));
  setNumber('expressionFreedom', 'novelty_angle', (value) => clamp(value, 0, 100));
  if (typeof config.vigilanceLevel === 'number') {
    const value = clamp(config.vigilanceLevel, 0, 100);
    values.evidence_strictness = value;
    values.boundary_visibility = value;
  }
  if (typeof config.bodyLength === 'number') {
    const range = bodyRangeFor(clamp(config.bodyLength, 60, 2_000));
    values.body_min_chars = range.min;
    values.body_max_chars = range.max;
  }
  if (typeof config.commentThreads === 'number') {
    const value = Math.floor(clamp(config.commentThreads, 0, 30));
    values.comment_thread_min = value;
    values.comment_thread_max = value;
  }
  if (typeof config.tone === 'string' && config.tone.trim()) values.expression_voice = toneFor(config.tone);
  if (config.evidenceMode === 'strict') {
    values.evidence_strictness = 95;
    values.boundary_visibility = 95;
  } else if (config.evidenceMode === 'balanced') {
    values.evidence_strictness = 85;
    values.boundary_visibility = 85;
  } else if (config.evidenceMode === 'creative') {
    values.evidence_strictness = 65;
    values.boundary_visibility = 75;
  }
  if (typeof raw.audienceStage === 'string') values.audience_stage = stage(raw.audienceStage);
  if (typeof raw.entryPoint === 'string') values.entry_route = entry(raw.entryPoint);
  if (Array.isArray(raw.informationGaps)) values.information_gaps = raw.informationGaps.map(String);
  const normalized = normalizeParameterValues(values, { partial: true, clamp: true });
  warnings.push(...normalized.warnings);
  return { values: normalized.values };
}

function directTaskParameterValues(
  raw: Record<string, unknown>,
  warnings: string[],
): { values: Record<string, ParameterValue> } {
  const values: Record<string, ParameterValue> = {};
  if (Object.prototype.hasOwnProperty.call(raw, 'audienceStage') && typeof raw.audienceStage === 'string') {
    values.audience_stage = stage(raw.audienceStage);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'entryPoint') && typeof raw.entryPoint === 'string') {
    values.entry_route = entry(raw.entryPoint);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'mustInclude')) {
    values.must_mention = lines(raw.mustInclude);
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'forbidden')) {
    values.forbidden_phrases = lines(raw.forbidden);
  }
  const normalized = normalizeParameterValues(values, { partial: true, clamp: true });
  warnings.push(...normalized.warnings);
  return { values: normalized.values };
}

function applyDirectTaskTextOverrides(
  config: ResolvedGenerationConfig,
  raw: Record<string, unknown>,
): void {
  for (const key of ['city', 'doctor'] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    config.task[key] = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
}

function applyDirectReaderTaskOverrides(
  config: ResolvedGenerationConfig,
  raw: Record<string, unknown>,
): void {
  const task = config.task as unknown as Record<string, unknown>;
  for (const key of ['preContactKnown', 'readerConstraints'] as const) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    task[key] = raw[key] ?? [];
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'readerHistory')) return;
  if (raw.readerHistory === undefined || raw.readerHistory === null) delete task.readerHistory;
  else task.readerHistory = raw.readerHistory;
}

const READER_TASK_LIST_MAX_ITEMS = 50;
const READER_TASK_ITEM_MAX_CHARS = 500;

function normalizedReaderTaskList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an array of strings.`);
  }
  if (value.length > READER_TASK_LIST_MAX_ITEMS) {
    throw new BadRequestException(`${field} may contain at most ${READER_TASK_LIST_MAX_ITEMS} items.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new BadRequestException(`${field} must contain only strings.`);
    }
    const text = item.trim();
    if (!text) continue;
    if (text.length > READER_TASK_ITEM_MAX_CHARS) {
      throw new BadRequestException(`${field} items may contain at most ${READER_TASK_ITEM_MAX_CHARS} characters.`);
    }
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeReaderTaskFields(config: ResolvedGenerationConfig): void {
  const task = config.task as unknown as Record<string, unknown>;
  task.preContactKnown = normalizedReaderTaskList(task.preContactKnown ?? [], 'preContactKnown');
  task.readerConstraints = normalizedReaderTaskList(task.readerConstraints ?? [], 'readerConstraints');
  if (task.readerHistory === undefined || task.readerHistory === null) {
    delete task.readerHistory;
    return;
  }
  task.readerHistory = normalizedReaderTaskList(task.readerHistory, 'readerHistory');
}

function taskLayer(raw: Record<string, unknown>, current: ResolvedGenerationConfig): Record<string, unknown> {
  const topic = typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim().slice(0, 500) : current.task.theme;
  if (!topic) throw new BadRequestException('内容主题不能为空');
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  const optionalTaskText = (key: 'city' | 'doctor', currentValue: string | undefined): string | undefined => {
    if (!has(key)) return currentValue;
    const value = raw[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  return {
    task: {
      theme: topic,
      goal: typeof raw.goal === 'string' && raw.goal.trim() ? raw.goal.trim() : current.task.goal,
      audienceStage: typeof raw.audienceStage === 'string' ? stage(raw.audienceStage) : current.task.audienceStage,
      entry: typeof raw.entryPoint === 'string' ? entry(raw.entryPoint) : current.task.entry,
      city: optionalTaskText('city', current.task.city),
      doctor: optionalTaskText('doctor', current.task.doctor),
      mustMention: has('mustInclude') ? lines(raw.mustInclude) : current.task.mustMention,
      forbidden: has('forbidden') ? lines(raw.forbidden) : current.task.forbidden,
    },
    generation: {
      baseSeed: typeof raw.seed === 'number' && Number.isFinite(raw.seed)
        ? Math.floor(raw.seed)
        : randomBytes(4).readUInt32BE(0),
    },
  };
}

function projectForConfig(row: Record<string, unknown>): ResolvedGenerationConfig['project'] {
  const profile = parseJson<Record<string, unknown>>(row.profile_json, {});
  return {
    id: String(row.id),
    name: String(row.name),
    domain: typeof profile.domain === 'string' ? profile.domain : '',
    productPoints: stringArray(profile.productPoints ?? profile.product_points),
    organizationPoints: stringArray(profile.organizationPoints ?? profile.org_points),
    cities: stringArray(profile.cities),
    doctors: Array.isArray(profile.doctors)
      ? profile.doctors.filter(isRecord).map((doctor) => ({
          id: typeof doctor.id === 'string' ? doctor.id : undefined,
          name: String(doctor.name ?? ''),
          points: stringArray(doctor.points),
        })).filter((doctor) => doctor.name)
      : [],
  };
}

function validateResolved(
  config: ResolvedGenerationConfig,
  conflicts: Array<Record<string, unknown>>,
  warnings: string[],
): void {
  if (config.content.bodyMinChars > config.content.bodyMaxChars) {
    conflicts.push({ code: 'INVALID_BODY_RANGE', message: '正文最小字数大于最大字数。' });
  }
  if (config.content.commentThreadMin > config.content.commentThreadMax) {
    conflicts.push({ code: 'INVALID_COMMENT_RANGE', message: '评论线程最小值大于最大值。' });
  }
  if (config.content.bodyMaxChars <= 170 && config.informationWindow.gaps.length >= 5 && config.content.commentThreadMax <= 1) {
    warnings.push('正文较短、信息缺口较多且评论窗口很小，部分信息可能没有可见承载位置。');
  }
}

function applyValues(
  target: Record<string, ParameterValue>,
  layer: Record<string, ParameterValue>,
  source: string,
  sourceMap: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(layer)) {
    target[key] = structuredClone(value);
    sourceMap[key] = source;
  }
}

function differenceFrom(
  base: Record<string, ParameterValue>,
  target: Record<string, ParameterValue>,
): Record<string, ParameterValue> {
  return Object.fromEntries(
    Object.entries(target).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(base[key])),
  );
}

function safeCoreOverrides(value: Record<string, unknown>): Record<string, unknown> {
  const result = safeClone(value);
  delete result.schemaVersion;
  delete result.project;
  if (isRecord(result.formula)) delete result.formula.versionId;
  if (isRecord(result.generation)) delete result.generation.candidateCount;
  return result;
}

function safeClone(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || item === undefined) continue;
    if (Array.isArray(item)) result[key] = structuredClone(item);
    else if (isRecord(item)) result[key] = safeClone(item);
    else result[key] = item;
  }
  return result;
}

function parametersFromCoreLayers(layers: Record<string, unknown>[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const definition of GENERATION_PARAMETER_REGISTRY) {
      const value = getPath(layer, definition.path);
      if (value !== undefined) values[definition.id] = value;
    }
  }
  return values;
}

function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(part) || !isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(/[\n,，、;；]/u).map((item) => item.trim()).filter(Boolean);
}

function stage(value: string): ResolvedGenerationConfig['task']['audienceStage'] {
  return ({
    发现期: 'discovering', discovering: 'discovering', 收集期: 'collecting', collecting: 'collecting',
    比较期: 'comparing', comparing: 'comparing', 犹豫期: 'hesitating', hesitating: 'hesitating',
    行动期: 'ready', ready: 'ready',
  } as Record<string, ResolvedGenerationConfig['task']['audienceStage']>)[value] ?? 'collecting';
}

function entry(value: string): ResolvedGenerationConfig['task']['entry'] {
  return ({
    搜索: 'search', search: 'search', 标签: 'recommendation', 首页推荐: 'recommendation',
    recommendation: 'recommendation', profile: 'profile', return_visit: 'return_visit',
  } as Record<string, ResolvedGenerationConfig['task']['entry']>)[value] ?? 'search';
}

function bodyRangeFor(target: number): { min: number; max: number } {
  if (target <= 150) return { min: Math.max(60, target - 40), max: target + 50 };
  if (target <= 300) return { min: Math.max(60, target - 40), max: target + 40 };
  return { min: Math.max(60, Math.floor(target * 0.75)), max: Math.floor(target * 1.25) };
}

function toneFor(value: string): string {
  return ({
    真实分享: '第一人称自然短句、克制真实，不虚构生活细节',
    理性功课: '分清事实、条件、比较项和未知的理性功课语气',
    轻松聊天: '口语化、轻松但不轻佻，专业信息保持准确',
    专业解答: '专业、条件化、术语配通俗解释并明确边界',
  } as Record<string, string>)[value] ?? value;
}

function titleDirectiveFor(value: string): string {
  return ({
    疑问与缺口: '标题用具体问题或尚未补齐的信息缺口建立入口承诺',
    经历与转折: '标题呈现经历中的判断转折，但不虚构结果',
    反常识与重构: '标题指出常见认知遗漏，并在正文给出可核验重构',
    清单与方法: '标题明确清单数量、判断步骤或可执行方法',
  } as Record<string, string>)[value] ?? value;
}

function defaultGaps(breadth: number): string[] {
  const gaps = [
    '适用条件与不适用边界', '方案或选择之间的关键差异', '证据如何核验',
    '恢复、成本、风险与时间窗口', '常见误区与反例', '下一步应该向谁核实什么',
  ];
  return gaps.slice(0, breadth < 25 ? 1 : breadth < 50 ? 2 : breadth < 75 ? 3 : breadth < 90 ? 5 : 6);
}

function defaultBoundaries(visibility: number): string[] {
  if (visibility >= 70) return ['关键结论必须同时显示适用条件、限制、反例和未知信息'];
  if (visibility >= 40) return ['说明适用范围与个体差异'];
  return ['保留必要事实边界'];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
