import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkspaceMemo, readerPath, serializeWorkspaceMemo } from '../src/lib/quick-nav.js';

test('readerPath 生成阅读页地址', () => {
  assert.equal(readerPath('abc-123'), '/quick/read/abc-123');
});

// jobId 来自后端 randomUUID,但地址是要被收藏/分享的,不该假设它永远无需转义
test('readerPath 对 id 做 URL 转义', () => {
  assert.equal(readerPath('a/b'), '/quick/read/a%2Fb');
  assert.equal(readerPath('a b'), '/quick/read/a%20b');
});

test('工作区记忆能往返', () => {
  const memo = { projectId: 'p1', tab: 'history' as const };
  assert.deepEqual(parseWorkspaceMemo(serializeWorkspaceMemo(memo)), memo);
});

test('没有记忆时返回 null,而不是抛错', () => {
  assert.equal(parseWorkspaceMemo(null), null);
  assert.equal(parseWorkspaceMemo(undefined), null);
  assert.equal(parseWorkspaceMemo(''), null);
});

// sessionStorage 里的东西可能被手改、也可能是旧版本写的。任何形状不对都当没有记忆,
// 让用户回到项目卡墙——比让整页因为一次 JSON.parse 崩掉好。
test('形状不对的记忆一律当作没有', () => {
  assert.equal(parseWorkspaceMemo('{ 不是 json'), null);
  assert.equal(parseWorkspaceMemo('null'), null);
  assert.equal(parseWorkspaceMemo('"string"'), null);
  assert.equal(parseWorkspaceMemo('[]'), null);
  assert.equal(parseWorkspaceMemo('{}'), null);
  assert.equal(parseWorkspaceMemo('{"projectId":"p1"}'), null);
  assert.equal(parseWorkspaceMemo('{"projectId":"","tab":"history"}'), null);
  assert.equal(parseWorkspaceMemo('{"projectId":"p1","tab":"nope"}'), null);
  assert.equal(parseWorkspaceMemo('{"projectId":123,"tab":"history"}'), null);
});

test('四个分区都是合法的记忆目标', () => {
  for (const tab of ['overview', 'knowledge', 'create', 'history']) {
    assert.deepEqual(
      parseWorkspaceMemo(`{"projectId":"p1","tab":"${tab}"}`),
      { projectId: 'p1', tab },
    );
  }
});
