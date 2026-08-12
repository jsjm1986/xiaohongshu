import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORMULA_EXECUTION_POLICY_DIGEST,
  FORMULA_EXECUTION_POLICY_VERSION,
  PROMPT_CONTRACT_DIGEST,
} from '@content-agent/agent-core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { DatabaseService } from '../src/database.service.js';
import { ResearchService } from '../src/research.service.js';
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
  assert.equal(overview.body.catalog.version, '2026-08-13.policy-digest-sync');
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

test('代码合同 digest 漂移后：未绑定研究产物的基线自愈，绑定过的保持报错等人复核', async () => {
  const database = app.get(DatabaseService);
  const research = app.get(ResearchService);
  const project = await post('/api/projects', { name: '合同漂移自愈', domain: '眼袋' });
  assert.equal(project.response.status, 201, JSON.stringify(project.body));
  const healProjectId = project.body.id;
  seedApprovedProjectBlueprint(app, healProjectId);

  const activeRow = () => database.prepare(
    "SELECT * FROM release_manifests WHERE project_id=? AND status='active'",
  ).get(healProjectId) as { id: string; version: string; prompt_digest: string; bindings_json: string } | undefined;

  // 基线由 bootstrap 建好，digest 与当前运行时一致
  const baseline = activeRow();
  assert.ok(baseline, '项目创建后应有 active 基线');
  assert.equal(baseline!.prompt_digest, PROMPT_CONTRACT_DIGEST);

  // 模拟发版后 prompt 合同 digest 漂移（改 prompt.ts 就会这样）
  database.prepare("UPDATE release_manifests SET prompt_digest='stale-digest-from-older-build' WHERE id=?")
    .run(baseline!.id);

  // 关键行为：generation.service 每次建任务都先 bootstrapProject 再取 active 快照，
  // 所以 bindings 为空的漂移会就地自愈，生成不该被挡。这正是修复的目的——原先这里
  // 会 400「发布清单绑定的运行合同已经过期」，而 SaaS 用户进不了 /research，无路可走。
  const recoveredInline = await post('/api/generations', {
    projectId: healProjectId,
    mode: 'simple',
    topic: '合同漂移应就地自愈而不是把人挡死',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(recoveredInline.response.status, 201, JSON.stringify(recoveredInline.body));

  // bindings 为空 → 只钉代码合同，没有人做过的研究决定，按当前运行时重建不丢信息
  research.bootstrapProject(healProjectId, 'admin');
  const healed = activeRow();
  assert.ok(healed);
  assert.notEqual(healed!.id, baseline!.id, '应换成新的 active manifest');
  assert.equal(healed!.prompt_digest, PROMPT_CONTRACT_DIGEST);
  assert.equal(JSON.parse(healed!.bindings_json).source, 'baseline-heal');
  // 旧的那条转 archived，保留审计痕迹而不是删掉
  const superseded = database.prepare('SELECT status FROM release_manifests WHERE id=?')
    .get(baseline!.id) as { status: string };
  assert.equal(superseded.status, 'archived');
  // release_manifests_active_idx 是 (project_id) WHERE status='active' 唯一索引
  const activeCount = database.prepare(
    "SELECT COUNT(*) AS c FROM release_manifests WHERE project_id=? AND status='active'",
  ).get(healProjectId) as { c: number };
  assert.equal(activeCount.c, 1);

  // 自愈后生成恢复
  const recovered = await post('/api/generations', {
    projectId: healProjectId,
    mode: 'simple',
    topic: '自愈后恢复生成',
    audienceStage: '收集期',
    entryPoint: '搜索',
  });
  assert.equal(recovered.response.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.body.releaseManifestId, healed!.id);

  // 绑过研究产物的发布：漂移后不许自动重建，必须留给人复核
  const dataset = database.prepare(
    "SELECT id FROM dataset_snapshots WHERE project_id=? LIMIT 1",
  ).get(healProjectId) as { id: string } | undefined;
  assert.ok(dataset, 'bootstrap 应导入参考数据快照');
  database.prepare('UPDATE release_manifests SET bindings_json=?, prompt_digest=? WHERE id=?').run(
    JSON.stringify({ datasetSnapshotIds: [dataset!.id], experimentResultIds: [], calibrationProposalIds: [] }),
    'stale-digest-again',
    healed!.id,
  );
  research.bootstrapProject(healProjectId, 'admin');
  const untouched = activeRow();
  assert.equal(untouched!.id, healed!.id, '绑过研究产物的发布不得被自动替换');
  assert.equal(untouched!.prompt_digest, 'stale-digest-again');
});

test('experiment result review rechecks project ownership at the final write boundary', async () => {
  const database = app.get(DatabaseService);
  const research = app.get(ResearchService);
  const targetProject = await post('/api/projects', { name: '审批竞态目标项目' });
  const externalProject = await post('/api/projects', { name: '审批竞态外部项目' });
  assert.equal(targetProject.response.status, 201, JSON.stringify(targetProject.body));
  assert.equal(externalProject.response.status, 201, JSON.stringify(externalProject.body));

  const createExperiment = async (ownerProjectId: string, experimentKey: string) => post(
    '/api/projects/' + ownerProjectId + '/research/experiments',
    {
      experimentKey,
      title: '审批归属竞态实验',
      hypothesis: '审批写入前必须重新确认结果仍属于请求项目。',
      design: { arms: ['control', 'candidate'], assignment: 'fixed' },
      metrics: ['review_boundary'],
      analysisPlan: { primaryMetric: 'review_boundary', stoppingRule: 'fixed-n' },
    },
  );
  const targetExperiment = await createExperiment(targetProject.body.id, 'review-race-target');
  const externalExperiment = await createExperiment(externalProject.body.id, 'review-race-external');
  assert.equal(targetExperiment.response.status, 201, JSON.stringify(targetExperiment.body));
  assert.equal(externalExperiment.response.status, 201, JSON.stringify(externalExperiment.body));

  for (const status of ['preregistered', 'running']) {
    const transitioned = await post(
      '/api/projects/' + targetProject.body.id + '/research/experiments/' + targetExperiment.body.id + '/transition',
      { status },
    );
    assert.equal(transitioned.response.status, 201, JSON.stringify(transitioned.body));
  }
  const result = await post(
    '/api/projects/' + targetProject.body.id + '/research/experiments/' + targetExperiment.body.id + '/results',
    { result: { review_boundary: 1 }, conclusion: 'supports' },
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.body));

  const mutableResearch = research as unknown as {
    resultRow?: (ownerProjectId: string, resultId: string) => Record<string, unknown>;
  };
  const originalResultRow = mutableResearch.resultRow!.bind(research);
  let associationChanged = false;
  mutableResearch.resultRow = (ownerProjectId, resultId) => {
    const row = originalResultRow(ownerProjectId, resultId);
    if (!associationChanged && ownerProjectId === targetProject.body.id && resultId === result.body.id) {
      associationChanged = true;
      database.prepare(
        'UPDATE experiment_results SET experiment_version_id=? WHERE id=?',
      ).run(externalExperiment.body.id, result.body.id);
    }
    return row;
  };

  const auditCount = () => Number((database.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action='research.experiment-result.review' AND entity_id=?",
  ).get(result.body.id) as { count: number }).count);
  const beforeAuditCount = auditCount();
  try {
    const reviewed = await post(
      '/api/projects/' + targetProject.body.id + '/research/experiment-results/' + result.body.id + '/review',
      { status: 'approved' },
    );
    assert.equal(reviewed.response.status, 404, JSON.stringify(reviewed.body));
  } finally {
    delete mutableResearch.resultRow;
  }

  assert.equal(associationChanged, true, 'the test must move the result after the initial ownership check');
  const stored = database.prepare(
    'SELECT status, reviewed_by, reviewed_at, experiment_version_id FROM experiment_results WHERE id=?',
  ).get(result.body.id) as {
    status: string;
    reviewed_by: string | null;
    reviewed_at: string | null;
    experiment_version_id: string;
  };
  assert.equal(
    stored.experiment_version_id,
    targetExperiment.body.id,
    'the rejected review must roll back the injected cross-project reassignment too',
  );
  assert.equal(stored.status, 'draft');
  assert.equal(stored.reviewed_by, null);
  assert.equal(stored.reviewed_at, null);
  assert.equal(auditCount(), beforeAuditCount, 'a rejected cross-project review must not be audited as successful');
});

test('公式证据目录与运行时执行策略合同同步（防审计文档静默漂移）', () => {
  // r13 报告的执行策略 digest 曾在 formula.ts 更新后漂移近一个月而无人发现——
  // catalog 是给人与外部审计读的实现状态快照,它描述的必须是正在跑的代码。
  // 服务端 validateCatalogAgainstRuntime 在启动时强校验;这里再显式断言一次,
  // 让漂移在测试报告里有一条指名道姓的失败,而不是几十个「应用启动失败」。
  const catalogPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/audit/formula-evidence-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
    executionPolicyVersion?: string;
    executionPolicyDigest?: string;
  };
  assert.equal(catalog.executionPolicyVersion, FORMULA_EXECUTION_POLICY_VERSION);
  assert.equal(catalog.executionPolicyDigest, FORMULA_EXECUTION_POLICY_DIGEST);
});
