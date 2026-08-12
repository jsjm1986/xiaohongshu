import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBatchExport } from '../src/lib/batch-export.js';

const cand = (id: string, publishable: boolean) => ({ id, publishable, title: `标题${id}` });
const job = (id: string, status: string, cands: Array<{ id: string; publishable: boolean }>) => ({
  id, status, topic: `选题${id}`, candidates: cands,
}) as any;

test('只导出可发布候选,未通过校验的计入 skipped', () => {
  // 后端 export.service.ts:155 对未通过校验的候选一律 400,实测 165 个里 129 个
  // 过不了。批量导出必须先筛,否则大半请求都是 400。
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true), cand('c2', false)]),
  ], 'docx');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].candidateId, 'c1');
  assert.equal(plan.skippedUnpublishable, 1);
});

test('markdown 格式不筛但要计水印数:未过校验的稿子带「仅供核对」水印导出', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true), cand('c2', false)]),
  ], 'markdown');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.skippedUnpublishable, 0);
  // 调用方要据此在结果提示里如实说明;文档本身的水印由 quickCandidateToMarkdown 负责。
  assert.equal(plan.draftWatermarked, 1);
});

test('非 markdown 格式不产生水印计数', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true), cand('c2', false)]),
  ], 'docx');
  assert.equal(plan.draftWatermarked, 0);
});

test('未完成任务整个跳过,单独计数', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true)]),
    job('j2', 'failed', []),
    job('j3', 'running', []),
  ], 'docx');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.skippedUnfinished, 2);
});

test('一个任务的多个候选都要导出,带上可区分的序号', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true), cand('c2', true), cand('c3', true)]),
  ], 'pdf');
  assert.equal(plan.items.length, 3);
  // 同一任务下多个候选,文件名必须能区分
  const names = plan.items.map((i) => i.filename);
  assert.equal(new Set(names).size, 3, `文件名必须互不相同,实际 ${names.join(',')}`);
});

test('文件名含选题与格式后缀,并清掉路径非法字符', () => {
  const plan = planBatchExport([
    { id: 'j1', status: 'completed', topic: 'a/b:c*d?e"f<g>h|i', candidates: [cand('c1', true)] } as any,
  ], 'docx');
  const name = plan.items[0].filename;
  assert.match(name, /\.docx$/);
  assert.ok(!/[/\\:*?"<>|]/.test(name), `文件名不应含非法字符: ${name}`);
});

test('缺 candidates 的任务不崩,计为未完成', () => {
  const plan = planBatchExport([{ id: 'j1', status: 'completed' } as any], 'docx');
  assert.equal(plan.items.length, 0);
});

test('空输入给空计划', () => {
  const plan = planBatchExport([], 'docx');
  assert.deepEqual(plan.items, []);
  assert.equal(plan.skippedUnpublishable, 0);
  assert.equal(plan.skippedUnfinished, 0);
});

test('total 反映实际要下载的文件数', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', true), cand('c2', false)]),
    job('j2', 'completed', [cand('c3', true)]),
  ], 'docx');
  assert.equal(plan.total, 2);
  assert.equal(plan.total, plan.items.length);
});
