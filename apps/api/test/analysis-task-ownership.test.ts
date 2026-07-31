import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';
import { SettingsService } from '../src/settings.service.js';

/**
 * 分析任务的实例归属。
 *
 * 分析任务是同步 inline 执行，没有队列可回。启动清理只能回收心跳已停的任务；
 * 执行中的每次调用和最终结算也必须持续验证归属，否则旧实例会覆盖新持有者状态，
 * 或在任务已易主后留下无法对应任何成功任务的分析产物。
 */

const PASSWORD = 'Ownership-bootstrap-123!';
const INSTANCE_ID = 'ownership-instance';
const OTHER_INSTANCE_ID = 'other-instance';
const CLAIM_TIMEOUT_MS = 90_000;
const TAKEOVER_MARKER =
  'new-owner-state: ownership-instance claimed_by heartbeat_at analysis_tasks SQL UPDATE secret-detail';

const BLUEPRINT_MODULE_KEYS = [
  'knowledge_map',
  'domain_model',
  'audience_model',
  'scenario_model',
  'role_model',
  'claim_policy',
  'surface_language',
] as const;

interface TaskState {
  id: string;
  status: string;
  error: string | null;
  result_id: string | null;
  claimed_by: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  quota_consumed_count: number;
}

interface MockReply {
  status: number;
  body: unknown;
}

type ModelResponder = (input: { rawBody: string; stage: string }) => Promise<MockReply> | MockReply;

let app: NestExpressApplication;
let modelServer: Server;
let dataDir = '';
let projectId = '';
let imageAssetId = '';
let principal: SessionPrincipal;
let modelCalls: Array<{ rawBody: string; stage: string }> = [];
let modelResponder: ModelResponder = () => modelSuccess({ ok: true });
let auditTriggerSequence = 0;

function stage1BlueprintPayload(): Record<string, unknown> {
  return {
    blueprintModules: {
      knowledge_map: { entries: [] },
      domain_model: {
        projectNoun: '项目', industry: '测试行业', domain: '测试领域',
        objects: ['项目'], actions: ['比较'], concepts: ['边界'], decisionTasks: ['核验'], vocabulary: ['边界'],
      },
      audience_model: {
        states: [{ id: 'collector', label: '信息收集者', stages: ['collecting'], goals: ['补全依据'], hesitationReasons: [] }],
      },
      scenario_model: { families: [{ id: 'compare', label: '比较', prototype: 'option_comparison' }] },
      role_model: { hostVoiceTraits: [], hostSpeechMarkers: [], roles: [] },
      claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
      surface_language: {
        registerDescription: '自然、具体', preferredTerms: [], optionalColloquialisms: [],
        prohibitedCliches: [], antiCopyRules: [],
      },
    },
    intelligence: {
      industry: '测试行业', domain: '测试领域', projectSummary: '测试摘要', verifiedFacts: [],
      differentiators: [], audienceStates: ['collecting'], hardBoundaries: [], prohibitedClaims: [],
      dynamicUnknowns: [], evidenceIds: [],
    },
  };
}

function stage2PlanningPayload(): Record<string, unknown> {
  return {
    informationGaps: [{
      key: 'gap-key', title: '待核验信息', question: '适用边界是什么？', priority: 80,
      label: '待核验信息', category: 'decision', audienceStages: ['collecting'], importance: 0.6,
      decisionLeverage: 0.6, proofability: 0.4, evidenceIds: [], required: true,
    }],
    expressionStrategies: [{
      name: '边界比较', label: '边界比较', prototype: 'option_comparison', description: '先比较再给边界',
      openingMode: 'reader_question', narrativeMode: 'question_framework_boundary',
      bodyRole: 'minimum_sufficient_information', imageRole: 'other', commentMode: 'gap_completion',
      voice: '克制', sequence: [], targetChannels: ['N.body'],
    }],
  };
}

