// Feature: content-methodology-self-consistency — 八轮连续对话装配测试
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';

const BLUEPRINT_MODULE_KEYS = [
  'knowledge_map', 'domain_model', 'audience_model', 'scenario_model',
  'role_model', 'claim_policy', 'surface_language',
] as const;

const TURN_OUTPUTS: Record<number, Record<string, unknown>> = {
  1: {
    knowledge_map: { entries: [] },
    domain_model: {
      projectNoun: 'TURN1_PROJECT_NOUN', industry: 'TURN1_INDUSTRY', domain: 'TURN1_DOMAIN',
      objects: ['项目'], actions: ['比较'], concepts: ['适用边界'],
      decisionTasks: ['TURN1_DECISION_TASK'], vocabulary: ['适用边界'],
    },
  },
  2: {
    audience_model: { states: [{
      id: 'collector', label: '信息收集者', stages: ['collecting'], goals: ['补全依据'], hesitationReasons: [],
      source: { status: 'supplied_fact', evidenceIds: ['invented-evidence-id'] },
    }] },
    scenario_model: { families: [{
      id: 'compare', label: '课程比较', prototype: 'option_comparison',
      prohibitedUnsupportedHistories: ['我亲自做过'], source: { status: 'hypothesis', evidenceIds: [] },
    }] },
  },
  3: { role_model: { serviceModel: 'one_time', hostVoiceTraits: [], hostSpeechMarkers: [], roles: [] } },
  4: {
    claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
    surface_language: {
      registerDescription: '自然、具体', preferredTerms: [], optionalColloquialisms: [],
      prohibitedCliches: [], antiCopyRules: [],
    },
  },
  5: { intelligence: {
    industry: 'TURN1_INDUSTRY', domain: 'TURN1_DOMAIN', projectSummary: 'TURN5_PROJECT_SUMMARY',
    verifiedFacts: ['模型声称已经核验但没有台账的事实'], differentiators: [], audienceStates: ['collecting'],
    hardBoundaries: [], prohibitedClaims: [], dynamicUnknowns: [], evidenceIds: [], evidenceLedger: [],
  } },
  6: { informationGaps: [{
    key: 'turn6_gap_key', title: 'TURN6_GAP_TITLE', question: 'TURN6_GAP_QUESTION', priority: 80,
    label: 'TURN6_GAP_TITLE', category: 'decision', audienceStages: ['collecting'], importance: 0.6,
    decisionLeverage: 0.6, proofability: 0.4, evidenceIds: [], required: true,
  }] },
  7: { expressionStrategies: [{
    name: 'TURN7_STRATEGY_NAME', label: 'TURN7_STRATEGY_NAME', prototype: 'option_comparison',
    description: 'TURN7_STRATEGY_DESC',
    applicability: { gapCategories: ['decision'], audienceStages: ['collecting'], publishingTopologies: ['institution_owned'], topicTerms: ['TURN6_GAP'], requiresEvidence: true },
    openingMode: 'reader_question',
    narrativeMode: 'question_framework_boundary', bodyRole: 'minimum_sufficient_information',
    imageRole: 'other', commentMode: 'gap_completion', voice: '克制', sequence: [], targetChannels: ['N.body'],
  }] },
  8: { topicOpportunities: [{
    title: 'TURN8_OPP_TITLE', topic: 'TURN8_OPP_TOPIC', angle: 'TURN8_ANGLE', rationale: '核验适用边界',
    gapKeys: ['turn6_gap_key'], audienceStage: 'collecting', entry: 'search', relevance: 0.9,
    importance: 0.8, proofability: 0.6, novelty: 0.5, decisionLeverage: 0.8,
    cognitiveCost: 0.3, risk: 0.2, evidenceIds: [], boundaries: [], tags: [], imageAssetIds: [], status: 'eligible',
  }] },
};

function lastTurn(rawBody: string): number {
  const matches = [...rawBody.matchAll(/TURN (\d)\/8/gu)];
  return Number(matches.at(-1)?.[1] ?? 0);
}

