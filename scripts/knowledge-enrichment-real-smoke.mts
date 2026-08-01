#!/usr/bin/env node
import '../apps/api/node_modules/reflect-metadata/Reflect.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createApplication } from '../apps/api/src/app.js';
import { DatabaseService } from '../apps/api/src/database.service.js';
import { IntelligenceEnrichService } from '../apps/api/src/intelligence-enrich.service.js';
import { IntelligenceService } from '../apps/api/src/intelligence.service.js';
import { KnowledgeService } from '../apps/api/src/knowledge.service.js';
import type { SessionPrincipal } from '../apps/api/src/models.js';
import { ProjectController } from '../apps/api/src/project.controller.js';

type JsonObject = Record<string, any>;

const root = resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const runDir = resolve(root, '.tmp-test', `knowledge-enrichment-real-smoke-${stamp}`);
const dataDir = join(runDir, 'data');
const databasePath = join(dataDir, 'app.db');
const reportPath = join(runDir, 'report.json');
const markdownPath = join(runDir, 'report.md');
const originalFetch = globalThis.fetch;
const modelCalls: JsonObject[] = [];

const sourceMarkdown = `# 青岚空间整理服务说明

## 服务范围

目前仅服务成都市五城区。基础整理适用于建筑面积不超过 80 平方米的两居室，由 2 名整理师在 1 个工作日内完成；当日服务时长上限为 8 小时。基础整理不包含收纳用品采购、保洁和家具搬运。

## 价格与咨询

基础整理服务费为 6800 元。首次需求诊断为 60 分钟视频咨询，费用 199 元；咨询后 7 日内签约，199 元可抵扣基础整理服务费。建筑面积超过 80 平方米、三居室及以上户型需要人工勘察后报价，文档未提供统一价格。

## 预约与改期

常规服务至少提前 3 个自然日预约。客户可免费改期 1 次，但需在原预约时间前 24 小时提出。节假日是否加价以及最近可预约日期，由客服按当期排期确认。

## 售后边界

服务完成后 7 日内提供 1 次免费线上调整建议。该售后不包含再次上门，也不包含新增收纳用品。我们不承诺整理效果永久保持，实际维持时间与家庭成员使用习惯有关。
`;

function principalFrom(database: DatabaseService): SessionPrincipal {
  const row = database.prepare(
    `SELECT id, username, system_role, user_kind
       FROM users
      WHERE disabled_at IS NULL
      ORDER BY CASE WHEN system_role='admin' THEN 0 ELSE 1 END, created_at
      LIMIT 1`,
  ).get() as JsonObject | undefined;
  if (!row) throw new Error('测试副本中没有可用用户');
  return {
    kind: 'session',
    userId: String(row.id),
    username: String(row.username),
    systemRole: row.system_role === 'admin' ? 'admin' : 'user',
    userKind: row.user_kind === 'saas' ? 'saas' : 'research',
    mustChangePassword: false,
    tokenHash: 'knowledge-real-smoke-token',
    csrfHash: 'knowledge-real-smoke-csrf',
  };
}