function stage3OpportunityPayload(): Record<string, unknown> {
  return {
    topicOpportunities: [{
      title: '选题', topic: '边界比较', angle: '核验适用边界', rationale: '帮助做决定',
      gapKeys: ['gap-key'], audienceStage: 'collecting', entry: 'search', relevance: 0.9, importance: 0.8,
      proofability: 0.6, novelty: 0.5, decisionLeverage: 0.8, cognitiveCost: 0.3, risk: 0.2,
      evidenceIds: [], boundaries: [], tags: [], imageAssetIds: [], status: 'eligible',
    }],
  };
}

function imageAnalysisPayload(): Record<string, unknown> {
  return {
    observedFacts: ['蓝色方形图片'], inferredSignals: [], unknowns: [], visibleText: [], roles: ['cover'],
    quality: { clarity: 0.9, relevance: 0.7, textLegibility: 0.1 }, safetyFlags: [], evidenceIds: [],
    source: 'uploaded', altText: '蓝色方形图片',
  };
}

function stageOf(rawBody: string): string {
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 1/3')) return 'blueprint';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 2/3')) return 'planning';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 3/3')) return 'opportunity';
  if (rawBody.includes('Analyze this project image')) return 'image';
  return 'enrichment';
}

function modelSuccess(payload: Record<string, unknown>): MockReply {
  return { status: 200, body: { output_text: JSON.stringify(payload) } };
}

