import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewDigest } from '../src/lib/overview-digest.js';

const job = (status: string, qualityStatus?: string, createdAt?: string) => ({
  id: Math.random().toString(36).slice(2),
  projectId: 'p1',
  topic: 't',
  mode: 'simple',
  status,
  qualityStatus,
  createdAt,
}) as any;

test('按 qualityStatus 统计可发布 / 待核对,失败单独计', () => {
  const d = overviewDigest([
    job('completed', 'passed'),
    job('completed', 'passed'),
    job('completed', 'needs_review'),
    job('failed', 'unknown'),
    job('running'),
  ]);
  assert.equal(d.publishable, 2);
  assert.equal(d.needsReview, 1);
  assert.equal(d.failed, 1);
  assert.equal(d.inFlight, 1);
  assert.equal(d.total, 5);
});

test('completed 但 qualityStatus 缺省时算待核对,不算可发布', () => {
  // 老任务没有 quality_status;不能因为缺字段就当成能直接发。
  const d = overviewDigest([job('completed', undefined)]);
  assert.equal(d.publishable, 0);
  assert.equal(d.needsReview, 1);
});

test('空列表给全零,不产生 NaN 比例', () => {
  const d = overviewDigest([]);
  assert.equal(d.total, 0);
  assert.equal(d.publishable, 0);
  assert.equal(d.publishableRatio, 0);
  assert.equal(d.needsReviewRatio, 0);
  assert.equal(d.failedRatio, 0);
});

test('比例按三类之和归一,不含进行中', () => {
  // 进行中还没有结果,计入分母会让条形随任务排队而缩水
  const d = overviewDigest([
    job('completed', 'passed'),
    job('completed', 'needs_review'),
    job('failed'),
    job('running'),
    job('queued'),
  ]);
  assert.equal(d.settled, 3);
  assert.equal(d.publishableRatio, 1 / 3);
  assert.equal(d.needsReviewRatio, 1 / 3);
  assert.equal(d.failedRatio, 1 / 3);
});

test('全部失败时可发布比例为 0、失败比例为 1', () => {
  const d = overviewDigest([job('failed'), job('failed')]);
  assert.equal(d.publishableRatio, 0);
  assert.equal(d.failedRatio, 1);
});

test('最近产出按 createdAt 倒序取前 N,缺 createdAt 的排在后面', () => {
  const d = overviewDigest([
    job('completed', 'passed', '2026-07-20T10:00:00Z'),
    job('completed', 'passed', '2026-07-25T10:00:00Z'),
    job('completed', 'passed', undefined),
    job('completed', 'passed', '2026-07-23T10:00:00Z'),
  ], 3);
  assert.equal(d.recent.length, 3);
  assert.equal(d.recent[0].createdAt, '2026-07-25T10:00:00Z');
  assert.equal(d.recent[1].createdAt, '2026-07-23T10:00:00Z');
  assert.equal(d.recent[2].createdAt, '2026-07-20T10:00:00Z');
});

test('recent 默认取 5 条', () => {
  const jobs = Array.from({ length: 9 }, (_, i) => job('completed', 'passed', `2026-07-1${i}T10:00:00Z`));
  assert.equal(overviewDigest(jobs).recent.length, 5);
});
