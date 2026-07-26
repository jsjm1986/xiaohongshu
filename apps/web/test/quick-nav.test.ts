import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readerPath } from '../src/lib/quick-nav.js';

test('readerPath 生成阅读页地址', () => {
  assert.equal(readerPath('abc-123'), '/quick/read/abc-123');
});

// jobId 来自后端 randomUUID,但地址是要被收藏/分享的,不该假设它永远无需转义
test('readerPath 对 id 做 URL 转义', () => {
  assert.equal(readerPath('a/b'), '/quick/read/a%2Fb');
  assert.equal(readerPath('a b'), '/quick/read/a%20b');
});

// 工作区记忆(parseWorkspaceMemo / serializeWorkspaceMemo)的用例已删:四区改成
// 真路由后地址本身就是记忆,那套 sessionStorage 不复存在。区解析的用例见
// quick-routes.test.ts。
