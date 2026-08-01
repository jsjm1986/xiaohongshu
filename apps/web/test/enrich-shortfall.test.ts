import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { draftShortfallNote, enrichButtonLabel, enrichSavedHint, enrichTargetOptions } from '../src/lib/enrich-types';

/*
  入口按钮写的是真实待补总数,而单次起草有上限(后端 MAX_DRAFT_GAPS)。
  两者不一致时必须说出来:否则按钮写「补充 17 项」,点进来只有 15 条,
  少了哪两条用户无从得知——静默丢数据。
*/

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('起草条数等于待补总数时没有提示', () => {
  assert.equal(draftShortfallNote({ gaps: new Array(8), totalPending: 8, limit: 15 }), null);
});

test('超出单次上限时说明还剩多少', () => {
  const note = draftShortfallNote({ gaps: new Array(15), totalPending: 17, limit: 15 });
  assert.ok(note, '被截断了却没有提示');
  assert.match(note, /15 条/, '要说明这次起草了多少条');
  assert.match(note, /还有 2 条/, '要说明还剩多少条');
});

test('模型漏答与超上限的措辞不同', () => {
  /*
   * 两种落差的处置不一样:超上限是必然的,再跑一轮就能补完;模型漏答是异常,
   * 重试通常就好。都说成「还剩 N 条」会让用户以为漏答也得再跑一轮才算正常。
   */
  const capped = draftShortfallNote({ gaps: new Array(15), totalPending: 20, limit: 15 });
  const missed = draftShortfallNote({ gaps: new Array(6), totalPending: 8, limit: 15 });
  assert.ok(capped && missed);
  assert.notEqual(capped, missed, '两种落差不能用同一句话');
  assert.match(missed, /没能给出可用内容|再试/, '漏答要说明可以重试');
  assert.doesNotMatch(missed, /单次最多/, '漏答与单次上限无关,别提上限');
});

test('超上限时的剩余条数按实收算,不按上限算', () => {
  /*
   * 20 条待补、上限 15、模型只答出 12 条:还没起草的是 8 条(20-12),
   * 不是 5 条(20-15)。按上限算会漏掉模型漏答的那 3 条。
   */
  const note = draftShortfallNote({ gaps: new Array(12), totalPending: 20, limit: 15 });
  assert.ok(note);
  assert.match(note, /还有 8 条/, '剩余数要按实际起草条数算');
});

test('入口按钮文案三处共用一个函数', () => {
  /*
   * 原先三处各自拼字符串,括号还不一致:专业版全角「（1 项）」,
   * 快捷版和缺口池半角「(11 项)」。同一个按钮在不同页面长得不一样。
   */
  assert.equal(enrichButtonLabel(3), '完善知识（3 项）');
  assert.equal(enrichButtonLabel(3, { organize: 2, askUser: 1 }), '完善知识（整理 2 · 回答 1）');

  const ENTRIES = [
    '../src/components/quick/ProjectKnowledgeTab.tsx',
    '../src/pages/KnowledgePage.tsx',
    '../src/pages/IntelligentSimpleFlow.tsx',
  ];
  for (const path of ENTRIES) {
    const source = read(path);
    assert.match(source, /enrichButtonLabel\(/, `${path} 没有复用 enrichButtonLabel`);
    // 自己再拼一遍就会重新分叉
    assert.doesNotMatch(
      source,
      /AI 帮我补充[（(]\{/u,
      `${path} 仍在自己拼按钮文案`,
    );
  }
});

test('弹窗把落差和读不出的文件都显示出来', () => {
  const modal = read('../src/components/knowledge/KnowledgeEnrichmentModal.tsx');
  assert.match(modal, /draftShortfallNote\(result\)/, '没有计算起草落差');
  assert.match(modal, /unreadableFiles/, '没有读取 unreadableFiles');
  // 读不出资料会让推断质量下降,得用告警级别而不是普通提示
  assert.match(modal, /unreadable\.length > 0[\s\S]{0,200}enrich-warning/, '读不出的文件应当以告警显示');
});

/**
 * 保存后的提示要准确表达人工确认后的证据性质和下一步。
 */
test('保存提示说明已知事实并指向重新分析', () => {
  const hint = enrichSavedHint();
  assert.match(hint, /人工确认/u);
  assert.match(hint, /已知事实/u);
  assert.match(hint, /重新分析/u);
});

test('可选目标按文件名去重:快捷版传进来的列表含历史版本', () => {
  // knowledge.list 不按 filename 去重(后端 SQL 每版一行),不去重会出现
  // 重复选项和重复的 React key。专业版传的是已折叠的列表,两边要给出同一组选项。
  assert.deepEqual(
    enrichTargetOptions([{ name: 'A.md' }, { name: 'A.md' }, { name: 'B.md' }]),
    ['A.md', 'B.md'],
  );
  assert.deepEqual(enrichTargetOptions([{ name: 'A.md' }, { name: 'B.md' }]), ['A.md', 'B.md']);
});

test('空文件名不进选项:选中它会让保存目标变成空串', () => {
  assert.deepEqual(enrichTargetOptions([{ name: '  ' }, { name: 'A.md' }]), ['A.md']);
});

test('reference-corpus 不作为 AI 补全目标,同名文件按最新版分类判断', () => {
  assert.deepEqual(
    enrichTargetOptions([
      { name: '对标.md', version: 1, category: '知识地图' },
      { name: '对标.md', version: 2, category: 'reference-corpus' },
      { name: '事实.md', version: 1, category: 'reference-corpus' },
      { name: '事实.md', version: 2, category: '知识地图' },
    ]),
    ['事实.md'],
  );
});

test('目标文件在合并前选定,不能只改保存目标', () => {
  /*
   * 目标文件必须参与 merge。merge 会读目标文件的原文并把补充融进去
   * (intelligence-enrich.service.ts:202-217),预览就是那份融合结果。
   * 如果只把选择结果用在 save 上,融进 A 原文的文档会存成 B 的新版本——
   * B 的最新版里 B 自己的内容凭空消失,正是后端在 :212 处防的那种覆盖。
   */
  const modal = read('../src/components/knowledge/KnowledgeEnrichmentModal.tsx');
  assert.match(modal, /enrich\.merge\(projectId, \{[^}]*targetFile/, 'merge 没有带上目标文件');
});
