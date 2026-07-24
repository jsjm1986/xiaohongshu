import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearDownstreamOfProject,
  clearResults,
  initialZone,
  zoneReachable,
  createStepReachable,
  createStepStatus,
} from '../src/lib/quick-channel-state.js';

test('changing project clears opportunities, selection, and results', () => {
  const cleared = clearDownstreamOfProject();
  assert.deepEqual(cleared.opportunities, []);
  assert.equal(cleared.opportunityId, '');
  assert.deepEqual(cleared.results, []);
});

test('changing topic clears only results', () => {
  const cleared = clearResults();
  assert.deepEqual(cleared.results, []);
  assert.equal((cleared as Record<string, unknown>).opportunityId, undefined);
});

test('initialZone:有选题落创作区,无选题落准备区', () => {
  assert.equal(initialZone({ opportunityCount: 3 }), 'create');
  assert.equal(initialZone({ opportunityCount: 0 }), 'prepare');
});

test('zoneReachable:准备区恒可达;创作区需有选题;历史需有项目', () => {
  const none = zoneReachable({ hasProject: false, opportunityCount: 0 });
  assert.equal(none.prepare, true);
  assert.equal(none.create, false);
  assert.equal(none.history, false);
  const ready = zoneReachable({ hasProject: true, opportunityCount: 5 });
  assert.equal(ready.create, true);
  assert.equal(ready.history, true);
});

test('createStepReachable:topic 需选题,config 需已选,result 需有结果', () => {
  const r = createStepReachable({ opportunityCount: 3, hasOpportunity: true, resultCount: 0 });
  assert.equal(r.topic, true);
  assert.equal(r.config, true);
  assert.equal(r.result, false);
});

test('createStepStatus:当前步恒 current,已完成前置为 done,未达为 locked', () => {
  const s = createStepStatus({ activeStep: 'config', opportunityCount: 3, hasOpportunity: true, resultCount: 0 });
  assert.equal(s.topic, 'done');   // 已选题 → topic 完成
  assert.equal(s.config, 'current');
  assert.equal(s.result, 'locked'); // 尚无结果
});

test('createStepStatus:有结果后 config 为 done、result 可为 current', () => {
  const s = createStepStatus({ activeStep: 'result', opportunityCount: 3, hasOpportunity: true, resultCount: 2 });
  assert.equal(s.topic, 'done');
  assert.equal(s.config, 'done');
  assert.equal(s.result, 'current');
});
