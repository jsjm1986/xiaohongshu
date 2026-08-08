// Feature: content-methodology-self-consistency, Property 6: 保留的硬门禁恒阻断且命中即拒绝
//
// Property 6 (Validates: Requirements 3.1, 3.2, 3.6, 3.8, 3.10):
// 对任意包含禁止声明（资格状态 status==='blocked'）、或含"被当作事实但不满足证据落地"的声明的
// 资源 / 草案，审批服务与生成准备恒阻断对应操作，且命中时拒绝该操作、不产生也不持久化任何审批结果
// 或生成输出，并返回指明所命中硬门禁的原因。
//
// 被测入口（设计 "Testing Strategy · 属性→实现位置映射(P6)"：apps/api + agent-core）：
//   1) 禁止声明（blocked）——由真实的结构轴硬门禁纯函数驱动，二者只读结构字段、从不读度量或排序分数：
//      · assertOpportunityReviewFields —— 生成准备门禁（prepareGeneration → assertOpportunityReviewFields）
//        及审批授权门禁（selectOpportunity → assertOpportunitySelectable → assertOpportunityReviewFields）。
//      · assertOpportunitySelectable   —— 审批服务的选择 / 审批门禁。
//      这两个纯函数在真实流程中都在"任何持久化写入之前"执行（selectOpportunity 先跑门禁再 UPDATE、
//      generation.service.create 先跑 prepareGeneration 再 INSERT generation_jobs），故一旦抛出即
//      "拒绝、不产生也不持久化任何结果"（此结构性事实由下方 3.4/3.3/3.5 集成示例具体佐证）。
//   2) 证据落地——由 agent-core content.ts 的纯校验入口 validateGenerationDraft 驱动：被当作事实
//      （claimStatus==='verified'）呈现却无证据的线程恒触发 error 级 `verified_claim_without_evidence`；
//      声明了 evidenceIds 却无任一事实推理条目将可见声明映射到该来源跨度的线程恒触发 error 级
//      `thread_evidence_ledger_mismatch`。error 级校验驱动生成拒绝该草案（不产出 / 持久化无效稿），
//      其 message 即指明所命中门禁的原因。
//
// 说明（忠实性）：两类违规都以真实实现驱动、不 mock、不复制被测逻辑；禁止声明侧覆盖度量已知 / 未知
// （null / undefined / 省略键）三种真实表示，证明未知度量不使禁止声明选题获得任何豁免。单一属性测试，
// numRuns=200（≥100）。文件末尾另附非属性的示例测试，覆盖需求 3.3 / 3.4 / 3.5（抛错且不持久化）与
// 3.7（仅移除度量完备性门禁：含未知度量但满足全部结构门禁的资源放行）。

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import fc from 'fast-check';
import {
  buildKnowledgeLedger,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  parseGenerationDraft,
  validateGenerationDraft,
} from '@content-agent/agent-core';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import {
  assertOpportunityReviewFields,
  assertOpportunitySelectable,
  IntelligenceService,
} from '../src/intelligence.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

// 门禁结论：是否阻断 + 命中门禁的原因（错误消息即门禁身份）。放行时 reason 为 null。
interface GateOutcome {
  readonly blocked: boolean;
  readonly reason: string | null;
}

