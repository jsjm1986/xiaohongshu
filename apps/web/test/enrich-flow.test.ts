import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDraftChange,
  beginEdit,
  cancelEdit,
  canMerge,
  commitEdit,
  confidenceLabel,
  confirmDraft,
  deleteDraft,
  effectiveContent,
  hasUnsavedEdits,
  restoreDraft,
  toDraftItems,
  toMergeItems,
} from '../src/lib/enrich-flow';
import type { DraftItem, EnrichDraft } from '../src/lib/enrich-types';

function draft(patch: Partial<EnrichDraft> = {}): EnrichDraft {
  return {
    gapId: 'g1', title: '价格', question: '多少钱?', priority: 90,
    aiDraft: '约 7000 元,待确认。', confidence: 'medium',
    ...patch,
  };
}

function item(patch: Partial<DraftItem> = {}): DraftItem {
  return { ...draft(), status: 'pending', ...patch };
}

test('toDraftItems 一律初始为 pending:没审过就不算确认', () => {
  const items = toDraftItems([draft({ gapId: 'a' }), draft({ gapId: 'b' })]);
  assert.deepEqual(items.map((i) => i.status), ['pending', 'pending']);
  assert.equal(items[0].userContent, undefined);
});

test('effectiveContent: userContent 为空或纯空白时回落 aiDraft', () => {
  assert.equal(effectiveContent(item()), '约 7000 元,待确认。');
  assert.equal(effectiveContent(item({ userContent: '' })), '约 7000 元,待确认。');
  assert.equal(effectiveContent(item({ userContent: '   ' })), '约 7000 元,待确认。');
  assert.equal(effectiveContent(item({ userContent: '用户写的' })), '用户写的');
});

test('toMergeItems 剔除 deleted', () => {
  const merged = toMergeItems([
    item({ gapId: 'a' }),
    item({ gapId: 'b', status: 'deleted' }),
  ]);
  assert.deepEqual(merged.map((i) => i.gapId), ['a']);
});

test('toMergeItems: pending → confirmed,edited/editing → edited', () => {
  const merged = toMergeItems([
    item({ gapId: 'a', status: 'pending' }),
    item({ gapId: 'b', status: 'confirmed' }),
    item({ gapId: 'c', status: 'edited', userContent: '改过的' }),
    item({ gapId: 'd', status: 'editing', userContent: '正在改' }),
  ]);
  assert.deepEqual(
    merged.map((i) => [i.gapId, i.status]),
    [['a', 'confirmed'], ['b', 'confirmed'], ['c', 'edited'], ['d', 'edited']],
  );
});

test('toMergeItems 每条都带正文:后端不缓存草稿,拿不到就没法合并', () => {
  const merged = toMergeItems([item(), item({ gapId: 'b', userContent: '改过的' })]);
  assert.deepEqual(merged.map((i) => i.content), ['约 7000 元,待确认。', '改过的']);
});

test('hasUnsavedEdits: 只有 pending / confirmed / deleted 时为 false', () => {
  assert.equal(hasUnsavedEdits([item(), item({ gapId: 'b', status: 'confirmed' })]), false);
  assert.equal(hasUnsavedEdits([item({ status: 'deleted' })]), false);
  assert.equal(hasUnsavedEdits([item({ status: 'editing' })]), true);
  assert.equal(hasUnsavedEdits([item({ status: 'edited', userContent: 'x' })]), true);
});

test('canMerge: 全部删除时为 false', () => {
  assert.equal(canMerge([item({ status: 'deleted' })]), false);
  assert.equal(canMerge([]), false);
});

test('canMerge: 有一条正文空白时为 false', () => {
  // aiDraft 为空且用户没写东西 —— 发过去后端也会拒
  assert.equal(canMerge([item({ aiDraft: '   ', userContent: '' })]), false);
  assert.equal(canMerge([item(), item({ gapId: 'b', aiDraft: '' })]), false);
});

test('canMerge: 正常情况为 true,被删掉的空条目不影响', () => {
  assert.equal(canMerge([item()]), true);
  assert.equal(canMerge([item(), item({ gapId: 'b', aiDraft: '', status: 'deleted' })]), true);
});