function projectStageReply(stage: string): MockReply {
  if (stage === 'blueprint') return modelSuccess(stage1BlueprintPayload());
  if (stage === 'planning') return modelSuccess(stage2PlanningPayload());
  if (stage === 'opportunity') return modelSuccess(stage3OpportunityPayload());
  return modelSuccess({});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function database(): DatabaseService {
  return app.get(DatabaseService);
}

function service(): IntelligenceService {
  return app.get(IntelligenceService);
}

function seedTask(id: string, input: {
  status: string;
  claimedBy?: string | null;
  heartbeatAt?: string | null;
  quotaConsumedCount?: number;
}): void {
  const db = database();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO analysis_tasks
       (id, project_id, kind, target_id, status, source_fingerprint, attempt_count,
        created_by, created_at, updated_at, claimed_by, heartbeat_at, quota_consumed_count)
     VALUES (?, ?, 'project', NULL, ?, 'fp', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.status,
    principal.userId,
    now,
    now,
    input.claimedBy ?? null,
    input.heartbeatAt ?? null,
    input.quotaConsumedCount ?? 0,
  );
}

function taskState(id: string): TaskState {
  const row = database().prepare(
    `SELECT id, status, error, result_id, claimed_by, heartbeat_at, completed_at,
            quota_consumed_count
       FROM analysis_tasks WHERE id=?`,
  ).get(id) as unknown as TaskState | undefined;
  assert.ok(row, `analysis task ${id} should exist`);
  return row;
}

function runningTask(): TaskState {
  const row = database().prepare(
    `SELECT id, status, error, result_id, claimed_by, heartbeat_at, completed_at,
            quota_consumed_count
       FROM analysis_tasks WHERE project_id=? AND status='running' ORDER BY rowid DESC LIMIT 1`,
  ).get(projectId) as unknown as TaskState | undefined;
  assert.ok(row, 'a running analysis task should exist');
  return row;
}

function takeOverRunningTask(marker = TAKEOVER_MARKER): TaskState {
  const task = runningTask();
  const now = new Date().toISOString();
  const updated = database().prepare(
    `UPDATE analysis_tasks SET claimed_by=?, heartbeat_at=?, error=?, updated_at=?
       WHERE id=? AND status='running'`,
  ).run(OTHER_INSTANCE_ID, now, marker, now, task.id);
  assert.equal(updated.changes, 1, 'test takeover must update exactly one running task');
  return taskState(task.id);
}

function runStartupCleanup(): void {
  service().onModuleInit();
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected promise to reject');
}

function visibleException(error: unknown): { status: number; text: string } {
  const exception = error as { getStatus?: () => number; getResponse?: () => unknown };
  assert.equal(typeof exception.getStatus, 'function', 'error should be an HttpException');
  assert.equal(typeof exception.getResponse, 'function', 'error should expose an HTTP response');
  return { status: exception.getStatus!(), text: JSON.stringify(exception.getResponse!()) };
}

function assertSafeClaimLost(error: unknown): void {
  const visible = visibleException(error);
  assert.equal(visible.status, 503);
  assert.match(visible.text, /retry|重试/iu);
  assert.doesNotMatch(
    visible.text,
    /ownership-instance|other-instance|claimed_by|heartbeat_at|analysis_tasks|secret-detail|\b(?:SELECT|UPDATE|SQL)\b/iu,
    'user-visible response must not expose ownership or database internals',
  );
}

function countRows(table: string): number {
  const row = database().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id=?`).get(projectId) as { count: number };
  return Number(row.count);
}

function quotaUsed(): number {
  const row = database().prepare(
    `SELECT s.quota_used
       FROM workspace_settings s
       JOIN projects p ON p.workspace_id=s.workspace_id
      WHERE p.id=?`,
  ).get(projectId) as { quota_used: number } | undefined;
  assert.ok(row, 'workspace quota row should exist');
  return Number(row.quota_used);
}

async function withAuditFailure(action: string, operation: () => Promise<unknown>): Promise<unknown> {
  const trigger = 'analysis_audit_failure_' + String(++auditTriggerSequence);
  const actionLiteral = "'" + action.replaceAll("'", "''") + "'";
  database().db.exec(
    'CREATE TRIGGER ' + trigger + ' ' +
    'BEFORE INSERT ON audit_logs WHEN NEW.action=' + actionLiteral + ' ' +
    "BEGIN SELECT RAISE(ABORT, 'forced analysis audit failure'); END",
  );
  try {
    return await rejectionOf(operation());
  } finally {
    database().db.exec('DROP TRIGGER IF EXISTS ' + trigger);
  }
}

function latestTask(): TaskState {
  const row = database().prepare(
    'SELECT id, status, error, result_id, claimed_by, heartbeat_at, completed_at, ' +
    'quota_consumed_count FROM analysis_tasks ORDER BY rowid DESC LIMIT 1',
  ).get() as unknown as TaskState | undefined;
  assert.ok(row, 'an analysis task should exist');
  return row;
}

before(async () => {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const stage = stageOf(rawBody);
    modelCalls.push({ rawBody, stage });
    try {
      const reply = await modelResponder({ rawBody, stage });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');

  dataDir = await mkdtemp(join(tmpdir(), 'ca-analysis-ownership-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'ownership-test-master-encryption-key',
    logger: false,
    platformApiKey: 'ownership-provider-key',
    platformBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    platformModel: 'ownership-model',
    platformTransport: 'responses',
    instanceId: INSTANCE_ID,
    jobHeartbeatMs: 10_000,
    jobClaimTimeoutMs: CLAIM_TIMEOUT_MS,
  });
  await app.init();

  const db = database();
  const now = new Date().toISOString();
  const admin = db.prepare(
    `SELECT id, username, system_role, user_kind, must_change_password FROM users WHERE username='admin'`,
  ).get() as { id: string; username: string; system_role: 'admin'; user_kind: 'research'; must_change_password: number };
  const workspace = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  principal = {
    kind: 'session', userId: admin.id, username: admin.username, systemRole: admin.system_role,
    userKind: admin.user_kind, mustChangePassword: Boolean(admin.must_change_password), tokenHash: '', csrfHash: '',
  };
  projectId = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, workspace_id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'ownership', '归属项目', ?, ?, ?)`,
  ).run(projectId, workspace.id, admin.id, now, now);

  const imageBuffer = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#225588' },
  }).png().toBuffer();
  const uploaded = await service().uploadImage({
    projectId, filename: 'ownership.png', buffer: imageBuffer, principal,
  });
  imageAssetId = String(uploaded.id);
});

