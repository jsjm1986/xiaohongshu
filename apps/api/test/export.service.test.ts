import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_FORMULA_VERSION,
  buildParameterDiagnostics,
  compileGenerationParameters,
  createDefaultGenerationConfig,
} from '@content-agent/agent-core';
import { BadRequestException } from '@nestjs/common';
import { ExportService } from '../src/export.service.js';

const contentPackage = {
  schemaVersion: '1.0',
  id: 'package-1',
  projectId: 'project-1',
  jobId: 'job-1',
  candidateId: 'candidate-1',
  candidateIndex: 0,
  seed: 12345,
  createdAt: '2026-07-12T08:00:00.000Z',
  formulaSnapshot: { versionId: 'formula-1', digest: 'abc123', enabledFormulaIds: ['F01'] },
  configSnapshot: {},
  knowledgeSnapshot: {
    mode: 'full',
    documents: [{ id: 'doc-1', path: 'facts.md', checksum: 'def456', version: '1' }],
    sectionIds: [],
  },
  opportunitySnapshot: {
    id: 'opportunity-1',
    opportunitySelectionAudit: {
      selectedOpportunityId: 'opportunity-1',
      selectionMode: 'heuristic_ranked',
      rankStatus: 'applied',
      selectedOpportunityRank: {
        rank: 1,
        heuristic: {
          id: 'OpportunityRankHeuristicV1',
          version: '1.0.0',
          weights: { relevance: 0.22, importance: 0.2, proofability: 0.22, decisionLeverage: 0.18, novelty: 0.1, cognitiveCost: 0.08, risk: -0.18 },
          criticalMetrics: ['relevance', 'importance', 'proofability', 'decisionLeverage', 'novelty', 'cognitiveCost', 'risk'],
          weightsCalibrated: false,
          causal: false,
          notF28: true,
          scoreSemantics: 'ordinal_noncausal_heuristic',
          scoreRange: [0, 1],
        },
        components: [
          { metric: 'relevance', rawValue: 0.9, transformedValue: 0.9, transformation: 'identity', weight: 0.22, contribution: 0.198, source: { source: 'user', sourceRef: 'api:user_input' } },
        ],
        inputSources: {
          status: { source: 'user' },
          topic: { source: 'user' },
          gapIds: { source: 'user' },
          recentCoverage: { source: 'observed', sourceRef: 'coverage_records' },
          options: { source: 'default_policy' },
        },
        unknownMetrics: [],
        reviewRequired: false,
        reviewReasons: [],
        effectiveEligibility: 'eligible',
        unboundedBaseScore: 0.64,
        baseScore: 0.64,
        recentPenalty: 0.1,
        finalScore: 0.54,
        scoreSemantics: 'ordinal_noncausal_heuristic',
        recentCoverage: { status: 'provided', count: 2, similarity: 0.2, source: { source: 'observed', sourceRef: 'coverage_records' } },
        reasons: [],
      },
    },
  },
  imagePlan: {
    role: 'diagram',
    composition: 'PLAN-COMPOSITION-ONLY',
    frames: ['frame one'],
    requiredVisibleInformation: ['visible boundary'],
    forbiddenVisualClaims: [],
    sourceAssetId: 'source-image-1',
    boundaries: ['not a final image'],
  },
  productionArtifacts: {
    schemaVersion: '1.0',
    imageObservation: { status: 'approved', sourceAssetId: 'source-image-1', analysisAssetIds: ['analysis-1'], note: 'approved source observation' },
    imagePlan: { status: 'planned', sourceAssetId: 'source-image-1' },
    imageBrief: { status: 'contract_validated' },
    finalImageAsset: { status: 'absent' },
    entrySnapshot: { status: 'absent' },
    deployment: { status: 'not_deployed' },
    planToCopyAlignment: { status: 'pass', evaluated: true, reasons: ['brief follows plan'], checks: [] },
    finalAssetAlignment: { status: 'not_evaluated', evaluated: false, reasons: ['final asset absent'], checks: [] },
    entrySnapshotAlignment: { status: 'not_evaluated', evaluated: false, reasons: ['entry snapshot absent'], checks: [] },
  },
  content: {
    H: { hashtags: ['去眼袋', '#恢复记录'] },
    N: {
      imageBrief: '一张自然光下的术前咨询照片',
      title: '决定之前，我先补齐了这几个信息',
      body: '我最关心的是恢复时间、适用边界，以及哪些信息还不能确定。',
    },
    Cref: {
      disclaimer: '以下为模拟问答情景，不代表真实用户评论。',
      threads: [
        {
          id: 'thread-1',
          question: '大概多久恢复？',
          answer: '恢复因人而异，项目资料中的观察窗口约为一周。',
          postingIdentity: 'staff',
          personaRole: 'information_collector',
          speakerType: 'simulated_reader',
          claimStatus: 'bounded',
          replyTo: null,
          threadDepth: 0,
          simulated: true,
          simulationLabel: '模拟潜在读者情景',
          roleCard: { stage: 'collecting', knowledge: ['已了解基本概念'], constraints: ['待核实维度：时间与工作可见性'], decisionTask: '判断恢复安排', evidenceStance: 'verification_seeking' },
          primaryGapId: 'recovery',
          auxiliaryGapIds: ['work_visibility'],
          densityProxy: { primaryGapCount: 1, auxiliaryDimensionCount: 1, roleDimensionCount: 5, constraintCount: 1, expectedReplyComponents: 5, questionTargetChars: 22 },
          replyPlan: { directAnswer: '恢复存在个体差异', condition: '时间与工作可见性', boundary: '不能承诺统一天数', unknown: '个人恢复速度未知', nextQuestion: '需要正常见人的时间' },
          discoveryPlan: { cue: '资料只给出观察窗口', inferencePrompt: '这能直接推出每个人都一样吗', reveal: '不能，个体恢复仍需单独判断', selfCheck: '核对个人条件和资料范围', boundary: '发现答案不等于获得新证据', revealTiming: 'same_thread', difficulty: 'low' },
          followUps: [{ question: '每个人都一样吗？', answer: '不一样，需要结合个体情况。' }],
        },
      ],
    },
  },
  orchestrationSnapshot: {
    gapCoverageLedger: {
      entries: [{ gapId: 'recovery', label: '恢复安排', status: 'thread_resolved', required: true, bodyAllocated: false, commentAllocated: true, primaryThreadIds: ['thread-1'], auxiliaryThreadIds: [], reason: '同一线程给出有边界的回答' }],
      uncoveredGapIds: [], closureRate: 1, resolvedRate: 1, targetThreadCount: 1, effectiveThreadCount: 1,
    },
  },
  evidence: [
    {
      id: 'evidence-1',
      path: 'facts.md',
      section: '恢复',
      quote: '一周左右可见改善',
      kind: 'fact',
      evidenceStatus: 'user_supplied',
    },
  ],
  reasoning: [{ statement: '用户处于信息收集阶段', status: 'inference', evidenceIds: [] }],
  unknowns: [{ key: 'individual_recovery', question: '个体恢复期是多少？', reason: '资料不足', impact: 'high' }],
  conflicts: [],
  diagnostics: [{ name: '证据边界', status: 'pass', explanation: '已标记个体差异', score: 0.9 }],
  validation: { valid: true, repairAttempts: 1, issues: [] },
  revisions: [],
};

