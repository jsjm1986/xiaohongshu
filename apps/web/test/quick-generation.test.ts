import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoApproveAndGenerate, quickCandidateFields, quickCandidateToMarkdown } from '../src/lib/quick-generation.js';

const fullCandidate = {
  id: 'c1',
  label: '版本一',
  title: '去眼袋功课怎么做',
  body: '正文内容……',
  tags: ['去眼袋', '医美功课'],
  imageBrief: '封面：术前术后对比图',
  commentOwnedFirstComment: '楼主补充：先看资质',
  comments: [
    {
      question: '会反弹吗？',
      answer: '结构性去除不易反弹',
      boundary: '不构成医疗建议',
      nextStep: '面诊确认方案',
      followUps: [{ question: '恢复期多久？', answer: '一般一周', boundary: '因人而异' }],
      // 审计字段，应被剔除：
      primaryGapId: 'g1',
      postingIdentity: 'author',
      densityProxy: { x: 1 },
    },
  ],
  // 审计字段，应被剔除：
  score: 88,
  diagnostics: [{ code: 'x' }],
  sources: [{ name: 's' }],
  unknowns: ['u'],
  gapCoverageLedger: { closed: 1 },
  validation: { valid: true, repairAttempts: 0, issues: [] },
} as any;

test('quickCandidateFields keeps only usable copy fields', () => {
  const view = quickCandidateFields(fullCandidate);
  assert.equal(view.id, 'c1');
  assert.equal(view.label, '版本一');
  assert.equal(view.publishable, true);
  assert.equal(view.title, '去眼袋功课怎么做');
  assert.equal(view.body, '正文内容……');
  assert.deepEqual(view.tags, ['去眼袋', '医美功课']);
  assert.equal(view.imageBrief, '封面：术前术后对比图');
  assert.equal(view.commentOwnedFirstComment, '楼主补充：先看资质');
  assert.equal(view.comments.length, 1);
  assert.equal(view.comments[0].question, '会反弹吗？');
  assert.equal(view.comments[0].answer, '结构性去除不易反弹');
  assert.equal(view.comments[0].boundary, '不构成医疗建议');
  assert.equal(view.comments[0].nextStep, '面诊确认方案');
  assert.equal(view.comments[0].followUps?.[0].question, '恢复期多久？');
  // 审计字段必须不存在
  assert.equal((view as any).score, undefined);
  assert.equal((view as any).diagnostics, undefined);
  assert.equal((view as any).sources, undefined);
  assert.equal((view as any).gapCoverageLedger, undefined);
  assert.equal((view.comments[0] as any).primaryGapId, undefined);
  assert.equal((view.comments[0] as any).densityProxy, undefined);
  assert.equal((view.comments[0] as any).postingIdentity, undefined);
});

test('quickCandidateFields marks publishable=false when validation invalid', () => {
  const view = quickCandidateFields({ ...fullCandidate, validation: { valid: false, repairAttempts: 2, issues: [{ severity: 'error', message: 'x' }] } } as any);
  assert.equal(view.publishable, false);
  // 仍保留可用文案，不因不可发布就丢
  assert.equal(view.title, '去眼袋功课怎么做');
});

test('quickCandidateFields tolerates missing optional fields', () => {
  const view = quickCandidateFields({ id: 'c2', title: 't', body: 'b', tags: [], comments: [] } as any);
  assert.equal(view.publishable, false); // 无 validation 视为未通过
  assert.equal(view.imageBrief, undefined);
  assert.equal(view.commentOwnedFirstComment, undefined);
  assert.deepEqual(view.comments, []);
});

test('quickCandidateToMarkdown includes usable copy and no audit appendix', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields(fullCandidate));
  assert.match(md, /去眼袋功课怎么做/);
  assert.match(md, /正文内容/);
  assert.match(md, /#去眼袋/);
  assert.match(md, /会反弹吗？/);
  assert.match(md, /楼主补充/);
  assert.doesNotMatch(md, /审计附录/);
  assert.doesNotMatch(md, /primaryGapId/);
});

test('quickCandidateFields preserves label used for result tabs', () => {
  const withLabel = quickCandidateFields({ id: 'c3', label: '版本二', title: 't', body: 'b', tags: [], comments: [] } as any);
  assert.equal(withLabel.label, '版本二');
  const noLabel = quickCandidateFields({ id: 'c4', title: 't', body: 'b', tags: [], comments: [] } as any);
  assert.equal(noLabel.label, undefined);
});

