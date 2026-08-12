import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveOpportunitiesForBatch, autoApproveAndGenerate, GenerationStillRunningError, quickCandidateFields, quickCandidateToMarkdown, reviseCandidate } from '../src/lib/quick-generation.js';

const fullCandidate = {
  id: 'c1',
  label: '版本一',
  title: '去眼袋功课怎么做',
  body: '正文内容……',
  tags: ['去眼袋', '医美功课'],
  imageBrief: '封面：术前术后对比图',
  commentDisclaimer: '问答参考，不代表真实用户发言',
  commentOwnedFirstComment: '楼主补充：先看资质',
  commentUncoveredGaps: ['价格区间'],
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
  assert.equal(view.commentDisclaimer, '问答参考，不代表真实用户发言');
  assert.equal(view.commentOwnedFirstComment, '楼主补充：先看资质');
  assert.deepEqual(view.commentUncoveredGaps, ['价格区间']);
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
  // postingIdentity 是仿真预览正确署名所需的最小发布字段，不再当作可丢弃审计数据。
  assert.equal((view.comments[0] as any).postingIdentity, 'author');
});

// 身份三字段必须透传:创作区的仿真预览靠它们区分「机构答复」与「读者接话」。
// 丢掉 threadKind 的后果不是少个徽标,而是 reader_exchange 的读者互聊被署名成机构发言,
// 撞上方法论禁止假冒消费者那条红线。
test('quickCandidateFields 透传线程形态、读者昵称与机构答复身份', () => {
  const view = quickCandidateFields({
    ...fullCandidate,
    comments: [
      {
        question: '你们能指定师傅吗？',
        answer: '姐妹我也在问这个',
        threadKind: 'reader_exchange',
        displayName: '打呼的小海豹',
        replyDisplayName: '冰美式续杯',
        postingIdentity: 'expert',
        surfaceRoleCard: { replyDisplayRole: '项雄院长' },
        followUps: [],
      },
    ],
  } as any);
  assert.equal(view.comments[0].threadKind, 'reader_exchange');
  assert.equal(view.comments[0].displayName, '打呼的小海豹');
  assert.equal(view.comments[0].replyDisplayName, '冰美式续杯');
  assert.equal(view.comments[0].postingIdentity, 'expert');
  assert.equal(view.comments[0].surfaceRoleCard?.replyDisplayRole, '项雄院长');
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
  assert.equal(view.commentDisclaimer, undefined);
  assert.equal(view.commentOwnedFirstComment, undefined);
  assert.equal(view.commentUncoveredGaps, undefined);
  assert.deepEqual(view.comments, []);
});

test('quickCandidateToMarkdown includes usable copy and no audit appendix', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields(fullCandidate));
  assert.match(md, /去眼袋功课怎么做/);
  assert.match(md, /正文内容/);
  assert.match(md, /#去眼袋/);
  assert.match(md, /会反弹吗？/);
  assert.match(md, /楼主补充/);
  assert.match(md, /免责声明: 问答参考/);
  assert.match(md, /## 未展开缺口/);
  assert.match(md, /- 价格区间/);
  assert.doesNotMatch(md, /审计附录/);
  assert.doesNotMatch(md, /primaryGapId/);
});

// 出口层合规:导出的 Markdown 离开产品后没有界面声明护体,必须自带角色标注。
test('quickCandidateToMarkdown 恒带模拟情景声明与角色标注', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields(fullCandidate));
  assert.match(md, /## 评论区话术参考（模拟情景 · 非真实评论）/);
  assert.match(md, /不得由任何账号代发/);
  assert.match(md, /模拟提问（勿代发）: 会反弹吗？/);
  assert.match(md, /本账号答复参考: 结构性去除不易反弹/);
  assert.match(md, /· 模拟追问（勿代发）: 恢复期多久？/);
  // 声明不依赖 candidate 自带 disclaimer:去掉它照样有段落级声明。
  const bare = quickCandidateToMarkdown(quickCandidateFields({ ...fullCandidate, commentDisclaimer: undefined } as any));
  assert.match(bare, /不得由任何账号代发/);
  // 可发布稿不带水印
  assert.doesNotMatch(md, /仅供人工核对/);
});

