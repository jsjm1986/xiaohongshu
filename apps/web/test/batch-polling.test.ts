import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeJobUpdates, pendingJobIds } from '../src/lib/batch-polling.js';

test('pendingJobIds returns only queued/running ids', () => {
  const jobs = [
    { id: 'a', status: 'queued' },
    { id: 'b', status: 'running' },
    { id: 'c', status: 'completed' },
    { id: 'd', status: 'failed' },
  ];
  assert.deepEqual(pendingJobIds(jobs), ['a', 'b']);
  assert.deepEqual(pendingJobIds([]), []);
});

test('pendingJobIds dedupes ids appearing in several batches', () => {
  const jobs = [
    { id: 'a', status: 'queued' },
    { id: 'a', status: 'running' },
    { id: 'b', status: 'running' },
  ];
  assert.deepEqual(pendingJobIds(jobs), ['a', 'b']);
});

test('mergeJobUpdates swaps in fresh jobs and keeps the rest untouched', () => {
  const current = {
    b1: [
      { id: 'a', status: 'running', progress: 10 },
      { id: 'b', status: 'completed', progress: 100 },
    ],
    b2: [{ id: 'c', status: 'queued', progress: 0 }],
  } as never;
  const next = mergeJobUpdates(current, [
    { id: 'a', status: 'completed', progress: 100 },
    null,
  ] as never);
  assert.equal(next.b1[0]!.status, 'completed');
  assert.equal(next.b1[0]!.progress, 100);
  // 未在更新列表里的 job 原样保留（引用不变，避免无谓重渲染链）
  assert.equal(next.b1[1], (current as never as Record<string, unknown[]>).b1![1]);
  assert.equal(next.b2[0]!.status, 'queued');
});

test('mergeJobUpdates returns the same object when nothing changed', () => {
  const current = { b1: [{ id: 'a', status: 'running' }] } as never;
  const next = mergeJobUpdates(current, [null] as never);
  // 全部轮询失败时不制造新对象，避免无内容变化的重渲染（轮询靠 tick 继续推进）
  assert.equal(next, current);
});
