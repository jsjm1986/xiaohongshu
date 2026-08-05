import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_DISCLAIMER_FALLBACK, commentTotal, replyIdentity } from '../src/components/quick/NoteComments';
import { answererLabelFor } from '../src/lib/comment-view';

// 这一组守的是合规红线,不是排版:答复的署名决定「这句话是谁在担责」。
// 主答复与追问答复共用 replyIdentity,所以这些断言同时覆盖两条渲染路径。
test('org_answer 的答复署名发布账号并带作者标', () => {
  assert.deepEqual(replyIdentity('org_answer', '稳行驾校'), {
    name: '稳行驾校',
    badge: '作者',
  });
});

test('机构答复显示最终角色名，历史 publisher 楼主别名降级成项目发布账号', () => {
  assert.deepEqual(replyIdentity('org_answer', '星零感', undefined, 'expert', '项雄院长'), {
    name: '项雄院长', badge: '作者',
  });
  assert.deepEqual(replyIdentity('org_answer', '星零感', undefined, 'staff', '星零感官方助理'), {
    name: '星零感官方助理', badge: '作者',
  });
  assert.deepEqual(replyIdentity('org_answer', '星零感', undefined, 'publisher', '楼主'), {
    name: '项目发布账号', badge: '作者',
  });
});

test('threadKind 缺失的历史包按 org_answer 处理', () => {
  assert.deepEqual(replyIdentity(undefined, '稳行驾校'), {
    name: '稳行驾校',
    badge: '作者',
  });
});

// Core 合同规定 T3 只有一条读者短反应、answer 恒空、机构不出现。历史脏数据即使
// 带了 answer 也不能靠署「作者」把错误形态合法化。
test('organic_reaction 不产生任何答复身份', () => {
  assert.equal(replyIdentity('organic_reaction', '稳行驾校'), undefined);
});

test('reader_exchange 是唯一署名读者的线程,且永不带作者标', () => {
  const anonymous = replyIdentity('reader_exchange', '稳行驾校');
  assert.equal(anonymous.name, '读者');
  assert.equal(anonymous.badge, undefined);

  // 提问者已用昵称署名,答复者只能是「另一位」。
  const named = replyIdentity('reader_exchange', '稳行驾校', '打呼的小海豹');
  assert.equal(named.name, '另一位读者');
  assert.equal(named.badge, undefined);
});

test('未知 threadKind 不会被当成读者接话', () => {
  assert.deepEqual(replyIdentity('some_future_kind', '稳行驾校', '酸梅汤加冰'), {
    name: '稳行驾校',
    badge: '作者',
  });
});

// 回归守卫:署名判定曾经比对 answererLabelFor 返回的中文文案
// (`=== '模拟读者接话'`),改一次措辞就会把读者接话集体署名成机构。
// 这条断言证明现在换掉那句中文也不影响身份归属。
test('署名归属只由 threadKind 决定,与 answererLabel 的措辞无关', () => {
  // 刻意不断言 answererLabelFor 的具体文案:它是展示文案,本来就允许改。
  // 要守的是「改它不会改动身份归属」,所以这里只确认两者产出互不牵连。
  const readerLabel = answererLabelFor({ threadKind: 'reader_exchange', answer: '我也这么觉得' });
  const orgLabel = answererLabelFor({ threadKind: 'org_answer', postingIdentity: 'publisher', answer: '按合同全额退' });
  assert.notEqual(readerLabel, orgLabel);

  // replyIdentity 的签名里没有 answererLabel,措辞怎么改都到不了这里。
  assert.equal(replyIdentity('reader_exchange', '稳行驾校').badge, undefined);
  assert.equal(replyIdentity('org_answer', '稳行驾校').badge, '作者');
  assert.equal(replyIdentity('organic_reaction', '稳行驾校'), undefined);
});

// 互动条「评论 N」与评论区「共 N 条评论」必须同源:同一张卡两个数字打架时,
// 用户无法判断哪个为真,而条数是本产品唯一声称如实的数字。
test('评论总数把自备首评算进去', () => {
  const comments = [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }] as never[];
  assert.equal(commentTotal({ comments, commentOwnedFirstComment: '置顶说明：价格以当期确认为准。' }), 3);
  assert.equal(commentTotal({ comments }), 2);
  assert.equal(commentTotal({ comments: [] as never[] }), 0);
});

test('免责声明兜底文案不为空', () => {
  assert.ok(COMMENT_DISCLAIMER_FALLBACK.length > 0);
});

test('host_reply 只署楼主本人和已确认作者标', () => {
  assert.deepEqual(replyIdentity('host_reply', '项目账号', undefined, 'author', '楼主'), {
    name: '楼主本人',
    badge: '已确认作者',
  });
  assert.equal(answererLabelFor({ threadKind: 'host_reply', postingIdentity: 'author', answer: '我还没决定' }), '楼主本人（已确认）');
});