test('quickCandidateToMarkdown 给未过校验的稿子加顶部水印', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields({
    ...fullCandidate,
    validation: { valid: false, repairAttempts: 0, issues: [{ severity: 'error', message: 'x' }] },
  } as any));
  assert.ok(md.startsWith('> ⚠ 本稿未通过可发布校验'), md.slice(0, 60));
  assert.match(md, /不得直接发布/);
});

test('reader_exchange 的接话在 Markdown 里标为模拟读者,不冒充本账号答复', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields({
    ...fullCandidate,
    comments: [{
      question: '我也在纠结这个',
      answer: '同感，我先等等看',
      threadKind: 'reader_exchange',
      followUps: [],
    }],
  } as any));
  assert.match(md, /模拟读者接话（勿代发）: 同感，我先等等看/);
  assert.doesNotMatch(md, /本账号答复参考: 同感/);
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

test('autoApproveAndGenerate merges a replay publishing contract into the final create request', async () => {
  const base = makeDeps().deps;
  let submitted: Record<string, unknown> | undefined;
  const deps = {
    ...base,
    api: {
      ...base.api,
      generations: {
        create: async (input: Record<string, unknown>) => {
          submitted = input;
          return { id: 'job1', status: 'completed', projectId: 'proj1', topic: 't', mode: 'simple', candidates: [] };
        },
        get: base.api.generations.get,
      },
    },
  };
  const publishing = {
    publishingTopology: 'confirmed_individual_author' as const,
    authorFactsConfirmed: true,
    authorFacts: [{ id: 'fact-1', statement: '我目前还没决定', category: 'current_state' as const }],
  };
  await autoApproveAndGenerate({
    project: { id: 'proj1', name: 'p' } as any,
    opportunityId: 'o1',
    publishing,
    pollIntervalMs: 1,
    maxPolls: 1,
    deps: deps as any,
  });
  assert.equal(submitted?.publishingTopology, 'confirmed_individual_author');
  assert.equal(submitted?.authorFactsConfirmed, true);
  assert.deepEqual(submitted?.authorFacts, publishing.authorFacts);
});

test('autoApproveAndGenerate does not invent a publishing contract for a fresh request', async () => {
  const base = makeDeps().deps;
  let submitted: Record<string, unknown> | undefined;
  const deps = {
    ...base,
    api: {
      ...base.api,
      generations: {
        create: async (input: Record<string, unknown>) => {
          submitted = input;
          return { id: 'job1', status: 'completed', projectId: 'proj1', topic: 't', mode: 'simple', candidates: [] };
        },
        get: base.api.generations.get,
      },
    },
  };
  await autoApproveAndGenerate({
    project: { id: 'proj1', name: 'p' } as any,
    opportunityId: 'o1',
    pollIntervalMs: 1,
    maxPolls: 1,
    deps: deps as any,
  });
  assert.equal(Object.hasOwn(submitted ?? {}, 'publishingTopology'), false);
  assert.equal(Object.hasOwn(submitted ?? {}, 'authorFacts'), false);
  assert.equal(Object.hasOwn(submitted ?? {}, 'authorFactsConfirmed'), false);
});

test('autoApproveAndGenerate calls onProgress with each polled job', async () => {
  const base = makeDeps().deps;
  let n = 0;
  const deps = {
    ...base,
    api: {
      ...base.api,
      generations: {
        create: async () => ({ id: 'job1', status: 'queued', projectId: 'proj1', topic: 't', mode: 'simple' }),
        get: async () => {
          n += 1;
          return n >= 2
            ? { id: 'job1', projectId: 'proj1', topic: 't', mode: 'simple', status: 'completed', progress: 100, candidates: [] }
            : { id: 'job1', projectId: 'proj1', topic: 't', mode: 'simple', status: 'running', progress: 44 };
        },
      },
    },
  };
  const seen: Array<{ id: string; status: string; progress?: number }> = [];
  const project = { id: 'proj1', name: 'p' } as any;
  await autoApproveAndGenerate({
    project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 5,
    onProgress: (job) => seen.push({ id: job.id, status: job.status, progress: job.progress }),
    deps: deps as any,
  });
  // created 一次 + 每次轮询各一次,进度逐次送达
  assert.deepEqual(seen.map((s) => s.progress), [undefined, 44, 100]);
  assert.deepEqual(seen.map((s) => s.status), ['queued', 'running', 'completed']);
  assert.ok(seen.every((s) => s.id === 'job1'));
});

