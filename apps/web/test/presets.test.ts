import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdvancedGenerationConfig, Candidate, ContentPreset, ExpressionStrategy, InformationGap, Project, TopicOpportunity } from '../src/types.js';
import {
  builtInPresets,
  mergePresetShelf,
  preparePresetApplication,
} from '../src/lib/presets.js';
import {
  buildSimpleGenerateInput,
  COMMENT_RICHNESS_PROFILES,
  mergeCommentRichnessOverrides,
  resolveSimpleGenerationSettings,
  shouldShowSimpleLocalFields,
} from '../src/lib/simple-generation.js';
import { BUILT_IN_GENERATION_PRESETS, GENERATION_PARAMETER_REGISTRY } from '../../../packages/agent-core/src/parameters.js';
import { candidateToMarkdown } from '../src/lib/utils.js';
import { inspectOpportunityApprovalDependencies, opportunityRequiresReview } from '../src/lib/opportunity-approval.js';
import { resolveOpportunityRankView, resolveOpportunitySelectionAuditView } from '../src/lib/opportunity-rank.js';
import { normalizeParameterSchema } from '../src/lib/parameter-schema.js';

const defaultAdvanced: AdvancedGenerationConfig = {
  knowledgeScope: 'all',
  informationBreadth: 76,
  informationDepth: 64,
  expressionFreedom: 58,
  vigilanceLevel: 44,
  bodyLength: 220,
  commentThreads: 4,
  tone: '真实分享',
  titleStyle: '疑问与缺口',
  model: '项目默认',
  temperature: 0.75,
  repairRounds: 2,
  evidenceMode: 'balanced',
};

const project: Project = {
  id: 'p1',
  name: '项目一',
  cities: ['杭州'],
  doctors: [{ name: '林医生' }],
  generationDefaults: {
    audienceStage: 'discovering',
    entryPoint: 'recommendation',
    mustInclude: ['项目默认必须项'],
    forbidden: ['项目默认禁写项'],
  },
};

const opportunity: TopicOpportunity = {
  id: 'o1',
  projectId: 'p1',
  title: '怎么筛选适合自己的方案',
  coreQuestion: '该看哪些条件？',
  summary: '补齐筛选条件',
  gapIds: ['gap-1'],
  readerStages: ['comparing'],
  recommendedEntryPoint: 'search',
  decisionTask: '比较选择',
  whyValuable: '帮助用户形成核验清单',
  answerability: 'verifiable',
  evidenceIds: ['e1'],
  unknowns: [],
  boundaries: ['不承诺结果'],
  suggestedImageAssetIds: [],
  compatibleStrategyIds: ['strategy-1'],
  mustInclude: ['选题必须项'],
};

test('OpportunityRankHeuristicV1 exposes fixed uncalibrated components without claiming F28 or causality', () => {
  const view = resolveOpportunityRankView({
    ...opportunity,
    rank: 1,
    heuristic: {
      id: 'OpportunityRankHeuristicV1', version: '1.0.0',
      weights: { relevance: 0.22 }, criticalMetrics: ['relevance'],
      weightsCalibrated: false, causal: false, notF28: true,
    },
    components: [{
      metric: 'relevance', rawValue: 0.8, transformedValue: 0.8,
      transformation: 'identity', weight: 0.22, contribution: 0.176,
      source: { source: 'project_knowledge', sourceRef: 'facts.md' },
    }],
    effectiveEligibility: 'eligible', reviewRequired: false,
    scoreSemantics: 'ordinal_noncausal_heuristic',
    finalScore: 0.62,
    recentCoverage: { status: 'provided', count: 0, similarity: 0, source: 'coverage_ledger' },
  });
  assert.equal(view.title, '机会排序启发式 V1');
  assert.equal(view.sortable, true);
  assert.equal(view.valueLabel, '0.620');
  assert.equal(view.fixedWeights, true);
  assert.equal(view.weightsCalibrated, false);
  assert.equal(view.causal, false);
  assert.equal(view.notF28, true);
  assert.match(view.components[0]?.source || '', /项目知识.*facts\.md/u);
  assert.equal(view.recentCoverage.value, '0.00');
});

