import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/QuickReaderPage.tsx', import.meta.url), 'utf8');
const quickResult = readFileSync(new URL('../src/components/QuickResult.tsx', import.meta.url), 'utf8');
const result = readFileSync(new URL('../src/pages/GenerationResultPage.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../src/components/quick/ReaderDetail.tsx', import.meta.url), 'utf8');
const note = readFileSync(new URL('../src/components/quick/NoteCard.tsx', import.meta.url), 'utf8');
const comments = readFileSync(new URL('../src/components/quick/NoteComments.tsx', import.meta.url), 'utf8');
const alert = readFileSync(new URL('../src/components/quick/NoteAlertBar.tsx', import.meta.url), 'utf8');
const verdict = readFileSync(new URL('../src/components/quick/ValidationVerdict.tsx', import.meta.url), 'utf8');
const utils = readFileSync(new URL('../src/lib/utils.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/**
 * 交付门禁的既定决策(delivery-readiness):正式模型产物即可交付,复核发现
 * 保持可见但不再需要确认点击;只有机械硬门禁 blocked 锁死复制与导出。
 * 人工确认的「发起」入口曾是永不可达的死分支(deliveryReadiness 从不返回
 * human_reviewable),已按该决策清理——这组断言防它无意识回潮:
 * 恢复确认流程必须是显式的产品决定,不是残骸复活。
 */
test('人工确认的发起入口已按交付政策清理，不得无意识回潮', () => {
  for (const source of [page, result, detail, alert, verdict]) {
    assert.doesNotMatch(source, /confirmManualDelivery/u);
    assert.doesNotMatch(source, /manualConfirmChecked/u);
    assert.doesNotMatch(source, /我已核对事实、证据、身份与风险/u);
    assert.doesNotMatch(source, /人工确认后可|已人工确认，可|人工交付确认/u);
  }
});

test('交付门禁两档判定：blocked 锁死全部复制与导出入口', () => {
  assert.match(page, /const deliverable = candidateDeliverable\(activeCandidate\?\.validation, false/u);
  assert.match(page, /copyEnabled=\{deliverable\}/u);
  assert.match(page, /deliverable=\{deliverable\}/u);
  assert.match(note, /disabled=\{!copyEnabled\}/u);
  assert.match(comments, /disabled=\{!copyEnabled\}/u);
  assert.match(detail, /disabled=\{!deliverable\}/u);
  assert.match(detail, /const blocked = !deliverable/u);
  assert.match(detail, /<ValidationVerdict validation=\{current\.validation\} deliverable=\{deliverable\}/u);
  assert.match(page, /deliverable=\{deliverable\}/u);
  assert.match(alert, /const verdict = issueVerdict\(validation\)/u);
  assert.match(alert, /<span>\{verdict\.headline\}<\/span>/u);
  assert.match(verdict, /const verdict = issueVerdict\(validation\)/u);
  assert.match(verdict, /const displayPublishable = !deliveryBlocked && verdict\.publishable/u);
  assert.match(verdict, /const headline = deliveryBlocked \? '存在硬门禁 · 须修复后重新生成' : verdict\.headline/u);
  assert.match(verdict, /<strong>\{headline\}<\/strong>/u);
  assert.match(verdict, /硬门禁 · 须修复后重新生成/u);
  assert.match(verdict, /qc-verdict--\$\{deliveryBlocked \? 'blocked' : displayPublishable \? 'ok' : 'review'\}/u);
  assert.match(css, /\.qc-verdict--review/u);
  assert.match(page, /四种格式统一走服务端/u);
});

test('全文、逐字段、评论与标题快捷复制统一携带 needs_review 剪贴板状态', () => {
  assert.match(
    note,
    /candidateClipboardText\(candidate\.validation,\s*text\)/u,
    'NoteCard 的全文与逐字段复制必须经过统一状态包装',
  );
  assert.match(
    comments,
    /candidateClipboardText\(candidate\.validation,\s*payload\)/u,
    '逐条评论复制也必须带候选状态',
  );
  assert.match(
    result,
    /candidateClipboardText\(selected\.validation,\s*selected\.title\)/u,
    '结果页标题快捷复制不得只写裸标题',
  );
  assert.match(
    detail,
    /candidateClipboardText\(current\.validation,\s*text\)/u,
    '按发布顺序复制的最终 clipboard 边界必须再次失败关闭',
  );
  assert.match(
    quickResult,
    /candidateClipboardText\(\s*view\.validation,\s*quickCandidateToMarkdown\(view\)\)/u,
    '创作区复制全部的最终 clipboard 边界必须使用同一 helper',
  );
  for (const source of [note, comments, result]) {
    assert.match(source, /candidateClipboardText/u);
  }
});

test('历史人工确认记录仍随校验结论展示，不删审计痕迹', () => {
  // 历史记录只进导出附录，不再参与当前交付权限或伪装成当前确认状态
  assert.match(utils, /## 人工交付确认/u);
  assert.match(utils, /manualDeliveryConfirmation\?\.confirmed !== true/u);
  assert.doesNotMatch(page, /manuallyConfirmed=/u);
  assert.doesNotMatch(page, /validation\.valid\s*=\s*true/u);
});

test('校验问题默认折叠，工作区保留完整结论', () => {
  assert.match(detail, /<ValidationVerdict/u);
  assert.match(verdict, /<details className="qc-verdict__group qc-verdict__group--blocking">/u);
});
