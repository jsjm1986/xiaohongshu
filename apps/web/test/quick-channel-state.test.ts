import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tabReachable,
  clearDownstreamOfProject,
  clearResults,
  stepStatus,
  initialZone,
  zoneReachable,
  createStepReachable,
  createStepStatus,
} from '../src/lib/quick-channel-state.js';

test('project and history tabs reachable whenever a project exists', () => {
  const r = tabReachable({ hasProject: true, opportunityCount: 0, hasOpportunity: false, resultCount: 0 });
  assert.equal(r.project, true);
  assert.equal(r.history, true);
  assert.equal(r.topic, false);
  assert.equal(r.config, false);
  assert.equal(r.result, false);
});

test('project tab reachable even with no project; history needs a project', () => {
  const r = tabReachable({ hasProject: false, opportunityCount: 0, hasOpportunity: false, resultCount: 0 });
  assert.equal(r.project, true);
  assert.equal(r.history, false);
});

test('topic reachable once opportunities exist, config once one is picked', () => {
  const r = tabReachable({ hasProject: true, opportunityCount: 3, hasOpportunity: true, resultCount: 0 });
  assert.equal(r.topic, true);
  assert.equal(r.config, true);
  assert.equal(r.result, false);
});

test('result reachable once results exist', () => {
  const r = tabReachable({ hasProject: true, opportunityCount: 3, hasOpportunity: true, resultCount: 3 });
  assert.equal(r.result, true);
});

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

test('stepStatus:无项目时仅 project 为 current,其余 locked', () => {
  const s = stepStatus({
    activeTab: 'project', hasProject: false, opportunityCount: 0, hasOpportunity: false, resultCount: 0,
  });
  assert.equal(s.project, 'current');
  assert.equal(s.topic, 'locked');
  assert.equal(s.config, 'locked');
  assert.equal(s.result, 'locked');
  assert.equal(s.history, 'locked');
});

test('stepStatus:已选项目+已有选题,project 为 done,topic 为 current', () => {
  const s = stepStatus({
    activeTab: 'topic', hasProject: true, opportunityCount: 3, hasOpportunity: false, resultCount: 0,
  });
  assert.equal(s.project, 'done');
  assert.equal(s.topic, 'current');
  assert.equal(s.history, 'active');
});

test('stepStatus:当前所在标签恒为 current(即使其前置已完成)', () => {
  const s = stepStatus({
    activeTab: 'config', hasProject: true, opportunityCount: 3, hasOpportunity: true, resultCount: 0,
  });
  assert.equal(s.project, 'done');
  assert.equal(s.topic, 'done');
  assert.equal(s.config, 'current');
  assert.equal(s.result, 'locked');
});

test('stepStatus:有结果后 result 为 done 或 current', () => {
  const s = stepStatus({
    activeTab: 'result', hasProject: true, opportunityCount: 3, hasOpportunity: true, resultCount: 2,
  });
  assert.equal(s.result, 'current');
  assert.equal(s.config, 'done');
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