test('unknown opportunity inputs remain review-required and never render as an ordinary zero score', () => {
  const view = resolveOpportunityRankView({
    ...opportunity,
    heuristic: {
      id: 'OpportunityRankHeuristicV1', version: '1.0.0', weights: { risk: -0.18 },
      criticalMetrics: ['risk'], weightsCalibrated: false, causal: false, notF28: true,
    },
    components: [{
      metric: 'risk', rawValue: null, transformedValue: null,
      transformation: 'identity', weight: -0.18, contribution: null,
      source: { kind: 'not_provided', note: '没有风险审查' },
    }],
    effectiveEligibility: 'review_required', reviewRequired: true,
    scoreSemantics: 'ordinal_noncausal_heuristic',
    reviewReasons: ['关键输入 risk 缺失'], unknownMetrics: ['risk'], finalScore: null,
    recentCoverage: { status: 'unknown', count: null, similarity: null, source: 'not_provided' },
  });
  assert.equal(view.sortable, false);
  assert.equal(view.valueLabel, '待复核');
  assert.deepEqual(view.unknownMetrics, ['risk']);
  assert.equal(view.components[0]?.value, 'unknown');
  assert.equal(view.recentCoverage.value, 'unknown');
  assert.doesNotMatch(view.valueLabel, /0|%/u);
});

test('legacy opportunity score is retained only as historical metadata and is not displayed as current ranking', () => {
  const view = resolveOpportunityRankView({ ...opportunity, score: 93 });
  assert.equal(view.historical, true);
  assert.equal(view.stateLabel, '历史数据');
  assert.equal(view.valueLabel, '历史值不参与当前排序');
  assert.match(view.warning || '', /旧 score.*历史启发式/u);
  assert.doesNotMatch(view.valueLabel, /93/u);
});

test('explicitly locked generation reports that ranking was not applied and never invents rank components', () => {
  const view = resolveOpportunitySelectionAuditView({
    selectedOpportunityId: 'o1', selectionMode: 'explicit_locked', rankStatus: 'not_applied',
    approvalBasis: 'approved_dependency', rankNotAppliedReason: 'Explicit user choice',
  });
  assert.equal(view.state, 'explicit_locked');
  assert.equal(view.rankApplied, false);
  assert.equal(view.rankView, undefined);
  assert.match(view.label, /未运行排序/u);
});

test('non-ranked selection modes retain their real cause instead of being mislabeled as user locked', () => {
  const defaultPolicy = resolveOpportunitySelectionAuditView({
    selectedOpportunityId: 'default', selectionMode: 'default_policy', rankStatus: 'not_applied',
  });
  const inherited = resolveOpportunitySelectionAuditView({
    selectedOpportunityId: 'o1', selectionMode: 'revision_inherited', rankStatus: 'not_applied',
  });
  const unspecified = resolveOpportunitySelectionAuditView({
    selectedOpportunityId: 'o1', selectionMode: 'future_non_ranked_mode', rankStatus: 'not_applied',
  });
  assert.equal(defaultPolicy.state, 'default_policy');
  assert.match(defaultPolicy.label, /默认选题策略/u);
  assert.equal(inherited.state, 'revision_inherited');
  assert.match(inherited.label, /沿用原选题/u);
  assert.equal(unspecified.state, 'not_applied');
  assert.doesNotMatch(unspecified.label, /用户|锁定/u);
});

test('automatic selection displays only the persisted server rank audit', () => {
  const view = resolveOpportunitySelectionAuditView({
    selectedOpportunityId: 'o1', selectionMode: 'heuristic_ranked', rankStatus: 'applied',
    selectedOpportunityRank: {
      opportunity,
      rank: 1,
      heuristic: {
        id: 'OpportunityRankHeuristicV1', version: '1.0.0', weights: { relevance: 1 },
        criticalMetrics: ['relevance'], weightsCalibrated: false, causal: false, notF28: true,
      },
      components: [{ metric: 'relevance', rawValue: 0.7, transformedValue: 0.7, transformation: 'identity', weight: 1, contribution: 0.7, source: { source: 'model_heuristic' } }],
      inputSources: {
        status: { source: 'project', sourceRef: 'topic-opportunity:o1' },
        topic: { source: 'user' }, gapIds: { source: 'project' },
        recentCoverage: { source: 'project', sourceRef: 'coverage_records' },
        options: { source: 'default_policy' },
      },
      effectiveEligibility: 'eligible', reviewRequired: false, finalScore: 0.7,
      policy: { minProofability: 0.35, maxRisk: 0.65, recentPenaltyWeight: 0.45, reuseCooldown: 20 },
      recentCoverage: { status: 'provided', count: 0, similarity: 0, source: { source: 'coverage_ledger' } },
      scoreSemantics: 'ordinal_noncausal_heuristic',
    },
  });
  assert.equal(view.rankApplied, true);
  assert.equal(view.rankView?.valueLabel, '0.700');
  assert.match(view.rankView?.inputSources.find((item) => item.label === '状态')?.source || '', /项目资源.*topic-opportunity:o1/u);
  assert.equal(view.rankView?.policy?.find((item) => item.label === '复用冷却条数')?.value, '20');
  assert.match(view.detail, /服务端审计.*没有重新计算/u);
});

