import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api } from '../src/lib/api';
import { gapStats, pendingCount } from '../src/lib/enrich-types';
import type { InformationGap } from '../src/types';

/*
  这一层该测的是 URL 拼接、方法、body 与错误透出。request() 没有导出,所以打桩
  globalThis.fetch——它同时也是真实的调用路径,比 spy 内部函数更接近实情。
*/

interface Recorded { url: string; init: RequestInit }

function stubFetch(status = 200, payload: unknown = { gaps: [] }): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function gap(patch: Partial<InformationGap> = {}): InformationGap {
  return {
    id: 'g1', projectId: 'p1', label: '缺口', question: '问题?', category: '未分类',
    stages: [], decisionTasks: [], sourceType: 'domain_inference', evidenceStatus: 'unapproved',
    answerability: 'verifiable', evidenceIds: [], priority: 50, enabled: true, locked: false,
    ...patch,
  };
}

test('draft 打到正确端点,方法是 POST', async () => {
  const calls = stubFetch();
  await api.intelligence.enrich.draft('proj-123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/projects/proj-123/intelligence/enrich/draft');
  assert.equal(calls[0].init.method, 'POST');
});

test('projectId 被转义,不能拼出别的路径', async () => {
  const calls = stubFetch();
  await api.intelligence.enrich.draft('../../admin/users');
  assert.equal(calls[0].url, '/api/projects/..%2F..%2Fadmin%2Fusers/intelligence/enrich/draft');
  assert.doesNotMatch(calls[0].url, /projects\/\.\.\//);
});

test('中文 projectId 也被转义', async () => {
  const calls = stubFetch();
  await api.intelligence.enrich.draft('项目 A');
  assert.equal(calls[0].url, `/api/projects/${encodeURIComponent('项目 A')}/intelligence/enrich/draft`);
});

test('merge 的 body 是传入对象的 JSON', async () => {
  const calls = stubFetch(200, { preview: 'x', targetFile: 'INDEX.md', baseFileId: 'f1', isNewFile: false });
  const body = { items: [{ gapId: 'g1', status: 'edited' as const, content: '正文' }], targetFile: 'INDEX.md' };
  await api.intelligence.enrich.merge('p1', body);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
  assert.equal(calls[0].init.method, 'POST');
});

test('save 走 normalizeKnowledge,形状与 knowledge.list 一致', async () => {
  stubFetch(200, { id: 'f1', projectId: 'p1', filename: 'INDEX.md', version: 2, bytes: 120, category: '未分类', evidenceStatus: '已知事实' });
  const saved = await api.intelligence.enrich.save('p1', { content: '# 正文', targetFile: 'INDEX.md', baseFileId: 'f0' });
  // normalizeKnowledge 把 filename 映射成 name;调用方按 KnowledgeFile 用它
  assert.equal(saved.name, 'INDEX.md');
  assert.equal(saved.id, 'f1');
  assert.equal(saved.kind, '已知事实', '证据类型必须优先于独立的文件分类');
});

test('后端 4xx 抛 ApiError 并透出后端原文', async () => {
  stubFetch(400, { message: '当前没有需要补充的信息缺口' });
  await assert.rejects(
    () => api.intelligence.enrich.draft('p1'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      // 前端直接展示后端文案,不二次翻译;这条断言锁住那个约定
      assert.equal(error.message, '当前没有需要补充的信息缺口');
      return true;
    },
  );
});

test('gapStats: 空数组全为 0', () => {
  assert.deepEqual(gapStats([]), { total: 0, supplied: 0, inferred: 0, unknown: 0, organize: 0, askUser: 0 });
});

test('gapStats: 有答案且来源是事实 → supplied', () => {
  const stats = gapStats([gap({ answer: '有答案', sourceStatus: 'supplied_fact' })]);
  assert.equal(stats.supplied, 1);
  assert.equal(stats.unknown, 0);
});

test('gapStats: 推断与假设都归到 inferred', () => {
  const stats = gapStats([
    gap({ id: 'a', answer: 'x', sourceStatus: 'inference' }),
    gap({ id: 'b', answer: 'y', sourceStatus: 'hypothesis' }),
  ]);
  assert.equal(stats.inferred, 2);
  assert.equal(stats.supplied, 0);
});

test('gapStats: 没有答案却标着 supplied_fact 时取保守档', () => {
  // 数据矛盾。宁可提示用户补,也别把空答案显示成已有资料。
  for (const answer of [undefined, '', '   ']) {
    const stats = gapStats([gap({ answer, sourceStatus: 'supplied_fact' })]);
    assert.equal(stats.unknown, 1, `answer=${JSON.stringify(answer)} 应算空白档`);
    assert.equal(stats.supplied, 0);
  }
});

test('gapStats: sourceStatus 缺失但有答案 → supplied', () => {
  assert.equal(gapStats([gap({ answer: '有答案' })]).supplied, 1);
});

test('gapStats: 三档之和恒等于 total', () => {
  const gaps = [
    gap({ id: 'a', answer: 'x', sourceStatus: 'supplied_fact' }),
    gap({ id: 'b', sourceStatus: 'unknown' }),
    gap({ id: 'c', answer: 'y', sourceStatus: 'inference' }),
    gap({ id: 'd', answer: 'z', sourceStatus: 'hypothesis' }),
    gap({ id: 'e' }),
  ];
  const stats = gapStats(gaps);
  assert.equal(stats.total, gaps.length);
  assert.equal(stats.supplied + stats.inferred + stats.unknown, stats.total);
});

test('pendingCount 只统计明确的知识完善动作', () => {
  assert.equal(pendingCount({ total: 5, supplied: 2, inferred: 1, unknown: 2, organize: 1, askUser: 1 }), 2);
  assert.equal(pendingCount(gapStats([
    gap({ id: 'a', knowledgeAction: 'organize_existing' }),
    gap({ id: 'b', knowledgeAction: 'ask_user' }),
    gap({ id: 'c', sourceStatus: 'unknown', knowledgeAction: 'none' }),
  ])), 2, '规划类 unknown 缺口不应进入知识完善');
});
