import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allValidationIssueLabels, firstValidationIssueLabel, validationIssueLabel } from '../src/lib/validation-labels.js';

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

// 产出卡此前只显示首条未通过项,其余静默丢弃:用户改完第一条又冒出第二条,
// 不知道到底还剩几处。allValidationIssueLabels 给出完整清单。
test('allValidationIssueLabels:按原顺序返回全部可识别说明', () => {
  assert.deepEqual(
    allValidationIssueLabels(['title_required', 'body_too_short']),
    ['缺少标题', '正文低于最少字数'],
  );
});

test('allValidationIssueLabels:不可识别 code 原样保留,不猜译也不丢', () => {
  assert.deepEqual(
    allValidationIssueLabels(['unknown_x', 'title_required']),
    ['unknown_x', '缺少标题'],
  );
});

test('allValidationIssueLabels:去重(同一 code 重复只留一条)', () => {
  assert.deepEqual(
    allValidationIssueLabels(['title_required', 'title_required', 'body_required']),
    ['缺少标题', '缺少正文'],
  );
});

test('allValidationIssueLabels:空数组/undefined 返回空数组', () => {
  assert.deepEqual(allValidationIssueLabels([]), []);
  assert.deepEqual(allValidationIssueLabels(undefined), []);
});
