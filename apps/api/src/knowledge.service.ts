import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  evidenceIdForSection,
  findSupportingSectionEvidenceIds,
  indexKnowledgeSource,
  selectKnowledgeContext,
  type EvidenceStatus,
  type KnowledgeContextSelection,
  type KnowledgeDocument,
  type KnowledgeKind,
  type KnowledgeSection,
} from '@content-agent/agent-core';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { assertKnowledgeContextBudget, assertKnowledgeRowsBudget } from './knowledge-budget.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import {
  analysisStateFrom,
  classifyGap,
  summarize,
  PREFLIGHT_NOTE,
  type PreflightGapResult,
} from './knowledge-preflight.js';
import { readStoredText, removeStoredFile, validateStoredFile } from './storage-file.js';
import { nowIso, parseJson } from './utils.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = new Set(['.md', '.txt']);
// Generous budget so selectKnowledgeContext always takes its "full" mode, whose
// sections are exactly the per-document canonical splits (never truncated), i.e.
// the same section identity generation-time evidence binding uses.
const EVIDENCE_SECTION_TOKEN_BUDGET = 100_000_000;
/**
 * 缺口 sourceStatus 的合法取值。
 *
 * preflight 直接读 data_json,不经 normalizeGap,所以白名单要在这里再过一遍——
 * 库里实测有 'unacknowledged' 这种不在联合类型里的历史值。与
 * intelligence.service.ts 的 GAP_SOURCE_STATUSES 保持一致。
 */