function modelOutputText(payload: JsonObject): string {
  const chat = payload.choices?.[0]?.message?.content;
  if (typeof chat === 'string') return chat;
  if (typeof payload.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap((item: JsonObject) => item?.content ?? [])
      .map((item: JsonObject) => item?.text ?? '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

function installModelCallObserver(): void {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url);
    if (!/api\.deepseek\.com$/iu.test(parsedUrl.hostname)) return originalFetch(input as any, init);
    const startedAt = Date.now();
    let requestBody: JsonObject = {};
    try {
      requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    } catch {
      requestBody = {};
    }
    const call: JsonObject = {
      index: modelCalls.length + 1,
      endpoint: `${parsedUrl.origin}${parsedUrl.pathname}`,
      model: requestBody.model,
      transport: requestBody.messages ? 'chat_completions' : 'responses',
      // Do not persist prompts or headers. The synthetic source is present in this report already.
      requestChars: typeof init?.body === 'string' ? init.body.length : 0,
    };
    modelCalls.push(call);
    try {
      const response = await originalFetch(input as any, init);
      call.status = response.status;
      call.elapsedMs = Date.now() - startedAt;
      const raw = await response.clone().text();
      call.responseChars = raw.length;
      try {
        const payload = JSON.parse(raw) as JsonObject;
        const output = modelOutputText(payload);
        call.outputChars = output.length;
        call.finishReason = payload.choices?.[0]?.finish_reason ?? payload.status ?? null;
      } catch {
        call.responseParse = 'non_json';
      }
      return response;
    } catch (error) {
      call.elapsedMs = Date.now() - startedAt;
      call.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
}

function numericTokens(text: string): string[] {
  return [...new Set(text.match(/\d+(?:\.\d+)?/gu) ?? [])];
}

function markdownReport(report: JsonObject): string {
  const model = report.model ?? { provider: 'unknown', model: 'unknown' };
  const analysis = report.analysis ?? { status: 'not_started', error: report.error?.message };
  const enrichment = report.enrichment ?? { drafts: [] };
  const quality = report.quality ?? {};
  const taskEvidence = Array.isArray(report.modelTaskEvidence) ? report.modelTaskEvidence : [];
  const lines = [
    '# 知识库真实模型质量冒烟',
    '',
    `- 运行：${report.runId}`,
    `- 模型：${model.provider} / ${model.model}`,
    `- 模型任务：${taskEvidence.length} 个（${taskEvidence.filter((task: JsonObject) => task.status === 'completed').length} 成功，${taskEvidence.filter((task: JsonObject) => task.status === 'failed').length} 失败）`,
    `- 正式数据库：未修改（使用隔离副本）`,
    '',
    '## 完整分析结果',
    '',
    `状态：${analysis.status}`,
  ];
  if (analysis.error) lines.push('', `错误：${analysis.error}`);
  if (analysis.gaps) {
    lines.push('', '| 缺口 | action | sourceStatus | 原因 |', '|---|---|---|---|');
    for (const gap of analysis.gaps) {
      lines.push(`| ${String(gap.title).replaceAll('|', '\\|')} | ${gap.knowledgeAction} | ${gap.sourceStatus ?? ''} | ${String(gap.knowledgeReason ?? '').replaceAll('|', '\\|')} |`);
    }
  }
  lines.push('', '## 固定探针补全', '');
  for (const draft of enrichment.drafts ?? []) {
    lines.push(`### ${draft.title}`, '', `- action：${draft.knowledgeAction}`, `- confidence：${draft.confidence}`);
    if (draft.knowledgeReason) lines.push(`- reason：${draft.knowledgeReason}`);
    if (draft.sources?.length) lines.push(`- 来源：${draft.sources.map((source: JsonObject) => `${source.filename} / ${source.heading || '全文'}`).join('；')}`);
    lines.push('', draft.aiDraft ? '```markdown' : '_未生成 AI 正文_', draft.aiDraft ?? '', ...(draft.aiDraft ? ['```'] : []), '');
  }
  lines.push(
    '## 自动检查',
    '',
    `- ask_user 未由 AI 编写：${quality.askUserStayedBlank ? '通过' : '失败'}`,
    `- none 未进入补全：${quality.noneExcluded ? '通过' : '失败'}`,
    `- organize_existing 带来源：${quality.organizeHasSources ? '通过' : '失败'}`,
    `- 草稿无未决占位：${quality.noUnresolvedPlaceholders ? '通过' : '失败'}`,
    `- 草稿数字均可在原文找到：${Array.isArray(quality.unsupportedNumericTokens) && quality.unsupportedNumericTokens.length === 0 ? '通过' : `失败（${quality.unsupportedNumericTokens?.join('、') ?? '未执行'}）`}`,
    `- 已有事实不重复追加：${quality.duplicateAppendPrevented ? '通过' : '未触发（草稿含新增事实）'}`,
    '',
    '## 合并预览',
    '',
    report.merge?.preview ? '```markdown' : '_未生成合并预览_',
    report.merge?.preview ?? '',
    ...(report.merge?.preview ? ['```'] : []),
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const source = new DatabaseSync(resolve(root, 'data/app.db'), { readOnly: true });
  try {
    await backup(source, databasePath);
  } finally {
    source.close();
  }

  installModelCallObserver();
  const app = await createApplication({ dataDir, databasePath, logger: false });
  let database: DatabaseService | undefined;
  let projectId = '';
  const report: JsonObject = {
    runId: basename(runDir),
    runDir,
    startedAt: new Date().toISOString(),
    isolation: { sourceDatabaseModified: false, databasePath },
    sourceMarkdown,
    modelCalls,
  };

  try {
    database = app.get(DatabaseService);
    const intelligence = app.get(IntelligenceService);
    const enrich = app.get(IntelligenceEnrichService);
    const knowledge = app.get(KnowledgeService);
    const projects = app.get(ProjectController);
    const principal = principalFrom(database);
    const configured = database.prepare(
      `SELECT ws.workspace_id, ws.provider_mode, ws.provider, ws.model, ws.base_url, ws.transport
         FROM workspace_settings ws
        JOIN workspaces w ON w.id=ws.workspace_id
        WHERE w.deleted_at IS NULL AND ws.provider_mode='byok' AND ws.encrypted_api_key IS NOT NULL
        ORDER BY ws.updated_at DESC LIMIT 1`,
    ).get() as JsonObject | undefined;
    if (!configured) throw new Error('正式数据库副本中没有可用的 BYOK 模型配置');
    report.model = {
      providerMode: configured.provider_mode,
      provider: configured.provider,
      model: configured.model,
      baseUrl: configured.base_url,
      transport: configured.transport,
    };

    const project = projects.create(
      { principal } as never,
      {
        workspaceId: configured.workspace_id,
        name: `知识补全真实模型冒烟 ${stamp}`,
        description: '隔离副本中的合成知识库质量测试',
        domain: '家庭空间整理服务',
      },
    ) as JsonObject;
    report.project = { id: project.id, name: project.name };
    projectId = String(project.id);
    const uploaded = await knowledge.import({
      projectId: String(project.id),
      filename: 'INDEX.md',
      content: sourceMarkdown,
      category: '项目事实',
      evidenceStatus: '已知事实',
      metadata: { title: '青岚空间整理服务说明', kind: 'fact', source: 'synthetic-real-model-smoke' },
      principal,
    });
    report.upload = { id: uploaded.id, filename: uploaded.filename, version: uploaded.version };

    const analysisStarted = Date.now();
    if (process.env.KNOWLEDGE_SMOKE_SKIP_ANALYSIS === 'true') {
      report.analysis = { status: 'skipped', reason: 'Fixed enrichment probes only.' };
    } else {
      try {
        const result = await intelligence.analyzeProject(String(project.id), principal, true) as JsonObject;
        const gaps = (result.informationGaps ?? []).map((gap: JsonObject) => ({
          id: gap.id,
          title: gap.title,
          question: gap.question,
          answer: gap.answer,
          sourceStatus: gap.sourceStatus,
          knowledgeAction: gap.knowledgeAction,
          knowledgeReason: gap.knowledgeReason,
          evidenceIds: gap.evidenceIds,
        }));
        report.analysis = {
          status: 'completed',
          elapsedMs: Date.now() - analysisStarted,
          gapCount: gaps.length,
          actionCounts: Object.fromEntries(['organize_existing', 'ask_user', 'none'].map((action) => [
            action,
            gaps.filter((gap: JsonObject) => gap.knowledgeAction === action).length,
          ])),
          gaps,
        };
      } catch (error) {
        report.analysis = {
          status: 'failed',
          elapsedMs: Date.now() - analysisStarted,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const organizeProbe = intelligence.createGap(String(project.id), {
      title: '整理咨询费、抵扣条件与基础服务范围',
      question: '请把咨询费、抵扣条件、基础整理价格和明确不包含的服务整理成可直接加入知识库的事实说明。',
      sourceStatus: 'unknown',
      knowledgeAction: 'organize_existing',
      knowledgeReason: '这些事实已经存在于原始资料，但分散在价格和服务范围两个章节。',
      priority: 100,
    }, principal) as JsonObject;
    const askProbe = intelligence.createGap(String(project.id), {
      title: '120 平方米三居室最终报价',
      question: '120 平方米三居室的最终服务报价是多少？',
      sourceStatus: 'unknown',
      knowledgeAction: 'ask_user',
      knowledgeReason: '现有资料明确要求人工勘察后报价，没有统一价格。',
      priority: 90,
    }, principal) as JsonObject;
    const noneProbe = intelligence.createGap(String(project.id), {
      title: '首次了解整理服务的读者常见问题',
      question: '第一次了解空间整理服务的读者通常会关注哪些问题？',
      sourceStatus: 'unknown',
      knowledgeAction: 'none',
      knowledgeReason: '这是内容规划问题，不是需要补入项目知识库的新事实。',
      priority: 80,
    }, principal) as JsonObject;

    const draftStarted = Date.now();
    const draftResult = await enrich.generateEnrichmentDraft(
      String(project.id),
      principal,
      [String(organizeProbe.id), String(askProbe.id)],
    );
    report.enrichment = {
      elapsedMs: Date.now() - draftStarted,
      probes: { organize: organizeProbe.id, askUser: askProbe.id, none: noneProbe.id },
      drafts: draftResult.gaps,
      totalPending: draftResult.totalPending,
      unreadableFiles: draftResult.unreadableFiles,
    };

    const organizeDrafts = draftResult.gaps.filter((draft) => draft.knowledgeAction === 'organize_existing');
    const askDraft = draftResult.gaps.find((draft) => draft.gapId === askProbe.id);
    const combinedDraft = organizeDrafts.map((draft) => draft.aiDraft).join('\n\n');
    const sourceNumbers = new Set(numericTokens(sourceMarkdown));
    const unsupportedNumericTokens = numericTokens(combinedDraft).filter((token) => !sourceNumbers.has(token));
    report.quality = {
      askUserStayedBlank: askDraft?.knowledgeAction === 'ask_user' && askDraft.aiDraft === '',
      noneExcluded: !draftResult.gaps.some((draft) => draft.gapId === noneProbe.id),
      organizeHasSources: organizeDrafts.length > 0 && organizeDrafts.every((draft) => draft.sources.length > 0),
      noUnresolvedPlaceholders: !/(?:待确认|资料未提及|尚未提供|信息缺失|不清楚|不知道|目前未知|暂不确定)/u.test(combinedDraft),
      sourceNumericTokens: [...sourceNumbers],
      draftNumericTokens: numericTokens(combinedDraft),
      unsupportedNumericTokens,
    };

    if (organizeDrafts.length > 0) {
      try {
        report.merge = await enrich.mergeEnrichedKnowledge(
          String(project.id),
          organizeDrafts.map((draft) => ({ gapId: draft.gapId, status: 'confirmed' as const, content: draft.aiDraft })),
          'INDEX.md',
          principal,
        );
        report.merge.note = '草稿含目标文件中没有的新事实，因此生成了预览；未写回正式数据库。';
        quality.duplicateAppendPrevented = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/已存在于目标文件|无需重复保存/u.test(message)) throw error;
        report.merge = { status: 'duplicate_prevented', message };
        quality.duplicateAppendPrevented = true;
      }
    }
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.failedAt = new Date().toISOString();
    report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    if (database && projectId) {
      report.modelTaskEvidence = database.prepare(
        `SELECT source_fingerprint AS sourceFingerprint, status, attempt_count AS attemptCount,
                created_at AS createdAt, completed_at AS completedAt, error
           FROM analysis_tasks
          WHERE project_id=? AND deleted_at IS NULL
          ORDER BY created_at`,
      ).all(projectId);
    }
    await app.close();
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(markdownPath, markdownReport(report), 'utf8');
    console.log(JSON.stringify({ runDir, reportPath, markdownPath, modelCalls }, null, 2));
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
