import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';

const PASSWORD = 'Conversation-bootstrap-123!';
const NEW_PASSWORD = 'Conversation-updated-456!';

const outputs: Record<number, Record<string, unknown>> = {
  1: {
    knowledge_map: { entries: [] },
    domain_model: {
      projectNoun: '对话项目', industry: '测试行业', domain: '决策支持', objects: ['项目'],
      actions: ['比较'], concepts: ['边界'], decisionTasks: ['核验边界'], vocabulary: ['边界'],
    },
  },
  2: {
    audience_model: { states: [{ id: 'collector', label: '收集者', stages: ['collecting'], source: { status: 'inference', evidenceIds: [] } }] },
    scenario_model: { families: [{ id: 'compare', label: '比较', prototype: 'option_comparison', prohibitedUnsupportedHistories: ['我亲自做过'], source: { status: 'hypothesis', evidenceIds: [] } }] },
  },
  3: { role_model: { serviceModel: 'one_time', hostVoiceTraits: ['具体'], hostSpeechMarkers: [], roles: [] } },
  4: {
    claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: ['保持未知'] },
    surface_language: { registerDescription: '自然具体', preferredTerms: [], optionalColloquialisms: [], prohibitedCliches: [], antiCopyRules: [] },
  },
  5: {
    intelligence: {
      industry: '测试行业', domain: '决策支持', projectSummary: '连续对话测试', verifiedFacts: [],
      differentiators: [], audienceStates: ['collecting'], hardBoundaries: [], prohibitedClaims: [],
      dynamicUnknowns: [], evidenceIds: [], evidenceLedger: [],
    },
  },
  6: {
    informationGaps: [{
      key: 'gap-1', title: '还缺什么依据', question: '还缺什么依据？', priority: 80,
      audienceStages: ['collecting'], importance: 0.8, decisionLeverage: 0.7, proofability: 0.3,
      evidenceIds: [], sourceStatus: 'unknown', required: true,
    }],
  },
  7: {
    expressionStrategies: [{
      name: '边界问答', label: '边界问答', prototype: 'option_comparison', openingMode: 'reader_question',
      narrativeMode: 'question_framework_boundary', bodyRole: 'minimum_sufficient_information', imageRole: 'other',
      commentMode: 'gap_completion', voice: '克制', sequence: [], targetChannels: ['N.body'],
    }],
  },
  8: {
    topicOpportunities: [{
      title: '先核验边界再决定', topic: '边界核验', angle: '条件', rationale: '帮助决策', gapKeys: ['gap-1'],
      audienceStage: 'collecting', entry: 'search', relevance: 0.9, importance: 0.8, proofability: 0.3,
      novelty: 0.6, decisionLeverage: 0.8, cognitiveCost: 0.3, risk: 0.2, evidenceIds: [],
      boundaries: [], tags: [], imageAssetIds: [], status: 'eligible', sourceStatus: 'inference',
    }],
  },
};

function turnFrom(messages: Array<{ role: string; content: unknown }>): number {
  const last = messages.at(-1);
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  const match = text.match(/TURN (\d)\/8/u);
  assert.ok(match, `missing turn marker in ${text.slice(0, 200)}`);
  return Number(match[1]);
}

function modelReply(turn: number): Record<string, unknown> {
  const text = JSON.stringify({ ...outputs[turn], marker: `ASSISTANT_TURN_${turn}` });
  return {
    choices: [{ finish_reason: 'stop', message: { content: text } }],
    usage: {
      prompt_tokens: 1000 + turn,
      completion_tokens: 100 + turn,
      prompt_cache_hit_tokens: turn === 1 ? 0 : 900 + turn,
      prompt_cache_miss_tokens: turn === 1 ? 1000 : 100,
    },
  };
}

async function startApp(server: Server) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-conversation-'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: PASSWORD,
    masterEncryptionKey: 'conversation-test-master-key',
    platformApiKey: 'test-key',
    platformBaseUrl: `http://127.0.0.1:${port}/v1`,
    platformModel: 'conversation-test',
    platformTransport: 'chat_completions',
    modelRetryAttempts: 2,
    modelRetryBaseDelayMs: 0,
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  let cookie = '';
  let csrf = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (csrf && !['GET', 'HEAD'].includes(init.method ?? 'GET')) headers.set('x-csrf-token', csrf);
    if (typeof init.body === 'string') headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    return { response, body };
  };
  const login = await request('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
  });
  const project = await request('/api/projects', {
    method: 'POST', body: JSON.stringify({ name: '连续对话项目' }),
  });
  const principal: SessionPrincipal = {
    kind: 'session', userId: login.body.user.id, username: 'admin', systemRole: 'admin', userKind: 'research',
    mustChangePassword: false, tokenHash: '', csrfHash: '',
  };
  const close = async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDir, { recursive: true, force: true });
  };
  return { app, projectId: String(project.body.id), principal, close };
}

async function readBody(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
}

