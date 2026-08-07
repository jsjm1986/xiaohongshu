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

test('resolveRecipeTargets treats stale or blocked opportunities as unavailable', () => {
  const presets = [{ id: 'pr1', name: 'P' }] as unknown as ContentPreset[];
  for (const opportunity of [
    { id: 'o1', status: 'stale' },
    { id: 'o1', approvalStatus: 'stale' },
    { id: 'o1', eligibilityStatus: 'blocked' },
    { id: 'o1', effectiveEligibility: 'ineligible' },
  ]) {
    const result = resolveRecipeTargets(
      { opportunityId: 'o1', presetId: 'pr1', overrides: {}, imageAssetIds: [] },
      [opportunity] as unknown as TopicOpportunity[],
      presets,
    );
    assert.equal(result.opportunityId, '');
    assert.match(result.warnings[0]!, /失效|当前选题池/);
  }
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

// ── 回归防线:真实 resolvedConfig.task 形状(来自后端 ResolvedGenerationConfig) ──
// mustMention/forbidden 是 string[](后端 lines() 按 \n , ， 、 ; ； 拆分),
// 入口字段名是 entry 而非 entryPoint。若实现只按 string 读,这些覆盖项会静默丢失。

test('extractRecipe reads real backend task shape: string[] words and entry alias', () => {
  const real = {
    id: 'j3', projectId: 'p1', topic: 'T', mode: 'simple', status: 'completed',
    opportunityId: 'o1', presetId: 'pr1',
    resolvedConfig: {
      task: {
        audienceStage: 'comparing',
        entry: 'recommendation',
        city: '杭州',
        doctor: '李医生',
        mustMention: ['术后随访', '面诊'],
        forbidden: ['最好', '包治百病'],
        commentRichness: 'dense',
      },
    },
  } as unknown as GenerationJob;
  const recipe = extractRecipe(real);
  assert.equal(recipe.overrides.entryPoint, 'recommendation');
  assert.equal(recipe.overrides.mustInclude, '术后随访、面诊');
  assert.equal(recipe.overrides.forbidden, '最好、包治百病');
  assert.equal(recipe.overrides.city, '杭州');
  assert.equal(recipe.overrides.doctor, '李医生');
  assert.equal(recipe.overrides.commentRichness, 'dense');
});

test('extractRecipe drops empty word arrays instead of writing empty overrides', () => {
  const empty = {
    id: 'j4', projectId: 'p1', topic: 'T', mode: 'simple', status: 'completed',
    resolvedConfig: { task: { mustMention: [], forbidden: ['  '] } },
  } as unknown as GenerationJob;
  const recipe = extractRecipe(empty);
  assert.equal(recipe.overrides.mustInclude, undefined);
  assert.equal(recipe.overrides.forbidden, undefined);
});

test('extractRecipe collects source image asset ids from imageContext', () => {
  const withImages = {
    id: 'j5', projectId: 'p1', topic: 'T', mode: 'simple', status: 'completed',
    imageContext: [{ assetId: 'a1' }, { assetId: 'a2' }],
  } as unknown as GenerationJob;
  assert.deepEqual(extractRecipe(withImages).imageAssetIds, ['a1', 'a2']);
});

test('extractRecipe preserves institution publishing topology for retry', () => {
  const institution = {
    id: 'j-institution', projectId: 'p1', topic: 'T', mode: 'simple', status: 'failed',
    opportunityId: 'o1', presetId: 'pr1',
    resolvedConfig: { task: { publishingTopology: 'institution_owned', authorContext: { status: 'not_provided', facts: [] } } },
  } as unknown as GenerationJob;
  assert.deepEqual(extractRecipe(institution).publishing, { publishingTopology: 'institution_owned' });
});

test('extractRecipe preserves confirmed author facts but drops old confirmation identity', () => {
  const individual = {
    id: 'j-author', projectId: 'p1', topic: 'T', mode: 'simple', status: 'failed',
    opportunityId: 'o1', presetId: 'pr1',
    resolvedConfig: { task: {
      publishingTopology: 'confirmed_individual_author',
      authorContext: { status: 'confirmed', facts: [{
        id: 'af1', statement: '我只能周末安排', category: 'constraint',
        confirmedBy: 'old-user', confirmedAt: '2025-01-01T00:00:00.000Z', confirmationId: 'old-confirmation',
      }] },
    } },
  } as unknown as GenerationJob;
  assert.deepEqual(extractRecipe(individual).publishing, {
    publishingTopology: 'confirmed_individual_author',
    authorFacts: [{ id: 'af1', statement: '我只能周末安排', category: 'constraint' }],
    authorFactsConfirmed: true,
  });
  assert.equal(JSON.stringify(extractRecipe(individual).publishing).includes('old-user'), false);
  assert.equal(JSON.stringify(extractRecipe(individual).publishing).includes('old-confirmation'), false);
});

test('historical recipes without publishing topology remain retryable with an empty contract', () => {
  const opps = [{ id: 'o1', title: 'T' }] as unknown as TopicOpportunity[];
  const presets = [{ id: 'pr1', name: 'P' }] as unknown as ContentPreset[];
  const resolved = resolveRecipeTargets(
    { opportunityId: 'o1', presetId: 'pr1', overrides: {}, imageAssetIds: [] },
    opps,
    presets,
  );
  assert.deepEqual(resolved.publishing, {});
});