after(async () => {
  await app?.close();
  if (modelServer) await new Promise<void>((resolveClose) => modelServer.close(() => resolveClose()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const db = database();
  for (const table of [
    'opportunity_batches',
    'topic_opportunities',
    'image_analysis_versions',
    'project_blueprint_modules',
    'expression_strategies',
    'information_gaps',
    'project_intelligence',
    'analysis_tasks',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const workspace = db.prepare(
    'SELECT workspace_id FROM projects WHERE id=?',
  ).get(projectId) as { workspace_id: string };
  app.get(SettingsService).ensure(workspace.workspace_id, principal.userId);
  db.prepare('UPDATE workspace_settings SET quota_used=0 WHERE workspace_id=?')
    .run(workspace.workspace_id);
  modelCalls = [];
  modelResponder = () => modelSuccess({ ok: true });
});

test('启动清理保留新鲜任务，并只回收过期或无心跳任务且释放租约', () => {
  const freshHeartbeat = new Date(Date.now() - 5_000).toISOString();
  database().prepare('UPDATE workspace_settings SET quota_used=4').run();
  seedTask('alive', {
    status: 'running', claimedBy: 'host:999:other', heartbeatAt: freshHeartbeat, quotaConsumedCount: 1,
  });
  seedTask('stale', {
    status: 'running', claimedBy: 'host:999:dead',
    heartbeatAt: new Date(Date.now() - CLAIM_TIMEOUT_MS - 30_000).toISOString(),
    quotaConsumedCount: 1,
  });
  seedTask('legacy', {
    status: 'queued', claimedBy: 'host:999:legacy', heartbeatAt: null, quotaConsumedCount: 2,
  });
  seedTask('done', { status: 'completed', claimedBy: null, heartbeatAt: null });

  runStartupCleanup();

  const alive = taskState('alive');
  assert.equal(alive.status, 'running');
  assert.equal(alive.claimed_by, 'host:999:other');
  assert.equal(alive.heartbeat_at, freshHeartbeat);
  assert.equal(alive.quota_consumed_count, 1, '新鲜任务的扣费余额不能被其它实例清理');
  for (const id of ['stale', 'legacy']) {
    const row = taskState(id);
    assert.equal(row.status, 'failed');
    assert.match(String(row.error), /restart interrupted/u);
    assert.equal(row.claimed_by, null);
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.quota_consumed_count, 0);
    assert.ok(row.completed_at);
  }
  assert.equal(quotaUsed(), 1, '只退过期任务共 3 次，保留新鲜任务的 1 次消费');
  assert.equal(taskState('done').status, 'completed');
});

test('真实公共入口创建任务时立即写入当前实例归属和心跳，成功终态释放租约', async () => {
  const arrived = deferred();
  const release = deferred();
  modelResponder = async () => {
    arrived.resolve();
    await release.promise;
    return modelSuccess({ ok: true });
  };

  const pending = service().runEnrichmentModel(projectId, principal, 'return JSON', 'draft');
  await arrived.promise;
  const task = runningTask();
  assert.equal(task.claimed_by, INSTANCE_ID);
  assert.ok(task.heartbeat_at);
  assert.equal(task.quota_consumed_count, 1, '调用 provider 前必须同时写入任务扣费余额');
  assert.equal(quotaUsed(), 1);
  runStartupCleanup();
  assert.equal(taskState(task.id).status, 'running', '新鲜的真实任务不能被启动清理回收');

  release.resolve();
  assert.deepEqual(await pending, { ok: true });
  const completed = taskState(task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.claimed_by, null);
  assert.equal(completed.heartbeat_at, null);
  assert.equal(completed.quota_consumed_count, 0, '成功终态要结清任务内账，但保留实际消费');
  assert.ok(completed.completed_at);
  assert.equal(quotaUsed(), 1);
});

test('合法模型失败只由当前持有者结算，并在 failed 终态释放租约', async () => {
  modelResponder = () => ({ status: 400, body: { error: 'controlled rejection' } });

  await rejectionOf(service().runEnrichmentModel(projectId, principal, 'fail', 'draft'));

  const failed = database().prepare(
    `SELECT id, status, error, result_id, claimed_by, heartbeat_at, completed_at,
            quota_consumed_count
       FROM analysis_tasks ORDER BY rowid DESC LIMIT 1`,
  ).get() as unknown as TaskState;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.claimed_by, null);
  assert.equal(failed.heartbeat_at, null);
  assert.equal(failed.quota_consumed_count, 0);
  assert.ok(failed.completed_at);
  assert.equal(quotaUsed(), 0, 'provider 失败没有产出，必须退还本次额度');
});

test('模型调用开始前丢失归属时不请求 provider，并返回不泄密的可重试 503', async () => {
  const pending = service().runEnrichmentModel(projectId, principal, 'must not be called', 'draft');
  const taken = takeOverRunningTask();

  const error = await rejectionOf(pending);

  assert.equal(modelCalls.length, 0, '归属 CAS 失败后不得调用模型');
  assertSafeClaimLost(error);
  const current = taskState(taken.id);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0, '调用前失去归属时不得留下扣费');
});

test('模型失败结算前任务易主时，旧实例不能覆盖新持有者状态', async () => {
  let takenTaskId = '';
  modelResponder = () => {
    const taken = takeOverRunningTask();
    takenTaskId = taken.id;
    return { status: 400, body: { error: 'provider failure after takeover' } };
  };

  const error = await rejectionOf(service().runEnrichmentModel(projectId, principal, 'fail after takeover', 'draft'));

  assertSafeClaimLost(error);
  const current = taskState(takenTaskId);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.completed_at, null);
  assert.equal(current.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0);
});