function assistantText(turn: number): string {
  return JSON.stringify({ ...TURN_OUTPUTS[turn], marker: `TURN_${turn}_OUTPUT` });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function startApp(modelServer: Server) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-eight-turn-assembly-'));
  await new Promise<void>((resolve, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (modelServer.address() as AddressInfo).port;
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin', adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'eight-turn-assembly-key', logger: false,
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
    const text = await response.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
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

test('eight-turn project analysis replays accepted JSON in order and persists independently reviewable drafts', async () => {
  const calls: Array<{ turn: number; body: Record<string, any>; raw: string }> = [];
  const modelServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(raw) as Record<string, any>;
    const turn = lastTurn(raw);
    calls.push({ turn, body, raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: assistantText(turn) }));
  });
  const { app, dataDir, request, user } = await startApp(modelServer);
  try {
    const project = await request('/api/projects', {
      method: 'POST', body: JSON.stringify({ name: 'Eight-turn assembly project' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const projectId = String(project.body.id);
    const principal: SessionPrincipal = {
      kind: 'session', userId: user.id, username: 'admin', systemRole: 'admin', userKind: 'research',
      mustChangePassword: false, tokenHash: '', csrfHash: '',
    };
    const result = await app.get(IntelligenceService).analyzeProject(projectId, principal, true);
    assert.match(String((result.task as Record<string, unknown>).sourceFingerprint), /:project-conversation-v3$/u);

    assert.deepEqual(calls.map((call) => call.turn), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const call of calls) {
      const messages = call.body.input as Array<{ role: string; content: unknown }>;
      assert.equal(messages.length, call.turn * 2 - 1);
      assert.deepEqual(messages.map((message) => message.role),
        Array.from({ length: call.turn * 2 - 1 }, (_, index) => index % 2 === 0 ? 'user' : 'assistant'));
      for (let previous = 1; previous < call.turn; previous += 1) {
        assert.equal(messages[(previous - 1) * 2 + 1]!.content, assistantText(previous));
      }
    }
    const turnPrompt = (turn: number): string => {
      const call = calls[turn - 1]!;
      const messages = call.body.input as Array<{ role: string; content: unknown }>;
      const message = messages.at(-1)!;
      assert.equal(message.role, 'user', `turn ${turn} must end with the current user prompt`);
      assert.equal(typeof message.content, 'string', `turn ${turn} prompt must be plain text`);
      return message.content as string;
    };
    const requirePromptContracts = (turn: number, contracts: RegExp[]): void => {
      const prompt = turnPrompt(turn);
      for (const contract of contracts) {
        assert.match(prompt, contract, `turn ${turn} lost prompt contract ${contract}`);
      }
    };

    // Each contract is checked only against that turn's newest user message. The full-history
    // transport cannot make these assertions pass by carrying a keyword from an earlier turn.
    requirePromptContracts(1, [
      /PROJECT_ANALYSIS_CONVERSATION_V3 TURN 1\/8/u,
      /Do not assume a medical, local-service, SaaS/u,
      /Reference-corpus material may guide style only/u,
      /Never invent an evidence id/u,
      /completion claims, repeat-contact language/u,
    ]);
    requirePromptContracts(2, [
      /conditional decision states, never population distributions/u,
      /prohibitedUnsupportedHistories must be filled/u,
      /derive project-specific completion forms/iu,
      /亲测, 亲身经历 and 朋友做过/u,
      /one_time means one decision\/engagement/u,
      /老用户\/回购\/复购\/续做\/第二次做/u,
    ]);
    requirePromptContracts(3, [
      /REPEAT CONTACT over time/u,
      /scheduled return visits is recurring, not one_time/u,
      /each at least 3 utteranceModes/u,
      /老客复购 is allowed only when serviceModel is recurring or mixed/u,
      /accountable=true roles must be EXACTLY 2/u,
      /host_account, assistant_account, role_IP, role_01 or host/u,
      /price\/location\/schedule\/contact questions to the assistant/u,
      /every price, number, credential, schedule or promise needs supplied evidence/u,
      /route to human staff instead of improvising/u,
    ]);
    requirePromptContracts(4, [
      /approved observations support only what is visibly observed/u,
      /Dynamic information must be verified at use time/u,
      /Cross-check every historical_action rule/u,
      /must never authorize a price, number, credential, schedule, promise/u,
      /Slang and colloquialisms are optional, never mandatory/u,
      /reference-corpus wording into project facts/u,
    ]);
    requirePromptContracts(5, [
      /preserving the stricter boundary/u,
      /verifiedFacts must each have a matching evidenceLedger statement/u,
      /Differentiators also require project evidence/u,
      /Cross-check serviceModel, scenario prohibitedUnsupportedHistories/u,
      /unresolved conflicts and time-sensitive facts/u,
    ]);
    requirePromptContracts(6, [
      /Independently enumerate real domain decision tasks, recurring questions/u,
      /do not limit discovery to what the knowledge files already answer/u,
      /ONLY citable evidence handles/u,
      /retaining qualifiers such as 以当期确认为准\/源资料称/u,
      /Prefer a supplied standard-answer or FAQ passage/u,
      /knowledgeAction is independent from content planning/u,
      /Do not treat every information gap as a knowledge-document defect/u,
      /proofability<=0\.3 without verifiable support/u,
    ]);
    requirePromptContracts(7, [
      /Produce exactly 8 materially different strategies/u,
      /not cosmetic renamings/u,
      /preserve factual qualifiers/u,
      /never turn a simulated role\/history into testimony/u,
    ]);
    requirePromptContracts(8, [
      /exact Turn 6 information-gap keys/u,
      /at least one Turn 7 strategy prototype and its target channels/u,
      /Do not copy one generic gap set to every topic/u,
      /All seven are mandatory 0\.\.1 uncalibrated non-causal/u,
      /Set status="blocked" only for genuinely unsafe or prohibited topics/u,
      /Keep unsafe, unprovable or uncertain opportunities visible/u,
      /approvedImageObservations/u,
      /(?:not|never).*proof of a non-visible project claim/u,
    ]);
    assert.match(calls[7]!.raw, /TURN6_GAP_QUESTION/u);
    assert.match(calls[7]!.raw, /TURN7_STRATEGY_NAME/u);

    const database = app.get(DatabaseService);
    const statusesOf = (table: string): string[] =>
      (database.prepare(`SELECT status FROM ${table} WHERE project_id=?`).all(projectId) as Array<{ status: string }>)
        .map((row) => row.status);
    const allStatuses = [
      ...statusesOf('project_intelligence'), ...statusesOf('project_blueprint_modules'),
      ...statusesOf('information_gaps'), ...statusesOf('expression_strategies'),
      ...statusesOf('topic_opportunities'),
    ];
    assert.equal(statusesOf('project_blueprint_modules').length, 7);
    assert.ok(allStatuses.length > 0 && allStatuses.every((status) => status === 'draft'));

    const blueprintModules = result.blueprintModules as Array<Record<string, unknown>>;
    assert.deepEqual(blueprintModules.map((module) => String(module.moduleKey)).sort(), [...BLUEPRINT_MODULE_KEYS].sort());
    assert.ok(blueprintModules.every((module) => isRecord(module.data) && Object.keys(module.data).length > 0));

    const normalizedIntelligence = result.intelligence as Record<string, unknown>;
    assert.deepEqual(normalizedIntelligence.verifiedFacts, []);
    const validationIssues = normalizedIntelligence.evidenceValidationIssues as Array<Record<string, unknown>>;
    assert.ok(validationIssues.some((issue) => issue.reason === 'missing_ledger'));
    assert.ok(validationIssues.some((issue) => issue.reason === 'unknown_evidence'));
    const audienceModule = blueprintModules.find((module) => module.moduleKey === 'audience_model')!;
    const audienceState = ((audienceModule.data as any).states as any[])[0];
    assert.equal(audienceState.source.status, 'inference');
    assert.deepEqual(audienceState.source.evidenceIds, []);

    const gaps = result.informationGaps as Array<Record<string, unknown>>;
    const gap = gaps.find((item) => item.title === 'TURN6_GAP_TITLE')!;
    assert.ok(gap.id);
    assert.equal(gap.question, 'TURN6_GAP_QUESTION');
    for (const key of ['importance', 'decisionLeverage', 'proofability', 'metricStatus', 'unknownMetrics']) assert.ok(key in gap);

    const strategies = result.expressionStrategies as Array<Record<string, unknown>>;
    const strategy = strategies.find((item) => item.name === 'TURN7_STRATEGY_NAME')!;
    assert.ok(strategy.id);
    for (const key of ['openingMode', 'narrativeMode', 'bodyRole', 'commentMode', 'targetChannels']) assert.ok(key in strategy);
    assert.deepEqual(strategy.applicability, {
      gapIds: [], gapCategories: ['decision'], audienceStages: ['collecting'],
      publishingTopologies: ['institution_owned'], topicTerms: ['TURN6_GAP'], requiresEvidence: true,
    });

    const opportunities = result.topicOpportunities as Array<Record<string, unknown>>;
    const opportunity = opportunities.find((item) => item.title === 'TURN8_OPP_TITLE')!;
    assert.ok(opportunity.id);
    assert.ok(Array.isArray(opportunity.gapIds));
    assert.equal((opportunity.gapIds as string[])[0], gap.id);
    assert.equal(opportunity.eligibilityStatus, 'eligible');

    const edited = await request(`/api/projects/${projectId}/blueprint-modules/${audienceModule.id}`, {
      method: 'PATCH', body: JSON.stringify({ data: { states: [{
        id: 'collector', label: '全国用户都偏爱低价', stages: ['collecting'], goals: ['低价'],
        source: { status: 'supplied_fact', evidenceIds: ['still-invented'] },
      }] } }),
    });
    const rejected = await request(`/api/projects/${projectId}/blueprint-modules/${edited.body.id}/approve`, {
      method: 'POST', body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(rejected.response.status, 400);
    assert.match(String(rejected.body.message), /缺少当前有效证据/u);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  }
});
