import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readerNeighbors } from '../src/lib/reader-navigation.js';
import type { GenerationJob } from '../src/types.js';

const job = (id: string, status: GenerationJob['status']): GenerationJob =>
  ({ id, status, topic: id } as GenerationJob);

test('在已完成的任务之间翻页,位次按列表顺序', () => {
  const jobs = [job('a', 'completed'), job('b', 'completed'), job('c', 'completed')];
  const mid = readerNeighbors(jobs, 'b');
  assert.equal(mid.previous?.id, 'a');
  assert.equal(mid.next?.id, 'c');
  assert.equal(mid.position, 2);
  assert.equal(mid.total, 3);
});

test('首篇没有上一篇,末篇没有下一篇', () => {
  const jobs = [job('a', 'completed'), job('b', 'completed')];
  assert.equal(readerNeighbors(jobs, 'a').previous, undefined);
  assert.equal(readerNeighbors(jobs, 'a').next?.id, 'b');
  assert.equal(readerNeighbors(jobs, 'b').next, undefined);
});

// 关键:批量里一半是失败/排队时,翻页不能带用户去只有错误信息或等待卡的空页
test('排队中与失败的任务不进翻页序列', () => {
  const jobs = [
    job('done1', 'completed'),
    job('fail', 'failed'),
    job('queued', 'queued'),
    job('running', 'running'),
    job('done2', 'completed'),
  ];
  const first = readerNeighbors(jobs, 'done1');
  assert.equal(first.next?.id, 'done2');
  assert.equal(first.total, 2);
  assert.equal(first.position, 1);
});

test('当前这篇不可读时不给翻页,但总数照报', () => {
  const jobs = [job('done', 'completed'), job('running', 'running')];
  const n = readerNeighbors(jobs, 'running');
  assert.equal(n.previous, undefined);
  assert.equal(n.next, undefined);
  assert.equal(n.position, 0);
  assert.equal(n.total, 1);
});

test('空列表(还没拉到)不抛错', () => {
  const n = readerNeighbors([], 'whatever');
  assert.deepEqual(n, { position: 0, total: 0 });
});

test('只有一篇时两侧都没有邻居', () => {
  const n = readerNeighbors([job('only', 'completed')], 'only');
  assert.equal(n.previous, undefined);
  assert.equal(n.next, undefined);
  assert.equal(n.position, 1);
  assert.equal(n.total, 1);
});
