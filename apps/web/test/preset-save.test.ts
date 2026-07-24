import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPresetValuesFromOverrides } from '../src/lib/preset-save.js';
import { COMMENT_MULTI_TURN_GROWTH_BY_LEVEL, COMMENT_RICHNESS_PROFILES } from '../src/lib/simple-generation.js';

test('buildPresetValuesFromOverrides returns {} for empty overrides', () => {
  assert.deepEqual(buildPresetValuesFromOverrides({}), {});
});

test('buildPresetValuesFromOverrides maps stage/entry to registry parameter ids', () => {
  assert.deepEqual(
    buildPresetValuesFromOverrides({ audienceStage: 'comparing', entryPoint: 'search' }),
    { audience_stage: 'comparing', entry_route: 'search' },
  );
});

test('buildPresetValuesFromOverrides expands all three commentRichness levels', () => {
  for (const level of ['restrained', 'balanced', 'dense'] as const) {
    const values = buildPresetValuesFromOverrides({ commentRichness: level });
    for (const [key, value] of Object.entries(COMMENT_RICHNESS_PROFILES[level].values)) {
      assert.equal(values[key], value, `${level}.${key}`);
    }
    assert.equal(values.comment_multi_turn_growth, COMMENT_MULTI_TURN_GROWTH_BY_LEVEL[level], `${level}.comment_multi_turn_growth`);
  }
  // 克制档关闭多轮接龙,均衡/高密度开启
  assert.equal(buildPresetValuesFromOverrides({ commentRichness: 'restrained' }).comment_multi_turn_growth, false);
  assert.equal(buildPresetValuesFromOverrides({ commentRichness: 'balanced' }).comment_multi_turn_growth, true);
  assert.equal(buildPresetValuesFromOverrides({ commentRichness: 'dense' }).comment_multi_turn_growth, true);
});

test('buildPresetValuesFromOverrides keeps project-level fields out of presets', () => {
  assert.deepEqual(
    buildPresetValuesFromOverrides({ city: '上海', doctor: '王医生', mustInclude: '资质', forbidden: '保证效果' }),
    {},
  );
});
