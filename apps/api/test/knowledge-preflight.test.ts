import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analysisStateFrom,
  classifyGap,
  summarize,
  type PreflightGapInput,
} from '../src/knowledge-preflight.js';

/**
 * 知识库完善度预检的分档逻辑。
 *
 * 这套判据必须和生成端 bindGapEvidence 一致:无资料答案只有在来源明确为
 * user_supplied 且数据库冻结了批准人/批准时间时才可引用。文本中的换行、引号或
 * 反斜杠不再影响事实效力；没有真实审批元数据时任何格式都不能自证。
 */

function gap(overrides: Partial<PreflightGapInput> = {}): PreflightGapInput {
  return {
    id: 'g1',
    label: '整装报价包含哪些项',
    status: 'approved',
    required: false,
    answer: '',
    framework: '',
    declaredEvidenceIds: [],
    category: 'decision',
    sectionEvidenceIds: [],
    // 默认「项目里没有任何可用证据」,想测引用仍然存在的用例要显式传入。
    availableEvidenceIds: new Set<string>(),
    humanConfirmed: false,
    ...overrides,
  };
}

test('答案能在上传资料里找到支撑 → evidence_backed', () => {
  const result = classifyGap(gap({
    answer: '整装报价包含主材与人工',
    sectionEvidenceIds: ['evidence_section_abc123'],
  }));
  assert.equal(result.tier, 'evidence_backed');
  assert.deepEqual(result.sectionEvidenceIds, ['evidence_section_abc123']);
});

test('真实人工审批的单行答案无资料支撑 → approved_only', () => {
  const result = classifyGap(gap({ answer: '整装报价包含主材与人工', sourceStatus: 'user_supplied', humanConfirmed: true }));
  assert.equal(result.tier, 'approved_only');
  // 措辞必须说清依据来自人工确认,不能让用户以为这是资料里的事实
  assert.match(result.reasons.join(''), /项目负责人明确确认/u);
});

test('真实人工审批与文本格式无关:多行答案仍为 approved_only', () => {
  const result = classifyGap(gap({ answer: '整装报价包含主材\n不含家电', sourceStatus: 'user_supplied', humanConfirmed: true }));
  assert.equal(result.tier, 'approved_only');
});

test('真实人工审批与文本格式无关:半角双引号仍为 approved_only', () => {
  const result = classifyGap(gap({ answer: '报价按"套内面积"计算', sourceStatus: 'user_supplied', humanConfirmed: true }));
  assert.equal(result.tier, 'approved_only');
});

test('真实人工审批与文本格式无关:制表符和反斜杠仍为 approved_only', () => {
  assert.equal(classifyGap(gap({ answer: '主材\t人工', sourceStatus: 'user_supplied', humanConfirmed: true })).tier, 'approved_only');
  assert.equal(classifyGap(gap({ answer: '见 C:\\报价单', sourceStatus: 'user_supplied', humanConfirmed: true })).tier, 'approved_only');
});

test('仅有单行文本也不能自证', () => {
  assert.equal(classifyGap(gap({ answer: '报价按「套内面积」计算' })).tier, 'will_be_dropped');
  assert.equal(classifyGap(gap({ answer: '含主材、人工；不含家电。' })).tier, 'will_be_dropped');
});

test('没有答案 → blank', () => {
  assert.equal(classifyGap(gap()).tier, 'blank');
  assert.equal(classifyGap(gap({ answer: '   ' })).tier, 'blank');
});

test('只有 framework 也算提出了答案,与生成端 (answer || framework) 一致', () => {
  const result = classifyGap(gap({ framework: '按面积段位分档报价', sourceStatus: 'user_supplied', humanConfirmed: true }));
  assert.equal(result.tier, 'approved_only');
});

test('引用的证据确实不在项目里 → 报失效', () => {
  const result = classifyGap(gap({
    answer: '整装报价包含主材与人工',
    declaredEvidenceIds: ['evidence_section_gone1', 'evidence_section_gone2'],
    availableEvidenceIds: new Set(['evidence_section_other']),
  }));
  assert.deepEqual(result.staleDeclaredEvidenceIds, ['evidence_section_gone1', 'evidence_section_gone2']);
  assert.match(result.reasons.join(''), /已失效/u);
});

