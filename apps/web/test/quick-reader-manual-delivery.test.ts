import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/QuickReaderPage.tsx', import.meta.url), 'utf8');
const result = readFileSync(new URL('../src/pages/GenerationResultPage.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../src/components/quick/ReaderDetail.tsx', import.meta.url), 'utf8');
const note = readFileSync(new URL('../src/components/quick/NoteCard.tsx', import.meta.url), 'utf8');
const comments = readFileSync(new URL('../src/components/quick/NoteComments.tsx', import.meta.url), 'utf8');
const alert = readFileSync(new URL('../src/components/quick/NoteAlertBar.tsx', import.meta.url), 'utf8');

/**
 * 交付门禁的既定决策(delivery-readiness):正式模型产物即可交付,复核发现
 * 保持可见但不再需要确认点击;只有机械硬门禁 blocked 锁死复制与导出。
 * 人工确认的「发起」入口曾是永不可达的死分支(deliveryReadiness 从不返回
 * human_reviewable),已按该决策清理——这组断言防它无意识回潮:
 * 恢复确认流程必须是显式的产品决定,不是残骸复活。
 */
test('人工确认的发起入口已按交付政策清理，不得无意识回潮', () => {
  for (const source of [page, result]) {
    assert.doesNotMatch(source, /confirmManualDelivery/u);
    assert.doesNotMatch(source, /manualConfirmChecked/u);
    assert.doesNotMatch(source, /我已核对事实、证据、身份与风险/u);
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
  assert.match(page, /四种格式统一走服务端/u);
});

test('历史人工确认记录仍随校验结论展示，不删审计痕迹', () => {
  // NoteAlertBar 对带历史确认记录的包如实标注,不伪装成自动通过
  assert.match(alert, /自动校验未通过 · 已人工确认，可复制与导出/u);
  assert.match(page, /manuallyConfirmed=\{current\.manualDeliveryConfirmation\?\.confirmed === true\}/u);
  assert.doesNotMatch(page, /validation\.valid\s*=\s*true/u);
});

test('校验问题默认折叠，工作区保留完整结论', () => {
  assert.match(detail, /<ValidationVerdict/u);
  assert.match(readFileSync(new URL('../src/components/quick/ValidationVerdict.tsx', import.meta.url), 'utf8'), /<details className="qc-verdict__group qc-verdict__group--blocking">/u);
});