test('the fallback shelf uses the ten canonical IDs and exactly one default', () => {
  assert.equal(builtInPresets.length, 10);
  assert.equal(new Set(builtInPresets.map((item) => item.id)).size, 10);
  assert.ok(builtInPresets.every((item) => !item.id.startsWith('builtin-')));
  const shelf = mergePresetShelf([]);
  assert.equal(shelf.length, 10);
  assert.deepEqual(shelf.filter((item) => item.isDefault).map((item) => item.id), ['balanced_information']);
});

test('offline cards mirror the core labels, descriptions, and parameter values exactly', () => {
  for (const corePreset of BUILT_IN_GENERATION_PRESETS) {
    const fallback = builtInPresets.find((item) => item.id === corePreset.id);
    assert.ok(fallback, `missing fallback for ${corePreset.id}`);
    assert.equal(fallback.name, corePreset.label);
    assert.equal(fallback.description, corePreset.description);
    assert.deepEqual(fallback.values, corePreset.parameterValues);
  }
});

test('API built-ins and project default state win without duplicate cards or stars', () => {
  const remote = builtInPresets.map((item): ContentPreset => ({
    ...item,
    description: `API:${item.description}`,
    isDefault: item.id === 'first_research',
  }));
  const shelf = mergePresetShelf(remote);
  assert.equal(shelf.length, 10);
  assert.ok(shelf.every((item) => item.description.startsWith('API:')));
  assert.deepEqual(shelf.filter((item) => item.isDefault).map((item) => item.id), ['first_research']);
});

test('applying preset B after preset A replaces overrides and legacy preview state', () => {
  const first = preparePresetApplication(builtInPresets.find((item) => item.id === 'real_minimal')!);
  const second = preparePresetApplication(builtInPresets.find((item) => item.id === 'balanced_information')!);
  let overrides = { ...first.parameterValues };
  let advanced = { ...defaultAdvanced, ...first.legacyConfig, ...first.advancedPatch };
  overrides = { ...second.parameterValues };
  advanced = { ...defaultAdvanced, ...second.legacyConfig, ...second.advancedPatch };
  const cleanSecondAdvanced = { ...defaultAdvanced, ...second.legacyConfig, ...second.advancedPatch };
  assert.deepEqual(overrides, second.parameterValues);
  assert.deepEqual(advanced, cleanSecondAdvanced);
  assert.equal(overrides.state_information_strength, 75);
  assert.equal(advanced.bodyLength, 140);
});

test('simple settings follow user > opportunity > preset > project > default precedence', () => {
  const preset: ContentPreset = {
    id: 'local_choice',
    name: '本地选择',
    description: '本地决策',
    source: 'built-in',
    values: {
      audience_stage: 'ready',
      entry_route: 'profile',
      forbidden: ['模板禁写项'],
    },
  };
  const resolved = resolveSimpleGenerationSettings({
    overrides: { audienceStage: 'hesitating', city: '上海' },
    opportunity,
    preset,
    project,
  });
  assert.deepEqual(resolved.audienceStage, { value: 'hesitating', source: 'user' });
  assert.deepEqual(resolved.entryPoint, { value: 'search', source: 'opportunity' });
  assert.deepEqual(resolved.mustInclude, { value: '选题必须项', source: 'opportunity' });
  assert.deepEqual(resolved.forbidden, { value: '模板禁写项', source: 'preset' });
  assert.deepEqual(resolved.city, { value: '上海', source: 'user' });
  assert.deepEqual(resolved.doctor, { value: '林医生', source: 'project' });

  const presetWins = resolveSimpleGenerationSettings({ preset, project });
  assert.equal(presetWins.audienceStage.source, 'preset');
  const projectWins = resolveSimpleGenerationSettings({ project });
  assert.equal(projectWins.audienceStage.source, 'project');
  const defaultsWin = resolveSimpleGenerationSettings({});
  assert.deepEqual(defaultsWin.entryPoint, { value: 'search', source: 'default' });
});