test('模型成功返回后任务易主时，旧实例不能把它标为 completed', async () => {
  let takenTaskId = '';
  modelResponder = () => {
    const taken = takeOverRunningTask();
    takenTaskId = taken.id;
    return modelSuccess({ ok: true });
  };

  const error = await rejectionOf(service().runEnrichmentModel(projectId, principal, 'succeed after takeover', 'merge'));

  assertSafeClaimLost(error);
  const current = taskState(takenTaskId);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.completed_at, null);
  assert.equal(current.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0, '模型虽返回成功，但旧执行者失去租约时本次调用必须退款');
});

test('项目三阶段分析在最终模型返回前易主时，全部阶段产物随终态 CAS 一起回滚', async () => {
  let takenTaskId = '';
  modelResponder = ({ stage }) => {
    if (stage === 'opportunity') {
      const taken = takeOverRunningTask();
      takenTaskId = taken.id;
    }
    return projectStageReply(stage);
  };

  const error = await rejectionOf(service().analyzeProject(projectId, principal, true));

  assert.deepEqual(modelCalls.map((call) => call.stage), ['blueprint', 'planning', 'opportunity']);
  assertSafeClaimLost(error);
  for (const table of [
    'project_intelligence',
    'project_blueprint_modules',
    'information_gaps',
    'expression_strategies',
    'topic_opportunities',
  ]) {
    assert.equal(countRows(table), 0, `${table} must roll back when final ownership CAS fails`);
  }
  const current = taskState(takenTaskId);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.result_id, null);
  assert.equal(current.quota_consumed_count, 2, '前两阶段成功消费保留，失去租约的第三阶段退款');
  assert.equal(quotaUsed(), 2);
});

test('图片分析在模型返回前易主时，分析版本插入回滚且新持有者状态不被覆盖', async () => {
  let takenTaskId = '';
  modelResponder = ({ stage }) => {
    assert.equal(stage, 'image');
    const taken = takeOverRunningTask();
    takenTaskId = taken.id;
    return modelSuccess(imageAnalysisPayload());
  };

  const error = await rejectionOf(service().analyzeImage(projectId, imageAssetId, principal, true));

  assertSafeClaimLost(error);
  assert.equal(countRows('image_analysis_versions'), 0);
  const current = taskState(takenTaskId);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.result_id, null);
  assert.equal(current.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0);
});

test('专题刷新在模型返回前易主时，批次和选题插入全部回滚', async () => {
  let takenTaskId = '';
  modelResponder = ({ stage }) => {
    assert.equal(stage, 'opportunity');
    const taken = takeOverRunningTask();
    takenTaskId = taken.id;
    return modelSuccess(stage3OpportunityPayload());
  };

  const error = await rejectionOf(service().refreshTopicOpportunities(projectId, principal, { userGuidance: '避免重复' }));

  assertSafeClaimLost(error);
  assert.equal(countRows('opportunity_batches'), 0);
  assert.equal(countRows('topic_opportunities'), 0);
  const current = taskState(takenTaskId);
  assert.equal(current.status, 'running');
  assert.equal(current.claimed_by, OTHER_INSTANCE_ID);
  assert.equal(current.error, TAKEOVER_MARKER);
  assert.equal(current.completed_at, null);
  assert.equal(current.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0);
});

