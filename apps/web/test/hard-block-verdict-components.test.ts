import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { NoteAlertBar } from '../src/components/quick/NoteAlertBar.js';
import { ValidationVerdict } from '../src/components/quick/ValidationVerdict.js';

const passedValidation = {
  valid: true,
  qualityStatus: 'passed' as const,
  issues: [],
};

test('NoteAlertBar 中硬门禁优先于 passed，不得渲染绿色或直接发布', () => {
  const markup = renderToStaticMarkup(createElement(NoteAlertBar, {
    validation: passedValidation,
    deliverable: false,
    onSeeDetail: () => undefined,
  }));

  assert.match(markup, /xhs-alert--error/u);
  assert.match(markup, /存在硬门禁 · 须修复后重新生成/u);
  assert.match(markup, /lucide-triangle-alert/u);
  assert.doesNotMatch(markup, /xhs-alert--ok|lucide-check-circle|可直接发布|已通过可发布校验/u);
});

test('ValidationVerdict 中硬门禁优先于 passed，不得渲染通过图标或文案', () => {
  const markup = renderToStaticMarkup(createElement(ValidationVerdict, {
    validation: passedValidation,
    deliverable: false,
  }));

  assert.match(markup, /qc-verdict--blocked/u);
  assert.match(markup, /存在硬门禁 · 须修复后重新生成/u);
  assert.match(markup, /lucide-triangle-alert/u);
  assert.doesNotMatch(markup, /lucide-shield-check|可直接发布|已通过可发布校验|均已检查/u);
});