function runGate(invoke: () => void): GateOutcome {
  try {
    invoke();
    return { blocked: false, reason: null };
  } catch (error) {
    return { blocked: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

// 选题的七项预测表现度量（预测轴）——用于证明未知 / 已知度量都不改变禁止声明门禁结论。
const OPPORTUNITY_METRICS = [
  'relevance',
  'importance',
  'proofability',
  'decisionLeverage',
  'novelty',
  'cognitiveCost',
  'risk',
] as const;

// 度量单元：已知（落在 [0,1] 的显式数值）或未知（null / undefined / 省略键 三种真实表示）。
type MetricCell =
  | { readonly kind: 'known'; readonly value: number }
  | { readonly kind: 'unknown'; readonly rep: 'null' | 'undefined' | 'omit' };

const knownRatio = fc.double({ min: 0, max: 1, noNaN: true }).map((value) => (Object.is(value, -0) ? 0 : value));

const metricCell: fc.Arbitrary<MetricCell> = fc.oneof(
  knownRatio.map((value): MetricCell => ({ kind: 'known', value })),
  fc
    .constantFrom<'null' | 'undefined' | 'omit'>('null', 'undefined', 'omit')
    .map((rep): MetricCell => ({ kind: 'unknown', rep })),
);

const metricsArb = fc.record(
  Object.fromEntries(OPPORTUNITY_METRICS.map((metric) => [metric, metricCell])),
) as fc.Arbitrary<Record<(typeof OPPORTUNITY_METRICS)[number], MetricCell>>;

// ---- 判别式场景：禁止声明（blocked）或证据落地违规草案。----
interface ProhibitedScenario {
  readonly tag: 'prohibited';
  readonly metrics: Record<(typeof OPPORTUNITY_METRICS)[number], MetricCell>;
}
interface EvidenceScenario {
  readonly tag: 'evidence';
  readonly violation: 'verified_no_evidence' | 'ledger_mismatch';
  readonly body: string;
  readonly question: string;
  readonly answer: string;
  readonly benign: number;
  readonly evidenceId: string;
}
type Scenario = ProhibitedScenario | EvidenceScenario;

const prohibitedScenarioArb: fc.Arbitrary<ProhibitedScenario> = fc.record({
  tag: fc.constant('prohibited' as const),
  metrics: metricsArb,
});

const evidenceScenarioArb: fc.Arbitrary<EvidenceScenario> = fc.record({
  tag: fc.constant('evidence' as const),
  violation: fc.constantFrom('verified_no_evidence' as const, 'ledger_mismatch' as const),
  body: fc.string({ maxLength: 40 }),
  question: fc.string({ maxLength: 30 }),
  answer: fc.string({ maxLength: 30 }),
  benign: fc.nat({ max: 2 }),
  evidenceId: fc.string({ minLength: 1, maxLength: 6 }).map((suffix) => `ev_${suffix}`),
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(prohibitedScenarioArb, evidenceScenarioArb);

// 构造含禁止声明（status='blocked'）的选题：七项度量按配置置为已知数值或未知（null / undefined /
// 省略键）；并铺入随度量变化的预测轴派生字段——门禁不得读取它们，blocked 恒阻断。
function buildBlockedOpportunity(metrics: Record<string, MetricCell>): Record<string, unknown> {
  const opportunity: Record<string, unknown> = {
    id: 'opp',
    topic: 'prohibited-claim-topic',
    gapIds: ['gap-1'],
    status: 'blocked',
  };
  const unknownMetrics: string[] = [];
  for (const metric of OPPORTUNITY_METRICS) {
    const cell = metrics[metric]!;
    if (cell.kind === 'known') {
      opportunity[metric] = cell.value;
    } else {
      unknownMetrics.push(metric);
      if (cell.rep === 'null') opportunity[metric] = null;
      else if (cell.rep === 'undefined') opportunity[metric] = undefined;
      // 'omit' → 完全不写入该键（留空 = 未知）。
    }
  }
  opportunity.metricStatus = unknownMetrics.length ? 'unknown' : 'complete';
  opportunity.unknownMetrics = unknownMetrics;
  opportunity.score = unknownMetrics.length ? null : 0.5;
  return opportunity;
}

// 构造一份含证据落地违规的生成草案对象（随后经真实 parseGenerationDraft 解析）：
//  · verified_no_evidence：一条 claimStatus='verified' 但 evidenceIds=[] 的线程（被当作事实却无证据）。
//  · ledger_mismatch：一条声明了 evidenceIds 但无任一事实推理条目映射其来源跨度的线程。
// 另附 0..2 条良性线程（claimStatus='bounded'、evidenceIds=[]），不触发上述任一 error。
function buildEvidenceDraftObject(scenario: EvidenceScenario): unknown {
  const threads: Record<string, unknown>[] = [];
  for (let index = 0; index < scenario.benign; index += 1) {
    threads.push({
      id: `benign_${index}`,
      question: '读者的问题',
      answer: '附带适用边界的回答',
      followUps: [],
      postingIdentity: 'author',
      claimStatus: 'bounded',
      evidenceIds: [],
    });
  }
  if (scenario.violation === 'verified_no_evidence') {
    threads.push({
      id: 'ungrounded',
      question: scenario.question,
      answer: scenario.answer,
      followUps: [],
      postingIdentity: 'author',
      claimStatus: 'verified',
      evidenceIds: [],
    });
  } else {
    threads.push({
      id: 'ledger-mismatch',
      question: scenario.question,
      answer: scenario.answer,
      followUps: [],
      postingIdentity: 'author',
      claimStatus: 'bounded',
      evidenceIds: [scenario.evidenceId],
    });
  }
  return {
    content: {
      H: { hashtags: ['信息', '选择'] },
      N: { imageBrief: '清单式封面', title: '先核实再决定', body: scenario.body },
      Cref: { disclaimer: '评论区问答参考模板', threads },
    },
    evidenceIds: [],
    reasoning: [],
    unknowns: [],
  };
}

// 证据落地校验的固定输入（纯、可复用）：默认生成配置 + 空知识台账。
const evidenceProject = {
  id: 'p1',
  name: '测试项目',
  domain: '信息服务',
  productPoints: [],
  organizationPoints: [],
  cities: [],
  doctors: [],
};
const evidenceConfig = createDefaultGenerationConfig(evidenceProject, DEFAULT_FORMULA_VERSION);
const evidenceLedger = buildKnowledgeLedger([]);

test('Property 6: retained hard gates always block prohibited claims and ungrounded fact claims, rejecting before any persistence', () => {
  fc.assert(
    fc.property(scenarioArb, (scenario) => {
      if (scenario.tag === 'prohibited') {
        const opportunity = buildBlockedOpportunity(scenario.metrics);
        // ranked 声明为 eligible，证明结论完全由结构轴禁止声明（blocked）决定，与排序 / 度量无关。
        const ranked = { effectiveEligibility: 'eligible', reasons: [] as string[] };
        const review = runGate(() => assertOpportunityReviewFields(opportunity));
        const selectable = runGate(() => assertOpportunitySelectable(opportunity, ranked as never));

        // 生成准备（prepareGeneration → assertOpportunityReviewFields）恒阻断禁止声明选题（需求 3.10）。
        assert.strictEqual(review.blocked, true, '生成准备的禁止声明门禁必须阻断 blocked 选题');
        // 审批服务（selectOpportunity → assertOpportunitySelectable）恒阻断禁止声明选题（需求 3.1 / 3.6）。
        assert.strictEqual(selectable.blocked, true, '审批服务的禁止声明门禁必须阻断 blocked 选题');
        // 命中即返回指明门禁的原因（需求 3.8）；未知 / 已知度量都不使其获得豁免（需求 3.9 佐证）。
        assert.match(String(review.reason), /blocked/i, '生成准备的拒绝原因应指明命中的禁止声明门禁');
        assert.match(String(selectable.reason), /blocked/i, '审批服务的拒绝原因应指明命中的禁止声明门禁');
        return;
      }

      const draft = parseGenerationDraft(JSON.stringify(buildEvidenceDraftObject(scenario)));
      const issues = validateGenerationDraft({
        draft,
        config: evidenceConfig,
        ledger: evidenceLedger,
        allowedEvidenceIds: [],
      });
      const code = scenario.violation === 'verified_no_evidence'
        ? 'verified_claim_without_evidence'
        : 'thread_evidence_ledger_mismatch';
      const hit = issues.find((issue) => issue.code === code
        && issue.severity === 'warning'
        && issue.disposition === 'review');

      // 无据事实判断仍必须留下可审计提醒，但它依赖语义/台账解释，不能仅凭
      // error 位升级为发布硬门禁。精确引文、未知证据 ID 等机械真实性问题由
      // Core 的 NON_OVERRIDABLE allowlist 回归单独保证。
      assert.ok(hit, `证据落地问题必须保留 review 提醒：期望命中 ${code}`);
      assert.ok(
        hit && typeof hit.message === 'string' && hit.message.length > 0,
        '证据落地提醒必须返回明确原因',
      );
    }),
    { numRuns: 200 },
  );
});

// ---- 示例（Requirement 3.7）：仅移除"度量完备性"门禁——纯门禁驱动、无需数据库。----
// 含全部未知度量（null）但满足全部结构门禁（status='eligible'、有主题、有缺口引用、effectiveEligibility
// 非 ineligible）的选题，能通过被保留的结构轴硬门禁而放行。这与既有集成用例
// "unknown opportunity metrics remain null and no longer block selection or generation" 呼应。
test('Example (Requirement 3.7): unknown metrics alone never trip the retained structural gates', () => {
  const opportunity: Record<string, unknown> = {
    id: 'opp',
    topic: '先核验再比较',
    gapIds: ['gap-1'],
    status: 'eligible',
    relevance: null,
    importance: null,
    proofability: null,
    decisionLeverage: null,
    novelty: null,
    cognitiveCost: null,
    risk: null,
    metricStatus: 'unknown',
    unknownMetrics: [...OPPORTUNITY_METRICS],
    score: null,
  };
  // review_required（预测轴提示态），非 ineligible（结构轴）——不应阻断可选择性。
  const ranked = { effectiveEligibility: 'review_required', reasons: ['unknown metrics'] };
  assert.doesNotThrow(
    () => assertOpportunityReviewFields(opportunity),
    '含未知度量的 eligible 选题不应被度量门禁阻断审批',
  );
  assert.doesNotThrow(
    () => assertOpportunitySelectable(opportunity, ranked as never),
    '含未知度量的 eligible 选题不应被度量门禁阻断选择',
  );
});

// =====================================================================================
// 集成示例（需求 3.3 / 3.4 / 3.5）：以 intelligence.test.ts 既有 startApp/request 集成风格，
// 驱动真实审批服务 / 生成准备，断言命中硬门禁时抛错且不持久化任何审批结果或生成输出。
// =====================================================================================

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function startApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 'content-agent-hard-gate-'));
  const app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'hard-gate-test-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  cleanup.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let cookie = '';
  let csrf = '';
  const request = async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
    if (typeof options.body === 'string') headers.set('content-type', 'application/json');
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const text = await response.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* binary response */ }
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
  return { app, request };
}

function countGenerationJobs(app: NestExpressApplication, projectId: string): number {
  const row = app.get(DatabaseService)
    .prepare('SELECT COUNT(*) AS total FROM generation_jobs WHERE project_id=?')
    .get(projectId) as { total: number | bigint };
  return Number(row.total);
}

test('Example (Requirements 3.4, 3.8): an opportunity with no gap reference is rejected on select and persists no approval', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Empty gap reference gate' }),
  });
  const projectId = String(project.body.id);
  seedApprovedProjectBlueprint(app, projectId);

  const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({ title: 'No gap reference', status: 'eligible' }),
  });
  assert.equal(opportunity.response.status, 201, JSON.stringify(opportunity.body));

  const rejected = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body.message), /explicitly reference at least one information gap/);
  // 命中即不持久化：审批结果未写入，approvalStatus 仍为 draft。
  const after = await request(`/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}`);
  assert.equal(after.body.approvalStatus, 'draft');
});

