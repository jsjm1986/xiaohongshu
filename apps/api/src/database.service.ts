import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { APP_OPTIONS, type ApiOptions } from './config.js';

export type SqlValue = string | number | bigint | Uint8Array | null;

/**
 * 当前 schema 版本(PRAGMA user_version 迁移完之后的值)。
 *
 * 加迁移时改这里一处。原来有四个测试各自硬编码 `=== 12`,于是每加一次迁移就有四条
 * 无关的测试变红——那不是回归信号,是维护噪声。测试断言这个常量,真正想验的
 * 「迁移到最新且表结构对得上」不变。
 */
export const SCHEMA_VERSION = 30;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: DatabaseSync;
  readonly knowledgeDir: string;
  readonly imageDir: string;
  readonly exportDir: string;
  private transactionDepth = 0;

  constructor(@Inject(APP_OPTIONS) readonly options: ApiOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.knowledgeDir = join(options.dataDir, 'knowledge');
    this.imageDir = join(options.dataDir, 'images');
    this.exportDir = join(options.dataDir, 'exports');
    mkdirSync(this.knowledgeDir, { recursive: true });
    mkdirSync(this.imageDir, { recursive: true });
    mkdirSync(this.exportDir, { recursive: true });

    this.db = new DatabaseSync(options.databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    // The migration version read and every subsequent DDL statement must share
    // one write lock. Per-version locks allow two starting processes to read the
    // same stale user_version and then execute the same CREATE/ALTER twice.
    this.transaction(() => this.migrate());
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `content_agent_nested_${depth}`;
    if (depth === 0) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (depth === 0) this.db.exec('COMMIT');
      else this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (depth === 0) this.db.exec('ROLLBACK');
      else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth = depth;
    }
  }

  private migrate(): void {
    let version = Number(this.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version < 1) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          system_role TEXT NOT NULL DEFAULT 'user' CHECK(system_role IN ('admin', 'user')),
          must_change_password INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          disabled_at TEXT
        );

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_hash TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX sessions_user_id_idx ON sessions(user_id);
        CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL,
          owner_id TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE workspace_members (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('Owner', 'Admin', 'KnowledgeEditor', 'ContentEditor', 'Viewer')),
          grants_json TEXT NOT NULL DEFAULT '[]',
          denies_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, user_id)
        );

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          profile_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          UNIQUE(workspace_id, slug)
        );
        CREATE INDEX projects_workspace_idx ON projects(workspace_id, deleted_at);

        CREATE TABLE project_acl (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          grants_json TEXT NOT NULL DEFAULT '[]',
          denies_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, user_id)
        );

        CREATE TABLE knowledge_files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          storage_path TEXT NOT NULL UNIQUE,
          media_type TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          category TEXT NOT NULL DEFAULT 'general',
          evidence_status TEXT NOT NULL DEFAULT 'unknown',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX knowledge_project_idx ON knowledge_files(project_id, deleted_at);

        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          key_prefix TEXT NOT NULL,
          secret_hash TEXT NOT NULL UNIQUE,
          permissions_json TEXT NOT NULL DEFAULT '["api.read"]',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );

        CREATE TABLE formula_versions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          definition_json TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          activated_at TEXT,
          UNIQUE(project_id, version)
        );

        CREATE TABLE generation_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          config_json TEXT NOT NULL,
          seed TEXT NOT NULL,
          formula_version_id TEXT REFERENCES formula_versions(id),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX generation_jobs_project_idx ON generation_jobs(project_id, created_at);

        CREATE TABLE content_packages (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          candidate_index INTEGER NOT NULL,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(job_id, candidate_index)
        );

        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT,
          user_id TEXT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX audit_workspace_idx ON audit_logs(workspace_id, created_at);

        PRAGMA user_version = 1;
      `);
    });
    if (version < 1) version = 1;

    if (version < 2) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE workspace_settings (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          provider_mode TEXT NOT NULL DEFAULT 'platform' CHECK(provider_mode IN ('platform', 'byok')),
          provider TEXT NOT NULL DEFAULT 'openai',
          model TEXT NOT NULL DEFAULT '',
          base_url TEXT NOT NULL DEFAULT '',
          transport TEXT NOT NULL DEFAULT 'responses' CHECK(transport IN ('responses', 'chat_completions')),
          encrypted_api_key TEXT,
          monthly_quota INTEGER NOT NULL DEFAULT 100,
          quota_used INTEGER NOT NULL DEFAULT 0,
          default_temperature REAL NOT NULL DEFAULT 0.8,
          config_json TEXT NOT NULL DEFAULT '{}',
          updated_by TEXT REFERENCES users(id),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE project_settings (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          config_json TEXT NOT NULL DEFAULT '{}',
          updated_by TEXT REFERENCES users(id),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE generation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          event TEXT NOT NULL,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX generation_events_job_idx ON generation_events(job_id, id);

        ALTER TABLE generation_jobs ADD COLUMN topic TEXT NOT NULL DEFAULT '';
        ALTER TABLE generation_jobs ADD COLUMN goal TEXT NOT NULL DEFAULT '';
        ALTER TABLE generation_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'simple';
        ALTER TABLE generation_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE generation_jobs ADD COLUMN error TEXT;
        ALTER TABLE generation_jobs ADD COLUMN completed_at TEXT;
        ALTER TABLE generation_jobs ADD COLUMN knowledge_context_json TEXT NOT NULL DEFAULT '{}';

        PRAGMA user_version = 2;
      `);
    });
    if (version < 2) version = 2;

    if (version < 3) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE projects ADD COLUMN style_profile_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE projects ADD COLUMN style_profile_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE projects ADD COLUMN style_profile_updated_at TEXT;

        CREATE TABLE generation_presets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          base_preset_id TEXT NOT NULL DEFAULT 'balanced_information',
          values_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX generation_presets_project_idx
          ON generation_presets(project_id, deleted_at, updated_at);

        CREATE TABLE project_preset_defaults (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          preset_id TEXT NOT NULL,
          updated_by TEXT NOT NULL REFERENCES users(id),
          updated_at TEXT NOT NULL
        );

        ALTER TABLE generation_jobs ADD COLUMN preset_id TEXT;
        ALTER TABLE generation_jobs ADD COLUMN style_profile_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE generation_jobs ADD COLUMN resolution_snapshot_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE generation_jobs ADD COLUMN config_impact_json TEXT NOT NULL DEFAULT '[]';

        PRAGMA user_version = 3;
      `);
    });
    if (version < 3) version = 3;

    if (version < 4) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE project_intelligence (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected', 'stale')),
          source_fingerprint TEXT NOT NULL,
          map_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT,
          UNIQUE(project_id, version)
        );
        CREATE INDEX project_intelligence_project_idx
          ON project_intelligence(project_id, deleted_at, version DESC);

        CREATE TABLE analysis_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('project', 'image')),
          target_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
          source_fingerprint TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          result_id TEXT,
          error TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          deleted_at TEXT
        );
        CREATE INDEX analysis_tasks_lookup_idx
          ON analysis_tasks(project_id, kind, target_id, source_fingerprint, status, deleted_at);

        CREATE TABLE information_gaps (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected', 'stale')),
          source_analysis_id TEXT,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT
        );
        CREATE INDEX information_gaps_project_idx
          ON information_gaps(project_id, deleted_at, status, priority DESC);

        CREATE TABLE expression_strategies (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected', 'stale')),
          source_analysis_id TEXT,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT
        );
        CREATE INDEX expression_strategies_project_idx
          ON expression_strategies(project_id, deleted_at, status, updated_at DESC);

        CREATE TABLE image_assets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          storage_path TEXT NOT NULL UNIQUE,
          media_type TEXT NOT NULL CHECK(media_type IN ('image/jpeg', 'image/png', 'image/webp')),
          bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          UNIQUE(project_id, sha256)
        );
        CREATE INDEX image_assets_project_idx
          ON image_assets(project_id, deleted_at, created_at DESC);

        CREATE TABLE image_analysis_versions (
          id TEXT PRIMARY KEY,
          image_asset_id TEXT NOT NULL REFERENCES image_assets(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected', 'stale')),
          source_fingerprint TEXT NOT NULL,
          observation_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT,
          UNIQUE(image_asset_id, version)
        );
        CREATE INDEX image_analysis_versions_asset_idx
          ON image_analysis_versions(image_asset_id, deleted_at, version DESC);

        CREATE TABLE topic_opportunities (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          angle TEXT NOT NULL DEFAULT '',
          rationale TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'approved', 'rejected', 'stale')),
          source_analysis_id TEXT,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT
        );
        CREATE INDEX topic_opportunities_project_idx
          ON topic_opportunities(project_id, deleted_at, status, updated_at DESC);

        CREATE TABLE coverage_records (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          generation_job_id TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
          content_package_id TEXT REFERENCES content_packages(id) ON UPDATE CASCADE ON DELETE SET NULL,
          opportunity_id TEXT REFERENCES topic_opportunities(id) ON DELETE SET NULL,
          signature_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX coverage_records_project_idx
          ON coverage_records(project_id, deleted_at, created_at DESC);
        CREATE INDEX coverage_records_job_idx
          ON coverage_records(generation_job_id, deleted_at);

        ALTER TABLE generation_jobs ADD COLUMN opportunity_id TEXT;
        ALTER TABLE generation_jobs ADD COLUMN opportunity_snapshot_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE generation_jobs ADD COLUMN planning_context_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE generation_jobs ADD COLUMN image_context_json TEXT NOT NULL DEFAULT '[]';

        PRAGMA user_version = 4;
      `);
    });
    if (version < 4) version = 4;

    if (version < 5) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE image_assets
          ADD COLUMN asset_kind TEXT NOT NULL DEFAULT 'source_material'
          CHECK(asset_kind = 'source_material');

        PRAGMA user_version = 5;
      `);
    });
    if (version < 5) version = 5;

    if (version < 6) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE research_claims (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          logical_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          parent_id TEXT REFERENCES research_claims(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          statement TEXT NOT NULL,
          claim_type TEXT NOT NULL CHECK(claim_type IN ('definition','external_research','internal_observation','inference','hypothesis','unknown')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','deprecated','rejected')),
          scope_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          reviewed_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          UNIQUE(project_id, logical_key, version)
        );
        CREATE INDEX research_claims_project_idx ON research_claims(project_id, status, logical_key, version DESC);

        CREATE TABLE evidence_sources (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          parent_id TEXT REFERENCES evidence_sources(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          citation TEXT NOT NULL,
          url TEXT,
          supports_text TEXT NOT NULL DEFAULT '',
          limitations_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','deprecated','rejected')),
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          reviewed_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          UNIQUE(project_id, source_key, version)
        );
        CREATE INDEX evidence_sources_project_idx ON evidence_sources(project_id, status, source_key, version DESC);

        CREATE TABLE claim_evidence_links (
          claim_id TEXT NOT NULL REFERENCES research_claims(id) ON DELETE CASCADE,
          evidence_source_id TEXT NOT NULL REFERENCES evidence_sources(id) ON DELETE CASCADE,
          relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','limits','context')),
          strength TEXT NOT NULL DEFAULT 'unrated' CHECK(strength IN ('unrated','weak','moderate','strong')),
          note TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          PRIMARY KEY(claim_id, evidence_source_id, relation)
        );

        CREATE TABLE dataset_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          dataset_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('internal_sample','experiment','live_observation','external')),
          sha256 TEXT NOT NULL,
          row_count INTEGER,
          storage_ref TEXT NOT NULL DEFAULT '',
          provenance TEXT NOT NULL DEFAULT '',
          limitations TEXT NOT NULL DEFAULT '',
          schema_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','deprecated','rejected')),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          approved_by TEXT REFERENCES users(id),
          approved_at TEXT,
          UNIQUE(project_id, dataset_key, version)
        );
        CREATE INDEX dataset_snapshots_project_idx ON dataset_snapshots(project_id, status, dataset_key, version DESC);

        CREATE TABLE experiment_versions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          experiment_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          parent_id TEXT REFERENCES experiment_versions(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          hypothesis TEXT NOT NULL,
          design_json TEXT NOT NULL DEFAULT '{}',
          metrics_json TEXT NOT NULL DEFAULT '[]',
          analysis_plan_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','preregistered','running','completed','replicated','rejected','archived')),
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          approved_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(project_id, experiment_key, version)
        );
        CREATE INDEX experiment_versions_project_idx ON experiment_versions(project_id, status, experiment_key, version DESC);

        CREATE TABLE experiment_results (
          id TEXT PRIMARY KEY,
          experiment_version_id TEXT NOT NULL REFERENCES experiment_versions(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          dataset_snapshot_id TEXT REFERENCES dataset_snapshots(id) ON DELETE SET NULL,
          result_json TEXT NOT NULL DEFAULT '{}',
          conclusion TEXT NOT NULL DEFAULT 'inconclusive' CHECK(conclusion IN ('supports','contradicts','inconclusive','not_analyzed')),
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','rejected')),
          created_by TEXT NOT NULL REFERENCES users(id),
          reviewed_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          UNIQUE(experiment_version_id, version)
        );

        CREATE TABLE calibration_proposals (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK(target_type IN ('parameter','formula','prompt','policy')),
          target_key TEXT NOT NULL,
          current_json TEXT NOT NULL DEFAULT '{}',
          proposed_json TEXT NOT NULL DEFAULT '{}',
          rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          impact_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','under_review','approved','rejected','applied')),
          created_by TEXT NOT NULL REFERENCES users(id),
          reviewed_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          applied_release_id TEXT
        );
        CREATE INDEX calibration_proposals_project_idx ON calibration_proposals(project_id, status, created_at DESC);

        CREATE TABLE release_manifests (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version TEXT NOT NULL,
          parent_id TEXT REFERENCES release_manifests(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','active','archived','rejected')),
          app_version TEXT NOT NULL,
          build_id TEXT NOT NULL DEFAULT '',
          formula_version_id TEXT REFERENCES formula_versions(id) ON DELETE SET NULL,
          formula_digest TEXT NOT NULL,
          execution_policy_version TEXT NOT NULL,
          execution_policy_digest TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          prompt_digest TEXT NOT NULL,
          parameter_policy_version TEXT NOT NULL,
          parameter_policy_digest TEXT NOT NULL,
          evidence_catalog_version TEXT NOT NULL,
          evidence_catalog_digest TEXT NOT NULL,
          bindings_json TEXT NOT NULL DEFAULT '{}',
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          approved_at TEXT,
          activated_at TEXT,
          UNIQUE(project_id, version)
        );
        CREATE UNIQUE INDEX release_manifests_active_idx ON release_manifests(project_id) WHERE status='active';
        CREATE INDEX release_manifests_project_idx ON release_manifests(project_id, status, created_at DESC);

        ALTER TABLE generation_jobs ADD COLUMN release_manifest_id TEXT REFERENCES release_manifests(id) ON DELETE SET NULL;
        ALTER TABLE generation_jobs ADD COLUMN research_snapshot_json TEXT NOT NULL DEFAULT '{}';

        PRAGMA user_version = 6;
      `);
    });
    if (version < 6) version = 6;

    if (version < 7) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE generation_jobs
          ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK(quality_status IN ('unknown','passed','needs_review'));

        PRAGMA user_version = 7;
      `);
    });
    if (version < 7) version = 7;

    if (version < 8) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE project_blueprint_modules (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          intelligence_id TEXT REFERENCES project_intelligence(id) ON DELETE SET NULL,
          source_analysis_id TEXT REFERENCES analysis_tasks(id) ON DELETE SET NULL,
          module_key TEXT NOT NULL CHECK(module_key IN (
            'knowledge_map','domain_model','audience_model','scenario_model',
            'role_model','claim_policy','surface_language'
          )),
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected','stale')),
          source_fingerprint TEXT NOT NULL,
          content_revision TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL REFERENCES users(id),
          approved_by TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          approved_at TEXT,
          deleted_at TEXT,
          UNIQUE(project_id, module_key, version)
        );
        CREATE INDEX project_blueprint_modules_project_idx
          ON project_blueprint_modules(project_id, module_key, status, deleted_at, version DESC);
        CREATE INDEX project_blueprint_modules_analysis_idx
          ON project_blueprint_modules(source_analysis_id, deleted_at);

        PRAGMA user_version = 8;
      `);
    });
    if (version < 8) version = 8;

    if (version < 9) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE topic_opportunities ADD COLUMN batch_id TEXT;
        ALTER TABLE topic_opportunities ADD COLUMN collection_status TEXT NOT NULL DEFAULT 'active';
        CREATE INDEX IF NOT EXISTS topic_opportunities_batch_idx
          ON topic_opportunities(project_id, batch_id, deleted_at);
        CREATE INDEX IF NOT EXISTS topic_opportunities_collection_idx
          ON topic_opportunities(project_id, collection_status, deleted_at, updated_at DESC);
        CREATE TABLE opportunity_batches (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          analysis_task_id TEXT,
          trigger TEXT NOT NULL DEFAULT 'refresh',
          user_guidance TEXT NOT NULL DEFAULT '',
          temperature REAL,
          opportunity_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX opportunity_batches_project_idx
          ON opportunity_batches(project_id, created_at DESC);
        CREATE TABLE opportunity_prompt_templates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          guidance TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX opportunity_prompt_templates_project_idx
          ON opportunity_prompt_templates(project_id, deleted_at, updated_at DESC);
        PRAGMA user_version = 9;
      `);
    });
    if (version < 9) version = 9;

    if (version < 10) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE registration_requests (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          organization_name TEXT NOT NULL,
          phone TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','approved','rejected')),
          review_note TEXT,
          reviewed_by TEXT REFERENCES users(id),
          reviewed_at TEXT,
          created_user_id TEXT REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX registration_requests_status_idx ON registration_requests(status, created_at);
        PRAGMA user_version = 10;
      `);
    });
    if (version < 10) version = 10;

    if (version < 11) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE users ADD COLUMN user_kind TEXT NOT NULL DEFAULT 'research'
          CHECK(user_kind IN ('research','saas'));

        PRAGMA user_version = 11;
      `);
    });
    if (version < 11) version = 11;

    if (version < 12) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE generation_batches (
          id           TEXT PRIMARY KEY,
          project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name         TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL,
          total_jobs   INTEGER NOT NULL DEFAULT 0,
          config_json  TEXT NOT NULL DEFAULT '{}',
          created_by   TEXT NOT NULL REFERENCES users(id),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX generation_batches_project_idx ON generation_batches(project_id, created_at);

        ALTER TABLE generation_jobs ADD COLUMN batch_id TEXT REFERENCES generation_batches(id) ON DELETE SET NULL;
        CREATE INDEX generation_jobs_batch_idx ON generation_jobs(batch_id);

        PRAGMA user_version = 12;
      `);
    });
    if (version < 12) version = 12;

    if (version < 13) this.transaction(() => {
      /*
       * 产出的软删除。
       *
       * 实测缺口:极简创作的产出区没有任何删除入口,单个项目跑到 33 条之后列表只增
       * 不减——失败的、试错的、重复的全部堆在一起,用户无法整理自己的工作区。
       *
       * 用 deleted_at 软删而不是物理删:
       *  - 内容包、事件、批次都靠 job_id 外键挂着,物理删会连带清掉审计痕迹;
       *  - 误删可撤销(付费产品里"删错了"必须有退路);
       *  - 已扣的额度不因删除退还,记录还在才解释得清账。
       */
      this.db.exec(`
        ALTER TABLE generation_jobs ADD COLUMN deleted_at TEXT;
        /*
         * 索引只建在 deleted_at 上,不做 (project_id, deleted_at) 复合索引。
         *
         * 从 v2/v3 升上来的老库里 generation_jobs 只有 id 一列(project_id 是 v1 建表
         * 时才有的,跳过 v1 的库没有它),复合索引会让整条迁移以
         * 「no such column: project_id」失败——实测两条迁移测试就是这样红的。
         * 列表查询已有 v1 的 generation_jobs_project_idx 顶住项目维度。
         */
        CREATE INDEX generation_jobs_deleted_idx ON generation_jobs(deleted_at);

        PRAGMA user_version = 13;
      `);
    });
    if (version < 13) version = 13;

    if (version < 14) this.transaction(() => {
      /*
       * 任务的实例归属与心跳。
       *
       * 队列与恢复逻辑原来假设「本进程独占这个 DB」:recoverInterruptedJobs 无条件
       * 抓全表 queued/running 重置,于是多实例下 B 启动会把 A 正在跑的任务判成
       * 「被重启打断」——同一任务被两个实例并发执行(重复烧模型调用),三轮误判后
       * 触顶判 failed。实测两个任务就是这么死的,报「被应用重启多次打断(3 次)」
       * 而实际上没有任何一次真正的重启。
       *
       * claimed_by 让领取变成原子事实:UPDATE ... WHERE status='queued' 的
       * changes===1 才算领到,SQLite 的单写者模型保证两个实例不可能都拿到。
       * heartbeat_at 让「实例死了」和「实例在正常跑」可区分,回收只动前者。
       *
       * 存量行 claimed_by 为 NULL。回收逻辑必须把「NULL 且 running」当作上一代
       * 进程留下的孤儿接管,否则升级那一刻在跑的任务会永久卡在 running。
       */
      this.db.exec(`
        ALTER TABLE generation_jobs ADD COLUMN claimed_by TEXT;
        ALTER TABLE generation_jobs ADD COLUMN claimed_at TEXT;
        ALTER TABLE generation_jobs ADD COLUMN heartbeat_at TEXT;
        /*
         * 索引只含本次 ALTER 出来的两列,不带 status。
         *
         * 见 v13 的同类说明:从 v3 升上来的老库里 generation_jobs 只有 id 一列,
         * status/project_id 都不存在,把它们写进索引会让整条迁移以「no such
         * column: status」失败(实测 migrates a v3 database 用例就是这样红的)。
         * 回收扫描按 heartbeat_at 筛,这个索引已经顶住;status 维度由 v1 的
         * generation_jobs_project_idx 与主键覆盖。
         */
        CREATE INDEX generation_jobs_claim_idx
          ON generation_jobs(claimed_by, heartbeat_at);

        /*
         * 分析任务是 insert 时直接 running 的同步 inline 执行,没有队列可回,
         * 所以只加归属与心跳、不加 claimed_at:它需要的是「别杀别人的」,
         * 不是「原子领取」。
         */
        ALTER TABLE analysis_tasks ADD COLUMN claimed_by TEXT;
        ALTER TABLE analysis_tasks ADD COLUMN heartbeat_at TEXT;

        PRAGMA user_version = 14;
      `);
    });
    if (version < 14) version = 14;

    if (version < 15) this.transaction(() => {
      /*
       * 修改任务(revise)的异步化。
       *
       * revise 原来是同步请求-响应:全程不落中间状态,前端只能显示一个转圈。而它
       * 耗时是分钟级(实测两次 revised 事件相隔 299s),公网下会撞上 Cloudflare 约
       * 100 秒超时——隧道日志已记录一次 context canceled。掐断后前端把指令追加进
       * 正文并提示「演示模式:已记录」,用户以为改好了,拿到的是被污染的正文。
       *
       * 状态放独立表而不是给 generation_jobs 加列:一个 job 会被改 N 次,单组列
       * 只记得住最后一次;而且 status 与 revision_status 并存会让所有读 job 状态
       * 的代码都要先问「你说的哪个状态」。generation_jobs.status 在改稿期间保持
       * completed——前端有 10 处按它判定能否查看产出,改它会让用户在改稿期间打不开
       * 自己的稿子。
       *
       * package_id 是执行时的权威目标(入队时一次性解析),candidate_id 保留用户
       * 传入的原值供追溯与前端匹配活跃任务。
       *
       * 没有 claimed_at 列:claimed_by + heartbeat_at 已足够判定归属与存活,
       * generation_jobs 的 claimed_at 至今没有消费方。
       */
      this.db.exec(`
        CREATE TABLE revision_tasks (
          id                  TEXT PRIMARY KEY,
          job_id              TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
          package_id          TEXT NOT NULL,
          candidate_id        TEXT NOT NULL,
          instruction         TEXT NOT NULL,
          status              TEXT NOT NULL,
          progress            INTEGER NOT NULL DEFAULT 0,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          error               TEXT,
          rerun_channels_json TEXT NOT NULL DEFAULT '[]',
          result_package_id   TEXT,
          created_by          TEXT NOT NULL REFERENCES users(id),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          completed_at        TEXT,
          claimed_by          TEXT,
          heartbeat_at        TEXT,
          /*
           * 这条任务累计扣了几次额度。
           *
           * 扣额度发生在每次执行(processRevision)调用模型之前,而重试是靠孤儿回收
           * 重新入队——kill -9 三次就扣三次,最后由回收判 failed,用户零产出。没有这个
           * 计数,回收那一侧无从知道该退几次:退 1 次会少退,固定退 3 次会在只扣过 1 次
           * 时白送。计数只在真正 consume 成功后 +1,退还时按退还的次数减,所以任何时刻
           * 它就是「已扣未退」的余额。
           */
          quota_consumed_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX revision_tasks_job_idx ON revision_tasks(job_id, created_at);
        CREATE INDEX revision_tasks_claim_idx ON revision_tasks(status, heartbeat_at);
        /*
         * 一个 job 同时只能有一条未终态的修改。应用层入队前会先查 pending 并给出可读
         * 的 409,但「先查后写」在多实例下不成立:两个进程能在彼此的查与写之间穿插,
         * 各插一条。这条部分唯一索引是 DB 层的最后防线。终态行不进索引,所以同一个
         * job 可以被反复修改。
         *
         * 互斥收在 job 级而不是 package 级:投影 activeFor(jobId) 是任务级的(一个 job
         * 只回一条活跃任务),包级互斥允许同一 job 的两个候选并发改稿,于是 A 候选的
         * 轮询会看不到自己的任务、立刻判「已完成」并把**未更新的旧候选**当成改稿结果
         * 报给用户。三个前端实际都是单飞行(一次只改一个候选),job 级互斥不减功能。
         */
        CREATE UNIQUE INDEX revision_tasks_active_job_idx
          ON revision_tasks(job_id) WHERE status IN ('queued','running');
      `);
      this.db.exec('PRAGMA user_version = 15');
    });
    if (version < 15) version = 15;

    if (version < 16) this.transaction(() => {
      /*
       * Knowledge versions used to be allocated with MAX(version)+1 outside the
       * INSERT transaction and had no unique constraint. Repair any duplicate
       * legacy rows before adding the database-level last line of defence.
       */
      const tableExists = (name: string): boolean => Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
      );
      const hasKnowledgeFiles = tableExists('knowledge_files');
      const hasWorkspaceMembership = tableExists('workspaces') && tableExists('workspace_members');

      // Some historical migration fixtures contain only the tables relevant to
      // their target version. A real v15 database has these v1 tables, but v16
      // should still upgrade those deliberately partial snapshots.
      if (hasKnowledgeFiles) {
        const duplicateGroups = this.prepare(
          `SELECT project_id, filename
             FROM knowledge_files
            GROUP BY project_id, filename
           HAVING COUNT(*) > COUNT(DISTINCT version)`,
        ).all() as Array<{ project_id: string; filename: string }>;
        const rowsForFile = this.prepare(
          `SELECT id, version FROM knowledge_files
            WHERE project_id = ? AND filename = ?
            ORDER BY version, created_at, id`,
        );
        const updateVersion = this.prepare('UPDATE knowledge_files SET version = ? WHERE id = ?');
        for (const group of duplicateGroups) {
          const rows = rowsForFile.all(group.project_id, group.filename) as Array<{ id: string; version: number }>;
          const used = new Set<number>();
          let next = rows.reduce((maximum, row) => Math.max(maximum, Number(row.version)), 0);
          for (const row of rows) {
            const current = Number(row.version);
            if (!used.has(current)) {
              used.add(current);
              continue;
            }
            do next += 1; while (used.has(next));
            updateVersion.run(next, row.id);
            used.add(next);
          }
        }
        this.db.exec(`
          CREATE UNIQUE INDEX knowledge_files_version_idx
            ON knowledge_files(project_id, filename, version);
        `);
      }

      /*
       * v15 and earlier allowed member upsert to create several Owners or
       * downgrade the canonical owner. Restore owner_id as the authority, then
       * enforce the invariant for all future writes, not only this controller.
       */
      if (hasWorkspaceMembership) this.db.exec(`
        INSERT INTO workspace_members
          (workspace_id, user_id, role, grants_json, denies_json, created_at, updated_at)
        SELECT id, owner_id, 'Owner', '[]', '[]', created_at, updated_at
          FROM workspaces
         WHERE NOT EXISTS (
           SELECT 1 FROM workspace_members
            WHERE workspace_id = workspaces.id AND user_id = workspaces.owner_id
         );

        UPDATE workspace_members
           SET role = 'Admin'
         WHERE role = 'Owner'
           AND user_id <> (SELECT owner_id FROM workspaces WHERE id = workspace_id);
        UPDATE workspace_members
           SET role = 'Owner', grants_json = '[]', denies_json = '[]'
         WHERE user_id = (SELECT owner_id FROM workspaces WHERE id = workspace_id);

        CREATE UNIQUE INDEX workspace_members_single_owner_idx
          ON workspace_members(workspace_id) WHERE role = 'Owner';

        CREATE TRIGGER workspace_member_owner_insert_guard
        BEFORE INSERT ON workspace_members
        WHEN (NEW.role = 'Owner' AND NEW.user_id <> (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
          OR (NEW.role <> 'Owner' AND NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
        BEGIN
          SELECT RAISE(ABORT, 'workspace owner role mismatch');
        END;

        CREATE TRIGGER workspace_member_owner_update_guard
        BEFORE UPDATE OF workspace_id, user_id, role ON workspace_members
        WHEN (NEW.role = 'Owner' AND NEW.user_id <> (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
          OR (NEW.role <> 'Owner' AND NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
        BEGIN
          SELECT RAISE(ABORT, 'workspace owner role mismatch');
        END;

        CREATE TRIGGER workspace_member_owner_delete_guard
        BEFORE DELETE ON workspace_members
        WHEN OLD.user_id = (SELECT owner_id FROM workspaces WHERE id = OLD.workspace_id)
        BEGIN
          SELECT RAISE(ABORT, 'workspace owner membership cannot be deleted');
        END;

        CREATE TRIGGER workspace_owner_update_guard
        BEFORE UPDATE OF owner_id ON workspaces
        WHEN NEW.owner_id <> OLD.owner_id
        BEGIN
          SELECT RAISE(ABORT, 'workspace ownership requires an explicit transfer transaction');
        END;
      `);
      this.db.exec('PRAGMA user_version = 16');
    });
    if (version < 16) version = 16;

    if (version < 17) this.transaction(() => {
      const tableExists = (name: string): boolean => Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
      );
      const hasWorkspaceMembership = tableExists('workspaces') && tableExists('workspace_members');
      const hasProjectAcl = hasWorkspaceMembership && tableExists('projects') && tableExists('project_acl');

      /*
       * owner_id is the sole ownership authority. v16 repaired Owner roles but
       * still allowed grants/denies and project ACL rows to override the
       * canonical owner's permissions. Clean those legacy rows, then enforce
       * the complete invariant for controller-independent writes.
       */
      if (hasWorkspaceMembership) {
        this.db.exec(`
          UPDATE workspace_members
             SET role = 'Owner', grants_json = '[]', denies_json = '[]'
           WHERE user_id = (SELECT owner_id FROM workspaces WHERE id = workspace_id);

          DROP TRIGGER IF EXISTS workspace_member_owner_insert_guard;
          DROP TRIGGER IF EXISTS workspace_member_owner_update_guard;

          CREATE TRIGGER workspace_member_owner_insert_guard
          BEFORE INSERT ON workspace_members
          WHEN (NEW.role = 'Owner' AND NEW.user_id <> (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
            OR (NEW.role <> 'Owner' AND NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
            OR (NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id)
                AND (NEW.grants_json <> '[]' OR NEW.denies_json <> '[]'))
          BEGIN
            SELECT RAISE(ABORT, 'workspace owner role or permission override mismatch');
          END;

          CREATE TRIGGER workspace_member_owner_update_guard
          BEFORE UPDATE OF workspace_id, user_id, role, grants_json, denies_json ON workspace_members
          WHEN (NEW.role = 'Owner' AND NEW.user_id <> (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
            OR (NEW.role <> 'Owner' AND NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id))
            OR (NEW.user_id = (SELECT owner_id FROM workspaces WHERE id = NEW.workspace_id)
                AND (NEW.grants_json <> '[]' OR NEW.denies_json <> '[]'))
          BEGIN
            SELECT RAISE(ABORT, 'workspace owner role or permission override mismatch');
          END;
        `);
      }

      if (hasProjectAcl) {
        this.db.exec(`
          DELETE FROM project_acl
           WHERE EXISTS (
             SELECT 1
               FROM projects p
               JOIN workspaces w ON w.id = p.workspace_id
              WHERE p.id = project_acl.project_id AND w.owner_id = project_acl.user_id
           );

          CREATE TRIGGER IF NOT EXISTS project_acl_owner_insert_guard
          BEFORE INSERT ON project_acl
          WHEN EXISTS (
            SELECT 1
              FROM projects p
              JOIN workspaces w ON w.id = p.workspace_id
             WHERE p.id = NEW.project_id AND w.owner_id = NEW.user_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'workspace owner project ACL is not allowed');
          END;

          CREATE TRIGGER IF NOT EXISTS project_acl_owner_update_guard
          BEFORE UPDATE OF project_id, user_id, grants_json, denies_json ON project_acl
          WHEN EXISTS (
            SELECT 1
              FROM projects p
              JOIN workspaces w ON w.id = p.workspace_id
             WHERE p.id = NEW.project_id AND w.owner_id = NEW.user_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'workspace owner project ACL is not allowed');
          END;
        `);
      }

      this.db.exec('PRAGMA user_version = 17');
    });
    if (version < 17) version = 17;

    if (version < 18) this.transaction(() => {
      const hasAnalysisTasks = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_tasks'").get(),
      );
      /*
       * Persist the number of platform calls charged to an inline analysis task
       * but not yet settled. A process can die, lose its lease, or have its
       * workspace deleted while the provider request is in flight; without this
       * balance the recovery side cannot distinguish a real charge from a call
       * that never started.
       *
       * Some migration tests intentionally use partial historical snapshots. A
       * real v17 database has analysis_tasks, but skipping the ALTER when that
       * table is absent keeps those fixtures upgradeable.
       */
      if (hasAnalysisTasks) {
        const hasQuotaBalance = Boolean(
          this.prepare("SELECT 1 FROM pragma_table_info('analysis_tasks') WHERE name='quota_consumed_count'").get(),
        );
        if (!hasQuotaBalance) {
          this.db.exec(
            'ALTER TABLE analysis_tasks ADD COLUMN quota_consumed_count INTEGER NOT NULL DEFAULT 0',
          );
        }
      }
      this.db.exec('PRAGMA user_version = 18');
    });
    if (version < 18) version = 18;

    if (version < 19) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
          scope TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
          reset_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(scope, key_hash)
        );
        CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx
          ON rate_limit_buckets(reset_at);
        PRAGMA user_version = 19;
      `);
    });
    if (version < 19) version = 19;

    if (version < 20) this.transaction(() => {
      const hasAnalysisTasks = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_tasks'").get(),
      );
      // Partial migration fixtures may not contain analysis_tasks. Real databases do.
      if (hasAnalysisTasks) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS analysis_task_turns (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES analysis_tasks(id) ON DELETE CASCADE,
            turn_index INTEGER NOT NULL CHECK(turn_index >= 1),
            turn_key TEXT NOT NULL,
            label TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
            user_message TEXT NOT NULL,
            assistant_message TEXT,
            output_json TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            UNIQUE(task_id, turn_index),
            UNIQUE(task_id, turn_key)
          );
          CREATE INDEX IF NOT EXISTS analysis_task_turns_task_idx
            ON analysis_task_turns(task_id, turn_index);
          CREATE TRIGGER IF NOT EXISTS analysis_task_turns_terminal_sync
          AFTER UPDATE OF status ON analysis_tasks
          WHEN NEW.status IN ('completed', 'failed')
          BEGIN
            UPDATE analysis_task_turns
               SET status='failed',
                   error=COALESCE(error, 'Analysis task ended before this turn completed.'),
                   completed_at=COALESCE(completed_at, NEW.completed_at),
                   updated_at=NEW.updated_at
             WHERE task_id=NEW.id AND status='running';
          END;
        `);
      }
      this.db.exec('PRAGMA user_version = 20');
    });
    if (version < 20) version = 20;

    if (version < 21) this.transaction(() => {
      const hasProjects = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get(),
      );
      // Partial migration fixtures may omit the application tables. Real databases contain projects/users.
      if (hasProjects) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS agent_harness_jobs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
            progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
            topic TEXT NOT NULL,
            goal TEXT NOT NULL DEFAULT '',
            task_json TEXT NOT NULL DEFAULT '{}',
            runtime_snapshot_json TEXT NOT NULL DEFAULT '{}',
            evidence_snapshot_json TEXT NOT NULL DEFAULT '[]',
            decision_summary TEXT NOT NULL DEFAULT '',
            review_summary TEXT NOT NULL DEFAULT '',
            usage_json TEXT NOT NULL DEFAULT '{}',
            error TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
            quota_consumed_count INTEGER NOT NULL DEFAULT 0 CHECK(quota_consumed_count >= 0),
            created_by TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT,
            claimed_by TEXT,
            claimed_at TEXT,
            heartbeat_at TEXT,
            deleted_at TEXT
          );
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_project_idx
            ON agent_harness_jobs(project_id, deleted_at, created_at DESC);
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_claim_idx
            ON agent_harness_jobs(status, claimed_by, heartbeat_at, created_at);

          CREATE TABLE IF NOT EXISTS agent_harness_candidates (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES agent_harness_jobs(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            candidate_index INTEGER NOT NULL CHECK(candidate_index BETWEEN 0 AND 2),
            content_json TEXT NOT NULL,
            validation_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(job_id, candidate_index)
          );
          CREATE INDEX IF NOT EXISTS agent_harness_candidates_job_idx
            ON agent_harness_candidates(job_id, candidate_index);

          CREATE TABLE IF NOT EXISTS agent_harness_tool_calls (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES agent_harness_jobs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK(sequence >= 1),
            action TEXT NOT NULL CHECK(action IN ('search_knowledge','read_evidence','submit_candidates')),
            input_json TEXT NOT NULL DEFAULT '{}',
            output_json TEXT NOT NULL DEFAULT '{}',
            summary TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(job_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS agent_harness_tool_calls_job_idx
            ON agent_harness_tool_calls(job_id, sequence);
        `);
      }
      this.db.exec('PRAGMA user_version = 21');
    });
    if (version < 21) version = 21;

    if (version < 22) this.transaction(() => {
      const hasHarnessJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_harness_jobs'").get(),
      );
      if (hasHarnessJobs) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('agent_harness_jobs')").all() as { name: string }[])
            .map((row) => row.name),
        );
        const additions: Array<[string, string]> = [
          ['parent_job_id', 'TEXT REFERENCES agent_harness_jobs(id) ON DELETE SET NULL'],
          ['run_kind', "TEXT NOT NULL DEFAULT 'original' CHECK(run_kind IN ('original','retry','revision'))"],
          ['source_candidate_id', 'TEXT'],
          ['instruction', "TEXT NOT NULL DEFAULT ''"],
          ['image_snapshot_json', "TEXT NOT NULL DEFAULT '[]'"],
          ['claim_audit_summary', "TEXT NOT NULL DEFAULT ''"],
        ];
        for (const [name, definition] of additions) {
          if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_harness_jobs ADD COLUMN ${name} ${definition}`);
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_parent_idx
            ON agent_harness_jobs(parent_job_id, created_at DESC);
        `);
      }
      this.db.exec('PRAGMA user_version = 22');
    });
    if (version < 22) version = 22;

    if (version < 23) this.transaction(() => {
      const hasHarnessJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_harness_jobs'").get(),
      );
      if (hasHarnessJobs) {
        this.db.exec(`
          CREATE TRIGGER IF NOT EXISTS agent_harness_jobs_active_retry_guard
          BEFORE INSERT ON agent_harness_jobs
          WHEN NEW.run_kind='retry' AND NEW.status IN ('queued','running') AND NEW.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM agent_harness_jobs existing
               WHERE existing.parent_job_id=NEW.parent_job_id
                 AND existing.run_kind='retry'
                 AND existing.status IN ('queued','running')
                 AND existing.deleted_at IS NULL
            )
          BEGIN
            SELECT RAISE(ABORT, 'active agent harness retry already exists');
          END;

          CREATE TRIGGER IF NOT EXISTS agent_harness_jobs_active_revision_guard
          BEFORE INSERT ON agent_harness_jobs
          WHEN NEW.run_kind='revision' AND NEW.status IN ('queued','running') AND NEW.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM agent_harness_jobs existing
               WHERE existing.parent_job_id=NEW.parent_job_id
                 AND existing.source_candidate_id=NEW.source_candidate_id
                 AND existing.run_kind='revision'
                 AND existing.status IN ('queued','running')
                 AND existing.deleted_at IS NULL
            )
          BEGIN
            SELECT RAISE(ABORT, 'active agent harness revision already exists');
          END;
        `);
      }
      this.db.exec('PRAGMA user_version = 23');
    });
    if (version < 23) version = 23;

    if (version < 24) this.transaction(() => {
      const hasHarnessJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_harness_jobs'").get(),
      );
      if (hasHarnessJobs) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('agent_harness_jobs')").all() as { name: string }[])
            .map((row) => row.name),
        );
        const additions: Array<[string, string]> = [
          ['project_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['provider_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['source_candidate_job_id', 'TEXT'],
          ['failure_stage', "TEXT NOT NULL DEFAULT ''"],
          ['partial_usage_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['provider_started_at', 'TEXT'],
          ['cancelled_at', 'TEXT'],
          ['cancelled_by', 'TEXT'],
          ['selected_candidate_id', 'TEXT'],
          ['approval_status', "TEXT NOT NULL DEFAULT 'draft' CHECK(approval_status IN ('draft','selected','approved'))"],
          ['approval_notes', "TEXT NOT NULL DEFAULT ''"],
          ['approved_by', 'TEXT'],
          ['approved_at', 'TEXT'],
          ['approved_content_hash', "TEXT NOT NULL DEFAULT ''"],
          ['purge_after', 'TEXT'],
        ];
        for (const [name, definition] of additions) {
          if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_harness_jobs ADD COLUMN ${name} ${definition}`);
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_queue_fairness_idx
            ON agent_harness_jobs(status, deleted_at, created_by, created_at);
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_purge_idx
            ON agent_harness_jobs(deleted_at, purge_after);
        `);
      }
      this.db.exec('PRAGMA user_version = 24');
    });
    if (version < 24) version = 24;

    if (version < 25) this.transaction(() => {
      const hasHarnessJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_harness_jobs'").get(),
      );
      if (hasHarnessJobs) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('agent_harness_jobs')").all() as { name: string }[])
            .map((row) => row.name),
        );
        const additions: Array<[string, string]> = [
          ['review_status', "TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','running','completed','blocked'))"],
          ['review_error', "TEXT NOT NULL DEFAULT ''"],
          ['review_attempt_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(review_attempt_count >= 0)'],
          ['candidate_checkpoint_at', 'TEXT'],
          ['read_evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
        ];
        for (const [name, definition] of additions) {
          if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_harness_jobs ADD COLUMN ${name} ${definition}`);
        }
        this.db.exec(`
          UPDATE agent_harness_jobs
             SET review_status=CASE
               WHEN status='completed' AND EXISTS (SELECT 1 FROM agent_harness_candidates c WHERE c.job_id=agent_harness_jobs.id)
                 THEN 'completed'
               WHEN status='failed' AND EXISTS (SELECT 1 FROM agent_harness_candidates c WHERE c.job_id=agent_harness_jobs.id)
                 THEN 'blocked'
               ELSE review_status
             END,
             candidate_checkpoint_at=CASE
               WHEN candidate_checkpoint_at IS NULL AND EXISTS (SELECT 1 FROM agent_harness_candidates c WHERE c.job_id=agent_harness_jobs.id)
                 THEN updated_at
               ELSE candidate_checkpoint_at
             END;
          CREATE INDEX IF NOT EXISTS agent_harness_jobs_review_idx
            ON agent_harness_jobs(review_status, status, deleted_at, updated_at);
        `);
      }
      this.db.exec('PRAGMA user_version = 25');
    });
    if (version < 25) version = 25;

    if (version < 26) this.transaction(() => {
      const hasGenerationJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_jobs'").get(),
      );
      if (hasGenerationJobs) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('generation_jobs')").all() as { name: string }[])
            .map((row) => row.name),
        );
        if (!columns.has('delivery_quality_status')) {
          this.db.exec(`
            ALTER TABLE generation_jobs
              ADD COLUMN delivery_quality_status TEXT NOT NULL DEFAULT 'unknown'
              CHECK(delivery_quality_status IN ('unknown','passed','needs_review','blocked'));
          `);
        }
        if (columns.has('quality_status')) {
          this.db.exec("UPDATE generation_jobs SET delivery_quality_status=quality_status WHERE delivery_quality_status='unknown'");
        }
      }
      this.db.exec('PRAGMA user_version = 26');
    });
    if (version < 26) version = 26;

    if (version < 27) this.transaction(() => {
      const hasGenerationJobs = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_jobs'").get(),
      );
      if (hasGenerationJobs) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('generation_jobs')").all() as { name: string }[])
            .map((row) => row.name),
        );
        /*
         * 生成任务的「已扣未退」额度余额,语义与 revision_tasks 同名列一致:
         * 入队时平台扣 1 就记 1,终态结算按「交付了产出留 1,零产出留 0」退还差额。
         * 此前入队扣款没有任何记账,失败/删除/断供清队一律不退——用户零产出照样
         * 扣费,而修改任务同样情形是退的。存量行保持 0:历史任务无法区分是否已
         * 交付,不做追溯退款。
         */
        if (!columns.has('quota_consumed_count')) {
          this.db.exec('ALTER TABLE generation_jobs ADD COLUMN quota_consumed_count INTEGER NOT NULL DEFAULT 0 CHECK(quota_consumed_count >= 0)');
        }
      }
      this.db.exec('PRAGMA user_version = 27');
    });
    if (version < 27) version = 27;

    if (version < 28) this.transaction(() => {
      /*
       * /health 写探测的落点。此前 /health 只返回版本常量:磁盘满、库文件损坏
       * 时它照样报 ok,外部监控毫无感知。探测表单行 upsert,不与业务表混写。
       */
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS health_probe (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          checked_at TEXT NOT NULL
        );
      `);
      this.db.exec('PRAGMA user_version = 28');
    });
    if (version < 28) version = 28;

    if (version < 29) this.transaction(() => {
      /*
       * 平台额度逐笔流水。此前 quota_used 是工作区级单计数器,扣退款正确但
       * **不可自证**:客户质疑「这个月为什么扣了我 87 次」时,只能人工考古
       * 事件表且有洞(分析任务完成时把 quota_consumed_count 清零,扣费痕迹
       * 被抹掉)。流水在 consume/refund 的同一事务内写入:
       * - delta:+1 消耗 / 负数为退还(记**实际**变动——refund 的 MAX(0,…)
       *   下限保护意味着实际退还可能小于请求数,账本必须记真实发生额);
       * - balance_after:变动后 quota_used 快照,对账锚点;
       * - reason/entity_type/entity_id:归属到具体任务或删除/断供事件。
       * 月度对账按 created_at 的 YYYY-MM 前缀分桶,不清零计数器。
       */
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS quota_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          delta INTEGER NOT NULL CHECK(delta != 0),
          balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
          reason TEXT NOT NULL,
          entity_type TEXT,
          entity_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS quota_ledger_workspace_idx
          ON quota_ledger(workspace_id, created_at);
      `);
      this.db.exec('PRAGMA user_version = 29');
    });
    if (version < 29) version = 29;

    if (version < 30) this.transaction(() => {
      /*
       * content_json 整包单列(实测单包可达 1MB)曾让所有热路径付 parse 税:
       * 列表轮询对每个非 passed 任务全包 parse 重投影;按 candidateId 找包是
       * 顺序全量 parse。物化两列消掉这两处大头(写包同一事务落值,读路径优先
       * 走小列,缺失回退旧路径——历史损坏行不阻断):
       * - candidate_id:直查代替顺序扫描;
       * - issue_summary_json:重投影只需要 {valid, issues[{code,severity,
       *   disposition}]},几百字节代替 1MB。
       * 回填遍历存量包 parse 一次;parse 失败的行留 NULL,读取回退兜底。
       */
      const hasPackages = Boolean(
        this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_packages'").get(),
      );
      if (hasPackages) {
        const columns = new Set(
          (this.prepare("SELECT name FROM pragma_table_info('content_packages')").all() as { name: string }[])
            .map((row) => row.name),
        );
        if (!columns.has('candidate_id')) this.db.exec('ALTER TABLE content_packages ADD COLUMN candidate_id TEXT');
        if (!columns.has('issue_summary_json')) this.db.exec('ALTER TABLE content_packages ADD COLUMN issue_summary_json TEXT');
        // 迁移测试的 v3 快照库没有 job_id 列(真实老库不可能没有,但迁移链
        // 必须能跑完 fixture,见本文件其他迁移的同款防御);缺列时只建单列索引。
        if (columns.has('job_id')) {
          this.db.exec('CREATE INDEX IF NOT EXISTS content_packages_candidate_idx ON content_packages(job_id, candidate_id)');
        } else {
          this.db.exec('CREATE INDEX IF NOT EXISTS content_packages_candidate_idx ON content_packages(candidate_id)');
        }
        // 同款 fixture 防御:v3 快照库连 content_json 列都没有,回填只对真实形状执行。
        const rows = columns.has('content_json')
          ? this.prepare('SELECT id, content_json FROM content_packages WHERE candidate_id IS NULL').all() as Array<{ id: string; content_json: string }>
          : [];
        const update = this.prepare('UPDATE content_packages SET candidate_id=?, issue_summary_json=? WHERE id=?');
        for (const row of rows) {
          try {
            const content = JSON.parse(row.content_json) as {
              candidateId?: string;
              validation?: { valid?: boolean; issues?: Array<{ code?: string; severity?: string; disposition?: string }> };
            };
            const summary = content.validation
              ? JSON.stringify({
                valid: content.validation.valid === true,
                issues: (content.validation.issues ?? []).map((issue) => ({
                  code: issue.code, severity: issue.severity, disposition: issue.disposition,
                })),
              })
              : null;
            update.run(content.candidateId ?? null, summary, row.id);
          } catch { /* 损坏行留 NULL,读取路径回退整包 parse */ }
        }
      }
      this.db.exec('PRAGMA user_version = 30');
    });
    if (version < 30) version = 30;
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
