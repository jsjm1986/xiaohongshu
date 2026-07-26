import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_DISCLAIMER_FALLBACK, followUpReplyIdentity } from '../src/components/quick/NoteComments';

// 这两条守的是合规红线,不是排版:org_answer 线程的追问答复是机构补充,
// 渲染成读者发言等于把机构承诺(换教练、全额退)伪装成另一位学员的说法。
test('org_answer 的追问答复署名发布账号并带作者标', () => {
  assert.deepEqual(followUpReplyIdentity('org_answer', '稳行驾校'), {
    name: '稳行驾校',
    badge: '作者',
  });
});

test('threadKind 缺失的历史包按 org_answer 处理', () => {
  assert.deepEqual(followUpReplyIdentity(undefined, '稳行驾校'), {
    name: '稳行驾校',
    badge: '作者',
  });
});

test('reader_exchange 的追问答复是模拟读者接话,不得带作者标', () => {
  const got = followUpReplyIdentity('reader_exchange', '稳行驾校');
  assert.equal(got.name, '读者');
  assert.equal(got.badge, undefined);
});

test('organic_reaction 同样不得署名为机构', () => {
  const got = followUpReplyIdentity('organic_reaction', '稳行驾校');
  assert.equal(got.name, '读者');
  assert.equal(got.badge, undefined);
});

test('免责声明兜底文案不为空', () => {
  assert.ok(COMMENT_DISCLAIMER_FALLBACK.length > 0);
});
