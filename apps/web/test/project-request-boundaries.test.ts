import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function pageSource(name: string): string {
  return readFileSync(new URL(`../src/pages/${name}`, import.meta.url), 'utf8');
}

test('intelligent flow rejects stale project responses and pages source images', () => {
  const source = pageSource('IntelligentSimpleFlow.tsx');

  assert.ok(source.includes('const activeProjectId = useRef(projectId)'));
  assert.ok(source.includes('activeProjectId.current !== requestedProjectId'));
  assert.ok(source.includes('seq !== loadRequestSeq.current'));
  assert.ok(source.includes('api.imageAssets.list(requestedProjectId, { limit: IMAGE_PAGE_SIZE, offset: 0 })'));
  assert.ok(source.includes('api.imageAssets.list(requestedProjectId, { limit: IMAGE_PAGE_SIZE, offset })'));
  assert.ok(source.includes('加载更多（已显示 {assets.length}/{assetsTotal}）'));
  assert.match(source, /项目智能规划加载失败/u);
  assert.ok(!source.includes('api.intelligence.get(projectId).catch(() =>'));
  assert.ok(!source.includes('api.imageAssets.list(projectId).catch(() =>'));
});

test('knowledge page keeps primary and auxiliary failures explicit and project-scoped', () => {
  const source = pageSource('KnowledgePage.tsx');

  assert.ok(source.includes('const activeProjectId = useRef(projectId)'));
  assert.ok(source.includes('seq !== loadSeq.current'));
  assert.ok(source.includes('seq !== preflightSeq.current'));
  assert.ok(source.includes('seq !== gapsSeq.current'));
  assert.match(source, /资料完整度暂不可用/u);
  assert.match(source, /页面不会据此显示生成就绪或缺口数量/u);
  assert.ok(!source.includes('api.knowledge.preflight(projectId).then(setPreflight).catch(() =>'));
  assert.ok(!source.includes('api.informationGaps.list(projectId).then((r) => setGaps(r.items)).catch(() =>'));
});

test('research page separates overview failure from parameter-schema fallback', () => {
  const source = pageSource('ResearchPage.tsx');

  assert.ok(source.includes('const activeProjectId = useRef(projectId)'));
  assert.ok(source.includes('Promise.allSettled'));
  assert.ok(source.includes('seq !== loadSeq.current'));
  assert.match(source, /研究资料加载失败/u);
  assert.match(source, /生成参数定义暂不可用/u);
  assert.match(source, /不能据此新建校准提案/u);
  assert.ok(!source.includes('api.parameters.schema(projectId).catch(() => null)'));
});
