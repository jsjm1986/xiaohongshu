#!/usr/bin/env node
import '../apps/api/node_modules/reflect-metadata/Reflect.js';
import { backup, DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createApplication } from '../apps/api/src/app.js';
import { DatabaseService } from '../apps/api/src/database.service.js';
import { GenerationService } from '../apps/api/src/generation.service.js';
import { IntelligenceService } from '../apps/api/src/intelligence.service.js';
import type { SessionPrincipal } from '../apps/api/src/models.js';

type JsonObject = Record<string, any>;

const root = resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const runDir = resolve(root, '.tmp-test', `full-generation-smoke-${stamp}`);
const cloneDataDir = join(runDir, 'data');
const sourceDataDir = resolve(root, 'data');
const persistToDevelopmentDatabase = process.env.SMOKE_PERSIST_DEVELOPMENT_DATA === 'true';
const activeDataDir = persistToDevelopmentDatabase ? sourceDataDir : cloneDataDir;
const capture: JsonObject[] = [];
const originalFetch = globalThis.fetch;

function requestText(body: JsonObject): string {
  const content = body.messages?.[0]?.content ?? body.input?.[0]?.content ?? '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => item?.text ?? item?.input_text ?? '').filter(Boolean).join('\n');
}

function operationOf(text: string): string {
  const analysisStage = text.match(/PROJECT_ANALYSIS_STAGE:\s*(\d\/3)/u)?.[1];
  if (analysisStage) return `project-analysis-${analysisStage}`;
  if (text.includes('repair') || text.includes('修复')) return 'generation-or-repair';
  return 'content-generation';
}

