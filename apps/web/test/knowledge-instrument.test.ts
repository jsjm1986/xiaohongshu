import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  actionableGaps,
  categoryCoverage,
  fileStats,
  historyVersions,
  latestFiles,
  preflightHeadline,
  TIER_LABEL,
  TIER_NOTE,
  TIER_TONE,
} from '../src/lib/knowledge-instrument';
import type { KnowledgeFile, KnowledgePreflight, KnowledgePreflightGap } from '../src/types';

/**
 * 知识库仪表盘的取数。
 *
 * 核心是版本折叠:`/api/knowledge` 返回同名文件的全部版本,页面此前直接按行计数,
 * 于是一份资料被 AI 补充过一次就显示「文件总数 2 份」、字节数两版相加、
 * 同一份资料在「已知事实」和「推理与猜想」里各占一个计数。
 */

function file(overrides: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    id: 'f1',
    projectId: 'p1',
    name: 'INDEX.md',
    size: 1000,
    version: 1,
    kind: '已知事实',
    category: '未分类',
    ...overrides,
  };
}

test('同名多版本折叠成一份,取最高版本', () => {
  const files = [
    file({ id: 'v1', version: 1, kind: '已知事实', size: 1000 }),
    file({ id: 'v2', version: 2, kind: '猜想', size: 1100 }),
  ];
  const latest = latestFiles(files);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.id, 'v2', '必须取最高版本,生成端读的就是它');
});

test('乱序传入也取最高版本', () => {
  const files = [file({ id: 'v2', version: 2 }), file({ id: 'v1', version: 1 })];
  assert.equal(latestFiles(files)[0]?.id, 'v2');
});

test('份数与字节都按生效版本算:这是截图里那组数字的病根', () => {
  // 线上实测的形态:原文 v1「已知事实」11KB,AI 补充后 v2「猜想」11KB。
  // 旧算法 → 2 份 / 22KB / 已知事实 1 份 / 推理与猜想 1 份,四个数字全错。
  const stats = fileStats([
    file({ id: 'v1', version: 1, kind: '已知事实', size: 11_000 }),
    file({ id: 'v2', version: 2, kind: '猜想', size: 11_000 }),
  ]);
  assert.equal(stats.fileCount, 1, '一份资料');
  assert.equal(stats.versionCount, 2, '两个版本');
  assert.equal(stats.totalBytes, 11_000, '不能把两版字节相加');
  assert.equal(stats.fact, 0, '生效版本是猜想,不该再算作可直接引用的已知事实');
  assert.equal(stats.reasoning, 1);
});

test('多个不同文件各计一份', () => {
  const stats = fileStats([
    file({ id: 'a', name: 'a.md', kind: '已知事实', size: 100 }),
    file({ id: 'b', name: 'b.md', kind: '禁止表达', size: 200 }),
    file({ id: 'b2', name: 'b.md', version: 2, kind: '禁止表达', size: 250 }),
  ]);
  assert.equal(stats.fileCount, 2);
  assert.equal(stats.totalBytes, 350, '100 + 250,不含 b 的 v1');
  assert.equal(stats.banned, 1);
});

test('version 缺省当 1,不因载荷异常崩掉', () => {
  const stats = fileStats([file({ id: 'x', version: undefined }), file({ id: 'y', version: 2 })]);
  assert.equal(stats.fileCount, 1);
  assert.equal(latestFiles([file({ id: 'x', version: undefined }), file({ id: 'y', version: 2 })])[0]?.id, 'y');
});

test('空列表不产生 NaN', () => {
  const stats = fileStats([]);
  assert.equal(stats.fileCount, 0);
  assert.equal(stats.totalBytes, 0);
});

test('历史版本按版本号倒序,不含最新版', () => {
  const files = [
    file({ id: 'v1', version: 1 }),
    file({ id: 'v3', version: 3 }),
    file({ id: 'v2', version: 2 }),
    file({ id: 'other', name: 'other.md', version: 1 }),
  ];
  assert.deepEqual(historyVersions(files, 'INDEX.md').map((item) => item.id), ['v2', 'v1']);
  assert.deepEqual(historyVersions(files, 'other.md'), []);
});

function gap(overrides: Partial<KnowledgePreflightGap> = {}): KnowledgePreflightGap {
  return {
    id: 'g1',
    label: '缺口',
    status: 'approved',
    required: false,
    category: 'decision',
    tier: 'evidence_backed',
    sectionEvidenceIds: [],
    staleDeclaredEvidenceIds: [],
    reasons: [],
    ...overrides,
  };
}

function preflight(overrides: Partial<KnowledgePreflight> = {}): KnowledgePreflight {
  return {
    analysis: 'approved',
    canGenerate: true,
    requiredOpen: [],
    tiers: { evidence_backed: 0, approved_only: 0, evidence_stale: 0, will_be_dropped: 0, blank: 0 },
    byCategory: [],
    gaps: [],
    warnings: [],
    note: '说明',
    ...overrides,
  };
}

