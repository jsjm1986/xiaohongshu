import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readerView } from '../src/generation-reader-view.js';
import type { ContentPackage } from '@content-agent/agent-core';

/**
 * 阅读投影的字段集。
 *
 * 起因是实测:GET /api/generations/:id 单任务 1.05 MB,其中 trace / 参数影响报告 /
 * 编排快照全量占 90%,极简创作一个都不渲染;而界面真正要的判断依据(reasoning、
 * gapCoverageLedger、strategy)旧接口压根不返回。
 *
 * 这里用白名单**相等**锁死字段集(不是「包含」):加字段必须连这个测试一起改,
 * 免得重字段又悄悄长回去。
 */

const CANDIDATE_KEYS = [
  'id', 'packageId', 'candidateIndex', 'seed',
  'title', 'body', 'tags', 'imageBrief',
  'commentDisclaimer', 'commentOwnedFirstComment', 'commentUncoveredGaps', 'comments',
  'validation', 'reasoning', 'gapLedger', 'gapCards',
  'sources', 'unknowns', 'strategy', 'deploymentPlan',
];

/** 明确不能出现的重字段:这些是完整版工作台的专家视角。 */
const FORBIDDEN_KEYS = [
  'trace', 'parameterImpactReport', 'impactReport', 'configImpact',
  'orchestrationSnapshot', 'resolutionSnapshot', 'configSnapshot',
  'knowledgeSnapshot', 'formulaSnapshot', 'diagnostics', 'diagnosticProxies',
  'dialogueThreads', 'productionArtifacts', 'coverageSignature', 'opportunitySnapshot',
];

