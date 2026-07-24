// Feature: content-methodology-self-consistency, Property 8: 三阶段串联缺必需内容即刻报错终止
//
// Property 8 (Validates: Requirements 6.6):
// 对任意前一分析阶段的结构化输出，若其缺少下一阶段 schema 所要求的必需内容（如蓝图七模块任一缺失、
// 或规划资源阶段 informationGaps 为空），项目分析（analyzeProject）恒以「指明缺失内容的错误」终止，
// 且不以空输入发起后续分析阶段调用。
//
// 被测入口为设计 "Testing Strategy · 属性→实现位置映射(P8)" 指向的 analyzeProject（apps/api，mock
// provider）。三个分析阶段（蓝图→规划资源→选题）依次经 analyzeWithCurrentModel 调用当前模型；本测试用
// 一个受控的 mock 模型 HTTP 服务（platform provider 指向它）按阶段返回构造好的结构化输出，并用调用日志
// callLog 记录「实际发起了哪些阶段的模型调用」（阶段身份由请求体中的 PROJECT_ANALYSIS_STAGE: N/3 标记判定）。
//
// 每次迭代随机构造两类「前阶段缺必需内容」之一：
//   (A) stage1-missing：阶段 1 蓝图缺失/损坏「七模块」的一个非空子集（omit / null / 字符串 / 数字 / 数组，
//       后者均非 record，故按缺失计）。断言：analyzeProject 以含 "omitted required project blueprint
//       modules" 且指明每个缺失模块名的错误终止；且 callLog 恰为 ['blueprint']——阶段 2/3 未被以空输入发起。
//   (B) stage2-empty：阶段 1 返回完整蓝图（通过完整性校验），阶段 2 规划资源的 informationGaps 为空
//       （缺键 / [] / 全非 record 项 / null）。断言：analyzeProject 以含 "empty planning resources" 且
//       指明 "informationGaps" 的错误终止；且 callLog 恰为 ['blueprint','planning']——阶段 3 未被以空 gaps 发起。
//
// 这两条断言分别对应 Property 8 的两个从句：(a) 以指明缺失内容的错误终止；(b) 不以空输入发起后续阶段调用
// （通过 mock 调用计数/阶段日志验证）。单一属性测试，numRuns=100（≥100）。参考既有 intelligence.test.ts
// 的 startApp / mock provider 用法。

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import { SettingsService } from '../src/settings.service.js';
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

// 完整蓝图：七模块全部以 record 形式存在，可通过 analyzeProject 阶段 1 后的完整性校验。
function completeBlueprintModules(): Record<string, unknown> {
  return {
    knowledge_map: { entries: [] },
    domain_model: {
      projectNoun: '测试项目', industry: '通用信息服务', domain: '决策支持',
      objects: ['项目'], actions: ['比较'], concepts: ['适用边界'],
      decisionTasks: ['确认会改变答案的条件'], vocabulary: ['适用边界'],
    },
    audience_model: { states: [] },
    scenario_model: { families: [] },
    role_model: { hostVoiceTraits: [], hostSpeechMarkers: [], roles: [] },
    claim_policy: { rules: [], prohibitedClaims: [], dynamicInformation: [], unknownHandling: [] },
    surface_language: {
      registerDescription: '自然、具体', preferredTerms: [], optionalColloquialisms: [],
      prohibitedCliches: [], antiCopyRules: [],
    },
  };
}

const COMPLETE_INTELLIGENCE = {
  industry: '通用信息服务', domain: '决策支持', projectSummary: '测试项目蓝图',
  verifiedFacts: [], differentiators: [], audienceStates: ['collecting'], hardBoundaries: [],
  prohibitedClaims: [], dynamicUnknowns: [], evidenceIds: [],
};

// 规划资源阶段的非空、合规输出（仅在阶段 1 通过、需要让阶段 2 通过时使用；本属性中不会用到，因为
// stage2-empty 场景恒返回空 gaps，而 stage1-missing 场景阶段 2 不会被发起）。
const NON_EMPTY_PLANNING = {
  informationGaps: [{ key: 'gap_1', title: '还缺什么证据？', question: '还缺什么证据？' }],
  expressionStrategies: [{ name: '克制问答' }],
};

type Scenario =
  | { kind: 'stage1-missing'; missingKeys: readonly string[]; corruption: 'omit' | 'null' | 'string' | 'number' | 'array' }
  | { kind: 'stage2-empty'; emptyMode: 'omit' | 'emptyArray' | 'nonRecords' | 'nullValue' };

// 阶段 1 蓝图输出：complete 场景返回完整七模块；stage1-missing 场景把选中的键损坏成「非 record」。
function buildBlueprintModules(scenario: Scenario): Record<string, unknown> {
  const modules = completeBlueprintModules();
  if (scenario.kind === 'stage1-missing') {
    for (const key of scenario.missingKeys) {
      switch (scenario.corruption) {
        case 'omit': delete modules[key]; break;
        case 'null': modules[key] = null; break;
        case 'string': modules[key] = 'not-a-module'; break;
        case 'number': modules[key] = 7; break;
        case 'array': modules[key] = []; break; // 数组非 record，按缺失计
      }
    }
  }
  return modules;
}

