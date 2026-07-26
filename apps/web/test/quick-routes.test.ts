import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchRoutes } from 'react-router-dom';
import {
  AREA_LABELS,
  AREA_ORDER,
  areaPath,
  DEFAULT_AREA,
  isWorkspaceSegment,
  parseArea,
  projectPath,
  QUICK_RESERVED_SEGMENTS,
} from '../src/lib/quick-routes.js';

test('四个区,顺序即步骤顺序', () => {
  assert.deepEqual(AREA_ORDER, ['overview', 'knowledge', 'create', 'history']);
  assert.equal(DEFAULT_AREA, 'overview');
  assert.deepEqual(Object.keys(AREA_LABELS).sort(), [...AREA_ORDER].sort());
});

test('areaPath 拼出 /quick/:projectId/:area', () => {
  assert.equal(areaPath('p1', 'overview'), '/quick/p1/overview');
  assert.equal(areaPath('p1', 'history'), '/quick/p1/history');
  assert.equal(areaPath('p1'), '/quick/p1/overview');
  assert.equal(projectPath('p1'), '/quick/p1');
});

// 地址要被收藏和分享,不假设 projectId 永远无需转义
test('areaPath / projectPath 对 projectId 做 URL 转义', () => {
  assert.equal(areaPath('a/b', 'create'), '/quick/a%2Fb/create');
  assert.equal(projectPath('a b'), '/quick/a%20b');
});

test('parseArea 认得四个合法区', () => {
  for (const area of AREA_ORDER) {
    assert.deepEqual(parseArea(area), { area, fallback: false });
  }
});

// 手改地址、旧收藏、拼错:一律落默认区,并且要能被识别为兜底(调用方据此 replace 地址)
test('parseArea 对非法值落默认区并标记 fallback', () => {
  for (const raw of ['', 'nope', 'Overview', 'HISTORY', 'read', undefined, null]) {
    assert.deepEqual(parseArea(raw), { area: 'overview', fallback: true }, `raw=${String(raw)}`);
  }
});

test('固定段名单与工作区段判别', () => {
  assert.deepEqual([...QUICK_RESERVED_SEGMENTS].sort(), ['account', 'read']);
  assert.equal(isWorkspaceSegment('some-project-id'), true);
  assert.equal(isWorkspaceSegment('read'), false);
  assert.equal(isWorkspaceSegment('account'), false);
  assert.equal(isWorkspaceSegment(''), false);
});

/*
 * 静态段 vs 动态段:/quick/read/:jobId 与 /quick/:projectId/:area 都能匹配
 * /quick/read/xxx。React Router 的 rank 规则让静态段胜出,但那是隐式行为——
 * 用 matchRoutes 断言,而不是靠直觉。一旦哪天 router 升级改了 rank,这里会红。
 */
const ROUTES = [
  { path: '/quick' },
  { path: '/quick/account' },
  { path: '/quick/read/:jobId' },
  {
    path: '/quick/:projectId',
    children: [
      { index: true },
      { path: 'overview' },
      { path: 'knowledge' },
      { path: 'create' },
      { path: 'history' },
      { path: '*' },
    ],
  },
];

const matchedPaths = (pathname: string): string[] =>
  (matchRoutes(ROUTES, pathname) ?? []).map((m) => m.route.path ?? '(index)');

test('固定段不被 :projectId 吃掉', () => {
  assert.deepEqual(matchedPaths('/quick/read/job-1'), ['/quick/read/:jobId']);
  assert.deepEqual(matchedPaths('/quick/account'), ['/quick/account']);
});

test('工作区四区各自命中自己的子路由', () => {
  assert.deepEqual(matchedPaths('/quick/p1/overview'), ['/quick/:projectId', 'overview']);
  assert.deepEqual(matchedPaths('/quick/p1/history'), ['/quick/:projectId', 'history']);
});

test('项目根命中 index(由它重定向到默认区)', () => {
  assert.deepEqual(matchedPaths('/quick/p1'), ['/quick/:projectId', '(index)']);
});

test('认不出的区段落到通配子路由,而不是无匹配', () => {
  assert.deepEqual(matchedPaths('/quick/p1/nope'), ['/quick/:projectId', '*']);
});