function pkg(overrides: Record<string, unknown> = {}): ContentPackage {
  return {
    schemaVersion: '1.1',
    id: 'pkg-1',
    projectId: 'p-1',
    jobId: 'j-1',
    candidateId: 'cand-1',
    candidateIndex: 0,
    seed: 12345,
    createdAt: '2026-07-25T00:00:00.000Z',
    formulaSnapshot: { versionId: 'fv', digest: 'd', enabledFormulaIds: ['F32'] },
    configSnapshot: {} as ContentPackage['configSnapshot'],
    knowledgeSnapshot: { mode: 'auto', documents: [], sectionIds: [] },
    content: {
      H: { hashtags: ['杭州装修', '#保修'] },
      N: { title: '标题', body: '正文一句。正文两句。', imageBrief: '图片说明' },
      Cref: {
        disclaimer: '以下为创作参考',
        ownedFirstComment: '首评文本',
        uncoveredGaps: [],
        threads: [
          {
            id: 't-1',
            gap: 'gap-1',
            function: 'clarify',
            question: '能换班组吗',
            answer: '按合同可以',
            postingIdentity: 'staff',
            stage: 'comparing',
            boundary: '工期顺延',
            nextStep: '先面谈',
            simulated: true,
            displayName: '小李',
            followUps: [{ question: '要加钱吗', answer: '不加' }],
          },
        ],
      },
    } as unknown as ContentPackage['content'],
    evidence: [
      { id: 'e-1', documentId: 'doc-1', path: '知识库/保修.md', section: '第3节', kind: 'fact', evidenceStatus: 'user_supplied' },
    ] as unknown as ContentPackage['evidence'],
    reasoning: [
      {
        statement: '正文一句。',
        status: 'hypothesis',
        evidenceIds: [],
        location: 'N.body',
        occurrence: { field: 'body' },
        // 这一段是整段证据原文,投影必须丢掉
        sourceSpans: [{ evidenceId: 'e-1', quote: 'x'.repeat(4000) }],
      },
    ] as unknown as ContentPackage['reasoning'],
    unknowns: [
      { id: 'u-1', key: '判定标准', question: '由谁认定不合格', reason: '资料未给', impact: 'high', requiredFor: ['user_decision'] },
    ] as unknown as ContentPackage['unknowns'],
    conflicts: [],
    diagnostics: [{ name: 'hard_constraints', status: 'pass', explanation: 'ok', score: 1 }] as unknown as ContentPackage['diagnostics'],
    validation: { valid: false, repairAttempts: 1, issues: [{ code: 'ungrounded_fact', severity: 'error', message: 'no evidence' }] },
    revisions: [],
    deploymentPlan: { postingIdentity: 'author', ownedFirstComment: true } as unknown as ContentPackage['deploymentPlan'],
    dialogueThreads: [{ id: 't-1', personaRole: 'skeptical_returning_reader', simulated: true } as unknown as NonNullable<ContentPackage['dialogueThreads']>[number]],
    orchestrationSnapshot: {
      strategy: {
        id: 's-1', label: '政策确认', prototype: 'process_log',
        openingMode: 'clarify', narrativeMode: 'sequential', bodyRole: 'source_attribution',
        commentMode: 'none', voice: 'reassuring_but_honest', sequence: [], targetChannels: [],
        imageRole: 'other',
      },
      gapPlanningCards: [
        {
          gapId: 'gap-1', label: '班组更换', question: '不合格能换吗', category: 'decision',
          audienceStages: [], importance: 0.8, decisionLeverage: 0.7, proofability: 0.2,
          required: false, priority: 'high', boundary: '工期顺延', evidenceIds: [],
          plannedPlacements: ['N.body', 'Cref'],
        },
      ],
      gapCoverageLedger: {
        entries: [
          {
            gapId: 'gap-1', label: '班组更换', status: 'realization_failed', required: false,
            bodyAllocated: true, commentAllocated: true, plannedPlacements: ['N.body', 'Cref'],
            reason: '正文与评论都未完整落地',
            actualRealizations: [
              { channel: 'N.body', answerRealized: false, conditionOrBoundaryRealized: false, evidenceRealized: false, findable: false, resolved: false, missing: ['answer', 'evidence'] },
            ],
            primaryThreadIds: [], auxiliaryThreadIds: [],
          },
        ],
        uncoveredGapIds: [], ledgerCompleteness: 1, closureRate: 1, resolvedRate: 0,
        realizedResolvedRate: 0, realizationStatus: 'evaluated',
        targetThreadCount: 5, effectiveThreadCount: 5,
      },
      // 这些是重字段的来源,投影里不该出现
      dialogueThreads: [], channelAllocation: {}, rationale: ['x'.repeat(2000)],
    } as unknown as ContentPackage['orchestrationSnapshot'],
    ...overrides,
  } as ContentPackage;
}

test('字段集与白名单完全相等,不多不少', () => {
  const view = readerView(pkg());
  assert.deepEqual(Object.keys(view).sort(), [...CANDIDATE_KEYS].sort());
});

test('完整版专家字段一个都不出现', () => {
  const view = readerView(pkg()) as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(key in view, false, `投影不该带 ${key}`);
  }
});

test('reasoning 保留结论与落点,丢掉整段证据原文', () => {
  const view = readerView(pkg());
  assert.equal(view.reasoning.length, 1);
  const entry = view.reasoning[0]!;
  assert.equal(entry.statement, '正文一句。');
  assert.equal(entry.status, 'hypothesis');
  assert.equal(entry.field, 'body');
  assert.deepEqual(entry.evidenceIds, []);
  // 4000 字的 quote 不能被带出来
  assert.equal('sourceSpans' in entry, false);
  assert.ok(JSON.stringify(view).length < 4000, '投影体积应远小于单条 sourceSpans');
});

test('缺口落地台账带上缺哪几项:这是「不能直接发」的具体原因', () => {
  const view = readerView(pkg());
  const entry = view.gapLedger!.entries[0]!;
  assert.equal(entry.status, 'realization_failed');
  assert.equal(entry.label, '班组更换');
  assert.deepEqual(entry.plannedPlacements, ['N.body', 'Cref']);
  assert.deepEqual(entry.realizations[0]!.missing, ['answer', 'evidence']);
  assert.equal(entry.realizations[0]!.resolved, false);
  assert.equal(view.gapLedger!.realizationStatus, 'evaluated');
});