test('exports a complete package as Markdown and deterministic JSON', async () => {
  const service = new ExportService();
  const markdown = await service.exportPackage(contentPackage, 'markdown');
  const markdownText = markdown.toString('utf8');
  assert.ok(markdownText.includes(`实际图片简报（content.N.imageBrief）：${contentPackage.content.N.imageBrief}`));
  assert.match(markdownText, /规划构图：PLAN-COMPOSITION-ONLY/u);
  assert.match(markdownText, /最终图片资产状态：absent/u);
  assert.match(markdownText, /入口快照状态：absent/u);
  assert.match(markdownText, /发布部署状态：not_deployed/u);
  assert.match(markdownText, /规划→图片简报一致性：pass；是否已评估=是/u);
  assert.match(markdownText, /规划\/简报→最终图片一致性：not_evaluated；是否已评估=否/u);
  assert.match(markdownText, /上传 image_assets 仅是源素材/u);
  assert.match(markdownText, /^# 决定之前/);
  assert.match(markdownText, /#去眼袋 #恢复记录/);
  assert.match(markdownText, /大概多久恢复/);
  assert.match(markdownText, /模拟情景，非真实评论/);
  assert.match(markdownText, /潜在读者角色：information_collector/);
  assert.match(markdownText, /声明状态：bounded/);
  assert.match(markdownText, /可追责答复身份：staff/);
  assert.match(markdownText, /动态角色卡：阶段=collecting/);
  assert.match(markdownText, /信息密度代理：角色维度=5/);
  assert.match(markdownText, /隐藏答复计划：直接回答=恢复存在个体差异/);
  assert.match(markdownText, /发现式路径：线索=资料只给出观察窗口/);
  assert.match(markdownText, /同线程揭示=不能，个体恢复仍需单独判断/);
  assert.match(markdownText, /信息闭合台账/);
  assert.match(markdownText, /真正解决率：1/);
  assert.match(markdownText, /事实、推理与猜想/);
  assert.match(markdownText, /知识注入模式：full/);
  assert.match(markdownText, /机会选择与排序审计/u);
  assert.match(markdownText, /OpportunityRankHeuristicV1 \/ 1\.0\.0/u);
  assert.match(markdownText, /权重已标定：否/u);
  assert.match(markdownText, /因果模型：否/u);
  assert.match(markdownText, /notF28=true/u);
  assert.match(markdownText, /ordinal_noncausal_heuristic/u);
  assert.match(markdownText, /分项 relevance/u);
  assert.match(markdownText, /来源=user/u);

  const json = await service.exportPackage(contentPackage, 'json');
  assert.deepEqual(JSON.parse(json.toString('utf8')), contentPackage);
});

test('exports valid DOCX and PDF buffers containing document signatures', async () => {
  const service = new ExportService();
  const docx = await service.exportPackage(contentPackage, 'docx', { docxFontName: 'Noto Sans CJK SC' });
  assert.equal(docx.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(docx.byteLength > 1_000);

  const pdf = await service.exportPackage(contentPackage, 'pdf');
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(pdf.byteLength > 1_000);
});

test('preserves the exact F32/F33 component-review contract across JSON, Markdown, DOCX and PDF', async () => {
  const config = createDefaultGenerationConfig({
    id: 'diagnostic-project',
    name: '诊断合同测试',
    domain: '决策信息',
    productPoints: [],
    organizationPoints: [],
    cities: [],
    doctors: [],
  }, DEFAULT_FORMULA_VERSION);
  const impactReport = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION).impactReport;
  const diagnostics = buildParameterDiagnostics(impactReport);
  const pkg = {
    ...structuredClone(contentPackage),
    impactReport,
    diagnostics: [...structuredClone(contentPackage.diagnostics), ...diagnostics],
  };
  const service = new ExportService();

  const json = JSON.parse((await service.exportPackage(pkg, 'json')).toString('utf8'));
  for (const formulaId of ['F32', 'F33']) {
    const diagnostic = json.diagnostics.find((item: any) => item.formulaId === formulaId);
    assert.deepEqual(diagnostic, diagnostics.find((item) => item.formulaId === formulaId));
    assert.deepEqual(
      json.impactReport.diagnosticProxies.find((item: any) => item.formulaId === formulaId),
      impactReport.diagnosticProxies.find((item) => item.formulaId === formulaId),
    );
    assert.equal(diagnostic.semantics, 'ordered_component_review_metadata');
    assert.equal(diagnostic.status, 'unknown');
    assert.equal(diagnostic.evaluationStatus, 'not_evaluated');
    assert.equal(diagnostic.aggregateValue, null);
    assert.equal(diagnostic.scoreProduced, false);
    assert.equal(diagnostic.evidenceStatus, 'unvalidated_proxy');
    assert.equal(diagnostic.aggregation, 'components_only');
    assert.equal(diagnostic.components.length, 10);
    assert.equal(diagnostic.score, undefined);
    assert.ok(diagnostic.components.every((item: any) => item.value === null && item.status === 'unknown'));
    assert.ok(diagnostic.components.every((item: any) => item.emphasisSemantics === 'display_and_manual_review_priority_only'));
  }

  const markdown = (await service.exportPackage(pkg, 'markdown')).toString('utf8');
  assert.match(markdown, /F32\/F33 分项审查元数据（非质量分）/u);
  assert.match(markdown, /语义：ordered_component_review_metadata/u);
  assert.match(markdown, /是否产生分数：否/u);
  assert.match(markdown, /emphasis语义=display_and_manual_review_priority_only/u);
  assert.match(markdown, /不改变阈值、结论、生成、规划、选稿或校验/u);

  const rendered: string[] = [];
  const originalToMarkdown = service.toMarkdown.bind(service);
  service.toMarkdown = ((raw: unknown) => {
    const value = originalToMarkdown(raw);
    rendered.push(value);
    return value;
  }) as ExportService['toMarkdown'];
  const docx = await service.exportPackage(pkg, 'docx');
  const pdf = await service.exportPackage(pkg, 'pdf');
  assert.equal(docx.subarray(0, 2).toString('ascii'), 'PK');
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(rendered.length, 2);
  assert.ok(rendered.every((value) => value.includes('F32/F33 分项审查元数据（非质量分）')));
  assert.ok(rendered.every((value) => value.includes('是否产生分数：否')));

  const malformed = structuredClone(pkg) as any;
  const malformedF32 = malformed.diagnostics.find((item: any) => item.formulaId === 'F32');
  malformedF32.components = [];
  malformedF32.diagnosticContract.componentDefinitions = [];
  malformedF32.diagnosticContract.boundaries = [];
  const malformedJson = JSON.parse((await service.exportPackage(malformed, 'json')).toString('utf8'));
  const rejectedF32 = malformedJson.diagnostics.find((item: any) => item.formulaId === 'F32');
  assert.equal(rejectedF32.contractStatus, 'unknown');
  assert.equal(rejectedF32.semantics, 'unknown');
  assert.equal(rejectedF32.unknown.reason, 'historical_contract_incomplete');
  assert.ok(rejectedF32.unknown.missingFields.includes('diagnosticContract'));
  assert.ok(rejectedF32.unknown.missingFields.includes('components.contract'));

  const adversarialMutations: Array<[string, (diagnostic: any) => void, string]> = [
    ['contract extra key', (diagnostic) => { diagnostic.diagnosticContract.extraField = true; }, 'diagnosticContract'],
    ['component extra weight', (diagnostic) => { diagnostic.components[0].weight = 0.9; }, 'components.contract'],
    ['matching forged labels', (diagnostic) => {
      diagnostic.components[0].label = '质量93/100';
      diagnostic.diagnosticContract.componentDefinitions[0].label = '质量93/100';
    }, 'diagnosticContract'],
    ['raw array reorder', (diagnostic) => { diagnostic.components.reverse(); }, 'components.contract'],
    ['source extra key', (diagnostic) => { diagnostic.components[0].source.extraField = '质量93/100'; }, 'components.contract'],
    ['content diagnostic extra key', (diagnostic) => { diagnostic.extraField = '质量93/100'; }, 'contentDiagnostic.keys'],
    ['canonical explanation changed', (diagnostic) => { diagnostic.explanation = '质量93/100'; }, 'explanation'],
  ];
  for (const [label, mutate, missingField] of adversarialMutations) {
    const adversarial = structuredClone(pkg) as any;
    const diagnostic = adversarial.diagnostics.find((item: any) => item.formulaId === 'F32');
    mutate(diagnostic);
    const output = JSON.parse((await service.exportPackage(adversarial, 'json')).toString('utf8'));
    const normalized = output.diagnostics.find((item: any) => item.formulaId === 'F32');
    assert.equal(normalized.contractStatus, 'unknown', label);
    assert.equal(normalized.name, 'F32 历史诊断', label);
    assert.ok(normalized.unknown.missingFields.includes(missingField), label);
    assert.equal(JSON.stringify(normalized).includes('质量93/100'), false, label);
  }

  const forgedProxy = structuredClone(pkg) as any;
  const proxy = forgedProxy.impactReport.diagnosticProxies.find((item: any) => item.formulaId === 'F32');
  proxy.extraField = '质量93/100';
  proxy.warning = '质量93/100';
  const forgedProxyJson = JSON.parse((await service.exportPackage(forgedProxy, 'json')).toString('utf8'));
  const normalizedProxy = forgedProxyJson.impactReport.diagnosticProxies.find((item: any) => item.formulaId === 'F32');
  assert.equal(normalizedProxy.contractStatus, 'unknown');
  assert.equal(normalizedProxy.name, 'F32 历史诊断');
  assert.equal(normalizedProxy.warning.includes('质量93/100'), false);
  assert.ok(normalizedProxy.unknown.missingFields.includes('report.keys'));
});

test('fails closed when a historical F32/F33 diagnostic lacks the reviewed contract', async () => {
  const historical = structuredClone(contentPackage) as any;
  historical.diagnostics = [{
    formulaId: 'F32',
    name: '质量93/100',
    status: 'unknown',
    explanation: '质量93/100，值得推荐',
    aggregation: 'components_only',
    score: 87,
    components: [{ id: 'stateMatch', label: '质量93/100', emphasis: 87, direction: 'positive' }],
  }];
  historical.impactReport = {
    diagnosticProxies: [{
      formulaId: 'F33',
      name: '历史评论诊断',
      aggregation: 'components_only',
      components: [],
      warning: '质量93/100',
    }],
  };

  const service = new ExportService();
  const json = JSON.parse((await service.exportPackage(historical, 'json')).toString('utf8'));
  const f32 = json.diagnostics[0];
  assert.equal(f32.contractStatus, 'unknown');
  assert.equal(f32.name, 'F32 历史诊断');
  assert.equal(f32.explanation.includes('质量93/100'), false);
  assert.equal(f32.semantics, 'unknown');
  assert.equal(f32.evidenceStatus, 'unknown');
  assert.equal(f32.aggregateValue, null);
  assert.equal(f32.scoreProduced, false);
  assert.equal(f32.score, undefined);
  assert.equal(f32.unknown.reason, 'historical_contract_incomplete');
  assert.equal(f32.components[0].value, null);
  assert.equal(f32.components[0].emphasis, null);
  assert.equal(f32.components[0].displayOrder, null);
  assert.equal(f32.components[0].manualReviewRank, null);
  assert.equal(f32.components[0].label, '历史分项 1');
  const f33 = json.impactReport.diagnosticProxies[0];
  assert.equal(f33.contractStatus, 'unknown');
  assert.equal(f33.name, 'F33 历史诊断');
  assert.equal(f33.warning.includes('质量93/100'), false);
  assert.equal(f33.components.length, 0);
  assert.equal(JSON.stringify(json).includes('质量93/100'), false);

  const markdown = (await service.exportPackage(historical, 'markdown')).toString('utf8');
  assert.match(markdown, /合同状态：unknown/u);
  assert.match(markdown, /历史未知原因：historical_contract_incomplete/u);
  assert.match(markdown, /不得把缺失分项记为 0/u);
  assert.doesNotMatch(markdown, /分数 87/u);
  assert.doesNotMatch(markdown, /质量93\/100/u);

  const rendered: string[] = [];
  const originalToMarkdown = service.toMarkdown.bind(service);
  service.toMarkdown = ((raw: unknown) => {
    const value = originalToMarkdown(raw);
    rendered.push(value);
    return value;
  }) as ExportService['toMarkdown'];
  const docx = await service.exportPackage(historical, 'docx');
  const pdf = await service.exportPackage(historical, 'pdf');
  assert.equal(docx.subarray(0, 2).toString('ascii'), 'PK');
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(rendered.every((value) => !value.includes('质量93/100')));
  assert.equal(docx.toString('binary').includes('93/100'), false);
  assert.equal(pdf.toString('binary').includes('93/100'), false);
});

test('exports an explicit opportunity lock without inventing a ranking result', async () => {
  const service = new ExportService();
  const explicit = structuredClone(contentPackage);
  explicit.opportunitySnapshot.opportunitySelectionAudit = {
    selectedOpportunityId: 'opportunity-1',
    selectionMode: 'explicit_locked',
    rankStatus: 'not_applied',
    approvalBasis: 'approved_dependency',
    rankNotAppliedReason: 'The user explicitly locked an approved opportunity.',
  } as any;
  const markdown = (await service.exportPackage(explicit, 'markdown')).toString('utf8');
  assert.match(markdown, /选择方式：explicit_locked/u);
  assert.match(markdown, /排序状态：not_applied/u);
  assert.match(markdown, /排序结果：未作为本次选择依据/u);
  assert.doesNotMatch(markdown, /固定权重（未标定）/u);
  const json = JSON.parse((await service.exportPackage(explicit, 'json')).toString('utf8'));
  assert.equal(json.opportunitySnapshot.opportunitySelectionAudit.selectedOpportunityRank, undefined);
});

test('keeps an actual empty image brief distinct from an existing image plan', async () => {
  const service = new ExportService();
  const packageWithEmptyBrief = structuredClone(contentPackage);
  packageWithEmptyBrief.content.N.imageBrief = '';
  packageWithEmptyBrief.productionArtifacts.imageBrief = { status: 'absent', note: 'enabled but not produced' };

  const markdown = (await service.exportPackage(packageWithEmptyBrief, 'markdown')).toString('utf8');
  assert.match(markdown, /实际图片简报（content\.N\.imageBrief）：未提供/u);
  assert.match(markdown, /图片简报状态：absent/u);
  assert.match(markdown, /规划构图：PLAN-COMPOSITION-ONLY/u);

  const json = JSON.parse((await service.exportPackage(packageWithEmptyBrief, 'json')).toString('utf8'));
  assert.equal(json.content.N.imageBrief, '');
  assert.equal(json.imagePlan.composition, 'PLAN-COMPOSITION-ONLY');
  assert.equal(json.productionArtifacts.imageBrief.status, 'absent');
});

test('resolves an explicit CJK font path before platform fallbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-agent-font-'));
  try {
    const fontPath = join(directory, 'custom-cjk.ttf');
    await writeFile(fontPath, 'placeholder');
    assert.equal(new ExportService().resolveCjkFontPath(fontPath), fontPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects malformed packages and unsupported formats', async () => {
  const service = new ExportService();
  await assert.rejects(service.exportPackage({}, 'markdown'), BadRequestException);
  await assert.rejects(
    service.exportPackage({ ...contentPackage, validation: { valid: false, repairAttempts: 2, issues: [{ severity: 'error' }] } }, 'markdown'),
    /禁止导出/u,
  );
  await assert.rejects(
    service.exportPackage(contentPackage, 'xml' as never),
    BadRequestException,
  );
});
