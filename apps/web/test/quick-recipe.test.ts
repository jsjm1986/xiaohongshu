import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractRecipe, resolveRecipeTargets } from '../src/lib/quick-recipe.js';
import type { ContentPreset, GenerationJob, TopicOpportunity } from '../src/types.js';

const job = {
  id: 'j1', projectId: 'p1', topic: 'T', mode: 'simple', status: 'completed',
  opportunityId: 'o1', presetId: 'pr1',
  resolvedConfig: { task: { audienceStage: 'collecting', entryPoint: 'search', city: '上海', doctor: '张三', mustMention: '玻尿酸', forbidden: '最好' } },
} as unknown as GenerationJob;

test('extractRecipe pulls opportunity, preset, overrides from job', () => {
  const recipe = extractRecipe(job);
  assert.equal(recipe.opportunityId, 'o1');
  assert.equal(recipe.presetId, 'pr1');
  assert.equal(recipe.overrides.city, '上海');
  assert.equal(recipe.overrides.doctor, '张三');
  assert.equal(recipe.overrides.audienceStage, 'collecting');
  assert.equal(recipe.overrides.entryPoint, 'search');
  assert.equal(recipe.overrides.mustInclude, '玻尿酸');
  assert.equal(recipe.overrides.forbidden, '最好');
});

test('extractRecipe falls back to opportunitySnapshot id and tolerates empty config', () => {
  const bare = {
    id: 'j2', projectId: 'p1', topic: 'T', mode: 'simple', status: 'completed',
    opportunitySnapshot: { id: 'o9' },
  } as unknown as GenerationJob;
  const recipe = extractRecipe(bare);
  assert.equal(recipe.opportunityId, 'o9');
  assert.equal(recipe.presetId, undefined);
  assert.deepEqual(recipe.overrides, {});
  assert.deepEqual(recipe.imageAssetIds, []);
});

test('resolveRecipeTargets keeps targets when both exist', () => {
  const opps = [{ id: 'o1', title: 'T' }] as unknown as TopicOpportunity[];
  const presets = [{ id: 'pr1', name: 'P' }] as unknown as ContentPreset[];
  const r = resolveRecipeTargets({ opportunityId: 'o1', presetId: 'pr1', overrides: {}, imageAssetIds: [] }, opps, presets);
  assert.equal(r.opportunityId, 'o1');
  assert.equal(r.presetId, 'pr1');
  assert.deepEqual(r.warnings, []);
});

test('resolveRecipeTargets warns and clears opportunity when it is gone', () => {
  const presets = [{ id: 'pr1', name: 'P' }] as unknown as ContentPreset[];
  const r = resolveRecipeTargets({ opportunityId: 'oX', presetId: 'pr1', overrides: {}, imageAssetIds: [] }, [], presets);
  assert.equal(r.opportunityId, '');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /选题/);
});

test('resolveRecipeTargets falls back to default preset when preset deleted', () => {
  const opps = [{ id: 'o1', title: 'T' }] as unknown as TopicOpportunity[];
  const presets = [{ id: 'prDefault', name: 'D', isDefault: true }] as unknown as ContentPreset[];
  const r = resolveRecipeTargets({ opportunityId: 'o1', presetId: 'prX', overrides: {}, imageAssetIds: [] }, opps, presets);
  assert.equal(r.presetId, 'prDefault');
  assert.equal(r.warnings.some((w) => /预设/.test(w)), true);
});

test('resolveRecipeTargets carries overrides and image ids through untouched', () => {
  const opps = [{ id: 'o1', title: 'T' }] as unknown as TopicOpportunity[];
  const presets = [{ id: 'pr1', name: 'P' }] as unknown as ContentPreset[];
  const r = resolveRecipeTargets(
    { opportunityId: 'o1', presetId: 'pr1', overrides: { city: '北京', commentRichness: 'dense' }, imageAssetIds: ['a1', 'a2'] },
    opps,
    presets,
  );
  assert.equal(r.overrides.city, '北京');
  assert.equal(r.overrides.commentRichness, 'dense');
  assert.deepEqual(r.imageAssetIds, ['a1', 'a2']);
});
