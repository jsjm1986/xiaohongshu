import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FORMULAS,
  DEFAULT_FORMULA_VERSION,
  FORMULA_EXECUTION_HANDLER_REGISTRY,
  FORMULA_EXECUTION_POLICY_DIGEST,
  FORMULA_EXECUTION_POLICY_VERSION,
  GENERATION_PARAMETER_REGISTRY,
  PARAMETER_POLICY_DIGEST,
  PARAMETER_POLICY_VERSION,
  PROMPT_CONTRACT_DIGEST,
  PROMPT_CONTRACT_VERSION,
} from '@content-agent/agent-core';
import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit, PayloadTooLargeException } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { normalizeParameterValues } from './generation-parameters.js';
import type { SessionPrincipal } from './models.js';
import { assertJsonComplexity, nowIso, optionalString, parseJson, requireString, slugify } from './utils.js';

type JsonObject = Record<string, unknown>;
const MAX_RESEARCH_JSON_BYTES = 256 * 1024;
const MAX_RELEASE_BINDINGS_PER_TYPE = 100;

interface CatalogSource {
  id: string;
  kind?: string;
  citation?: string;
  url?: string;
  path?: string;
  supports?: string;
  doesNotSupport?: string;
}

interface CatalogFormula {
  formulaId: string;
  equation?: string;
  currentStatus?: string;
  auditVerdict?: string;
  evidenceClass?: string;
  sourceIds?: string[];
  actualExecution?: string;
  boundary?: string;
  reviewIds?: string[];
  semanticFingerprint?: string;
  executionClass?: string;
  implementedStages?: string[];
}

interface EvidenceCatalog {
  catalogVersion?: string;
  reviewedAt?: string;
  defaultFormulaVersion?: {
    version?: string;
    digest?: string;
  };
  sources?: CatalogSource[];
  formulaEvidence?: CatalogFormula[];
}

