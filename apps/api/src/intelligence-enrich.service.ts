import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { KnowledgeService } from './knowledge.service.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import { isEnrichConfidence } from './intelligence-enrich.types.js';
import type { DraftItem, EnrichDraftResult } from './intelligence-enrich.types.js';
import { parseJson } from './utils.js';

/** 一次最多起草多少条。再多提示词会过长,用户也审不完。 */
const MAX_DRAFT_GAPS = 15;
/** 塞进提示词的知识库片段上限(字符)。 */
const MAX_CONTEXT_CHARS = 4_000;
/** 少于这个长度的草稿正文当作模型没写出东西。 */
const MIN_DRAFT_CHARS = 10;

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
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const gap = byId.get(String(item.gapId));
      // 模型有时会自己编 gapId。不在请求列表里的直接丢——落库的东西必须对得上缺口。
      if (!gap) continue;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (content.length < MIN_DRAFT_CHARS) continue;
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
    // 预算连最相关的一段都放不下时,截断它,而不是返回空。
    return parts.length ? parts.join('\n\n') : scored[0].text.slice(0, MAX_CONTEXT_CHARS);
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
6. gapId 必须原样使用上面给出的值，不要新增缺口。

只返回 JSON 对象，不要多余文字：
{"items":[{"gapId":"...","content":"## 小标题\\n\\n正文...","confidence":"medium","reasoning":"推断依据"}]}`;
  }
}
