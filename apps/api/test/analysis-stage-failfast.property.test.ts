// Feature: content-methodology-self-consistency, Property 8:
// 八轮连续分析任一轮缺必需内容时立即终止，不向后续轮发送空状态。
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import { SettingsService } from '../src/settings.service.js';
import type { SessionPrincipal } from '../src/models.js';

const VALID_OUTPUTS: Record<number, Record<string, unknown>> = {
  1: {
    knowledge_map: { entries: [] },
    domain_model: {
      projectNoun: '测试项目', industry: '通用信息服务', domain: '决策支持', objects: ['项目'],
      actions: ['比较'], concepts: ['适用边界'], decisionTasks: ['核验边界'], vocabulary: ['适用边界'],
    },
  },
  2: {
    audience_model: { states: [] },
    scenario_model: { families: [] },
  },
  3: { role_model: { serviceModel: 'one_time', hostVoiceTraits: [], hostSpeechMarkers: [], roles: [] } },
  4: {
    claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
    surface_language: {
      registerDescription: '自然具体', preferredTerms: [], optionalColloquialisms: [],
      prohibitedCliches: [], antiCopyRules: [],
    },
  },
  5: { intelligence: {
    industry: '通用信息服务', domain: '决策支持', projectSummary: '测试项目', verifiedFacts: [],
    differentiators: [], audienceStates: ['collecting'], hardBoundaries: [], prohibitedClaims: [],
    dynamicUnknowns: [], evidenceIds: [], evidenceLedger: [],
  } },
  6: { informationGaps: [{
    key: 'gap-1', title: '还缺什么证据', question: '还缺什么证据？', priority: 80,
    audienceStages: ['collecting'], importance: 0.8, decisionLeverage: 0.8, proofability: 0.3,
    evidenceIds: [], sourceStatus: 'unknown', required: true,
  }] },
  7: { expressionStrategies: [{
    name: '克制问答', openingMode: 'reader_question', narrativeMode: 'question_framework_boundary',
    bodyRole: 'minimum_sufficient_information', imageRole: 'other', commentMode: 'gap_completion',
    voice: '克制', sequence: [], targetChannels: ['N.body'],
  }] },
  8: { topicOpportunities: [{
    title: '边界核验', topic: '边界核验', angle: '条件', gapKeys: ['gap-1'], audienceStage: 'collecting',
    entry: 'search', relevance: 0.8, importance: 0.8, proofability: 0.3, novelty: 0.5,
    decisionLeverage: 0.8, cognitiveCost: 0.3, risk: 0.2, evidenceIds: [], boundaries: [],
    tags: [], imageAssetIds: [], status: 'eligible',
  }] },
};

const REQUIRED_BY_TURN: Record<number, readonly string[]> = {
  1: ['knowledge_map', 'domain_model'],
  2: ['audience_model', 'scenario_model'],
  3: ['role_model'],
  4: ['claim_policy', 'surface_language'],
  5: ['intelligence'],
};

type Corruption = 'omit' | 'null' | 'string' | 'number' | 'array';
type Scenario =
  | { kind: 'missing-record'; turn: number; key: string; corruption: Corruption }
  | { kind: 'empty-gaps'; emptyMode: 'omit' | 'emptyArray' | 'nonRecords' | 'nullValue' };

const missingRecordArb: fc.Arbitrary<Scenario> = fc.integer({ min: 1, max: 5 }).chain((turn) =>
  fc.record({
    kind: fc.constant('missing-record' as const),
    turn: fc.constant(turn),
    key: fc.constantFrom(...REQUIRED_BY_TURN[turn]!),
    corruption: fc.constantFrom<Corruption>('omit', 'null', 'string', 'number', 'array'),
  }),
);
const emptyGapsArb: fc.Arbitrary<Scenario> = fc.record({
  kind: fc.constant('empty-gaps' as const),
  emptyMode: fc.constantFrom('omit', 'emptyArray', 'nonRecords', 'nullValue'),
});
const scenarioArb = fc.oneof(missingRecordArb, emptyGapsArb);

let currentScenario: Scenario | undefined;
const callLog: number[] = [];