test('simple mode only reveals local fields for ready readers or the local-choice preset', () => {
  assert.equal(shouldShowSimpleLocalFields('ready'), true);
  assert.equal(shouldShowSimpleLocalFields('collecting', 'local_choice'), true);
  assert.equal(shouldShowSimpleLocalFields('comparing', 'comparison_framework'), false);
});

test('simple input mapping carries edited essentials and preserves images and resource locks', () => {
  const settings = resolveSimpleGenerationSettings({
    overrides: {
      audienceStage: 'ready',
      entryPoint: 'profile',
      city: '上海',
      doctor: '周医生',
      mustInclude: '说明恢复周期',
      forbidden: '不得承诺效果',
    },
    opportunity,
    project,
  });
  const input = buildSimpleGenerateInput({
    projectId: 'p1',
    opportunity,
    settings,
    imageAssetIds: ['image-1', 'image-2'],
    lockedGapIds: ['gap-locked'],
    lockedStrategyId: 'strategy-locked',
    presetId: 'local_choice',
    localFieldsEnabled: true,
    randomizationDimensions: ['strategy', 'opening'],
  });
  assert.equal(input.audienceStage, 'ready');
  assert.equal(input.entryPoint, 'profile');
  assert.equal(input.city, '上海');
  assert.equal(input.doctor, '周医生');
  assert.equal(input.mustInclude, '说明恢复周期');
  assert.equal(input.forbidden, '不得承诺效果');
  assert.deepEqual(input.imageAssetIds, ['image-1', 'image-2']);
  assert.deepEqual(input.lockedGapIds, ['gap-locked']);
  assert.equal(input.lockedStrategyId, 'strategy-locked');
  assert.deepEqual(input.locks, { gapIds: ['gap-locked'], strategyId: 'strategy-locked' });
  assert.deepEqual(input.randomizationDimensions, ['strategy', 'opening']);
});

test('blank user constraints and visible local fields remain explicit clears in the request', () => {
  const settings = resolveSimpleGenerationSettings({
    overrides: { city: '', doctor: '', mustInclude: '', forbidden: '' },
    opportunity: { ...opportunity, mustInclude: ['选题默认必须项'], forbidden: ['选题默认禁写项'] },
    project,
  });
  assert.equal(settings.mustInclude.source, 'user');
  assert.equal(settings.forbidden.source, 'user');
  const input = buildSimpleGenerateInput({
    projectId: 'p1',
    opportunity,
    settings,
    imageAssetIds: [],
    lockedGapIds: [],
    localFieldsEnabled: true,
    randomizationDimensions: [],
  });
  assert.equal(input.city, '');
  assert.equal(input.doctor, '');
  assert.equal(input.mustInclude, '');
  assert.equal(input.forbidden, '');
});

test('simple input keeps non-empty read-only local context and makes the opportunity strategy authoritative', () => {
  const settings = resolveSimpleGenerationSettings({
    opportunity: { ...opportunity, city: '苏州', doctor: '许医生' },
  });
  const input = buildSimpleGenerateInput({
    projectId: 'p1',
    opportunity: { ...opportunity, strategyId: 'strategy-opportunity' },
    settings,
    imageAssetIds: [],
    lockedGapIds: [],
    lockedStrategyId: 'strategy-global-lock',
    localFieldsEnabled: false,
    randomizationDimensions: ['strategy'],
  });
  assert.equal(input.city, '苏州');
  assert.equal(input.doctor, '许医生');
  assert.equal(input.lockedStrategyId, 'strategy-opportunity');
  assert.equal(input.locks?.strategyId, 'strategy-opportunity');
});

