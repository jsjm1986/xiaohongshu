// Feature: content-methodology-self-consistency — 三阶段装配单测（示例/单元测试，非属性测试）
//
// 覆盖设计 "Testing Strategy · 示例/边界测试 · 三阶段装配（需求 6.1–6.5）"：
// 用一个「mock provider」（受控 mock 模型 HTTP 服务，platform provider 指向它）按阶段返回构造好的
// 结构化输出，并记录三阶段的实际调用顺序与入参（请求体），据此断言 analyzeProject 的三阶段串联装配：
//   1. 顺序固定为 蓝图 → 规划资源 → 选题，不跳阶段（需求 6.1）；
//   2. 阶段 2 入参包含阶段 1 的结构化蓝图输出（提示含 APPROVED_STAGE_1_BLUEPRINT 及蓝图摘要内容）（需求 6.2）；
//   3. 阶段 3 入参包含阶段 2 的结构化输出（提示含 APPROVED_STAGE_2_GAP_CATALOG + APPROVED_STAGE_2_EXPRESSION_STRATEGIES
//      及其摘要内容）（需求 6.3）；
//   4. 各阶段产物落库为 status='draft' 且需独立审批（无隐式级联审批）（需求 6.4）；
//   5. 下游依赖的输出 schema 字段齐全（blueprintModules 七键 / gap / strategy / opportunity 形状，
//      且 opportunity 通过 gapIds 引用阶段 2 落库的缺口）（需求 6.5）。
//
// 阶段身份由请求体中的 PROJECT_ANALYSIS_STAGE: N/3 标记判定（复用 analysis-stage-failfast.property.test.ts
// 与 intelligence.test.ts 的 startApp / mock provider 用法）。为验证「串联入参确实来自上一阶段的结构化输出」，
// 各阶段的 mock 输出注入独特标记（如 STAGE1_PROJECT_NOUN / stage2_gap_key / STAGE2_STRATEGY_NAME），
// 再断言这些标记出现在下一阶段的请求体中。

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import type { SessionPrincipal } from '../src/models.js';

// 项目创作蓝图七模块键（与 agent-core PROJECT_BLUEPRINT_MODULE_KEYS 一致；此处内联以保持测试自洽）。
const BLUEPRINT_MODULE_KEYS = [
  'knowledge_map',
  'domain_model',
  'audience_model',
  'scenario_model',
  'role_model',
  'claim_policy',
  'surface_language',
] as const;

// 阶段 1 蓝图：七模块全部以 record 形式存在（通过阶段 1 后的完整性校验），并在 domain_model / intelligence
// 注入独特标记，供断言「阶段 2 提示确实携带了阶段 1 的结构化蓝图摘要」。
function stage1BlueprintPayload(): Record<string, unknown> {
  return {
    blueprintModules: {
      knowledge_map: { entries: [] },
      domain_model: {
        projectNoun: 'STAGE1_PROJECT_NOUN', industry: 'STAGE1_INDUSTRY', domain: 'STAGE1_DOMAIN',
        objects: ['项目'], actions: ['比较'], concepts: ['适用边界'],
        decisionTasks: ['STAGE1_DECISION_TASK'], vocabulary: ['适用边界'],
      },
      audience_model: {
        states: [{ id: 'collector', label: '信息收集者', stages: ['collecting'], goals: ['补全依据'], hesitationReasons: [] }],
      },
      scenario_model: {
        families: [{ id: 'compare', label: '课程比较', prototype: 'option_comparison' }],
      },
      role_model: { hostVoiceTraits: [], hostSpeechMarkers: [], roles: [] },
      claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
      surface_language: {
        registerDescription: '自然、具体', preferredTerms: [], optionalColloquialisms: [],
        prohibitedCliches: [], antiCopyRules: [],
      },
    },
    intelligence: {
      industry: 'STAGE1_INDUSTRY', domain: 'STAGE1_DOMAIN', projectSummary: 'STAGE1_PROJECT_SUMMARY',
      verifiedFacts: [], differentiators: [], audienceStates: ['collecting'], hardBoundaries: [],
      prohibitedClaims: [], dynamicUnknowns: [], evidenceIds: [],
    },
  };
}

