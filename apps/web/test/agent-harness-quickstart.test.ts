import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HARNESS_AUDIENCE_STAGES, HARNESS_INTENTS, resolveHarnessQuickStart } from '../src/lib/agent-harness-quickstart.js';
import { DEFAULT_HARNESS_METHOD_ID, HARNESS_METHOD_PROFILES } from '@content-agent/agent-harness-core/methods';

/** 界面落点的源码断言:选择器有没有真的接到请求上,jsdom 跑不到,只能读源码。 */
const pageSource = readFileSync(new URL('../src/pages/AgentHarnessPage.tsx', import.meta.url), 'utf8');

test('Agent 快速开始默认已有推荐选择，不要求用户填写主题', () => {
  assert.equal(HARNESS_INTENTS.filter((item) => item.recommended).length, 1);
  assert.equal(HARNESS_AUDIENCE_STAGES.length, 5);
  assert.equal(HARNESS_AUDIENCE_STAGES.filter((item) => item.recommended).length, 1);
  assert.equal(HARNESS_METHOD_PROFILES.length, 10);
  const input = resolveHarnessQuickStart({ projectId: 'p1', approvedImageAssetIds: ['a1', 'a2'] });
  assert.equal(input.topicMode, 'agent_discovery');
  assert.equal(input.methodProfileId, DEFAULT_HARNESS_METHOD_ID);
  assert.equal(input.creativeIntent, 'project_value');
  assert.equal(input.audienceStage, 'discovering');
  assert.equal(input.entryPoint, '推荐流中的状态与生活线索');
  assert.equal(input.bodyLength, 'short');
  assert.equal(input.topic, undefined, '自主发现模式不应伪造主题字符串');
  assert.match(input.goal ?? '', /种草成品/u);
  assert.match(input.tone ?? '', /不写说明书/u);
  assert.ok(input.audience);
  assert.ok(input.entryPoint);
  assert.ok(input.tone);
  assert.ok(input.callToAction);
  assert.deepEqual(input.imageAssetIds, ['a1', 'a2']);
});

test('用户只需点选意图和阶段，系统自动换成完整任务设置', () => {
  const input = resolveHarnessQuickStart({ projectId: 'p1', intentId: 'checklist', audienceStageId: 'ready' });
  assert.match(input.goal ?? '', /行动清单/u);
  assert.match(input.audience ?? '', /准备采取下一步/u);
  assert.match(input.callToAction ?? '', /保存清单/u);
});

test('只有明确选择自定义主题时才采用用户输入，并允许关闭自动素材', () => {
  const input = resolveHarnessQuickStart({
    projectId: 'p1', useCustomTopic: true, customTopic: '三天假期前先核验什么',
    approvedImageAssetIds: ['a1'], useApprovedImages: false,
  });
  assert.equal(input.topic, '三天假期前先核验什么');
  assert.equal(input.topicMode, 'user_defined');
  assert.deepEqual(input.imageAssetIds, []);
});


test('内容形态由 overrides 透传；不选时不在前端编默认值', () => {
  /*
   * 缺省必须是「字段不存在」而不是前端写死 'peer_seeding'：默认值的唯一真源是后端的
   * DEFAULT_HARNESS_SEEDING_MODE。前端也编一份，将来后端改默认时两边会悄悄分叉。
   */
  const untouched = resolveHarnessQuickStart({ projectId: 'p1' });
  assert.equal('seedingMode' in untouched, false, '没选内容形态时不应替后端编默认值');
  const brand = resolveHarnessQuickStart({ projectId: 'p1', overrides: { seedingMode: 'brand_voice' } });
  assert.equal(brand.seedingMode, 'brand_voice');
  const peer = resolveHarnessQuickStart({ projectId: 'p1', overrides: { seedingMode: 'peer_seeding' } });
  assert.equal(peer.seedingMode, 'peer_seeding');
});

