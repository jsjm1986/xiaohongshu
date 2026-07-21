import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
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

async function call(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('cookie', cookie);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('x-csrf-token', csrf);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* assertions preserve text */ }
  return { response, body };
}

const post = (path: string, body: Record<string, unknown> = {}) => call(path, {
  method: 'POST',
  body: JSON.stringify(body),
});

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'content-agent-research-'));
  app = await createApplication({
    dataDir,
    adminUsername: 'admin',
    adminPassword: 'Admin-bootstrap-123!',
    masterEncryptionKey: 'research-test-master-encryption-key',
    logger: false,
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  const login = await post('/api/auth/login', { username: 'admin', password: 'Admin-bootstrap-123!' });
  cookie = login.response.headers.get('set-cookie')!.split(';', 1)[0]!;
  csrf = login.body.csrfToken;
  const changed = await post('/api/auth/change-password', {
    currentPassword: 'Admin-bootstrap-123!',
    newPassword: 'Admin-updated-456!',
  });
  assert.equal(changed.response.status, 201);
  const project = await post('/api/projects', { name: '研究治理测试', domain: '眼袋' });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  projectId = project.body.id;
  seedApprovedProjectBlueprint(app, projectId);
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('catalog and sample data are imported with explicit non-causal boundaries', async () => {
  const overview = await call(`/api/projects/${projectId}/research/overview`);
  assert.equal(overview.response.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.body.counts.claims, 45);
  assert.ok(overview.body.counts.evidenceSources >= 40);
  assert.equal(overview.body.isolationPolicy.researchInjectedIntoPrompt, false);
  assert.equal(overview.body.isolationPolicy.experimentsAutoApply, false);
  assert.equal(overview.body.isolationPolicy.runtimeChangesRequireActiveRelease, true);
  assert.equal(overview.body.activeRelease.version, '0.1.0-baseline');
  assert.equal(overview.body.catalog.version, '2026-07-21.r14-f10-runtime-contract');
  assert.equal(overview.body.activeRelease.evidenceCatalogDigest, overview.body.catalog.digest);
  assert.ok(overview.body.activeRelease.promptDigest);
  assert.ok(overview.body.activeRelease.parameterPolicyDigest);
  const f10 = overview.body.claims.find((item: any) => item.logicalKey === 'formula:F10');
  assert.ok(f10);
  assert.equal(f10.metadata.equation, 'Cref=Rollout(ρC|Role×Scene×Register×Topology×Gap)');
  assert.equal(f10.metadata.semanticFingerprint, '2dee6ad04f88f34b03ad68abe2ed081452f1f06d54d7ef6ad733b22b582b1b2d');
  assert.equal(f10.metadata.catalogDigest, overview.body.catalog.digest);
  const repeatedOverview = await call(`/api/projects/${projectId}/research/overview`);
  assert.equal(repeatedOverview.body.counts.claims, 45, '相同 catalog digest 不应重复导入');

  const sample = overview.body.datasets.find((item: any) => item.datasetKey === 'reference-copy-70');
  assert.ok(sample, 'the frozen reference-copy snapshot should be visible');
  assert.equal(sample.status, 'approved');
  assert.equal(sample.sha256.length, 64);
  assert.ok(sample.rowCount > 0);
  assert.match(sample.limitations, /不是随机样本/u);
  assert.match(sample.limitations, /不能证明平台推荐/u);
});

test('claims, evidence and experiments use reviewable versioned workflows', async () => {
  const source = await post(`/api/projects/${projectId}/research/evidence-sources`, {
    sourceKey: 'local-test-source',
    kind: 'internal_observation',
    citation: '研究治理集成测试快照',
    supports: '仅支持本测试中的工作流连通性。',
    limitations: '不支持因果、平台流量或营销效果结论。',
  });
  assert.equal(source.response.status, 201, JSON.stringify(source.body));
  assert.equal(source.body.status, 'draft');

  const claim = await post(`/api/projects/${projectId}/research/claims`, {
    logicalKey: 'test-reviewable-claim',
    title: '可复核主张',
    statement: '该主张只用于验证证据链接和审批流程。',
    claimType: 'internal_observation',
    scope: ['integration-test'],
  });
  assert.equal(claim.response.status, 201, JSON.stringify(claim.body));
  const linked = await post(`/api/projects/${projectId}/research/claims/${claim.body.id}/evidence-links`, {
    evidenceSourceId: source.body.id,
    relation: 'limits',
    strength: 'moderate',
    note: '来源限制该主张的外推范围。',
  });
  assert.equal(linked.response.status, 201);
  assert.equal((await post(`/api/projects/${projectId}/research/evidence-sources/${source.body.id}/review`, { status: 'approved' })).body.status, 'approved');
  assert.equal((await post(`/api/projects/${projectId}/research/claims/${claim.body.id}/review`, { status: 'approved' })).body.status, 'approved');

  const experiment = await post(`/api/projects/${projectId}/research/experiments`, {
    experimentKey: 'comment-completeness-test',
    title: '评论区完整度实验',
    hypothesis: '在固定任务下，完整度检查可减少未覆盖缺口。',
    design: { arms: ['control', 'coverage-check'], assignment: 'fixed-seed-pairs' },
    metrics: ['uncovered_gap_count'],
    analysisPlan: { primaryMetric: 'uncovered_gap_count', stoppingRule: 'fixed-n' },
  });
  assert.equal(experiment.response.status, 201);
  const premature = await post(`/api/projects/${projectId}/research/experiments/${experiment.body.id}/results`, {
    result: { uncovered_gap_count: 0 },
  });
  assert.equal(premature.response.status, 400);
  assert.equal((await post(`/api/projects/${projectId}/research/experiments/${experiment.body.id}/transition`, { status: 'preregistered' })).body.status, 'preregistered');
  assert.equal((await post(`/api/projects/${projectId}/research/experiments/${experiment.body.id}/transition`, { status: 'running' })).body.status, 'running');
  const result = await post(`/api/projects/${projectId}/research/experiments/${experiment.body.id}/results`, {
    result: { uncovered_gap_count: { control: 2, coverage_check: 0 }, n: 12 },
    conclusion: 'supports',
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  assert.equal((await post(`/api/projects/${projectId}/research/experiment-results/${result.body.id}/review`, { status: 'approved' })).body.status, 'approved');
  assert.equal((await post(`/api/projects/${projectId}/research/experiments/${experiment.body.id}/transition`, { status: 'completed' })).body.status, 'completed');
});

test('only an approved calibration in an active release changes runtime defaults', async () => {
  const calibration = await post(`/api/projects/${projectId}/research/calibrations`, {
    targetType: 'parameter',
    targetKey: 'comment_expansion',
    current: { value: 70 },
    proposed: { value: 62 },
    rationale: '验证发布清单对运行时参数的受控覆盖。',
    evidence: { kind: 'integration-test', doesNotEstablishEffect: true },
    impact: { expected: '评论区展开力度降低；不代表效果提升。' },
  });
  assert.equal(calibration.response.status, 201, JSON.stringify(calibration.body));
  assert.equal((await post(`/api/projects/${projectId}/research/calibrations/${calibration.body.id}/review`, { status: 'approved' })).body.status, 'approved');

  const overview = (await call(`/api/projects/${projectId}/research/overview`)).body;
  const approvedResult = overview.experiments.flatMap((item: any) => item.results ?? []).find((item: any) => item.status === 'approved');
  const approvedDataset = overview.datasets.find((item: any) => item.status === 'approved');
  assert.ok(approvedResult);
  assert.ok(approvedDataset);

  const release = await post(`/api/projects/${projectId}/research/releases`, {
    version: '0.2.0-test',
    notes: '集成测试发布：绑定冻结数据、实验结果和参数校准。',
    bindings: {
      datasetSnapshotIds: [approvedDataset.id],
      experimentResultIds: [approvedResult.id],
      calibrationProposalIds: [calibration.body.id],
    },
  });
  assert.equal(release.response.status, 201, JSON.stringify(release.body));
  assert.equal((await post(`/api/projects/${projectId}/research/releases/${release.body.id}/review`, { status: 'approved' })).body.status, 'approved');
  const activated = await post(`/api/projects/${projectId}/research/releases/${release.body.id}/activate`);
  assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
  assert.equal(activated.body.status, 'active');

  const generation = await post('/api/generations', {
    projectId,
    mode: 'simple',
    topic: '做眼袋功课时先确认什么',
    goal: '补全判断信息',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(generation.body.releaseManifestId, release.body.id);
  assert.equal(generation.body.researchSnapshot.researchInjectedIntoPrompt, false);
  assert.equal(generation.body.resolvedConfig.parameters.commentExpansion, 62);

  const stored = app.get(DatabaseService).prepare(
    'SELECT release_manifest_id, research_snapshot_json FROM generation_jobs WHERE id=?',
  ).get(generation.body.id) as { release_manifest_id: string; research_snapshot_json: string };
  assert.equal(stored.release_manifest_id, release.body.id);
  assert.equal(JSON.parse(stored.research_snapshot_json).version, '0.2.0-test');

  const manualOverride = await post('/api/generations', {
    projectId,
    mode: 'simple',
    topic: '恢复期信息怎么查',
    audienceStage: '收集期',
    entryPoint: '搜索',
    parameterValues: { comment_expansion: 75 },
  });
  assert.equal(manualOverride.response.status, 201, JSON.stringify(manualOverride.body));
  assert.equal(manualOverride.body.resolvedConfig.parameters.commentExpansion, 75);
});


test('formula activation invalidates the old release and formal generation locks to the replacement release formula', async () => {
  const formulas = await call(`/api/formulas?projectId=${projectId}`);
  const active = formulas.body.find((item: any) => item.status === 'active');
  assert.ok(active);
  const draft = await post('/api/formulas', {
    projectId,
    parentId: active.id,
    description: 'release invalidation integration test',
  });
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  const activated = await post(`/api/formulas/${draft.body.id}/activate`);
  assert.equal(activated.response.status, 201, JSON.stringify(activated.body));
  assert.equal(activated.body.status, 'active');

  const blockedWithoutRelease = await post('/api/generations', {
    projectId,
    mode: 'simple',
    topic: '公式切换后必须先激活新发布清单',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(blockedWithoutRelease.response.status, 400, JSON.stringify(blockedWithoutRelease.body));
  assert.equal(blockedWithoutRelease.body.code, 'ACTIVE_RELEASE_REQUIRED');

  const replacement = await post(`/api/projects/${projectId}/research/releases`, {
    version: '0.3.0-formula-lock',
    formulaVersionId: activated.body.id,
    notes: '绑定新 active 公式，恢复正式生成。',
    bindings: {},
  });
  assert.equal(replacement.response.status, 201, JSON.stringify(replacement.body));
  const approved = await post(`/api/projects/${projectId}/research/releases/${replacement.body.id}/review`, { status: 'approved' });
  assert.equal(approved.body.status, 'approved', JSON.stringify(approved.body));
  const replacementActive = await post(`/api/projects/${projectId}/research/releases/${replacement.body.id}/activate`);
  assert.equal(replacementActive.body.status, 'active', JSON.stringify(replacementActive.body));

  const conflictingDraft = await post('/api/formulas', {
    projectId,
    parentId: activated.body.id,
    description: 'must remain preview-only',
  });
  assert.equal(conflictingDraft.response.status, 201, JSON.stringify(conflictingDraft.body));
  const conflict = await post('/api/generations', {
    projectId,
    formulaVersion: conflictingDraft.body.id,
    mode: 'simple',
    topic: '不得绕过发布清单指定草稿公式',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(conflict.response.status, 400, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, 'RELEASE_FORMULA_CONFLICT');

  const generation = await post('/api/generations', {
    projectId,
    mode: 'simple',
    topic: '新发布清单恢复生成',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(generation.response.status, 201, JSON.stringify(generation.body));
  assert.equal(generation.body.releaseManifestId, replacement.body.id);
  assert.equal(generation.body.formulaVersion, activated.body.id);
});