import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSaasApiAllowed } from '../src/saas-access.js';

const cases: Array<[string, string, boolean]> = [
  // /api/auth 全放行
  ['GET', '/api/auth/me', true],
  ['POST', '/api/auth/me', true],
  // /api/workspaces:仅 exact GET 放行,子路径一律拒绝
  ['GET', '/api/workspaces', true],
  ['POST', '/api/workspaces', false],
  ['GET', '/api/workspaces/w1/members', false],
  ['PUT', '/api/workspaces/w1/members/u2', false],
  // /api/projects 及子路径放行
  ['GET', '/api/projects', true],
  ['POST', '/api/projects', true],
  ['PATCH', '/api/projects/p1', true],
  ['DELETE', '/api/projects/p1', true],
  ['POST', '/api/projects/p1/intelligence/analyze', true],
  ['GET', '/api/projects/p1/knowledge', true],
  ['GET', '/api/projects/p1/presets', true],
  ['POST', '/api/projects/p1/resolve-config', true],
  // research 子路径禁止优先(GET/POST 均拒)
  ['GET', '/api/projects/p1/research/overview', false],
  ['POST', '/api/projects/p1/research/overview', false],
  ['GET', '/api/projects/p1/research/claims/c1', false],
  // /api/knowledge、/api/generations 全放行
  ['GET', '/api/knowledge', true],
  ['POST', '/api/generations', true],
  ['POST', '/api/generations/j1/revise', true],
  // /api/generation-batches 批量生成全放行
  ['GET', '/api/generation-batches', true],
  ['POST', '/api/generation-batches', true],
  ['GET', '/api/generation-batches/b1', true],
  ['DELETE', '/api/generation-batches/b1', true],
  // 前缀陷阱:generation-batches 不得被 generations 误命中,且必须按段边界匹配
  ['GET', '/api/generation-batchesX', false],
  // generation-parameters schema 仅 GET
  ['GET', '/api/generation-parameters/schema', true],
  ['POST', '/api/generation-parameters/schema', false],
  // 其他全部拒绝
  ['GET', '/api/admin/users', false],
  ['GET', '/api/audit', false],
  ['GET', '/api/settings', false],
  ['PATCH', '/api/settings', false],
  ['POST', '/api/register', false],
  ['GET', '/api/formulas', false],
  ['GET', '/api/v1/projects', false],
  // 前缀陷阱:必须按路径段边界匹配
  ['GET', '/api/projectsX', false],
  ['GET', '/api/authx', false],
  ['GET', '/api/knowledgeX', false],
];

test('isSaasApiAllowed 白名单矩阵', () => {
  for (const [method, path, expected] of cases) {
    assert.equal(isSaasApiAllowed(method, path), expected, `${method} ${path}`);
  }
});

test('method 大小写不敏感', () => {
  assert.equal(isSaasApiAllowed('get', '/api/workspaces'), true);
  assert.equal(isSaasApiAllowed('Get', '/api/generation-parameters/schema'), true);
  assert.equal(isSaasApiAllowed('post', '/api/workspaces'), false);
});

test('query 不影响判定', () => {
  assert.equal(isSaasApiAllowed('GET', '/api/workspaces?limit=10'), true);
  assert.equal(isSaasApiAllowed('GET', '/api/projects?workspaceId=w1'), true);
  assert.equal(isSaasApiAllowed('GET', '/api/settings?x=1'), false);
  assert.equal(isSaasApiAllowed('GET', '/api/projects/p1/research/overview?pretty=1'), false);
});