test('unknown opportunity review is detected before dependency approval work starts', () => {
  assert.equal(opportunityRequiresReview({
    ...opportunity,
    eligibilityStatus: 'unknown',
    reviewRequired: true,
    unknownMetrics: ['risk'],
  }), true);
  assert.equal(opportunityRequiresReview({
    ...opportunity,
    eligibilityStatus: 'eligible',
    reviewRequired: false,
    unknownMetrics: [],
  }), false);
  assert.equal(opportunityRequiresReview({
    ...opportunity,
    eligibilityStatus: 'eligible',
    effectiveEligibility: 'ineligible',
    reviewRequired: false,
    unknownMetrics: [],
  }), true);
});

test('candidate markdown explicitly exports simulated role and claim metadata', () => {
  const candidate: Candidate = {
    id: 'candidate-1',
    title: '测试标题',
    body: '测试正文',
    tags: ['#测试'],
    commentDisclaimer: '以下为模拟问答，不代表真实用户评论。',
    comments: [{
      id: 'thread-1',
      question: '我应该先核实什么？',
      answer: '先核实适用条件。',
      personaRole: 'information_collector',
      speakerType: 'simulated_reader',
      claimStatus: 'bounded',
      replyTo: null,
      threadDepth: 0,
      simulated: true,
      simulationLabel: '模拟潜在读者情景',
      postingIdentity: 'staff',
      roleCard: { stage: 'collecting', knowledge: ['已了解基本概念'], constraints: ['待核实维度：时间与工作可见性'], decisionTask: '判断恢复安排', evidenceStance: 'verification_seeking' },
      primaryGapId: 'recovery',
      auxiliaryGapIds: ['work_visibility'],
      densityProxy: { primaryGapCount: 1, auxiliaryDimensionCount: 1, roleDimensionCount: 5, constraintCount: 1, expectedReplyComponents: 5, questionTargetChars: 22 },
      replyPlan: { directAnswer: '恢复存在个体差异', condition: '时间与工作可见性', boundary: '不能承诺统一天数', unknown: '个人恢复速度未知', nextQuestion: '需要正常见人的时间' },
      discoveryPlan: { cue: '资料只给出观察窗口', inferencePrompt: '这能直接推出每个人都一样吗', reveal: '不能，个体恢复仍需单独判断', selfCheck: '核对个人条件和资料范围', boundary: '发现答案不等于获得新证据', revealTiming: 'same_thread', difficulty: 'low' },
    }],
    gapCoverageLedger: {
      entries: [{ gapId: 'recovery', label: '恢复安排', status: 'thread_resolved', required: true, bodyAllocated: false, commentAllocated: true, primaryThreadIds: ['thread-1'], auxiliaryThreadIds: [], reason: '同一线程给出有边界的回答' }],
      uncoveredGapIds: [], closureRate: 1, resolvedRate: 1, targetThreadCount: 1, effectiveThreadCount: 1,
    },
  };
  const markdown = candidateToMarkdown(candidate);
  assert.match(markdown, /标签只表达主题.*不保证曝光、推荐或合格触达/u);
  assert.match(markdown, /模拟情景，非真实评论/u);
  assert.match(markdown, /信息收集者/u);
  assert.match(markdown, /模拟读者/u);
  assert.match(markdown, /有边界回答/u);
  assert.match(markdown, /答复身份：staff/u);
  assert.match(markdown, /后台决策状态：阶段=collecting/u);
  assert.match(markdown, /1个主缺口＋1个辅助维度/u);
  assert.match(markdown, /后台答复库存（按人物与关系择需使用，不要求全部写出）：直接回答=恢复存在个体差异/u);
  assert.match(markdown, /发现式路径：线索=资料只给出观察窗口/u);
  assert.match(markdown, /同线程揭示=不能，个体恢复仍需单独判断/u);
  assert.match(markdown, /信息闭合台账/u);
  assert.match(markdown, /台账完整度：100%/u);
  assert.match(markdown, /最终实际解决率：待评估/u);
  assert.match(markdown, /最终图片资产：unknown/u);
  assert.match(markdown, /实际部署：unknown/u);
  assert.match(markdown, /入口截图→文案语义一致性：not_evaluated/u);
  assert.match(markdown, /部署计划（非部署记录）/u);

  const evaluated = candidateToMarkdown({
    ...candidate,
    gapCoverageLedger: {
      ...candidate.gapCoverageLedger!,
      ledgerCompleteness: 1,
      realizationStatus: 'evaluated',
      realizedResolvedRate: 1,
      entries: candidate.gapCoverageLedger!.entries.map((entry) => ({
        ...entry,
        plannedPlacements: ['Cref'],
        actualRealizations: [{
          channel: 'Cref', threadId: 'thread-1', answerRealized: true,
          conditionOrBoundaryRealized: true, evidenceRealized: true,
          findable: true, resolved: true, missing: [],
        }],
      })),
    },
  });
  assert.match(evaluated, /最终实际解决率：100%/u);
  assert.match(evaluated, /计划位置=Cref/u);
  assert.match(evaluated, /实际核验=Cref:完整实现/u);
});

