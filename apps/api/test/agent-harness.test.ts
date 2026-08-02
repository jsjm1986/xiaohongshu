import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';

const PASSWORD = 'Harness-bootstrap-123!';
const NEW_PASSWORD = 'Harness-updated-456!';
const FACT = '项目资料要求先核验明确条件。';
const LEGACY_TABLES = [
  'analysis_tasks', 'project_intelligence', 'project_blueprint_modules',
  'information_gaps', 'expression_strategies', 'topic_opportunities',
  'generation_jobs', 'content_packages', 'coverage_records',
] as const;

let app: NestExpressApplication;
let modelServer: Server;
let dataDir = '';
let baseUrl = '';
let cookie = '';
let csrf = '';
let projectId = '';
let imageAssetId = '';
let modelCalls = 0;
let actionStage = 0;
let modelMode: 'normal' | 'hold' | 'empty-review' = 'normal';
let heldRequestAborted = false;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

function candidate(index: 0 | 1 | 2, evidenceId: string, imageEvidenceId: string, revision = false) {
  return {
    candidateIndex: index,
    concept: ['请假核验清单', '反常识判断框架', '行动前问答'][index],
    content: {
      H: { hashtags: [`核验角度${index + 1}`, '项目决策'] },
      N: {
        coverHeadline: `先核验，再决定 ${index + 1}`,
        coverSubheadline: '把会改变答案的条件先列清楚',
        imageBrief: `第${index + 1}套核验清单封面，参考已批准图片观察。`,
        imageSequence: [{
          sequence: 1,
          source: 'selected_asset',
          assetId: imageAssetId,
          role: '封面与核验清单示意',
          overlayText: '先核验，再决定',
          direction: '使用已选清单图片，保持原始画面内容，不添加效果暗示。',
          evidenceIds: [imageEvidenceId],
        }],
        title: `先核验，再决定 ${index + 1}`,
        body: `这是第${index + 1}套独立构思。${FACT}未提供的具体结果保持未知。`,
        callToAction: '先把自己的条件列出来，再逐项核验。',
      },
      Cref: {
        disclaimer: '以下为模拟问答参考模板，不代表真实用户互动。',
        ownedFirstComment: '账号补充：具体个人结果未知，请按自己的条件逐项确认。',
        threads: [{
          id: `thread_${index + 1}`,
          question: '行动前应该先核验什么？',
          answer: '先核验资料中明确列出的条件，个人结论仍需结合实际情况确认。',
          followUps: [],
          clarification: '不同答案取决于实际条件，不能用单条互动替代核验。',
          nextStep: '补充自己的条件，并由可追责账号按资料核验。',
          stopReason: 'evidence_boundary',
          postingIdentity: 'publisher',
          evidenceIds: [evidenceId],
          boundary: '不替代个体判断',
        }],
      },
      publishing: {
        entryPoint: '搜索与推荐流',
        accountIdentity: '项目官方发布账号',
        timingNote: '按实际内容排期发布，发布前人工确认时效信息。',
        interactionGoal: '引导读者补充自己的核验条件。',
        responseSla: '工作时段 4 小时内首次回应，复杂问题先确认已收到。',
        liveQuestionRoutes: [{ when: '项目事实与流程问题', owner: 'staff', action: '核对资料后答复并附核验入口' }],
        updateTriggers: ['项目资料、流程或时效信息变化时更新正文与首评'],
        stopRules: ['涉及个体适用性或证据不足时停止在线判断并转专业复核'],
      },
    },
    assetDecisions: [{
      assetId: imageAssetId,
      decision: 'use',
      rationale: '已批准观察显示该图适合作为核验清单示意。',
      evidenceIds: [imageEvidenceId],
    }],
    citations: [{ statement: FACT, evidenceIds: [evidenceId] }],
    unknowns: ['具体个人结果未知'],
    selfReview: '事实引用已绑定已读证据，模拟身份已明确。',
    revisionNotes: revision
      ? { instructionApplied: ['正文改为更口语的表达'], preservedElements: ['事实边界', '核验清单结构'] }
      : { instructionApplied: [], preservedElements: [] },
  };
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof init.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { response, body, text };
}

function counts(database: DatabaseService, tables: readonly string[]): Record<string, number> {
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number };
    return [table, Number(row.value)];
  }));
}

