import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planBatchExport } from '../src/lib/batch-export.js';

const board = readFileSync(new URL('../src/components/quick/BatchBoard.tsx', import.meta.url), 'utf8');

const cand = (id: string, state: 'passed' | 'needs_review' | 'blocked') => ({
  id,
  title: `标题${id}`,
  validation: {
    valid: true,
    qualityStatus: state === 'needs_review' ? 'needs_review' : 'passed',
    repairAttempts: 0,
    issues: [],
  },
  generationMode: 'model_generated',
  artifactRealization: {
    deliverability: state === 'blocked' ? 'non_deliverable' : 'eligible',
  },
});
const job = (id: string, status: string, cands: ReturnType<typeof cand>[]) => ({
  id, status, topic: `选题${id}`, candidates: cands,
}) as any;

test('任何格式都排除 deliverable=false 的硬阻断候选', () => {
  for (const format of ['markdown', 'json', 'docx', 'pdf'] as const) {
    const plan = planBatchExport([
      job('j1', 'completed', [cand('c1', 'passed'), cand('c2', 'blocked')]),
    ], format);
    assert.deepEqual(plan.items.map((item) => item.candidateId), ['c1'], format);
    assert.equal(plan.skippedBlocked, 1, format);
  }
});

test('needs_review 候选仍可按任何格式批量导出', () => {
  for (const format of ['markdown', 'json', 'docx', 'pdf'] as const) {
    const plan = planBatchExport([
      job('j1', 'completed', [cand('c1', 'needs_review')]),
    ], format);
    assert.deepEqual(plan.items.map((item) => item.candidateId), ['c1'], format);
    assert.deepEqual(plan.items.map((item) => item.qualityStatusLabel), ['建议复核（可复制导出）'], format);
    assert.equal(plan.skippedBlocked, 0, format);
  }
});

test('批量导出清单携带人类可读 qualityStatus，历史候选才回退 valid', () => {
  const passed = cand('passed', 'passed');
  const review = cand('review', 'needs_review');
  const historical = {
    ...cand('historical', 'passed'),
    validation: { valid: false, repairAttempts: 0, issues: [] },
  };
  const plan = planBatchExport([
    job('j1', 'completed', [passed, review, historical] as any),
  ], 'markdown');
  assert.deepEqual(
    plan.items.map((item) => [item.candidateId, item.qualityStatus, item.qualityStatusLabel]),
    [
      ['passed', 'passed', '校验通过'],
      ['review', 'needs_review', '建议复核（可复制导出）'],
      ['historical', 'needs_review', '建议复核（可复制导出）'],
    ],
  );
});

test('BatchBoard 如实说明硬门禁跳过，不再建议改用 Markdown 绕过', () => {
  assert.match(board, /命中交付硬门禁/u);
  assert.doesNotMatch(board, /可改用 Markdown|draftWatermarked|仅供核对.*水印/u);
});

test('未完成任务整个跳过,单独计数', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', 'passed')]),
    job('j2', 'failed', []),
    job('j3', 'running', []),
  ], 'docx');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.skippedUnfinished, 2);
});

test('一个任务的多个候选都要导出,带上可区分的序号', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', 'passed'), cand('c2', 'passed'), cand('c3', 'passed')]),
  ], 'pdf');
  assert.equal(plan.items.length, 3);
  // 同一任务下多个候选,文件名必须能区分
  const names = plan.items.map((i) => i.filename);
  assert.equal(new Set(names).size, 3, `文件名必须互不相同,实际 ${names.join(',')}`);
});

test('文件名含选题与格式后缀,并清掉路径非法字符', () => {
  const plan = planBatchExport([
    { id: 'j1', status: 'completed', topic: 'a/b:c*d?e"f<g>h|i', candidates: [cand('c1', 'passed')] } as any,
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
  assert.equal(plan.skippedBlocked, 0);
  assert.equal(plan.skippedUnfinished, 0);
});

test('total 反映实际要下载的文件数', () => {
  const plan = planBatchExport([
    job('j1', 'completed', [cand('c1', 'passed'), cand('c2', 'blocked')]),
    job('j2', 'completed', [cand('c3', 'needs_review')]),
  ], 'docx');
  assert.equal(plan.total, 2);
  assert.equal(plan.total, plan.items.length);
});