test('刚传完资料还没分析 → 说下一步是做分析,不能说「可以生成」', () => {
  /*
   * 这是实际踩到的缺陷:用户上传知识库后页面显示「可以生成,缺口都已落实」。
   * 那时缺口数为 0、tiers 全 0、requiredOpen 为空,和「全部落实」在数据上一样,
   * 但生成会被 prepareGenerationPlan 拦掉。
   */
  const view = preflightHeadline(preflight({ analysis: 'missing', canGenerate: false }));
  assert.equal(view?.needsAnalysis, true);
  assert.match(view!.text, /做项目分析/u);
  assert.doesNotMatch(view!.text, /可以生成/u);
  assert.ok(view!.nextStep.length > 0, '必须给出下一步说明');
});

test('指路指向科研版的「内容生成」,不指快捷版', () => {
  /*
   * 这个页面属于科研版。第一版把「去分析」跳到了 /quick/:id/knowledge(基础版工作台),
   * 是串了产品线——科研版的分析 UI 在 /generate(GeneratorPage 默认 simple 模式渲染
   * IntelligentSimpleFlow,项目分析、蓝图确认、缺口池都在那里)。
   */
  for (const analysis of ['missing', 'stale', 'draft'] as const) {
    const view = preflightHeadline(preflight({ analysis, canGenerate: false }));
    assert.match(view!.nextStep, /内容生成/u, `${analysis} 应指向「内容生成」`);
    assert.doesNotMatch(view!.nextStep, /快捷|工作台/u, `${analysis} 不该把用户送去快捷版`);
  }
});

test('分析失效 → 说要重新分析', () => {
  const view = preflightHeadline(preflight({ analysis: 'stale', canGenerate: false }));
  assert.equal(view?.needsAnalysis, true);
  assert.match(view!.text, /重新分析/u);
});

test('资料变动后的待办条要说明缺口和证据都会被更新', () => {
  /*
   * 用户实际卡住的地方:补充保存后以为完事了,结果缺口还在、证据全失效。
   * 待办条要把「重新分析会一并更新缺口与证据引用」说出来,否则用户会去
   * 逐条手工重选证据——那是错的动作,evidenceId 含 documentId,
   * 一次保存会让该文件所有引用同时失效。
   */
  const view = preflightHeadline(preflight({ analysis: 'stale', canGenerate: false }));
  assert.equal(view?.needsAnalysis, true);
  assert.match(view!.nextStep, /缺口/u);
  assert.match(view!.nextStep, /证据|引用/u);
  /*
   * 禁的是「指示用户去逐条重选」,不是「逐条」这三个字。
   * 计划原本写的是 doesNotMatch(/逐条|重新选择/),但它自己给的文案是
   * 「不需要你逐条重选」——明确否定该动作,恰是想要的语义,却被字面断言判红。
   * 所以提到逐条/重选时必须带否定词,否则就是在指示用户白做工。
   */
  const mentionsReselect = /逐条|重新选择|重选/u.test(view!.nextStep);
  const negated = /(不需要|无需|不用)[^。]{0,8}(逐条|重新选择|重选)/u.test(view!.nextStep);
  assert.equal(mentionsReselect && !negated, false, `不该指示用户逐条重选:${view!.nextStep}`);
});

test('分析完成但未确认 → 说要确认', () => {
  const view = preflightHeadline(preflight({ analysis: 'draft', canGenerate: false }));
  assert.equal(view?.needsAnalysis, true);
  assert.match(view!.text, /确认/u);
});

test('分析未就绪时,即便缺口层面没问题也不说可以生成', () => {
  // 顺序要紧:分析状态必须先判,否则 tiers 全 0 会走到「缺口都已落实」那一支。
  for (const analysis of ['missing', 'stale', 'draft'] as const) {
    const view = preflightHeadline(preflight({ analysis, canGenerate: false }));
    assert.doesNotMatch(view!.text, /可以生成/u, `analysis=${analysis} 不该说可以生成`);
  }
});

test('分析已确认且缺口都落实 → 才说可以生成,且不再提示去分析', () => {
  const view = preflightHeadline(preflight({
    analysis: 'approved',
    tiers: { evidence_backed: 8, approved_only: 9, evidence_stale: 0, will_be_dropped: 0, blank: 0 },
  }));
  assert.equal(view?.tone, 'ok');
  assert.equal(view?.needsAnalysis, false);
  assert.match(view!.text, /可以生成/u);
});