// 阶段 2 规划资源：非空 informationGaps + expressionStrategies，注入独特标记（缺口键 / 问题 / 策略名），
// 供断言「阶段 3 提示确实携带了阶段 2 的结构化 gapCatalog + expressionStrategies 摘要」。
function stage2PlanningPayload(): Record<string, unknown> {
  return {
    informationGaps: [{
      key: 'stage2_gap_key', title: 'STAGE2_GAP_TITLE', question: 'STAGE2_GAP_QUESTION',
      priority: 80, label: 'STAGE2_GAP_TITLE', category: 'decision', audienceStages: ['collecting'],
      importance: 0.6, decisionLeverage: 0.6, proofability: 0.4, evidenceIds: [], required: true,
    }],
    expressionStrategies: [{
      name: 'STAGE2_STRATEGY_NAME', label: 'STAGE2_STRATEGY_NAME', prototype: 'option_comparison',
      description: 'STAGE2_STRATEGY_DESC', openingMode: 'reader_question',
      narrativeMode: 'question_framework_boundary', bodyRole: 'minimum_sufficient_information',
      imageRole: 'other', commentMode: 'gap_completion', voice: '克制', sequence: [], targetChannels: ['N.body'],
    }],
  };
}

// 阶段 3 选题：通过 gapKeys 引用阶段 2 的缺口键，落库后其 gapIds 应解析为阶段 2 缺口的存储 id。
function stage3OpportunityPayload(): Record<string, unknown> {
  return {
    topicOpportunities: [{
      title: 'STAGE3_OPP_TITLE', topic: 'STAGE3_OPP_TOPIC', angle: 'STAGE3_ANGLE',
      rationale: '核验适用边界', gapKeys: ['stage2_gap_key'], audienceStage: 'collecting', entry: 'search',
      relevance: 0.9, importance: 0.8, proofability: 0.6, novelty: 0.5, decisionLeverage: 0.8,
      cognitiveCost: 0.3, risk: 0.2, evidenceIds: [], boundaries: [], tags: [], imageAssetIds: [], status: 'eligible',
    }],
  };
}

function stageOf(rawBody: string): string {
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 1/3')) return 'blueprint';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 2/3')) return 'planning';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 3/3')) return 'opportunity';
  return 'unknown';
}

function responseForStage(stage: string): Record<string, unknown> {
  if (stage === 'blueprint') return stage1BlueprintPayload();
  if (stage === 'planning') return stage2PlanningPayload();
  if (stage === 'opportunity') return stage3OpportunityPayload();
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 复刻 intelligence.test.ts / analysis-stage-failfast.property.test.ts 的 startApp（登录 + 改密）。
async function startApp(options: Record<string, unknown>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-chaining-'));
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'chaining-test-encryption-key',
    logger: false,
    ...options,
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
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }),
  });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }),
  });
  return { app, dataDir, request, user: login.body.user };
}