function lastTurn(rawBody: string): number {
  const matches = [...rawBody.matchAll(/TURN (\d)\/8/gu)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

function outputFor(turn: number): Record<string, unknown> {
  const scenario = currentScenario!;
  const output = structuredClone(VALID_OUTPUTS[turn]!);
  if (scenario.kind === 'missing-record' && scenario.turn === turn) {
    switch (scenario.corruption) {
      case 'omit': delete output[scenario.key]; break;
      case 'null': output[scenario.key] = null; break;
      case 'string': output[scenario.key] = 'not-a-record'; break;
      case 'number': output[scenario.key] = 7; break;
      case 'array': output[scenario.key] = []; break;
    }
  }
  if (scenario.kind === 'empty-gaps' && turn === 6) {
    switch (scenario.emptyMode) {
      case 'omit': return {};
      case 'emptyArray': return { informationGaps: [] };
      case 'nonRecords': return { informationGaps: [1, 'x', null, true] };
      case 'nullValue': return { informationGaps: null };
    }
  }
  return output;
}

async function startApp(modelServer: Server) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-eight-turn-failfast-'));
  await new Promise<void>((resolve, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (modelServer.address() as AddressInfo).port;
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin', adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'eight-turn-failfast-key', logger: false,
    platformApiKey: 'test-key', platformBaseUrl: `http://127.0.0.1:${port}/v1`,
    platformModel: 'analysis-test', platformTransport: 'responses',
    modelRetryAttempts: 1, modelRetryBaseDelayMs: 0,
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
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST', body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }),
  });
  return { app, dataDir, request, user: login.body.user };
}

test('Property 8: eight-turn analysis fails fast on missing required turn content and never calls later turns', async () => {
  const modelServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const turn = lastTurn(rawBody);
    callLog.push(turn);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: JSON.stringify(outputFor(turn)) }));
  });
  const { app, dataDir, request, user } = await startApp(modelServer);
  try {
    const project = await request('/api/projects', {
      method: 'POST', body: JSON.stringify({ name: 'Eight-turn fail-fast project' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const projectId = String(project.body.id);
    const database = app.get(DatabaseService);
    const workspaceId = (database.prepare('SELECT workspace_id FROM projects WHERE id=?')
      .get(projectId) as { workspace_id: string }).workspace_id;
    app.get(SettingsService).ensure(workspaceId, user.id);
    database.prepare('UPDATE workspace_settings SET monthly_quota=?, quota_used=0 WHERE workspace_id=?')
      .run(1_000_000_000, workspaceId);
    const service = app.get(IntelligenceService);
    const principal: SessionPrincipal = {
      kind: 'session', userId: user.id, username: 'admin', systemRole: 'admin', userKind: 'research',
      mustChangePassword: false, tokenHash: '', csrfHash: '',
    };

    await fc.assert(fc.asyncProperty(scenarioArb, async (scenario) => {
      // Prevent a previous failed case from providing resumable turns to this independently generated case.
      database.prepare('DELETE FROM analysis_tasks WHERE project_id=?').run(projectId);
      callLog.length = 0;
      currentScenario = scenario;
      let error: unknown;
      try { await service.analyzeProject(projectId, principal, true); } catch (thrown) { error = thrown; }
      assert.ok(error instanceof Error, '缺必需内容时必须以错误终止');
      const cause = (error as { cause?: unknown }).cause;
      const message = cause instanceof Error ? cause.message : error.message;
      const failingTurn = scenario.kind === 'missing-record' ? scenario.turn : 6;
      assert.deepEqual(callLog, Array.from({ length: failingTurn }, (_, index) => index + 1),
        `故障轮 ${failingTurn} 后不得调用后续轮；实际=${callLog.join(',')}`);
      if (scenario.kind === 'missing-record') {
        assert.match(message, /omitted required/u, message);
        assert.ok(message.includes(scenario.key), `错误应指出缺失字段 ${scenario.key}: ${message}`);
      } else {
        assert.match(message, /empty planning resources/u, message);
        assert.ok(message.includes('informationGaps'), message);
      }
      const persisted = database.prepare(
        'SELECT turn_index, status FROM analysis_task_turns WHERE task_id=(SELECT id FROM analysis_tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY turn_index',
      ).all(projectId) as Array<{ turn_index: number; status: string }>;
      assert.equal(persisted.at(-1)?.turn_index, failingTurn);
      assert.equal(persisted.at(-1)?.status, 'failed');
    }), { numRuns: 100 });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});
