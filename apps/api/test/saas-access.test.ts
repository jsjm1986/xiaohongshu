import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSaasApiAllowed } from '../src/saas-access.js';

const cases: Array<[string, string, boolean]> = [
  // 会话态认证路由只放行实际存在且基础版需要的 method
  ['GET', '/api/auth/me', true],
  ['POST', '/api/auth/logout', true],
  ['POST', '/api/auth/change-password', true],
  ['POST', '/api/auth/me', false],
  // /api/workspaces:仅 exact GET 放行,子路径一律拒绝
  ['GET', '/api/workspaces', true],
  ['POST', '/api/workspaces', false],
  ['GET', '/api/workspaces/w1/members', false],
  ['PUT', '/api/workspaces/w1/members/u2', false],
  // 项目根资源与基础版工作流逐条放行
  ['GET', '/api/projects', true],
  ['POST', '/api/projects', true],
  ['PATCH', '/api/projects/p1', true],
  ['DELETE', '/api/projects/p1', true],
  ['POST', '/api/projects/p1/intelligence/analyze', true],
  ['GET', '/api/projects/p1/intelligence/analysis-tasks/t1', true],
  ['POST', '/api/projects/p1/intelligence/i1/approve', true],
  ['GET', '/api/projects/p1/blueprint-modules', true],
  ['POST', '/api/projects/p1/blueprint-modules/m1/approve', true],
  ['GET', '/api/projects/p1/information-gaps', true],
  ['POST', '/api/projects/p1/information-gaps/g1/approve', true],
  ['GET', '/api/projects/p1/expression-strategies', true],
  ['POST', '/api/projects/p1/expression-strategies/s1/approve', true],
  ['GET', '/api/projects/p1/topic-opportunities', true],
  ['POST', '/api/projects/p1/topic-opportunities/refresh', true],
  ['POST', '/api/projects/p1/topic-opportunities/o1/collection', true],
  ['DELETE', '/api/projects/p1/topic-opportunities/o1', true],
  ['GET', '/api/projects/p1/opportunity-prompt-templates', true],
  ['POST', '/api/projects/p1/opportunity-prompt-templates', true],
  ['GET', '/api/projects/p1/image-assets/a1/content', true],
  ['POST', '/api/projects/p1/image-assets/a1/analyze', true],
  ['POST', '/api/projects/p1/image-assets/a1/analyses/an1/approve', true],
  ['GET', '/api/projects/p1/knowledge', true],
  ['GET', '/api/projects/p1/presets', true],
  ['POST', '/api/projects/p1/presets/pr1/default', true],
  // 同前缀下的专家/管理路由默认拒绝，新增路由不会自动获得权限
  ['GET', '/api/projects/p1/acl', false],
  ['PUT', '/api/projects/p1/acl/u1', false],
  ['GET', '/api/projects/p1/style-profile', false],
  ['PATCH', '/api/projects/p1/information-gaps/g1', false],
  ['PATCH', '/api/projects/p1/image-assets/a1/analyses/an1', false],
  ['POST', '/api/projects/p1/resolve-config', false],
  ['GET', '/api/projects/p1/coverage', false],
  // research 子路径拒绝
  ['GET', '/api/projects/p1/research/overview', false],
  ['POST', '/api/projects/p1/research/overview', false],
  ['GET', '/api/projects/p1/research/claims/c1', false],
  // 知识、生成按实际 method + shape 放行
  ['GET', '/api/knowledge', true],
  ['PATCH', '/api/knowledge/k1', true],
  ['POST', '/api/generations', true],
  ['POST', '/api/generations/j1/revise', true],
  ['GET', '/api/generations/j1/trace', true],
  ['POST', '/api/generations/j1/trace', false],
  ['GET', '/api/generations/j1/candidates/c1/export', true],
  // 人工确认发起端点已按交付政策移除,白名单不再放行
  ['POST', '/api/generations/j1/candidates/c1/manual-delivery-confirmation', false],
  ['GET', '/api/generations/j1/candidates/c1/manual-delivery-confirmation', false],
  ['PATCH', '/api/generations/j1', false],
  // 批量生成只放行控制器实际提供的 GET/POST
  ['GET', '/api/generation-batches', true],
  ['POST', '/api/generation-batches', true],
  ['GET', '/api/generation-batches/b1', true],
  ['DELETE', '/api/generation-batches/b1', false],
  // 前缀陷阱:generation-batches 不得被 generations 误命中,且必须按段边界匹配
  ['GET', '/api/generation-batchesX', false],
  // generation-parameters schema 仅 GET
  ['GET', '/api/generation-parameters/schema', true],
  ['POST', '/api/generation-parameters/schema', false],
  // 额度只读:仅这一条精确路径放行。裸 /api/settings 仍拒——它的 publicSettings
  // 会连带吐出 apiBaseUrl / model / generationDefaults,租户不该看到基础设施细节。
  ['GET', '/api/settings/quota', true],
  ['GET', '/api/settings/quota/ledger', true],
  ['POST', '/api/settings/quota/ledger', false],
  ['POST', '/api/settings/quota', false],
  ['PATCH', '/api/settings/quota', false],
  ['DELETE', '/api/settings/quota', false],
  // 前缀陷阱:放行的是精确路径,不是前缀
  ['GET', '/api/settings/quota/anything', false],
  ['GET', '/api/settings/quotaX', false],
  // 其他全部拒绝
  ['GET', '/api/admin/users', false],
  ['GET', '/api/audit', false],
  ['GET', '/api/settings', false],
  ['PATCH', '/api/settings', false],
  ['POST', '/api/register', false],
  ['GET', '/api/formulas', false],
  ['GET', '/v1/projects', false],
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
