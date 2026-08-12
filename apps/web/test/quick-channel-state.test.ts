import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveNextAction,
  parseCities,
  parseDoctors,
  pruneCheckedIds,
  formatCities,
  formatDoctors,
  filterOpportunities,
  filterGenerationJobs,
} from '../src/lib/quick-channel-state.js';

// clearDownstreamOfProject / clearResults 的用例已删:两个函数不复存在。
// 换项目的清空改由 QuickWorkspaceProvider 的 key 重挂承担(结构性保证,不是靠
// 记得列举字段),对应验收点在浏览器实测:换项目后勾选与配置为空。

test('deriveNextAction:无知识文件 → 上传资料并分析(其余就绪也优先)', () => {
  const a = deriveNextAction({ hasKnowledge: false, analysis: 'ready', topicCount: 3, generationCount: 2 });
  assert.deepEqual(a, { label: '上传资料并分析', tab: 'knowledge' });
});

test('deriveNextAction:analysis=none → 分析知识库', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'none', topicCount: 0, generationCount: 0 });
  assert.deepEqual(a, { label: '分析知识库', tab: 'knowledge' });
});

test('deriveNextAction:analysis=failed → 分析知识库', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'failed', topicCount: 0, generationCount: 0 });
  assert.deepEqual(a, { label: '分析知识库', tab: 'knowledge' });
});

test('deriveNextAction:analysis=stale → 重新分析,带「资料有更新」note', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'stale', topicCount: 3, generationCount: 2 });
  assert.deepEqual(a, { label: '重新分析', tab: 'knowledge', note: '资料有更新' });
});

test('deriveNextAction:analysis=draft → 查看内容地图(不阻塞,仅提示)', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'draft', topicCount: 3, generationCount: 2 });
  assert.deepEqual(a, { label: '查看内容地图', tab: 'knowledge' });
});

test('deriveNextAction:已就绪但无选题 → 去选题池换一批', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'ready', topicCount: 0, generationCount: 0 });
  assert.deepEqual(a, { label: '去选题池换一批', tab: 'create' });
});

test('deriveNextAction:有选题但无产出 → 去创作第一篇', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'ready', topicCount: 3, generationCount: 0 });
  assert.deepEqual(a, { label: '去创作第一篇', tab: 'create' });
});

test('deriveNextAction:链路齐全 → 继续创作', () => {
  const a = deriveNextAction({ hasKnowledge: true, analysis: 'ready', topicCount: 3, generationCount: 2 });
  assert.deepEqual(a, { label: '继续创作', tab: 'create' });
});

test('deriveNextAction:分支优先级——analysis 先于选题/产出判定', () => {
  // 待确认/需更新时,即使选题与产出已存在,也先提示内容地图
  assert.equal(deriveNextAction({ hasKnowledge: true, analysis: 'draft', topicCount: 0, generationCount: 0 }).tab, 'knowledge');
  assert.equal(deriveNextAction({ hasKnowledge: true, analysis: 'stale', topicCount: 0, generationCount: 0 }).label, '重新分析');
  // 选题缺口先于产出缺口
  assert.equal(deriveNextAction({ hasKnowledge: true, analysis: 'ready', topicCount: 0, generationCount: 5 }).label, '去选题池换一批');
});

test('parseCities:中英文逗号、顿号、分号、空白均可分隔', () => {
  assert.deepEqual(parseCities('上海, 北京、广州;深圳;杭州 成都'), ['上海', '北京', '广州', '深圳', '杭州', '成都']);
});

test('parseCities:去空、去重、trim', () => {
  assert.deepEqual(parseCities(' 上海 ,,上海、 、北京 '), ['上海', '北京']);
  assert.deepEqual(parseCities(''), []);
  assert.deepEqual(parseCities('  ,、 '), []);
});

test('parseDoctors:按行分隔,去空行与首尾空白', () => {
  assert.deepEqual(parseDoctors(' 张三 \n\n李四\n   \n王五'), [{ name: '张三' }, { name: '李四' }, { name: '王五' }]);
  assert.deepEqual(parseDoctors(''), []);
});

test('formatCities/formatDoctors:与 parse 往返一致', () => {
  assert.equal(formatCities(['上海', '北京']), '上海、北京');
  assert.deepEqual(parseCities(formatCities(['上海', '北京'])), ['上海', '北京']);
  assert.equal(formatCities(undefined), '');
  assert.equal(formatDoctors([{ name: '张三', points: ['双眼皮'] }, { name: '李四' }]), '张三\n李四');
  assert.deepEqual(parseDoctors(formatDoctors([{ name: '张三' }, { name: '李四' }])), [{ name: '张三' }, { name: '李四' }]);
  assert.equal(formatDoctors(undefined), '');
});