test('opportunity dependencies approve only explicit references and expose missing resources', () => {
  const gaps: InformationGap[] = [{
    id: 'gap-1', projectId: 'p1', label: '恢复安排', question: '怎么安排？', category: '恢复',
    stages: ['collecting'], decisionTasks: [], sourceType: 'project_knowledge', evidenceStatus: 'unapproved',
    answerability: 'verifiable', evidenceIds: [], priority: 80, enabled: true, locked: false, status: 'draft',
  }];
  const strategy = (id: string): ExpressionStrategy => ({
    id, projectId: 'p1', name: id, description: '测试策略', routePolicy: '', imagePolicy: '', titlePolicy: '',
    bodyPolicy: '', commentPolicy: '', deploymentPolicy: '', compatibleGapTypes: [], incompatibleConditions: [],
    randomizableDimensions: [], weight: 60, enabled: true, locked: false, source: 'ai', status: 'draft',
  });
  const dependencies = inspectOpportunityApprovalDependencies({
    ...opportunity,
    gapIds: ['gap-1', 'gap-missing'],
    strategyId: 'strategy-explicit',
    compatibleStrategyIds: ['strategy-compatible'],
  }, gaps, [strategy('strategy-explicit'), strategy('strategy-compatible')]);

  assert.deepEqual(dependencies.missingGapIds, ['gap-missing']);
  assert.deepEqual(dependencies.unapprovedGaps.map((item) => item.id), ['gap-1']);
  assert.deepEqual(dependencies.unapprovedStrategies.map((item) => item.id), ['strategy-explicit']);
  assert.deepEqual(dependencies.missingStrategyIds, []);
});

test('comment richness profiles map all social-network parameters and preserve unrelated overrides', () => {
  assert.deepEqual(COMMENT_RICHNESS_PROFILES.restrained.values, {
    comment_role_diversity: 35, comment_constraint_density: 35, comment_gap_multiplexing: 30, comment_reply_increment: 45, question_compression: 35,
    comment_platform_register: 25, comment_conversation_rate: 20, comment_branching_strength: 30, comment_organic_variation: 25,
    comment_discovery_strength: 35, comment_inference_effort: 20, comment_self_verification: 45, comment_false_closure_guard: 95,
  });
  assert.deepEqual(COMMENT_RICHNESS_PROFILES.balanced.values, {
    comment_role_diversity: 65, comment_constraint_density: 60, comment_gap_multiplexing: 55, comment_reply_increment: 70, question_compression: 60,
    comment_platform_register: 68, comment_conversation_rate: 48, comment_branching_strength: 62, comment_organic_variation: 58,
    comment_discovery_strength: 65, comment_inference_effort: 35, comment_self_verification: 70, comment_false_closure_guard: 95,
  });
  assert.deepEqual(COMMENT_RICHNESS_PROFILES.dense.values, {
    comment_role_diversity: 90, comment_constraint_density: 85, comment_gap_multiplexing: 80, comment_reply_increment: 88, question_compression: 80,
    comment_platform_register: 82, comment_conversation_rate: 70, comment_branching_strength: 80, comment_organic_variation: 82,
    comment_discovery_strength: 80, comment_inference_effort: 45, comment_self_verification: 85, comment_false_closure_guard: 98,
  });
  assert.deepEqual(mergeCommentRichnessOverrides({ evidence_strictness: 95 }, 'restrained'), {
    evidence_strictness: 95,
    ...COMMENT_RICHNESS_PROFILES.restrained.values,
  });
  assert.deepEqual(mergeCommentRichnessOverrides({ evidence_strictness: 95 }, 'balanced'), {
    evidence_strictness: 95,
    ...COMMENT_RICHNESS_PROFILES.balanced.values,
  });
  assert.deepEqual(mergeCommentRichnessOverrides({ evidence_strictness: 95 }, 'dense'), {
    evidence_strictness: 95,
    ...COMMENT_RICHNESS_PROFILES.dense.values,
  });

  const settings = resolveSimpleGenerationSettings({ overrides: { commentRichness: 'dense' }, opportunity, project });
  const input = buildSimpleGenerateInput({
    projectId: 'p1',
    opportunity,
    settings,
    imageAssetIds: [],
    lockedGapIds: [],
    localFieldsEnabled: false,
    overrides: { evidence_strictness: 95 },
    randomizationDimensions: [],
  });
  assert.deepEqual(input.overrides, { evidence_strictness: 95, ...COMMENT_RICHNESS_PROFILES.dense.values });
  assert.equal((input.overrides as Record<string, unknown>).parameterValues, undefined);
});

