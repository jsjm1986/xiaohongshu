# AI 协助完善知识库 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现"AI 协助完善知识库"功能，让用户通过 AI 起草 + 人工审查的方式，快速补充知识库中的空白信息缺口。

**Architecture:** 后端新增 3 个 API 端点（draft / merge / save），前端在知识库页加一个
`modal--wide` 弹窗承载编辑流程，复用现有 `information_gaps` 表和 `knowledge_files`
版本机制。2 次模型调用，无新增数据表、无新增依赖。

**Tech Stack:** NestJS + node:sqlite + React + TypeScript，前后端测试都是 `node:test`

## Global Constraints

- Node.js ≥ 24.0.0，TypeScript strict
- **测试框架：前后端都是 `node:test`（`node --import tsx --test`）。仓库里没有
  vitest、没有 `@testing-library/react`、没有 supertest——不要引入。**
- **两个 `package.json` 的 `test` 脚本都是显式文件列表，不是 glob。新测试文件
  必须登记进去，否则永远不会被跑到（看起来是绿的，比红更危险）。**
- **不新增运行时依赖。** 特别是 `class-validator` / `class-transformer` /
  `react-markdown` —— 设计稿里出现过，但都不装。
- 请求校验用 `apps/api/src/utils.ts` 风格的手写函数（`requireObject` /
  `requireString` / `optionalString`），controller 收 `@Body() body: unknown`
- 错误用 NestJS 的 `BadRequestException`，模型侧失败用 `AnalysisGatewayError`
- 所有模型调用必须经过 `IntelligenceService`，走 `analysis_tasks` 的任务生命周期
  （建行 → 心跳 → 收尾），不要绕开
- API 端点必须声明 `@RequirePermission`；写知识文件的端点判 `knowledge.import`
- 文档、注释、UI 文案用中文
- 提交信息遵循 Conventional Commits，结尾加
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## 任务概览

1. 后端类型与请求校验
2. 后端核心服务（起草）
3. 后端核心服务（合并与保存）
4. 后端路由与集成测试
5. 前端类型与 API 封装
6. 前端流程容器（Modal）
7. 前端编辑组件（DraftItemCard）
8. 前端预览组件与样式
9. 前端入口集成（ProjectKnowledgeTab）
10. 全量回归
11. 端到端手工验证

---

### Task 1: 后端类型与请求校验

**为什么不用 class-validator 装饰器**：`apps/api` 没有 `class-validator` /
`class-transformer` 依赖，全库也没有 `*.dto.ts`。现有 controller 一律
`@Body() body: unknown`，再用 `utils.ts` 的 `requireObject` / `requireString` /
`optionalString` 手写校验。本任务沿用这套惯例，不引入第二种校验风格。

**Files:**
- Create: `apps/api/src/intelligence-enrich.types.ts`
- Test: `apps/api/test/intelligence-enrich-types.test.ts`

**Interfaces:**
- Consumes: `requireObject`, `requireString`, `optionalString` from `./utils.js`
- Produces:
  - 类型：`DraftItem`, `EnrichDraftResult`, `MergeItem`, `MergePreview`, `EnrichConfidence`, `MergeItemStatus`
  - 校验器：`parseMergeRequest(body: unknown): { items: MergeItem[]; targetFile?: string }`
  - 校验器：`parseSaveRequest(body: unknown): { content: string; targetFile: string }`
  - 常量：`MAX_MERGE_ITEMS = 50`, `MAX_ITEM_CONTENT_CHARS = 20_000`, `MAX_TOTAL_CONTENT_CHARS = 500_000`, `MAX_SAVE_CONTENT_BYTES = 2 * 1024 * 1024`

- [ ] **Step 1: 编写类型与校验文件**

```typescript
// apps/api/src/intelligence-enrich.types.ts
import { BadRequestException } from '@nestjs/common';
import { requireObject, requireString, optionalString } from './utils.js';

/** AI 对推断把握程度的自评。用于前端标注，低把握的要重点审查。 */
export type EnrichConfidence = 'low' | 'medium' | 'high';

/** 用户对单条草稿的处置。 */
export type MergeItemStatus = 'confirmed' | 'edited' | 'deleted';

export interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: EnrichConfidence;
}

export interface EnrichDraftResult {
  gaps: DraftItem[];
}

export interface MergeItem {
  gapId: string;
  status: MergeItemStatus;
  content?: string;
}

export interface MergePreview {
  preview: string;
  targetFile: string;
  isNewFile: boolean;
}

/*
 * 为什么没有 tokensUsed:
 * callAnalysisModel 只把模型输出的 JSON 对象往上传,usage 字段在那一层就被丢掉了,
 * 拿不到真实 token 数。设计稿里写了这个字段,但填 0 或估算值等于在 UI 上摆一个
 * 看着像事实的假数字。要显示消耗就得先改 callAnalysisModel 的返回值,那是另一件事。
 */

export const MAX_MERGE_ITEMS = 50;
export const MAX_ITEM_CONTENT_CHARS = 20_000;
export const MAX_TOTAL_CONTENT_CHARS = 500_000;
export const MAX_SAVE_CONTENT_BYTES = 2 * 1024 * 1024;

const CONFIDENCES = new Set<string>(['low', 'medium', 'high']);
const MERGE_STATUSES = new Set<string>(['confirmed', 'edited', 'deleted']);

/**
 * 目标文件名必须是裸文件名 + .md/.txt。
 *
 * 这不只是格式校验：文件名最终会进 knowledge.import()，那里再走
 * path.join。放过 `../` 就是路径穿越，所以这里显式拒绝任何分隔符。
 * knowledge.service.ts 的 validateFilename 也做同样的事，两道都要有——
 * 本函数是入口拒绝，那里是存储层兜底。
 */
function parseTargetFile(value: unknown, field: string): string {
  const text = requireString(value, field, { max: 180 });
  if (text.includes('/') || text.includes('\\') || text.startsWith('.')) {
    throw new BadRequestException(`${field} 不能包含路径或以点开头`);
  }
  if (!/\.(md|txt)$/i.test(text)) {
    throw new BadRequestException(`${field} 仅支持 .md 和 .txt`);
  }
  return text;
}

export function isEnrichConfidence(value: unknown): value is EnrichConfidence {
  return typeof value === 'string' && CONFIDENCES.has(value);
}

/** 解析 merge 请求。items 至少一条、至多 MAX_MERGE_ITEMS 条。 */
export function parseMergeRequest(body: unknown): { items: MergeItem[]; targetFile?: string } {
  const raw = requireObject(body);
  if (!Array.isArray(raw.items)) throw new BadRequestException('items 必须是数组');
  if (raw.items.length === 0) throw new BadRequestException('items 不能为空');
  if (raw.items.length > MAX_MERGE_ITEMS) {
    throw new BadRequestException(`items 最多 ${MAX_MERGE_ITEMS} 条`);
  }

  const items: MergeItem[] = raw.items.map((entry, index) => {
    const item = requireObject(entry);
    const gapId = requireString(item.gapId, `items[${index}].gapId`, { max: 200 });
    const status = requireString(item.status, `items[${index}].status`, { max: 20 });
    if (!MERGE_STATUSES.has(status)) {
      throw new BadRequestException(`items[${index}].status 必须是 confirmed / edited / deleted`);
    }
    const content = optionalString(item.content, `items[${index}].content`, MAX_ITEM_CONTENT_CHARS);
    return { gapId, status: status as MergeItemStatus, content };
  });

  // 总长度在入口就挡住：合并提示词会把所有 content 拼进去，过长会撞模型上下文上限。
  const totalChars = items.reduce((sum, item) => sum + (item.content?.length ?? 0), 0);
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    throw new BadRequestException(`补充内容总长度超过 ${MAX_TOTAL_CONTENT_CHARS} 字符`);
  }

  const targetFile = raw.targetFile === undefined || raw.targetFile === null
    ? undefined
    : parseTargetFile(raw.targetFile, 'targetFile');
  return { items, targetFile };
}

/** 解析 save 请求。content 按字节校验——2 MiB 是 knowledge.import 的硬上限。 */
export function parseSaveRequest(body: unknown): { content: string; targetFile: string } {
  const raw = requireObject(body);
  const content = requireString(raw.content, 'content', { max: MAX_SAVE_CONTENT_BYTES });
  if (Buffer.byteLength(content, 'utf8') > MAX_SAVE_CONTENT_BYTES) {
    throw new BadRequestException('content 不能超过 2 MiB');
  }
  return { content, targetFile: parseTargetFile(raw.targetFile, 'targetFile') };
}
```

- [ ] **Step 2: 编写校验测试**

`apps/api` 的测试用 `node:test`，且文件要显式加进 `package.json` 的 `test`
脚本列表（这个仓库不用 glob）。

```typescript
// apps/api/test/intelligence-enrich-types.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import {
  parseMergeRequest,
  parseSaveRequest,
  MAX_MERGE_ITEMS,
  MAX_TOTAL_CONTENT_CHARS,
} from '../src/intelligence-enrich.types.js';

describe('parseMergeRequest', () => {
  it('接受有效请求并回传规范化结果', () => {
    const parsed = parseMergeRequest({
      items: [{ gapId: 'gap-1', status: 'edited', content: '  正文  ' }],
      targetFile: 'INDEX.md',
    });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].status, 'edited');
    assert.equal(parsed.items[0].content, '正文');
    assert.equal(parsed.targetFile, 'INDEX.md');
  });

  it('targetFile 缺省时为 undefined，由服务层决定落到哪个文件', () => {
    const parsed = parseMergeRequest({ items: [{ gapId: 'g', status: 'confirmed' }] });
    assert.equal(parsed.targetFile, undefined);
  });

  it('拒绝空 items', () => {
    assert.throws(() => parseMergeRequest({ items: [] }), BadRequestException);
  });

  it('拒绝超过上限的 items', () => {
    const items = Array.from({ length: MAX_MERGE_ITEMS + 1 }, (_, i) => ({
      gapId: `g${i}`,
      status: 'confirmed',
    }));
    assert.throws(() => parseMergeRequest({ items }), BadRequestException);
  });

  it('拒绝未知 status', () => {
    assert.throws(
      () => parseMergeRequest({ items: [{ gapId: 'g', status: 'approved' }] }),
      BadRequestException,
    );
  });

  it('拒绝路径穿越的 targetFile', () => {
    for (const targetFile of ['../../../etc/passwd', 'a/b.md', '.hidden.md', 'x.exe']) {
      assert.throws(
        () => parseMergeRequest({ items: [{ gapId: 'g', status: 'confirmed' }], targetFile }),
        BadRequestException,
        `应拒绝 ${targetFile}`,
      );
    }
  });

  it('拒绝总长度超限', () => {
    const items = [
      { gapId: 'a', status: 'edited', content: 'x'.repeat(19_000) },
      { gapId: 'b', status: 'edited', content: 'y'.repeat(19_000) },
    ];
    // 单条都在 MAX_ITEM_CONTENT_CHARS 内，但要凑到总量超限需要更多条
    const many = Array.from({ length: Math.ceil(MAX_TOTAL_CONTENT_CHARS / 19_000) + 1 }, (_, i) => ({
      gapId: `g${i}`,
      status: 'edited' as const,
      content: 'z'.repeat(19_000),
    }));
    assert.doesNotThrow(() => parseMergeRequest({ items }));
    assert.throws(() => parseMergeRequest({ items: many }), BadRequestException);
  });

  it('拒绝非对象请求体', () => {
    assert.throws(() => parseMergeRequest(null), BadRequestException);
    assert.throws(() => parseMergeRequest([]), BadRequestException);
  });
});

describe('parseSaveRequest', () => {
  it('接受有效请求', () => {
    const parsed = parseSaveRequest({ content: '# 标题', targetFile: '补充资料.md' });
    assert.equal(parsed.targetFile, '补充资料.md');
    assert.equal(parsed.content, '# 标题');
  });

  it('targetFile 必填', () => {
    assert.throws(() => parseSaveRequest({ content: 'x' }), BadRequestException);
  });

  it('按字节而非字符判断 2 MiB 上限', () => {
    // 中文一字三字节：700_000 字符 = 2.1 MB > 2 MiB，字符数判断会漏过
    const content = '中'.repeat(700_000);
    assert.throws(() => parseSaveRequest({ content, targetFile: 'a.md' }), BadRequestException);
  });
});
```

