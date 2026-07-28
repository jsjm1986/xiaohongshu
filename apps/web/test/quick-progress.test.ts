import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationProgressValue, progressStageText } from '../src/lib/quick-progress.js';

test('progressStageText maps each progress range to a stage label', () => {
  assert.equal(progressStageText(undefined), '排队等待中');
  assert.equal(progressStageText(0), '排队等待中');
  assert.equal(progressStageText(11), '排队等待中');
  assert.equal(progressStageText(12), '解析选题与已确认信息');
  assert.equal(progressStageText(27), '解析选题与已确认信息');
  assert.equal(progressStageText(28), '组织内容结构');
  assert.equal(progressStageText(49), '组织内容结构');
  assert.equal(progressStageText(50), '生成初稿');
  assert.equal(progressStageText(89), '生成初稿');
  assert.equal(progressStageText(90), '质检与合规校验');
  assert.equal(progressStageText(99), '质检与合规校验');
  assert.equal(progressStageText(100), '完成');
  assert.equal(progressStageText(120), '完成');
});

test('generationProgressValue preserves a real queued 0 instead of inventing progress', () => {
  assert.equal(generationProgressValue(0), 0);
  assert.equal(generationProgressValue(12), 12);
  assert.equal(generationProgressValue(undefined), 0);
});
