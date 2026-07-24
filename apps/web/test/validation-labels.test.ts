import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstValidationIssueLabel, validationIssueLabel } from '../src/lib/validation-labels.js';

test('validationIssueLabel:已知 code 返回中文说明', () => {
  assert.equal(validationIssueLabel('title_required'), '缺少标题');
  assert.equal(validationIssueLabel('body_too_short'), '正文低于最少字数');
  assert.equal(validationIssueLabel('ungrounded_fact'), '事实没有证据引用');
});

test('validationIssueLabel:未知或空 code 返回 null', () => {
  assert.equal(validationIssueLabel('not_a_real_code'), null);
  assert.equal(validationIssueLabel(''), null);
  assert.equal(validationIssueLabel(undefined), null);
});

test('firstValidationIssueLabel:跳过不可识别 code,取首个可识别', () => {
  assert.equal(firstValidationIssueLabel(['unknown_x', 'body_required', 'title_required']), '缺少正文');
  assert.equal(firstValidationIssueLabel(['title_required']), '缺少标题');
});

test('firstValidationIssueLabel:空数组/undefined/全不可识别返回 null', () => {
  assert.equal(firstValidationIssueLabel([]), null);
  assert.equal(firstValidationIssueLabel(undefined), null);
  assert.equal(firstValidationIssueLabel(['unknown_x', 'unknown_y']), null);
});