test('autoApproveAndGenerate forwards imageAssetIds into buildInput', async () => {
  const seen: { imageAssetIds?: unknown } = {};
  const base = makeDeps().deps;
  const deps = {
    ...base,
    buildInput: (arg: { imageAssetIds?: unknown }) => {
      seen.imageAssetIds = arg.imageAssetIds;
      return { projectId: 'proj1', mode: 'simple', opportunityId: 'o1', topic: 't', goal: 'w', audienceStage: 'hesitation', entryPoint: 'x' };
    },
  };
  const project = { id: 'proj1', name: 'p' } as any;
  await autoApproveAndGenerate({ project, opportunityId: 'o1', imageAssetIds: ['a1', 'a2'], pollIntervalMs: 1, maxPolls: 5, deps: deps as any });
  assert.deepEqual(seen.imageAssetIds, ['a1', 'a2']);
});

test('autoApproveAndGenerate defaults imageAssetIds to []', async () => {
  const seen: { imageAssetIds?: unknown } = {};
  const base = makeDeps().deps;
  const deps = {
    ...base,
    buildInput: (arg: { imageAssetIds?: unknown }) => {
      seen.imageAssetIds = arg.imageAssetIds;
      return { projectId: 'proj1', mode: 'simple', opportunityId: 'o1', topic: 't', goal: 'w', audienceStage: 'hesitation', entryPoint: 'x' };
    },
  };
  const project = { id: 'proj1', name: 'p' } as any;
  await autoApproveAndGenerate({ project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 5, deps: deps as any });
  assert.deepEqual(seen.imageAssetIds, []);
});

// 返回 { ...deps, calls }:calls 直接挂在 deps 上,断言写 deps.calls。
// 多出来的 calls 键对 reviseCandidate 无影响(它只读 api)。
function makeReviseDeps(reviseImpl: () => Promise<any>, getImpl?: () => Promise<any>) {
  const calls: string[] = [];
  const deps = {
    api: {
      generations: {
        revise: async (jobId: string, candidateId: string, instruction: string) => {
          calls.push(`revise:${jobId}:${candidateId}:${instruction}`);
          return reviseImpl();
        },
        get: async (id: string) => { calls.push(`get:${id}`); return getImpl ? getImpl() : { id: 'job1', status: 'completed', progress: 100 }; },
      },
    },
  };
  return { ...deps, calls };
}

test('reviseCandidate:受理后轮询到修改任务终态才返回', async () => {
  // 异步化后 revise 立即返回,此时 activeRevision 还在跑;函数必须等它到终态。
  // 注意 job.status 全程是 completed——旧实现按它判断,于是一次都不轮询就返回了。
  const running = {
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev1', candidateId: 'c1', status: 'running', progress: 40, rerunChannels: [] },
  };
  const done = {
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev1', candidateId: 'c1', status: 'completed', progress: 100, rerunChannels: ['N.body'] },
  };
  const deps = makeReviseDeps(async () => running, async () => done);
  const job = await reviseCandidate({
    jobId: 'job1', candidateId: 'c1', instruction: '标题再口语化一点',
    pollIntervalMs: 1, maxPolls: 5, deps: deps as any,
  });
  assert.equal(job.activeRevision?.status, 'completed');
  assert.deepEqual(deps.calls, ['revise:job1:c1:标题再口语化一点', 'get:job1']);
});

test('reviseCandidate:修改任务失败时抛出服务端给的原因', async () => {
  const failed = {
    id: 'job1', status: 'completed',
    activeRevision: {
      id: 'rev1', candidateId: 'c1', status: 'failed', progress: 100, rerunChannels: [],
      error: '模型服务暂时不可用，修改没有完成。已退还本次额度，请稍后重试；若持续失败请联系客服。',
    },
  };
  const deps = makeReviseDeps(async () => failed);
  await assert.rejects(
    () => reviseCandidate({ jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, deps: deps as any }),
    /模型服务暂时不可用/u,
  );
});