function assertConversationPrefix(messages: Array<{ role: string; content: unknown }>, turn: number): void {
  assert.equal(messages.length, turn * 2 - 1, `turn ${turn} message count`);
  assert.deepEqual(messages.map((message) => message.role),
    Array.from({ length: turn * 2 - 1 }, (_, index) => index % 2 === 0 ? 'user' : 'assistant'));
  for (let previous = 1; previous < turn; previous += 1) {
    const assistant = messages[(previous - 1) * 2 + 1]!;
    assert.equal(typeof assistant.content, 'string');
    assert.equal(assistant.content, JSON.stringify({ ...outputs[previous], marker: `ASSISTANT_TURN_${previous}` }));
  }
}

test('八轮项目分析原样回放完整对话，逐轮落库且只结算一次额度', async () => {
  const calls: Array<{ turn: number; messages: Array<{ role: string; content: unknown }> }> = [];
  let turn6Calls = 0;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const turn = turnFrom(body.messages);
    calls.push({ turn, messages: body.messages });
    response.setHeader('content-type', 'application/json');
    if (turn === 6 && ++turn6Calls === 1) {
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"informationGaps":' } }] }));
      return;
    }
    response.end(JSON.stringify(modelReply(turn)));
  });
  const context = await startApp(server);
  try {
    const service = context.app.get(IntelligenceService);
    const result = await service.analyzeProject(context.projectId, context.principal, true);
    assert.equal((result.task as Record<string, unknown>).status, 'completed');
    assert.deepEqual(calls.map((call) => call.turn), [1, 2, 3, 4, 5, 6, 6, 7, 8]);
    for (const call of calls) assertConversationPrefix(call.messages, call.turn);
    assert.deepEqual(calls[5]!.messages, calls[6]!.messages, '当前轮重试必须复用完全相同的上下文');

    const database = context.app.get(DatabaseService);
    const taskId = String((result.task as Record<string, unknown>).id);
    const turns = database.prepare(
      'SELECT turn_index, turn_key, status, attempt_count, assistant_message FROM analysis_task_turns WHERE task_id=? ORDER BY turn_index',
    ).all(taskId) as Array<{ turn_index: number; turn_key: string; status: string; attempt_count: number; assistant_message: string }>;
    assert.equal(turns.length, 8);
    assert.ok(turns.every((turn) => turn.status === 'completed'));
    assert.equal(turns[5]!.attempt_count, 2);
    assert.match(turns[7]!.assistant_message, /ASSISTANT_TURN_8/u);
    const workspace = database.prepare('SELECT workspace_id FROM projects WHERE id=?').get(context.projectId) as { workspace_id: string };
    const quota = database.prepare('SELECT quota_used FROM workspace_settings WHERE workspace_id=?').get(workspace.workspace_id) as { quota_used: number };
    assert.equal(quota.quota_used, 1, '八个内部轮次属于一次项目分析产品动作');
  } finally {
    await context.close();
  }
});

test('相同资料重试会从失败轮继续，不重新调用已完成轮次', async () => {
  let failTurn6 = true;
  const calls: Array<{ run: number; turn: number; messages: Array<{ role: string; content: unknown }> }> = [];
  let run = 1;
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const turn = turnFrom(body.messages);
    calls.push({ run, turn, messages: body.messages });
    response.setHeader('content-type', 'application/json');
    if (turn === 6 && failTurn6) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: { message: 'temporary outage' } }));
      return;
    }
    response.end(JSON.stringify(modelReply(turn)));
  });
  const context = await startApp(server);
  try {
    const service = context.app.get(IntelligenceService);
    await assert.rejects(service.analyzeProject(context.projectId, context.principal, true));
    assert.deepEqual(calls.map((call) => call.turn), [1, 2, 3, 4, 5, 6, 6]);

    failTurn6 = false;
    run = 2;
    const result = await service.analyzeProject(context.projectId, context.principal, true);
    assert.equal((result.task as Record<string, unknown>).status, 'completed');
    const resumed = calls.filter((call) => call.run === 2);
    assert.deepEqual(resumed.map((call) => call.turn), [6, 7, 8]);
    assertConversationPrefix(resumed[0]!.messages, 6);
    assert.match(String(resumed[0]!.messages[1]!.content), /ASSISTANT_TURN_1/u);

    const database = context.app.get(DatabaseService);
    const tasks = database.prepare(
      "SELECT id, status FROM analysis_tasks WHERE project_id=? AND kind='project' ORDER BY created_at",
    ).all(context.projectId) as Array<{ id: string; status: string }>;
    assert.deepEqual(tasks.map((task) => task.status), ['failed', 'completed']);
    const resumedTurns = database.prepare(
      'SELECT turn_index, status FROM analysis_task_turns WHERE task_id=? ORDER BY turn_index',
    ).all(tasks[1]!.id) as Array<{ turn_index: number; status: string }>;
    assert.deepEqual(resumedTurns.map((turn) => turn.turn_index), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(resumedTurns.every((turn) => turn.status === 'completed'));
  } finally {
    await context.close();
  }
});