@Injectable()
export class ResearchService implements OnModuleInit {
  private readonly catalog = this.loadCatalog();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    const projects = this.database.prepare(
      `SELECT p.id, p.created_by FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL`,
    ).all() as Array<{ id: string; created_by: string }>;
    for (const project of projects) this.bootstrapProject(project.id, project.created_by);
  }

  bootstrapProject(projectId: string, userId: string): void {
    this.project(projectId);
    if (!this.currentCatalogImported(projectId)) this.importCatalog(projectId, userId);
    this.ensureBaselineRelease(projectId, userId);
  }

  overview(projectId: string, principal: SessionPrincipal): JsonObject {
    this.bootstrapProject(projectId, principal.userId);
    const count = (table: string): number => Number((this.database.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE project_id=?`).get(projectId) as { value: number }).value);
    const experimentResults = Number((this.database.prepare(
      `SELECT COUNT(*) AS value FROM experiment_results r JOIN experiment_versions e ON e.id=r.experiment_version_id WHERE e.project_id=?`,
    ).get(projectId) as { value: number }).value);
    const activeRelease = this.activeRelease(projectId);
    return {
      projectId,
      isolationPolicy: {
        researchInjectedIntoPrompt: false,
        experimentsAutoApply: false,
        calibrationRequiresApproval: true,
        runtimeChangesRequireActiveRelease: true,
      },
      catalog: {
        version: this.catalog.data.catalogVersion ?? 'unknown',
        digest: this.catalog.digest,
        sourcePath: this.catalog.path,
      },
      counts: {
        claims: count('research_claims'),
        evidenceSources: count('evidence_sources'),
        datasets: count('dataset_snapshots'),
        experiments: count('experiment_versions'),
        experimentResults,
        calibrationProposals: count('calibration_proposals'),
        releases: count('release_manifests'),
      },
      activeRelease,
      claims: this.listClaims(projectId),
      evidenceSources: this.listSources(projectId),
      datasets: this.listDatasets(projectId),
      experiments: this.listExperiments(projectId),
      calibrationProposals: this.listCalibrations(projectId),
      releases: this.listReleases(projectId),
    };
  }

  listClaims(projectId: string): JsonObject[] {
    return this.rows(
      `SELECT c.*, (SELECT COUNT(*) FROM claim_evidence_links l WHERE l.claim_id=c.id) AS evidence_count
       FROM research_claims c WHERE c.project_id=? ORDER BY c.logical_key, c.version DESC`,
      projectId,
    ).map((row) => this.claim(row));
  }

  createClaim(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const parentId = input.parentId === undefined
      ? undefined
      : requireString(input.parentId, 'parentId', { max: 200 });
    const requestedLogicalKey = parentId
      ? undefined
      : requireString(input.logicalKey ?? slugify(String(input.title ?? '')), 'logicalKey', { max: 120 });
    const id = randomUUID();
    const now = nowIso();
    const claimType = enumValue(input.claimType, ['definition', 'external_research', 'internal_observation', 'inference', 'hypothesis', 'unknown'], 'claimType');
    const title = requireString(input.title, 'title', { max: 240 });
    const statement = requireString(input.statement, 'statement', { max: 12_000 });
    const scope = jsonArray(input.scope, 'scope');
    const metadata = jsonObject(input.metadata, 'metadata');
    this.database.transaction(() => {
      const parent = parentId ? this.claimRow(projectId, parentId) : undefined;
      const logicalKey = parent ? String(parent.logical_key) : requestedLogicalKey!;
      const allocated = this.nextVersion('research_claims', 'logical_key', projectId, logicalKey);
      this.database.prepare(
        `INSERT INTO research_claims
         (id,project_id,logical_key,version,parent_id,title,statement,claim_type,status,scope_json,metadata_json,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?, 'draft',?,?,?,?)`,
      ).run(
        id, projectId, logicalKey, allocated, parent ? String(parent.id) : null,
        title, statement, claimType, scope, metadata, principal.userId, now,
      );
      this.record(projectId, principal.userId, 'research.claim.create', 'research_claim', id, { logicalKey, version: allocated });
      return allocated;
    });
    return this.claim(this.claimRow(projectId, id));
  }

  reviewClaim(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['under_review', 'approved', 'deprecated', 'rejected'], 'status');
    return this.database.transaction(() => {
      this.claimRow(projectId, id);
      const updated = this.database.prepare('UPDATE research_claims SET status=?, reviewed_by=?, reviewed_at=? WHERE id=? AND project_id=?')
        .run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('理论主张不存在');
      this.record(projectId, principal.userId, 'research.claim.review', 'research_claim', id, { status });
      return this.claim(this.claimRow(projectId, id));
    });
  }

  listSources(projectId: string): JsonObject[] {
    return this.rows(
      `SELECT s.*, (SELECT COUNT(*) FROM claim_evidence_links l WHERE l.evidence_source_id=s.id) AS claim_count
       FROM evidence_sources s WHERE s.project_id=? ORDER BY s.source_key, s.version DESC`,
      projectId,
    ).map((row) => this.source(row));
  }

  createSource(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const parentId = input.parentId === undefined
      ? undefined
      : requireString(input.parentId, 'parentId', { max: 200 });
    const requestedSourceKey = parentId
      ? undefined
      : requireString(input.sourceKey ?? slugify(String(input.citation ?? '')), 'sourceKey', { max: 160 });
    const id = randomUUID();
    const kind = requireString(input.kind, 'kind', { max: 120 });
    const citation = requireString(input.citation, 'citation', { max: 2_000 });
    const url = optionalString(input.url, 'url', 2_000) ?? null;
    const supports = optionalString(input.supports, 'supports', 12_000) ?? '';
    const limitations = optionalString(input.limitations, 'limitations', 12_000) ?? '';
    const metadata = jsonObject(input.metadata, 'metadata');
    const createdAt = nowIso();
    this.database.transaction(() => {
      const parent = parentId ? this.sourceRow(projectId, parentId) : undefined;
      const sourceKey = parent ? String(parent.source_key) : requestedSourceKey!;
      const allocated = this.nextVersion('evidence_sources', 'source_key', projectId, sourceKey);
      this.database.prepare(
        `INSERT INTO evidence_sources
         (id,project_id,source_key,version,parent_id,kind,citation,url,supports_text,limitations_text,status,metadata_json,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'draft',?,?,?)`,
      ).run(
        id, projectId, sourceKey, allocated, parent ? String(parent.id) : null,
        kind, citation, url, supports, limitations, metadata, principal.userId, createdAt,
      );
      this.record(projectId, principal.userId, 'research.source.create', 'evidence_source', id, { sourceKey, version: allocated });
      return allocated;
    });
    return this.source(this.sourceRow(projectId, id));
  }

  reviewSource(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['under_review', 'approved', 'deprecated', 'rejected'], 'status');
    return this.database.transaction(() => {
      this.sourceRow(projectId, id);
      const updated = this.database.prepare('UPDATE evidence_sources SET status=?, reviewed_by=?, reviewed_at=? WHERE id=? AND project_id=?')
        .run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('证据来源不存在');
      this.record(projectId, principal.userId, 'research.source.review', 'evidence_source', id, { status });
      return this.source(this.sourceRow(projectId, id));
    });
  }

  linkEvidence(projectId: string, claimId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const sourceId = requireString(input.evidenceSourceId, 'evidenceSourceId', { max: 200 });
    const relation = enumValue(input.relation, ['supports', 'contradicts', 'limits', 'context'], 'relation');
    const strength = enumValue(input.strength ?? 'unrated', ['unrated', 'weak', 'moderate', 'strong'], 'strength');
    const note = optionalString(input.note, 'note', 4_000) ?? '';
    this.database.transaction(() => {
      this.claimRow(projectId, claimId);
      this.sourceRow(projectId, sourceId);
      this.database.prepare(
        `INSERT OR REPLACE INTO claim_evidence_links
         (claim_id,evidence_source_id,relation,strength,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(claimId, sourceId, relation, strength, note, principal.userId, nowIso());
      this.record(projectId, principal.userId, 'research.claim.link-evidence', 'research_claim', claimId, { sourceId, relation, strength });
    });
    return { claimId, evidenceSourceId: sourceId, relation, strength, note };
  }

  listDatasets(projectId: string): JsonObject[] {
    return this.rows('SELECT * FROM dataset_snapshots WHERE project_id=? ORDER BY dataset_key, version DESC', projectId).map((row) => this.dataset(row));
  }

  createDataset(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const key = requireString(input.datasetKey ?? slugify(String(input.label ?? '')), 'datasetKey', { max: 160 });
    const id = randomUUID();
    const checksum = requireString(input.sha256, 'sha256', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/u });
    const rowCount = input.rowCount === undefined || input.rowCount === null ? null : integer(input.rowCount, 'rowCount', 0);
    const label = requireString(input.label, 'label', { max: 240 });
    const kind = enumValue(input.kind, ['internal_sample', 'experiment', 'live_observation', 'external'], 'kind');
    const storageRef = optionalString(input.storageRef, 'storageRef', 2_000) ?? '';
    const provenance = optionalString(input.provenance, 'provenance', 12_000) ?? '';
    const limitations = optionalString(input.limitations, 'limitations', 12_000) ?? '';
    const schema = jsonObject(input.schema, 'schema');
    const createdAt = nowIso();
    this.database.transaction(() => {
      const allocated = this.nextVersion('dataset_snapshots', 'dataset_key', projectId, key);
      this.database.prepare(
        `INSERT INTO dataset_snapshots
         (id,project_id,dataset_key,version,label,kind,sha256,row_count,storage_ref,provenance,limitations,schema_json,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,
      ).run(
        id, projectId, key, allocated, label, kind, checksum, rowCount, storageRef,
        provenance, limitations, schema, principal.userId, createdAt,
      );
      this.record(projectId, principal.userId, 'research.dataset.create', 'dataset_snapshot', id, { key, version: allocated, checksum });
      return allocated;
    });
    return this.dataset(this.datasetRow(projectId, id));
  }

  reviewDataset(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['under_review', 'approved', 'deprecated', 'rejected'], 'status');
    return this.database.transaction(() => {
      this.datasetRow(projectId, id);
      const updated = this.database.prepare('UPDATE dataset_snapshots SET status=?, approved_by=?, approved_at=? WHERE id=? AND project_id=?')
        .run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('数据快照不存在');
      this.record(projectId, principal.userId, 'research.dataset.review', 'dataset_snapshot', id, { status });
      return this.dataset(this.datasetRow(projectId, id));
    });
  }

  listExperiments(projectId: string): JsonObject[] {
    const experiments = this.rows('SELECT * FROM experiment_versions WHERE project_id=? ORDER BY experiment_key, version DESC', projectId);
    return experiments.map((row) => ({
      ...this.experiment(row),
      results: this.rows('SELECT * FROM experiment_results WHERE experiment_version_id=? ORDER BY version DESC', String(row.id)).map((result) => this.result(result)),
    }));
  }

  createExperiment(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const parentId = input.parentId === undefined
      ? undefined
      : requireString(input.parentId, 'parentId', { max: 200 });
    const requestedKey = parentId
      ? undefined
      : requireString(input.experimentKey ?? slugify(String(input.title ?? '')), 'experimentKey', { max: 160 });
    const id = randomUUID();
    const title = requireString(input.title, 'title', { max: 240 });
    const hypothesis = requireString(input.hypothesis, 'hypothesis', { max: 12_000 });
    const design = jsonObject(input.design, 'design');
    const metrics = jsonArray(input.metrics, 'metrics');
    const analysisPlan = jsonObject(input.analysisPlan, 'analysisPlan');
    const createdAt = nowIso();
    this.database.transaction(() => {
      const parent = parentId ? this.experimentRow(projectId, parentId) : undefined;
      const key = parent ? String(parent.experiment_key) : requestedKey!;
      const allocated = this.nextVersion('experiment_versions', 'experiment_key', projectId, key);
      this.database.prepare(
        `INSERT INTO experiment_versions
         (id,project_id,experiment_key,version,parent_id,title,hypothesis,design_json,metrics_json,analysis_plan_json,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'draft',?,?)`,
      ).run(
        id, projectId, key, allocated, parent ? String(parent.id) : null, title, hypothesis,
        design, metrics, analysisPlan, principal.userId, createdAt,
      );
      this.record(projectId, principal.userId, 'research.experiment.create', 'experiment_version', id, { key, version: allocated });
      return allocated;
    });
    return this.experiment(this.experimentRow(projectId, id));
  }

  transitionExperiment(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['preregistered', 'running', 'completed', 'replicated', 'rejected', 'archived'], 'status');
    const allowed: Record<string, string[]> = {
      draft: ['preregistered', 'rejected', 'archived'],
      preregistered: ['running', 'rejected', 'archived'],
      running: ['completed', 'rejected'],
      completed: ['replicated', 'archived'],
      replicated: ['archived'],
      rejected: ['archived'],
      archived: [],
    };
    const now = nowIso();
    return this.database.transaction(() => {
      const row = this.experimentRow(projectId, id);
      const previousStatus = String(row.status);
      if (!allowed[previousStatus]?.includes(status)) {
        throw new BadRequestException(`实验状态不能从 ${previousStatus} 变为 ${status}`);
      }
      const updated = this.database.prepare(
        `UPDATE experiment_versions SET status=?, approved_by=COALESCE(approved_by,?),
         approved_at=CASE WHEN ?='preregistered' THEN ? ELSE approved_at END,
         started_at=CASE WHEN ?='running' THEN ? ELSE started_at END,
         completed_at=CASE WHEN ? IN ('completed','replicated') THEN ? ELSE completed_at END
         WHERE id=? AND project_id=? AND status=?`,
      ).run(status, principal.userId, status, now, status, now, status, now, id, projectId, previousStatus);
      if (Number(updated.changes) !== 1) throw new BadRequestException('实验状态已变化，请刷新后重试');
      this.record(projectId, principal.userId, 'research.experiment.transition', 'experiment_version', id, { from: row.status, status });
      return this.experiment(this.experimentRow(projectId, id));
    });
  }

  createExperimentResult(projectId: string, experimentId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const datasetId = input.datasetSnapshotId === undefined || input.datasetSnapshotId === null
      ? null
      : requireString(input.datasetSnapshotId, 'datasetSnapshotId', { max: 200 });
    const id = randomUUID();
    const result = jsonObject(input.result, 'result');
    const conclusion = enumValue(input.conclusion ?? 'inconclusive', ['supports', 'contradicts', 'inconclusive', 'not_analyzed'], 'conclusion');
    const createdAt = nowIso();
    this.database.transaction(() => {
      const experiment = this.experimentRow(projectId, experimentId);
      if (!['running', 'completed', 'replicated'].includes(String(experiment.status))) {
        throw new BadRequestException('实验只有开始运行后才能登记结果');
      }
      if (datasetId) this.datasetRow(projectId, datasetId);
      const allocated = Number((this.database.prepare(
        'SELECT COALESCE(MAX(version),0)+1 AS value FROM experiment_results WHERE experiment_version_id=?',
      ).get(experimentId) as { value: number }).value);
      this.database.prepare(
        `INSERT INTO experiment_results
         (id,experiment_version_id,version,dataset_snapshot_id,result_json,conclusion,status,created_by,created_at)
         VALUES (?,?,?,?,?,?, 'draft',?,?)`,
      ).run(id, experimentId, allocated, datasetId, result, conclusion, principal.userId, createdAt);
      this.record(projectId, principal.userId, 'research.experiment-result.create', 'experiment_result', id, { experimentId, version: allocated, datasetId });
      return allocated;
    });
    return this.result(this.resultRow(projectId, id));
  }

  reviewExperimentResult(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['under_review', 'approved', 'rejected'], 'status');
    return this.database.transaction(() => {
      this.resultRow(projectId, id);
      const updated = this.database.prepare(
        `UPDATE experiment_results
            SET status=?, reviewed_by=?, reviewed_at=?
          WHERE id=?
            AND EXISTS (
              SELECT 1
                FROM experiment_versions e
               WHERE e.id=experiment_results.experiment_version_id
                 AND e.project_id=?
            )`,
      ).run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('实验结果不存在');
      this.record(projectId, principal.userId, 'research.experiment-result.review', 'experiment_result', id, { status });
      return this.result(this.resultRow(projectId, id));
    });
  }

  listCalibrations(projectId: string): JsonObject[] {
    return this.rows('SELECT * FROM calibration_proposals WHERE project_id=? ORDER BY created_at DESC', projectId).map((row) => this.calibration(row));
  }

  createCalibration(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const targetType = enumValue(input.targetType, ['parameter', 'formula', 'prompt', 'policy'], 'targetType');
    const targetKey = requireString(input.targetKey, 'targetKey', { max: 240 });
    if (targetType === 'parameter' && !GENERATION_PARAMETER_REGISTRY.some((item) => item.id === targetKey)) {
      throw new BadRequestException('targetKey 不是已注册的生成参数');
    }
    const id = randomUUID();
    const current = jsonObject(input.current, 'current');
    const proposed = jsonObject(input.proposed, 'proposed');
    const rationale = requireString(input.rationale, 'rationale', { max: 12_000 });
    const evidence = jsonObject(input.evidence, 'evidence');
    const impact = jsonObject(input.impact, 'impact');
    const createdAt = nowIso();
    return this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO calibration_proposals
         (id,project_id,target_type,target_key,current_json,proposed_json,rationale,evidence_json,impact_json,status,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'draft',?,?)`,
      ).run(
        id, projectId, targetType, targetKey, current, proposed, rationale, evidence, impact,
        principal.userId, createdAt,
      );
      this.record(projectId, principal.userId, 'research.calibration.create', 'calibration_proposal', id, { targetType, targetKey });
      return this.calibration(this.calibrationRow(projectId, id));
    });
  }

  reviewCalibration(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['under_review', 'approved', 'rejected'], 'status');
    return this.database.transaction(() => {
      const row = this.calibrationRow(projectId, id);
      if (String(row.status) === 'applied') {
        throw new BadRequestException('已应用的校准提案不能重新审批');
      }
      if (status === 'approved') this.validateCalibration(row);
      const updated = this.database.prepare(
        `UPDATE calibration_proposals
            SET status=?, reviewed_by=?, reviewed_at=?
          WHERE id=? AND project_id=? AND status<>'applied'`,
      ).run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new BadRequestException('校准提案状态已变化，请刷新后重试');
      this.record(projectId, principal.userId, 'research.calibration.review', 'calibration_proposal', id, { status });
      return this.calibration(this.calibrationRow(projectId, id));
    });
  }

  listReleases(projectId: string): JsonObject[] {
    return this.rows('SELECT * FROM release_manifests WHERE project_id=? ORDER BY created_at DESC', projectId).map((row) => this.release(row));
  }

  createRelease(projectId: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const id = randomUUID();
    const version = requireString(input.version, 'version', { max: 80, pattern: /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u });
    const requestedFormulaId = input.formulaVersionId === undefined
      ? undefined
      : requireString(input.formulaVersionId, 'formulaVersionId', { max: 200 });
    const buildId = optionalString(input.buildId, 'buildId', 200) ?? '';
    const notes = optionalString(input.notes, 'notes', 12_000) ?? '';
    return this.database.transaction(() => {
      const activeFormula = this.activeFormula(projectId);
      const formulaId = requestedFormulaId ?? String(activeFormula.id);
      const formula = this.formulaRow(projectId, formulaId);
      const stored = parseJson<JsonObject>(formula.definition_json, {});
      const definition = isRecord(stored.version) ? stored.version : {};
      const parent = this.activeRelease(projectId);
      const bindings = this.validateBindings(projectId, input.bindings);
      this.database.prepare(
        `INSERT INTO release_manifests
         (id,project_id,version,parent_id,status,app_version,build_id,formula_version_id,formula_digest,
          execution_policy_version,execution_policy_digest,prompt_version,prompt_digest,
          parameter_policy_version,parameter_policy_digest,evidence_catalog_version,evidence_catalog_digest,
          bindings_json,notes,created_by,created_at)
         VALUES (?,?,?,?,'draft','0.1.0',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, projectId, version, typeof parent?.id === 'string' ? parent.id : null,
        buildId, formulaId, String(definition.digest ?? ''),
        FORMULA_EXECUTION_POLICY_VERSION, FORMULA_EXECUTION_POLICY_DIGEST,
        PROMPT_CONTRACT_VERSION, PROMPT_CONTRACT_DIGEST,
        PARAMETER_POLICY_VERSION, PARAMETER_POLICY_DIGEST,
        String(this.catalog.data.catalogVersion ?? 'unknown'), this.catalog.digest,
        JSON.stringify(bindings), notes, principal.userId, nowIso(),
      );
      this.record(projectId, principal.userId, 'research.release.create', 'release_manifest', id, { version, formulaId, bindings });
      return this.release(this.releaseRow(projectId, id));
    });
  }

  reviewRelease(projectId: string, id: string, input: JsonObject, principal: SessionPrincipal): JsonObject {
    const status = enumValue(input.status, ['approved', 'rejected'], 'status');
    return this.database.transaction(() => {
      const row = this.releaseRow(projectId, id);
      if (String(row.status) !== 'draft') throw new BadRequestException('只有 draft 发布清单可以审批');
      if (status === 'approved') this.validateReleaseForActivation(projectId, row);
      const updated = this.database.prepare(
        `UPDATE release_manifests SET status=?, approved_by=?, approved_at=?
         WHERE id=? AND project_id=? AND status='draft'`,
      ).run(status, principal.userId, nowIso(), id, projectId);
      if (Number(updated.changes) !== 1) throw new BadRequestException('发布清单状态已变化，请刷新后重试');
      this.record(projectId, principal.userId, 'research.release.review', 'release_manifest', id, { status });
      return this.release(this.releaseRow(projectId, id));
    });
  }

  activateRelease(projectId: string, id: string, principal: SessionPrincipal): JsonObject {
    const now = nowIso();
    return this.database.transaction(() => {
      const row = this.releaseRow(projectId, id);
      if (String(row.status) !== 'approved') throw new BadRequestException('只有 approved 发布清单可以激活');
      this.validateReleaseForActivation(projectId, row);
      this.database.prepare("UPDATE release_manifests SET status='archived' WHERE project_id=? AND status='active'").run(projectId);
      const activated = this.database.prepare(
        "UPDATE release_manifests SET status='active', activated_at=? WHERE id=? AND project_id=? AND status='approved'",
      ).run(now, id, projectId);
      if (Number(activated.changes) !== 1) throw new BadRequestException('发布清单状态已变化，请刷新后重试');
      const bindings = parseJson<JsonObject>(row.bindings_json, {});
      for (const proposalId of stringArray(bindings.calibrationProposalIds)) {
        const applied = this.database.prepare("UPDATE calibration_proposals SET status='applied', applied_release_id=? WHERE id=? AND project_id=? AND status='approved'")
          .run(id, proposalId, projectId);
        if (Number(applied.changes) !== 1) {
          throw new BadRequestException(`校准提案 ${proposalId} 状态已变化，请刷新后重试`);
        }
      }
      this.record(projectId, principal.userId, 'research.release.activate', 'release_manifest', id, { version: row.version });
      return this.release(this.releaseRow(projectId, id));
    });
  }

  activeRuntimeSnapshot(projectId: string): JsonObject {
    const row = this.database.prepare("SELECT * FROM release_manifests WHERE project_id=? AND status='active'").get(projectId) as JsonObject | undefined;
    if (!row) {
      const managed = this.database.prepare('SELECT 1 FROM release_manifests WHERE project_id=? LIMIT 1').get(projectId);
      if (managed) {
        throw new BadRequestException({
          message: '项目没有可用的 active release，请审批并激活与当前公式匹配的发布清单',
          code: 'ACTIVE_RELEASE_REQUIRED',
        });
      }
      return { status: 'unmanaged_legacy', parameterOverrides: {}, researchInjectedIntoPrompt: false };
    }
    this.validateActiveRuntime(projectId, row);
    const manifest = this.release(row);
    const bindings = isRecord(manifest.bindings) ? manifest.bindings : {};
    const parameterOverrides: JsonObject = {};
    for (const proposalId of stringArray(bindings.calibrationProposalIds)) {
      const proposal = this.database.prepare(
        "SELECT * FROM calibration_proposals WHERE id=? AND project_id=? AND status='applied' AND applied_release_id=?",
      ).get(proposalId, projectId, String(row.id)) as JsonObject | undefined;
      if (!proposal || proposal.target_type !== 'parameter') continue;
      const proposed = parseJson<JsonObject>(proposal.proposed_json, {});
      if (Object.hasOwn(proposed, 'value')) parameterOverrides[String(proposal.target_key)] = proposed.value;
    }
    return {
      ...manifest,
      parameterOverrides,
      researchInjectedIntoPrompt: false,
      source: 'active_release_manifest',
    };
  }

  private currentCatalogImported(projectId: string): boolean {
    const rows = this.database.prepare(
      "SELECT metadata_json FROM research_claims WHERE project_id=? AND logical_key LIKE 'formula:%'",
    ).all(projectId) as Array<{ metadata_json: string }>;
    return rows.some((row) => {
      const metadata = parseJson<JsonObject>(row.metadata_json, {});
      return metadata.catalogDigest === this.catalog.digest;
    });
  }

  private importCatalog(projectId: string, userId: string): void {
    const now = nowIso();
    const sourceIds = new Map<string, string>();
    this.database.transaction(() => {
      // Another process may have imported the same digest after bootstrapProject's
      // optimistic read. Recheck only after acquiring the write lock.
      if (this.currentCatalogImported(projectId)) return;
      for (const source of this.catalog.data.sources ?? []) {
        const parent = this.database.prepare(
          'SELECT id, version FROM evidence_sources WHERE project_id=? AND source_key=? ORDER BY version DESC LIMIT 1',
        ).get(projectId, source.id) as { id: string; version: number } | undefined;
        const id = randomUUID();
        const version = Number(parent?.version ?? 0) + 1;
        sourceIds.set(source.id, id);
        this.database.prepare(
          `INSERT INTO evidence_sources
           (id,project_id,source_key,version,parent_id,kind,citation,url,supports_text,limitations_text,status,metadata_json,created_by,reviewed_by,created_at,reviewed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'approved',?,?,?,?,?)`,
        ).run(
          id, projectId, source.id, version, parent?.id ?? null,
          source.kind ?? 'unknown', source.citation ?? source.id,
          source.url ?? null, source.supports ?? '', source.doesNotSupport ?? '',
          JSON.stringify({
            importedFrom: 'formula-evidence-catalog',
            path: source.path ?? null,
            catalogVersion: this.catalog.data.catalogVersion ?? 'unknown',
            catalogDigest: this.catalog.digest,
          }),
          userId, userId, now, now,
        );
      }
      for (const formula of this.catalog.data.formulaEvidence ?? []) {
        const logicalKey = `formula:${formula.formulaId}`;
        const parent = this.database.prepare(
          'SELECT id, version FROM research_claims WHERE project_id=? AND logical_key=? ORDER BY version DESC LIMIT 1',
        ).get(projectId, logicalKey) as { id: string; version: number } | undefined;
        const claimId = randomUUID();
        const version = Number(parent?.version ?? 0) + 1;
        const claimType = formula.evidenceClass?.includes('unvalidated')
          ? 'hypothesis'
          : formula.evidenceClass === 'project_definition'
            ? 'definition'
            : formula.sourceIds?.some((id) => id.startsWith('DATA-'))
              ? 'internal_observation'
              : 'inference';
        this.database.prepare(
          `INSERT INTO research_claims
           (id,project_id,logical_key,version,parent_id,title,statement,claim_type,status,scope_json,metadata_json,created_by,reviewed_by,created_at,reviewed_at)
           VALUES (?,?,?,?,?,?,?,?,'approved',?,?,?,?,?,?)`,
        ).run(
          claimId, projectId, logicalKey, version, parent?.id ?? null,
          `${formula.formulaId} · ${formula.auditVerdict ?? '审计主张'}`,
          formula.actualExecution ?? formula.equation ?? formula.formulaId,
          claimType,
          JSON.stringify([formula.formulaId]),
          JSON.stringify({
            formulaId: formula.formulaId,
            equation: formula.equation,
            boundary: formula.boundary,
            currentStatus: formula.currentStatus,
            auditVerdict: formula.auditVerdict,
            reviewIds: formula.reviewIds,
            semanticFingerprint: formula.semanticFingerprint,
            executionClass: formula.executionClass,
            implementedStages: formula.implementedStages,
            importedFrom: 'formula-evidence-catalog',
            catalogVersion: this.catalog.data.catalogVersion ?? 'unknown',
            catalogDigest: this.catalog.digest,
          }),
          userId, userId, now, now,
        );
        for (const sourceKey of formula.sourceIds ?? []) {
          const evidenceId = sourceIds.get(sourceKey);
          if (!evidenceId) continue;
          this.database.prepare(
            `INSERT INTO claim_evidence_links
             (claim_id,evidence_source_id,relation,strength,note,created_by,created_at) VALUES (?,?,'context','unrated',?,?,?)`,
          ).run(claimId, evidenceId, '仅在来源明确支持范围内作为背景；不能越过来源限制推导因果或参数权重。', userId, now);
        }
      }
      this.importReferenceDataset(projectId, userId, now);
      this.record(projectId, userId, 'research.catalog.import', 'research_catalog', projectId, {
        catalogVersion: this.catalog.data.catalogVersion,
        catalogDigest: this.catalog.digest,
        sources: sourceIds.size,
        claims: this.catalog.data.formulaEvidence?.length ?? 0,
      });
    });
  }

  private importReferenceDataset(projectId: string, userId: string, now: string): void {
    const existing = this.database.prepare(
      "SELECT 1 FROM dataset_snapshots WHERE project_id=? AND dataset_key='reference-copy-70' LIMIT 1",
    ).get(projectId);
    if (existing) return;
    const candidates = [
      resolve(process.cwd(), '../70篇对标内容_AI提炼版.jsonl'),
      resolve(process.cwd(), '../../../70篇对标内容_AI提炼版.jsonl'),
      resolve(dirname(this.catalog.path), '../../../70篇对标内容_AI提炼版.jsonl'),
    ];
    const path = candidates.find(existsSync);
    if (!path) return;
    const buffer = readFileSync(path);
    const rowCount = buffer.toString('utf8').split(/\r?\n/u).filter((line) => line.trim()).length;
    this.database.prepare(
      `INSERT INTO dataset_snapshots
       (id,project_id,dataset_key,version,label,kind,sha256,row_count,storage_ref,provenance,limitations,schema_json,status,created_by,approved_by,created_at,approved_at)
       VALUES (?,?, 'reference-copy-70',1,'70篇对标内容描述性快照','internal_sample',?,?,?,?,?,?,'approved',?,?,?,?)`,
    ).run(
      randomUUID(), projectId, createHash('sha256').update(buffer).digest('hex'), rowCount, path,
      '内部收集的内容样本，仅用于描述体裁和信息位置。',
      '不是随机样本，不能证明平台推荐、转化因果、最佳阈值或总体人群分布。',
      JSON.stringify({ format: 'jsonl', frozen: true }), userId, userId, now, now,
    );
  }

  private ensureBaselineRelease(projectId: string, userId: string): void {
    this.database.transaction(() => {
      // Serialize the check with insertion. Without the lock, two API processes
      // can both observe an empty project and race on the active/version indexes.
      const existing = this.database.prepare('SELECT 1 FROM release_manifests WHERE project_id=? LIMIT 1').get(projectId);
      if (existing) {
        this.healStaleBaselineRelease(projectId, userId);
        return;
      }
      this.insertBaselineRelease(projectId, userId);
    });
  }

  /**
   * 代码合同 digest 漂移后的自愈。
   *
   * execution/prompt/parameter/catalog 四个 digest 是**编译期常量**——改了 prompt.ts
   * 或 parameters.ts 就会变。而 ensureBaselineRelease 原先只判断「有没有 manifest」,
   * 有就直接 return,于是一次发版之后库里那条 active manifest 永久失效:
   * validateActiveRuntime 每次生成都抛「发布清单绑定的运行合同已经过期」,而
   * 极简创作(SaaS)用户连 /research 都进不去(前后端白名单都挡),没有任何自救入口。
   * 实测 9 个项目里有 3 个卡在这个状态,生成完全不可用。
   *
   * 只在 bindings 为空时自愈。bindings 空 = 没有绑定任何数据快照/实验结果/校准提案,
   * 也就是这条 manifest 只钉代码合同,不承载任何人做过的研究决定,按当前代码重建
   * 不丢信息。一旦绑过东西就保持报错——那是真的需要人复核的发布,不能替人决定。
   */
  private healStaleBaselineRelease(projectId: string, userId: string): void {
    const active = this.database.prepare(
      "SELECT * FROM release_manifests WHERE project_id=? AND status='active'",
    ).get(projectId) as JsonObject | undefined;
    if (!active) return;

    try {
      this.validateReleaseContract(projectId, active);
      return; // 合同仍然有效,不动
    } catch {
      // 落到下面判断能不能自愈
    }

    const bindings = parseJson<JsonObject>(active.bindings_json, {});
    const pinned = [
      ...stringArray(bindings.datasetSnapshotIds),
      ...stringArray(bindings.experimentResultIds),
      ...stringArray(bindings.calibrationProposalIds),
    ];
    // 绑过研究产物 → 交给人处理,保持原有报错行为
    if (pinned.length > 0) return;

    this.database.transaction(() => {
      // (project_id) WHERE status='active' 是唯一索引,必须先让旧的退位
      this.database.prepare(
        "UPDATE release_manifests SET status='archived' WHERE id=?",
      ).run(String(active.id));
      this.insertBaselineRelease(projectId, userId, String(active.id));
    });
    this.record(projectId, userId, 'research.release.baseline-heal', 'release_manifest', String(active.id), {
      reason: 'code_contract_digest_drift',
      supersededVersion: active.version,
    });
  }

  private insertBaselineRelease(projectId: string, userId: string, parentId?: string): void {
    const formula = this.activeFormula(projectId);
    const stored = parseJson<JsonObject>(formula.definition_json, {});
    const definition = isRecord(stored.version) ? stored.version : {};
    const id = randomUUID();
    const now = nowIso();
    // UNIQUE(project_id, version):自愈重建时不能再叫 0.1.0-baseline(旧那条还在,
    // 只是转 archived)。名字必须覆盖全部四个合同 digest——只取 prompt 的话,
    // 仅 parameter 或 catalog 漂移的下一次自愈会撞上同名而插入失败。
    const contractTag = createHash('sha256')
      .update([
        FORMULA_EXECUTION_POLICY_DIGEST,
        PROMPT_CONTRACT_DIGEST,
        PARAMETER_POLICY_DIGEST,
        this.catalog.digest,
      ].join(':'), 'utf8')
      .digest('hex')
      .slice(0, 12);
    const version = parentId
      ? `0.1.0-baseline+${PROMPT_CONTRACT_VERSION}.${contractTag}`
      : '0.1.0-baseline';
    const notes = parentId
      ? '代码合同 digest 漂移后按当前运行时重建的只读基线；未绑定任何研究产物，不代表研究结论或参数校准。'
      : '迁移前已运行行为的只读基线；不代表研究结论或参数校准。';
    this.database.prepare(
      `INSERT INTO release_manifests
       (id,project_id,version,parent_id,status,app_version,build_id,formula_version_id,formula_digest,
        execution_policy_version,execution_policy_digest,prompt_version,prompt_digest,
        parameter_policy_version,parameter_policy_digest,evidence_catalog_version,evidence_catalog_digest,
        bindings_json,notes,created_by,approved_by,created_at,approved_at,activated_at)
       VALUES (?,?,?,?,'active','0.1.0','',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)`,
    ).run(
      id, projectId, version, parentId ?? null, String(formula.id), String(definition.digest ?? ''),
      FORMULA_EXECUTION_POLICY_VERSION, FORMULA_EXECUTION_POLICY_DIGEST,
      PROMPT_CONTRACT_VERSION, PROMPT_CONTRACT_DIGEST,
      PARAMETER_POLICY_VERSION, PARAMETER_POLICY_DIGEST,
      String(this.catalog.data.catalogVersion ?? 'unknown'), this.catalog.digest,
      JSON.stringify({ datasetSnapshotIds: [], experimentResultIds: [], calibrationProposalIds: [], source: parentId ? 'baseline-heal' : 'baseline-migration' }),
      notes, userId, userId, now, now, now,
    );
    this.record(projectId, userId, 'research.release.baseline', 'release_manifest', id, { formulaVersionId: formula.id });
  }

  private validateBindings(projectId: string, value: unknown): JsonObject {
    if (value !== undefined && !isRecord(value)) throw new BadRequestException('bindings 必须是 JSON 对象');
    const input = value === undefined ? {} : value as JsonObject;
    const datasetSnapshotIds = bindingIds(input.datasetSnapshotIds, 'bindings.datasetSnapshotIds');
    const experimentResultIds = bindingIds(input.experimentResultIds, 'bindings.experimentResultIds');
    const calibrationProposalIds = bindingIds(input.calibrationProposalIds, 'bindings.calibrationProposalIds');
    for (const id of datasetSnapshotIds) this.datasetRow(projectId, id);
    for (const id of experimentResultIds) this.resultRow(projectId, id);
    for (const id of calibrationProposalIds) this.calibrationRow(projectId, id);
    return { datasetSnapshotIds, experimentResultIds, calibrationProposalIds };
  }

  private validateReleaseForActivation(projectId: string, row: JsonObject): void {
    this.validateReleaseContract(projectId, row);
    const bindings = parseJson<JsonObject>(row.bindings_json, {});
    for (const id of stringArray(bindings.datasetSnapshotIds)) {
      if (this.datasetRow(projectId, id).status !== 'approved') throw new BadRequestException(`数据快照 ${id} 尚未批准`);
    }
    for (const id of stringArray(bindings.experimentResultIds)) {
      if (this.resultRow(projectId, id).status !== 'approved') throw new BadRequestException(`实验结果 ${id} 尚未批准`);
    }
    for (const id of stringArray(bindings.calibrationProposalIds)) {
      const proposal = this.calibrationRow(projectId, id);
      if (proposal.status !== 'approved') throw new BadRequestException(`校准提案 ${id} 尚未批准`);
      this.validateCalibration(proposal);
    }
  }

  private validateActiveRuntime(projectId: string, row: JsonObject): void {
    this.validateReleaseContract(projectId, row);
    const bindings = parseJson<JsonObject>(row.bindings_json, {});
    for (const id of stringArray(bindings.datasetSnapshotIds)) {
      if (this.datasetRow(projectId, id).status !== 'approved') throw new BadRequestException(`active release 的数据快照 ${id} 已失效`);
    }
    for (const id of stringArray(bindings.experimentResultIds)) {
      if (this.resultRow(projectId, id).status !== 'approved') throw new BadRequestException(`active release 的实验结果 ${id} 已失效`);
    }
    for (const id of stringArray(bindings.calibrationProposalIds)) {
      const proposal = this.calibrationRow(projectId, id);
      if (proposal.status !== 'applied' || proposal.applied_release_id !== row.id) {
        throw new BadRequestException(`active release 的校准提案 ${id} 未正确应用`);
      }
      this.validateCalibration(proposal);
    }
  }

  private validateReleaseContract(projectId: string, row: JsonObject): void {
    const activeFormula = this.activeFormula(projectId);
    if (row.formula_version_id !== activeFormula.id) throw new BadRequestException('发布清单绑定的公式不是项目当前 active 公式，请先显式激活对应公式');
    const stored = parseJson<JsonObject>(activeFormula.definition_json, {});
    const definition = isRecord(stored.version) ? stored.version : {};
    if (row.formula_digest !== definition.digest) throw new BadRequestException('公式 digest 与发布清单不一致');
    if (row.execution_policy_digest !== FORMULA_EXECUTION_POLICY_DIGEST
      || row.prompt_digest !== PROMPT_CONTRACT_DIGEST
      || row.parameter_policy_digest !== PARAMETER_POLICY_DIGEST) {
      throw new BadRequestException('发布清单绑定的运行合同已经过期，请创建新版本');
    }
    if (row.evidence_catalog_digest !== this.catalog.digest
      || row.evidence_catalog_version !== String(this.catalog.data.catalogVersion ?? 'unknown')) {
      throw new BadRequestException('发布清单绑定的证据目录已经过期，请创建新版本');
    }
  }

  private validateCalibration(row: JsonObject): void {
    if (row.target_type !== 'parameter') throw new BadRequestException('当前运行时只允许参数型校准提案进入发布；其他类型先作为研究记录保留');
    const definition = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === row.target_key);
    if (!definition) throw new BadRequestException('校准目标参数不存在');
    const proposed = parseJson<JsonObject>(row.proposed_json, {});
    if (!Object.hasOwn(proposed, 'value')) throw new BadRequestException('参数校准 proposed 必须包含 value');
    normalizeParameterValues({ [String(row.target_key)]: proposed.value }, { partial: true, rejectUnknown: true });
  }

  private loadCatalog(): { data: EvidenceCatalog; digest: string; path: string } {
    const base = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(process.cwd(), 'docs/audit/formula-evidence-catalog.json'),
      resolve(base, '../../../docs/audit/formula-evidence-catalog.json'),
    ];
    const path = candidates.find(existsSync);
    if (!path) throw new Error('找不到公式证据目录 docs/audit/formula-evidence-catalog.json');
    const raw = readFileSync(path, 'utf8');
    const data = parseJson<EvidenceCatalog>(raw, {});
    this.validateCatalogAgainstRuntime(data, path);
    return { data, digest: createHash('sha256').update(raw).digest('hex'), path };
  }

  private validateCatalogAgainstRuntime(data: EvidenceCatalog, path: string): void {
    const issues: string[] = [];
    if (!data.catalogVersion) issues.push('缺少 catalogVersion');
    if (data.defaultFormulaVersion?.version !== DEFAULT_FORMULA_VERSION.version) {
      issues.push(`默认公式版本不一致：catalog=${data.defaultFormulaVersion?.version ?? 'missing'} runtime=${DEFAULT_FORMULA_VERSION.version}`);
    }
    if (data.defaultFormulaVersion?.digest !== DEFAULT_FORMULA_VERSION.digest) {
      issues.push(`默认公式 digest 不一致：catalog=${data.defaultFormulaVersion?.digest ?? 'missing'} runtime=${DEFAULT_FORMULA_VERSION.digest}`);
    }
    const entries = new Map<string, CatalogFormula>();
    for (const entry of data.formulaEvidence ?? []) {
      if (entries.has(entry.formulaId)) issues.push(`重复公式条目：${entry.formulaId}`);
      entries.set(entry.formulaId, entry);
    }
    for (const formula of DEFAULT_FORMULAS) {
      const entry = entries.get(formula.id);
      const runtime = FORMULA_EXECUTION_HANDLER_REGISTRY[formula.id];
      if (!entry) {
        issues.push(`缺少公式条目：${formula.id}`);
        continue;
      }
      if (!runtime) {
        issues.push(`缺少运行时注册：${formula.id}`);
        continue;
      }
      if (entry.equation !== formula.equation) issues.push(`${formula.id} equation 与运行时不一致`);
      if (entry.semanticFingerprint !== runtime.semanticFingerprint) issues.push(`${formula.id} semanticFingerprint 与运行时不一致`);
    }
    if (issues.length) {
      throw new Error(`公式证据目录与运行时合同不一致（${path}）：${issues.join('；')}`);
    }
  }

  private activeRelease(projectId: string): JsonObject | undefined {
    const row = this.database.prepare("SELECT * FROM release_manifests WHERE project_id=? AND status='active'").get(projectId) as JsonObject | undefined;
    return row ? this.release(row) : undefined;
  }

  private activeFormula(projectId: string): JsonObject {
    const row = this.database.prepare("SELECT * FROM formula_versions WHERE project_id=? AND status='active' ORDER BY version DESC LIMIT 1").get(projectId) as JsonObject | undefined;
    if (!row) throw new NotFoundException('项目没有 active 公式版本');
    return row;
  }

  private project(projectId: string): JsonObject {
    const row = this.database.prepare(
      `SELECT p.* FROM projects p
       JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.id=? AND p.deleted_at IS NULL AND w.deleted_at IS NULL`,
    ).get(projectId) as JsonObject | undefined;
    if (!row) throw new NotFoundException('项目不存在');
    return row;
  }

  private formulaRow(projectId: string, id: string): JsonObject {
    const row = this.database.prepare('SELECT * FROM formula_versions WHERE id=? AND project_id=?').get(id, projectId) as JsonObject | undefined;
    if (!row) throw new NotFoundException('公式版本不存在');
    return row;
  }

  private claimRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('research_claims', projectId, id, '理论主张不存在');
  }
  private sourceRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('evidence_sources', projectId, id, '证据来源不存在');
  }
  private datasetRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('dataset_snapshots', projectId, id, '数据快照不存在');
  }
  private experimentRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('experiment_versions', projectId, id, '实验版本不存在');
  }
  private calibrationRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('calibration_proposals', projectId, id, '校准提案不存在');
  }
  private releaseRow(projectId: string, id: string): JsonObject {
    return this.requiredRow('release_manifests', projectId, id, '发布清单不存在');
  }
  private resultRow(projectId: string, id: string): JsonObject {
    const row = this.database.prepare(
      `SELECT r.* FROM experiment_results r JOIN experiment_versions e ON e.id=r.experiment_version_id WHERE r.id=? AND e.project_id=?`,
    ).get(id, projectId) as JsonObject | undefined;
    if (!row) throw new NotFoundException('实验结果不存在');
    return row;
  }
  private requiredRow(table: string, projectId: string, id: string, message: string): JsonObject {
    const row = this.database.prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=?`).get(id, projectId) as JsonObject | undefined;
    if (!row) throw new NotFoundException(message);
    return row;
  }

  private nextVersion(table: string, keyColumn: string, projectId: string, key: string): number {
    return Number((this.database.prepare(`SELECT COALESCE(MAX(version),0)+1 AS value FROM ${table} WHERE project_id=? AND ${keyColumn}=?`).get(projectId, key) as { value: number }).value);
  }

  private rows(sql: string, ...params: Array<string | number | null>): JsonObject[] {
    return this.database.prepare(sql).all(...params) as JsonObject[];
  }

  private claim(row: JsonObject): JsonObject {
    return mapCommon(row, { logicalKey: 'logical_key', claimType: 'claim_type', scope: 'scope_json', metadata: 'metadata_json', evidenceCount: 'evidence_count' });
  }
  private source(row: JsonObject): JsonObject {
    return mapCommon(row, { sourceKey: 'source_key', supports: 'supports_text', limitations: 'limitations_text', metadata: 'metadata_json', claimCount: 'claim_count' });
  }
  private dataset(row: JsonObject): JsonObject {
    return mapCommon(row, { datasetKey: 'dataset_key', rowCount: 'row_count', storageRef: 'storage_ref', schema: 'schema_json' });
  }
  private experiment(row: JsonObject): JsonObject {
    return mapCommon(row, { experimentKey: 'experiment_key', design: 'design_json', metrics: 'metrics_json', analysisPlan: 'analysis_plan_json' });
  }
  private result(row: JsonObject): JsonObject {
    return mapCommon(row, { experimentVersionId: 'experiment_version_id', datasetSnapshotId: 'dataset_snapshot_id', result: 'result_json' });
  }
  private calibration(row: JsonObject): JsonObject {
    return mapCommon(row, { targetType: 'target_type', targetKey: 'target_key', current: 'current_json', proposed: 'proposed_json', evidence: 'evidence_json', impact: 'impact_json', appliedReleaseId: 'applied_release_id' });
  }
  private release(row: JsonObject): JsonObject {
    return mapCommon(row, {
      appVersion: 'app_version', buildId: 'build_id', formulaVersionId: 'formula_version_id', formulaDigest: 'formula_digest',
      executionPolicyVersion: 'execution_policy_version', executionPolicyDigest: 'execution_policy_digest',
      promptVersion: 'prompt_version', promptDigest: 'prompt_digest', parameterPolicyVersion: 'parameter_policy_version',
      parameterPolicyDigest: 'parameter_policy_digest', evidenceCatalogVersion: 'evidence_catalog_version',
      evidenceCatalogDigest: 'evidence_catalog_digest', bindings: 'bindings_json',
    });
  }

  private record(projectId: string, userId: string, action: string, entityType: string, entityId: string, details: JsonObject): void {
    const project = this.project(projectId);
    this.audit.record({ workspaceId: String(project.workspace_id), userId, action, entityType, entityId, details });
  }
}

function mapCommon(row: JsonObject, aliases: Record<string, string>): JsonObject {
  const result: JsonObject = {};
  const reverse = new Map(Object.entries(aliases).map(([target, source]) => [source, target]));
  for (const [key, value] of Object.entries(row)) {
    if (['definition_json'].includes(key)) continue;
    const target = reverse.get(key) ?? snakeToCamel(key);
    result[target] = key.endsWith('_json') ? parseJson(value, key === 'scope_json' || key === 'metrics_json' ? [] : {}) : value;
  }
  return result;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function jsonObject(value: unknown, field: string): string {
  const resolved = value === undefined ? {} : value;
  if (!isRecord(resolved)) throw new BadRequestException(`${field} 必须是 JSON 对象`);
  return boundedJson(resolved, field);
}

function jsonArray(value: unknown, field: string): string {
  const resolved = value === undefined ? [] : value;
  if (!Array.isArray(resolved)) throw new BadRequestException(`${field} 必须是数组`);
  return boundedJson(resolved, field);
}

function boundedJson(value: unknown, field: string): string {
  assertJsonComplexity(value, field);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESEARCH_JSON_BYTES) {
    throw new PayloadTooLargeException(`${field} 不能超过 256 KiB`);
  }
  return serialized;
}

function bindingIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${field} 必须是字符串数组`);
  if (value.length > MAX_RELEASE_BINDINGS_PER_TYPE) {
    throw new BadRequestException(`${field} 最多 ${MAX_RELEASE_BINDINGS_PER_TYPE} 项`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) {
      throw new BadRequestException(`${field} 必须是非空字符串数组`);
    }
    const id = item.trim();
    if (seen.has(id)) throw new BadRequestException(`${field} 不能包含重复项`);
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new BadRequestException(`${field} 不在允许范围内`);
  return value as T;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw new BadRequestException(`${field} 必须是不小于 ${minimum} 的整数`);
  return value;
}