test('reviseCandidate:受理时没有修改任务就直接返回,不空转', async () => {
  // 服务端若因为幂等等原因没有建任务,不该在这里等到 maxPolls 超时。
  const deps = makeReviseDeps(async () => ({ id: 'job1', status: 'completed' }));
  const job = await reviseCandidate({
    jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 3, deps: deps as any,
  });
  assert.equal(job.id, 'job1');
  assert.deepEqual(deps.calls, ['revise:job1:c1:x']);
});

/*
 * 同 job 的第二个候选被后端拒(409)时,必须把错误抛出去,不能报成「已按意见修改」。
 *
 * 互斥现在是 job 级(revision_tasks_active_job_idx):A 候选在改时,另一标签页改 B 候选
 * 会拿到 409。把它吞掉、返回受理前的 job,ResultTab 就会拿未更新的旧候选去 toast
 * 「已按意见修改」——那正是假成功的用户可见形态,只是换了触发点。
 */
test('reviseCandidate:受理被 409 拒绝时抛错,不报成已修改', async () => {
  const deps = makeReviseDeps(async () => {
    throw new Error('这篇稿子还有一次修改正在进行，请等它完成后再提交');
  });
  await assert.rejects(
    () => reviseCandidate({ jobId: 'job1', candidateId: 'c2', instruction: 'x', pollIntervalMs: 1, deps: deps as any }),
    /还有一次修改正在进行/u,
  );
  assert.deepEqual(deps.calls, ['revise:job1:c2:x'], '受理失败后不该继续轮询');
});

test('reviseCandidate:activeRevision 属于别的候选时不去等它', async () => {
  // 投影 activeFor(jobId) 是任务级的(一个 job 只回一条活跃任务),而本函数关心的是
  // **本次**提交的那个候选。不按 candidateId 过滤就会等别人的任务、抛别人的错、画别人的
  // 进度条——历史上包级互斥让同 job 两个候选能并发改稿,那时这是常态;现在互斥收到 job
  // 级,这条过滤仍是必要的:投影也会带出上一次(别的候选的)终态任务。
  // 与 Task 6 的 revisionBoxState(candidateId) 同一口径。
  const other = {
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev-other', candidateId: 'c2', status: 'running', progress: 40, rerunChannels: [] },
  };
  const deps = makeReviseDeps(async () => other, async () => other);
  const job = await reviseCandidate({
    jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 3, deps: deps as any,
  });
  assert.equal(job.id, 'job1');
  assert.deepEqual(deps.calls, ['revise:job1:c1:x'], '不该为别的候选轮询');
});

test('reviseCandidate:别的候选修改失败不该报到本次调用头上', async () => {
  const deps = makeReviseDeps(async () => ({
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev-other', candidateId: 'c2', status: 'failed', progress: 100, rerunChannels: [], error: '别人的失败原因' },
  }));
  const job = await reviseCandidate({
    jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 3, deps: deps as any,
  });
  assert.equal(job.id, 'job1');
});

test('reviseCandidate:onProgress 在受理时与每次轮询后各送一次', async () => {
  // ResultTab 的进度条只有这一条数据来源(它读 j.activeRevision.progress)。
  // 没有这条断言,删掉那两行 args.onProgress?.(job) 不会有任何测试变红。
  const deps = makeReviseDeps(
    async () => ({
      id: 'job1', status: 'completed',
      activeRevision: { id: 'rev1', candidateId: 'c1', status: 'queued', progress: 0, rerunChannels: [] },
    }),
    (() => {
      let n = 0;
      return async () => {
        n += 1;
        return n >= 2
          ? { id: 'job1', status: 'completed', activeRevision: { id: 'rev1', candidateId: 'c1', status: 'completed', progress: 100, rerunChannels: ['N.body'] } }
          : { id: 'job1', status: 'completed', activeRevision: { id: 'rev1', candidateId: 'c1', status: 'running', progress: 40, rerunChannels: [] } };
      };
    })(),
  );
  const seen: Array<{ status?: string; progress?: number }> = [];
  await reviseCandidate({
    jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 5,
    onProgress: (j) => seen.push({ status: j.activeRevision?.status, progress: j.activeRevision?.progress }),
    deps: deps as any,
  });
  // 受理一次 + 每次轮询各一次;进度取自 activeRevision 而不是 job.progress
  assert.deepEqual(seen.map((s) => s.status), ['queued', 'running', 'completed']);
  assert.deepEqual(seen.map((s) => s.progress), [0, 40, 100]);
});

