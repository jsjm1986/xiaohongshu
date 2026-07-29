import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/*
  三个知识库入口都必须能用 AI 补充。

  这个功能第一版只挂在快捷版 ProjectKnowledgeTab,专业版 KnowledgePage 和
  IntelligentSimpleFlow 的缺口池都没有——用户在缺口池里一条条手填答案,
  那里恰恰最需要补充,却没有入口。这条测试防的就是「只接一处就以为做完了」。

  读源文件做断言,不渲染组件:apps/web 没有 testing-library(见 CLAUDE.md 约定)。
*/
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const ENTRY_POINTS = [
  { name: '快捷版知识库页', path: '../src/components/quick/ProjectKnowledgeTab.tsx' },
  { name: '专业版知识库页', path: '../src/pages/KnowledgePage.tsx' },
  { name: '智能流程缺口池', path: '../src/pages/IntelligentSimpleFlow.tsx' },
] as const;

test('三个知识库入口都挂了补充弹窗', () => {
  for (const entry of ENTRY_POINTS) {
    const source = read(entry.path);
    assert.match(source, /KnowledgeEnrichmentModal/, `${entry.name} 缺少补充弹窗`);
    assert.match(source, /AI 帮我补充|用 AI 补充/, `${entry.name} 缺少入口按钮文案`);
  }
});

test('三个入口的待补充条数都用同一个判据算', () => {
  // 各写一套判据的话,按钮上写「6 项」点进去出来 4 条,信任就没了
  for (const entry of ENTRY_POINTS) {
    const source = read(entry.path);
    assert.match(source, /pendingCount|gapStats/, `${entry.name} 没有复用 gapStats/pendingCount`);
  }
});

test('入口按钮只在真有待补充缺口时出现', () => {
  for (const entry of ENTRY_POINTS) {
    const source = read(entry.path);
    assert.match(
      source,
      /pending(Gap)?Count > 0/,
      `${entry.name} 没有按待补充条数做条件渲染`,
    );
  }
});

test('缺口池的单条精补按钮只给待补充的缺口', () => {
  // 已有答案的缺口后端会拒(见 generateEnrichmentDraft),显示按钮就是误导
  const source = read('../src/pages/IntelligentSimpleFlow.tsx');
  assert.match(source, /isGapPending\(gap\) &&[\s\S]{0,120}openEnrich\(\[gap\.id\]\)/);
  // 判据要和后端 pendingGaps 一致
  assert.match(source, /const isGapPending[\s\S]{0,400}hypothesis/);
});

test('弹窗支持只补指定缺口,缺省则整批', () => {
  const modal = read('../src/components/knowledge/KnowledgeEnrichmentModal.tsx');
  assert.match(modal, /gapIds\?:\s*readonly string\[\]/, '缺少 gapIds prop');
  assert.match(modal, /enrich\.draft\(projectId, gapIds\)/, 'draft 调用没传 gapIds');

  const api = read('../src/lib/api.ts');
  assert.match(api, /draft: \(projectId: string, gapIds\?/, 'api 层不支持 gapIds');
  // 空数组不能当成「精补 0 条」发出去,后端会拒
  assert.match(api, /gapIds\?\.length \? \{ gapIds \} : \{\}/);
});