test('applyDraftChange 只改中标那条,长度与顺序不变', () => {
  const items = [item({ gapId: 'a' }), item({ gapId: 'b' }), item({ gapId: 'c' })];
  const next = applyDraftChange(items, { ...items[1], status: 'confirmed' });
  assert.deepEqual(next.map((i) => i.gapId), ['a', 'b', 'c']);
  assert.deepEqual(next.map((i) => i.status), ['pending', 'confirmed', 'pending']);
});

test('confirmDraft 只改状态,不动正文', () => {
  const next = confirmDraft(item({ userContent: '改过的' }));
  assert.equal(next.status, 'confirmed');
  assert.equal(next.userContent, '改过的');
});

test('beginEdit 进入 editing', () => {
  assert.equal(beginEdit(item()).status, 'editing');
});

test('commitEdit: 改回和原稿一致(含首尾空白差异)时退回 pending 并清掉 userContent', () => {
  const base = item({ status: 'editing' });
  for (const text of [base.aiDraft, `  ${base.aiDraft}  `, `\n${base.aiDraft}\n`]) {
    const next = commitEdit(base, text);
    assert.equal(next.status, 'pending', `「${text}」应视为没改动`);
    assert.equal(next.userContent, undefined);
  }
});

test('commitEdit: aiDraft 自带首尾空白时也能认出「没改动」', () => {
  // 模型输出常带尾随换行。两边都要 trim 后再比,否则用户什么都没改也会被标成「已修改」,
  // 关闭时还会弹一次「有未提交的改动」。
  const base = item({ status: 'editing', aiDraft: '\n约 7000 元,待确认。\n' });
  const next = commitEdit(base, '约 7000 元,待确认。');
  assert.equal(next.status, 'pending');
  assert.equal(next.userContent, undefined);
});

test('commitEdit: 内容不同时标 edited,userContent 原样保留(不 trim)', () => {
  const next = commitEdit(item({ status: 'editing' }), '  第一段\n\n第二段  ');
  assert.equal(next.status, 'edited');
  // 用户的换行和缩进要留着——正文是 Markdown,trim 会改变渲染
  assert.equal(next.userContent, '  第一段\n\n第二段  ');
});

test('cancelEdit: 有 userContent 回 edited,没有回 pending', () => {
  assert.equal(cancelEdit(item({ status: 'editing', userContent: '改过的' })).status, 'edited');
  assert.equal(cancelEdit(item({ status: 'editing' })).status, 'pending');
});

test('deleteDraft 保留 userContent,以便恢复后不丢', () => {
  const next = deleteDraft(item({ status: 'edited', userContent: '改过的' }));
  assert.equal(next.status, 'deleted');
  assert.equal(next.userContent, '改过的');
});

test('restoreDraft: 改过的回 edited,没改过的回 pending', () => {
  assert.equal(restoreDraft(item({ status: 'deleted', userContent: '改过的' })).status, 'edited');
  assert.equal(restoreDraft(item({ status: 'deleted' })).status, 'pending');
  // 恢复后编辑必须还在,否则用户白改一遍
  assert.equal(restoreDraft(item({ status: 'deleted', userContent: '改过的' })).userContent, '改过的');
});

test('confidenceLabel 的 tone 都是 Badge 认识的取值', () => {
  // Badge 的 tone 联合类型里没有 'success';写错了 typecheck 能拦,
  // 但取值一旦改动这里会更早报出来。
  const allowed = new Set(['positive', 'warning', 'danger']);
  for (const confidence of ['low', 'medium', 'high'] as const) {
    const label = confidenceLabel(confidence);
    assert.ok(allowed.has(label.tone), `${confidence} 的 tone=${label.tone} 不合法`);
    assert.ok(label.text.length > 0);
  }
});

test('confidenceLabel 的文案说的是依据强弱,不是质量评分', () => {
  // 「高把握」会被读成「更可信,不用细看」,而逐条审查是这个功能成立的前提
  for (const confidence of ['low', 'medium', 'high'] as const) {
    assert.doesNotMatch(confidenceLabel(confidence).text, /把握/);
  }
  assert.match(confidenceLabel('high').text, /依据/);
  assert.match(confidenceLabel('low').text, /确认|依据/);
});