test('reviseCandidate:修改任务失败且服务端没给原因时用兜底文案', async () => {
  // 失败判定同样落在 activeRevision 上:job.status 改稿期间恒为 completed。
  const deps = makeReviseDeps(async () => ({
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev1', candidateId: 'c1', status: 'failed', progress: 100, rerunChannels: [] },
  }));
  await assert.rejects(
    () => reviseCandidate({ jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 5, deps: deps as any }),
    /修改失败，请重试/,
  );
});

// ── 批量审批:批量提交前必须逐个选题走完审批链,否则后端 selectOpportunity 会拒绝 ──

test('approveOpportunitiesForBatch approves blueprint/intelligence once and every opportunity', async () => {
  const calls: string[] = [];
  const deps = {
    api: {
      blueprintModules: {
        list: async () => { calls.push('bp.list'); return [{ id: 'b1', status: 'draft' }]; },
        approve: async (_p: string, id: string) => { calls.push(`bp.approve:${id}`); return { id }; },
      },
      intelligence: {
        get: async () => { calls.push('intel.get'); return { id: 'i1', approvalStatus: 'draft' }; },
        approve: async (_p: string, id: string) => { calls.push(`intel.approve:${id}`); return { id }; },
      },
      informationGaps: {
        list: async () => ({ items: [{ id: 'g1', status: 'draft' }, { id: 'g2', status: 'draft' }], total: 2 }),
        approve: async (_p: string, id: string) => { calls.push(`gap.approve:${id}`); return { id }; },
      },
      expressionStrategies: {
        list: async () => ({ items: [{ id: 's1', status: 'draft' }, { id: 's2', status: 'draft' }], total: 2 }),
        approve: async (_p: string, id: string) => { calls.push(`strat.approve:${id}`); return { id }; },
      },
      opportunities: {
        list: async () => ({ items: [
          { id: 'o1', title: 'A', gapIds: ['g1'], strategyId: 's1', compatibleStrategyIds: [] },
          { id: 'o2', title: 'B', gapIds: ['g2'], strategyId: 's2', compatibleStrategyIds: [] },
        ], total: 2 }),
        approve: async (_p: string, id: string) => { calls.push(`opp.approve:${id}`); return { id }; },
      },
    },
  };
  const project = { id: 'proj1', name: 'p' } as any;
  const approved = await approveOpportunitiesForBatch({ project, opportunityIds: ['o1', 'o2'], deps: deps as any });

  assert.deepEqual(approved.map((o) => o.id), ['o1', 'o2']);
  // 蓝图与 intelligence 只审批一次(不按选题数重复)
  assert.equal(calls.filter((c) => c === 'bp.approve:b1').length, 1);
  assert.equal(calls.filter((c) => c === 'intel.approve:i1').length, 1);
  // 每个选题的依赖与自身都审批了
  assert.ok(calls.includes('gap.approve:g1') && calls.includes('gap.approve:g2'));
  assert.ok(calls.includes('strat.approve:s1') && calls.includes('strat.approve:s2'));
  assert.ok(calls.includes('opp.approve:o1') && calls.includes('opp.approve:o2'));
  // intelligence 必须在任一选题审批之前
  assert.ok(calls.indexOf('intel.approve:i1') < calls.indexOf('opp.approve:o1'));
  assert.ok(calls.indexOf('intel.approve:i1') < calls.indexOf('opp.approve:o2'));
});