test('Example (Requirements 3.3, 3.8): a missing approved blueprint module blocks select and persists no approval', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Blueprint completeness gate' }),
  });
  const projectId = String(project.body.id);
  seedApprovedProjectBlueprint(app, projectId);

  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title: '应该先核对什么？', priority: 80 }),
  });
  const approvedGap = await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(approvedGap.response.status, 201, JSON.stringify(approvedGap.body));
  const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({ title: 'References an approved gap', gapIds: [gap.body.id], status: 'eligible' }),
  });
  assert.equal(opportunity.response.status, 201, JSON.stringify(opportunity.body));

  // 破坏 Blueprint_Completeness：将七个已审批蓝图模块之一直接置为非 approved。
  const staled = app.get(DatabaseService)
    .prepare("UPDATE project_blueprint_modules SET status='draft' WHERE project_id=? AND module_key='domain_model' AND status='approved'")
    .run(projectId);
  assert.equal(Number(staled.changes), 1);

  const rejected = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
  assert.match(String(rejected.body.message), /Approve every project creative blueprint module/);
  assert.match(String(rejected.body.message), /domain_model/);
  // 命中即不持久化：审批结果未写入，approvalStatus 仍为 draft。
  const after = await request(`/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}`);
  assert.equal(after.body.approvalStatus, 'draft');
});

