import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFrozenSnapshotStorageRef } from '../src/reference-snapshot.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

test('可读原始文件的哈希不匹配时失败关闭', () => {
  assert.throws(
    () => resolveFrozenSnapshotStorageRef(
      ['/snapshot.jsonl'],
      { sha256: '0'.repeat(64), rowCount: 1, storageRef: 'frozen-metadata' },
      () => Buffer.from('one row\n'),
    ),
    /固化的哈希或行数不一致/u,
  );
});

test('可读原始文件的行数不匹配时失败关闭', () => {
  assert.throws(
    () => resolveFrozenSnapshotStorageRef(
      ['/snapshot.jsonl'],
      { sha256: EMPTY_SHA256, rowCount: 1, storageRef: 'frozen-metadata' },
      () => Buffer.alloc(0),
    ),
    /固化的哈希或行数不一致/u,
  );
});

test('所有候选均为 ENOENT/EACCES/EPERM 时回退固化元数据', () => {
  const candidates = ['/missing.jsonl', '/denied.jsonl', '/forbidden.jsonl'];
  const codes = ['ENOENT', 'EACCES', 'EPERM'];
  const visited: string[] = [];
  const storageRef = resolveFrozenSnapshotStorageRef(
    candidates,
    { sha256: EMPTY_SHA256, rowCount: 0, storageRef: 'frozen-metadata' },
    (path) => {
      visited.push(path);
      const error = new Error(path) as NodeJS.ErrnoException;
      error.code = codes[visited.length - 1];
      throw error;
    },
  );

  assert.equal(storageRef, 'frozen-metadata');
  assert.deepEqual(visited, candidates);
});

test('可读且匹配的候选返回真实路径，未知读取错误继续失败关闭', () => {
  const spec = { sha256: EMPTY_SHA256, rowCount: 0, storageRef: 'frozen-metadata' };
  assert.equal(
    resolveFrozenSnapshotStorageRef(['/snapshot.jsonl'], spec, () => Buffer.alloc(0)),
    '/snapshot.jsonl',
  );
  assert.throws(
    () => resolveFrozenSnapshotStorageRef(['/snapshot.jsonl'], spec, () => {
      const error = new Error('io') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }),
    /io/u,
  );
});