test('approveOpportunitiesForBatch skips historical stale blueprint versions', async () => {
  const calls: string[] = [];
  const deps = {
    api: {
      blueprintModules: {
        list: async () => [
          { id: 'current', moduleKey: 'role_model', status: 'approved' },
          { id: 'historical', moduleKey: 'role_model', status: 'stale' },
          { id: 'draft', moduleKey: 'claim_policy', status: 'draft' },
        ],
        approve: async (_projectId: string, id: string) => { calls.push(id); return { id }; },
      },
      intelligence: { get: async () => ({ id: 'i1', approvalStatus: 'approved' }), approve: async () => ({}) },
      informationGaps: { list: async () => ({ items: [], total: 0 }), approve: async () => ({}) },
      expressionStrategies: { list: async () => ({ items: [], total: 0 }), approve: async () => ({}) },
      opportunities: {
        list: async () => ({ items: [{ id: 'o1', title: 'A', gapIds: [] }], total: 1 }),
        approve: async () => ({}),
      },
    },
  };

  await approveOpportunitiesForBatch({
    project: { id: 'proj1', name: 'p' } as any,
    opportunityIds: ['o1'],
    deps: deps as any,
  });

  assert.deepEqual(calls, ['draft']);
});

test('approveOpportunitiesForBatch rejects a stale opportunity before any approval write', async () => {
  const calls: string[] = [];
  const deps = {
    api: {
      opportunities: {
        list: async () => ({ items: [{ id: 'stale-o', status: 'stale', gapIds: [] }], total: 1 }),
        approve: async () => { calls.push('opportunity.approve'); return {}; },
      },
      blueprintModules: {
        list: async () => { calls.push('blueprint.list'); return [{ id: 'draft', status: 'draft' }]; },
        approve: async () => { calls.push('blueprint.approve'); return {}; },
      },
      intelligence: {
        get: async () => { calls.push('intelligence.get'); return { id: 'i1', approvalStatus: 'draft' }; },
        approve: async () => { calls.push('intelligence.approve'); return {}; },
      },
      informationGaps: { list: async () => { calls.push('gaps.list'); return { items: [], total: 0 }; }, approve: async () => ({}) },
      expressionStrategies: { list: async () => { calls.push('strategies.list'); return { items: [], total: 0 }; }, approve: async () => ({}) },
    },
  };

  await assert.rejects(
    () => approveOpportunitiesForBatch({
      project: { id: 'proj1', name: 'p' } as any,
      opportunityIds: ['stale-o'],
      deps: deps as any,
    }),
    /失效|阻断/,
  );
  assert.deepEqual(calls, []);
});

test('approveOpportunitiesForBatch does not approve compatible strategy suggestions', async () => {
  const calls: string[] = [];
  const deps = {
    api: {
      blueprintModules: { list: async () => [], approve: async () => ({}) },
      intelligence: { get: async () => ({ id: 'i1', approvalStatus: 'approved' }), approve: async () => ({}) },
      informationGaps: { list: async () => ({ items: [], total: 0 }), approve: async () => ({}) },
      expressionStrategies: {
        list: async () => ({
          items: [{ id: 'strategy-explicit', status: 'draft' }, { id: 'strategy-compatible', status: 'draft' }],
          total: 2,
        }),
        approve: async (_projectId: string, id: string) => { calls.push(`strategy:${id}`); return { id }; },
      },
      opportunities: {
        list: async () => ({
          items: [{
            id: 'o1', title: 'A', gapIds: [], strategyId: 'strategy-explicit',
            compatibleStrategyIds: ['strategy-compatible'],
          }],
          total: 1,
        }),
        approve: async (_projectId: string, id: string) => { calls.push(`opportunity:${id}`); return { id }; },
      },
    },
  };

  await approveOpportunitiesForBatch({
    project: { id: 'proj1', name: 'p' } as any,
    opportunityIds: ['o1'],
    deps: deps as any,
  });

  assert.ok(calls.includes('strategy:strategy-explicit'), '显式 strategyId 必须获批');
  assert.equal(
    calls.includes('strategy:strategy-compatible'),
    false,
    'compatibleStrategyIds 只是建议，不得产生审批副作用',
  );
});