test('必答缺口没落实 → 主结论说还不能生成', () => {
  const view = preflightHeadline(preflight({
    canGenerate: false,
    requiredOpen: [{ id: 'g1', label: '资质编号', tier: 'will_be_dropped' }],
    tiers: { evidence_backed: 3, approved_only: 0, evidence_stale: 0, will_be_dropped: 1, blank: 0 },
  }));
  assert.equal(view?.tone, 'error');
  assert.match(view!.text, /还不能生成/u);
});

test('能生成但有答案会被丢弃 → 仍要告警,不能只说可以生成', () => {
  const view = preflightHeadline(preflight({
    tiers: { evidence_backed: 5, approved_only: 2, evidence_stale: 0, will_be_dropped: 2, blank: 0 },
  }));
  assert.equal(view?.tone, 'warn');
  assert.match(view!.text, /2 条答案会被丢弃/u);
  assert.equal(view?.actionable, 2);
});

test('全部落实 → ok', () => {
  const view = preflightHeadline(preflight({
    tiers: { evidence_backed: 8, approved_only: 9, evidence_stale: 0, will_be_dropped: 0, blank: 0 },
  }));
  assert.equal(view?.tone, 'ok');
  assert.equal(view?.actionable, 0);
});

test('主结论不使用「N/M」比率:分母是模型每轮随机给的,跨轮不可比', () => {
  const view = preflightHeadline(preflight({
    tiers: { evidence_backed: 16, approved_only: 0, evidence_stale: 0, will_be_dropped: 0, blank: 1 },
  }));
  assert.doesNotMatch(view!.text, /\d+\s*\/\s*\d+/u, '不得出现 16/17 这类比率');
});

test('没有预检结果时返回 null,不编造结论', () => {
  assert.equal(preflightHeadline(null), null);
  assert.deepEqual(categoryCoverage(null), []);
  assert.deepEqual(actionableGaps(null), []);
});

test('分类覆盖:缺得多的排前面', () => {
  const rows = categoryCoverage(preflight({
    byCategory: [
      { category: 'decision', total: 5, settled: 5 },
      { category: 'trust', total: 6, settled: 0 },
      { category: 'price', total: 2, settled: 1 },
    ],
  }));
  assert.deepEqual(rows.map((row) => row.category), ['trust', 'price', 'decision']);
});

test('待处理缺口:必答优先,会丢弃排在无答案之前', () => {
  const rows = actionableGaps(preflight({
    gaps: [
      gap({ id: 'blank', tier: 'blank' }),
      gap({ id: 'dropped', tier: 'will_be_dropped' }),
      gap({ id: 'ok', tier: 'evidence_backed' }),
      gap({ id: 'requiredBlank', tier: 'blank', required: true }),
    ],
  }));
  assert.deepEqual(rows.map((row) => row.id), ['requiredBlank', 'dropped', 'blank']);
});

test('引用失效的缺口也算待处理,即使答案本身有资料支撑', () => {
  const rows = actionableGaps(preflight({
    gaps: [gap({ id: 'stale', tier: 'evidence_backed', staleDeclaredEvidenceIds: ['e-gone'] })],
  }));
  assert.deepEqual(rows.map((row) => row.id), ['stale']);
});

test('仅人工确认这一档的说明必须点明它不是资料里的事实', () => {
  // 这是整个功能的要点:此前界面把它和「已知事实」一起显示成「可直接引用」。
  assert.match(TIER_NOTE.approved_only, /不是资料里的事实/u);
  assert.match(TIER_NOTE.will_be_dropped, /丢掉/u);
});

test('三张档位表都有 evidence_stale 的格子,说明要指向重新分析', () => {
  // 标签不能只验非空:换成「有资料支撑」这种自相矛盾的说法也是非空的,
  // 而那正是本档要否认的意思——必须看得出引用出了问题。
  assert.match(TIER_LABEL.evidence_stale, /失效|引用/u);
  assert.ok(TIER_NOTE.evidence_stale.trim().length > 0);
  // tone 是字符串联合,断言非空没意义,直接钉具体值:它可修复且重新分析能自愈,
  // 与 blank 同级,不该用 error 吓人
  assert.equal(TIER_TONE.evidence_stale, 'warn');
  // 这一档唯一的出路是重新分析,说明里必须说出来
  assert.match(TIER_NOTE.evidence_stale, /重新分析/u);
  // 不能沿用「你填写并确认过」那套说法——本次修的就是这个谎
  assert.ok(!/你填写|确认过/u.test(TIER_NOTE.evidence_stale), TIER_NOTE.evidence_stale);
});