test('three-stage project analysis assembles in fixed order, chains each stage output into the next, and persists drafts with complete schema', async () => {
  // 受控 mock 模型服务：按阶段返回构造好的结构化输出，并按调用顺序记录 { stage, body }。
  const calls: Array<{ stage: string; body: string }> = [];
  const modelServer: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const stage = stageOf(rawBody);
    calls.push({ stage, body: rawBody });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ output_text: JSON.stringify(responseForStage(stage)) }));
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');

  const { app, dataDir, request, user } = await startApp({
    platformApiKey: 'test-key',
    platformBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    platformModel: 'analysis-test',
    platformTransport: 'responses',
  });

  try {
    const project = await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Stage chaining assembly project' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const projectId = String(project.body.id);

    const service = app.get(IntelligenceService);
    const principal: SessionPrincipal = {
      kind: 'session', userId: user.id, username: 'admin', systemRole: 'admin', userKind: 'research',
      mustChangePassword: false, tokenHash: '', csrfHash: '',
    };

    // force=true 绕过 analyzeProject 级缓存，真正跑一次三阶段串联。
    const result = await service.analyzeProject(projectId, principal, true);

    // —— 需求 6.1：顺序固定为 蓝图 → 规划资源 → 选题，且不跳阶段（恰三次调用、次序固定）。——
    assert.deepEqual(
      calls.map((call) => call.stage),
      ['blueprint', 'planning', 'opportunity'],
      `三阶段调用顺序必须固定且不跳阶段；实际=${calls.map((call) => call.stage).join(',')}`,
    );

    const stage1Body = calls.find((call) => call.stage === 'blueprint')!.body;
    const stage2Body = calls.find((call) => call.stage === 'planning')!.body;
    const stage3Body = calls.find((call) => call.stage === 'opportunity')!.body;

    // 链首（阶段 1）不携带任何上一阶段的结构化输入标记（串联从蓝图开始）。
    assert.equal(stage1Body.includes('APPROVED_STAGE_1_BLUEPRINT'), false);
    assert.equal(stage1Body.includes('APPROVED_STAGE_2_GAP_CATALOG'), false);

    // 双号运营的两条硬约束必须以独立段落出现在阶段 1 提示里。此前它们埋在
    // role_model 的长段落中间，产出的 role_model 半数以上只给 0 或 1 个
    // accountable 身份、replyDisplayRoles 写内部 id；合回长段落即回归。
    assert.match(stage1Body, /TWO HARD REQUIREMENTS on roles/);
    assert.ok(stage1Body.includes('must be EXACTLY 2'), '阶段 1 提示应显式要求 accountable 身份恰好 2 个');
    assert.ok(stage1Body.includes('host_account'), '阶段 1 提示应点名禁止把内部 id 写进 replyDisplayRoles');
    assert.ok(stage1Body.includes('Copy the displayRole text verbatim'), '阶段 1 提示应要求逐字复制 displayRole');

    // —— 需求 6.2：阶段 2 入参包含阶段 1 的结构化蓝图输出（标记 + 蓝图摘要内容）。——
    assert.match(stage2Body, /APPROVED_STAGE_1_BLUEPRINT/);
    assert.ok(stage2Body.includes('STAGE1_PROJECT_NOUN'), '阶段 2 提示应含阶段 1 蓝图的 domain_model.projectNoun');
    assert.ok(stage2Body.includes('STAGE1_PROJECT_SUMMARY'), '阶段 2 提示应含阶段 1 的 intelligence.projectSummary');
    assert.ok(stage2Body.includes('STAGE1_DECISION_TASK'), '阶段 2 提示应含阶段 1 的 domain_model.decisionTasks');

    // —— 需求 6.3：阶段 3 入参包含阶段 2 的结构化输出（gapCatalog + expressionStrategies 摘要）。——
    assert.match(stage3Body, /APPROVED_STAGE_2_GAP_CATALOG/);
    assert.match(stage3Body, /APPROVED_STAGE_2_EXPRESSION_STRATEGIES/);
    assert.ok(stage3Body.includes('stage2_gap_key'), '阶段 3 提示应含阶段 2 缺口目录的缺口键');
    assert.ok(stage3Body.includes('STAGE2_GAP_QUESTION'), '阶段 3 提示应含阶段 2 缺口的问题');
    assert.ok(stage3Body.includes('STAGE2_STRATEGY_NAME'), '阶段 3 提示应含阶段 2 的表达策略名');

    // —— 需求 6.4：各阶段产物以 status='draft' 落库且需独立审批（无隐式级联审批）。——
    const database = app.get(DatabaseService);
    const statusesOf = (table: string): string[] =>
      (database.prepare(`SELECT status FROM ${table} WHERE project_id=?`).all(projectId) as unknown as Array<{ status: string }>)
        .map((row) => row.status);
    const intelligenceStatuses = statusesOf('project_intelligence');
    const blueprintStatuses = statusesOf('project_blueprint_modules');
    const gapStatuses = statusesOf('information_gaps');
    const strategyStatuses = statusesOf('expression_strategies');
    const opportunityStatuses = statusesOf('topic_opportunities');
    assert.deepEqual(intelligenceStatuses, ['draft'], '阶段 1 情报应恰有一条且落库为 draft');
    assert.equal(blueprintStatuses.length, 7, '阶段 1 应落库七个蓝图模块');
    assert.ok(blueprintStatuses.every((status) => status === 'draft'), '七个蓝图模块均应为 draft');
    assert.ok(gapStatuses.length >= 1 && gapStatuses.every((status) => status === 'draft'), '阶段 2 缺口应落库为 draft');
    assert.ok(strategyStatuses.length >= 1 && strategyStatuses.every((status) => status === 'draft'), '阶段 2 策略应落库为 draft');
    assert.ok(opportunityStatuses.length >= 1 && opportunityStatuses.every((status) => status === 'draft'), '阶段 3 选题应落库为 draft');
    // 需独立审批：分析后任一产物都不得被自动/级联判为 approved。
    const allStatuses = [...intelligenceStatuses, ...blueprintStatuses, ...gapStatuses, ...strategyStatuses, ...opportunityStatuses];
    assert.ok(allStatuses.every((status) => status !== 'approved'), '任一阶段产物都不得在分析时被自动审批');

    // —— 需求 6.5：下游依赖的输出 schema 字段齐全。——
    // blueprintModules 七键齐全，且每个模块的 data 为非空对象。
    const blueprintModules = result.blueprintModules as Array<Record<string, unknown>>;
    assert.equal(blueprintModules.length, 7);
    assert.deepEqual(
      blueprintModules.map((module) => String(module.moduleKey)).sort(),
      [...BLUEPRINT_MODULE_KEYS].sort(),
    );
    assert.ok(
      blueprintModules.every((module) => isRecord(module.data) && Object.keys(module.data).length > 0),
      '每个蓝图模块都应有非空的结构化 data',
    );

    // gap 形状：id / title / question 齐全，且两轴字段（度量 + metricStatus/unknownMetrics）存在。
    const gaps = result.informationGaps as Array<Record<string, unknown>>;
    assert.ok(gaps.length >= 1);
    const gap = gaps.find((item) => String(item.title) === 'STAGE2_GAP_TITLE') ?? gaps[0]!;
    assert.ok(typeof gap.id === 'string' && gap.id, 'gap 应有 id');
    assert.equal(gap.question, 'STAGE2_GAP_QUESTION');
    for (const key of ['importance', 'decisionLeverage', 'proofability', 'metricStatus', 'unknownMetrics']) {
      assert.ok(key in gap, `gap schema 应含字段 ${key}`);
    }

    // strategy 形状：id / name / 表达策略要件字段齐全。
    const strategies = result.expressionStrategies as Array<Record<string, unknown>>;
    assert.ok(strategies.length >= 1);
    const strategy = strategies.find((item) => String(item.name) === 'STAGE2_STRATEGY_NAME') ?? strategies[0]!;
    assert.ok(typeof strategy.id === 'string' && strategy.id, 'strategy 应有 id');
    assert.equal(strategy.name, 'STAGE2_STRATEGY_NAME');
    for (const key of ['openingMode', 'narrativeMode', 'bodyRole', 'commentMode', 'targetChannels']) {
      assert.ok(key in strategy, `strategy schema 应含字段 ${key}`);
    }

    // opportunity 形状：id / topic / gapIds / eligibilityStatus 齐全，且 gapIds 解析为阶段 2 落库缺口的 id
    // （证明下游 schema 链接：选题 → 缺口 端到端连通）。
    const opportunities = result.topicOpportunities as Array<Record<string, unknown>>;
    assert.ok(opportunities.length >= 1);
    const opportunity = opportunities.find((item) => String(item.title) === 'STAGE3_OPP_TITLE') ?? opportunities[0]!;
    assert.ok(typeof opportunity.id === 'string' && opportunity.id, 'opportunity 应有 id');
    for (const key of ['topic', 'gapIds', 'eligibilityStatus']) {
      assert.ok(key in opportunity, `opportunity schema 应含字段 ${key}`);
    }
    assert.ok(Array.isArray(opportunity.gapIds) && (opportunity.gapIds as unknown[]).length >= 1, 'opportunity 应引用至少一个缺口');
    assert.equal((opportunity.gapIds as string[])[0], gap.id, 'opportunity.gapIds 应解析为阶段 2 落库缺口的存储 id');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolveClose, rejectClose) =>
      modelServer.close((closeError) => (closeError ? rejectClose(closeError) : resolveClose())));
  }
});
