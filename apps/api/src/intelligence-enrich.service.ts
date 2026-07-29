import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { KnowledgeService } from './knowledge.service.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { countHedges, isEnrichConfidence } from './intelligence-enrich.types.js';
import type { DraftItem, EnrichDraftResult, MergeItem, MergePreview } from './intelligence-enrich.types.js';
import { nowIso, parseJson } from './utils.js';

/** 一次最多起草多少条。再多提示词会过长,用户也审不完。 */
const MAX_DRAFT_GAPS = 15;
/** 塞进提示词的知识库片段上限(字符)。 */
const MAX_CONTEXT_CHARS = 4_000;
/** 少于这个长度的草稿正文当作模型没写出东西。 */
const MIN_DRAFT_CHARS = 10;
/**
 * 补充版本的证据类型。
 *
 * 走 knowledge.service 的 evidenceStatus() 会映射成 'inferred',而不是
 * 「已知事实」对应的 'observed'。见 saveEnrichedKnowledge 的注释。
 */
const ENRICHED_EVIDENCE_STATUS = '猜想';

interface GapRow {
  id: string;
  title: string;
  priority: number;
  data_json: string;
}

interface KnowledgeDoc {
  filename: string;
  content: string;
}

@Injectable()
export class IntelligenceEnrichService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ResourceService) private readonly resources: ResourceService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
  ) {}

  async generateEnrichmentDraft(projectId: string, principal: SessionPrincipal): Promise<EnrichDraftResult> {
    this.resources.projectRow(projectId);
    const gaps = this.pendingGaps(projectId);
    if (gaps.length === 0) throw new BadRequestException('当前没有需要补充的信息缺口');

    const docs = await this.latestDocuments(projectId);
    const context = this.extractRelevantContext(docs, gaps);
    const payload = await this.intelligence.runEnrichmentModel(
      projectId,
      principal,
      this.draftPrompt(gaps, context),
      'draft',
    );

    const byId = new Map(gaps.map((gap) => [gap.id, gap]));
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const drafts: DraftItem[] = [];
    /*
     * 已收下的 gapId。模型偶尔会把同一个缺口答两遍,重复的后果是实际的:
     * 前端列表用 gapId 当 React key(重复 key 渲染行为未定义)、applyDraftChange
     * 按 gapId 匹配(改一条会同时改掉两条)、合并时同一缺口的内容进去两遍。
     * 保留第一条:模型通常把最完整的答案放在前面。
     */
    const seen = new Set<string>();
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const gap = byId.get(String(item.gapId));
      // 模型有时会自己编 gapId。不在请求列表里的直接丢——落库的东西必须对得上缺口。
      if (!gap) continue;
      if (seen.has(gap.id)) continue;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (content.length < MIN_DRAFT_CHARS) continue;
      seen.add(gap.id);
      const data = parseJson<Record<string, unknown>>(gap.data_json, {});
      drafts.push({
        gapId: gap.id,
        title: gap.title,
        question: typeof data.question === 'string' ? data.question : '',
        priority: Number(gap.priority),
        aiDraft: content,
        // 把握程度缺失或不认识时保守取 low,让用户重点看它,而不是默认显示成可信。
        confidence: isEnrichConfidence(item.confidence) ? item.confidence : 'low',
      });
    }

    if (drafts.length === 0) {
      throw new BadRequestException('模型没能基于现有资料生成可用内容,请先补充一些原始资料');
    }
    return { gaps: drafts };
  }

  async mergeEnrichedKnowledge(
    projectId: string,
    items: MergeItem[],
    targetFile: string | undefined,
    principal: SessionPrincipal,
  ): Promise<MergePreview> {
    this.resources.projectRow(projectId);

    /*
     * 同一个 gapId 只取一条。
     *
     * 前端正常不会发重复,但这是公开端点,请求体由调用方给。重复的话同一个缺口的
     * 标题和正文会进提示词两遍,合并出来的文档里就有两段几乎一样的内容。
     * 取最后一条:如果调用方先发 confirmed 再发 deleted,后者是更新的意图。
     */
    const deduped = [...new Map(items.map((item) => [item.gapId, item])).values()];
    const active = deduped.filter((item) => item.status !== 'deleted');
    if (active.length === 0) throw new BadRequestException('请至少保留一条补充内容');

    // gapId 必须属于本项目。这既是数据校验也是越权防护:gapId 来自请求体,
    // 不带 project_id 条件就能拿别的项目的缺口标题去拼提示词。
    const ids = active.map((item) => item.gapId);
    const rows = this.database
      .prepare(
        `SELECT id, title, priority, data_json FROM information_gaps
         WHERE project_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(projectId, ...ids) as unknown as GapRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const missing = ids.filter((id) => !byId.has(id));
    // 只回条数,不回 id 也不回标题:请求方本来就知道自己传了什么,
    // 而逐一列出等于把「这个 id 在别的项目里存在吗」变成可探测的。
    if (missing.length) throw new BadRequestException(`有 ${missing.length} 条缺口不存在或不属于本项目`);

    // 每条都必须有正文。confirmed 表示用户接受了 AI 草稿,前端要把草稿原文回传;
    // 服务端不缓存草稿,这里拿不到就没法合并。
    if (active.some((item) => !item.content || item.content.trim().length === 0)) {
      throw new BadRequestException('确认或编辑过的条目必须带上正文内容');
    }

    const docs = await this.latestDocuments(projectId);
    const target = targetFile
      ?? docs.find((doc) => doc.filename.toUpperCase() === 'INDEX.MD')?.filename
      ?? 'INDEX.md';
    const existing = docs.find((doc) => doc.filename === target)?.content ?? '';

    const supplements = active
      .map((item) => `### ${byId.get(item.gapId)!.title}\n${item.content!.trim()}`)
      .join('\n\n');

    const payload = await this.intelligence.runEnrichmentModel(
      projectId,
      principal,
      this.mergePrompt(existing, supplements),
      'merge',
    );

    // callAnalysisModel 只返回 JSON 对象,所以合并结果要包在字段里,不能直接返 Markdown。
    const merged = typeof payload.document === 'string' ? payload.document.trim() : '';
    if (merged.length === 0) throw new BadRequestException('模型没能生成合并结果,请重试');

    /*
     * 数一下不确定标记有没有变少。
     *
     * 实测:合并那一步会把「待确认:主材是否达到 E1 级」改写成「主材达到 E1 级」,
     * 把疑问句改成陈述句——凭空造出事实。提示词已明确禁止(第 6 条),但不能只靠
     * 提示词。这里只做计数并提示,不阻断保存:判断某句是否真从推断变成断言需要理解
     * 上下文,词面统计做不到,当门会误伤(模型合并同类项时正常会去掉重复的限定词)。
     */
    const hedgeLoss = Math.max(0, countHedges(`${existing}\n${supplements}`) - countHedges(merged));

    return { preview: merged, targetFile: target, isNewFile: existing === '', hedgeLossCount: hedgeLoss };
  }

  /**
   * 存成同名文件的新版本。
   *
   * knowledge.import 内部按 (project_id, filename) 取 MAX(version)+1,所以「新版本」
   * 只要文件名一致就自动成立。旧版本行保留,用户能回看。
   *
   * evidenceStatus 一律落到「猜想」,不沿用原文件的取值。这一条是刻意的:
   * evidence_status 会经 knowledge.service 的 evidenceStatus() 映射成 observed /
   * inferred,而 agent-core 的 knowledge.ts 用它判定哪些主张算已知事实。补充内容
   * 是模型推断、用户逐条审查过——审查不等于核实,继承「已知事实」就是把推断洗成事实,
   * 恰是这个项目一直在防的事。用户核实后可以在知识库页改回去。
   *
   * category 沿用原文件:它只决定这份资料参与哪一类语料(reference-corpus 会被
   * 排除出生成语料),改掉会让知识库的分类视图错乱。
   */
  async saveEnrichedKnowledge(
    projectId: string,
    content: string,
    targetFile: string,
    principal: SessionPrincipal,
  ): Promise<Record<string, unknown>> {
    this.resources.projectRow(projectId);
    const rows = this.knowledge.list(projectId).filter((row) => String(row.filename) === targetFile);
    const latest = rows.sort((a, b) => Number(b.version) - Number(a.version)).at(0);

    return this.knowledge.import({
      projectId,
      filename: targetFile,
      content,
      category: latest ? String(latest.category) : '未分类',
      evidenceStatus: ENRICHED_EVIDENCE_STATUS,
      metadata: { source: 'ai-enrichment', enrichedAt: nowIso() },
      principal,
    });
  }

  private mergePrompt(existing: string, supplements: string): string {
    return `你在把用户确认过的补充内容合并进一份项目知识库文档。

【原文档】
${existing || '（这是一个新文件，暂无原文）'}

【补充内容（用户已逐条确认）】
${supplements}

要求：
1. 输出一份完整的新版文档，把补充内容自然地融进原有结构。
2. 不要删除原文里的任何信息，只做整合与去重。
3. 与原文冲突时以补充内容为准，它更新更具体。
4. 用 Markdown，二级标题分节，结构清晰。
5. 不要新增原文和补充内容里都没有的事实。
6. 【最重要】不确定的说法必须保持不确定。补充内容里凡是「待确认」「建议补充」
   「尚未提供」「是否…」「可能」「通常」「应」这类限定词和疑问句，一律原样保留，
   不要改写成陈述句、不要删掉限定词、不要把疑问句变成肯定句。
   例如「待确认：主材是否达到 E1 级」不可以写成「主材达到 E1 级」——
   后者是凭空造出来的事实。这类标记是给用户看的待办，不是可以精简的赘语。
7. 不要替原文或补充内容做判断：没有依据的地方保持空白并标注出来。

只返回 JSON 对象，不要多余文字：
{"document":"完整的 Markdown 文档"}`;
  }

  /**
   * 待补充的缺口:答案为空,或来源是推断/假设/未知。
   *
   * 过滤放在 JS 里而不是 SQL 的 json_extract:data_json 里 answer 键可能整个不存在,
   * 那时 json_extract 返回 NULL,`= ''` 判不出来,真正该补的行反而被漏掉。
   */
  private pendingGaps(projectId: string): GapRow[] {
    const rows = this.database
      .prepare(
        `SELECT id, title, priority, data_json FROM information_gaps
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY priority DESC, updated_at DESC`,
      )
      .all(projectId) as unknown as GapRow[];
    return rows
      .filter((row) => {
        const data = parseJson<Record<string, unknown>>(row.data_json, {});
        const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
        const status = typeof data.sourceStatus === 'string' ? data.sourceStatus : '';
        return answer === '' || status === 'unknown' || status === 'inference' || status === 'hypothesis';
      })
      .slice(0, MAX_DRAFT_GAPS);
  }

  /** 取每个文件名的最新版本正文。list() 只给元数据,正文得逐个读。 */
  private async latestDocuments(projectId: string): Promise<KnowledgeDoc[]> {
    const rows = this.knowledge.list(projectId);
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const filename = String(row.filename);
      const previous = latest.get(filename);
      if (!previous || Number(row.version) > Number(previous.version)) latest.set(filename, row);
    }
    const docs: KnowledgeDoc[] = [];
    for (const row of latest.values()) {
      const full = await this.knowledge.getWithContent(String(row.id));
      docs.push({ filename: String(full.filename), content: String(full.content ?? '') });
    }
    return docs;
  }

  /**
   * 从缺口标题与问题里取检索词。
   *
   * 中文用二元字组(bigram),不是按标点切出来的整个短语。第一版按标点切,得到的是
   * 「整装报价包含哪些项」这种长句,资料里几乎不会逐字出现,于是没有任何段落命中、
   * 每次都退回全文——压缩形同虚设。二元字组能让「整装报价…」命中写着「报价说明」
   * 的段落。英文数字按词取,长度 >= 3(避免 the / and 之类噪声)。
   */
  private searchTerms(gaps: GapRow[]): Set<string> {
    const terms = new Set<string>();
    for (const gap of gaps) {
      const data = parseJson<Record<string, unknown>>(gap.data_json, {});
      const question = typeof data.question === 'string' ? data.question : '';
      const text = `${gap.title} ${question}`;
      for (const run of text.match(/[一-鿿]+/gu) ?? []) {
        if (run.length === 1) continue; // 单字太泛,命中一切
        for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
      }
      for (const word of text.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu) ?? []) terms.add(word.toLowerCase());
    }
    return terms;
  }

  /**
   * 只把跟缺口相关的段落塞进提示词。
   *
   * 按命中词数排序而不是简单过滤:命中越多越可能真相关,预算有限时先给这些。
   * 一条都没命中时退回原文——宁可给点上下文,也别让模型完全凭空写。
   */
  private extractRelevantContext(docs: KnowledgeDoc[], gaps: GapRow[]): string {
    const terms = [...this.searchTerms(gaps)];
    const scored: Array<{ text: string; score: number }> = [];
    for (const doc of docs) {
      for (const paragraph of doc.content.split(/\n{2,}|(?=^#{1,3}\s)/mu)) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        const score = terms.filter((term) => lower.includes(term)).length;
        if (score > 0) scored.push({ text: `## ${doc.filename}\n${trimmed}`, score });
      }
    }

    if (scored.length === 0) {
      return docs.map((doc) => `## ${doc.filename}\n${doc.content}`).join('\n\n').slice(0, MAX_CONTEXT_CHARS);
    }

    scored.sort((a, b) => b.score - a.score);
    const parts: string[] = [];
    let used = 0;
    for (const item of scored) {
      if (used + item.text.length > MAX_CONTEXT_CHARS) break;
      parts.push(item.text);
      used += item.text.length + 2;
    }
    const best = scored[0];
    if (!best) return '';
    // 预算连最相关的一段都放不下时,截断它,而不是返回空。
    return parts.length ? parts.join('\n\n') : best.text.slice(0, MAX_CONTEXT_CHARS);
  }

  private draftPrompt(gaps: GapRow[], context: string): string {
    const list = gaps
      .map((gap) => {
        const data = parseJson<Record<string, unknown>>(gap.data_json, {});
        const question = typeof data.question === 'string' && data.question ? data.question : '（无具体问题）';
        return `- gapId=${gap.id}｜${gap.title}：${question}`;
      })
      .join('\n');

    return `你在帮用户完善项目知识库。用户已上传资料，但仍有决策关键信息缺失。

【现有资料片段】
${context || '（暂无资料）'}

【待补充的缺口】
${list}

要求：
1. 每个缺口写 2-4 段 Markdown，回答该缺口的问题。
2. 资料里明确写了的，直接提取，confidence=high。
3. 能从资料合理推断的，谨慎推断并说明依据，confidence=medium。
4. 没有任何依据的，写成待用户确认的假设并明确标注，confidence=low。
5. 不要编造具体数字、人名、地址、资质编号、成交价这类事实信息；缺就写「待确认」。
6. 【重要】"资料里没写"不等于"这项不存在"。资料没提到的服务、渠道、优惠，
   一律写成"资料未提及，待确认"，**不要**写成"暂未开通""目前不支持""未提供"
   ——那是在替对方否认一项他可能确实有的服务，和编造事实一样是凭空断言。
   同理，不要把"资料只提到 A"扩写成"支持 A、B、C"。
7. gapId 必须原样使用上面给出的值，不要新增缺口。

只返回 JSON 对象，不要多余文字：
{"items":[{"gapId":"...","content":"## 小标题\\n\\n正文...","confidence":"medium","reasoning":"推断依据"}]}`;
  }
}