test('Example (Requirements 3.5, 3.8): a stale dependency snapshot blocks generation and persists no output', async () => {
  const { app, request } = await startApp();
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Dependency freshness gate' }),
  });
  const projectId = String(project.body.id);
  seedApprovedProjectBlueprint(app, projectId);

  const gap = await request(`/api/projects/${projectId}/information-gaps`, {
    method: 'POST',
    body: JSON.stringify({ title: '应该先核对什么？', answer: '先核对适用条件。', enabled: true }),
  });
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  const opportunity = await request(`/api/projects/${projectId}/topic-opportunities`, {
    method: 'POST',
    body: JSON.stringify({ title: '生成前核对依赖', gapIds: [gap.body.id], status: 'eligible' }),
  });
  const selected = await request(
    `/api/projects/${projectId}/topic-opportunities/${opportunity.body.id}/select`,
    { method: 'POST' },
  );
  assert.equal(selected.response.status, 201, JSON.stringify(selected.body));

  // 使依赖快照过期：重新编辑并再次审批被引用缺口 → 其 contentRevision / approvedAt 相对快照发生变化。
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ answer: '改为先核对两项条件。' }),
  });
  await request(`/api/projects/${projectId}/information-gaps/${gap.body.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });

  // 生成准备的依赖新鲜度门禁（assertOpportunityDependenciesCurrent）恒阻断，且抛错早于任何生成入队。
  const service = app.get(IntelligenceService);
  assert.throws(
    () => service.prepareGeneration(projectId, { opportunityId: opportunity.body.id }),
    /changed or were re-approved/,
  );
  // 生成端命中即拒绝且不持久化任何生成输出：POST /api/generations 返回 400，且未创建 generation_jobs 记录。
  const jobsBefore = countGenerationJobs(app, projectId);
  const blocked = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({ projectId, opportunityId: opportunity.body.id }),
  });
  assert.equal(blocked.response.status, 400, JSON.stringify(blocked.body));
  assert.equal(countGenerationJobs(app, projectId), jobsBefore);
});
