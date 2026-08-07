import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/pages/QuickReaderPage.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../src/components/quick/ReaderDetail.tsx', import.meta.url), 'utf8');
const note = readFileSync(new URL('../src/components/quick/NoteCard.tsx', import.meta.url), 'utf8');
const comments = readFileSync(new URL('../src/components/quick/NoteComments.tsx', import.meta.url), 'utf8');
const alert = readFileSync(new URL('../src/components/quick/NoteAlertBar.tsx', import.meta.url), 'utf8');

test('极简阅读页紧凑展示候选级人工交付确认', () => {
  assert.match(page, /current\.validation\?\.valid !== true && \(/u);
  assert.match(page, /人工核对后解锁复制与导出/u);
  assert.match(page, /我已核对事实、证据、身份与风险/u);
  assert.match(page, /api\.generations\.confirmManualDelivery\(jobId, activeCandidate\.id\)/u);
  assert.match(page, /setJob\(await api\.generations\.reader\(jobId\)\)/u);
  assert.match(page, /仅限当前用户与候选，自动校验结论保留/u);
  assert.match(page, /setManualConfirmChecked\(false\)/u);
});

test('自动通过或人工确认后才开放极简页全部复制与导出入口', () => {
  assert.match(page, /const deliverable = publishable \|\| manuallyConfirmed/u);
  assert.match(page, /copyEnabled=\{deliverable\}/u);
  assert.match(page, /deliverable=\{deliverable\}/u);
  assert.match(note, /disabled=\{!copyEnabled\}/u);
  assert.match(comments, /disabled=\{!copyEnabled\}/u);
  assert.match(detail, /disabled=\{!deliverable\}/u);
  assert.match(detail, /const blocked = !deliverable/u);
  assert.match(page, /四种格式统一走服务端/u);
});

test('人工确认不伪装成自动校验通过', () => {
  assert.match(alert, /自动校验未通过 · 已人工确认，可复制与导出/u);
  assert.match(detail, /自动校验结论仍保留/u);
  assert.doesNotMatch(page, /validation\.valid\s*=\s*true/u);
});

test('极简阅读页确认操作原地切换为交付入口，校验问题默认折叠', () => {
  assert.match(page, /已人工确认，可复制与导出/u);
  assert.match(page, /copyConfirmedCandidate\(current\)/u);
  assert.match(page, /exportAs\(current, format\)/u);
  assert.match(detail, /<ValidationVerdict/u);
  assert.match(readFileSync(new URL('../src/components/quick/ValidationVerdict.tsx', import.meta.url), 'utf8'), /<details className="qc-verdict__group qc-verdict__group--blocking">/u);
});