test('引用仍然存在、只是没支撑这条答案 → 不得报失效', () => {
  /*
   * 这是实际误报的形态。旧实现拿 sectionEvidenceIds(内容支撑这条答案的分节)当
   * 「存在的分节」,于是任何「引用有效但 conservativeEvidenceSupport 没匹配上答案」
   * 的缺口都被报成引用失效。线上实测:某项目 69 条引用里只有 1 条真失效,却报了 69 条,
   * 每条缺口都挂着「资料被改动或删除」的假警报。
   */
  const result = classifyGap(gap({
    answer: '手工填的答案,资料里没有原句',
    declaredEvidenceIds: ['evidence_section_alive'],
    sectionEvidenceIds: [],                                  // 没支撑这条答案
    availableEvidenceIds: new Set(['evidence_section_alive']), // 但它确实还在
  }));
  assert.deepEqual(result.staleDeclaredEvidenceIds, [], '引用还在就不能说失效');
  assert.doesNotMatch(result.reasons.join(''), /失效/u);
  // 引用仍存在不等于它支持答案；没有人工审批时仍会被丢弃。
  assert.equal(result.tier, 'will_be_dropped');
});

test('失效提示指向重新分析,不是让用户逐条重选', () => {
  // 引用批量失效多半是存了新版本导致 evidenceId 全变,重新分析一次全部更新;
  // 让用户对着几十条引用手工重选是错的指引。
  const result = classifyGap(gap({
    answer: '答案',
    declaredEvidenceIds: ['a', 'b', 'c'],
    availableEvidenceIds: new Set<string>(),
  }));
  assert.match(result.reasons.join(''), /重新分析/u);
  assert.doesNotMatch(result.reasons.join(''), /重新选择/u);
});

test('必答缺口站不住 → canGenerate=false 并列出它', () => {
  const rows = [
    classifyGap(gap({ id: 'ok', answer: '有支撑', sectionEvidenceIds: ['e1'] })),
    classifyGap(gap({ id: 'bad', label: '资质编号', required: true, answer: '多行\n答案' })),
  ];
  const summary = summarize(rows, 'approved');
  assert.equal(summary.canGenerate, false);
  assert.deepEqual(summary.requiredOpen, [{ id: 'bad', label: '资质编号', tier: 'will_be_dropped' }]);
});

test('必答缺口仅人工批准也算站得住:与生成端一致,不比它更严', () => {
  // 只有正式审批元数据才能与生成端构造的人工 EvidenceReference 对齐。
  const rows = [classifyGap(gap({ required: true, answer: '单行答案就够', sourceStatus: 'user_supplied', humanConfirmed: true }))];
  assert.equal(summarize(rows, 'approved').canGenerate, true);
});

test('空白的必答缺口同样阻断', () => {
  const rows = [classifyGap(gap({ required: true }))];
  const summary = summarize(rows, 'approved');
  assert.equal(summary.canGenerate, false);
  assert.equal(summary.requiredOpen[0]?.tier, 'blank');
});

test('分档计数与按分类覆盖', () => {
  const rows = [
    classifyGap(gap({ id: '1', category: 'decision', answer: 'a', sectionEvidenceIds: ['e1'] })),
    classifyGap(gap({ id: '2', category: 'decision', answer: '单行答案', sourceStatus: 'user_supplied', humanConfirmed: true })),
    classifyGap(gap({ id: '3', category: 'risk', answer: '多行\n答案' })),
    classifyGap(gap({ id: '4', category: '' })),
  ];
  const summary = summarize(rows);
  assert.deepEqual(summary.tiers, {
    evidence_backed: 1,
    approved_only: 1,
    evidence_stale: 0,
    will_be_dropped: 1,
    blank: 1,
  });
  /*
   * 按内容断言,不按顺序:跨字符集(中文 vs 拉丁)的 localeCompare 顺序取决于运行时
   * ICU 数据,拿它做断言会在别的 Node 版本上无故变红。同字符集内的顺序另测。
   */
  const byCategory = new Map(summary.byCategory.map((item) => [item.category, item]));
  assert.equal(summary.byCategory.length, 3);
  assert.deepEqual(byCategory.get('decision'), { category: 'decision', total: 2, settled: 2 });
  assert.deepEqual(byCategory.get('risk'), { category: 'risk', total: 1, settled: 0 });
  // 空分类要归到「未分类」,不能出现空字符串键
  assert.deepEqual(byCategory.get('未分类'), { category: '未分类', total: 1, settled: 0 });
});