test('内容形态可选可见：表单选择器、提交摘要、历史运行标注三处都在', () => {
  /*
   * 前七个任务把素人代发做进了生成逻辑,但界面上一个字都没有:模式硬编码、用户不能
   * 选、历史运行也看不出用了哪个。这条钉住「可见可选」的三个落点。
   *
   * 每个断言都先切到目标区段再断言,不整文件 includes:整文件断言时把选择器删掉、
   * 只留摘要里那句话照旧能过 —— 那正好是「后端能收但界面给不了」的假绿。
   */

  // 1) 表单里真有这个选择器,而且写回 form.seedingMode
  const fineTune = pageSource.slice(pageSource.indexOf('覆盖系统推荐（可选）'), pageSource.indexOf('事实与表达边界（可选）'));
  assert.ok(fineTune.includes('<Field label="内容形态"'), '精调区没有内容形态选择器');
  assert.ok(fineTune.includes('value={form.seedingMode}'), '选择器没有绑定 form.seedingMode');
  assert.ok(fineTune.includes('value="peer_seeding"'), '选择器没有素人代发这一项');
  assert.ok(fineTune.includes('value="brand_voice"'), '选择器没有机构口吻这一项');

  // 2) 选中的值真的进 overrides —— 不进的话选择器只是装饰
  const quick = pageSource.slice(pageSource.indexOf('const quickInput = useMemo'), pageSource.indexOf('const selectedIntent'));
  assert.ok(quick.includes('overrides.seedingMode = form.seedingMode'), '选中的内容形态没有进 overrides');

  // 3) 提交摘要说明本次用哪种形态
  const summary = pageSource.slice(pageSource.indexOf('现在开始，Agent 会这样做'), pageSource.indexOf('harness-fine-tune'));
  assert.match(summary, /harnessSeedingModeLabel\(form\.seedingMode\)/u,
    '提交摘要没有说明本次用哪种内容形态');
  /*
   * 4) 历史运行读的是 task 快照,不是当前表单。断言必须落在冻结合同那一段里:
   * 只要它读的是 selected.task,显示的就是当初冻结的那个模式,而不是「用户此刻
   * 在左边表单选了什么」—— 那两个值经常不一样。
   */
  const contract = pageSource.slice(pageSource.indexOf('复核本次冻结的创作合同'), pageSource.indexOf('harness-progress'));
  assert.match(contract, /selected\.task\?\.seedingMode/u, '冻结合同没有从 task 快照读出这次运行的内容形态');
  assert.ok(!contract.includes('form.seedingMode'), '历史运行读了当前表单的值,而不是当初冻结的模式');
});

test('内容形态的缺省是「不传」，由后端落默认，前端不编第二份默认值', () => {
  /*
   * 缺省项的 value 必须是空串:写成 value="peer_seeding" 就等于前端也存了一份默认值,
   * 将来后端改 DEFAULT_HARNESS_SEEDING_MODE 时两边悄悄分叉。空串在 quickInput 里被
   * if (form.seedingMode) 挡掉,字段根本不进请求。
   */
  const fineTune = pageSource.slice(pageSource.indexOf('覆盖系统推荐（可选）'), pageSource.indexOf('事实与表达边界（可选）'));
  const selector = fineTune.slice(fineTune.indexOf('<Field label="内容形态"'), fineTune.indexOf('行动引导'));
  assert.match(selector, /<option value="">素人代发（推荐）<\/option>/u, '缺省项不是空值,前端编了第二份默认值');
  assert.ok(selector.includes('机构口吻'), '选择器没有机构口吻的中文标签');

  // 初始表单值也必须是空串
  const initial = pageSource.slice(pageSource.indexOf('const INITIAL_FINE_TUNE'), pageSource.indexOf('function lines('));
  assert.match(initial, /seedingMode: ''/u, '初始表单没有把内容形态留空');
});

test('历史运行缺字段时按素人代发显示，与后端默认一致', () => {
  /*
   * 本次改动之前的运行 task_json 里没有 seedingMode。窄化必须落到素人代发,
   * 不能显示「旧运行未记录」—— 那些运行实际就是按素人代发跑的(后端默认
   * DEFAULT_HARNESS_SEEDING_MODE),说「未记录」会让人以为不知道,而我们是知道的。
   *
   * 断言钉在窄化函数体本身,不整文件 grep:整文件时表单里那个 <option
   * value="brand_voice"> 就能满足 /brand_voice/,窄化整个删掉照样绿 —— 那正是
   * 「历史运行显示成什么」这条要防的。
   */
  const fn = pageSource.slice(pageSource.indexOf('function harnessSeedingModeLabel'), pageSource.indexOf('function statusLabel'));
  assert.ok(fn.length > 0, '页面没有内容形态的窄化函数');
  assert.match(fn, /=== 'brand_voice'/u, '窄化没有显式判 brand_voice,而是信任了后端字符串');
  /*
   * 「素人代发」在这个函数里必须是另一支的返回值。上面那条只保证判了 brand_voice,
   * 判完两支都返回机构口吻也能过,所以这里钉住素人那支的文本。
   */
  assert.ok(fn.includes('素人代发'), '窄化的缺省分支不是素人代发');
  assert.ok(!fn.includes('旧运行未记录'), '历史运行被显示成未记录,而后端默认就是素人代发');
});

test('选择旧方法会联动阶段、入口与篇幅，用户覆盖仍然优先', () => {
  const automatic = resolveHarnessQuickStart({ projectId: 'p1', methodProfileId: 'real_minimal' });
  assert.equal(automatic.audienceStage, 'collecting');
  assert.equal(automatic.entryPoint, '推荐流中的真实处境切入');
  assert.equal(automatic.bodyLength, 'short');
  const overridden = resolveHarnessQuickStart({
    projectId: 'p1', methodProfileId: 'real_minimal', audienceStageId: 'hesitating',
    overrides: { entryPoint: '用户明确入口', bodyLength: 'long' },
  });
  assert.equal(overridden.audienceStage, 'hesitating');
  assert.match(overridden.audience ?? '', /担心选错/u);
  assert.equal(overridden.entryPoint, '用户明确入口');
  assert.equal(overridden.bodyLength, 'long');
});