test('filterOpportunities:all = 非归档,collected / archived 精确匹配', () => {
  const items = [
    { id: '1' },
    { id: '2', collectionStatus: 'active' },
    { id: '3', collectionStatus: 'collected' },
    { id: '4', collectionStatus: 'archived' },
    { id: '5', status: 'stale' },
    { id: '6', approvalStatus: 'stale', collectionStatus: 'collected' },
    { id: '7', eligibilityStatus: 'blocked' },
    { id: '8', effectiveEligibility: 'ineligible', collectionStatus: 'archived' },
    { id: '9', effectiveEligibility: 'review_required' },
  ];
  assert.deepEqual(filterOpportunities(items, 'all').map((i) => i.id), ['1', '2', '3', '9']);
  assert.deepEqual(filterOpportunities(items, 'collected').map((i) => i.id), ['3']);
  assert.deepEqual(filterOpportunities(items, 'archived').map((i) => i.id), ['4']);
});

test('filterGenerationJobs:状态筛选,running 含 queued+running', () => {
  const items = [
    { id: '1', status: 'queued', topic: '双眼皮功课' },
    { id: '2', status: 'running', topic: '术后恢复' },
    { id: '3', status: 'completed', topic: '双眼皮面诊' },
    { id: '4', status: 'failed', topic: '隆鼻避坑' },
  ];
  assert.deepEqual(filterGenerationJobs(items, { status: 'all' }).map((i) => i.id), ['1', '2', '3', '4']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'running' }).map((i) => i.id), ['1', '2']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'completed' }).map((i) => i.id), ['3']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'failed' }).map((i) => i.id), ['4']);
});

test('filterGenerationJobs:关键词 trim 后小写包含匹配,空关键词不过滤', () => {
  const items = [
    { id: '1', status: 'completed', topic: '双眼皮面诊记录' },
    { id: '2', status: 'completed', topic: 'Rhinoplasty 功课' },
    { id: '3', status: 'failed', topic: '双眼皮修复' },
  ];
  assert.deepEqual(filterGenerationJobs(items, { status: 'all', keyword: ' 双眼皮 ' }).map((i) => i.id), ['1', '3']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'all', keyword: 'rhino' }).map((i) => i.id), ['2']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'all', keyword: '  ' }).map((i) => i.id), ['1', '2', '3']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'completed', keyword: '双眼皮' }).map((i) => i.id), ['1']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'all', keyword: '不存在' }).map((i) => i.id), []);
});

// ── 回归防线:归档/删除选题后,批量勾选集必须同步剔除该选题 ──
// 否则勾选后再删除,批量提交会带着一个已不存在的 opportunityId,
// 被 approveOpportunitiesForBatch 判为「选题不存在或已过期」而整批失败。

test('pruneCheckedIds 剔除已消失的选题,保留其余勾选(保序)', () => {
  assert.deepEqual(pruneCheckedIds(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(pruneCheckedIds(['a', 'b', 'c'], 'a'), ['b', 'c']);
});

test('pruneCheckedIds 未勾选该选题时返回原数组引用,避免无意义重渲染', () => {
  const checked = ['a', 'b'];
  assert.equal(pruneCheckedIds(checked, 'zzz'), checked);
  assert.equal(pruneCheckedIds([], 'a').length, 0);
});

// 复核聚焦档:批量 24 篇跑完后,复核者只看「需要我处理的」。口径与概况条
// 同源——completed 但没有 qualityStatus 的老任务算待核对,不算可发布。
test('filterGenerationJobs:可发布/待核对档按 qualityStatus 细分已完成', () => {
  const items = [
    { id: 'p1', status: 'completed', qualityStatus: 'passed' },
    { id: 'r1', status: 'completed', qualityStatus: 'needs_review' },
    { id: 'r2', status: 'completed' }, // 老任务无 qualityStatus → 待核对
    { id: 'f1', status: 'failed' },
    { id: 'q1', status: 'queued' },
  ];
  assert.deepEqual(filterGenerationJobs(items, { status: 'passed' }).map((i) => i.id), ['p1']);
  assert.deepEqual(filterGenerationJobs(items, { status: 'needs_review' }).map((i) => i.id), ['r1', 'r2']);
  // 笼统的 completed 档保留:两个质量档都是它的子集
  assert.deepEqual(filterGenerationJobs(items, { status: 'completed' }).map((i) => i.id), ['p1', 'r1', 'r2']);
});
