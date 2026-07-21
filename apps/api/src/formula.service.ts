import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FORMULA_VERSION,
  F30_MIGRATION_DESCRIPTOR,
  F32_F33_MIGRATION_DESCRIPTOR,
  createFormulaVersion,
  evaluateFormulaDefinition,
  formulaExecutionAudit,
  isLegacyOfficialF30,
  isLegacyOfficialF32OrF33,
  resolveFormulaExecution,
  validateFormulaVersion,
  type FormulaCalculatorContract,
  type FormulaDefinition,
  type FormulaVersion,
} from '@content-agent/agent-core';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import type { SessionPrincipal } from './models.js';
import { nowIso } from './utils.js';

interface FormulaRow {
  id: string;
  project_id: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  definition_json: string;
  created_by: string;
  created_at: string;
  activated_at: string | null;
}

interface StoredFormulaDefinition {
  name: string;
  description: string;
  version: FormulaVersion;
  config?: Record<string, unknown>;
}

interface FormulaStorageIssue {
  path: string;
  code: string;
  message: string;
}

const PLANNING_FORMULA_IDS = new Set(['F38', 'F39', 'F40', 'F41', 'F42', 'F43']);

type FormulaCalculationIssueCode =
  | 'required_input_missing'
  | 'invalid_type'
  | 'invalid_value'
  | 'empty_value'
  | 'source_ref_hashtag_only'
  | 'source_ref_not_specific'
  | 'observed_at_invalid_format'
  | 'observed_at_invalid_value'
  | 'out_of_range'
  | 'unit_required'
  | 'unit_mismatch'
  | 'unknown_variable'
  | 'calculation_warning';

export interface FormulaCalculationIssue {
  path: string;
  code: FormulaCalculationIssueCode;
  message: string;
}

export interface FormulaCalculationResponse {
  formulaVersionId: string;
  formulaVersionDigest: string;
  formulaId: string;
  status: 'computed' | 'unknown' | 'invalid';
  value: number | null;
  unit: string | null;
  unknownPaths: string[];
  issues: FormulaCalculationIssue[];
  calculatorContract?: FormulaCalculatorContract;
  calculationOnly: true;
  directGeneration: false;
  consumedBy: {
    generation: false;
    planning: false;
    candidateSelection: false;
    validation: false;
    reachPrediction: false;
  };
  resultSemantics: 'manual_conditional_calculation';
  boundary: {
    explicitInputsOnly: true;
    usesLivePlatformData: false;
    predictsReach: false;
    predictsQualifiedReach: false;
    comparesHotTopicRankings: false;
  };
}