test('同字符集内按分类名排序', () => {
  const rows = ['risk', 'decision', 'audience'].map((category, index) =>
    classifyGap(gap({ id: String(index), category })));
  assert.deepEqual(
    summarize(rows).byCategory.map((item) => item.category),
    ['audience', 'decision', 'risk'],
  );
});

test('空缺口列表在未分析时不能伪报可生成', () => {
  const summary = summarize([]);
  assert.equal(summary.analysis, 'missing');
  assert.equal(summary.canGenerate, false);
  assert.deepEqual(summary.requiredOpen, []);
  assert.deepEqual(summary.byCategory, []);
});

test('空缺口列表只有在分析已确认时才可生成', () => {
  const summary = summarize([], 'approved');
  assert.equal(summary.analysis, 'approved');
  assert.equal(summary.canGenerate, true);
});

test('分析未就绪 → canGenerate 恒为 false,缺口层面再干净也不行', () => {
  /*
   * 实际踩到的缺陷:刚上传完资料、一条缺口都还没有时 requiredOpen 为空,旧实现据此
   * 判 canGenerate=true,界面显示「可以生成,缺口都已落实」。而那时
   * prepareGenerationPlan 会抛「An approved project analysis is required」。
   */
  const clean = [classifyGap(gap({ required: true, answer: '有支撑', sectionEvidenceIds: ['e1'] }))];
  for (const state of ['missing', 'draft', 'stale'] as const) {
    assert.equal(summarize(clean, state).canGenerate, false, `${state}:缺口干净也不该判可生成`);
  }
  assert.equal(summarize(clean, 'approved').canGenerate, true, 'approved 且缺口干净才算就绪');
});

test('analysisStateFrom:认不出的状态一律当没分析', () => {
  assert.equal(analysisStateFrom('approved'), 'approved');
  assert.equal(analysisStateFrom('draft'), 'draft');
  assert.equal(analysisStateFrom('stale'), 'stale');
  // rejected 是建表允许的取值,但不满足生成条件,归到 missing 让用户重跑
  assert.equal(analysisStateFrom('rejected'), 'missing');
  assert.equal(analysisStateFrom(undefined), 'missing');
  assert.equal(analysisStateFrom(null), 'missing');
  assert.equal(analysisStateFrom('未来新增的状态'), 'missing');
});

/**
 * 引用失效不能说成「你填写并确认过」。
 *
 * 分析器判定 supplied_fact 的缺口,一旦资料存了新版本,evidenceId 全变,
 * 分节匹配就不中。旧逻辑于是落 approved_only 并声称「依据是你填写并确认过」——
 * 而用户从没填过这条。实测 18 条缺口 15 条被这么谎报。
 */
test('分析器给过出处、引用已失效 → 独立成 evidence_stale,不谎报成人工确认', () => {
  const result = classifyGap(gap({
    label: '易用性',
    answer: '不需要额外培训,前台四个核心价值即可上手',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sourceStatus: 'supplied_fact',
  }));
  assert.equal(result.tier, 'evidence_stale');
  assert.ok(result.reasons.some((reason) => /引用/u.test(reason)), result.reasons.join('|'));
  // 关键:不能再声称是用户填的
  assert.ok(!result.reasons.some((reason) => /你填写并确认过/u.test(reason)), result.reasons.join('|'));
  /*
   * 只说一遍。新档的首句已经交代了引用失效,末尾那段通用失效提示必须让开——
   * 同一件事播报两遍会让用户以为是两个独立问题。上面的 /引用/ 断言兜不住这点:
   * 它对「说一遍」和「说两遍」都成立,所以这里按条数断言。
   */
  assert.equal(result.reasons.filter((reason) => /失效/u.test(reason)).length, 1, result.reasons.join('|'));
});

test('没有失效引用作证时不进新档:supplied_fact 是上一轮的判定,不能凭它作保', () => {
  // 声明的引用都还在可用集合里 → 出处没断 → 落不进新档
  const result = classifyGap(gap({
    answer: '一句能自证的单行答案',
    declaredEvidenceIds: ['evidence_section_alive'],
    availableEvidenceIds: new Set(['evidence_section_alive']),
    sourceStatus: 'supplied_fact',
  }));
  assert.equal(result.tier, 'will_be_dropped');
});

