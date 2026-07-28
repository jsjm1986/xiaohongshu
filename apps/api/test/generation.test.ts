import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createFormulaVersion } from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { seedApprovedProjectBlueprint } from './project-blueprint-fixture.js';

let app: NestExpressApplication;
let baseUrl = '';
let dataDir = '';
let cookie = '';
let csrf = '';
let projectId = '';

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await response.json() : await response.arrayBuffer();
  return { response, body: body as any };
}

async function waitForJob(id: string) {
  let job: any;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    job = (await request(`/api/generations/${id}`)).body;
    if (['completed', 'failed'].includes(job.status)) return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return job;
}

/** 等改稿任务到终态。执行是异步的,受理返回时它还在排队。 */
async function waitForRevisionTask(jobId: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const revision = (await request(`/api/generations/${jobId}`)).body.activeRevision;
    if (revision && ['completed', 'failed'].includes(revision.status)) return revision;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('改稿任务没有在超时前到达终态');
}

function assertVersionCapabilityAudit(formulaRow: any): void {
  assert.equal(formulaRow.auditScope.kind, 'version-default-capabilities');
  assert.equal(formulaRow.auditScope.formulaVersionId, formulaRow.id);
  assert.equal(formulaRow.auditScope.formulaVersionDigest, formulaRow.digest);
  assert.equal(formulaRow.auditScope.enabledFormulaMode, 'all-formulas-in-version');
  assert.equal(formulaRow.auditScope.recordsSingleGenerationRun, false);
  assert.match(String(formulaRow.auditScope.description), /不代表某次生成任务/);
  assert.deepEqual(formulaRow.executionAudit.auditScope, formulaRow.auditScope);
  assert.ok(Array.isArray(formulaRow.executionAudit.formulaTrace));
  assert.equal(formulaRow.executionAudit.formulaTrace.length, formulaRow.formulaCount);
  const traceById = new Map(formulaRow.executionAudit.formulaTrace.map((item: any) => [item.id, item]));

  const f02 = traceById.get('F02') as any;
  assert.equal(f02.implementationStatus, 'partial');
  assert.equal(f02.controlMode, 'always-on');
  assert.deepEqual(f02.registeredHandlers.planning, []);
  assert.ok(f02.nonDispatchedStages.includes('planning'));

  const f17 = traceById.get('F17') as any;
  assert.equal(f17.implementationStatus, 'conditional');
  assert.equal(f17.executionClass, 'derived-calculator');
  assert.equal(f17.controlMode, 'fully-gated');
  assert.deepEqual(f17.registeredHandlers.calculator, ['calculator:F17']);
  assert.ok(f17.registeredDispatchStages.includes('calculation'));

  const f25 = traceById.get('F25') as any;
  assert.equal(f25.implementationStatus, 'active');
  assert.equal(f25.controlMode, 'partially-gated');
  assert.deepEqual(f25.registeredHandlers.validator, []);
  assert.ok(f25.nonDispatchedStages.includes('validation'));

  const f32 = traceById.get('F32') as any;
  assert.equal(f32.implementationStatus, 'partial');
  assert.equal(f32.executionClass, 'diagnostic-proxy');
  assert.deepEqual(f32.registeredHandlers.diagnostic, ['diagnostic:F32']);

  for (const id of ['F42', 'F43']) {
    const item = traceById.get(id) as any;
    assert.equal(item.implementationStatus, 'active', id);
    assert.equal(item.controlMode, 'always-on', id);
    assert.equal(item.disableable, false, id);
    assert.deepEqual(item.registeredHandlers.planning, [], id);
  }

  const directGenerationIds = new Set(formulaRow.executionAudit.directGenerationFormulaIds);
  for (const item of formulaRow.executionAudit.formulaTrace.filter((entry: any) => entry.implementationStatus === 'protocol-only')) {
    assert.deepEqual(item.registeredHandlers.prompt, [], item.id);
    assert.deepEqual(item.effectiveHandlers.prompt, [], item.id);
    assert.equal(item.registeredDispatchStages.includes('generation'), false, item.id);
    assert.equal(directGenerationIds.has(item.id), false, item.id);
  }
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-generation-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'integration-test-master-encryption-key',
    logger: false,
    // 显式关掉模型供应商:本用例断言离线确定性生成(hasApiKey=false、稿件可复现)。
    // 不写这行,resolveOptions 会捡起环境里的 OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN,
    // 用例就会打到真实中继并随对端状态飘红。
    platformApiKey: '',
    platformBaseUrl: 'http://127.0.0.1:1/v1',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin-bootstrap-123!' }) });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: 'Admin-bootstrap-123!', newPassword: 'Admin-updated-456!' }) });
  assert.equal(changed.response.status, 201);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('formula registry, settings and deterministic generation form one working flow', async () => {
  const project = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: '全链路测试项目',
      domain: '去眼袋',
      productPoints: ['先判断眼袋类型，再讨论方案'],
      organizationPoints: ['支持复查'],
      cities: ['成都'],
      doctors: [{ name: '示例医生', points: ['讲清适用边界'] }],
    }),
  });
  assert.equal(project.response.status, 201);
  projectId = project.body.id;

  const uploaded = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      filename: 'facts.md',
      category: 'facts',
      evidenceStatus: 'observed',
      content: '# 已知事实\n\nSUPERSEDED_KNOWLEDGE_MARKER：旧版本内容，不得进入生成。',
      metadata: { kind: 'fact', keywords: ['旧版本'] },
    }),
  });
  assert.equal(uploaded.response.status, 201);
  const currentKnowledge = await request('/api/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      filename: 'facts.md',
      category: 'facts',
      evidenceStatus: 'observed',
      content: '# 已知事实\n\nCURRENT_KNOWLEDGE_MARKER：当前项目要求先核实问题类型，并明确个体差异。',
      metadata: { kind: 'fact', keywords: ['问题类型', '个体差异'] },
    }),
  });
  assert.equal(currentKnowledge.response.status, 201);
  assert.equal(currentKnowledge.body.version, 2);
  seedApprovedProjectBlueprint(app, projectId);

  const formulaList = await request(`/api/formulas?projectId=${projectId}`);
  assert.equal(formulaList.response.status, 200, JSON.stringify(formulaList.body));
  assert.equal(formulaList.body.length, 1);
  assert.equal(formulaList.body[0].formulaCount, 43);
  assert.equal(formulaList.body[0].status, 'active');
  assertVersionCapabilityAudit(formulaList.body[0]);

  const draft = await request('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({ projectId, parentId: formulaList.body[0].id, description: '集成测试草稿' }),
  });
  assert.equal(draft.response.status, 201);
  assert.equal(draft.body.status, 'draft');
  assertVersionCapabilityAudit(draft.body);
  const activated = await request(`/api/formulas/${draft.body.id}/activate`, { method: 'POST' });
  assert.equal(activated.body.status, 'active');
  assertVersionCapabilityAudit(activated.body);
  const formulaRelease = await request(`/api/projects/${projectId}/research/releases`, {
    method: 'POST',
    body: JSON.stringify({
      version: '0.2.0-generation-test',
      formulaVersionId: activated.body.id,
      notes: '集成测试绑定新 active 公式。',
      bindings: {},
    }),
  });
  assert.equal(formulaRelease.response.status, 201, JSON.stringify(formulaRelease.body));
  const reviewedFormulaRelease = await request(`/api/projects/${projectId}/research/releases/${formulaRelease.body.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ status: 'approved' }),
  });
  assert.equal(reviewedFormulaRelease.body.status, 'approved', JSON.stringify(reviewedFormulaRelease.body));
  const activeFormulaRelease = await request(`/api/projects/${projectId}/research/releases/${formulaRelease.body.id}/activate`, { method: 'POST' });
  assert.equal(activeFormulaRelease.body.status, 'active', JSON.stringify(activeFormulaRelease.body));

  const calculationPath = (formulaId: string) => `/api/formulas/${activated.body.id}/${formulaId}/calculate`;
  const f17Computed = await request(calculationPath('F17'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        regretBefore: 9,
        regretAfter: 3,
        cognitiveCost: 1.5,
        regretBeforeUnit: 'point',
        regretAfterUnit: 'point',
        cognitiveCostUnit: 'point',
      },
    }),
  });
  assert.equal(f17Computed.response.status, 200, JSON.stringify(f17Computed.body));
  assert.equal(f17Computed.body.status, 'computed');
  assert.equal(f17Computed.body.value, 4.5);
  assert.equal(f17Computed.body.unit, 'point');
  assert.equal(f17Computed.body.formulaVersionId, activated.body.id);
  assert.equal(f17Computed.body.formulaVersionDigest, activated.body.digest);
  assert.deepEqual(f17Computed.body.issues, []);
  assert.equal(f17Computed.body.calculationOnly, true);
  assert.equal(f17Computed.body.directGeneration, false);
  assert.deepEqual(f17Computed.body.consumedBy, {
    generation: false,
    planning: false,
    candidateSelection: false,
    validation: false,
    reachPrediction: false,
  });
  assert.equal(f17Computed.body.resultSemantics, 'manual_conditional_calculation');
  assert.deepEqual(f17Computed.body.boundary, {
    explicitInputsOnly: true,
    usesLivePlatformData: false,
    predictsReach: false,
    predictsQualifiedReach: false,
    comparesHotTopicRankings: false,
  });

  const f17Missing = await request(calculationPath('F17'), {
    method: 'POST',
    body: JSON.stringify({ variables: { regretBefore: 9 } }),
  });
  assert.equal(f17Missing.response.status, 200);
  assert.equal(f17Missing.body.status, 'unknown');
  assert.equal(f17Missing.body.value, null);
  assert.ok(f17Missing.body.unknownPaths.includes('regretAfter'));
  assert.ok(f17Missing.body.issues.every((issue: any) => issue.code === 'required_input_missing'));

  const f17EmptyUnits = await request(calculationPath('F17'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        regretBefore: 9,
        regretAfter: 3,
        cognitiveCost: 1.5,
        regretBeforeUnit: '',
        regretAfterUnit: '',
        cognitiveCostUnit: '',
      },
    }),
  });
  assert.equal(f17EmptyUnits.response.status, 200);
  assert.equal(f17EmptyUnits.body.status, 'invalid');
  assert.equal(f17EmptyUnits.body.value, null);
  assert.ok(f17EmptyUnits.body.issues.some((issue: any) => issue.code === 'unit_required'));

  const f17MismatchedUnits = await request(calculationPath('F17'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        regretBefore: 9,
        regretAfter: 3,
        cognitiveCost: 1.5,
        regretBeforeUnit: 'point',
        regretAfterUnit: 'yuan',
        cognitiveCostUnit: 'point',
      },
    }),
  });
  assert.equal(f17MismatchedUnits.response.status, 200);
  assert.equal(f17MismatchedUnits.body.status, 'invalid');
  assert.ok(f17MismatchedUnits.body.issues.some((issue: any) => issue.code === 'unit_mismatch'));

  const f21Computed = await request(calculationPath('F21'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        pExposure: 0.5,
        pNoticeGivenExposure: 0.4,
        pEnterGivenNotice: 0.3,
        pConsumeGivenEnter: 0.2,
      },
    }),
  });
  assert.equal(f21Computed.response.status, 200, JSON.stringify(f21Computed.body));
  assert.equal(f21Computed.body.status, 'computed');
  assert.ok(Math.abs(f21Computed.body.value - 0.012) < 1e-12);
  assert.equal(f21Computed.body.unit, null);

  const f21Missing = await request(calculationPath('F21'), {
    method: 'POST',
    body: JSON.stringify({ variables: { pExposure: 0.5 } }),
  });
  assert.equal(f21Missing.body.status, 'unknown');
  assert.equal(f21Missing.body.value, null);
  assert.ok(f21Missing.body.unknownPaths.includes('pNoticeGivenExposure'));

  const f21OutOfRange = await request(calculationPath('F21'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        pExposure: 1.2,
        pNoticeGivenExposure: 0.4,
        pEnterGivenNotice: 0.3,
        pConsumeGivenEnter: 0.2,
      },
    }),
  });
  assert.equal(f21OutOfRange.response.status, 200);
  assert.equal(f21OutOfRange.body.status, 'invalid');
  assert.equal(f21OutOfRange.body.value, null);
  assert.ok(f21OutOfRange.body.issues.some((issue: any) => issue.path === 'pExposure' && issue.code === 'out_of_range'));

  const f30Definition = activated.body.formulas.find((formula: any) => formula.id === 'F30');
  assert.ok(f30Definition);
  assert.deepEqual(
    f30Definition.variables.map((variable: any) => variable.path),
    ['trendSourceKind', 'trendSourceRef', 'sourceObservedAt', 'relevance', 'bridgeClarity', 'timeliness'],
  );
  assert.deepEqual(f30Definition.variables[0].allowedValues, [
    'xiaohongshu_hotspot_rank',
    'xiaohongshu_hot_discussion',
    'other_explicit_source',
  ]);
  assert.equal(
    f30Definition.variables.find((variable: any) => variable.path === 'trendSourceRef')?.format,
    'trend_source_ref',
  );
  assert.equal(
    f30Definition.variables.find((variable: any) => variable.path === 'sourceObservedAt')?.format,
    'rfc3339_timestamp',
  );
  for (const path of ['relevance', 'bridgeClarity', 'timeliness']) {
    const variable = f30Definition.variables.find((candidate: any) => candidate.path === path);
    assert.equal(variable.valueType, 'number', path);
    assert.equal(variable.required, true, path);
    assert.equal(variable.minimum, 0, path);
    assert.equal(variable.maximum, 1, path);
  }

  const f30Variables = {
    trendSourceKind: 'xiaohongshu_hotspot_rank',
    trendSourceRef: 'title:小红书热点榜条目示例对象',
    sourceObservedAt: '2026-07-14T00:00:00+08:00',
    relevance: 0.8,
    bridgeClarity: 0.5,
    timeliness: 0.25,
  };
  const f30Computed = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({ variables: f30Variables }),
  });
  assert.equal(f30Computed.response.status, 200, JSON.stringify(f30Computed.body));
  assert.equal(f30Computed.body.status, 'computed');
  assert.ok(Math.abs(f30Computed.body.value - 0.1) < 1e-12);
  assert.equal(f30Computed.body.unit, null);
  assert.equal(f30Computed.body.calculatorContract.outputMetric, 'TrendFit');
  assert.equal(f30Computed.body.calculatorContract.outputSemantics, 'unvalidated_scenario_index');
  assert.deepEqual(f30Computed.body.calculatorContract.outputRange, [0, 1]);
  assert.deepEqual(f30Computed.body.calculatorContract.consumedBy, {
    generation: false,
    planning: false,
    selection: false,
    validation: false,
  });
  const excludedReach = f30Computed.body.calculatorContract.excludedResearchOutputs.find(
    (output: any) => output.metric === 'qualifiedIncrementalReach',
  );
  assert.ok(excludedReach);
  assert.equal(excludedReach.status, 'not_executed');
  assert.equal(excludedReach.outputProduced, false);
  assert.equal(excludedReach.notProducedByCalculator, true);
  assert.ok(f30Computed.body.calculatorContract.boundaries.some((item: string) => item.includes('xiaohongshu_hotspot_rank')));
  assert.ok(f30Computed.body.calculatorContract.boundaries.some((item: string) => item.includes('xiaohongshu_hot_discussion')));
  assert.deepEqual(f30Computed.body.consumedBy, {
    generation: false,
    planning: false,
    candidateSelection: false,
    validation: false,
    reachPrediction: false,
  });
  assert.equal(f30Computed.body.boundary.predictsReach, false);
  assert.equal(f30Computed.body.boundary.predictsQualifiedReach, false);
  assert.equal(f30Computed.body.boundary.usesLivePlatformData, false);
  assert.equal(f30Computed.body.consumedBy.reachPrediction, false);

  const hotDiscussionComputed = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        ...f30Variables,
        trendSourceKind: 'xiaohongshu_hot_discussion',
        trendSourceRef: 'https://www.xiaohongshu.com/explore/example-hot-discussion',
      },
    }),
  });
  assert.equal(hotDiscussionComputed.body.status, 'computed');
  assert.ok(Math.abs(hotDiscussionComputed.body.value - 0.1) < 1e-12);

  const f30MissingScore = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({ variables: { ...f30Variables, timeliness: undefined } }),
  });
  assert.equal(f30MissingScore.body.status, 'unknown');
  assert.equal(f30MissingScore.body.value, null);
  assert.ok(f30MissingScore.body.unknownPaths.includes('timeliness'));

  const f30MissingProvenance = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        relevance: 0.8,
        bridgeClarity: 0.5,
        timeliness: 0.25,
      },
    }),
  });
  assert.equal(f30MissingProvenance.body.status, 'unknown');
  assert.equal(f30MissingProvenance.body.value, null);
  assert.deepEqual(f30MissingProvenance.body.unknownPaths, ['sourceObservedAt', 'trendSourceKind', 'trendSourceRef']);

  for (const invalidValue of [-0.01, 1.01]) {
    const f30OutOfRange = await request(calculationPath('F30'), {
      method: 'POST',
      body: JSON.stringify({ variables: { ...f30Variables, relevance: invalidValue } }),
    });
    assert.equal(f30OutOfRange.body.status, 'invalid');
    assert.equal(f30OutOfRange.body.value, null);
    assert.ok(f30OutOfRange.body.issues.some(
      (issue: any) => issue.path === 'relevance' && issue.code === 'out_of_range',
    ));
  }

  const f30InvalidSource = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({ variables: { ...f30Variables, trendSourceKind: 'hot_tag' } }),
  });
  assert.equal(f30InvalidSource.body.status, 'invalid');
  assert.equal(f30InvalidSource.body.value, null);
  assert.ok(f30InvalidSource.body.issues.some(
    (issue: any) => issue.path === 'trendSourceKind'
      && issue.code === 'invalid_value'
      && issue.message.includes('must be one of'),
  ));

  for (const path of ['trendSourceRef', 'sourceObservedAt']) {
    const f30BlankSource = await request(calculationPath('F30'), {
      method: 'POST',
      body: JSON.stringify({ variables: { ...f30Variables, [path]: '   ' } }),
    });
    assert.equal(f30BlankSource.body.status, 'invalid', path);
    assert.equal(f30BlankSource.body.value, null, path);
    assert.ok(f30BlankSource.body.issues.some(
      (issue: any) => issue.path === path
        && issue.code === 'empty_value'
        && issue.message.includes('must be a non-empty string'),
    ));
  }

  const f30FormatFailures = [
    {
      path: 'trendSourceRef',
      value: '#眼袋',
      code: 'source_ref_hashtag_only',
    },
    {
      path: 'trendSourceRef',
      value: '热点',
      code: 'source_ref_not_specific',
    },
    {
      path: 'sourceObservedAt',
      value: '2026-07-14 00:00:00',
      code: 'observed_at_invalid_format',
    },
    {
      path: 'sourceObservedAt',
      value: '2026-02-30T00:00:00+08:00',
      code: 'observed_at_invalid_value',
    },
  ];
  for (const failure of f30FormatFailures) {
    const rejected = await request(calculationPath('F30'), {
      method: 'POST',
      body: JSON.stringify({ variables: { ...f30Variables, [failure.path]: failure.value } }),
    });
    assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.status, 'invalid', failure.code);
    assert.equal(rejected.body.value, null, failure.code);
    const issue = rejected.body.issues.find(
      (candidate: any) => candidate.path === failure.path && candidate.code === failure.code,
    );
    assert.ok(issue, `${failure.code}: ${JSON.stringify(rejected.body)}`);
    assert.ok(issue.message.includes(`[${failure.code}]`));
    assert.match(issue.message, /does not verify/u);
    assert.equal(rejected.body.boundary.usesLivePlatformData, false);
    assert.equal(rejected.body.boundary.predictsReach, false);
  }

  const f30ExtraVariable = await request(calculationPath('F30'), {
    method: 'POST',
    body: JSON.stringify({ variables: { ...f30Variables, predictedReach: 0.9 } }),
  });
  assert.equal(f30ExtraVariable.body.status, 'invalid');
  assert.equal(f30ExtraVariable.body.value, null);
  assert.ok(f30ExtraVariable.body.issues.some(
    (issue: any) => issue.path === 'predictedReach' && issue.code === 'unknown_variable',
  ));

  const directFormulaRejected = await request(calculationPath('F01'), {
    method: 'POST',
    body: JSON.stringify({ variables: {} }),
  });
  assert.equal(directFormulaRejected.response.status, 400);
  assert.equal(directFormulaRejected.body.code, 'FORMULA_CALCULATOR_NOT_AVAILABLE');

  const changedF21 = activated.body.formulas.map((formula: any) => formula.id === 'F21'
    ? { ...formula, title: `${formula.title} (unreviewed change)` }
    : formula);
  const unreviewedVersion = await request('/api/formulas', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      parentId: activated.body.id,
      description: 'calculator semantic compatibility test',
      formulas: changedF21,
    }),
  });
  assert.equal(unreviewedVersion.response.status, 201, JSON.stringify(unreviewedVersion.body));
  const unreviewedCalculatorRejected = await request(`/api/formulas/${unreviewedVersion.body.id}/F21/calculate`, {
    method: 'POST',
    body: JSON.stringify({
      variables: {
        pExposure: 0.5,
        pNoticeGivenExposure: 0.4,
        pEnterGivenNotice: 0.3,
        pConsumeGivenEnter: 0.2,
      },
    }),
  });
  assert.equal(unreviewedCalculatorRejected.response.status, 400);
  assert.equal(unreviewedCalculatorRejected.body.code, 'FORMULA_CALCULATOR_NOT_AVAILABLE');
  assert.equal(unreviewedCalculatorRejected.body.compatibilityStatus, 'pending_review');

  const settings = await request('/api/settings');
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.providerMode, 'platform');
  const settingsUpdate = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ model: 'test-model', monthlyQuota: 25, defaultTemperature: 0.3 }),
  });
  assert.equal(settingsUpdate.response.status, 200);
  assert.equal(settingsUpdate.body.monthlyQuota, 25);
  assert.equal(settingsUpdate.body.hasApiKey, false);

  const created = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      mode: 'simple',
      topic: '做去眼袋功课时应该先问什么',
      goal: '补全选择信息',
      audienceStage: '收集期',
      entryPoint: '搜索',
      city: '成都',
      mustInclude: '先判断问题类型',
      forbidden: '百分百保证',
      preContactKnown: ['already knows the basic distinction', ' already knows the basic distinction '],
      readerHistory: ['searched recovery timing'],
      readerConstraints: ['needs to return to work within two weeks'],
      seed: 12345,
    }),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const jobId = created.body.id as string;

  const job = await waitForJob(jobId);
  assert.equal(job.status, 'completed', job.error);
  assert.equal(job.qualityStatus, 'passed');
  assert.equal(job.progress, 100);
  assert.equal(job.candidates.length, 3);
  assert.equal(job.imageContextKind, 'none');
  assert.deepEqual(job.sourceImageAssets, []);
  assert.ok(job.candidates.every((item: any) => item.imageBriefKind === 'generation_brief'));
  assert.deepEqual(job.resolvedConfig.task.preContactKnown, ['already knows the basic distinction']);
  assert.deepEqual(job.resolvedConfig.task.readerHistory, ['searched recovery timing']);
  assert.deepEqual(job.resolvedConfig.task.readerConstraints, ['needs to return to work within two weeks']);
  const generationConsumerState = JSON.stringify({
    formulaVariables: job.resolvedConfig.formula.variables,
    task: job.resolvedConfig.task,
    informationWindow: job.resolvedConfig.informationWindow,
    expressionWindow: job.resolvedConfig.expressionWindow,
    planningContext: job.planningContext,
    orchestrationSnapshots: job.candidates.map((item: any) => item.orchestrationSnapshot),
  });
  assert.equal(generationConsumerState.includes('title:小红书热点榜条目示例对象'), false);
  assert.equal(generationConsumerState.includes('trendSourceKind'), false);
  assert.equal(generationConsumerState.includes('TrendFit'), false);
  assert.equal(generationConsumerState.includes('qualifiedIncrementalReach'), false);
  assert.ok(job.candidates.every((item: any) => item.orchestrationSnapshot?.stateSeed?.preContactKnown?.includes('already knows the basic distinction')));
  const projectFacts = [...job.resolvedConfig.project.productPoints, ...job.resolvedConfig.project.organizationPoints];
  assert.ok(job.candidates.every((item: any) => projectFacts.every((fact: string) => !item.orchestrationSnapshot?.stateSeed?.preContactKnown?.includes(fact))));
  assert.ok(job.candidates.every((item: any) => projectFacts.some((fact: string) => item.orchestrationSnapshot?.stateSeed?.availableEvidence?.includes(fact))));
  assert.ok(job.candidates.every((item: any) => item.orchestrationSnapshot?.stateSeed?.history?.status === 'provided'));
  assert.equal(new Set(job.candidates.map((item: any) => item.id)).size, 3);
  assert.ok(job.candidates.every((item: any) => item.validation?.valid === true), JSON.stringify(job.candidates.map((item: any) => item.validation)));
  assert.equal(job.knowledgeContext.mode, 'full');
  assert.ok(job.knowledgeContext.selectedDocumentIds.includes(currentKnowledge.body.id));
  assert.equal(job.knowledgeContext.selectedDocumentIds.includes(uploaded.body.id), false);
  const staleKnowledgeSelection = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      mode: 'simple',
      topic: '历史知识版本不应进入生成',
      audienceStage: '收集期',
      entryPoint: '搜索',
      knowledgeScope: 'selected',
      selectedFileIds: [uploaded.body.id],
    }),
  });
  assert.equal(staleKnowledgeSelection.response.status, 400, JSON.stringify(staleKnowledgeSelection.body));
  assert.equal(staleKnowledgeSelection.body.code, 'KNOWLEDGE_VERSION_STALE');
  assert.ok(job.candidates.every((item: any) => item.comments.length >= 3));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.simulated === true)));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.personaRole && comment.speakerType === 'simulated_reader' && comment.claimStatus)));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.roleCard?.decisionTask && comment.primaryGapId && comment.densityProxy?.primaryGapCount === 1)));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.replyPlan?.directAnswer && comment.replyPlan?.nextQuestion)));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.discoveryPlan?.cue && comment.discoveryPlan?.revealTiming === 'same_thread' && ['low', 'moderate'].includes(comment.discoveryPlan?.difficulty))));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => comment.surfaceRoleCard?.displayRole
    && comment.surfaceRoleCard?.speechPattern && !/DirectAnswer|本线程/u.test(`${comment.question}${comment.answer}`))));
  assert.ok(job.candidates.every((item: any) => new Set(item.comments.map((comment: any) => comment.surfaceRoleCard?.displayRole)).size >= 3));
  assert.ok(job.candidates.every((item: any) => item.gapCoverageLedger?.closureRate === 1 && item.gapCoverageLedger?.uncoveredGapIds?.length === 0));
  assert.ok(job.candidates.every((item: any) => item.effectiveThreadCount === item.comments.length));
  assert.ok(job.candidates.every((item: any) => item.comments.every((comment: any) => ['publisher', 'brand', 'staff', 'expert'].includes(comment.postingIdentity))));
  assert.ok(job.candidates.every((candidate: any) => candidate.sources.every((source: any) => candidate.reasoning.some((entry: any) =>
    entry.status === 'fact' && entry.sourceSpans?.some((span: any) => span.evidenceId === source.id),
  ))), 'selected context must not be presented as a cited source without an exact visible claim span');
  assert.equal(job.diagnosticProxies.length, 2);
  assert.equal(job.parameterImpactReport.diagnosticProxies.length, 2);
  for (const proxy of job.diagnosticProxies) {
    assert.ok(['F32', 'F33'].includes(proxy.formulaId));
    assert.equal(proxy.semantics, 'ordered_component_review_metadata');
    assert.equal(proxy.status, 'unknown');
    assert.equal(proxy.evaluationStatus, 'not_evaluated');
    assert.equal(proxy.aggregateValue, null);
    assert.equal(proxy.scoreProduced, false);
    assert.equal(proxy.evidenceStatus, 'unvalidated_proxy');
    assert.equal(proxy.aggregation, 'components_only');
    assert.equal(proxy.components.length, 10);
  }
  for (const candidate of job.candidates) {
    assert.deepEqual(candidate.validationHeuristic, {
      schemaVersion: '1.0',
      kind: 'validation_issue_count_heuristic',
      semantics: 'non_quality_score',
      status: 'computed',
      value: candidate.score,
      range: [0, 100],
      inputs: { errorCount: 0, warningCount: candidate.validation.issues.filter((item: any) => item.severity === 'warning').length, errorPenalty: 25, warningPenalty: 5 },
      evidenceStatus: 'operational_heuristic',
      calibrated: false,
      predicts: { quality: false, effect: false },
      excludes: { formulaIds: ['F32', 'F33'], diagnosticProxies: true, emphasis: true, missingValues: true },
      consumedBy: { generation: false, planning: false, selection: false, validation: false },
    });
    const formulaDiagnostics = candidate.diagnostics.filter((item: any) => ['F32', 'F33'].includes(item.formulaId));
    assert.equal(formulaDiagnostics.length, 2);
    assert.ok(formulaDiagnostics.every((item: any) => item.status === 'unknown'));
    assert.ok(formulaDiagnostics.every((item: any) => item.scoreProduced === false && item.score === undefined));
    assert.ok(formulaDiagnostics.every((item: any) => item.components.length === 10));
  }

  const beforeSecond = JSON.stringify(job.candidates[1]);
  const revised = await request(`/api/generations/${jobId}/revise`, {
    method: 'POST',
    body: JSON.stringify({ candidateId: job.candidates[0].id, instruction: '正文更克制，保留标题并复查评论区' }),
  });
  // revise 已改为入队即返回:受理时模型还没跑,所以这个响应体断言的是「受理成功且
  // 有活跃修改任务」。改后内容(revisions.length===1)要等执行落地,见下面的等待。
  assert.equal(revised.response.status, 201);
  assert.ok(revised.body.activeRevision, '受理后投影里要有 activeRevision');
  assert.equal(revised.body.activeRevision.status, 'queued');
  assert.equal(revised.body.activeRevision.candidateId, job.candidates[0].id);
  // job 在改稿期间必须保持 completed,候选仍是旧版本(用户还能看自己的稿子)
  assert.equal(revised.body.status, 'completed');
  assert.equal(revised.body.candidates.length, 3);
  assert.equal(JSON.stringify(revised.body.candidates[1]), beforeSecond);
  assert.equal(revised.body.candidates[0].title, job.candidates[0].title);
  assert.equal(revised.body.candidates[0].revisions.length, 0, '受理这一刻还没有改稿记录');

  // 等执行落地,再断言改后内容:一条改稿记录、其它候选一个字节没动。
  const settledRevision = await waitForRevisionTask(jobId);
  assert.equal(settledRevision.status, 'completed', `改稿失败：${settledRevision.error}`);
  const afterRevision = await request(`/api/generations/${jobId}`);
  assert.equal(afterRevision.body.status, 'completed');
  assert.equal(afterRevision.body.candidates.length, 3);
  assert.equal(JSON.stringify(afterRevision.body.candidates[1]), beforeSecond, '别的候选不该被改稿动到');
  const revisedCandidate = afterRevision.body.candidates.find((item: any) => item.packageId === settledRevision.resultPackageId);
  assert.ok(revisedCandidate, '结果包应出现在候选里');
  assert.equal(revisedCandidate.revisions.length, 1);
  assert.equal(revisedCandidate.validation?.valid, true, JSON.stringify(revisedCandidate.validation));

  const exportCandidateId = job.candidates[1].id;
  const markdown = await request(`/api/generations/${jobId}/candidates/${encodeURIComponent(exportCandidateId)}/export?format=markdown`);
  assert.equal(markdown.response.status, 200);
  // Generated packages are schemaVersion 1.1, so the export uses the two-part
  // executive + audit appendix layout; thread metadata lives in the appendix.
  assert.match(Buffer.from(markdown.body).toString('utf8'), /# 审计附录（非发布素材）/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /评论线程完整元数据/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /模拟情景，非真实评论/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /发现式路径/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /信息闭合台账/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /F32\/F33 分项审查元数据（非质量分）/u);
  assert.match(Buffer.from(markdown.body).toString('utf8'), /是否产生分数：否/u);
  const exportedJson = await request(`/api/generations/${jobId}/candidates/${encodeURIComponent(exportCandidateId)}/export?format=json`);
  assert.equal(exportedJson.response.status, 200);
  const exportedDiagnostics = exportedJson.body.diagnostics.filter((item: any) => ['F32', 'F33'].includes(item.formulaId));
  assert.equal(exportedDiagnostics.length, 2);
  assert.ok(exportedDiagnostics.every((item: any) => item.semantics === 'ordered_component_review_metadata'));
  assert.ok(exportedDiagnostics.every((item: any) => item.aggregateValue === null && item.scoreProduced === false));
  const docx = await request(`/api/generations/${jobId}/candidates/${encodeURIComponent(exportCandidateId)}/export?format=docx`);
  assert.equal(docx.response.status, 200);
  assert.equal(Buffer.from(docx.body).subarray(0, 2).toString('ascii'), 'PK');

  const databaseForHistoricalDiagnostic = app.get(DatabaseService);
  const historicalRow = databaseForHistoricalDiagnostic.prepare(
    'SELECT id, content_json FROM content_packages WHERE job_id=? ORDER BY candidate_index LIMIT 1',
  ).get(jobId) as { id: string; content_json: string };
  const historicalContent = JSON.parse(historicalRow.content_json);
  const historicalF32 = historicalContent.diagnostics.find((item: any) => item.formulaId === 'F32');
  delete historicalF32.formulaSemanticFingerprint;
  delete historicalF32.semantics;
  delete historicalF32.evaluationStatus;
  delete historicalF32.aggregateValue;
  delete historicalF32.scoreProduced;
  delete historicalF32.diagnosticContract;
  historicalF32.name = '质量93/100';
  historicalF32.explanation = '质量93/100，值得推荐';
  historicalF32.components[0].label = '质量93/100';
  historicalF32.score = 93;
  databaseForHistoricalDiagnostic.prepare('UPDATE content_packages SET content_json=? WHERE id=?')
    .run(JSON.stringify(historicalContent), historicalRow.id);
  const historicalJob = (await request(`/api/generations/${jobId}`)).body;
  const historicalDiagnostic = historicalJob.candidates[0].diagnostics.find((item: any) => item.formulaId === 'F32');
  assert.equal(historicalDiagnostic.contractStatus, 'unknown');
  assert.equal(historicalDiagnostic.name, 'F32 历史诊断');
  assert.equal(historicalDiagnostic.explanation.includes('质量93/100'), false);
  assert.equal(historicalDiagnostic.semantics, 'unknown');
  assert.equal(historicalDiagnostic.evidenceStatus, 'unknown');
  assert.equal(historicalDiagnostic.aggregateValue, null);
  assert.equal(historicalDiagnostic.scoreProduced, false);
  assert.equal(historicalDiagnostic.score, undefined);
  assert.equal(historicalDiagnostic.unknown.reason, 'historical_contract_incomplete');
  assert.equal(historicalDiagnostic.components[0].label, '历史分项 1');
  assert.equal(JSON.stringify(historicalJob.candidates[0].diagnostics).includes('质量93/100'), false);
  databaseForHistoricalDiagnostic.prepare('UPDATE content_packages SET content_json=? WHERE id=?')
    .run(historicalRow.content_json, historicalRow.id);

  const advanced = await request('/api/generations', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      mode: 'advanced',
      topic: '设置模式覆盖测试',
      goal: '验证统一配置',
      audienceStage: 'comparing',
      entryPoint: 'search',
      config: {
        bodyLength: 400,
        commentThreads: 2,
        model: '项目默认',
        repairRounds: 1,
        overrides: {
          content: { hashtagMin: 2, hashtagMax: 2, imageBriefEnabled: false },
          informationWindow: { gaps: ['自定义信息缺口'] },
        },
      },
    }),
  });
  assert.equal(advanced.response.status, 201);
  const advancedJob = await waitForJob(advanced.body.id);
  assert.equal(advancedJob.status, 'completed', advancedJob.error);
  assert.equal(advancedJob.qualityStatus, 'passed');
  assert.deepEqual(advancedJob.resolvedConfig.task.preContactKnown, []);
  assert.deepEqual(advancedJob.resolvedConfig.task.readerConstraints, []);
  assert.equal(advancedJob.resolvedConfig.task.readerHistory, undefined);
  assert.ok(advancedJob.candidates.every((item: any) => item.orchestrationSnapshot?.stateSeed?.history?.status === 'unknown'));
  assert.ok(advancedJob.candidates.every((item: any) => item.orchestrationSnapshot?.stateSeed?.preContactKnown?.length === 0));
  assert.equal(advancedJob.candidates[0].comments.length, 2);
  assert.equal(advancedJob.candidates[0].tags.length, 2);
  assert.ok(advancedJob.candidates.every((item: any) => item.imageBrief === ''));
  assert.ok(advancedJob.candidates.every((item: any) => item.productionArtifacts?.imageBrief?.status === 'disabled'));
  assert.ok(advancedJob.candidates.every((item: any) => item.imageBriefKind === 'disabled'));

  const keyValue = 'sk-test-value-that-must-not-be-stored-plainly';
  const byok = await request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      providerMode: 'byok',
      provider: 'OpenAI Compatible',
      transport: 'chat_completions',
      apiBaseUrl: 'http://127.0.0.1:9999/v1',
      model: 'local-model',
      apiKey: keyValue,
    }),
  });
  assert.equal(byok.response.status, 200);
  assert.equal(byok.body.hasApiKey, true);
  assert.equal(JSON.stringify(byok.body).includes(keyValue), false);
  const encrypted = app.get(DatabaseService).prepare('SELECT encrypted_api_key FROM workspace_settings').get() as { encrypted_api_key: string };
  assert.ok(encrypted.encrypted_api_key);
  assert.equal(encrypted.encrypted_api_key.includes(keyValue), false);

  const audit = await request('/api/audit?limit=100');
  assert.equal(audit.response.status, 200);
  assert.ok(audit.body.some((entry: any) => entry.action === 'generation.create'));
  assert.ok(audit.body.some((entry: any) => entry.action === 'settings.update'));
});

test('stored formula corruption and binding mismatches fail closed before F30 calculation', async () => {
  const database = app.get(DatabaseService);
  const f30Variables = {
    trendSourceKind: 'xiaohongshu_hotspot_rank',
    trendSourceRef: 'title:小红书热点榜条目完整性测试',
    sourceObservedAt: '2026-07-14T00:00:00+08:00',
    relevance: 0.8,
    bridgeClarity: 0.5,
    timeliness: 0.25,
  };

  const createFixture = async (name: string) => {
    const project = await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, domain: '公式完整性测试' }),
    });
    assert.equal(project.response.status, 201, JSON.stringify(project.body));
    const formulaList = await request(`/api/formulas?projectId=${project.body.id}`);
    assert.equal(formulaList.response.status, 200, JSON.stringify(formulaList.body));
    assert.equal(formulaList.body.length, 1);
    const formulaRow = database.prepare(
      'SELECT id, project_id, definition_json FROM formula_versions WHERE id=?',
    ).get(formulaList.body[0].id) as { id: string; project_id: string; definition_json: string };
    return { projectId: String(project.body.id), formulaRow };
  };

  const assertCalculationRejected = async (formulaVersionId: string, expectedIssueCode: string) => {
    const result = await request(`/api/formulas/${formulaVersionId}/F30/calculate`, {
      method: 'POST',
      body: JSON.stringify({ variables: f30Variables }),
    });
    assert.equal(result.response.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.code, 'FORMULA_VERSION_INTEGRITY_ERROR');
    assert.ok(result.body.issues.some((issue: any) => issue.code === expectedIssueCode), JSON.stringify(result.body));
    assert.equal(result.body.formulaId, undefined);
    assert.equal(result.body.value, undefined);
    assert.equal(result.body.calculatorContract, undefined);
  };

  const corrupt = await createFixture('损坏公式 JSON');
  database.prepare('UPDATE formula_versions SET definition_json=? WHERE id=?').run('{', corrupt.formulaRow.id);
  const corruptList = await request(`/api/formulas?projectId=${corrupt.projectId}`);
  assert.equal(corruptList.response.status, 400, JSON.stringify(corruptList.body));
  assert.equal(corruptList.body.code, 'FORMULA_VERSION_INTEGRITY_ERROR');
  assert.ok(corruptList.body.issues.some((issue: any) => issue.code === 'invalid_json'));
  assert.equal(
    (database.prepare('SELECT COUNT(*) AS value FROM formula_versions WHERE project_id=?').get(corrupt.projectId) as { value: number }).value,
    1,
  );
  await assertCalculationRejected(corrupt.formulaRow.id, 'invalid_json');

  const digestFixture = await createFixture('摘要篡改公式');
  const digestStored = JSON.parse(digestFixture.formulaRow.definition_json);
  digestStored.version.digest = '0'.repeat(64);
  database.prepare('UPDATE formula_versions SET definition_json=? WHERE id=?')
    .run(JSON.stringify(digestStored), digestFixture.formulaRow.id);
  await assertCalculationRejected(digestFixture.formulaRow.id, 'digest_mismatch');

  const idFixture = await createFixture('行 ID 错绑公式');
  const idStored = JSON.parse(idFixture.formulaRow.definition_json);
  const { digest: _idDigest, ...idUnsigned } = idStored.version;
  idStored.version = createFormulaVersion({ ...idUnsigned, id: randomUUID() });
  database.prepare('UPDATE formula_versions SET definition_json=? WHERE id=?')
    .run(JSON.stringify(idStored), idFixture.formulaRow.id);
  await assertCalculationRejected(idFixture.formulaRow.id, 'row_id_mismatch');

  const projectFixture = await createFixture('项目错绑公式');
  const otherProject = await request('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: '错误绑定目标项目', domain: '公式完整性测试' }),
  });
  assert.equal(otherProject.response.status, 201, JSON.stringify(otherProject.body));
  const projectStored = JSON.parse(projectFixture.formulaRow.definition_json);
  const { digest: _projectDigest, ...projectUnsigned } = projectStored.version;
  projectStored.version = createFormulaVersion({ ...projectUnsigned, projectId: String(otherProject.body.id) });
  database.prepare('UPDATE formula_versions SET definition_json=? WHERE id=?')
    .run(JSON.stringify(projectStored), projectFixture.formulaRow.id);
  await assertCalculationRejected(projectFixture.formulaRow.id, 'project_binding_mismatch');
});