function makeDeps(overrides = {}) {
  const calls: string[] = [];
  const deps = {
    api: {
      blueprintModules: {
        list: async () => { calls.push('bp.list'); return [{ id: 'b1', status: 'draft' }, { id: 'b2', status: 'approved' }]; },
        approve: async (_p: string, id: string) => { calls.push(`bp.approve:${id}`); return { id, status: 'approved' }; },
      },
      intelligence: {
        get: async () => { calls.push('intel.get'); return { id: 'i1', status: 'draft' }; },
        approve: async (_p: string, id: string) => { calls.push(`intel.approve:${id}`); return { id, status: 'approved' }; },
      },
      informationGaps: {
        list: async () => { calls.push('gap.list'); return { items: [{ id: 'g1', status: 'draft' }], total: 1 }; },
        approve: async (_p: string, id: string) => { calls.push(`gap.approve:${id}`); return { id, status: 'approved' }; },
      },
      expressionStrategies: {
        list: async () => { calls.push('strat.list'); return { items: [{ id: 's1', status: 'draft' }], total: 1 }; },
        approve: async (_p: string, id: string) => { calls.push(`strat.approve:${id}`); return { id, status: 'approved' }; },
      },
      opportunities: {
        list: async () => { calls.push('opp.list'); return { items: [{ id: 'o1', title: 't', whyValuable: 'w', gapIds: ['g1'], strategyId: 's1', compatibleStrategyIds: [] }], total: 1 }; },
        approve: async (_p: string, id: string) => { calls.push(`opp.approve:${id}`); return { id }; },
      },
      presets: { list: async () => ({ items: [{ id: 'p1', name: 'x', isDefault: true, values: {} }], total: 1 }) },
      generations: {
        create: async () => { calls.push('gen.create'); return { id: 'job1', status: 'queued', projectId: 'proj1', topic: 't', mode: 'simple' }; },
        get: (() => {
          let n = 0;
          return async () => { calls.push('gen.get'); n += 1; return { id: 'job1', projectId: 'proj1', topic: 't', mode: 'simple', status: n >= 2 ? 'completed' : 'running', candidates: n >= 2 ? [{ id: 'c1', title: 't', body: 'b', tags: [], comments: [], validation: { valid: true, repairAttempts: 0, issues: [] } }] : [] }; };
        })(),
      },
    },
    buildInput: () => ({ projectId: 'proj1', mode: 'simple', opportunityId: 'o1', topic: 't', goal: 'w', audienceStage: 'hesitation', entryPoint: 'x' }),
    resolveSettings: () => ({}),
    ...overrides,
  };
  return { deps, calls };
}

test('autoApproveAndGenerate approves deps then creates and polls to completion', async () => {
  const { deps, calls } = makeDeps();
  const project = { id: 'proj1', name: 'p' } as any;
  const job = await autoApproveAndGenerate({ project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 5, deps: deps as any });
  assert.equal(job.status, 'completed');
  assert.equal(job.candidates?.length, 1);
  // 审批发生在 create 之前
  const createIdx = calls.indexOf('gen.create');
  assert.ok(calls.indexOf('bp.approve:b1') < createIdx, 'blueprint approved before create');
  assert.ok(calls.indexOf('gap.approve:g1') < createIdx, 'gap approved before create');
  assert.ok(calls.indexOf('strat.approve:s1') < createIdx, 'strategy approved before create');
  assert.ok(calls.indexOf('opp.approve:o1') < createIdx, 'opportunity approved before create');
  // 已 approved 的 blueprint b2 不应被再次 approve
  assert.equal(calls.includes('bp.approve:b2'), false);
  // 轮询直到 completed
  assert.ok(calls.filter((c) => c === 'gen.get').length >= 2);
});

test('autoApproveAndGenerate approves intelligence before opportunity', async () => {
  // 默认 makeDeps 的 intelligence.get 返回 { id: 'i1', status: 'draft' }，
  // 其 approvalStatus 为 undefined（≠ 'approved'），因此 intelligence.approve 一定会触发。
  const { deps, calls } = makeDeps();
  const project = { id: 'proj1', name: 'p' } as any;
  const job = await autoApproveAndGenerate({ project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 5, deps: deps as any });
  assert.equal(job.status, 'completed');
  assert.ok(calls.includes('intel.approve:i1'), 'intelligence was approved');
  assert.ok(calls.includes('opp.approve:o1'), 'opportunity was approved');
  assert.ok(calls.indexOf('intel.approve:i1') < calls.indexOf('opp.approve:o1'), 'intelligence approved before opportunity');
});

test('autoApproveAndGenerate throws when job fails', async () => {
  const { deps } = makeDeps({
    api: { ...makeDeps().deps.api, generations: {
      create: async () => ({ id: 'job1', status: 'queued', projectId: 'proj1', topic: 't', mode: 'simple' }),
      get: async () => ({ id: 'job1', projectId: 'proj1', topic: 't', mode: 'simple', status: 'failed', error: '生成失败' }),
    } },
  });
  const project = { id: 'proj1', name: 'p' } as any;
  await assert.rejects(() => autoApproveAndGenerate({ project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 5, deps: deps as any }), /生成失败|失败/);
});

test('autoApproveAndGenerate forwards overrides into buildInput and resolveSettings', async () => {
  const seen: { resolveOverrides?: unknown; buildOverrides?: unknown } = {};
  const base = makeDeps().deps;
  const deps = {
    ...base,
    resolveSettings: (arg: { overrides?: unknown }) => { seen.resolveOverrides = arg.overrides; return {}; },
    buildInput: (arg: { overrides?: unknown }) => {
      seen.buildOverrides = arg.overrides;
      return { projectId: 'proj1', mode: 'simple', opportunityId: 'o1', topic: 't', goal: 'w', audienceStage: 'hesitation', entryPoint: 'x' };
    },
  };
  const project = { id: 'proj1', name: 'p' } as any;
  const overrides = { city: '上海', commentRichness: 'dense' as const };
  await autoApproveAndGenerate({ project, opportunityId: 'o1', overrides, pollIntervalMs: 1, maxPolls: 5, deps: deps as any });
  assert.deepEqual(seen.resolveOverrides, overrides);
  assert.deepEqual(seen.buildOverrides, overrides);
});
