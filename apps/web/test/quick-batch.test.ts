import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBatchJobs, batchStatusLabel, batchProgressText } from '../src/lib/quick-batch.js';
import type { ContentPreset, GenerationJob, Project, TopicOpportunity } from '../src/types.js';

const project = { id: 'p1', name: 'P', cities: [], doctors: [] } as unknown as Project;
const opp = (id: string, title: string) => ({ id, title, whyValuable: 'w', gapIds: [], strategyId: 's1' } as unknown as TopicOpportunity);
const preset = (id: string) => ({ id, projectId: 'p1', source: 'project', name: id, description: '', values: {}, isDefault: false } as unknown as ContentPreset);
const presetWithValues = (id: string, values: Record<string, unknown>) => ({ ...preset(id), values } as unknown as ContentPreset);

test('buildBatchJobs makes cartesian product of opportunities x presets', () => {
  const jobs = buildBatchJobs({
    project,
    opportunities: [opp('o1', 'T1'), opp('o2', 'T2')],
    presets: [preset('pr1'), preset('pr2')],
    overrides: {},
    imageAssetIds: [],
  });
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map((j) => [j.opportunityId, j.presetId]), [
    ['o1', 'pr1'], ['o1', 'pr2'], ['o2', 'pr1'], ['o2', 'pr2'],
  ]);
  assert.equal(jobs.every((j) => j.projectId === 'p1' && j.mode === 'simple'), true);
});

test('buildBatchJobs with single preset keeps one job per opportunity', () => {
  const jobs = buildBatchJobs({ project, opportunities: [opp('o1', 'T1'), opp('o2', 'T2')], presets: [preset('pr1')], overrides: {}, imageAssetIds: [] });
  assert.equal(jobs.length, 2);
});

test('buildBatchJobs resolves settings from each cell own preset', () => {
  // 回归防线:每格必须用自己的 preset 解析设置。若实现退化成固定用 presets[0]
  // (只有 presetId 逐格取),city/mustInclude/forbidden 会全部串成 pr1 的值。
  const jobs = buildBatchJobs({
    project,
    opportunities: [opp('o1', 'T1')],
    presets: [
      preset('pr1'),
      presetWithValues('pr2', { city: '上海', must_mention: '术后随访', forbidden: '包治百病' }),
    ],
    overrides: {},
    imageAssetIds: [],
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[1]!.city, '上海');
  assert.equal(jobs[1]!.mustInclude, '术后随访');
  assert.equal(jobs[1]!.forbidden, '包治百病');
  // 空 preset 那格不能被隔壁 preset 污染。
  assert.notEqual(jobs[0]!.city, '上海');
  assert.equal(jobs[0]!.city, undefined);
  assert.equal(jobs[0]!.mustInclude, '');
  assert.equal(jobs[0]!.forbidden, '');
});

test('batchStatusLabel maps to Chinese', () => {
  assert.equal(batchStatusLabel('running'), '生成中');
  assert.equal(batchStatusLabel('completed'), '已完成');
  assert.equal(batchStatusLabel('partial'), '部分完成');
  assert.equal(batchStatusLabel('failed'), '全部失败');
  assert.equal(batchStatusLabel('queued'), '排队中');
});

test('batchProgressText separates success from failure', () => {
  const jobs = [
    { status: 'completed' }, { status: 'failed' }, { status: 'running' }, { status: 'queued' },
  ] as GenerationJob[];
  assert.equal(batchProgressText(jobs), '1/4 完成 · 1 失败');
});

test('batchProgressText omits failure suffix when nothing failed', () => {
  const jobs = [
    { status: 'completed' }, { status: 'completed' }, { status: 'running' },
  ] as GenerationJob[];
  assert.equal(batchProgressText(jobs), '2/3 完成');
});