const GAP_SOURCE_STATUSES = new Set([
  'supplied_fact', 'user_supplied', 'inference', 'hypothesis', 'unknown',
]);
/** 没有可引用文件时的空选择。不用 selectKnowledgeContext 空跑一次,省一次无意义的分节。 */
const EMPTY_SELECTION: KnowledgeContextSelection = {
  mode: 'empty',
  content: '',
  sections: [],
  selectedDocumentIds: [],
  omittedDocumentIds: [],
  estimatedTokens: 0,
  availableTokens: 0,
  generatedIndex: false,
  warnings: [],
};

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
  ) {}

  list(projectId: string): Record<string, unknown>[] {
    this.resources.projectRow(projectId);
    return this.database
      .prepare(
        `SELECT * FROM knowledge_files
         WHERE project_id = ? AND deleted_at IS NULL ORDER BY category, filename, version`,
      )
      .all(projectId)
      .map((row) => this.map(row as Record<string, unknown>));
  }

  row(fileId: string): Record<string, unknown> {
    const row = this.database
      .prepare('SELECT * FROM knowledge_files WHERE id = ? AND deleted_at IS NULL')
      .get(fileId) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException('知识文件不存在');
    return row;
  }

  async getWithContent(fileId: string): Promise<Record<string, unknown>> {
    const row = this.row(fileId);
    const content = await readStoredText({
      dataDir: this.database.options.dataDir,
      projectDir: join(this.database.knowledgeDir, String(row.project_id)),
      storagePath: String(row.storage_path),
    }, MAX_FILE_BYTES);
    return { ...this.map(row), content };
  }

  async import(input: {
    projectId: string;
    filename: string;
    content: string | Buffer;
    category?: string;
    evidenceStatus?: string;
    metadata?: Record<string, unknown>;
    principal: SessionPrincipal;
  }): Promise<Record<string, unknown>> {
    this.resources.projectRow(input.projectId);
    const cleanFilename = this.validateFilename(input.filename);
    const ext = extname(cleanFilename).toLowerCase();
    const buffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    if (buffer.byteLength > MAX_FILE_BYTES) throw new PayloadTooLargeException('知识文件不能超过 2 MiB');
    const text = buffer.toString('utf8');
    if (text.includes('\u0000') || Buffer.from(text, 'utf8').compare(buffer) !== 0) {
      throw new BadRequestException('文件必须是有效的 UTF-8 文本');
    }

    const id = randomUUID();
    const projectDir = join(this.database.knowledgeDir, input.projectId);
    await mkdir(projectDir, { recursive: true });
    const target = join(projectDir, `${id}${ext}`);
    const temporary = `${target}.tmp`;
    let version = 0;
    const now = nowIso();
    const storagePath = relative(this.database.options.dataDir, target).replaceAll('\\', '/');
    try {
      await writeFile(temporary, buffer, { flag: 'wx' });
      await rename(temporary, target);
      return this.database.transaction(() => {
        const project = this.resources.projectRow(input.projectId);
        const versionRow = this.database
          .prepare(
            `SELECT COALESCE(MAX(version), 0) AS version FROM knowledge_files
             WHERE project_id = ? AND filename = ?`,
          )
          .get(input.projectId, cleanFilename) as { version: number };
        version = Number(versionRow.version) + 1;
        this.database
          .prepare(
            `INSERT INTO knowledge_files
               (id, project_id, filename, storage_path, media_type, bytes, sha256, version,
                category, evidence_status, metadata_json, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.projectId,
            cleanFilename,
            storagePath,
            ext === '.md' ? 'text/markdown' : 'text/plain',
            buffer.byteLength,
            createHash('sha256').update(buffer).digest('hex'),
            version,
            (input.category ?? 'general').slice(0, 80),
            (input.evidenceStatus ?? 'unknown').slice(0, 80),
            JSON.stringify(input.metadata ?? {}),
            input.principal.userId,
            now,
            now,
          );
        this.audit.record({
          workspaceId: String(project.workspace_id),
          userId: input.principal.userId,
          action: 'knowledge.import',
          entityType: 'knowledge-file',
          entityId: id,
          details: { projectId: input.projectId, filename: cleanFilename, version },
        });
        this.intelligence.markProjectStale(input.projectId);
        return this.map(this.row(id));
      });
    } catch (error) {
      await Promise.all([
        unlink(temporary).catch(() => undefined),
        unlink(target).catch(() => undefined),
      ]);
      throw error;
    }
  }

  /**
   * 重新归类已有文件(分类 / 证据类型),不改内容、不升版本。
   *
   * 原来只能「删除后重传」:分类填错一次就得把文件删掉再上传一遍,对运营是纯摩擦。
   *
   * 但分类不是标签——它决定这份资料怎么参与生成:reference-corpus 会被排除出
   * 生成语料、只用于校准校验器(见 selectKnowledgeContext),evidenceStatus 影响
   * 事实能否被当作依据引用。所以改完必须让已审批的分析链失效,与上传/删除同一处理,
   * 否则内容地图与实际语料不符还显示「已就绪」。
   */
  recategorize(
    fileId: string,
    input: { category?: string; evidenceStatus?: string },
    principal: SessionPrincipal,
  ): Record<string, unknown> {
    const category = typeof input.category === 'string' && input.category.trim()
      ? input.category.trim().slice(0, 80)
      : undefined;
    const evidenceStatus = typeof input.evidenceStatus === 'string' && input.evidenceStatus.trim()
      ? input.evidenceStatus.trim().slice(0, 80)
      : undefined;
    // 不做无声空操作:没有任何可改字段时明确报错,免得调用方以为改成功了
    if (!category && !evidenceStatus) {
      throw new BadRequestException('请提供 category 或 evidenceStatus');
    }

    return this.database.transaction(() => {
      const row = this.row(fileId);
      const projectId = String(row.project_id);
      const project = this.resources.projectRow(projectId);
      const updated = this.database
        .prepare(
          `UPDATE knowledge_files
              SET category = COALESCE(?, category),
                  evidence_status = COALESCE(?, evidence_status),
                  updated_at = ?
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(category ?? null, evidenceStatus ?? null, nowIso(), fileId);
      if (Number(updated.changes) !== 1) throw new NotFoundException('知识文件不存在');
      this.audit.record({
        workspaceId: String(project.workspace_id),
        userId: principal.userId,
        action: 'knowledge.recategorize',
        entityType: 'knowledge-file',
        entityId: fileId,
        details: {
          from: { category: row.category, evidenceStatus: row.evidence_status },
          to: { category: category ?? row.category, evidenceStatus: evidenceStatus ?? row.evidence_status },
        },
      });
      this.intelligence.markProjectStale(projectId);
      return this.map(this.row(fileId));
    });
  }

  async remove(fileId: string, principal: SessionPrincipal): Promise<void> {
    const row = this.row(fileId);
    const projectId = String(row.project_id);
    const scope = {
      dataDir: this.database.options.dataDir,
      projectDir: join(this.database.knowledgeDir, projectId),
      storagePath: String(row.storage_path),
    };
    // Reject an invalid/symlinked path before committing the logical delete.
    // The second validation inside removeStoredFile protects the post-commit race.
    await validateStoredFile(scope, true);
    this.database.transaction(() => {
      const current = this.row(fileId);
      const project = this.resources.projectRow(String(current.project_id));
      if (String(current.project_id) !== projectId || String(current.storage_path) !== String(row.storage_path)) {
        throw new BadRequestException('知识文件状态已变化，请重试');
      }
      const now = nowIso();
      const removed = this.database
        .prepare(
          `UPDATE knowledge_files SET deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, now, fileId);
      if (Number(removed.changes) !== 1) throw new NotFoundException('知识文件不存在');
      this.audit.record({
        workspaceId: String(project.workspace_id),
        userId: principal.userId,
        action: 'knowledge.delete',
        entityType: 'knowledge-file',
        entityId: fileId,
      });
      this.intelligence.markProjectStale(projectId);
    });
    // The database row is the deletion authority. Cleanup is best-effort so an
    // I/O error cannot turn a committed, audited delete into a misleading 500.
    await removeStoredFile(scope).catch(() => undefined);
  }

  index(projectId: string): string {
    const files = this.list(projectId);
    const lines = ['# Knowledge Index', '', `Project: ${projectId}`, ''];
    let previousCategory = '';
    for (const file of files) {
      const category = String(file.category);
      if (category !== previousCategory) {
        lines.push(`## ${category}`, '');
        previousCategory = category;
      }
      lines.push(
        `- ${file.filename} (v${file.version}, ${file.bytes} bytes, evidence: ${file.evidenceStatus})`,
      );
    }
    if (files.length === 0) lines.push('_No knowledge files imported._');
    return lines.join('\n');
  }

  /**
   * Section-level evidence catalogue for the gap editor's evidence picker
   * (Cref v1.1). Indexes every latest-version knowledge file exactly like
   * generation.service.ts loadKnowledge does, splits each document into its
   * canonical sections and computes the content-addressed evidence id a later
   * generation will accept. Style corpora (scope style-analysis-only, i.e.
   * category reference-corpus) are excluded: they calibrate validators, they
   * are never citable evidence (see engine.filterKnowledge).
   */
  async evidenceSections(projectId: string): Promise<Record<string, unknown>> {
    const { documents, selection, warnings } = await this.evidenceDocumentSelection(projectId, '证据目录');
    if (!documents.length) return { documents: [], warnings };
    const sectionsByDocument = new Map<string, KnowledgeSection[]>();
    for (const section of selection.sections) {
      if (section.documentId === 'generated') continue;
      const list = sectionsByDocument.get(section.documentId) ?? [];
      list.push(section);
      sectionsByDocument.set(section.documentId, list);
    }
    return {
      documents: [...documents]
        .sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'))
        .map((document) => ({
          id: document.id,
          path: document.path,
          title: document.metadata.title,
          kind: document.metadata.kind,
          evidenceStatus: document.metadata.evidenceStatus,
          sections: (sectionsByDocument.get(document.id) ?? []).map((section) => ({
            evidenceId: evidenceIdForSection(section),
            sectionId: section.id,
            heading: section.heading ?? '',
            excerpt: section.content.replace(/\s+/gu, ' ').trim().slice(0, 120),
            charLength: section.content.length,
            kind: document.metadata.kind,
            evidenceStatus: document.metadata.evidenceStatus,
            caveats: document.metadata.caveats,
          })),
        })),
      warnings,
    };
  }

  /**
   * 取最新版知识文件、分节、算出生成会接受的证据 id —— 证据目录与完善度预检共用这一段。
   *
   * 抽出来是因为预检需要**分节全文**跑 conservativeEvidenceSupport,而 evidenceSections
   * 对外只回 120 字摘要,拿它的返回值不够用。两处必须走同一套索引,否则预检算出的
   * 证据 id 和生成时的不是一回事。
   */
  private async evidenceDocumentSelection(
    projectId: string,
    operation: string,
  ): Promise<{ documents: KnowledgeDocument[]; selection: KnowledgeContextSelection; warnings: string[] }> {
    this.resources.projectRow(projectId);
    const rows = this.database
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY filename
             ORDER BY version DESC, created_at DESC, id DESC
           ) AS version_rank
           FROM knowledge_files
           WHERE project_id=? AND deleted_at IS NULL
         )
         SELECT * FROM ranked WHERE version_rank=1 ORDER BY filename`,
      )
      .all(projectId) as unknown as Record<string, unknown>[];
    const warnings: string[] = [];
    const documents: KnowledgeDocument[] = [];
    const readableRows = rows.filter((row) => {
      if (String(row.category) === 'reference-corpus') return false;
      if (Number(row.bytes) > MAX_FILE_BYTES) {
        warnings.push(`知识文件 ${String(row.filename)} 超过 2 MiB，已跳过分节索引`);
        return false;
      }
      return true;
    });
    assertKnowledgeRowsBudget(operation, readableRows);
    let actualBytes = 0;
    for (const row of readableRows) {
      let content: string;
      try {
        content = await readStoredText({
          dataDir: this.database.options.dataDir,
          projectDir: join(this.database.knowledgeDir, projectId),
          storagePath: String(row.storage_path),
        }, MAX_FILE_BYTES);
      } catch {
        warnings.push(`知识文件 ${String(row.filename)} 磁盘读取失败，已跳过分节索引`);
        continue;
      }
      actualBytes += Buffer.byteLength(content, 'utf8');
      assertKnowledgeContextBudget({
        operation,
        fileCount: readableRows.length,
        totalBytes: actualBytes,
      });
      const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json), {});
      documents.push(indexKnowledgeSource({
        id: String(row.id),
        projectId,
        path: String(row.filename),
        content,
        version: String(row.version),
        importedAt: String(row.created_at),
        metadata: {
          title: typeof metadata.title === 'string' ? metadata.title : String(row.filename),
          kind: this.knowledgeKind(String(metadata.kind ?? row.category)),
          evidenceStatus: this.evidenceStatus(String(row.evidence_status)),
          keywords: Array.isArray(metadata.keywords) ? metadata.keywords.map(String) : [],
          scope: [
            ...(Array.isArray(metadata.scope) ? metadata.scope.map(String) : []),
            ...(String(row.category) === 'reference-corpus' ? ['style-analysis-only'] : []),
          ].filter((value, index, all) => all.indexOf(value) === index),
          caveats: Array.isArray(metadata.caveats) ? metadata.caveats.map(String) : [],
        },
      }));
    }
    const evidenceDocuments = documents.filter((document) => !document.metadata.scope.includes('style-analysis-only'));
    if (!evidenceDocuments.length) {
      return { documents: [], selection: EMPTY_SELECTION, warnings };
    }
    const selection = selectKnowledgeContext({
      documents: evidenceDocuments,
      query: '',
      budget: {
        maxInputTokens: EVIDENCE_SECTION_TOKEN_BUDGET,
        systemPromptTokens: 0,
        formulaPromptTokens: 0,
        outputReserveTokens: 0,
        safetyMarginTokens: 0,
      },
    });
    return { documents: evidenceDocuments, selection, warnings };
  }

  /**
   * 知识库完善度预检:每条信息缺口的答案,到生成那一步还站不站得住。
   *
   * 与生成端 engine.ts:892 同判据(答案必须有证据支撑),纯本地计算不调模型。
   * 分档逻辑在 knowledge-preflight.ts,这里只负责取数据、跑证据匹配。
   *
   * 取数不过滤 status:补充判据一向不看 status(见 intelligence-enrich.service.pendingGaps),
   * 而且 stale 的缺口恰恰是最需要提醒用户的。status 原样回给前端自行区分。
   * 但「挣住生成」只由 approved 行决定 —— 见 summarize 的 blocksGeneration,
   * 生成端只消费 approved 行,拿别的行去翻 canGenerate 会造出消不掉的错误结论。
   */
  async preflight(projectId: string): Promise<Record<string, unknown>> {
    const { selection, warnings } = await this.evidenceDocumentSelection(projectId, '完善度预检');
    /*
     * 项目当前全部可用证据 id。判断「声明的引用是否失效」要对着这个全集,
     * 不能对着「支撑某条答案的分节」——两者是不同的问题,混用会把大量仍然存在的
     * 引用误报成失效。
     */
    const availableEvidenceIds = new Set(
      selection.sections
        .filter((section) => section.documentId !== 'generated')
        .map((section) => evidenceIdForSection(section)),
    );
    const rows = this.database
      .prepare(
        `SELECT id, title, status, data_json FROM information_gaps
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY priority DESC, updated_at DESC`,
      )
      .all(projectId) as unknown as Array<Record<string, unknown>>;

    const gaps: PreflightGapResult[] = rows.map((row) => {
      const data = parseJson<Record<string, unknown>>(String(row.data_json), {});
      const answer = typeof data.answer === 'string' ? data.answer : '';
      const framework = typeof data.framework === 'string' ? data.framework : '';
      /*
       * 证据用 findSupportingSectionEvidenceIds 重算,不信 data_json 里声明的 evidenceIds
       * —— 生成端 bindGapEvidence 也是重算的。声明值只用来告诉用户哪些引用已失效。
       */
      const statement = answer.trim() || framework.trim();
      const sectionEvidenceIds = statement
        ? findSupportingSectionEvidenceIds([statement], selection)
        : [];
      return classifyGap({
        id: String(row.id),
        label: typeof data.label === 'string' && data.label ? data.label : String(row.title),
        status: String(row.status),
        required: data.required === true,
        answer,
        framework,
        declaredEvidenceIds: Array.isArray(data.evidenceIds)
          ? data.evidenceIds.filter((item): item is string => typeof item === 'string')
          : [],
        category: typeof data.category === 'string' ? data.category : '',
        sectionEvidenceIds,
        availableEvidenceIds,
        sourceStatus: typeof data.sourceStatus === 'string' && GAP_SOURCE_STATUSES.has(data.sourceStatus)
          ? data.sourceStatus
          : undefined,
      });
    });

    /*
     * 分析状态取自 project_intelligence —— 生成要求的正是一条 approved 行
     * (intelligence.service.prepareGenerationPlan)。取最新一条的状态:
     * 资料变动后 markProjectStale 会把 approved 打成 stale,那时必须重新分析。
     */
    const intelligenceRow = this.database
      .prepare(
        `SELECT status FROM project_intelligence
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END, version DESC
         LIMIT 1`,
      )
      .get(projectId) as { status?: string } | undefined;
    const analysis = analysisStateFrom(intelligenceRow?.status);

    return { ...summarize(gaps, analysis), gaps, warnings, note: PREFLIGHT_NOTE };
  }

  map(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      projectId: row.project_id,
      filename: row.filename,
      mediaType: row.media_type,
      bytes: row.bytes,
      sha256: row.sha256,
      version: row.version,
      category: row.category,
      evidenceStatus: row.evidence_status,
      metadata: parseJson(row.metadata_json, {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateFilename(filename: string): string {
    if (typeof filename !== 'string' || filename.length < 1 || filename.length > 180) {
      throw new BadRequestException('filename 长度必须在 1-180 之间');
    }
    const clean = basename(filename.normalize('NFKC'));
    if (clean !== filename.normalize('NFKC') || clean.startsWith('.')) {
      throw new BadRequestException('filename 不能包含路径或以点开头');
    }
    if (!EXTENSIONS.has(extname(clean).toLowerCase())) {
      throw new BadRequestException('仅支持 .md 和 .txt 文件');
    }
    return clean;
  }

  // Mirrors generation.service.ts: the same kind/evidenceStatus mapping must
  // back both generation-time indexing and this read model.
  private knowledgeKind(value: string): KnowledgeKind {
    const lower = value.toLowerCase();
    if (/禁止|prohibit|forbidden/u.test(lower)) return 'prohibited';
    if (/未知|unknown|不足/u.test(lower)) return 'unknown';
    if (/猜想|hypothesis/u.test(lower)) return 'hypothesis';
    if (/推理|inference/u.test(lower)) return 'inference';
    if (/方法|formula|method|prompt|提示词|evaluation|评分/u.test(lower)) return 'methodology';
    if (/案例|样本|case|sample|reference|corpus|对标/u.test(lower)) return 'case';
    if (/用户|观点|user/u.test(lower)) return 'user_view';
    return 'fact';
  }

  private evidenceStatus(value: string): EvidenceStatus {
    if (/observed|核验|已知事实/u.test(value)) return 'observed';
    if (/inferred|推理|猜想/u.test(value)) return 'inferred';
    if (/unknown|未知|不足/u.test(value)) return 'unknown';
    return 'user_supplied';
  }
}