test('待处理排序:引用失效比「会被丢弃」轻,比「仅人工确认」重', () => {
  const gaps = [
    { id: 'a', label: '仅人工确认的', status: 'approved', required: false, category: '', tier: 'approved_only' as const, sectionEvidenceIds: [], staleDeclaredEvidenceIds: ['x'], reasons: [] },
    { id: 'b', label: '引用失效的', status: 'approved', required: false, category: '', tier: 'evidence_stale' as const, sectionEvidenceIds: [], staleDeclaredEvidenceIds: ['x'], reasons: [] },
    { id: 'c', label: '会被丢弃的', status: 'approved', required: false, category: '', tier: 'will_be_dropped' as const, sectionEvidenceIds: [], staleDeclaredEvidenceIds: [], reasons: [] },
  ];
  const ordered = actionableGaps(preflight({ gaps })).map((gap) => gap.id);
  assert.deepEqual(ordered, ['c', 'b', 'a']);
});

/**
 * 分析已确认 + 引用失效,是真实存在的组合(项目「眼袋王」:analysis 为 approved、
 * 零个知识文件、49 条 supplied_fact 缺口)。旧文案在这里说「改掉会被丢弃的答案
 * 格式」——改格式没用,要做的是重新分析。
 */
test('分析已确认但必答缺口引用失效 → 指向重新分析,并给出跳转', () => {
  const view = preflightHeadline(preflight({
    analysis: 'approved',
    canGenerate: false,
    requiredOpen: [{ id: 'g1', label: '易用性', tier: 'evidence_stale' }],
  }));
  assert.match(view!.nextStep, /重新分析/u);
  assert.equal(view?.needsAnalysis, true);
  // 不该让用户去改格式
  assert.ok(!/格式/u.test(view!.nextStep), view!.nextStep);
  /*
   * 主结论本身也要钉住。只断言 nextStep 的话,把 text 改成「可以生成,缺口都已落实」、
   * tone 改成 ok 都能活下来——一个引用全失效的项目被告知可以生成,恰是本次要根治的谎报。
   */
  assert.match(view!.text, /还不能生成/u);
  assert.match(view!.text, /引用已失效/u);
  assert.doesNotMatch(view!.text, /可以生成,/u);
  assert.equal(view?.tone, 'error');
});

test('必答缺口不是引用失效时,仍走原来的补资料/改格式文案', () => {
  const view = preflightHeadline(preflight({
    analysis: 'approved',
    canGenerate: false,
    // 混一条 evidence_stale:只有这样才能区分「全部失效」和「有失效」两个判据。
    // fixture 若只放 blank,把 === requiredOpen.length 写成 > 0 也照样绿。
    requiredOpen: [
      { id: 'g1', label: '价格信息', tier: 'blank' },
      { id: 'g2', label: '易用性', tier: 'evidence_stale' },
    ],
  }));
  // 混合情形不能整条说成「引用已失效」:另一条 blank 缺口重新分析救不回来,
  // 用户仍得去补资料/改格式。这里必须留住格式那半句,否则等于漏掉一半出路。
  assert.match(view!.nextStep, /格式/u);
  assert.match(view!.text, /没落实/u);
  assert.doesNotMatch(view!.text, /引用已失效/u);
  // 但也要点出其中有引用失效,并给跳转:重新分析是那部分缺口的唯一出路
  assert.match(view!.nextStep, /重新分析/u);
  assert.equal(view?.needsAnalysis, true);
});

test('必答缺口全无引用问题时,不提重新分析也不给跳转', () => {
  const view = preflightHeadline(preflight({
    analysis: 'approved',
    canGenerate: false,
    requiredOpen: [{ id: 'g1', label: '价格信息', tier: 'blank' }],
  }));
  assert.match(view!.nextStep, /资料|格式/u);
  assert.equal(view?.needsAnalysis, false);
});

/**
 * actionable 是「需要你动手的条数」,而 actionableGaps 是对应的清单。
 * 漏算 evidence_stale 会让这个数字比清单短——用户看到「2 条要处理」却列出 5 条。
 */
test('引用失效计入需要动手的条数,不能和待处理清单打架', () => {
  const view = preflightHeadline(preflight({
    tiers: { evidence_backed: 1, approved_only: 0, evidence_stale: 3, will_be_dropped: 2, blank: 1 },
  }));
  assert.equal(view?.actionable, 6);
});

/**
 * api.ts 的 PREFLIGHT_TIERS 是硬编码的第二份档位清单,而且是运行时数组、
 * 不触发 typecheck。漏掉新档时 preflightTier() 会把它静默改判成
 * will_be_dropped——新档一条都到不了界面,而 tiers.will_be_dropped 被虚增。
 * 唯一能兜住它的就是这条源码断言。
 */
test('api.ts 的运行时档位白名单认得 evidence_stale', () => {
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const match = /const PREFLIGHT_TIERS = \[([^\]]+)\]/u.exec(source);
  assert.ok(match, 'api.ts 里找不到 PREFLIGHT_TIERS');
  assert.match(match[1], /evidence_stale/u);
});