test('项目分析正常成功时七类产物落库，任务终态释放归属', async () => {
  modelResponder = ({ stage }) => projectStageReply(stage);

  const result = await service().analyzeProject(projectId, principal, true);

  assert.equal(countRows('project_intelligence'), 1);
  assert.equal(countRows('project_blueprint_modules'), BLUEPRINT_MODULE_KEYS.length);
  assert.equal(countRows('information_gaps'), 1);
  assert.equal(countRows('expression_strategies'), 1);
  assert.equal(countRows('topic_opportunities'), 1);
  const taskId = String((result.task as Record<string, unknown>).id);
  const completed = taskState(taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.claimed_by, null);
  assert.equal(completed.heartbeat_at, null);
  assert.equal(completed.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 3, '三阶段均成功时保留三次真实模型消费');
});

test('项目分析审计失败时全部产物回滚，失败终态退还三阶段额度', async () => {
  modelResponder = ({ stage }) => projectStageReply(stage);

  await withAuditFailure(
    'intelligence.analyze',
    () => service().analyzeProject(projectId, principal, true),
  );

  assert.deepEqual(modelCalls.map((call) => call.stage), ['blueprint', 'planning', 'opportunity']);
  for (const table of [
    'project_intelligence',
    'project_blueprint_modules',
    'information_gaps',
    'expression_strategies',
    'topic_opportunities',
  ]) {
    assert.equal(countRows(table), 0, table + ' must roll back with the analysis audit');
  }
  const failed = latestTask();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result_id, null);
  assert.equal(failed.claimed_by, null);
  assert.equal(failed.heartbeat_at, null);
  assert.equal(failed.quota_consumed_count, 0);
  assert.ok(failed.completed_at);
  assert.equal(quotaUsed(), 0, '最终审计失败时必须退还三次模型调用额度');
});

test('专题刷新审计失败时批次和选题回滚并退还额度', async () => {
  modelResponder = ({ stage }) => {
    assert.equal(stage, 'opportunity');
    return modelSuccess(stage3OpportunityPayload());
  };

  await withAuditFailure(
    'topic-opportunity.refresh',
    () => service().refreshTopicOpportunities(projectId, principal, { userGuidance: '审计回滚' }),
  );

  assert.equal(countRows('opportunity_batches'), 0);
  assert.equal(countRows('topic_opportunities'), 0);
  const failed = latestTask();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0);
});

test('图片分析审计失败时观察版本回滚并退还额度', async () => {
  modelResponder = ({ stage }) => {
    assert.equal(stage, 'image');
    return modelSuccess(imageAnalysisPayload());
  };

  await withAuditFailure(
    'image-analysis.analyze',
    () => service().analyzeImage(projectId, imageAssetId, principal, true),
  );

  assert.equal(countRows('image_analysis_versions'), 0);
  const failed = latestTask();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result_id, null);
  assert.equal(failed.quota_consumed_count, 0);
  assert.equal(quotaUsed(), 0);
});

test('知识补充审计失败时完成状态回滚为失败并退还额度', async () => {
  modelResponder = ({ stage }) => {
    assert.equal(stage, 'enrichment');
    return modelSuccess({ suggestions: ['补充建议'] });
  };

  await withAuditFailure(
    'knowledge.enrich.model',
    () => service().runEnrichmentModel(projectId, principal, 'return JSON', 'draft'),
  );

  const failed = latestTask();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result_id, null);
  assert.equal(failed.claimed_by, null);
  assert.equal(failed.heartbeat_at, null);
  assert.equal(failed.quota_consumed_count, 0);
  assert.ok(failed.completed_at);
  assert.equal(quotaUsed(), 0);
});
