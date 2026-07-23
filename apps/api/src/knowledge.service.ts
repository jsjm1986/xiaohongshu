import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  evidenceIdForSection,
  indexKnowledgeSource,
  selectKnowledgeContext,
  type EvidenceStatus,
  type KnowledgeDocument,
  type KnowledgeKind,
  type KnowledgeSection,
} from '@content-agent/agent-core';
import { AuditService } from './audit.service.js';
import { DatabaseService } from './database.service.js';
import { IntelligenceService } from './intelligence.service.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { nowIso, parseJson } from './utils.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = new Set(['.md', '.txt']);
// Generous budget so selectKnowledgeContext always takes its "full" mode, whose
// sections are exactly the per-document canonical splits (never truncated), i.e.
// the same section identity generation-time evidence binding uses.
const EVIDENCE_SECTION_TOKEN_BUDGET = 100_000_000;

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
    const content = await readFile(this.absoluteStoragePath(String(row.storage_path)), 'utf8');
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
    const project = this.resources.projectRow(input.projectId);
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
    await writeFile(temporary, buffer, { flag: 'wx' });
    await rename(temporary, target);

    const versionRow = this.database
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS version FROM knowledge_files
         WHERE project_id = ? AND filename = ?`,
      )
      .get(input.projectId, cleanFilename) as { version: number };
    const version = Number(versionRow.version) + 1;
    const now = nowIso();
    const storagePath = relative(this.database.options.dataDir, target).replaceAll('\\', '/');
    try {
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
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
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
  }

  async remove(fileId: string, principal: SessionPrincipal): Promise<void> {
    const row = this.row(fileId);
    const project = this.resources.projectRow(String(row.project_id));
    this.database
      .prepare('UPDATE knowledge_files SET deleted_at = ?, updated_at = ? WHERE id = ?')
      .run(nowIso(), nowIso(), fileId);
    await unlink(this.absoluteStoragePath(String(row.storage_path))).catch(() => undefined);
    this.audit.record({
      workspaceId: String(project.workspace_id),
      userId: principal.userId,
      action: 'knowledge.delete',
      entityType: 'knowledge-file',
      entityId: fileId,
    });
    this.intelligence.markProjectStale(String(row.project_id));
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
    for (const row of rows) {
      if (Number(row.bytes) > MAX_FILE_BYTES) {
        warnings.push(`知识文件 ${String(row.filename)} 超过 2 MiB，已跳过分节索引`);
        continue;
      }
      let content: string;
      try {
        content = await readFile(this.absoluteStoragePath(String(row.storage_path)), 'utf8');
      } catch {
        warnings.push(`知识文件 ${String(row.filename)} 磁盘读取失败，已跳过分节索引`);
        continue;
      }
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
    if (!evidenceDocuments.length) return { documents: [], warnings };
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
    const sectionsByDocument = new Map<string, KnowledgeSection[]>();
    for (const section of selection.sections) {
      if (section.documentId === 'generated') continue;
      const list = sectionsByDocument.get(section.documentId) ?? [];
      list.push(section);
      sectionsByDocument.set(section.documentId, list);
    }
    return {
      documents: [...evidenceDocuments]
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

  private absoluteStoragePath(storagePath: string): string {
    const target = resolve(this.database.options.dataDir, storagePath);
    const root = resolve(this.database.options.dataDir);
    if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
      throw new BadRequestException('无效的存储路径');
    }
    return target;
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
