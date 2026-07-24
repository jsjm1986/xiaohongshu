import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  tabReachable,
  clearDownstreamOfProject,
  clearResults,
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