- [ ] **Step 3: 把测试文件加进 `apps/api/package.json` 的 `test` 脚本**

在 `test` 脚本的文件列表末尾追加 `test/intelligence-enrich-types.test.ts`。
不加就永远不会被跑到。

- [ ] **Step 4: 运行测试**

```bash
cd apps/api
node --import tsx --test test/intelligence-enrich-types.test.ts
npm run typecheck
```

Expected: 全部通过，typecheck 无错。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/intelligence-enrich.types.ts apps/api/test/intelligence-enrich-types.test.ts apps/api/package.json
git commit -m "feat(api): 知识库补充的请求类型与手写校验

draft/merge/save 三个端点的类型定义，含路径穿越防护和按字节的长度上限。
沿用 utils.ts 的手写校验风格,不引入 class-validator。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 后端核心服务（起草）

**Files:**
- Create: `apps/api/src/intelligence-enrich.service.ts`
- Modify: `apps/api/src/intelligence.service.ts` —— 新增一个公开方法 `runEnrichmentModel`
- Modify: `apps/api/src/app.module.ts` —— 注册 provider（本仓库没有 `intelligence.module.ts`，只有一个 `AppModule.register()`）
- Modify: `apps/web/src/components/quick/ProjectKnowledgeTab.tsx` —— 任务轮询排除补充任务
- Test: `apps/api/test/intelligence-enrich-draft.test.ts`

**为什么要动 `intelligence.service.ts`**：模型调用链是
`analyzeWithCurrentModel` → `retryAnalysis` → `callAnalysisModel`，三个都是
`private`；而且 `retryAnalysis` 第一行就是
`UPDATE analysis_tasks SET attempt_count=? WHERE id=?`，`taskId` 必须是真实存在的
行。`createTask` / `completeTask` / `failTask` / `startTaskHeartbeat` 也全是
private。所以独立服务**够不到模型**。分工：`IntelligenceService` 管任务生命周期
和模型调用，`IntelligenceEnrichService` 管业务逻辑（查 gap、抽 context、拼提示词、
校验产物）。

**Interfaces:**
- Consumes:
  - `DatabaseService.prepare()` —— 查 `information_gaps`
  - `KnowledgeService.list(projectId)` + `getWithContent(fileId)` —— `list()` 不带正文，正文要单独取
  - `IntelligenceService.runEnrichmentModel(projectId, principal, prompt, purpose)` —— 新增
- Produces:
  - `IntelligenceEnrichService.generateEnrichmentDraft(projectId, principal): Promise<EnrichDraftResult>`

- [ ] **Step 1: 在 `IntelligenceService` 上开一个公开的模型入口**

```typescript
// apps/api/src/intelligence.service.ts

/**
 * 给知识库补充功能用的模型入口。
 *
 * 为什么不让 enrich 服务自己调模型:analyzeWithCurrentModel 依赖一条真实的
 * analysis_tasks 行(retryAnalysis 会 UPDATE attempt_count),而建行、心跳、
 * 收尾全在这个类的 private 方法里。与其把四个方法改成 public、把任务生命周期
 * 散到两个服务,不如在这里留一个窄入口。
 *
 * 复用 kind='project':analysis_tasks 的 CHECK 只允许 'project' | 'image',
 * 加第三种值要改 schema + 迁移。用 source_fingerprint 前缀区分用途,与
 * refreshTopicOpportunities 的 `${fingerprint}:topic-refresh:${batchId}` 同一套做法。
 * 代价是这些任务会出现在 listTasks 里,前端要按前缀过滤(见 Step 5)。
 */
async runEnrichmentModel(
  projectId: string,
  principal: SessionPrincipal,
  prompt: string,
  purpose: 'draft' | 'merge',
): Promise<Record<string, unknown>> {
  const project = this.resources.projectRow(projectId);
  const task = this.createTask(projectId, 'project', null, `${ENRICH_FINGERPRINT_PREFIX}${purpose}:${randomUUID()}`, principal);
  try {
    const payload = await this.analyzeWithCurrentModel(project, principal, prompt, [], task.id);
    this.completeTask(task.id, null, nowIso());
    this.record(project, principal, 'knowledge.enrich.model', 'analysis_task', task.id, { projectId, purpose });
    return payload;
  } catch (error) {
    this.failTask(task.id, error);
    throw analysisFailureException(error);
  }
}
```

配套三处小改：

1. 文件顶部导出前缀常量，前后端与测试都引用它，别各写一遍字面量：
   ```typescript
   export const ENRICH_FINGERPRINT_PREFIX = 'enrich:';
   ```
2. `completeTask` 的签名放宽到 `resultId: string | null`。补充任务不产生
   `project_intelligence` 之类的结果行，`result_id` 只能是 NULL——列本来可空且无外键。
   顺带确认 `cachedTask` 要求 `result_id` 非空，所以补充任务天然不会被当成缓存命中。
3. `analysisFailureException` 与 `randomUUID` 在本文件已经 import 了，确认一下即可。

- [ ] **Step 2: 新建 enrich 服务，先写 context 抽取**

```typescript
// apps/api/src/intelligence-enrich.service.ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { KnowledgeService } from './knowledge.service.js';
import type { SessionPrincipal } from './models.js';
import { ResourceService } from './resource.service.js';
import type { DraftItem, EnrichDraftResult } from './intelligence-enrich.types.js';
import { isEnrichConfidence } from './intelligence-enrich.types.js';
import { parseJson } from './utils.js';

/** 一次最多起草多少条,超过这个数提示词会太长、用户也审不完。 */
const MAX_DRAFT_GAPS = 15;
/** 塞进提示词的知识库片段上限(字符)。 */
const MAX_CONTEXT_CHARS = 4_000;

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

  /**
   * 待补充的缺口:答案为空,或来源是推断/未知。
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

  /** 取最新版本的知识文件正文。list() 只给元数据,正文得逐个读。 */
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
   * 只把跟缺口相关的段落塞进提示词。
   *
   * 关键词是缺口标题和问题里的片段。中文没有空格分词,按空白切等于不切,
   * 所以这里按标点切,再要求长度 >= 2——单字关键词几乎命中所有段落,等于不过滤。
   */
  private extractRelevantContext(docs: KnowledgeDoc[], gaps: GapRow[]): string {
    const keywords = new Set<string>();
    for (const gap of gaps) {
      const data = parseJson<Record<string, unknown>>(gap.data_json, {});
      const question = typeof data.question === 'string' ? data.question : '';
      for (const token of `${gap.title} ${question}`.split(/[\s,，。、;；:：?？!！()（）"'“”‘’\/]+/u)) {
        if (token.length >= 2) keywords.add(token);
      }
    }

    const blocks: string[] = [];
    for (const doc of docs) {
      const paragraphs = doc.content.split(/\n{2,}|(?=^#{1,3}\s)/mu);
      const relevant = paragraphs.filter((paragraph) => [...keywords].some((keyword) => paragraph.includes(keyword)));
      if (relevant.length) blocks.push(`## ${doc.filename}\n${relevant.join('\n\n')}`);
    }
    // 一条都没命中时退回原文开头:宁可给点上下文,也别让模型完全凭空写。
    const joined = blocks.length ? blocks.join('\n\n') : docs.map((d) => `## ${d.filename}\n${d.content}`).join('\n\n');
    return joined.slice(0, MAX_CONTEXT_CHARS);
  }
}
```

- [ ] **Step 3: 加 `generateEnrichmentDraft`**

```typescript
// 接在 IntelligenceEnrichService 类里