function coalesceChatCompletionSse(raw: string): JsonObject {
  let id = '';
  let model = '';
  let content = '';
  let finishReason: string | null = null;
  let usage: JsonObject | undefined;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    let chunk: JsonObject;
    try { chunk = JSON.parse(value); } catch { continue; }
    id ||= String(chunk.id ?? '');
    model ||= String(chunk.model ?? '');
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (choice?.usage && typeof choice.usage === 'object') usage = choice.usage;
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
  }
  return {
    id,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function cloneProductionData(): Promise<void> {
  await mkdir(cloneDataDir, { recursive: true });
  const source = new DatabaseSync(join(sourceDataDir, 'app.db'), { readOnly: true });
  try { await backup(source, join(cloneDataDir, 'app.db')); } finally { source.close(); }
  for (const directory of ['knowledge', 'images']) {
    await cp(join(sourceDataDir, directory), join(cloneDataDir, directory), { recursive: true, force: true });
  }
}

/**
 * Offline smoke must not inherit BYOK credentials from the cloned production
 * database. Clearing only APP_OPTIONS.platformApiKey is insufficient because
 * SettingsService resolves workspace BYOK first. Mutate the disposable clone
 * before Nest starts, then additionally fail any unexpected fetch below.
 */
function disableClonedModelCredentials(): void {
  if (persistToDevelopmentDatabase) {
    throw new Error('SMOKE_DISABLE_MODEL cannot be combined with SMOKE_PERSIST_DEVELOPMENT_DATA.');
  }
  const clone = new DatabaseSync(join(cloneDataDir, 'app.db'));
  try {
    clone.prepare(`UPDATE workspace_settings
      SET provider_mode='platform', encrypted_api_key=NULL, updated_at=?`).run(new Date().toISOString());
  } finally {
    clone.close();
  }
}

function principalFrom(database: DatabaseService): SessionPrincipal {
  const user = database.prepare("SELECT id,username,system_role,user_kind,must_change_password FROM users WHERE disabled_at IS NULL ORDER BY created_at LIMIT 1").get() as JsonObject;
  return {
    kind: 'session',
    userId: String(user.id),
    username: String(user.username),
    systemRole: user.system_role === 'admin' ? 'admin' : 'user',
    userKind: user.user_kind === 'saas' ? 'saas' : 'research',
    mustChangePassword: Boolean(user.must_change_password),
    tokenHash: 'isolated-smoke-token',
    csrfHash: 'isolated-smoke-csrf',
  };
}

function allNumbersKnown(value: JsonObject, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

async function waitForJob(
  generation: GenerationService,
  id: string,
  timeoutMs = Number.parseInt(process.env.SMOKE_JOB_TIMEOUT_MS ?? String(12 * 60_000), 10),
): Promise<JsonObject> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60_000) {
    throw new Error('SMOKE_JOB_TIMEOUT_MS must be a finite integer of at least 60000.');
  }
  const started = Date.now();
  let job = generation.get(id);
  while (!['completed', 'failed'].includes(String(job.status))) {
    if (Date.now() - started > timeoutMs) throw new Error(`Generation ${id} timed out after ${timeoutMs}ms`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    job = generation.get(id);
  }
  return job;
}

function existingApprovedPlanning(
  intelligence: IntelligenceService,
  projectId: string,
): { opportunity?: JsonObject; rejected: Array<{ id: string; title?: string; reason: string }> } {
  const rejected: Array<{ id: string; title?: string; reason: string }> = [];
  const approved = intelligence.listOpportunities(projectId)
    .filter((opportunity) => opportunity.status === 'approved');
  for (const opportunity of approved) {
    try {
      // Reuse only a resource that passes the same production preparation gate as
      // generation. This validates current gap, blueprint and strategy revisions;
      // no approval or dependency state is mutated by the smoke harness.
      intelligence.prepareGeneration(projectId, { opportunityId: opportunity.id });
      return { opportunity, rejected };
    } catch (error) {
      rejected.push({
        id: String(opportunity.id),
        title: typeof opportunity.title === 'string' ? opportunity.title : undefined,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rejected };
}

async function approvePlanningResources(
  intelligence: IntelligenceService,
  projectId: string,
  analysis: JsonObject,
  principal: SessionPrincipal,
): Promise<JsonObject> {
  const approval: JsonObject = { intelligence: false, blueprintModules: [], gaps: [], rejectedGaps: [], strategies: [], opportunities: [] };
  const blueprintModules = analysis.blueprintModules ?? [];
  if (blueprintModules.length !== 7) {
    throw new Error(`Project analysis returned ${blueprintModules.length} blueprint modules; seven are required.`);
  }
  for (const module of blueprintModules) {
    const approved = await intelligence.approveBlueprintModule(projectId, module.id, { status: 'approved' }, principal);
    approval.blueprintModules.push({ id: approved.id, moduleKey: approved.moduleKey, version: approved.version });
  }
  if (analysis.intelligence?.id) {
    intelligence.approveIntelligence(projectId, analysis.intelligence.id, { status: 'approved' }, principal);
    approval.intelligence = true;
  }
  for (const gap of analysis.informationGaps ?? []) {
    try {
      intelligence.approveGap(projectId, gap.id, { status: 'approved' }, principal);
      approval.gaps.push(gap.id);
    } catch (error) {
      approval.rejectedGaps.push({ id: gap.id, title: gap.title, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const strategy of analysis.expressionStrategies ?? []) {
    intelligence.approveStrategy(projectId, strategy.id, { status: 'approved' }, principal);
    approval.strategies.push(strategy.id);
  }

  const gapSet = new Set<string>(approval.gaps);
  const opportunityMetrics = ['relevance', 'importance', 'proofability', 'novelty', 'decisionLeverage', 'cognitiveCost', 'risk'];
  const ranked = [...(analysis.topicOpportunities ?? [])].sort((left: JsonObject, right: JsonObject) =>
    Number(right.proofability ?? -1) - Number(left.proofability ?? -1)
      || Number(right.decisionLeverage ?? -1) - Number(left.decisionLeverage ?? -1),
  );
  for (let opportunity of ranked) {
    if (!allNumbersKnown(opportunity, opportunityMetrics) || !(opportunity.gapIds ?? []).every((id: string) => gapSet.has(id))) continue;
    if (opportunity.status !== 'eligible') {
      opportunity = intelligence.updateOpportunity(projectId, opportunity.id, {
        status: 'eligible',
        relevance: opportunity.relevance,
        importance: opportunity.importance,
        proofability: opportunity.proofability,
        novelty: opportunity.novelty,
        decisionLeverage: opportunity.decisionLeverage,
        cognitiveCost: opportunity.cognitiveCost,
        risk: opportunity.risk,
      }, principal);
    }
    try {
      const selected = intelligence.approveOpportunity(projectId, opportunity.id, { status: 'approved' }, principal);
      approval.opportunities.push(selected.id);
      approval.selectedOpportunity = selected;
      break;
    } catch (error) {
      approval.opportunityFailures ??= [];
      approval.opportunityFailures.push({ id: opportunity.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!approval.selectedOpportunity) throw new Error('No model-derived opportunity passed evidence, metric and dependency approval gates.');
  return approval;
}

async function main(): Promise<void> {
  await mkdir(runDir, { recursive: true });
  if (!persistToDevelopmentDatabase) await cloneProductionData();
  const modelDisabled = process.env.SMOKE_DISABLE_MODEL === 'true';
  if (modelDisabled) disableClonedModelCredentials();
  globalThis.fetch = async (input, init) => {
    if (modelDisabled) {
      throw new Error('Offline smoke blocked an unexpected outbound model request.');
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let body: JsonObject = {};
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}; } catch { /* leave empty */ }
    const prompt = requestText(body);
    const record: JsonObject = {
      index: capture.length + 1,
      at: new Date().toISOString(),
      url: new URL(url).origin + new URL(url).pathname,
      model: body.model,
      operation: operationOf(prompt),
      promptChars: prompt.length,
      request: body,
    };
    capture.push(record);
    try {
      const response = await originalFetch(input as any, init);
      record.status = response.status;
      const rawResponse = await response.clone().text();
      record.responseChars = rawResponse.length;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const payload = coalesceChatCompletionSse(rawResponse);
        record.testHarnessCoalescedSse = true;
        record.coalescedOutputChars = payload.choices?.[0]?.message?.content?.length ?? 0;
        record.coalescedFinishReason = payload.choices?.[0]?.finish_reason ?? null;
        record.coalescedOutputHead = String(payload.choices?.[0]?.message?.content ?? '').slice(0, 500);
        record.coalescedOutputTail = String(payload.choices?.[0]?.message?.content ?? '').slice(-1_000);
        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json');
        return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
      }
      try {
        const payload = JSON.parse(rawResponse) as JsonObject;
        const output = String(payload.choices?.[0]?.message?.content ?? payload.output_text ?? '');
        record.outputChars = output.length;
        record.finishReason = payload.choices?.[0]?.finish_reason ?? payload.status ?? null;
        record.outputHead = output.slice(0, 500);
        record.outputTail = output.slice(-1_000);
      } catch { /* response diagnostics stay limited to status and size */ }
      return response;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const app = await createApplication({
    dataDir: activeDataDir,
    databasePath: join(activeDataDir, 'app.db'),
    ...(process.env.SMOKE_DISABLE_MODEL === 'true'
      ? { platformApiKey: '' }
      : process.env.SMOKE_PLATFORM_API_KEY
        ? { platformApiKey: process.env.SMOKE_PLATFORM_API_KEY }
        : {}),
    logger: false,
  });
  const database = app.get(DatabaseService);
  const intelligence = app.get(IntelligenceService);
  const generation = app.get(GenerationService);
  const principal = principalFrom(database);
  const requestedProjectId = process.env.SMOKE_PROJECT_ID?.trim();
  const requestedProjectName = process.env.SMOKE_PROJECT_NAME?.trim();
  if (requestedProjectId && requestedProjectName) {
    throw new Error('Set only one of SMOKE_PROJECT_ID or SMOKE_PROJECT_NAME.');
  }
  const projects = database.prepare(
    `SELECT id,name,workspace_id FROM projects
     WHERE deleted_at IS NULL
       AND (? IS NULL OR id = ?)
       AND (? IS NULL OR name = ?)
     ORDER BY created_at`,
  ).all(
    requestedProjectId || null,
    requestedProjectId || null,
    requestedProjectName || null,
    requestedProjectName || null,
  ) as JsonObject[];
  if (projects.length === 0) {
    throw new Error(`Smoke project not found: ${requestedProjectId ?? requestedProjectName ?? '(first active project)'}`);
  }
  if ((requestedProjectId || requestedProjectName) && projects.length !== 1) {
    throw new Error(`Smoke project selector matched ${projects.length} projects; use SMOKE_PROJECT_ID.`);
  }
  const project = projects[0]!;
  const providerOverride = process.env.SMOKE_PROVIDER
    ?? (process.env.SMOKE_PROVIDER_COMPATIBLE === 'true' ? 'openai-compatible' : undefined);
  const modelOverride = process.env.SMOKE_MODEL;
  const baseUrlOverride = process.env.SMOKE_BASE_URL?.replace(/\/+$/u, '');
  if (providerOverride || modelOverride || baseUrlOverride) {
    database.prepare(`UPDATE workspace_settings SET
      provider=COALESCE(?,provider),
      model=COALESCE(?,model),
      base_url=COALESCE(?,base_url),
      updated_at=?
      WHERE workspace_id=?`)
      .run(providerOverride ?? null, modelOverride ?? null, baseUrlOverride ?? null, new Date().toISOString(), project.workspace_id);
  }
  const report: JsonObject = {
    runId: basename(runDir),
    startedAt: new Date().toISOString(),
    storage: persistToDevelopmentDatabase
      ? { mode: 'development_database', databaseModified: true, dataDir: activeDataDir }
      : { mode: 'isolated_clone', databaseModified: false, cloneDataDir },
    project: { id: project.id, name: project.name },
    model: database.prepare("SELECT provider_mode,provider,model,base_url,transport FROM workspace_settings WHERE workspace_id=?").get(project.workspace_id),
  };

  try {
    const analysisStarted = Date.now();
    let analysis: JsonObject = { informationGaps: [], expressionStrategies: [], topicOpportunities: [] };
    const reusable = existingApprovedPlanning(intelligence, project.id);
    let approvals: JsonObject;
    let opportunity: JsonObject;
    if (reusable.opportunity) {
      opportunity = reusable.opportunity;
      approvals = {
        reusedApprovedPlanning: true,
        selectedOpportunity: opportunity,
        rejectedApprovedOpportunities: reusable.rejected,
      };
      report.analysis = {
        status: 'reused_approved_planning',
        elapsedMs: Date.now() - analysisStarted,
        note: 'An existing approved opportunity passed the production prepareGeneration dependency gate; no analysis or approval resource was mutated.',
      };
    } else {
      if (process.env.SMOKE_SKIP_PROJECT_ANALYSIS === 'true') {
        throw new Error(`No existing approved opportunity passed generation preparation: ${JSON.stringify(reusable.rejected)}`);
      }
      try {
        analysis = await intelligence.analyzeProject(project.id, principal, true);
        report.analysis = {
          status: 'completed', elapsedMs: Date.now() - analysisStarted,
          task: analysis.task, intelligence: analysis.intelligence,
          counts: {
            blueprintModules: analysis.blueprintModules?.length ?? 0,
            gaps: analysis.informationGaps?.length ?? 0,
            strategies: analysis.expressionStrategies?.length ?? 0,
            opportunities: analysis.topicOpportunities?.length ?? 0,
          },
          resources: {
            blueprintModules: analysis.blueprintModules,
            informationGaps: analysis.informationGaps,
            expressionStrategies: analysis.expressionStrategies,
            topicOpportunities: analysis.topicOpportunities,
          },
          rejectedApprovedOpportunities: reusable.rejected,
        };
      } catch (error) {
        report.analysis = {
          status: 'failed', elapsedMs: Date.now() - analysisStarted,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      approvals = await approvePlanningResources(intelligence, project.id, analysis, principal);
      opportunity = approvals.selectedOpportunity as JsonObject;
    }
    const requestedOpportunityIds = (process.env.SMOKE_OPPORTUNITY_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const selectedOpportunities: JsonObject[] = [];
    if (requestedOpportunityIds.length) {
      if (new Set(requestedOpportunityIds).size !== requestedOpportunityIds.length) {
        throw new Error('SMOKE_OPPORTUNITY_IDS must contain distinct IDs.');
      }
      for (const opportunityId of requestedOpportunityIds) {
        const current = intelligence.listOpportunities(project.id)
          .find((item) => item.id === opportunityId) as JsonObject | undefined;
        if (!current) throw new Error(`Smoke opportunity not found: ${opportunityId}`);
        const selected = current.status === 'approved'
          ? current
          : await Promise.resolve(intelligence.approveOpportunity(
            project.id,
            opportunityId,
            { status: 'approved' },
            principal,
          )) as JsonObject;
        intelligence.prepareGeneration(project.id, { opportunityId });
        selectedOpportunities.push(selected);
      }
      approvals = {
        ...approvals,
        smokeRequestedOpportunityIds: requestedOpportunityIds,
        smokeSelectedOpportunities: selectedOpportunities,
        note: 'Non-approved requested opportunities were approved only inside the isolated smoke database clone.',
      };
      opportunity = selectedOpportunities[0]!;
    } else {
      selectedOpportunities.push(opportunity);
    }
    report.approvals = approvals;
    const domainModule = analysis.blueprintModules?.find((module: JsonObject) => module.moduleKey === 'domain_model');
    const projectNoun = String(domainModule?.data?.projectNoun ?? project.name);
    const decisionTasks = Array.isArray(domainModule?.data?.decisionTasks)
      ? domainModule.data.decisionTasks.filter((item: unknown): item is string => typeof item === 'string').slice(0, 3)
      : [];

    const scenarioFilter = process.env.SMOKE_SCENARIO;
    const defaultScenarios = [
      {
        name: 'simple-first-research',
        input: {
          projectId: project.id, mode: 'simple', opportunityId: opportunity.id,
          topic: opportunity.topic ?? opportunity.title,
          goal: `让第一次了解${projectNoun}的人知道先判断什么、向谁核实、哪些信息不能直接下结论。`,
          audienceStage: 'collecting', entryPoint: 'search', presetId: 'first_research',
          mustInclude: decisionTasks.join('、'),
          forbidden: '伪造亲历、伪造口碑、无证据的绝对承诺', seed: 2026071401,
        },
      },
      {
        name: 'advanced-minimal-body-rich-comments',
        input: {
          projectId: project.id, mode: 'advanced',
          topic: opportunity.topic ?? opportunity.title,
          goal: '正文只保留共同主线，评论区用不同角色的条件问题补齐决策信息。',
          audienceStage: 'comparing', entryPoint: 'search', presetId: 'minimal_body_conditional_comments',
          mustInclude: decisionTasks.join('、'),
          forbidden: '虚构亲历、虚构消费者口碑、绝对化承诺、未经知识库支持的数字',
          parameterValues: {
            body_completeness: 40, comment_expansion: 95, comment_role_diversity: 95,
            comment_constraint_density: 90, comment_reply_increment: 95,
            comment_gap_multiplexing: 65, question_compression: 85,
            comment_discovery_strength: 85, comment_inference_effort: 35,
            comment_self_verification: 90, comment_false_closure_guard: 100,
            evidence_strictness: 100, boundary_visibility: 100,
            body_min_chars: 100, body_max_chars: 180,
            comment_thread_min: 5, comment_thread_max: 7, follow_up_depth: 3,
            repair_attempts: Number.parseInt(process.env.SMOKE_REPAIR_ATTEMPTS ?? '2', 10),
          },
          seed: 2026071402,
        },
      },
    ];
    const angleScenarios = requestedOpportunityIds.length
      ? selectedOpportunities.map((selectedOpportunity, index) => ({
        name: `real-angle-${index + 1}`,
        input: {
          projectId: project.id,
          mode: 'simple',
          opportunityId: selectedOpportunity.id,
          topic: selectedOpportunity.topic ?? selectedOpportunity.title,
          goal: `围绕“${selectedOpportunity.title ?? selectedOpportunity.topic}”生成一套可直接审阅的完整图文与评论参考。`,
          audienceStage: selectedOpportunity.audienceStage ?? 'collecting',
          entryPoint: selectedOpportunity.entry ?? 'search',
          presetId: 'first_research',
          mustInclude: decisionTasks.join('、'),
          forbidden: '伪造亲历、伪造口碑、无证据的绝对承诺',
          seed: 2026080501 + index,
        },
      }))
      : defaultScenarios;
    const scenarios = angleScenarios.filter((scenario) => !scenarioFilter || scenario.name === scenarioFilter);

    if (scenarios.length === 0) {
      throw new Error(`Unknown SMOKE_SCENARIO: ${scenarioFilter}`);
    }

    report.generations = [];
    for (const scenario of scenarios) {
      const started = Date.now();
      const created = await generation.create(scenario.input as JsonObject, principal);
      const completed = await waitForJob(generation, String(created.id));
      report.generations.push({ name: scenario.name, elapsedMs: Date.now() - started, input: scenario.input, job: completed });
    }
    const generatedJobIds = report.generations
      .map((item: JsonObject) => item?.job?.id)
      .filter((id: unknown): id is string => typeof id === 'string');
    const generatedJobPlaceholders = generatedJobIds.map(() => '?').join(',');
    report.databaseEvidence = {
      // Scope every mutable count and event to this smoke run. The cloned
      // production database contains historical packages/events, which are
      // useful planning inputs but must not be reported as this run's output.
      generationEvents: generatedJobIds.length
        ? database.prepare(`SELECT job_id,event,details_json,created_at FROM generation_events
            WHERE job_id IN (${generatedJobPlaceholders}) ORDER BY id`).all(...generatedJobIds)
        : [],
      packageCount: generatedJobIds.length
        ? database.prepare(`SELECT COUNT(*) value FROM content_packages
            WHERE job_id IN (${generatedJobPlaceholders})`).get(...generatedJobIds)
        : { value: 0 },
      coverageCount: generatedJobIds.length
        ? database.prepare(`SELECT COUNT(*) value FROM coverage_records
            WHERE generation_job_id IN (${generatedJobPlaceholders}) AND deleted_at IS NULL`).get(...generatedJobIds)
        : { value: 0 },
      knowledge: database.prepare("SELECT id,filename,bytes,sha256,category,evidence_status FROM knowledge_files WHERE project_id=? AND deleted_at IS NULL").all(project.id),
      activeFormula: database.prepare("SELECT id,version,status FROM formula_versions WHERE project_id=? AND status='active'").get(project.id),
      activeRelease: database.prepare("SELECT id,version,status FROM release_manifests WHERE project_id=? AND status='active'").get(project.id),
    };
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.failedAt = new Date().toISOString();
    report.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    const generatedJobIds = Array.isArray(report.generations)
      ? report.generations.map((item: JsonObject) => item?.job?.id).filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const modelUsageEvents = generatedJobIds.length
      ? database.prepare(
        `SELECT job_id,details_json,created_at FROM generation_events
         WHERE event='model_usage' AND job_id IN (${generatedJobIds.map(() => '?').join(',')})
         ORDER BY id`,
      ).all(...generatedJobIds).map((row: JsonObject) => {
        let details: JsonObject = {};
        try { details = JSON.parse(String(row.details_json ?? '{}')); } catch { /* keep empty */ }
        return {
          jobId: row.job_id,
          createdAt: row.created_at,
          purpose: details.purpose,
          candidateIndex: details.candidateIndex,
          outcome: details.outcome,
          elapsedMs: details.elapsedMs,
          inputTokens: details.inputTokens,
          outputTokens: details.outputTokens,
          status: details.status,
          failureKind: details.failureKind,
          responseDiagnostics: details.responseDiagnostics,
        };
      })
      : [];
    // Some BYOK transports use a pinned dispatcher and do not pass through the
    // global fetch hook. Database model_usage events are the authoritative call
    // audit; captured transport payloads remain available only for harness debug.
    report.modelCalls = modelUsageEvents;
    report.capturedTransportCalls = capture;
    await writeFile(join(runDir, 'smoke-result.json'), JSON.stringify(report, null, 2), 'utf8');
    await writeFile(join(runDir, 'captured-prompts.json'), JSON.stringify(capture, null, 2), 'utf8');
    await app.close();
    globalThis.fetch = originalFetch;
    console.log(JSON.stringify({
      runDir,
      report: join(runDir, 'smoke-result.json'),
      calls: modelUsageEvents.map(({ purpose, candidateIndex, outcome, elapsedMs }) => ({ purpose, candidateIndex, outcome, elapsedMs })),
    }, null, 2));
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