test('user_supplied 还必须带真实审批元数据', () => {
  const unapproved = classifyGap(gap({ answer: '我到院面诊后才确定', sourceStatus: 'user_supplied' }));
  const approved = classifyGap(gap({ answer: '我到院面诊后才确定', sourceStatus: 'user_supplied', humanConfirmed: true }));
  assert.equal(unapproved.tier, 'will_be_dropped');
  assert.equal(approved.tier, 'approved_only');
});

test('内容仍能匹配上就仍算有资料支撑:引用失效不改变这个事实', () => {
  const result = classifyGap(gap({
    answer: '能匹配到分节的答案',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sectionEvidenceIds: ['evidence_section_hit'],
    availableEvidenceIds: new Set(['evidence_section_hit']),
    sourceStatus: 'supplied_fact',
  }));
  assert.equal(result.tier, 'evidence_backed');
});

test('supplied_fact 的失效引用不因文本格式改变分档', () => {
  const result = classifyGap(gap({
    answer: '第一行\n第二行',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sourceStatus: 'supplied_fact',
  }));
  assert.equal(result.tier, 'evidence_stale');
});

test('认不出的 sourceStatus 不进新档:库里真有 unacknowledged 这种值', () => {
  const result = classifyGap(gap({
    answer: '一句能自证的单行答案',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sourceStatus: 'unacknowledged',
  }));
  assert.equal(result.tier, 'will_be_dropped');
});

test('必答缺口落在 evidence_stale → 不算已落实,挣住生成', () => {
  const stale = classifyGap(gap({
    required: true,
    answer: '一句能自证的单行答案',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sourceStatus: 'supplied_fact',
  }));
  const summary = summarize([stale], 'approved');
  assert.equal(stale.tier, 'evidence_stale');
  assert.equal(summary.canGenerate, false);
  assert.equal(summary.requiredOpen.length, 1);
  assert.equal(summary.tiers.evidence_stale, 1);
});

/**
 * 非 approved 的必答缺口不该挣住生成。
 *
 * preflight() 读任何 status 的缺口行,而生成端只消费 status='approved' 的行
 * (intelligence.service.approvedRows)。一条 status='stale' 的必答缺口落进
 * evidence_stale 后会翻掉 canGenerate,面板说「还不能生成」并让用户去重新分析——
 * 但 insertAnalyzedGap 只插入、从不清理被取代的旧行,这条提示永远消不掉。
 * 实测项目「眼袋王」61 条 stale 缺口里正有 1 条必答。
 *
 * 分档展示仍要包含所有行(用户要看见全貌),但挣住生成只能由生成端真会消费的行决定。
 */
test('非 approved 的必答缺口不挣住生成:生成端根本不消费它', () => {
  const staleRow = classifyGap(gap({
    id: 'ghost',
    status: 'stale',
    required: true,
    answer: '一句能自证的单行答案',
    declaredEvidenceIds: ['evidence_section_deadbeef'],
    sourceStatus: 'supplied_fact',
  }));
  const summary = summarize([staleRow], 'approved');
  assert.equal(staleRow.tier, 'evidence_stale', '分档本身不变');
  assert.equal(summary.tiers.evidence_stale, 1, '仍要计入分档展示:用户要看见全貌');
  assert.equal(summary.requiredOpen.length, 0, '不该进 requiredOpen');
  assert.equal(summary.canGenerate, true, '生成端不消费这行,不能因它说不能生成');
});

test('非 approved 的行仍计入 byCategory,展示口径不缩水', () => {
  const rows = [
    classifyGap(gap({ id: 'a', status: 'draft', category: 'risk', answer: '多行\n答案' })),
    classifyGap(gap({ id: 'b', status: 'approved', category: 'risk', answer: 'x', sectionEvidenceIds: ['e1'] })),
  ];
  const summary = summarize(rows, 'approved');
  const risk = summary.byCategory.find((item) => item.category === 'risk');
  assert.equal(risk?.total, 2, '两行都要出现在覆盖统计里');
  assert.equal(risk?.settled, 1);
});