async generateEnrichmentDraft(projectId: string, principal: SessionPrincipal): Promise<EnrichDraftResult> {
  this.resources.projectRow(projectId);
  const gaps = this.pendingGaps(projectId);
  if (gaps.length === 0) throw new BadRequestException('当前没有需要补充的信息缺口');

  const docs = await this.latestDocuments(projectId);
  const context = this.extractRelevantContext(docs, gaps);
  const payload = await this.intelligence.runEnrichmentModel(projectId, principal, this.draftPrompt(gaps, context), 'draft');

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
    if (content.length < 10) continue;
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

  if (drafts.length === 0) throw new BadRequestException('模型没能基于现有资料生成可用内容,请先补充一些原始资料');
  return { gaps: drafts };
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
5. 不要编造具体数字、人名、地址、资质、成交价这类事实信息；缺就写「待确认」。
6. gapId 必须原样使用上面给出的值，不要新增缺口。

只返回 JSON 对象，不要多余文字：
{"items":[{"gapId":"...","content":"## 小标题\\n\\n正文...","confidence":"medium","reasoning":"推断依据"}]}`;
}
```

**关于返回格式**：`callAnalysisModel` 强制 `response_format: json_object`，并且
`parseModelJsonObject` 只接受**对象**。所以提示词必须要求 `{"items":[...]}`
这样的对象，顶层数组会被判成无效输出。

- [ ] **Step 4: 在 `app.module.ts` 注册**

`IntelligenceEnrichService` 加进 `providers`。同时加进 `exports`——后面
Task 4 的 controller 在同一个 module 里，其实不加也能注入，但这个文件的既有
习惯是两处都写，跟着来。

- [ ] **Step 5: 前端任务轮询排除补充任务**

`ProjectKnowledgeTab.tsx:59` 现在是
`sorted.find((t) => t.kind === 'project')`。补充任务也是 `kind='project'`，
不过滤的话用户点「AI 帮我补充」时，知识库页的分析进度条会跟着动，看上去像
在重跑分析。改成同时排除 `enrich:` 前缀：

```tsx
setAnalysisTask(sorted.find((t) => t.kind === 'project' && !t.sourceFingerprint.startsWith('enrich:')) ?? null);
```

`apps/web/src/types.ts:1110` 的 `AnalysisTask` 目前**没有** `sourceFingerprint`
字段（后端 `mapTask` 一直在返回，只是前端类型漏了），先补上：

```ts
sourceFingerprint: string;
```

顺带记一笔：`refreshTopicOpportunities` 建的任务 fingerprint 带
`:topic-refresh:`，同样会被这个 `find` 命中——那是既有行为，本次不改，
避免把无关修复混进来。

- [ ] **Step 6: 写测试**

用真 app + 真数据库（`apps/api/test` 的既有做法），只把模型那一层替换掉。
`runEnrichmentModel` 是 public 方法，测试里可以直接 stub 掉，从而在不联网的
前提下覆盖「查缺口 → 抽 context → 校验产物」这段真正的逻辑。

```typescript
// apps/api/test/intelligence-enrich-draft.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApplication } from '../src/app.js';
import { IntelligenceService } from '../src/intelligence.service.js';
import { IntelligenceEnrichService } from '../src/intelligence-enrich.service.js';

// 用例要覆盖:
// 1. 只挑 answer 为空 / sourceStatus 属于 unknown|inference|hypothesis 的缺口
//    (建三条缺口:一条 supplied_fact 且有答案 → 不该出现;两条待补 → 该出现)
// 2. 模型返回的 gapId 不在请求列表里 → 该条被丢弃
// 3. content 少于 10 字符 → 该条被丢弃
// 4. confidence 缺失或是垃圾值 → 落到 'low'
// 5. 一条缺口都没有 → 400
// 6. 模型返回的 items 全被丢弃 → 400,且提示指向「先补原始资料」
// 7. 传进模型的提示词包含知识文件里跟缺口相关的段落,不包含无关段落
//    (断言 stub 收到的 prompt 文本,这是 extractRelevantContext 的唯一可观测出口)
```

- [ ] **Step 7: 把测试文件加进 `apps/api/package.json` 的 `test` 列表并运行**

```bash
cd apps/api
node --import tsx --test test/intelligence-enrich-draft.test.ts
npm run typecheck
```

- [ ] **Step 8: 提交**

```bash
git add apps/api/src/intelligence-enrich.service.ts apps/api/src/intelligence.service.ts apps/api/src/app.module.ts apps/api/package.json apps/api/test/intelligence-enrich-draft.test.ts apps/web/src/components/quick/ProjectKnowledgeTab.tsx
git commit -m "feat(api): 知识库补充起草服务

查待补缺口 → 抽取相关资料片段 → 模型批量起草 → 校验产物。
模型调用走 IntelligenceService 新开的 runEnrichmentModel,复用既有任务生命周期;
补充任务用 fingerprint 前缀区分,前端分析进度条据此过滤。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 后端核心服务（合并与保存）

**Files:**
- Modify: `apps/api/src/intelligence-enrich.service.ts` —— 加 merge / save 两个方法
- Test: `apps/api/test/intelligence-enrich-merge.test.ts`

**Interfaces:**
- Consumes:
  - `KnowledgeService.list(projectId)` / `getWithContent(fileId)` —— 读原文
  - `KnowledgeService.import({ projectId, filename, content, category, evidenceStatus, metadata, principal })` —— 写新版本（同名文件自动递增 `version`）
  - `IntelligenceService.runEnrichmentModel(..., 'merge')` —— Task 2 新开的入口
  - `parseMergeRequest` / `parseSaveRequest`（Task 1）
- Produces:
  - `mergeEnrichedKnowledge(projectId, items, targetFile, principal): Promise<MergePreview>`
  - `saveEnrichedKnowledge(projectId, content, targetFile, principal): Promise<Record<string, unknown>>`

- [ ] **Step 1: 加 `mergeEnrichedKnowledge`**

```typescript
// 接在 IntelligenceEnrichService 类里

async mergeEnrichedKnowledge(
  projectId: string,
  items: MergeItem[],
  targetFile: string | undefined,
  principal: SessionPrincipal,
): Promise<MergePreview> {
  this.resources.projectRow(projectId);

  const active = items.filter((item) => item.status !== 'deleted');
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
  if (missing.length) throw new BadRequestException(`缺口不存在或不属于本项目：${missing.slice(0, 3).join('、')}`);

  // 每条都必须有正文。confirmed 表示用户接受了 AI 草稿,前端要把草稿原文回传;
  // 服务端不缓存草稿,这里拿不到就没法合并。
  const empty = active.filter((item) => !item.content || item.content.trim().length === 0);
  if (empty.length) throw new BadRequestException('确认或编辑过的条目必须带上正文内容');

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

  // callAnalysisModel 只返回 JSON 对象,所以合并结果要包在字段里,不能直接返 Markdown 字符串。
  const merged = typeof payload.document === 'string' ? payload.document.trim() : '';
  if (merged.length === 0) throw new BadRequestException('模型没能生成合并结果,请重试');

  return { preview: merged, targetFile: target, isNewFile: existing === '' };
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

只返回 JSON 对象，不要多余文字：
{"document":"完整的 Markdown 文档"}`;
}
```

- [ ] **Step 2: 加 `saveEnrichedKnowledge`**

```typescript
// 接在 IntelligenceEnrichService 类里

/**
 * 存成同名文件的新版本。
 *
 * knowledge.import 内部按 (project_id, filename) 取 MAX(version)+1,所以
 * 「新版本」只要文件名一致就自动成立,不需要显式传版本号。旧版本行保留,
 * 用户能回看——这正是设计稿要的版本历史。
 *
 * category / evidenceStatus 跟随原文件,只有新建时才用默认值:补充内容进的是
 * 用户原本那份资料,归类被悄悄改掉会让知识库的分类视图错乱。
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
    evidenceStatus: latest ? String(latest.evidenceStatus) : '待确认',
    metadata: { source: 'ai-enrichment', enrichedAt: nowIso() },
    principal,
  });
}
```

补两个 import：`nowIso` 来自 `./utils.js`，`MergeItem` / `MergePreview` 来自
`./intelligence-enrich.types.js`。

**注意 `evidenceStatus` 的取值**：`knowledge.import` 不校验这个字段，现有数据用的是中文
（`knowledge-recategorize.test.ts` 里是 `'已知事实'`）。落地前先跑一次
`SELECT DISTINCT evidence_status FROM knowledge_files`，用真实存在的值当默认，
别引入第三种写法。

- [ ] **Step 3: 写测试**

```typescript
// apps/api/test/intelligence-enrich-merge.test.ts
//
// 同样是真 app + 真库 + stub 掉 runEnrichmentModel。要覆盖:
// 1. targetFile 缺省且项目里有 INDEX.md → 选中它,isNewFile=false
// 2. targetFile 缺省且项目里没有 INDEX.md → 目标为 'INDEX.md',isNewFile=true
// 3. 传入别的项目的 gapId → 400,且报错信息不泄露那条缺口的标题
// 4. items 全是 deleted → 400
// 5. confirmed 但 content 为空 → 400
// 6. 模型返回 {"document":""} → 400
// 7. save 两次同名文件 → version 递增,旧版本行仍在(list 能查到两行)
// 8. save 到已存在的文件 → category / evidenceStatus 与原文件一致
// 9. save 的目标是新文件 → category='未分类'
```

- [ ] **Step 4: 加进 `apps/api/package.json` 的 `test` 列表并运行**

```bash
cd apps/api
node --import tsx --test test/intelligence-enrich-merge.test.ts
npm run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/intelligence-enrich.service.ts apps/api/package.json apps/api/test/intelligence-enrich-merge.test.ts
git commit -m "feat(api): 知识库补充的合并与保存

merge: 校验缺口归属 → 拼原文与补充 → 模型融合 → 返回预览(不落库)。
save: 走 knowledge.import 存成同名文件新版本,归类沿用原文件。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 后端路由与集成测试

**Files:**
- Modify: `apps/api/src/intelligence.controller.ts` —— 3 个路由
- Create: `apps/api/test/intelligence-enrich-api.test.ts`

**为什么 controller 直接注入 enrich 服务**：设计稿里让 `IntelligenceService`
包三层转发方法。那三个方法不做任何事，只是把参数原样传下去，而且
`IntelligenceService` 反过来注入 `IntelligenceEnrichService` 会和 Task 2 里
enrich 注入 `IntelligenceService` 形成循环依赖，Nest 要靠 `forwardRef` 才能起来。
controller 同时注入两个服务更简单，也是本仓库的常态（`KnowledgeController`
就同时注入 `KnowledgeService` / `ResourceService` / `PermissionGuard`）。

**Interfaces:**
- Consumes: `IntelligenceEnrichService`（Task 2、3）、`parseMergeRequest` / `parseSaveRequest`（Task 1）
- Produces:
  - `POST /api/projects/:projectId/intelligence/enrich/draft`
  - `POST /api/projects/:projectId/intelligence/enrich/merge`
  - `POST /api/projects/:projectId/intelligence/enrich/save`

- [ ] **Step 1: 加路由**

`IntelligenceController` 已经挂在 `@Controller('api/projects/:projectId')` 上，
`@UseGuards(SessionAuthGuard, CsrfGuard, PermissionGuard)` 是类级的，权限靠
`@RequirePermission` 声明。三条路由照这个来：

```typescript
// apps/api/src/intelligence.controller.ts

// 构造函数加一个依赖
constructor(
  @Inject(IntelligenceService) private readonly intelligence: IntelligenceService,
  @Inject(IntelligenceEnrichService) private readonly enrich: IntelligenceEnrichService,
) {}

@Post('intelligence/enrich/draft')
@RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
enrichDraft(@Req() request: Request, @Param('projectId') projectId: string) {
  return this.enrich.generateEnrichmentDraft(projectId, this.principal(request));
}

@Post('intelligence/enrich/merge')
@RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
enrichMerge(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
  const { items, targetFile } = parseMergeRequest(body);
  return this.enrich.mergeEnrichedKnowledge(projectId, items, targetFile, this.principal(request));
}

// save 写的是知识文件,所以判 knowledge.import 而不是 project.write——
// 和 KnowledgeController.handleUpload 保持同一把锁,否则会出现「不能上传知识库
// 但能通过补充功能写入知识库」的绕过。
@Post('intelligence/enrich/save')
@RequirePermission({ permission: 'knowledge.import', projectParam: 'projectId' })
enrichSave(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
  const { content, targetFile } = parseSaveRequest(body);
  return this.enrich.saveEnrichedKnowledge(projectId, content, targetFile, this.principal(request));
}
```

落地前确认两件事：`Permission` 联合类型里 `knowledge.import` 的确切拼写（见
`models.ts`，`KnowledgeController` 用的就是它）；以及 `@Post` 默认返回 201，
前端不要写死 200。

- [ ] **Step 2: 集成测试**

`apps/api` 没有 `supertest`，也没有 `test-helpers.js`。既有测试的做法是
`createApplication({...})` 起真 app + `fetch` 打真实 URL + 手动带 cookie 和
`x-csrf-token`。照 `test/knowledge-recategorize.test.ts` 的骨架来。

模型那层仍然 stub：从 app 里取出 `IntelligenceEnrichService` 依赖的
`IntelligenceService` 实例，替换 `runEnrichmentModel`。

```typescript
// apps/api/test/intelligence-enrich-api.test.ts
//
// 骨架照抄 test/knowledge-recategorize.test.ts:mkdtemp → createApplication →
// 登录拿 cookie/csrf → 建项目。然后:
//
//   const intelligence = app.get(IntelligenceService);
//   (intelligence as any).runEnrichmentModel = async (_p, _pr, prompt, purpose) =>
//     purpose === 'draft'
//       ? { items: [{ gapId: capturedGapId, content: '## 价格\n\n约 7000-9000 元（待确认）。', confidence: 'medium' }] }
//       : { document: '# 项目资料\n\n## 价格\n\n约 7000-9000 元（待确认）。' };
//
// 用例:
// 1. draft → 201,gaps 非空,每条 confidence 属于 low|medium|high
// 2. draft → merge → save 全链路:save 返回的 version 为 2(v1 是原文)
//    并且 GET /api/projects/:id/knowledge 能同时看到 v1 和 v2 两行
// 3. merge 的 targetFile 传 '../../../etc/passwd' → 400(Task 1 的校验生效)
// 4. save 时把 items 换成别的项目的 gapId → 400
// 5. 未登录 → 401;登录但无 project.write 的账号 → 403
//    (照 test/cross-tenant-isolation.test.ts 建第二个 workspace 的用户)
// 6. save 的 content 超过 2 MiB → 400 或 413,断言状态码是 4xx 且知识库没多出新版本
```

- [ ] **Step 3: 加进 `apps/api/package.json` 的 `test` 列表并跑全量**

```bash
cd apps/api
node --import tsx --test test/intelligence-enrich-api.test.ts
npm test
npm run typecheck
```

跑全量是因为这一步动了 `intelligence.controller.ts` 和 `app.module.ts`，
`api.test.ts` 里有路由清单类断言。

注意：本仓库的 `apps/api` 全量测试此前出现过一批环境相关的失败
（`cross-tenant-isolation` / `settings-quota` / `saas-quota` / 迁移测试报
`no such table: knowledge_files`）。如果这些还红，先确认是不是本次改动引入的
——判据是 `git stash` 后同样红。是既有问题就在提交信息里如实写明，不要声称全绿。

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/intelligence.controller.ts apps/api/package.json apps/api/test/intelligence-enrich-api.test.ts
git commit -m "feat(api): 知识库补充的三个端点

enrich/draft|merge|save。save 判 knowledge.import 权限,与知识库上传同一把锁。
集成测试覆盖全链路版本递增、路径穿越、越权与跨项目 gapId。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 前端类型与 API 封装

**Files:**
- Create: `apps/web/src/lib/enrich-types.ts`
- Modify: `apps/web/src/lib/api.ts` —— 在 `api.intelligence` 下加 `enrich`
- Modify: `apps/web/src/types.ts` —— 给 `AnalysisTask` 补 `sourceFingerprint`（若 Task 2 尚未补）

**两处与设计稿的偏差**：

1. **不新建 `api-enrich.ts`**。`request()` 是 `api.ts` 内部函数，没有 export，
   外部文件拿不到；而 `api` 是一个对象字面量，无法从别的模块往里加键。所以
   `enrich` 直接写在 `api.ts` 的 `intelligence` 块里（`tasks` 就在旁边，同一写法）。
2. **不导出 `tokensUsed`**。后端拿不到真实 token 数（见 Task 1 的注释）。
3. **本仓库的 import 不写扩展名**（看 `ProjectKnowledgeTab.tsx` 顶部），
   设计稿里的 `./api.js` 写法要去掉 `.js`。

- [ ] **Step 1: 前端类型**

```typescript
// apps/web/src/lib/enrich-types.ts

/** AI 对自己这条推断的把握程度。low 要在 UI 上显著标出。 */
export type EnrichConfidence = 'low' | 'medium' | 'high';

/** 一条草稿在用户手里的处置状态。editing 是纯 UI 态,不会发给后端。 */
export type DraftStatus = 'pending' | 'confirmed' | 'editing' | 'edited' | 'deleted';

export type ModalStep = 'drafting' | 'editing' | 'merging' | 'preview' | 'saving';

/** 后端 /enrich/draft 返回的单条草稿。 */
export interface EnrichDraft {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: EnrichConfidence;
}

/** 前端在 EnrichDraft 上叠加的编辑态。 */
export interface DraftItem extends EnrichDraft {
  status: DraftStatus;
  /** 用户改过的正文。为空表示沿用 aiDraft。 */
  userContent?: string;
}

export interface EnrichDraftResponse {
  gaps: EnrichDraft[];
}

export interface EnrichMergeItem {
  gapId: string;
  status: 'confirmed' | 'edited' | 'deleted';
  content?: string;
}

export interface EnrichMergeRequest {
  items: EnrichMergeItem[];
  targetFile?: string;
}

export interface EnrichMergeResponse {
  preview: string;
  targetFile: string;
  isNewFile: boolean;
}

export interface EnrichSaveRequest {
  content: string;
  targetFile: string;
}

/** 缺口的三档统计。入口按钮用它决定要不要提示、提示什么。 */
export interface GapStats {
  total: number;
  supplied: number;
  inferred: number;
  unknown: number;
}

/**
 * 待补充 = 未知 + 推断。
 *
 * 与后端 pendingGaps 的判据保持一致(答案为空或 sourceStatus 属于
 * unknown/inference/hypothesis)。两边要是各算一套,用户看到「3 条待补充」
 * 却点进去发现 5 条,信任就没了。
 */
export function pendingCount(stats: GapStats): number {
  return stats.unknown + stats.inferred;
}
```

- [ ] **Step 2: 在 `api.ts` 的 `intelligence` 块里加 `enrich`**

紧跟在 `tasks: { ... }` 后面：

```typescript
    enrich: {
      draft: (projectId: string) =>
        request<EnrichDraftResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/draft`,
          { method: "POST" },
        ),
      merge: (projectId: string, body: EnrichMergeRequest) =>
        request<EnrichMergeResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/merge`,
          { method: "POST", body: JSON.stringify(body) },
        ),
      save: (projectId: string, body: EnrichSaveRequest) =>
        request<JsonRecord>(
          `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/save`,
          { method: "POST", body: JSON.stringify(body) },
        ).then(normalizeKnowledge),
    },
```

三点说明：
- 不用手写 `Content-Type`，`request()` 已经加了，CSRF 头也是它统一带的。
- `save` 返回的是知识文件行，走既有的 `normalizeKnowledge`，这样前端拿到的
  形状跟 `api.knowledge.list()` 一致，能直接塞回文件列表。
- 类型从 `./enrich-types` import。

- [ ] **Step 3: 测试**

两处要纠正设计稿：`apps/web` **没有 vitest**（`package.json` 的 devDependencies
里没有，`test` 脚本是 `node --import tsx --test` 加一串显式文件），所以
`describe/it/expect/vi` 全都不可用；而且 `request` 没有 export，无法 spy。

用 `node:test` + `globalThis.fetch` 替换：

```typescript
// apps/web/test/enrich-api.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiError } from '../src/lib/api';
import { pendingCount } from '../src/lib/enrich-types';

/* 记录每次请求,便于断言 URL / method / body。 */
function stubFetch(status = 200, payload: unknown = { gaps: [] }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

// 用例:
// 1. draft 打到 /api/projects/proj-123/intelligence/enrich/draft,method=POST
// 2. projectId 含 '/' 或中文时被 encodeURIComponent 转义(防路径拼接)
// 3. merge 的 body 是传入对象的 JSON
// 4. 后端返 400 + {message:'...'} 时抛 ApiError,message 透出后端原文
// 5. pendingCount({total:5,supplied:2,inferred:1,unknown:2}) === 3
```

已核实两件事，不用再查：`ApiError` 在 `api.ts:46` 是 export 的；`cookieValue`
和 `readStoredCsrf` 都有 `typeof document === "undefined"` / `typeof window ===
"undefined"` 守卫，所以在 Node 下 import `api.ts` 不会炸。

**不要为了测试给 `api.ts` 加导出或改结构。**

- [ ] **Step 4: 登记测试文件并运行**

`apps/web` 的 `test` 脚本也是显式文件列表，新测试要加进去，否则不会被跑到。

```bash
cd apps/web
node --import tsx --test test/enrich-api.test.ts
npm run typecheck
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/enrich-types.ts apps/web/src/lib/api.ts apps/web/src/types.ts apps/web/src/lib/api-enrich.test.ts
git commit -m "feat(web): 知识库补充的类型与 API 封装

enrich-types 定义草稿/合并/保存的请求响应形状,api.intelligence.enrich 三个方法。
save 复用 normalizeKnowledge,返回形状与 knowledge.list 一致。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 前端核心组件（Modal 容器）

**Files:**
- Create: `apps/web/src/lib/enrich-flow.ts` —— 纯状态逻辑
- Create: `apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx`
- Create: `apps/web/src/components/knowledge/EnrichmentDraftList.tsx`
- Create: `apps/web/test/enrich-flow.test.ts`

**设计稿要改的四处**（都已核实）：

1. **组件从 `../Ui` 导入**。仓库里没有 `Modal.tsx` / `Button.tsx` / `Spinner.tsx`；
   `Button`、`Modal`、`useToast`、`Field`、`Badge`、`EmptyState` 全在
   `src/components/Ui.tsx`。也没有 `lib/toast.ts`。
2. **`Modal` 的 `size` 只接受 `"wide"`**（`Ui.tsx:112`），没有 `fullscreen`。
   用 `size="wide"`（920px）。
3. **footer 走 `Modal` 的 `footer` prop**，不要在 body 里塞一个自己的
   `.modal-footer` div——`Modal` 已经渲染 `.modal__footer` 并带上分隔线和底色。
4. **`ApiError` 没有 `code` 字段**，只有 `message` / `status` / `details`
   （`api.ts:46`）。后端「没有待补充缺口」抛的是 400 + 中文 message，所以
   前端按 `status === 400` 加 message 判断，或者干脆统一展示后端原文。
   本计划采用后者：后端的话已经是给用户看的，前端再翻译一遍只会不一致。

**为什么把状态逻辑拆进 `lib/enrich-flow.ts`**：`apps/web` 没有
`@testing-library/react`，也没有 vitest，测试是 `node:test` 跑纯逻辑
（`revision-progress.ts` + `test/revision-box.test.ts` 就是这个模式）。
状态机留在组件里就等于没测试。

**Interfaces:**
- Consumes: `api.intelligence.enrich.*`、`DraftItem` / `ModalStep`（Task 5）
- Produces:
  - `enrichFlow`: `toMergeItems`, `hasUnsavedEdits`, `canMerge`, `applyDraftChange`
  - `<KnowledgeEnrichmentModal open projectId onClose onComplete />`
  - `<EnrichmentDraftList items onChange />`

- [ ] **Step 1: 纯状态逻辑**

```typescript
// apps/web/src/lib/enrich-flow.ts
import type { DraftItem, EnrichDraft, EnrichMergeItem } from './enrich-types';

/** 后端返回的草稿转成前端编辑态。初始一律 pending:没审过就不算确认。 */
export function toDraftItems(drafts: EnrichDraft[]): DraftItem[] {
  return drafts.map((draft) => ({ ...draft, status: 'pending' }));
}

/** 当前生效的正文:改过就用用户的,没改就用 AI 的。 */
export function effectiveContent(item: DraftItem): string {
  return item.userContent?.trim() ? item.userContent : item.aiDraft;
}

/**
 * 组装 merge 请求。
 *
 * 只发非 deleted 的条目——后端 mergeEnrichedKnowledge 会对每条 active 项要求
 * 正文非空,把 deleted 项一起发过去只是让后端再过滤一遍。
 * pending(用户没动过)按 confirmed 发:用户点了「生成合并版」就是接受了它。
 */
export function toMergeItems(items: DraftItem[]): EnrichMergeItem[] {
  return items
    .filter((item) => item.status !== 'deleted')
    .map((item) => ({
      gapId: item.gapId,
      status: item.status === 'edited' || item.status === 'editing' ? 'edited' : 'confirmed',
      content: effectiveContent(item),
    }));
}

/** 有没有改动没提交。关闭前的二次确认靠它。 */
export function hasUnsavedEdits(items: DraftItem[]): boolean {
  return items.some((item) => item.status === 'editing' || item.status === 'edited');
}

/** 至少留一条、且每条都有正文,才能合并。 */
export function canMerge(items: DraftItem[]): boolean {
  const active = items.filter((item) => item.status !== 'deleted');
  return active.length > 0 && active.every((item) => effectiveContent(item).trim().length > 0);
}

/** 替换一条(按 gapId),其余不动。 */
export function applyDraftChange(items: DraftItem[], updated: DraftItem): DraftItem[] {
  return items.map((item) => (item.gapId === updated.gapId ? updated : item));
}
```

- [ ] **Step 2: Modal 容器**

```tsx
// apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx
import { useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { Button, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { canMerge, hasUnsavedEdits, toDraftItems, toMergeItems } from '../../lib/enrich-flow';
import type { DraftItem, ModalStep } from '../../lib/enrich-types';
import { EnrichmentDraftList } from './EnrichmentDraftList';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 保存成功后回调,让知识库页刷新文件列表并提示重新分析。 */
  onComplete: () => void;
}

const TITLES: Record<ModalStep, string> = {
  drafting: 'AI 正在起草',
  editing: 'AI 补充建议',
  merging: '正在合并',
  preview: '预览合并结果',
  saving: '正在保存',
};

export function KnowledgeEnrichmentModal({ open, projectId, onClose, onComplete }: Props) {
  const [step, setStep] = useState<ModalStep>('drafting');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [preview, setPreview] = useState('');
  const [targetFile, setTargetFile] = useState('');
  const [isNewFile, setIsNewFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // 每次打开都重新起草。草稿不落库,复用上次的会让用户以为编辑被保存了。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep('drafting');
    setItems([]);
    setPreview('');
    setError(null);
    api.intelligence.enrich.draft(projectId)
      .then((result) => {
        if (cancelled) return;
        setItems(toDraftItems(result.gaps));
        setStep('editing');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 后端的报错文案本来就是写给用户的(「当前没有需要补充的信息缺口」),
        // 直接展示,不在前端二次翻译。
        setError(e instanceof Error ? e.message : '起草失败');
      });
    return () => { cancelled = true; };
  }, [open, projectId]);

  const merge = async () => {
    setStep('merging');
    setError(null);
    try {
      const result = await api.intelligence.enrich.merge(projectId, { items: toMergeItems(items) });
      setPreview(result.preview);
      setTargetFile(result.targetFile);
      setIsNewFile(result.isNewFile);
      setStep('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '合并失败');
      setStep('editing');   // 退回编辑态,用户的修改还在
    }
  };

  const save = async () => {
    setStep('saving');
    try {
      await api.intelligence.enrich.save(projectId, { content: preview, targetFile });
      toast.push('知识库已更新,建议重新分析以让补充内容生效');
      onComplete();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败');
      setStep('preview');
    }
  };

  const close = () => {
    if (step === 'editing' && hasUnsavedEdits(items)
        && !window.confirm('有改过但未提交的补充内容,关闭后会丢失。确定关闭吗?')) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      size="wide"
      title={TITLES[step]}
      description={step === 'editing' ? 'AI 基于现有资料起草,请逐条审查后再合并' : undefined}
      onClose={close}
      footer={footer()}
    >
      {error && (
        <div className="enrich-error" role="alert">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {(step === 'drafting' || step === 'merging' || step === 'saving') && !error && (
        <div className="enrich-loading">
          <span className="spinner" aria-hidden="true" />
          <p>{step === 'drafting' ? 'AI 正在根据现有资料起草补充内容' : step === 'merging' ? '正在把补充内容融合进知识库' : '正在保存新版本'}</p>
          {step !== 'saving' && <small>通常需要 30-60 秒</small>}
        </div>
      )}

      {step === 'editing' && !error && (
        <>
          <p className="enrich-hint">
            以下内容由 AI 推断,<strong>不是已核实的事实</strong>。请逐条审查:
            准确的直接保留,有偏差的改掉,不需要的删除。
          </p>
          <EnrichmentDraftList items={items} onChange={setItems} />
        </>
      )}

      {step === 'preview' && (
        <div className="enrich-preview">
          <p className="enrich-notice">
            <Info size={15} aria-hidden="true" />
            <span>
              这是融合后的完整文档,将
              {isNewFile ? '新建' : '保存为'} <code>{targetFile}</code>
              {isNewFile ? '' : ' 的新版本(旧版本仍可查看)'}。
            </span>
          </p>
          <pre className="enrich-preview__body">{preview}</pre>
        </div>
      )}
    </Modal>
  );

  function footer() {
    if (step === 'editing') {
      return (
        <>
          <Button variant="ghost" onClick={close}>稍后再说</Button>
          <Button onClick={() => void merge()} disabled={!canMerge(items)}>生成合并版</Button>
        </>
      );
    }
    if (step === 'preview') {
      return (
        <>
          <Button variant="ghost" onClick={() => setStep('editing')}>返回修改</Button>
          <Button onClick={() => void save()}>确认保存</Button>
        </>
      );
    }
    if (error) return <Button variant="ghost" onClick={close}>关闭</Button>;
    return undefined;
  }
}
```

- [ ] **Step 3: 草稿列表容器**

```tsx
// apps/web/src/components/knowledge/EnrichmentDraftList.tsx
import { EmptyState } from '../Ui';
import { applyDraftChange } from '../../lib/enrich-flow';
import type { DraftItem } from '../../lib/enrich-types';

export function EnrichmentDraftList({ items, onChange }: { items: DraftItem[]; onChange: (items: DraftItem[]) => void }) {
  if (items.length === 0) {
    return <EmptyState title="没有可补充的内容" description="AI 没能基于现有资料生成建议,先上传一些原始资料再试。" />;
  }
  return (
    <div className="enrich-list">
      {items.map((item) => (
        // DraftItemCard 在 Task 7 实现;这一步先渲染最小可读形态,保证 Modal 流程能跑通。
        <article key={item.gapId} className="draft-item">
          <h4>{item.title}</h4>
          {item.question && <p className="draft-item__question">{item.question}</p>}
          <pre className="draft-item__body">{item.userContent ?? item.aiDraft}</pre>
        </article>
      ))}
    </div>
  );
}
```

`applyDraftChange` 在 Task 7 接上卡片交互时才用到，这一步先 import 会触发
未使用变量告警——Step 3 里**先不要** import 它，等 Task 7 再加。

- [ ] **Step 4: 测试纯逻辑**

```typescript
// apps/web/test/enrich-flow.test.ts
// node:test。用例:
// 1. toDraftItems 全部初始为 pending
// 2. effectiveContent: userContent 为空串/纯空白时回落 aiDraft
// 3. toMergeItems 剔除 deleted;pending → confirmed;edited/editing → edited
// 4. hasUnsavedEdits: 只有 pending/deleted 时为 false
// 5. canMerge: 全 deleted → false;有一条正文为空白 → false;正常 → true
// 6. applyDraftChange 只改中标那条,数组长度和顺序不变
```

- [ ] **Step 5: 登记并运行**

把 `test/enrich-flow.test.ts` 加进 `apps/web/package.json` 的 `test` 列表。

```bash
cd apps/web
node --import tsx --test test/enrich-flow.test.ts
npm run typecheck
```

`npm run typecheck` 这一步会暴露组件里的 import 路径和 prop 类型错误——这是
组件唯一的自动化保护，别跳过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/enrich-flow.ts apps/web/src/components/knowledge/ apps/web/test/enrich-flow.test.ts apps/web/package.json
git commit -m "feat(web): 知识库补充的流程容器

状态机拆进 lib/enrich-flow.ts 以便用 node:test 覆盖,Modal 只管渲染。
错误直接展示后端文案,避免前后端各写一套说法。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 前端编辑组件（DraftItemCard）

**Files:**
- Create: `apps/web/src/components/knowledge/DraftItemCard.tsx`
- Modify: `apps/web/src/components/knowledge/EnrichmentDraftList.tsx` —— 换成 DraftItemCard
- Modify: `apps/web/src/lib/enrich-flow.ts` —— 加卡片的状态转换纯函数
- Modify: `apps/web/test/enrich-flow.test.ts` —— 补相应用例

**设计稿要改的三处**：
1. `Button` / `Badge` 都从 `../Ui` 导入，仓库里没有 `Button.tsx` / `Badge.tsx`。
2. **`Button` 没有 `size` prop**（`Ui.tsx:86` 只有 `variant` / `loading` / `icon`）。
   卡片里的小按钮用原生 `<button type="button" className="draft-item__action">`，
   跟 `IntelligentSimpleFlow.tsx` 的 `.pool-list` 卡片一致；样式在 Task 8 里加。
3. **`Badge` 的 `tone` 没有 `'success'`**，可选值是
   `neutral | positive | warning | danger | purple | blue`（`Ui.tsx:95`）。
   高把握用 `positive`。

**卡片状态转换也放进 `enrich-flow.ts`**，理由同 Task 6：`apps/web` 只能测纯逻辑。
组件里只留 `useState` 和 JSX。

**Interfaces:**
- Consumes: `DraftItem`（Task 5）、`Badge` / `Button`（`../Ui`）
- Produces: `<DraftItemCard item onChange />`、`confirmDraft` / `editDraft` / `deleteDraft` / `restoreDraft` / `beginEdit` / `cancelEdit` / `confidenceLabel`

- [ ] **Step 1: 在 `enrich-flow.ts` 里加状态转换**

```typescript
// apps/web/src/lib/enrich-flow.ts 追加

export function beginEdit(item: DraftItem): DraftItem {
  return { ...item, status: 'editing' };
}

export function confirmDraft(item: DraftItem): DraftItem {
  return { ...item, status: 'confirmed' };
}

/** 提交编辑。正文改回和 AI 原稿一致时退回 pending——没有实际改动就别标成「已修改」。 */
export function commitEdit(item: DraftItem, content: string): DraftItem {
  const text = content.trim();
  if (text === item.aiDraft.trim()) return { ...item, status: 'pending', userContent: undefined };
  return { ...item, status: 'edited', userContent: content };
}

/** 放弃编辑。之前改过的保留 edited,没改过的回到 pending。 */
export function cancelEdit(item: DraftItem): DraftItem {
  return { ...item, status: item.userContent ? 'edited' : 'pending' };
}

export function deleteDraft(item: DraftItem): DraftItem {
  return { ...item, status: 'deleted' };
}

/** 恢复。改过的回到 edited,保住用户的文字——回到 pending 会让编辑白做。 */
export function restoreDraft(item: DraftItem): DraftItem {
  return { ...item, status: item.userContent ? 'edited' : 'pending' };
}

const CONFIDENCE_LABELS: Record<EnrichConfidence, { text: string; tone: 'positive' | 'warning' | 'danger' }> = {
  high: { text: '资料中有明确依据', tone: 'positive' },
  medium: { text: '基于资料推断', tone: 'warning' },
  low: { text: '缺少依据,需你确认', tone: 'danger' },
};

/**
 * 把把握程度说成「依据强弱」而不是「高/中/低把握」。
 *
 * 「高把握」听起来像质量评分,用户会当成「这条更可信,不用看」;而这三档说的
 * 其实是「依据来自哪里」。逐条审查是这个功能的前提,文案不能反过来劝人不审。
 */
export function confidenceLabel(confidence: EnrichConfidence) {
  return CONFIDENCE_LABELS[confidence];
}
```

顶部 import 加上 `EnrichConfidence` 类型。

- [ ] **Step 2: DraftItemCard**

```tsx
// apps/web/src/components/knowledge/DraftItemCard.tsx
import { useState } from 'react';
import { CheckCircle2, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '../Ui';
import {
  beginEdit, cancelEdit, commitEdit, confidenceLabel, confirmDraft, deleteDraft, restoreDraft,
} from '../../lib/enrich-flow';
import type { DraftItem } from '../../lib/enrich-types';

export function DraftItemCard({ item, onChange }: { item: DraftItem; onChange: (updated: DraftItem) => void }) {
  const [text, setText] = useState(item.userContent ?? item.aiDraft);

  if (item.status === 'deleted') {
    return (
      <article className="draft-item draft-item--deleted">
        <h4>{item.title}</h4>
        <span className="draft-item__note">已移除,不会写入知识库</span>
        <button type="button" className="draft-item__action" onClick={() => onChange(restoreDraft(item))}>
          <RotateCcw size={13} aria-hidden="true" /> 恢复
        </button>
      </article>
    );
  }

  const label = confidenceLabel(item.confidence);
  const editing = item.status === 'editing';

  return (
    <article className={`draft-item draft-item--${item.confidence}`}>
      <header className="draft-item__header">
        <h4>{item.title}</h4>
        <Badge tone={label.tone}>{label.text}</Badge>
      </header>
      {item.question && <p className="draft-item__question">{item.question}</p>}

      {editing ? (
        <>
          <label className="draft-item__label" htmlFor={`draft-${item.gapId}`}>补充内容</label>
          <textarea
            id={`draft-${item.gapId}`}
            className="draft-item__textarea"
            value={text}
            rows={8}
            onChange={(event) => setText(event.target.value)}
          />
          <footer className="draft-item__actions">
            <button type="button" className="draft-item__action" onClick={() => { setText(item.userContent ?? item.aiDraft); onChange(cancelEdit(item)); }}>
              取消
            </button>
            <button type="button" className="draft-item__action draft-item__action--primary" onClick={() => onChange(commitEdit(item, text))}>
              保存修改
            </button>
          </footer>
        </>
      ) : (
        <>
          <pre className="draft-item__body">{item.userContent ?? item.aiDraft}</pre>
          <footer className="draft-item__actions">
            {item.status === 'confirmed' && (
              <span className="draft-item__confirmed"><CheckCircle2 size={14} aria-hidden="true" /> 已确认</span>
            )}
            {item.status === 'edited' && <span className="draft-item__note">已修改</span>}
            <button type="button" className="draft-item__action" onClick={() => onChange(deleteDraft(item))}>
              <Trash2 size={13} aria-hidden="true" /> 删除
            </button>
            <button type="button" className="draft-item__action" onClick={() => onChange(beginEdit(item))}>
              <Pencil size={13} aria-hidden="true" /> 修改
            </button>
            {item.status !== 'confirmed' && (
              <button type="button" className="draft-item__action draft-item__action--primary" onClick={() => onChange(confirmDraft(item))}>
                确认无误
              </button>
            )}
          </footer>
        </>
      )}
    </article>
  );
}
```

- [ ] **Step 3: 列表接上卡片**

```tsx
// apps/web/src/components/knowledge/EnrichmentDraftList.tsx
import { EmptyState } from '../Ui';
import { applyDraftChange } from '../../lib/enrich-flow';
import type { DraftItem } from '../../lib/enrich-types';
import { DraftItemCard } from './DraftItemCard';

export function EnrichmentDraftList({ items, onChange }: { items: DraftItem[]; onChange: (items: DraftItem[]) => void }) {
  if (items.length === 0) {
    return <EmptyState title="没有可补充的内容" description="AI 没能基于现有资料生成建议,先上传一些原始资料再试。" />;
  }
  return (
    <div className="enrich-list">
      {items.map((item) => (
        <DraftItemCard key={item.gapId} item={item} onChange={(updated) => onChange(applyDraftChange(items, updated))} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 补测试用例**

在 `apps/web/test/enrich-flow.test.ts` 追加：

```
// 1. confirmDraft → status confirmed,userContent 不变
// 2. commitEdit 内容与 aiDraft 相同(含首尾空白差异)→ 退回 pending 且清掉 userContent
// 3. commitEdit 内容不同 → edited 且 userContent 是原样(不 trim,用户的换行要留着)
// 4. cancelEdit: 有 userContent → edited;没有 → pending
// 5. restoreDraft: 改过的回 edited,没改过的回 pending
// 6. confidenceLabel: 三档各自的 tone 都在 Badge 允许的取值里(positive|warning|danger)
//    ——这条是防回归:Badge 不接受 'success',写错了 typecheck 能拦,但取值一旦改动
//    这里会更早报出来
```

- [ ] **Step 5: 运行**

```bash
cd apps/web
node --import tsx --test test/enrich-flow.test.ts
npm run typecheck
```

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/enrich-flow.ts apps/web/src/components/knowledge/ apps/web/test/enrich-flow.test.ts
git commit -m "feat(web): 草稿卡片的逐条确认/编辑/删除

状态转换是 enrich-flow 里的纯函数,卡片只管渲染。
把握程度的文案改为「依据强弱」,避免用户把它当质量分而跳过审查。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 前端预览组件与样式

**Files:**
- Create: `apps/web/src/components/knowledge/OriginalKnowledgePreview.tsx`
- Modify: `apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx` —— editing 步骤放进左右布局
- Modify: `apps/web/src/styles.css` —— 加 `.enrich-*` / `.draft-item*` 样式

**设计稿要改的四处**（都已核实）：

1. **没有 `react-markdown` 依赖**，`apps/web/package.json` 里只有
   `lucide-react` / `react` / `react-dom` / `react-router-dom`。为了预览一段
   Markdown 装一个渲染器（还得连带考虑 XSS 净化——`preview` 是模型生成的文本）
   不值得。已有做法：知识文件预览就是
   `<pre className="qc-knowledge-preview">`（`ProjectKnowledgeTab.tsx:268`）。
   照它来，用 `<pre>` 显示纯文本。**这条同时废掉了 `MergedDocumentPreview` 组件**
   ——Task 6 的 Modal 里已经是 `<pre className="enrich-preview__body">`，不用再包一层。
2. **`api.knowledge.getAll` 不存在**。列表是 `api.knowledge.list(projectId)`
   （返回 `{ items, total }`，元素是 `KnowledgeFile`，字段名是 `name` 不是
   `filename`），正文要 `api.knowledge.get(fileId)` 单独取。
3. **CSS 变量对一下真名**：`--muted-soft` 和 `--green` 之外的
   `--red` / `--amber` / `--green` / `--blue-soft` / `--red-soft` 都在
   `styles.css:1-40` 有定义，但**没有 `--muted-soft`**——用 `--surface-soft`。
4. **`.enrich-error` 别写 `padding: 12px 20px`**。它现在渲染在
   `.modal__body`（本身有 23px 内边距）里面，再加 20px 会和卡片对不齐。

**Interfaces:**
- Consumes: `api.knowledge.list` / `api.knowledge.get`
- Produces: `<OriginalKnowledgePreview projectId />`、`.enrich-*` / `.draft-item*` 样式

- [ ] **Step 1: 原文预览**

```tsx
// apps/web/src/components/knowledge/OriginalKnowledgePreview.tsx
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { KnowledgeFile } from '../../types';

/**
 * 审查草稿时对照现有资料。
 *
 * 正文按需加载:一个项目可能有十几个文件,进来就全读会拖慢弹窗打开。
 * 第一个默认展开,其余点开再取。
 */
export function OriginalKnowledgePreview({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.knowledge.list(projectId)
      .then((result) => { if (!cancelled) setFiles(result.items); })
      .catch(() => { if (!cancelled) setFiles([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const load = (id: string) => {
    if (contents[id] !== undefined) return;
    setContents((current) => ({ ...current, [id]: '' }));   // 占位,避免重复请求
    api.knowledge.get(id)
      .then((file) => setContents((current) => ({ ...current, [id]: file.content || '(空文件)' })))
      .catch(() => setContents((current) => ({ ...current, [id]: '(读取失败)' })));
  };

  if (loading) return <p className="qc-hint">正在读取现有资料…</p>;
  if (files.length === 0) return <p className="qc-hint">项目里还没有知识文件。</p>;

  return (
    <div className="enrich-original__list">
      {files.map((file, index) => (
        <details key={file.id} open={index === 0} onToggle={() => load(file.id)}>
          <summary>{file.name}</summary>
          <pre className="enrich-original__body">{contents[file.id] ?? '正在加载…'}</pre>
        </details>
      ))}
    </div>
  );
}
```

第一个 `<details open>` 不会触发 `onToggle`，所以要在 `useEffect` 拿到列表后
主动 `load(result.items[0].id)`——落地时补上这一句。

- [ ] **Step 2: Modal 的 editing 步骤改成左右布局**

把 Task 6 里 editing 分支的内容包进 `.enrich-editing`：

```tsx
{step === 'editing' && !error && (
  <div className="enrich-editing">
    <div className="enrich-drafts">
      <p className="enrich-hint">
        以下内容由 AI 推断,<strong>不是已核实的事实</strong>。请逐条审查:
        准确的直接保留,有偏差的改掉,不需要的删除。
      </p>
      <EnrichmentDraftList items={items} onChange={setItems} />
    </div>
    <aside className="enrich-original">
      <h4>现有资料</h4>
      <OriginalKnowledgePreview projectId={projectId} />
    </aside>
  </div>
)}
```

- [ ] **Step 3: 样式**

追加到 `styles.css` 末尾。要点：

```css
/* ---- 知识库 AI 补充 ---- */
/* 弹窗宽度是 modal--wide 的 920px,左右分栏留给原文 280px 就够对照,
   再宽草稿区就不够放正文了。低于 900px 的视口(iPad 竖屏)收成单列。 */
.enrich-editing { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 18px; }
.enrich-drafts { min-width: 0; }
.enrich-hint { margin: 0 0 14px; padding: 11px 13px; border-radius: 8px; background: var(--blue-soft); color: var(--ink-2); font-size: var(--font-sm); line-height: 1.6; }
.enrich-list { display: flex; flex-direction: column; gap: 13px; }

.enrich-original { align-self: start; max-height: 460px; overflow-y: auto; padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.enrich-original h4 { margin: 0 0 9px; font-size: var(--font-sm); }
.enrich-original summary { cursor: pointer; font-size: var(--font-xs); font-weight: 600; padding: 5px 0; }
/* overflow-wrap:资料里常有长 URL 和无空格的中英混排,不断行会顶破窄栏 */
.enrich-original__body { margin: 4px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--font-2xs); line-height: 1.65; color: var(--muted); }

.draft-item { padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
/* 左边框编码依据强弱。颜色只是辅助,文字标签(Badge)才是主要信息载体——
   只靠颜色区分对色觉障碍用户不可达。 */
.draft-item--high { border-left: 3px solid var(--green); }
.draft-item--medium { border-left: 3px solid var(--amber); }
.draft-item--low { border-left: 3px solid var(--red); }
.draft-item--deleted { display: flex; align-items: center; gap: 10px; opacity: .6; background: var(--surface-soft); }
.draft-item--deleted h4 { margin: 0; }
.draft-item__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.draft-item__header h4 { margin: 0; font-size: var(--font-sm); }
.draft-item__question { margin: 0 0 10px; color: var(--muted); font-size: var(--font-xs); }
.draft-item__body { margin: 0; padding: 11px; border-radius: 7px; background: var(--surface-soft); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--font-sm); line-height: 1.7; }
.draft-item__label { display: block; margin-bottom: 5px; font-size: var(--font-xs); font-weight: 600; color: var(--ink-2); }
.draft-item__textarea { width: 100%; padding: 11px; border: 1px solid var(--line); border-radius: 7px; font: inherit; font-size: var(--font-sm); line-height: 1.7; resize: vertical; }
.draft-item__actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; margin-top: 11px; }
.draft-item__note { margin-right: auto; color: var(--muted); font-size: var(--font-2xs); }
.draft-item__confirmed { margin-right: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--green); font-size: var(--font-xs); }
.draft-item__action { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--muted); font-size: var(--font-xs); cursor: pointer; }
.draft-item__action:hover { border-color: var(--line-dark); color: var(--ink); }
.draft-item__action--primary { border-color: var(--coral); background: var(--coral-soft); color: var(--coral-dark); }

.enrich-loading { min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 11px; text-align: center; }
.enrich-loading p { margin: 0; font-size: var(--font-sm); }
.enrich-loading small { color: var(--muted); }

.enrich-notice { display: flex; align-items: flex-start; gap: 9px; margin: 0 0 13px; padding: 11px 13px; border-radius: 8px; background: var(--blue-soft); color: var(--ink-2); font-size: var(--font-sm); line-height: 1.6; }
.enrich-preview__body { margin: 0; max-height: 460px; overflow: auto; padding: 15px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--font-sm); line-height: 1.75; }

/* 内边距不带横向值:它渲染在 .modal__body 里,那里已有 23px */
.enrich-error { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 13px; padding: 11px 13px; border-radius: 8px; background: var(--red-soft); color: var(--red); font-size: var(--font-sm); }

@media (max-width: 900px) {
  .enrich-editing { grid-template-columns: minmax(0, 1fr); }
  .enrich-original { max-height: 240px; }
}
```

- [ ] **Step 4: typecheck + build**

```bash
cd apps/web
npm run typecheck && npm run build
```

`build` 会跑 `tsc --noEmit && vite build`，是这些组件唯一的自动化保护。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/knowledge/ apps/web/src/styles.css
git commit -m "feat(web): 原文对照视图与补充弹窗样式

原文按需加载正文,避免打开弹窗就读全部文件。
预览用 pre 显示纯文本,不引入 Markdown 渲染器——模型输出还要考虑净化,收益不抵成本。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: 前端入口集成（ProjectKnowledgeTab）

**Files:**
- Modify: `apps/web/src/lib/enrich-flow.ts` —— 加 `gapStats` 纯函数
- Modify: `apps/web/src/components/quick/ProjectKnowledgeTab.tsx` —— 三档统计 + 入口按钮 + 弹窗
- Modify: `apps/web/test/enrich-flow.test.ts` —— 补 `gapStats` 用例

**设计稿要改的四处**（都已核实）：

1. **路径是 `src/components/quick/ProjectKnowledgeTab.tsx`**，不是 `src/pages/`。
2. **`api.intelligence.gaps` 不存在**，是 `api.informationGaps.list(projectId)`，
   返回 `{ items, total }`。
3. **`intel` 对象上没有 `informationGaps`**。`api.intelligence.get()` 返回的是
   `ProjectIntelligence`，缺口要单独拉。所以要在既有的 `useEffect` 里加一次
   `api.informationGaps.list`，和 `api.opportunities.list` 并列。
4. **组件里没有 `projectId` 变量**，只有 `project: Project | null`（可能为 null），
   用 `project.id`。也没有 `toast`，要 `useToast()`（`fail` prop 是给失败用的）。

**Interfaces:**
- Consumes: `api.informationGaps.list`、`KnowledgeEnrichmentModal`（Task 6-8）
- Produces: `gapStats(gaps)`、三档统计单元格、「AI 帮我补充」按钮

- [ ] **Step 1: `gapStats` 纯函数**

```typescript
// apps/web/src/lib/enrich-flow.ts 追加
import type { InformationGap } from '../types';
import type { GapStats } from './enrich-types';

/**
 * 缺口的三档统计。
 *
 * 判据必须和后端 pendingGaps 一致(答案为空,或 sourceStatus 属于
 * unknown/inference/hypothesis),否则按钮上写「6 项」点进去出来 4 条。
 *
 * hypothesis 归到 inferred 而不是单开一档:对用户来说「推断」和「假设」
 * 都是同一件事——没有资料支撑,需要你确认。分成两档只是增加认知负担。
 */
export function gapStats(gaps: InformationGap[]): GapStats {
  let supplied = 0;
  let inferred = 0;
  let unknown = 0;
  for (const gap of gaps) {
    const answered = Boolean(gap.answer?.trim());
    const status = gap.sourceStatus;
    if (!answered || status === 'unknown') unknown += 1;
    else if (status === 'inference' || status === 'hypothesis') inferred += 1;
    else supplied += 1;
  }
  return { total: gaps.length, supplied, inferred, unknown };
}
```

注意 `!answered || status === 'unknown'` 的顺序：答案为空的一律算空白档，
即使它的 `sourceStatus` 写着 `supplied_fact`——没有答案的「已知事实」是数据矛盾，
按更保守的一档计。

- [ ] **Step 2: 组件里拉缺口**

在既有的那个 `useEffect`（`ProjectKnowledgeTab.tsx:38-45` 一带，
和 `api.opportunities.list` 同一处）里加：

```tsx
api.informationGaps.list(project.id)
  .then((r) => { if (!cancelled) setGaps(r.items); })
  .catch(() => { if (!cancelled) setGaps([]); });
```

配套 state：`const [gaps, setGaps] = useState<InformationGap[]>([]);`
以及 `const stats = useMemo(() => gapStats(gaps), [gaps]);`

- [ ] **Step 3: 三档统计单元格**

`V2Instrument` 的 `columns` 是 `2 | 3 | 4`，现在 analyzed 分支已经在
`isStale || isDraft ? 4 : 3` 之间摆动。再加一格会超过 4。做法：把统计放进
既有的「可用选题」旁边，只在有待补充项时替换 `isDraft` 那一格
（`isDraft` 的提示是「不阻塞使用」，优先级低于「资料有缺口」）：

```tsx
{!isStale && pending > 0 && (
  <V2InstrumentCell
    text tone="warn" icon={<Info size={14} />}
    label="资料完整度"
    value={`${stats.supplied}/${stats.total}`}
    note={`${stats.unknown} 项没有资料,${stats.inferred} 项靠推断`}
  />
)}
{!isStale && pending === 0 && isDraft && (
  /* 原来的「待确认」格保持不动 */
)}
```

`columns` 相应改成 `isStale || pending > 0 || isDraft ? 4 : 3`。
落地时以真实渲染为准，别硬凑——这一格挤不进去就放到 `V2Instrument` 下面单独一行。

- [ ] **Step 4: 入口按钮 + 弹窗**

按钮放在底部那个 `.qc-project-row`（「重新分析」旁边），因为补充完就该重新分析，
两个动作挨在一起最合理：

```tsx
{analyzed && pending > 0 && (
  <Button variant="secondary" icon={<Sparkles size={15} />} disabled={busy || analyzing}
    onClick={() => setEnrichOpen(true)}>
    AI 帮我补充({pending} 项)
  </Button>
)}
```

弹窗挂在既有 `preview` Modal 旁边：

```tsx
{project && (
  <KnowledgeEnrichmentModal
    open={enrichOpen}
    projectId={project.id}
    onClose={() => setEnrichOpen(false)}
    onComplete={() => {
      // 补充只改知识文件,不动分析结果,所以刷新文件列表和缺口即可。
      // 「建议重新分析」的提示由 Modal 自己弹,这里不重复。
      void api.knowledge.list(project.id).then((r) => setFiles(r.items)).catch(() => {});
      void api.informationGaps.list(project.id).then((r) => setGaps(r.items)).catch(() => {});
    }}
  />
)}
```

`KnowledgeEnrichmentModal` 的 props 里**没有 `gaps`**（Task 6 定稿的签名是
`open / projectId / onClose / onComplete`）——草稿由后端按项目查，前端不用传。

- [ ] **Step 5: 补测试并运行**

```
// test/enrich-flow.test.ts 追加:
// 1. 空数组 → 全 0
// 2. answer 有值 + supplied_fact → supplied
// 3. answer 有值 + inference / hypothesis → inferred(两者都进同一档)
// 4. answer 为空但 sourceStatus=supplied_fact → 计入 unknown(数据矛盾时取保守档)
// 5. answer 是纯空白 → unknown
// 6. sourceStatus 为 undefined 且有答案 → supplied
// 7. total 恒等于输入长度(supplied+inferred+unknown === total)
```

```bash
cd apps/web
node --import tsx --test test/enrich-flow.test.ts
npm run typecheck && npm run build
```

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/enrich-flow.ts apps/web/src/components/quick/ProjectKnowledgeTab.tsx apps/web/test/enrich-flow.test.ts
git commit -m "feat(web): 知识库页的资料完整度与补充入口

三档统计的判据与后端 pendingGaps 对齐,避免按钮写的条数和实际不符。
入口按钮放在「重新分析」旁边:补充完就该重新分析。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 全量回归

**Files:**
- Modify: `apps/api/package.json` / `apps/web/package.json` —— 确认所有新测试文件都已登记

**为什么这个任务不是「前端组件测试」**：设计稿原本让这一步写
`EnrichmentFlow.test.tsx`，用 vitest + `@testing-library/react` 渲染整个弹窗跑完
流程。这两个依赖 `apps/web` 都没有，而为一个功能引入 vitest + jsdom +
testing-library 是给整个仓库换测试基建，超出本次范围，也不该由这个功能顺手决定。

替代方案已经落在 Task 6/7/9 里：状态机全在 `lib/enrich-flow.ts`，用
`node:test` 逐个覆盖；组件只剩渲染，由 `npm run build`（含 `tsc --noEmit`）
把类型和 import 错误挡住。真实的端到端行为交给 Task 11 手工验证。

**Interfaces:**
- Consumes: 前面所有任务的产物
- Produces: 三个包的绿灯记录

- [ ] **Step 1: 确认测试文件都登记进了脚本**

`apps/api` 和 `apps/web` 的 `test` 脚本都是显式文件列表，漏登记的测试永远不会跑
——这比测试失败更危险，因为看起来是绿的。

```bash
cd /path/to/content-agent
# 列出本次新增的测试文件,逐个确认出现在对应 package.json 里
git diff --name-only main -- '*test*'
grep -o 'test/[a-z0-9.-]*\.test\.ts' apps/api/package.json | sort > /tmp/api-registered.txt
grep -o 'test/[a-z0-9.-]*\.test\.ts' apps/web/package.json | sort > /tmp/web-registered.txt
```

- [ ] **Step 2: 三个包全量**

```bash
cd packages/agent-core && npm test
cd ../../apps/api && npm test && npm run typecheck
cd ../web && npm test && npm run build
```

- [ ] **Step 3: 如实记录结果**

`apps/api` 全量此前存在一批环境相关的既有失败
（`cross-tenant-isolation` / `settings-quota` / `saas-quota` / 迁移测试报
`no such table: knowledge_files`）。判据：`git stash` 后是否同样红。

**不要把既有失败说成通过,也不要把它算到本次改动头上。** 在提交信息或 PR 描述里
写清楚：本次新增的 N 个测试全绿，既有的 M 个失败与本次改动无关（附判据）。

- [ ] **Step 4: 提交**

```bash
git add apps/api/package.json apps/web/package.json
git commit -m "test: 登记知识库补充的测试文件并跑全量回归

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: 端到端手工验证

**Files:** 无新增文件。

**为什么必须手工跑一遍**：这个功能的两个核心环节——模型起草的内容质量、以及
弹窗的交互手感——没有任何自动化测试能覆盖（前端没有渲染测试，模型调用在测试里
是 stub 的）。

**前置条件**：工作区必须配好可用的模型 API Key（平台额度或 BYOK 皆可）。
起草 + 合并是两次真实模型调用，会消耗额度。此前记录过「DeepSeek 账户余额耗尽」
导致 E2E 卡住，先确认余额。

- [ ] **Step 1: 起服务**

```bash
cd apps/api && npm run dev     # 端口见 apps/api 的配置,不要假定 3000
cd apps/web && npm run dev     # vite 默认 5173
```

- [ ] **Step 2: 准备一个真实场景的项目**

不要用「我们是一家眼袋去除机构」这种一句话资料——那样起草出来的全是 low
confidence，看不出功能在真实资料上表现如何。用一份两三千字、有明确服务但缺少
价格/资质/流程细节的资料，最好是**非医美行业**（比如装修、留学、法律咨询），
这样能顺带验证提示词没有过拟合到医美。

上传后点「分析知识库」，等三阶段跑完。

- [ ] **Step 3: 入口**

- 「资料完整度 N/M」显示出来，数字和实际缺口数吻合
- 「AI 帮我补充(K 项)」的 K == 统计里的「没有资料 + 靠推断」之和
- 缺口全都有据时按钮不出现

- [ ] **Step 4: 起草**

- 弹窗打开即进 loading，文案是「AI 正在根据现有资料起草补充内容」
- 30-60 秒后出草稿列表；每条有标题、原问题、正文、依据强弱标签
- **重点看内容**：有没有编造具体数字、人名、地址、资质编号。提示词第 5 条
  明确禁止；真出现了，问题在提示词，记下来别在校验层补正则
- 左侧原文栏能展开看到上传的资料

- [ ] **Step 5: 编辑 / 删除 / 恢复**

- 「修改」→ 文本框可正常输入**多个字符**（`Modal` 的焦点处理曾有过只能输入
  一个字的 bug，见 `Ui.tsx:112` 的注释，这里要专门确认一次）
- 改完保存 → 显示「已修改」
- 把内容改回和原稿一致再保存 → 状态回到未确认（`commitEdit` 的行为）
- 删除 → 变灰显示「已移除」；恢复 → 改过的回到「已修改」
- 全部删除 → 「生成合并版」按钮禁用
- 有未提交编辑时点关闭 → 弹二次确认

- [ ] **Step 6: 合并与保存**

- 「生成合并版」→ loading → 预览
- 预览里**原文的信息一条都没丢**（提示词第 2 条），补充内容位置合理
- 提示语正确区分「新建」和「保存为 xxx 的新版本」
- 「返回修改」能回到编辑态且改动还在
- 「确认保存」→ toast「知识库已更新,建议重新分析」→ 弹窗关闭
- 文件列表出现该文件，版本号 +1；旧版本仍可预览

- [ ] **Step 7: 补充后重新分析**

点「重新分析」，确认补充进去的内容真的进了新一轮分析——这是整个功能的目的。
对比新旧缺口：原先「没有资料」的那几条应该变成有答案。

- [ ] **Step 8: 分析进度条不受干扰**

点「AI 帮我补充」期间，页面上的分析进度条**不应该**开始动
（Task 2 Step 5 的 fingerprint 过滤）。这是最容易回归的一处。

- [ ] **Step 9: 权限**

- 用一个只有 `knowledge.read` 的账号：入口按钮点下去应该 403，且报错可读
- 用另一个工作区的账号直接访问该项目的 enrich 端点：403

- [ ] **Step 10: 如实记录**

把结果写进 `.superpowers/sdd/2026-07-28-knowledge-enrichment/progress.md`：
哪几步通过、哪几步有问题（附复现步骤和实际输出）、模型生成内容的质量观察。

**不要把没验的步骤标成通过。** 额度不足跑不完的，写明卡在哪一步。

---

## 自查清单

### 规格覆盖

- [x] 三档统计（有据 / 推断 / 空白）已实现，判据与后端 `pendingGaps` 一致
- [x] 起草只取待补充缺口，且 `answer` 键缺失的情况没被漏掉
- [x] 用户可逐条确认 / 编辑 / 删除 / 恢复，改动不会被静默丢弃
- [x] 合并自动选 `INDEX.md` 或新建，预览不落库
- [x] 保存走 `knowledge.import`，同名文件版本递增，旧版本保留
- [x] 全程停在知识库区，不自动跳转到创作区

### 与既有代码的一致性

- [x] 校验是 `utils.ts` 风格的手写函数，没有引入 `class-validator`
- [x] 错误用 `BadRequestException` / `AnalysisGatewayError`，没有自造 `ValidationError`
- [x] 模型调用走 `IntelligenceService`，没有绕开 `analysis_tasks` 生命周期
- [x] 前端组件从 `../Ui` 导入，没有引入 vitest / testing-library / react-markdown
- [x] 所有新测试文件都登记进了对应 `package.json` 的 `test` 脚本
      ⚠ 附带问题:登记时整份 package.json 一起 add,卷入了别的会话的 3 行依赖改动。
      已在 PR #61 留言披露,选择保留而非回退(见留言)。

### 安全

- [x] `targetFile` 在入口和 `knowledge.service` 两处都挡了路径穿越
- [x] `gapId` 查询带 `project_id` 条件，不能跨项目取缺口
- [x] `save` 判 `knowledge.import` 权限，与知识库上传同一把锁
- [x] 长度上限：单条、总量、2 MiB（按字节）都有校验

### 表述纪律

- [x] UI 上没有把 AI 推断说成已核实事实
- [x] 没有显示假的 token 消耗数字
- [x] 「依据强弱」的措辞不会诱导用户跳过审查

---

## 执行建议

**顺序**：Task 1 → 11，每个任务完成即提交。Task 1-4 是后端，5-9 是前端，
10-11 是回归与验证。前端的 Task 5 依赖 Task 1 的类型形状，但不依赖后端跑通。

**分支**：从 `main` 切 `feat/knowledge-enrichment`，最后提 PR。不要直接推 `main`。

**动到既有文件的地方**（每一处都要小心，别顺手重构）：
- `apps/api/src/intelligence.service.ts` —— 加 `runEnrichmentModel`，放宽 `completeTask` 签名
- `apps/api/src/intelligence.controller.ts` —— 加 3 个路由和一个注入
- `apps/api/src/app.module.ts` —— 注册 provider
- `apps/web/src/lib/api.ts` —— `intelligence` 块加 `enrich`
- `apps/web/src/types.ts` —— `AnalysisTask` 补 `sourceFingerprint`
- `apps/web/src/components/quick/ProjectKnowledgeTab.tsx` —— 入口 + 任务轮询过滤
- `apps/web/src/styles.css` —— 追加样式
- 两个 `package.json` —— 登记测试文件

**已知的仓库状况**（不是本次要修的）：
- 这个工作区可能有其他会话在并行改文件。提交前 `git status` 看一眼，只 add
  自己这几个文件，不要 `git add .`
- `apps/api` 全量测试有一批环境相关的既有失败，判据是 `git stash` 后是否同样红
