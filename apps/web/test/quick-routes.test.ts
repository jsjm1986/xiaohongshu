import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchRoutes } from 'react-router-dom';
import {
  AREA_LABELS,
  AREA_ORDER,
  areaPath,
  DEFAULT_AREA,
  QUICK_RESERVED_SEGMENTS,
} from '../src/lib/quick-routes.js';

test('四个区,顺序即步骤顺序', () => {
  assert.deepEqual(AREA_ORDER, ['overview', 'knowledge', 'create', 'history']);
  assert.equal(DEFAULT_AREA, 'overview');
  assert.deepEqual(Object.keys(AREA_LABELS).sort(), [...AREA_ORDER].sort());
});

test('areaPath 拼出 /quick/:projectId/:area,省略区时给默认区', () => {
  assert.equal(areaPath('p1', 'overview'), '/quick/p1/overview');
  assert.equal(areaPath('p1', 'history'), '/quick/p1/history');
  assert.equal(areaPath('p1'), '/quick/p1/overview');
});

// 地址要被收藏和分享,不假设 projectId 永远无需转义
test('areaPath 对 projectId 做 URL 转义', () => {
  assert.equal(areaPath('a/b', 'create'), '/quick/a%2Fb/create');
  assert.equal(areaPath('a b', 'create'), '/quick/a%20b/create');
});

// 固定段与项目 id 抢同一个位置,名单要和 App.tsx 的路由表对得上
test('固定段名单', () => {
  assert.deepEqual([...QUICK_RESERVED_SEGMENTS].sort(), ['account', 'read']);
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