async function waitForJob(id: string): Promise<any> {
  let detail: any;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const current = await request(`/api/agent-harness/${encodeURIComponent(id)}`);
    assert.equal(current.response.status, 200, JSON.stringify(current.body));
    detail = current.body;
    if (detail.status === 'completed' || detail.status === 'failed') return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Agent Harness task ${id} did not settle: ${JSON.stringify(detail)}`);
}

before(async () => {
  modelServer = createServer(async (incoming, response) => {
    const body = await bodyOf(incoming);
    modelCalls += 1;
    if (modelMode === 'hold') {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10_000);
        response.once('close', () => {
          heldRequestAborted = true;
          clearTimeout(timeout);
          resolve();
        });
      });
      if (!response.destroyed) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: { message: 'held request timed out in test' } }));
      }
      return;
    }
    const schemaName = String(body.response_format?.json_schema?.name ?? body.text?.format?.name ?? '');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = messages.map((message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const evidenceId = prompt.match(/evidence_section_[0-9a-f]{20}/u)?.[0] ?? '';
    const imageEvidenceId = prompt.match(/evidence_image_[0-9a-f]{20}/u)?.[0] ?? '';
    const revision = prompt.includes('"runMode":"revision"');
    let output: Record<string, unknown>;
    if (schemaName === 'agent_harness_search') {
      output = { query: '核验 条件', rationale: '先定位项目明确资料。' };
    } else if (schemaName === 'agent_harness_read') {
      assert.ok(evidenceId, '证据选择阶段应能读取搜索结果中的 evidence id');
      output = { evidenceIds: [evidenceId, ...(imageEvidenceId ? [imageEvidenceId] : [])], rationale: '读取知识与已选图片观察后再形成发布包。' };
    } else if (schemaName === 'agent_harness_submit') {
      assert.match(prompt, /output responsibility contract/u, '方法合同必须进入候选生成系统约束');
      assert.match(prompt, /bodyRole/u, '方法合同必须包含正文职责');
      assert.match(prompt, /commentRole/u, '方法合同必须包含评论职责');
      assert.match(prompt, /boundaryPolicy/u, '方法合同必须包含方法边界');
      assert.ok(evidenceId, '提交候选前应携带已读 evidence id');
      const buildCandidate = (index: 0 | 1 | 2, isRevision = false) => {
        const value = candidate(index, evidenceId, imageEvidenceId || 'unused-image-evidence', isRevision);
        if (!imageEvidenceId) {
          value.content.N.imageSequence = [{ sequence: 1, source: 'new_design', assetId: '', role: '封面', overlayText: '先核验，再决定', direction: '按文字证据制作简洁封面。', evidenceIds: [evidenceId] }];
          value.assetDecisions = [];
        }
        return value;
      };
      output = {
        decisionSummary: revision ? '只对所选候选执行定向改稿。' : '围绕同一事实边界形成三套不同表达。',
        candidates: revision
          ? [buildCandidate(0, true)]
          : [buildCandidate(0), buildCandidate(1), buildCandidate(2)],
      };
    } else if (schemaName === 'agent_harness_final_review') {
      if (modelMode === 'empty-review') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 } }));
        return;
      }
      assert.ok(evidenceId, '合并复核应收到本轮已读证据');
      output = {
        complete: true,
        summary: revision ? '定向改稿已逐项复核。' : '已逐项盘点本轮候选中的项目事实。',
        claims: (revision ? [0] : [0, 1, 2]).map((candidateIndex) => ({
          candidateIndex, statement: FACT, evidenceIds: [evidenceId], classification: 'project_fact',
        })),
      };
    } else {
      throw new Error(`Unexpected Harness schema in test: ${schemaName}`);
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    }));
  });
  const modelPort = await listen(modelServer);
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-harness-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'agent-harness-test-master-key',
    platformApiKey: 'local-model-key',
    platformBaseUrl: `http://127.0.0.1:${modelPort}/v1`,
    platformModel: 'harness-test-model',
    platformTransport: 'chat_completions',
    modelRetryAttempts: 1,
    modelRetryBaseDelayMs: 0,
    jobHeartbeatMs: 50,
    jobClaimTimeoutMs: 500,
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(login.response.status, 201, JSON.stringify(login.body));
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const userId = String(login.body.user.id);
  const changed = await request('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  assert.equal(changed.response.status, 201, JSON.stringify(changed.body));
  const project = await request('/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Agent Harness 隔离项目', description: '只测试旁路创作' }),
  });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = String(project.body.id);
  const knowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      filename: '项目事实.md',
      content: '# 决策条件\n项目资料要求先核验明确条件。具体个人结果没有提供。',
      category: 'general',
      evidenceStatus: 'observed',
    }),
  });
  assert.equal(knowledge.response.status, 201, JSON.stringify(knowledge.body));

  const database = app.get(DatabaseService);
  const now = new Date().toISOString();
  imageAssetId = randomUUID();
  const analysisId = randomUUID();
  database.transaction(() => {
    database.prepare(
      `INSERT INTO image_assets
       (id, project_id, filename, storage_path, media_type, bytes, sha256, width, height, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'image/png', 4, ?, 100, 100, ?, ?, ?)`,
    ).run(imageAssetId, projectId, '已批准参考图.png', `${projectId}/approved.png`, 'a'.repeat(64), userId, now, now);
    database.prepare(
      `INSERT INTO image_analysis_versions
       (id, image_asset_id, project_id, version, status, source_fingerprint, observation_json,
        created_by, approved_by, created_at, updated_at, approved_at)
       VALUES (?, ?, ?, 1, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      analysisId, imageAssetId, projectId, 'approved-image-fingerprint',
      JSON.stringify({ visibleFacts: ['画面中有一张核验清单'], safeClaims: ['可作为清单示意图'] }),
      userId, userId, now, now, now,
    );
  });
});

after(async () => {
  await app?.close();
  await close(modelServer);
  await rm(dataDir, { recursive: true, force: true });
});

test('明确主题模式缺少主题时由服务端拒绝且不入队', async () => {
  const database = app.get(DatabaseService);
  const before = counts(database, ['agent_harness_jobs']).agent_harness_jobs;
  const result = await request('/api/agent-harness', {
    method: 'POST',
    body: JSON.stringify({ projectId, topicMode: 'user_defined', creativeIntent: 'decision' }),
  });
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body?.message ?? ''), /主题不能为空/u);
  assert.equal(counts(database, ['agent_harness_jobs']).agent_harness_jobs, before);
});

test('未知成品写法由服务端拒绝且不入队', async () => {
  const database = app.get(DatabaseService);
  const before = counts(database, ['agent_harness_jobs']).agent_harness_jobs;
  const result = await request('/api/agent-harness', {
    method: 'POST',
    body: JSON.stringify({ projectId, methodProfileId: 'invented_method' }),
  });
  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  assert.match(String(result.body?.message ?? ''), /不支持的成品写法/u);
  assert.equal(counts(database, ['agent_harness_jobs']).agent_harness_jobs, before);
});

test('服务端按规范方法冻结阶段、入口、篇幅与职责快照', async () => {
  const created = await request('/api/agent-harness', {
    method: 'POST',
    body: JSON.stringify({ projectId, methodProfileId: 'real_minimal' }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.task.methodProfileId, 'real_minimal');
  assert.equal(created.body.task.audienceStage, 'collecting');
  assert.equal(created.body.task.entryPoint, '推荐流中的真实处境切入');
  assert.equal(created.body.task.bodyLength, 'short');
  assert.equal(created.body.task.methodProfile.label, '真实极简');
  assert.match(created.body.task.methodProfile.bodyRole, /人物处境/u);
  assert.match(created.body.task.methodProfile.commentRole, /短互动/u);
  assert.match(created.body.task.methodProfile.boundaryPolicy, /不得伪装/u);
  const completed = await waitForJob(String(created.body.id));
  assert.equal(completed.status, 'completed', completed.error ?? JSON.stringify(completed));
  assert.equal(completed.task.methodProfile.id, 'real_minimal');
  await request(`/api/agent-harness/${encodeURIComponent(String(created.body.id))}`, { method: 'DELETE' });
  modelCalls = 0;
  actionStage = 0;
});

test('同一父运行的活跃重试返回 409，且不重复扣额度或创建任务', async () => {
  const database = app.get(DatabaseService);
  const project = database.prepare('SELECT workspace_id, created_by FROM projects WHERE id=?').get(projectId) as {
    workspace_id: string;
    created_by: string;
  };
  const sourceId = randomUUID();
  const activeRetryId = randomUUID();
  const now = new Date().toISOString();
  const futureHeartbeat = new Date(Date.now() + 60_000).toISOString();
  database.transaction(() => {
    const insert = database.prepare(
      `INSERT INTO agent_harness_jobs
       (id, project_id, status, topic, goal, task_json, parent_job_id, run_kind,
        created_by, created_at, updated_at, claimed_by, heartbeat_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const task = JSON.stringify({
      topic: '冲突防护测试', goal: '', mustInclude: [], forbidden: [], imageAssetIds: [],
    });
    insert.run(sourceId, projectId, 'completed', '冲突防护测试', task, null, 'original', project.created_by, now, now, null, null);
    insert.run(activeRetryId, projectId, 'running', '冲突防护测试', task, sourceId, 'retry', project.created_by, now, now, 'held-by-test', futureHeartbeat);
  });
  const beforeJobs = counts(database, ['agent_harness_jobs']).agent_harness_jobs;
  const beforeQuota = Number((database.prepare(
    'SELECT quota_used FROM workspace_settings WHERE workspace_id=?',
  ).get(project.workspace_id) as { quota_used: number }).quota_used);
  const beforeModelCalls = modelCalls;

  const duplicate = await request(`/api/agent-harness/${sourceId}/retry`, {
    method: 'POST', body: '{}',
  });
  assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));
  assert.match(String(duplicate.body?.message ?? ''), /已有进行中的重试/u);
  assert.equal(counts(database, ['agent_harness_jobs']).agent_harness_jobs, beforeJobs);
  assert.equal(
    Number((database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(project.workspace_id) as { quota_used: number }).quota_used),
    beforeQuota,
  );
  assert.equal(modelCalls, beforeModelCalls);

  database.prepare('DELETE FROM agent_harness_jobs WHERE id IN (?, ?)').run(activeRetryId, sourceId);
});

