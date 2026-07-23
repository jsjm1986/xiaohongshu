import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickCandidateFields, quickCandidateToMarkdown } from '../src/lib/quick-generation.js';

const fullCandidate = {
  id: 'c1',
  label: '版本一',
  title: '去眼袋功课怎么做',
  body: '正文内容……',
  tags: ['去眼袋', '医美功课'],
  imageBrief: '封面：术前术后对比图',
  commentOwnedFirstComment: '楼主补充：先看资质',
  comments: [
    {
      question: '会反弹吗？',
      answer: '结构性去除不易反弹',
      boundary: '不构成医疗建议',
      nextStep: '面诊确认方案',
      followUps: [{ question: '恢复期多久？', answer: '一般一周', boundary: '因人而异' }],
      // 审计字段，应被剔除：
      primaryGapId: 'g1',
      postingIdentity: 'author',
      densityProxy: { x: 1 },
    },
  ],
  // 审计字段，应被剔除：
  score: 88,
  diagnostics: [{ code: 'x' }],
  sources: [{ name: 's' }],
  unknowns: ['u'],
  gapCoverageLedger: { closed: 1 },
  validation: { valid: true, repairAttempts: 0, issues: [] },
} as any;

test('quickCandidateFields keeps only usable copy fields', () => {
  const view = quickCandidateFields(fullCandidate);
  assert.equal(view.id, 'c1');
  assert.equal(view.label, '版本一');
  assert.equal(view.publishable, true);
  assert.equal(view.title, '去眼袋功课怎么做');
  assert.equal(view.body, '正文内容……');
  assert.deepEqual(view.tags, ['去眼袋', '医美功课']);
  assert.equal(view.imageBrief, '封面：术前术后对比图');
  assert.equal(view.commentOwnedFirstComment, '楼主补充：先看资质');
  assert.equal(view.comments.length, 1);
  assert.equal(view.comments[0].question, '会反弹吗？');
  assert.equal(view.comments[0].answer, '结构性去除不易反弹');
  assert.equal(view.comments[0].boundary, '不构成医疗建议');
  assert.equal(view.comments[0].nextStep, '面诊确认方案');
  assert.equal(view.comments[0].followUps?.[0].question, '恢复期多久？');
  // 审计字段必须不存在
  assert.equal((view as any).score, undefined);
  assert.equal((view as any).diagnostics, undefined);
  assert.equal((view as any).sources, undefined);
  assert.equal((view as any).gapCoverageLedger, undefined);
  assert.equal((view.comments[0] as any).primaryGapId, undefined);
  assert.equal((view.comments[0] as any).densityProxy, undefined);
  assert.equal((view.comments[0] as any).postingIdentity, undefined);
});

test('quickCandidateFields marks publishable=false when validation invalid', () => {
  const view = quickCandidateFields({ ...fullCandidate, validation: { valid: false, repairAttempts: 2, issues: [{ severity: 'error', message: 'x' }] } } as any);
  assert.equal(view.publishable, false);
  // 仍保留可用文案，不因不可发布就丢
  assert.equal(view.title, '去眼袋功课怎么做');
});

test('quickCandidateFields tolerates missing optional fields', () => {
  const view = quickCandidateFields({ id: 'c2', title: 't', body: 'b', tags: [], comments: [] } as any);
  assert.equal(view.publishable, false); // 无 validation 视为未通过
  assert.equal(view.imageBrief, undefined);
  assert.equal(view.commentOwnedFirstComment, undefined);
  assert.deepEqual(view.comments, []);
});

test('quickCandidateToMarkdown includes usable copy and no audit appendix', () => {
  const md = quickCandidateToMarkdown(quickCandidateFields(fullCandidate));
  assert.match(md, /去眼袋功课怎么做/);
  assert.match(md, /正文内容/);
  assert.match(md, /#去眼袋/);
  assert.match(md, /会反弹吗？/);
  assert.match(md, /楼主补充/);
  assert.doesNotMatch(md, /审计附录/);
  assert.doesNotMatch(md, /primaryGapId/);
});