test('comment richness source is user, template, or balanced system default', () => {
  const preset: ContentPreset = {
    id: 'comment-dense',
    name: '高密度评论',
    description: '测试',
    source: 'project',
    values: { ...COMMENT_RICHNESS_PROFILES.dense.values },
  };
  assert.deepEqual(resolveSimpleGenerationSettings({ preset }).commentRichness, { value: 'dense', source: 'preset' });
  assert.deepEqual(resolveSimpleGenerationSettings({ preset, overrides: { commentRichness: 'restrained' } }).commentRichness, { value: 'restrained', source: 'user' });
  assert.deepEqual(resolveSimpleGenerationSettings({}).commentRichness, { value: 'balanced', source: 'default' });
});

test('advanced schema automatically exposes all registered comment and discovery controls', () => {
  const schema = normalizeParameterSchema({ parameters: GENERATION_PARAMETER_REGISTRY });
  const expected = Object.keys(COMMENT_RICHNESS_PROFILES.balanced.values);
  const controls = schema.parameters.filter((parameter) => expected.includes(parameter.id));
  assert.deepEqual(controls.map((parameter) => parameter.id), expected);
  assert.ok(controls.every((parameter) => parameter.control === 'slider'));
  assert.ok(controls.every((parameter) => parameter.min === 0 && parameter.max === 100));
});

test('diagnostic emphasis is described only as display and manual-review ordering', () => {
  const schema = normalizeParameterSchema({ parameters: GENERATION_PARAMETER_REGISTRY });
  const group = schema.groups.find((item) => item.id === 'diagnostic');
  const parameters = schema.parameters.filter((item) => item.group === 'diagnostic' && /DiagnosticEmphasis/u.test(item.path));
  assert.match(group?.description || '', /F32\/F33 emphasis.*页面.*人工检查清单.*不调度系统检查.*合格线.*分数/u);
  assert.equal(parameters.length, 20);
  assert.ok(parameters.every((item) => /显示顺序.*人工复核优先级.*不是分项值/u.test(item.noviceExplanation)));
  assert.ok(parameters.every((item) => /不会改变阈值、状态、结论/u.test(item.increaseEffect || '')));
  assert.ok(parameters.every((item) => /人工清单中后移.*不调度系统检查.*硬校验.*门槛/u.test(item.decreaseEffect || '')));
});

test('legacy vigilance control is presented as an uncalibrated writing control, not reader psychology', () => {
  const schema = normalizeParameterSchema({});
  const parameter = schema.parameters.find((item) => item.id === 'vigilance');
  assert.ok(parameter);
  assert.match(parameter.label, /证据审慎/u);
  assert.equal(parameter.unit, undefined);
  assert.match(parameter.noviceExplanation, /不是读者警惕性百分比/u);
  assert.match(parameter.noviceExplanation, /心理测量/u);
  assert.match(parameter.equation || '', /evidence_strictness \+ boundary_visibility/u);
  assert.match(parameter.evidenceNote || '', /未标定/u);
  assert.doesNotMatch(parameter.description, /预计读者/u);
});