@Injectable()
export class FormulaService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  ensureDefault(projectId: string, principal: SessionPrincipal): FormulaVersion {
    const existing = this.database
      .prepare("SELECT * FROM formula_versions WHERE project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(projectId) as unknown as FormulaRow | undefined;
    if (existing) {
      const stored = this.parse(existing);
      return this.ensureReviewedDefaults(projectId, existing, stored, principal);
    }

    const latest = this.database
      .prepare('SELECT * FROM formula_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as unknown as FormulaRow | undefined;
    if (latest) {
      const stored = this.parse(latest);
      return this.ensureReviewedDefaults(projectId, latest, stored, principal);
    }

    const id = randomUUID();
    const createdAt = nowIso();
    const version = createFormulaVersion({
      id,
      projectId,
      version: '1.0.0',
      status: 'active',
      createdAt,
      formulas: DEFAULT_FORMULA_VERSION.formulas,
    });
    const stored: StoredFormulaDefinition = {
      name: '完整文案公式',
      description: 'F01–F43 默认方法论种子',
      version,
      config: {},
    };
    this.database
      .prepare(
        `INSERT INTO formula_versions
          (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
         VALUES (?, ?, 1, 'active', ?, ?, ?, ?)`,
      )
      .run(id, projectId, JSON.stringify(stored), principal.userId, createdAt, createdAt);
    return version;
  }

  private ensureReviewedDefaults(
    projectId: string,
    baseRow: FormulaRow,
    base: StoredFormulaDefinition,
    principal: SessionPrincipal,
  ): FormulaVersion {
    const present = new Set(base.version.formulas.map((formula) => formula.id));
    const missing = DEFAULT_FORMULA_VERSION.formulas.filter(
      (formula) => PLANNING_FORMULA_IDS.has(formula.id) && !present.has(formula.id),
    );
    const storedF30 = base.version.formulas.find((formula) => formula.id === 'F30');
    const replacementIds: FormulaDefinition['id'][] = [
      ...(storedF30 && isLegacyOfficialF30(storedF30) ? ['F30' as const] : []),
      ...base.version.formulas
        .filter(isLegacyOfficialF32OrF33)
        .map((formula) => formula.id),
    ];
    if (!missing.length && !replacementIds.length) return base.version;
    return this.upgradeReviewedDefaults(projectId, baseRow, base, missing, replacementIds, principal);
  }

  private upgradeReviewedDefaults(
    projectId: string,
    baseRow: FormulaRow,
    base: StoredFormulaDefinition,
    missing: FormulaDefinition[],
    replacementIds: FormulaDefinition['id'][],
    principal: SessionPrincipal,
  ): FormulaVersion {
    const replacements = new Map(
      replacementIds.map((formulaId) => {
        const replacement = DEFAULT_FORMULA_VERSION.formulas.find((formula) => formula.id === formulaId);
        if (!replacement) throw new BadRequestException(`找不到 ${formulaId} 的已复核默认定义`);
        return [formulaId, replacement] as const;
      }),
    );
    const migrated = base.version.formulas.map((formula) => replacements.get(formula.id) ?? formula);
    const nextNumber = Number(
      (this.database.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS value FROM formula_versions WHERE project_id = ?',
      ).get(projectId) as { value: number }).value,
    );
    const id = randomUUID();
    const createdAt = nowIso();
    const version = createFormulaVersion({
      id,
      projectId,
      parentId: base.version.id,
      version: `${nextNumber}.0.0`,
      status: 'active',
      createdAt,
      formulas: [...migrated, ...missing],
    });
    const issues = validateFormulaVersion(version);
    if (issues.length) throw new BadRequestException({ message: '公式自动升级校验失败', issues });
    const stored: StoredFormulaDefinition = {
      name: base.name,
      description: `${base.description || '项目公式'}；从 ${base.version.version} 派生并同步已复核默认能力`,
      version,
      config: base.config ?? {},
    };
    const invalidatedReleaseIds = (this.database.prepare(
      `SELECT id FROM release_manifests
       WHERE project_id=? AND status='active'
         AND (formula_version_id IS NULL OR formula_version_id<>? OR formula_digest<>?)`,
    ).all(projectId, id, version.digest) as Array<{ id: string }>).map((row) => row.id);
    this.database.transaction(() => {
      this.database.prepare(
        "UPDATE formula_versions SET status='archived' WHERE project_id=? AND status='active'",
      ).run(projectId);
      this.database.prepare(
        `INSERT INTO formula_versions
         (id, project_id, version, status, definition_json, created_by, created_at, activated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(id, projectId, nextNumber, JSON.stringify(stored), principal.userId, createdAt, createdAt);
      this.database.prepare(
        `UPDATE release_manifests SET status='archived'
         WHERE project_id=? AND status='active'
           AND (formula_version_id IS NULL OR formula_version_id<>? OR formula_digest<>?)`,
      ).run(projectId, id, version.digest);
    });
    const project = this.database.prepare('SELECT workspace_id FROM projects WHERE id=?').get(projectId) as { workspace_id: string };
    this.audit.record({
      workspaceId: project.workspace_id,
      userId: principal.userId,
      action: 'formula.auto-upgrade',
      entityType: 'formula_version',
      entityId: id,
      details: {
        projectId,
        parentId: baseRow.id,
        invalidatedReleaseIds,
        addedFormulaIds: missing.map((formula) => formula.id),
        replacedFormulaIds: replacementIds,
        ...(replacementIds.includes('F30') ? { f30Migration: F30_MIGRATION_DESCRIPTOR } : {}),
        ...(replacementIds.some((formulaId) => formulaId === 'F32' || formulaId === 'F33')
          ? {
              f32F33Migration: {
                ...F32_F33_MIGRATION_DESCRIPTOR,
                migratedFormulaIds: replacementIds.filter((formulaId) => formulaId === 'F32' || formulaId === 'F33'),
              },
            }
          : {}),
      },
    });
    return version;
  }

  list(projectId: string): Record<string, unknown>[] {
    const rows = this.database
      .prepare('SELECT * FROM formula_versions WHERE project_id = ? ORDER BY version DESC')
      .all(projectId) as unknown as FormulaRow[];
    return rows.map((row) => this.publicRow(row));
  }

  get(id: string): StoredFormulaDefinition & { row: FormulaRow } {
    const row = this.database.prepare('SELECT * FROM formula_versions WHERE id = ?').get(id) as unknown as FormulaRow | undefined;
    if (!row) throw new NotFoundException('公式版本不存在');
    return { ...this.parse(row), row };
  }

  active(projectId: string): FormulaVersion {
    const row = this.database
      .prepare("SELECT * FROM formula_versions WHERE project_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1")
      .get(projectId) as unknown as FormulaRow | undefined;
    if (!row) throw new NotFoundException('项目没有启用的公式版本');
    return this.parse(row).version;
  }

  calculate(
    versionId: string,
    formulaId: string,
    rawVariables: Record<string, unknown>,
  ): FormulaCalculationResponse {
    const stored = this.get(versionId);
    const formula = stored.version.formulas.find((candidate) => candidate.id === formulaId);
    if (!formula) throw new NotFoundException('该公式版本中不存在指定公式');

    const execution = resolveFormulaExecution(formula, [formula.id]);
    const isReviewedConditionalCalculator = execution.compatibilityStatus === 'reviewed'
      && execution.handlerState === 'enabled'
      && execution.registration?.implementationStatus === 'conditional'
      && execution.registration.executionRoles.includes('conditional-calculator')
      && execution.effectiveHandlers.calculator.length > 0;
    if (!isReviewedConditionalCalculator) {
      throw new BadRequestException({
        message: '该公式不是已复核且已启用的条件计算器',
        code: 'FORMULA_CALCULATOR_NOT_AVAILABLE',
        formulaId,
        compatibilityStatus: execution.compatibilityStatus,
        handlerState: execution.handlerState,
      });
    }

    const declaredPaths = new Set(formula.variables.map((variable) => variable.path));
    const variables: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const inputIssues: FormulaCalculationIssue[] = [];
    for (const [path, value] of Object.entries(rawVariables)) {
      if (!declaredPaths.has(path)) {
        inputIssues.push({ path, code: 'unknown_variable', message: `变量 ${path} 不在 ${formula.id} 的已复核输入契约中。` });
        continue;
      }
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        inputIssues.push({ path, code: 'invalid_type', message: `变量 ${path} 必须是 JSON 基本类型。` });
        continue;
      }
      if (typeof value === 'number' && !Number.isFinite(value)) {
        inputIssues.push({ path, code: 'invalid_type', message: `变量 ${path} 必须是有限数值。` });
        continue;
      }
      variables[path] = value;
    }

    const result = evaluateFormulaDefinition(formula, variables);
    const issues = [
      ...inputIssues,
      ...result.unknownPaths.map((path): FormulaCalculationIssue => ({
        path,
        code: 'required_input_missing',
        message: `缺少必需变量 ${path}，结果保持 unknown。`,
      })),
      ...result.warnings.map((warning) => this.calculationWarningIssue(formula, warning)),
    ];
    if (result.value === null && result.unknownPaths.length === 0 && issues.length === 0) {
      issues.push({
        path: '$.variables',
        code: 'calculation_warning',
        message: '输入未通过公式条件，计算结果保持 unknown。',
      });
    }

    const hasInvalidIssue = issues.some((issue) => issue.code !== 'required_input_missing');
    const status: FormulaCalculationResponse['status'] = hasInvalidIssue
      ? 'invalid'
      : result.unknownPaths.length > 0 || result.value === null
        ? 'unknown'
        : 'computed';
    const value = status === 'computed' && typeof result.value === 'number' ? result.value : null;
    if (status === 'computed' && value === null) {
      issues.push({
        path: '$.result',
        code: 'calculation_warning',
        message: '条件计算器未返回数值结果。',
      });
    }

    return {
      formulaVersionId: stored.version.id,
      formulaVersionDigest: stored.version.digest,
      formulaId: formula.id,
      status: status === 'computed' && value === null ? 'invalid' : status,
      value,
      unit: status === 'computed' && formula.id === 'F17'
        ? String(variables.regretBeforeUnit ?? '').trim() || null
        : null,
      unknownPaths: [...result.unknownPaths],
      issues: this.uniqueCalculationIssues(issues),
      ...(result.calculatorContract
        ? { calculatorContract: structuredClone(result.calculatorContract) }
        : {}),
      calculationOnly: true,
      directGeneration: false,
      consumedBy: {
        generation: false,
        planning: false,
        candidateSelection: false,
        validation: false,
        reachPrediction: false,
      },
      resultSemantics: 'manual_conditional_calculation',
      boundary: {
        explicitInputsOnly: true,
        usesLivePlatformData: false,
        predictsReach: false,
        predictsQualifiedReach: false,
        comparesHotTopicRankings: false,
      },
    };
  }

  private calculationWarningIssue(
    formula: FormulaDefinition,
    warning: string,
  ): FormulaCalculationIssue {
    const variable = [...formula.variables]
      .sort((left, right) => right.path.length - left.path.length)
      .find((candidate) => warning.includes(` ${candidate.path} `));
    if (/one comparable unit/u.test(warning)) {
      return { path: '$.variables', code: 'unit_mismatch', message: warning };
    }
    if (/non-empty comparable unit/u.test(warning)) {
      return { path: variable?.path ?? '$.variables', code: 'unit_required', message: warning };
    }
    if (/must be a non-empty string/u.test(warning)) {
      return { path: variable?.path ?? '$.variables', code: 'empty_value', message: warning };
    }
    if (/must be one of/u.test(warning)) {
      return { path: variable?.path ?? '$.variables', code: 'invalid_value', message: warning };
    }
    if (warning.includes('[source_ref_hashtag_only]')) {
      return { path: variable?.path ?? '$.variables', code: 'source_ref_hashtag_only', message: warning };
    }
    if (warning.includes('[source_ref_not_specific]')) {
      return { path: variable?.path ?? '$.variables', code: 'source_ref_not_specific', message: warning };
    }
    if (warning.includes('[observed_at_invalid_format]')) {
      return { path: variable?.path ?? '$.variables', code: 'observed_at_invalid_format', message: warning };
    }
    if (warning.includes('[observed_at_invalid_value]')) {
      return { path: variable?.path ?? '$.variables', code: 'observed_at_invalid_value', message: warning };
    }
    if (/must be within \[/u.test(warning)) {
      return { path: variable?.path ?? '$.variables', code: 'out_of_range', message: warning };
    }
    if (/Validation error:/u.test(warning)) {
      return { path: variable?.path ?? '$.variables', code: 'invalid_type', message: warning };
    }
    return { path: variable?.path ?? '$.variables', code: 'calculation_warning', message: warning };
  }

  private uniqueCalculationIssues(issues: FormulaCalculationIssue[]): FormulaCalculationIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.path}\u0000${issue.code}\u0000${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  create(
    projectId: string,
    input: Record<string, unknown>,
    principal: SessionPrincipal,
  ): Record<string, unknown> {
    const baseId = typeof input.parentId === 'string' ? input.parentId : undefined;
    const base = baseId
      ? this.get(baseId)
      : this.draftBase(projectId, principal);
    if (base.version.projectId && base.version.projectId !== projectId) {
      throw new BadRequestException('不能跨项目复制公式版本');
    }

    const nextNumber = Number(
      (this.database.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS value FROM formula_versions WHERE project_id = ?').get(projectId) as { value: number }).value,
    );
    const formulas = Array.isArray(input.formulas)
      ? (input.formulas as FormulaDefinition[])
      : base.version.formulas;
    const id = randomUUID();
    const createdAt = nowIso();
    const requestedVersion = typeof input.version === 'string' ? input.version.trim() : '';
    let version: FormulaVersion;
    try {
      version = createFormulaVersion({
        id,
        projectId,
        parentId: base.version.id,
        version: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(requestedVersion)
          ? requestedVersion
          : `${nextNumber}.0.0-draft`,
        status: 'draft',
        createdAt,
        formulas,
      });
    } catch (error) {
      throw new BadRequestException({
        message: '公式 Schema 校验失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const issues = validateFormulaVersion(version);
    if (issues.length) throw new BadRequestException({ message: '公式 Schema 校验失败', issues });
    const stored: StoredFormulaDefinition = {
      name: typeof input.name === 'string' ? input.name : base.name,
      description: typeof input.description === 'string' ? input.description : '从当前启用版本复制',
      version,
      config: input.config && typeof input.config === 'object' ? (input.config as Record<string, unknown>) : base.config,
    };
    this.database
      .prepare(
        `INSERT INTO formula_versions
          (id, project_id, version, status, definition_json, created_by, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(id, projectId, nextNumber, JSON.stringify(stored), principal.userId, createdAt);
    const project = this.database.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(projectId) as { workspace_id: string };
    this.audit.record({ workspaceId: project.workspace_id, userId: principal.userId, action: 'formula.create', entityType: 'formula_version', entityId: id, details: { projectId, version: nextNumber } });
    return this.publicRow(this.get(id).row);
  }

  private draftBase(
    projectId: string,
    principal: SessionPrincipal,
  ): StoredFormulaDefinition & { row: FormulaRow } {
    // Draft creation is not an upgrade command. Reuse any existing project
    // formula without archiving/replacing it; only a truly empty project may
    // bootstrap the reviewed default. Explicit ensure-reviewed-defaults is the
    // sole migration path for legacy official semantics.
    const existing = this.database.prepare(
      `SELECT * FROM formula_versions
       WHERE project_id=?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END,
                version DESC
       LIMIT 1`,
    ).get(projectId) as unknown as FormulaRow | undefined;
    if (existing) return { ...this.parse(existing), row: existing };
    const bootstrapped = this.ensureDefault(projectId, principal);
    return this.get(bootstrapped.id);
  }

  activate(id: string, principal: SessionPrincipal): Record<string, unknown> {
    const item = this.get(id);
    const issues = validateFormulaVersion(item.version);
    if (issues.length) throw new BadRequestException({ message: '公式 Schema 校验失败', issues });
    const now = nowIso();
    const invalidatedReleaseIds = (this.database.prepare(
      `SELECT id FROM release_manifests
       WHERE project_id=? AND status='active'
         AND (formula_version_id IS NULL OR formula_version_id<>? OR formula_digest<>?)`,
    ).all(item.row.project_id, id, item.version.digest) as Array<{ id: string }>).map((row) => row.id);
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE formula_versions SET status = 'archived' WHERE project_id = ? AND status = 'active'")
        .run(item.row.project_id);
      this.database
        .prepare("UPDATE formula_versions SET status = 'active', activated_at = ? WHERE id = ?")
        .run(now, id);
      this.database.prepare(
        `UPDATE release_manifests SET status='archived'
         WHERE project_id=? AND status='active'
           AND (formula_version_id IS NULL OR formula_version_id<>? OR formula_digest<>?)`,
      ).run(item.row.project_id, id, item.version.digest);
    });
    const project = this.database.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(item.row.project_id) as { workspace_id: string };
    this.audit.record({
      workspaceId: project.workspace_id,
      userId: principal.userId,
      action: 'formula.activate',
      entityType: 'formula_version',
      entityId: id,
      details: { projectId: item.row.project_id, invalidatedReleaseIds },
    });
    return this.publicRow(this.get(id).row);
  }

  private parse(row: FormulaRow): StoredFormulaDefinition {
    let raw: unknown;
    try {
      raw = JSON.parse(row.definition_json) as unknown;
    } catch {
      throw this.formulaStorageError(row, [{
        path: '$.definition_json',
        code: 'invalid_json',
        message: '公式版本 definition_json 不是有效 JSON。',
      }]);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw this.formulaStorageError(row, [{
        path: '$.definition_json',
        code: 'invalid_stored_object',
        message: '公式版本 definition_json 根节点必须是对象。',
      }]);
    }

    const stored = raw as Record<string, unknown>;
    if (!stored.version || typeof stored.version !== 'object' || Array.isArray(stored.version)) {
      throw this.formulaStorageError(row, [{
        path: '$.version',
        code: 'invalid_stored_version',
        message: '公式版本存储对象缺少有效的 version 对象。',
      }]);
    }

    const version = stored.version as Record<string, unknown>;
    const shapeIssues: FormulaStorageIssue[] = [];
    if (typeof stored.name !== 'string') {
      shapeIssues.push({ path: '$.name', code: 'invalid_stored_field', message: '公式版本 name 必须是字符串。' });
    }
    if (typeof stored.description !== 'string') {
      shapeIssues.push({ path: '$.description', code: 'invalid_stored_field', message: '公式版本 description 必须是字符串。' });
    }
    if (typeof version.id !== 'string' || !version.id) {
      shapeIssues.push({ path: '$.version.id', code: 'invalid_stored_field', message: '公式版本 id 必须是非空字符串。' });
    }
    if (typeof version.projectId !== 'string' || !version.projectId) {
      shapeIssues.push({ path: '$.version.projectId', code: 'invalid_stored_field', message: '持久化公式版本必须声明非空 projectId。' });
    }
    if (typeof version.version !== 'string') {
      shapeIssues.push({ path: '$.version.version', code: 'invalid_stored_field', message: '公式版本 version 必须是字符串。' });
    }
    if (!['draft', 'active', 'archived'].includes(String(version.status))) {
      shapeIssues.push({ path: '$.version.status', code: 'invalid_stored_field', message: '公式版本 status 无效。' });
    }
    if (typeof version.createdAt !== 'string' || !version.createdAt) {
      shapeIssues.push({ path: '$.version.createdAt', code: 'invalid_stored_field', message: '公式版本 createdAt 必须是非空字符串。' });
    }
    if (version.parentId !== undefined && typeof version.parentId !== 'string') {
      shapeIssues.push({ path: '$.version.parentId', code: 'invalid_stored_field', message: '公式版本 parentId 必须是字符串。' });
    }
    if (!Array.isArray(version.formulas)) {
      shapeIssues.push({ path: '$.version.formulas', code: 'invalid_stored_field', message: '公式版本 formulas 必须是数组。' });
    }
    if (typeof version.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(version.digest)) {
      shapeIssues.push({ path: '$.version.digest', code: 'invalid_digest', message: '公式版本 digest 必须是 64 位小写 SHA-256。' });
    }
    if (shapeIssues.length) throw this.formulaStorageError(row, shapeIssues);

    let validationIssues: FormulaStorageIssue[];
    try {
      validationIssues = validateFormulaVersion(version as unknown as FormulaVersion);
    } catch {
      validationIssues = [{
        path: '$.version',
        code: 'invalid_stored_version',
        message: '公式版本对象无法通过 Schema 校验。',
      }];
    }
    if (version.id !== row.id) {
      validationIssues.push({
        path: '$.version.id',
        code: 'row_id_mismatch',
        message: '公式版本对象的 id 与数据库行 id 不一致。',
      });
    }
    if (version.projectId !== row.project_id) {
      validationIssues.push({
        path: '$.version.projectId',
        code: 'project_binding_mismatch',
        message: '公式版本对象的 projectId 与数据库行 project_id 不一致。',
      });
    }
    if (validationIssues.length) throw this.formulaStorageError(row, validationIssues);

    return stored as unknown as StoredFormulaDefinition;
  }

  private formulaStorageError(row: FormulaRow, issues: FormulaStorageIssue[]): BadRequestException {
    return new BadRequestException({
      message: '公式版本存储完整性校验失败',
      code: 'FORMULA_VERSION_INTEGRITY_ERROR',
      formulaVersionId: row.id,
      issues,
    });
  }

  private publicRow(row: FormulaRow): Record<string, unknown> {
    const stored = this.parse(row);
    const auditScope = {
      kind: 'version-default-capabilities',
      formulaVersionId: stored.version.id,
      formulaVersionDigest: stored.version.digest,
      enabledFormulaMode: 'all-formulas-in-version',
      recordsSingleGenerationRun: false,
      description: '该审计描述公式版本的默认实现能力与控制边界，不代表某次生成任务的实际执行或效果。',
    } as const;
    // Preserve the core audit shape (especially formulaTrace) so existing web
    // readers can inspect it directly while still seeing the API-level scope.
    const executionAudit = {
      ...formulaExecutionAudit(stored.version),
      auditScope,
    };
    return {
      id: row.id,
      projectId: row.project_id,
      version: stored.version.version,
      name: stored.name,
      description: stored.description,
      status: row.status,
      formulaCount: stored.version.formulas.length,
      formulas: stored.version.formulas,
      digest: stored.version.digest,
      config: stored.config ?? {},
      auditScope,
      executionAudit,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
    };
  }
}