test('Agent Harness 完整生命周期走独立表，不写旧分析、规划或生成链路', async () => {
  const database = app.get(DatabaseService);
  const beforeLegacy = counts(database, LEGACY_TABLES);
  const beforeHarness = counts(database, [
    'agent_harness_jobs', 'agent_harness_candidates', 'agent_harness_tool_calls',
  ]);
  const created = await request('/api/agent-harness', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topicMode: 'agent_discovery',
      creativeIntent: 'decision',
      audienceStage: 'comparing',
      goal: '生成三套完整发布参考包',
      mustInclude: ['核验'],
      forbidden: ['保证效果'],
      imageAssetIds: [imageAssetId],
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const originalId = String(created.body.id);
  const original = await waitForJob(originalId);

  assert.equal(original.status, 'completed', original.error ?? JSON.stringify(original));
  assert.equal(modelCalls, 4);
  assert.equal(original.runKind, 'original');
  assert.equal(original.channel, 'agent_harness');
  assert.equal(original.task.topicMode, 'agent_discovery');
  assert.equal(original.task.creativeIntent, 'decision');
  assert.match(original.topic, /Agent 从项目资料中自主发现选题/u);
  assert.equal(original.candidates.length, 3);
  assert.ok(original.candidates.every((item: any) => item.validation.valid));
  assert.ok(original.candidates.every((item: any) => item.claimAudit.length === 1));
  assert.ok(original.candidates.every((item: any) => item.content.N.imageSequence.length === 1));
  assert.ok(original.candidates.every((item: any) => item.assetDecisions[0].assetId === imageAssetId));
  assert.ok(original.candidates.every((item: any) => item.publicationChecklist.some((check: any) => check.status === 'manual_review')));
  assert.ok(original.candidates.every((item: any) => item.publicationChecklist.some((check: any) => check.key === 'execution_plan' && check.status === 'ready')));
  assert.ok(original.candidates.every((item: any) => item.content.Cref.threads[0].clarification));
  assert.ok(original.candidates.every((item: any) => item.content.Cref.threads[0].nextStep));
  assert.ok(original.candidates.every((item: any) => item.content.Cref.threads[0].stopReason === 'evidence_boundary'));
  assert.ok(original.candidates.every((item: any) => item.content.publishing.responseSla));
  assert.ok(original.candidates.every((item: any) => item.content.publishing.liveQuestionRoutes.length === 1));
  assert.ok(original.candidates.every((item: any) => item.content.publishing.updateTriggers.length === 1));
  assert.ok(original.candidates.every((item: any) => item.content.publishing.stopRules.length === 1));
  assert.match(original.claimAuditSummary, /逐项盘点/u);
  assert.equal(original.imageSnapshot.length, 1);
  assert.equal(original.imageSnapshot[0].assetId, imageAssetId);
  assert.match(original.imageSnapshot[0].evidenceId, /^evidence_image_[0-9a-f]{20}$/u);
  assert.deepEqual(original.traces.map((trace: any) => trace.action), [
    'search_knowledge', 'read_evidence', 'submit_candidates',
  ]);
  assert.equal(original.runtimeSnapshot.source, 'neutral_project_evidence_and_approved_image_observations');
  assert.ok(original.runtimeSnapshot.excludes.includes('project_intelligence'));
  assert.ok(original.runtimeSnapshot.digest);
  assert.ok(original.evidenceInventory.length >= 1);
  assert.equal(JSON.stringify(original).includes('具体个人结果没有提供'), false, '详情不应回传完整证据原文');
  assert.equal(JSON.stringify(original).includes('画面中有一张核验清单'), false, '详情不应回传图片观察原文');

  const candidateId = String(original.candidates[0].id);
  const selectedCandidate = await request(`/api/agent-harness/${originalId}/select`, {
    method: 'POST', body: JSON.stringify({ candidateId }),
  });
  assert.equal(selectedCandidate.response.status, 201, JSON.stringify(selectedCandidate.body));
  assert.equal(selectedCandidate.body.selectedCandidateId, candidateId);
  assert.equal(selectedCandidate.body.approvalStatus, 'selected');
  const approvedCandidate = await request(`/api/agent-harness/${originalId}/approve`, {
    method: 'POST', body: JSON.stringify({ notes: '人工复核通过，按当前字节版本批准。' }),
  });
  assert.equal(approvedCandidate.response.status, 201, JSON.stringify(approvedCandidate.body));
  assert.equal(approvedCandidate.body.approvalStatus, 'approved');
  assert.equal(approvedCandidate.body.selectedCandidateId, candidateId);
  assert.match(String(approvedCandidate.body.approvedContentHash), /^[0-9a-f]{64}$/u);
  assert.match(String(approvedCandidate.body.approvalNotes), /人工复核通过/u);
  const markdown = await request(`/api/agent-harness/${originalId}/candidates/${candidateId}/export?format=markdown`);
  assert.equal(markdown.response.status, 200, markdown.text);
  assert.match(markdown.response.headers.get('content-type') ?? '', /text\/markdown/u);
  assert.match(markdown.text, /先核验，再决定 1/u);
  assert.match(markdown.text, /本次冻结的创作合同/u);
  assert.match(markdown.text, /真实问题承接计划/u);
  assert.match(markdown.text, /停止原因/u);
  const json = await request(`/api/agent-harness/${originalId}/candidates/${candidateId}/export?format=json`);
  assert.equal(json.response.status, 200, json.text);
  assert.equal(json.body.validation.valid, true);
  assert.equal(json.body.taskContract.methodProfileId, 'balanced_information');
  assert.match(String(json.body.runtimeContract.version), /^2\.3\./u);
  assert.equal(json.body.content.Cref.threads[0].stopReason, 'evidence_boundary');
  const runMarkdown = await request(`/api/agent-harness/${originalId}/export?format=markdown`);
  assert.equal(runMarkdown.response.status, 200, runMarkdown.text);
  assert.match(runMarkdown.text, /逐图脚本/u);
  assert.match(runMarkdown.text, /账号首评/u);
  assert.match(runMarkdown.text, /发布前检查/u);
  assert.match(runMarkdown.text, /人工复核/u);
  assert.match(runMarkdown.text, /本次冻结的创作合同/u);
  assert.match(runMarkdown.text, /运行时合同/u);
  assert.match(runMarkdown.text, /真实问题承接计划/u);
  const runJson = await request(`/api/agent-harness/${originalId}/export?format=json`);
  assert.equal(runJson.response.status, 200, runJson.text);
  assert.equal(runJson.body.candidates.length, 3);
  assert.equal(runJson.body.taskContract.creativeIntent, 'decision');
  assert.match(String(runJson.body.runtimeContract.digest), /^[0-9a-f]{64}$/u);

  const retried = await request(`/api/agent-harness/${originalId}/retry`, { method: 'POST', body: '{}' });
  assert.equal(retried.response.status, 201, JSON.stringify(retried.body));
  const retryResult = await waitForJob(String(retried.body.id));
  assert.equal(retryResult.status, 'completed', retryResult.error);
  assert.equal(retryResult.runKind, 'retry');
  assert.equal(retryResult.parentJobId, originalId);

  const revised = await request(`/api/agent-harness/${originalId}/revise`, {
    method: 'POST', body: JSON.stringify({ candidateId, instruction: '保留事实边界，改得更口语。' }),
  });
  assert.equal(revised.response.status, 201, JSON.stringify(revised.body));
  const revisionResult = await waitForJob(String(revised.body.id));
  assert.equal(revisionResult.status, 'completed', revisionResult.error);
  assert.equal(revisionResult.runKind, 'revision');
  assert.equal(revisionResult.parentJobId, originalId);
  assert.equal(revisionResult.sourceCandidateId, candidateId);
  assert.match(revisionResult.instruction, /更口语/u);
  assert.equal(revisionResult.candidates.length, 1, '定向改稿只能落一套，不得重新生成三套');
  assert.equal(revisionResult.candidates[0].candidateIndex, 0);
  assert.ok(revisionResult.candidates[0].revisionNotes.instructionApplied.length > 0);
  assert.equal(modelCalls, 12);

  // A failed directed revision must retry with the same one-candidate semantics,
  // original source candidate and instruction rather than becoming a 3-way retry.
  const databaseForRevisionRetry = app.get(DatabaseService);
  databaseForRevisionRetry.prepare(
    "UPDATE agent_harness_jobs SET status='failed', error='测试失败', completed_at=? WHERE id=?",
  ).run(new Date().toISOString(), String(revised.body.id));
  const revisionRetry = await request(`/api/agent-harness/${encodeURIComponent(String(revised.body.id))}/retry`, {
    method: 'POST', body: '{}',
  });
  assert.equal(revisionRetry.response.status, 201, JSON.stringify(revisionRetry.body));
  const revisionRetryResult = await waitForJob(String(revisionRetry.body.id));
  assert.equal(revisionRetryResult.status, 'completed', revisionRetryResult.error);
  assert.equal(revisionRetryResult.runKind, 'revision');
  assert.equal(revisionRetryResult.parentJobId, String(revised.body.id));
  assert.equal(revisionRetryResult.sourceCandidateId, candidateId);
  assert.equal(revisionRetryResult.candidates.length, 1);
  assert.match(revisionRetryResult.instruction, /更口语/u);
  assert.equal(modelCalls, 16);

  const originalWithChildren = await request(`/api/agent-harness/${originalId}`);
  assert.equal(originalWithChildren.response.status, 200);
  assert.equal(originalWithChildren.body.derivedRuns.length, 2);

  const removed = await request(`/api/agent-harness/${originalId}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.alreadyDeleted, false);
  const removedAgain = await request(`/api/agent-harness/${originalId}`, { method: 'DELETE' });
  assert.equal(removedAgain.response.status, 200, JSON.stringify(removedAgain.body));
  assert.equal(removedAgain.body.alreadyDeleted, true);
  const hidden = await request(`/api/agent-harness/${originalId}`);
  assert.equal(hidden.response.status, 404);
  const trash = await request(`/api/agent-harness/trash?projectId=${encodeURIComponent(projectId)}`);
  assert.equal(trash.response.status, 200, JSON.stringify(trash.body));
  assert.ok(trash.body.items.some((item: any) => item.id === originalId && item.deletedAt));
  const restored = await request(`/api/agent-harness/${originalId}/restore`, { method: 'POST', body: '{}' });
  assert.equal(restored.response.status, 201, JSON.stringify(restored.body));
  assert.equal(restored.body.id, originalId);
  assert.equal(restored.body.status, 'completed');

  assert.deepEqual(counts(database, LEGACY_TABLES), beforeLegacy);
  const afterHarness = counts(database, [
    'agent_harness_jobs', 'agent_harness_candidates', 'agent_harness_tool_calls',
  ]);
  assert.equal(afterHarness.agent_harness_jobs - beforeHarness.agent_harness_jobs, 4);
  assert.equal(afterHarness.agent_harness_candidates - beforeHarness.agent_harness_candidates, 8);
  assert.equal(afterHarness.agent_harness_tool_calls - beforeHarness.agent_harness_tool_calls, 12);

  const listed = await request(`/api/agent-harness?projectId=${encodeURIComponent(projectId)}`);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.total, 4);
  assert.ok(listed.body.items.every((item: any) => item.channel === 'agent_harness'));
  assert.ok(listed.body.items.every((item: any) => !('candidates' in item)), '列表投影不应携带候选重字段');

  const paged = await request(`/api/agent-harness?projectId=${encodeURIComponent(projectId)}&limit=1&offset=1`);
  assert.equal(paged.response.status, 200, JSON.stringify(paged.body));
  assert.equal(paged.body.total, 4);
  assert.equal(paged.body.limit, 1);
  assert.equal(paged.body.offset, 1);
  assert.equal(paged.body.items.length, 1);
});



test('最终复核空正文时保留候选，单独重试复核只增加一次调用且不创建新运行', async () => {
  const database = app.get(DatabaseService);
  database.prepare("DELETE FROM rate_limit_buckets WHERE scope='agent-harness.submit'").run();
  const jobsBefore = counts(database, ['agent_harness_jobs']).agent_harness_jobs;
  const callsBefore = modelCalls;
  modelMode = 'empty-review';
  const created = await request('/api/agent-harness', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      topicMode: 'user_defined',
      topic: '复核恢复测试',
      goal: '验证候选检查点与独立复核',
      mustInclude: ['核验'],
      imageAssetIds: [imageAssetId],
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const id = String(created.body.id);
  const blocked = await waitForJob(id);
  assert.equal(modelCalls - callsBefore, 4, '生成链固定为搜索、选证据、提交候选、合并复核四次调用');
  assert.equal(blocked.status, 'completed');
  assert.equal(blocked.reviewStatus, 'blocked');
  assert.ok(blocked.candidateCheckpointAt, '候选必须在复核前留下持久化检查点');
  assert.equal(blocked.candidates.length, 3);
  assert.ok(blocked.candidates.every((item: any) => item.validation.valid === false));
  assert.ok(blocked.candidates.every((item: any) => item.validation.issues.some((issue: any) => issue.code === 'claim_audit_incomplete')));
  assert.match(String(blocked.reviewError), /output text/u);
  const candidateIds = blocked.candidates.map((item: any) => item.id);
  const traceCount = blocked.traces.length;

  modelMode = 'normal';
  const callsBeforeReviewRetry = modelCalls;
  const jobsBeforeReviewRetry = counts(database, ['agent_harness_jobs']).agent_harness_jobs;
  const retried = await request(`/api/agent-harness/${encodeURIComponent(id)}/retry-review`, {
    method: 'POST', body: '{}',
  });
  assert.equal(retried.response.status, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.id, id, '独立复核必须原位恢复，不创建派生运行');
  const recovered = await waitForJob(id);
  assert.equal(modelCalls - callsBeforeReviewRetry, 1, '独立复核只能调用合并复核阶段一次');
  assert.equal(counts(database, ['agent_harness_jobs']).agent_harness_jobs, jobsBeforeReviewRetry);
  assert.equal(counts(database, ['agent_harness_jobs']).agent_harness_jobs, jobsBefore + 1);
  assert.equal(recovered.reviewStatus, 'completed');
  assert.equal(recovered.reviewError, undefined);
  assert.ok(recovered.candidates.every((item: any) => item.validation.valid));
  assert.deepEqual(recovered.candidates.map((item: any) => item.id), candidateIds, '复核升级不得替换候选记录身份');
  assert.equal(recovered.traces.length, traceCount, '独立复核不得重跑或追加检索、读证据、生成轨迹');
  assert.equal(recovered.usage.modelCalls, 4, '逻辑运行用量只统计成功响应；供应商尝试另由 partialUsage 审计');
  assert.ok((recovered.partialUsage?.modelCalls ?? 0) >= 5, '供应商尝试计数必须保留首次失败复核与恢复复核');
});

test('无项目证据必须显式确认，回收站记录可永久删除', async () => {
  const emptyProject = await request('/api/projects', {
    method: 'POST', body: JSON.stringify({ name: 'Agent Harness 空证据项目' }),
  });
  assert.equal(emptyProject.response.status, 201, JSON.stringify(emptyProject.body));
  const emptyProjectId = String(emptyProject.body.id);
  const rejected = await request('/api/agent-harness', {
    method: 'POST', body: JSON.stringify({ projectId: emptyProjectId }),
  });
  assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body.message), /没有可用事实证据|明确确认/u);

  const database = app.get(DatabaseService);
  const source = database.prepare('SELECT created_by FROM projects WHERE id=?').get(projectId) as { created_by: string };
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(
    `INSERT INTO agent_harness_jobs
      (id, project_id, status, progress, topic, goal, task_json, run_kind, created_by, created_at, updated_at, completed_at)
     VALUES (?, ?, 'completed', 100, '永久删除测试', '', '{}', 'original', ?, ?, ?, ?)`,
  ).run(id, projectId, source.created_by, now, now, now);
  const removed = await request(`/api/agent-harness/${id}`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  assert.match(String(removed.body.purgeAfter), /^\d{4}-/u);
  const purged = await request(`/api/agent-harness/${id}/purge`, { method: 'DELETE' });
  assert.equal(purged.response.status, 200, JSON.stringify(purged.body));
  assert.equal(purged.body.purged, true);
  assert.equal(database.prepare('SELECT 1 FROM agent_harness_jobs WHERE id=?').get(id), undefined);
});

test('Agent Harness capabilities 投影与运行治理端点可达', async () => {
  const capabilities = await request(`/api/agent-harness/capabilities?projectId=${encodeURIComponent(projectId)}`);
  assert.equal(capabilities.response.status, 200, JSON.stringify(capabilities.body));
  assert.deepEqual(
    Object.keys(capabilities.body).sort(),
    ['canEdit', 'canExport', 'canRevise', 'canRun', 'projectId'],
  );
  assert.equal(capabilities.body.projectId, projectId);
  assert.equal(capabilities.body.canRun, true);
  assert.equal(capabilities.body.canRevise, true);
  assert.equal(capabilities.body.canEdit, true);
  assert.equal(capabilities.body.canExport, true);
});

test('Agent Harness 列表拒绝畸形和越界分页参数', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=1000001']) {
    const result = await request(`/api/agent-harness?projectId=${encodeURIComponent(projectId)}&${query}`);
    assert.equal(result.response.status, 400, `${query}: ${JSON.stringify(result.body)}`);
  }
});


test('排队中删除退还额度；供应商调用后删除会中止请求并保留调用结算', async () => {
  const database = app.get(DatabaseService);
  const project = database.prepare('SELECT workspace_id, created_by FROM projects WHERE id=?').get(projectId) as { workspace_id: string; created_by: string };
  const now = new Date().toISOString();
  const queuedId = randomUUID();
  const task = JSON.stringify({ topic: '排队取消测试', goal: '', mustInclude: [], forbidden: [], imageAssetIds: [], allowUngrounded: true });
  const beforeQueued = Number((database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(project.workspace_id) as { quota_used: number }).quota_used);
  database.transaction(() => {
    database.prepare('UPDATE workspace_settings SET quota_used=quota_used+1 WHERE workspace_id=?').run(project.workspace_id);
    database.prepare(`INSERT INTO agent_harness_jobs
      (id, project_id, status, topic, goal, task_json, quota_consumed_count, created_by, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, '', ?, 1, ?, ?, ?)`)
      .run(queuedId, projectId, '排队取消测试', task, project.created_by, now, now);
  });
  const queuedDelete = await request(`/api/agent-harness/${queuedId}`, { method: 'DELETE' });
  assert.equal(queuedDelete.response.status, 200, JSON.stringify(queuedDelete.body));
  assert.equal(queuedDelete.body.quotaRefunded, true);
  assert.equal(Number((database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(project.workspace_id) as { quota_used: number }).quota_used), beforeQueued);
  const queuedRow = database.prepare('SELECT status, failure_stage, quota_consumed_count FROM agent_harness_jobs WHERE id=?').get(queuedId) as any;
  assert.equal(queuedRow.status, 'failed');
  assert.equal(queuedRow.failure_stage, 'cancelled');
  assert.equal(queuedRow.quota_consumed_count, 0);

  // Earlier lifecycle cases intentionally exercise the same shared submit bucket.
  // Reset only this test process's bucket so this settlement case reaches the provider.
  database.prepare("DELETE FROM rate_limit_buckets WHERE scope='agent-harness.submit'").run();
  modelMode = 'hold';
  heldRequestAborted = false;
  const beforeRunning = Number((database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(project.workspace_id) as { quota_used: number }).quota_used);
  const created = await request('/api/agent-harness', {
    method: 'POST', body: JSON.stringify({ projectId, topic: '供应商调用后取消', topicMode: 'user_defined' }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const runningId = String(created.body.id);
  let runningRow: any;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    runningRow = database.prepare('SELECT status, provider_started_at, partial_usage_json FROM agent_harness_jobs WHERE id=?').get(runningId);
    if (runningRow?.provider_started_at) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(runningRow?.provider_started_at, '模型请求必须已经发出');
  assert.ok(JSON.parse(String(runningRow.partial_usage_json)).modelCalls >= 1, '发出前先记录调用尝试');

  const runningDelete = await request(`/api/agent-harness/${runningId}`, { method: 'DELETE' });
  assert.equal(runningDelete.response.status, 200, JSON.stringify(runningDelete.body));
  assert.equal(runningDelete.body.quotaRefunded, false);
  for (let attempt = 0; attempt < 100 && !heldRequestAborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(heldRequestAborted, true, '删除运行中任务必须中止底层模型请求');
  const settled = database.prepare(`SELECT status, failure_stage, quota_consumed_count, claimed_by, partial_usage_json,
    (SELECT COUNT(*) FROM agent_harness_candidates c WHERE c.job_id=agent_harness_jobs.id) AS candidate_count
    FROM agent_harness_jobs WHERE id=?`).get(runningId) as any;
  assert.equal(settled.status, 'failed');
  assert.equal(settled.failure_stage, 'cancelled');
  assert.equal(settled.quota_consumed_count, 0);
  assert.equal(settled.claimed_by, null);
  assert.equal(settled.candidate_count, 0, '被取消任务不能写入迟到候选');
  assert.ok(JSON.parse(String(settled.partial_usage_json)).modelCalls >= 1);
  assert.equal(Number((database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(project.workspace_id) as { quota_used: number }).quota_used), beforeRunning + 1);
  modelMode = 'normal';
  actionStage = 0;
});
