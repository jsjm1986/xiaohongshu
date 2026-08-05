import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/pages/AgentHarnessPage.tsx', import.meta.url), 'utf8');

test('Agent 创建主路径默认零必填，并把文本字段收进可选精调', () => {
  assert.ok(source.includes('零必填'));
  assert.ok(source.includes('让 Agent 开始创作 3 套方案'));
  assert.ok(source.includes("useState<HarnessIntentId>('project_value')"));
  assert.ok(source.includes('<details className="harness-fine-tune">'));
  assert.ok(!source.includes('<Field label="主题" required>'));
  assert.ok(!source.includes('disabled={!projectId || !form.topic.trim()}'));
});

test('明确主题只在用户主动选择后出现，默认是 Agent 自主找题', () => {
  assert.ok(source.includes("useState<'agent_discovery' | 'user_defined'>('agent_discovery')"));
  assert.ok(source.includes('topicMode === \'user_defined\' && <Field label="明确主题" required>'));
  assert.ok(source.includes('让 Agent 自己找题'));
});


test('主路径展示十套成品方法，并让篇幅默认跟随方法', () => {
  assert.ok(source.includes('HARNESS_METHOD_PROFILES.map'));
  assert.ok(source.includes('想要哪种成品写法？'));
  assert.ok(source.includes('正文负责'));
  assert.ok(source.includes('评论负责'));
  assert.ok(source.includes('不能越过'));
  assert.ok(source.includes('跟随方法（'));
  assert.ok(source.includes('setAudienceStageId(method.audienceStage)'));
  assert.ok(source.includes("audienceStageAdjusted ? '已调整' : '方法带入'"));
  assert.ok(source.includes('useLayoutEffect(() => {'));
  assert.ok(source.includes("revealMethod(methodProfileId, methodShelfPositioned.current ? 'smooth' : 'auto')"));
  assert.ok(source.includes('data-method-id={method.id}'));
  assert.ok(source.includes('browseMethods(-1)'));
  assert.ok(source.includes('browseMethods(1)'));
});


test('精调字段提供可编辑下拉推荐，并保留自定义输入', () => {
  for (const id of ['harness-goal-options', 'harness-audience-options', 'harness-entry-options', 'harness-identity-options', 'harness-tone-options', 'harness-cta-options']) {
    assert.ok(source.includes(`list="${id}"`), `${id} 应连接可编辑推荐列表`);
    assert.ok(source.includes(`<datalist id="${id}">`), `${id} 应有推荐选项`);
  }
  assert.ok(source.includes('选择常用说明（选后仍可修改）'));
  assert.ok(source.includes('value={form.publishingNotes}'));
});


test('结果页展示可审阅的软营销心智链，并在复制 Markdown 中保留策略', () => {
  assert.match(source, /软营销心智链/u);
  assert.match(source, /这篇如何自然种草/u);
  assert.match(source, /narrativePathLabel\(candidate\.marketingStrategy\.narrativePath\)/u);
  assert.match(source, /顾虑切入/u);
  assert.match(source, /candidate\.marketingStrategy\.readerDesire/u);
  assert.match(source, /candidate\.marketingStrategy\.newJudgment/u);
  assert.match(source, /candidate\.marketingStrategy\.projectBridge/u);
  assert.match(source, /candidate\.marketingStrategy\.lowPressureNextStep/u);
});

test('结果先比较再聚焦单套，并明确区分模拟问答与真实承接', () => {
  assert.ok(source.includes('先对照三套差异，再聚焦阅读一套'));
  assert.ok(source.includes('activeCandidate && <CandidateCard'));
  assert.ok(source.includes('真实问题承接计划'));
  assert.ok(source.includes('计划，非已执行'));
  assert.ok(source.includes('停止原因'));
  assert.ok(source.includes("kind === 'reader_exchange' ? '读者接话'"));
  assert.ok(source.includes("kind === 'org_answer' && <Badge"));
  assert.ok(source.includes("kind === 'organic_reaction' ? <strong>{thread.question}</strong>"));
});

test('运行管理支持筛选、冻结合同复核和可操作失败恢复', () => {
  assert.ok(source.includes('filterHarnessRuns(jobs, runQuery, runFilter)'));
  assert.ok(source.includes('复核本次冻结的创作合同'));
  assert.ok(source.includes('harnessFailureGuidance(selected.error)'));
  assert.ok(source.includes("navigate('/settings')"));
  assert.ok(source.includes('状态刷新暂时中断'));
  assert.ok(source.includes('运行已结束，但候选结果缺失'));
  assert.ok(source.includes('所有候选均被自动校验阻断'));
  assert.ok(source.includes('回收站加载失败'));
  assert.ok(source.includes('批准所选终稿'));
  assert.ok(source.includes('永久删除'));
  assert.ok(source.includes('加载更多（已显示 {jobs.length}/{jobsTotal}）'));
  assert.ok(source.includes('offset: jobsFetched'));
  assert.ok(source.includes('requestSequence !== sequence.current || requestedProjectId !== projectId'));
});

test('硬校验失败禁止复制导出，运行进度对读屏可见', () => {
  assert.ok(source.includes('disabled={!candidate.validation.valid || !canExport}'));
  assert.ok(source.includes("该候选仍有硬校验阻断，暂不能复制或导出"));
  assert.ok(source.includes('role="progressbar"'));
  assert.ok(source.includes('aria-valuenow={selected.progress}'));
  assert.ok(source.includes('role="alert"'));
});

test('hero 说明写明这个频道在测试中，但不暗示产出未经校验', () => {
  /*
   * 侧边栏那个「测试」徽标只有两个字,承载不了「测试中意味着什么」。说明必须落在
   * hero 里:这个频道还在验证、写法与产出可能调整、旧运行不受影响。
   *
   * 同时不能说成「产出未经校验」—— canExportHarnessRun 要求每套候选都
   * validation.valid 才放开导出(agent-harness-view.ts),硬校验一直生效。
   * 把「在测试中」说成「结果不可信」会让用户白白弃用能用的产出。
   */
  const hero = source.slice(source.indexOf('<V2Hero'), source.indexOf('harness-boundary'));
  assert.ok(hero.includes('测试'), 'hero 没有说明这个频道在测试中');
  assert.match(hero, /调整|变化/u, 'hero 没说清测试中意味着什么会变');
  /*
   * 「校验仍然生效」这半句必须在场,不能只靠下面那条否定断言。
   * 只写否定的话,把整句删掉也能过——而删掉之后用户读到的就只剩「还在测试中」,
   * 那正是会让人误以为产出不可信的版本。
   */
  assert.match(hero, /校验/u, 'hero 没说明硬校验仍然生效');
  // 也不许反过来明说产出未经校验
  assert.doesNotMatch(hero, /未经校验|不可信|仅供参考,?\s*不可用/u);
});