test('缺口原始问题从 gapPlanningCards 带出,台账才能讲清在问什么', () => {
  const view = readerView(pkg());
  assert.equal(view.gapCards.length, 1);
  assert.equal(view.gapCards[0]!.question, '不合格能换吗');
  assert.equal(view.gapCards[0]!.boundary, '工期顺延');
});

test('候选表达轴带出 7 个维度,让三个「随机候选」可区分', () => {
  const view = readerView(pkg());
  assert.deepEqual(view.strategy, {
    label: '政策确认',
    prototype: 'process_log',
    openingMode: 'clarify',
    narrativeMode: 'sequential',
    bodyRole: 'source_attribution',
    commentMode: 'none',
    voice: 'reassuring_but_honest',
  });
  assert.equal(view.seed, 12345);
});

test('评论线程带上身份/角色/承担缺口,不只是问答两行', () => {
  const view = readerView(pkg());
  const c = view.comments[0]!;
  assert.equal(c.postingIdentity, 'staff');
  assert.equal(c.function, 'clarify');
  assert.equal(c.gap, 'gap-1');
  assert.equal(c.stage, 'comparing');
  assert.equal(c.boundary, '工期顺延');
  assert.equal(c.simulated, true);
  assert.equal(c.displayName, '小李');
  assert.equal(c.followUps.length, 1);
});

test('线程元数据缺失时从规划线程回落,而不是留空', () => {
  const p = pkg();
  // 成稿线程没有 personaRole(历史包常见),规划线程里有
  (p.content.Cref.threads[0] as unknown as Record<string, unknown>).personaRole = undefined;
  const view = readerView(p);
  assert.equal(view.comments[0]!.personaRole, 'skeptical_returning_reader');
});

test('标签统一补 #,不混着两种写法', () => {
  const view = readerView(pkg());
  assert.deepEqual(view.tags, ['#杭州装修', '#保修']);
});

test('校验结论原样带出,让前端自己按严重度分级', () => {
  const view = readerView(pkg());
  assert.equal(view.validation.valid, false);
  assert.equal(view.validation.issues[0]!.severity, 'error');
  assert.equal(view.validation.issues[0]!.code, 'ungrounded_fact');
});

test('未知问题只带人能读的三项,不带内部 id/requiredFor', () => {
  const view = readerView(pkg());
  assert.deepEqual(view.unknowns, [
    { question: '由谁认定不合格', impact: 'high', reason: '资料未给' },
  ]);
});

test('缺 orchestrationSnapshot 的历史包不炸,只是没有台账与表达轴', () => {
  const view = readerView(pkg({ orchestrationSnapshot: undefined }));
  assert.equal(view.gapLedger, undefined);
  assert.equal(view.strategy, undefined);
  assert.deepEqual(view.gapCards, []);
  assert.equal(view.title, '标题');
});

test('缺 reasoning/evidence 的历史包返回空数组,不返回 undefined', () => {
  const view = readerView(pkg({ reasoning: undefined, evidence: undefined, unknowns: undefined }));
  assert.deepEqual(view.reasoning, []);
  assert.deepEqual(view.sources, []);
  assert.deepEqual(view.unknowns, []);
});

test('host_reply 阅读投影保留作者事实与话题锚点，不冒充机构答复', () => {
  const p = pkg();
  Object.assign(p.content.Cref.threads[0] as unknown as Record<string, unknown>, {
    threadKind: 'host_reply', postingIdentity: 'author', authorFactIds: ['af1'], topicAnchorGapId: 'gap-1',
    surfaceRoleCard: { replyDisplayRole: '楼主' }, primaryGapId: undefined,
  });
  const comment = readerView(p).comments[0]!;
  assert.equal(comment.threadKind, 'host_reply');
  assert.equal(comment.postingIdentity, 'author');
  assert.deepEqual(comment.authorFactIds, ['af1']);
  assert.equal(comment.topicAnchorGapId, 'gap-1');
  assert.equal(comment.surfaceRoleCard?.replyDisplayRole, '楼主');
});
