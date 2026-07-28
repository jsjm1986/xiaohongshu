import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NAV_GROUPS, navItemForPath } from '../src/lib/nav-groups';

/*
  CHANNELS 现在是侧边栏与页面 hero 的共同真源,所以「表里的路径是否真有路由」
  从一个展示问题变成了正确性问题:表里多一条不存在的路径,hero 会给一个 404
  页面配上频道标记。

  channels.ts 依赖 lucide-react,在 node --test 下直接 import 会拉进 React 生态,
  所以这里读源文件取路径与标签,只对纯数据做断言。图标本身由 typecheck 保证。
*/
const channelSource = readFileSync(new URL('../src/lib/channels.ts', import.meta.url), 'utf8');

const channelEntries = [...channelSource.matchAll(/\{\s*to: '([^']+)',\s*label: '([^']+)'/g)].map((match) => ({
  to: match[1],
  label: match[2],
}));

const routePaths = (() => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  return [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
})();

test('解析到了足量频道与路由(防止正则空转让后面断言恒真)', () => {
  assert.ok(channelEntries.length >= 9, `只解析出 ${channelEntries.length} 条频道`);
  assert.ok(routePaths.length >= 15, `只解析出 ${routePaths.length} 条路由`);
});

test('每个频道路径都有对应路由', () => {
  // App.tsx 里专家壳的子路由是相对写法(如 "projects"),频道表是绝对路径
  const relative = new Set(routePaths.map((path) => path.replace(/^\//, '')));
  const missing = channelEntries
    .map((entry) => entry.to)
    .filter((to) => to !== '/' && !relative.has(to.replace(/^\//, '')));
  assert.deepEqual(missing, [], `以下频道没有对应路由:${missing.join(', ')}`);
});

test('频道路径与标签都不重复', () => {
  assert.equal(new Set(channelEntries.map((entry) => entry.to)).size, channelEntries.length, '存在重复路径');
  assert.equal(new Set(channelEntries.map((entry) => entry.label)).size, channelEntries.length, '存在重复标签');
});

test('每个频道都能被 navItemForPath 按自身路径命中', () => {
  const items = channelEntries.map((entry) => ({ to: entry.to, group: 'workspace' as const }));
  for (const entry of channelEntries) {
    assert.equal(navItemForPath(items, entry.to)?.to, entry.to, `${entry.to} 命中了别的频道`);
  }
});

test('频道声明的分组都在 NAV_GROUPS 里', () => {
  const declared = new Set(NAV_GROUPS.map((group) => group.id));
  const used = [...channelSource.matchAll(/group: '([^']+)'/g)].map((match) => match[1]);
  assert.ok(used.length >= 9, `只解析出 ${used.length} 个分组声明`);
  for (const group of used) assert.ok(declared.has(group), `分组 ${group} 未在 NAV_GROUPS 声明`);
});

test('hero 不再依赖硬编码页面序号', () => {
  /*
    原来十个页面各写一个 index="01".."10",靠人工与侧边栏顺序对齐,改分组后
    就指错了位置。这条守住它不被重新引入。
  */
  const v2 = readFileSync(new URL('../src/components/V2.tsx', import.meta.url), 'utf8');
  assert.ok(!/index\?:\s*string/.test(v2), 'V2Hero 又出现了 index 属性');
  for (const page of ['DashboardPage', 'GeneratorPage', 'ProjectsPage', 'HistoryPage', 'AuditPage']) {
    const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), 'utf8');
    assert.ok(!/\bindex="\d+"/.test(source), `${page} 又出现了硬编码页面序号`);
  }
});
