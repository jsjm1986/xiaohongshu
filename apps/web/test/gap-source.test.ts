import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GAP_SOURCE_OPTIONS, sourceForAnswer } from '../src/lib/gap-source';

/**
 * 缺口答案的「资料来源」。
 *
 * supplied_fact 不可手选:它表示「资料里有出处」,只能由分析器基于 evidenceSections
 * 判定。若允许手选,用户会声称有资料支撑却拿不到任何 evidenceId(分节匹配不中,
 * 又因 sourceStatus !== 'user_supplied' 拿不到人工证据),答案在生成端照样被丢弃。
 */
test('不提供 supplied_fact 选项', () => {
  assert.ok(!GAP_SOURCE_OPTIONS.some((option) => option.value === 'supplied_fact'));
});

test('提供四种人能合法声明的来源', () => {
  assert.deepEqual(
    GAP_SOURCE_OPTIONS.map((option) => option.value),
    ['user_supplied', 'inference', 'hypothesis', 'unknown'],
  );
});

test('每个选项都有中文标签与说明', () => {
  for (const option of GAP_SOURCE_OPTIONS) {
    assert.ok(option.label.trim().length > 0, `${option.value} 缺标签`);
    assert.ok(option.hint.trim().length > 0, `${option.value} 缺说明`);
  }
});

test('「我确认过」的说明要点明它会被生成采用', () => {
  const confirmed = GAP_SOURCE_OPTIONS.find((option) => option.value === 'user_supplied');
  assert.match(confirmed!.hint, /采用/u);
});

test('填了答案默认选中「我确认过」', () => {
  assert.equal(sourceForAnswer('每天九点到六点'), 'user_supplied');
});

test('清空答案回落 unknown:没有答案的「我确认过」是矛盾状态', () => {
  assert.equal(sourceForAnswer('', 'user_supplied'), 'unknown');
  assert.equal(sourceForAnswer('   ', 'user_supplied'), 'unknown');
});

test('已经手动选过别的来源就不覆盖', () => {
  assert.equal(sourceForAnswer('答案', 'inference'), 'inference');
  assert.equal(sourceForAnswer('答案', 'hypothesis'), 'hypothesis');
});

test('分析写的 supplied_fact 不被人工路径改掉', () => {
  // 分析器判定的资料支撑要保留,不能因为用户碰了一下答案框就降级
  assert.equal(sourceForAnswer('答案', 'supplied_fact'), 'supplied_fact');
});

test('normalizer 认得 user_supplied,不会把它吞成 undefined', () => {
  // api.ts 那份白名单是硬编码的第二份取值清单,漏掉 user_supplied 会让
  // 「我确认过」存进去却读不回来,下拉框重载归零
  const source = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const match = /sourceStatus:\s*\[([^\]]+)\]/u.exec(source);
  assert.ok(match, 'api.ts 里找不到 sourceStatus 白名单');
  assert.match(match![1], /user_supplied/u);
});