// 阶段 2 规划资源输出：stage2-empty 场景令 informationGaps 为空（各种「空」形态）。
function buildPlanningPayload(scenario: Scenario): Record<string, unknown> {
  if (scenario.kind === 'stage2-empty') {
    switch (scenario.emptyMode) {
      case 'omit': return { expressionStrategies: [] };
      case 'emptyArray': return { informationGaps: [], expressionStrategies: [] };
      case 'nonRecords': return { informationGaps: [1, 'x', null, true], expressionStrategies: [] };
      case 'nullValue': return { informationGaps: null, expressionStrategies: [] };
    }
  }
  return NON_EMPTY_PLANNING;
}

// —— 受控 mock 模型服务与调用日志（由属性迭代前重置/设置）——
let currentScenario: Scenario | undefined;
const callLog: string[] = [];

function stageOf(rawBody: string): string {
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 1/3')) return 'blueprint';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 2/3')) return 'planning';
  if (rawBody.includes('PROJECT_ANALYSIS_STAGE: 3/3')) return 'opportunity';
  return 'unknown';
}

function responseForStage(stage: string): Record<string, unknown> {
  const scenario = currentScenario!;
  if (stage === 'blueprint') {
    return { blueprintModules: buildBlueprintModules(scenario), intelligence: COMPLETE_INTELLIGENCE };
  }
  if (stage === 'planning') return buildPlanningPayload(scenario);
  if (stage === 'opportunity') return { topicOpportunities: [] };
  return {};
}

// 复刻 intelligence.test.ts 的 startApp（登录 + 改密），返回 request 助手与已登录用户。
async function startApp(options: Record<string, unknown>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-failfast-'));
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'failfast-test-encryption-key',
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

const stage1MissingArb = fc.record({
  kind: fc.constant('stage1-missing' as const),
  // 非空的「缺失模块」子集（去重）。
  missingKeys: fc.uniqueArray(fc.constantFrom(...BLUEPRINT_MODULE_KEYS), { minLength: 1, maxLength: 7 }),
  corruption: fc.constantFrom('omit', 'null', 'string', 'number', 'array') as fc.Arbitrary<'omit' | 'null' | 'string' | 'number' | 'array'>,
});

const stage2EmptyArb = fc.record({
  kind: fc.constant('stage2-empty' as const),
  emptyMode: fc.constantFrom('omit', 'emptyArray', 'nonRecords', 'nullValue') as fc.Arbitrary<'omit' | 'emptyArray' | 'nonRecords' | 'nullValue'>,
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(stage1MissingArb, stage2EmptyArb);

test('Property 8: three-stage analysis fails fast on missing required stage content without initiating later stages', async () => {
  // 一个受控 mock 模型服务，按阶段返回构造好的结构化输出，并记录被发起的阶段调用。
  const modelServer: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const stage = stageOf(rawBody);
    callLog.push(stage);
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
      body: JSON.stringify({ name: 'Fail-fast property project' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const projectId = String(project.body.id);

    const database = app.get(DatabaseService);
    const workspaceId = String((database.prepare(
      'SELECT workspace_id FROM projects WHERE id=?',
    ).get(projectId) as { workspace_id: string }).workspace_id);
    // 抬高平台额度，避免 100+ 次分析（每次 1~2 次模型调用）耗尽默认额度而以「额度用完」错误干扰断言。
    app.get(SettingsService).ensure(workspaceId, user.id);
    database.prepare('UPDATE workspace_settings SET monthly_quota=?, quota_used=0 WHERE workspace_id=?')
      .run(1_000_000_000, workspaceId);

    const service = app.get(IntelligenceService);
    const principal: SessionPrincipal = {
      kind: 'session', userId: user.id, username: 'admin', systemRole: 'admin', userKind: 'research',
      mustChangePassword: false, tokenHash: '', csrfHash: '',
    };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        callLog.length = 0;
        currentScenario = scenario;

        // force=true 绕过 analyzeProject 级缓存，使每次迭代都真正跑三阶段串联。
        let error: unknown;
        try {
          await service.analyzeProject(projectId, principal, true);
        } catch (thrown) {
          error = thrown;
        }

        // (a) 缺必需内容时恒以错误终止。
        assert.ok(error instanceof Error, '缺必需内容时 analyzeProject 必须以错误终止，而非正常返回');
        const message = (error as Error).message;

        if (scenario.kind === 'stage1-missing') {
          // (a) 错误信息指明缺失内容：含标识短语且逐一指明缺失的蓝图模块名。
          assert.match(message, /omitted required project blueprint modules/, message);
          for (const key of scenario.missingKeys) {
            assert.ok(message.includes(key), `错误信息应指明缺失模块 ${key}：${message}`);
          }
          // (b) 仅发起了阶段 1 的模型调用；阶段 2/3 未被以空/不完整蓝图发起。
          assert.deepEqual(callLog, ['blueprint'], `阶段 1 缺模块后不得发起后续阶段；实际调用=${callLog.join(',')}`);
        } else {
          // (a) 错误信息指明「规划资源为空 / informationGaps」。
          assert.match(message, /empty planning resources/, message);
          assert.ok(message.includes('informationGaps'), `错误信息应指明 informationGaps 为空：${message}`);
          // (b) 阶段 1、2 已发起，阶段 3 未被以空 gaps 发起。
          assert.deepEqual(callLog, ['blueprint', 'planning'], `阶段 2 空 gaps 后不得发起阶段 3；实际调用=${callLog.join(',')}`);
        }
      }),
      { numRuns: 100 },
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolveClose, rejectClose) =>
      modelServer.close((closeError) => (closeError ? rejectClose(closeError) : resolveClose())));
  }
});