test('approveOpportunitiesForBatch rejects when an opportunity disappeared', async () => {
  const deps = {
    api: {
      blueprintModules: { list: async () => [], approve: async () => ({}) },
      intelligence: { get: async () => ({ id: 'i1', approvalStatus: 'approved' }), approve: async () => ({}) },
      informationGaps: { list: async () => ({ items: [], total: 0 }), approve: async () => ({}) },
      expressionStrategies: { list: async () => ({ items: [], total: 0 }), approve: async () => ({}) },
      opportunities: { list: async () => ({ items: [{ id: 'o1', title: 'A' }], total: 1 }), approve: async () => ({}) },
    },
  };
  const project = { id: 'proj1', name: 'p' } as any;
  await assert.rejects(
    () => approveOpportunitiesForBatch({ project, opportunityIds: ['o1', 'oX'], deps: deps as any }),
    /选题/,
  );
});

// 轮询上限到了不等于任务失败:后端 process() 由 setImmediate 独立驱动,不看 HTTP 连接。
// 这两个用例锁住「抛 GenerationStillRunningError 而不是普通 Error」,因为壳的 fail()
// 靠这个类型把提示从「请稍后重试」(会派出重复任务) 改成「去产出区看进度」,并带 jobId 定位。
test('autoApproveAndGenerate 轮询用尽时抛 GenerationStillRunningError 并带上 jobId', async () => {
  const { deps } = makeDeps({
    api: {
      ...makeDeps().deps.api,
      generations: {
        create: async () => ({ id: 'job1', status: 'queued', projectId: 'proj1', topic: 't', mode: 'simple' }),
        // 永远 running:模拟后端还在跑
        get: async () => ({ id: 'job1', projectId: 'proj1', topic: 't', mode: 'simple', status: 'running', progress: 60 }),
      },
    },
  });
  const project = { id: 'proj1', name: 'p' } as any;
  const err = await autoApproveAndGenerate({ project, opportunityId: 'o1', pollIntervalMs: 1, maxPolls: 2, deps: deps as any })
    .then(() => null, (e) => e);
  assert.ok(err instanceof GenerationStillRunningError, '应是 GenerationStillRunningError');
  assert.equal(err.jobId, 'job1');
  assert.match(err.message, /产出/);
  assert.doesNotMatch(err.message, /重试/, '不能劝用户重试:会派出第二个任务');
});

test('reviseCandidate 轮询用尽时同样抛 GenerationStillRunningError', async () => {
  // 「还在跑」的判据是 activeRevision 一直停在 running,而不是 job.status。
  const inFlight = {
    id: 'job1', status: 'completed',
    activeRevision: { id: 'rev1', candidateId: 'c1', status: 'running', progress: 40, rerunChannels: [] },
  };
  const deps = makeReviseDeps(async () => inFlight, async () => inFlight);
  const err = await reviseCandidate({ jobId: 'job1', candidateId: 'c1', instruction: 'x', pollIntervalMs: 1, maxPolls: 2, deps: deps as any })
    .then(() => null, (e) => e);
  assert.ok(err instanceof GenerationStillRunningError, '应是 GenerationStillRunningError');
  assert.equal(err.jobId, 'job1');
});

// 发布执行方案要在创作区就能看到(不只是产出区),所以 view 必须带上它。
// 原来 quickCandidateFields 把 deploymentPlan 丢了,创作区拿不到。
test('quickCandidateFields 保留 deploymentPlan 与 unknowns', () => {
  const view = quickCandidateFields({
    ...fullCandidate,
    deploymentPlan: { postingIdentity: 'publisher', sla: '24h 内答复' },
    unknowns: ['保修范围是什么'],
  } as any);
  assert.equal((view.deploymentPlan as any)?.postingIdentity, 'publisher');
  assert.deepEqual(view.unknowns, ['保修范围是什么']);
});

test('quickCandidateFields 在缺 deploymentPlan 时不报错', () => {
  const view = quickCandidateFields({ id: 'c9', title: 't', body: 'b', tags: [], comments: [] } as any);
  assert.equal(view.deploymentPlan, undefined);
  assert.equal(view.unknowns, undefined);
});
