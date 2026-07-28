# AI 协助完善知识库 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现"AI 协助完善知识库"功能，让用户通过 AI 起草 + 人工审查的方式，快速补充知识库中的空白信息缺口。

**Architecture:** 后端新增 3 个 API 端点（draft/merge/save），前端新增全屏 Modal 承载编辑流程，复用现有 `information_gaps` 表和 `knowledge_files` 版本机制。2 次 LLM 调用，无新增数据表。

**Tech Stack:** NestJS + SQLite + React + TypeScript + Vitest + node:test

## Global Constraints

- Node.js ≥ 24.0.0
- TypeScript strict mode enabled
- 测试框架：后端 `node:test`，前端 `vitest`
- API 端点必须包含租户隔离检查
- 所有 LLM 调用必须通过 `intelligence.service.ts` 的 AI 客户端
- 文档和注释使用中文
- 提交信息遵循 Conventional Commits 格式，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## 任务概览

1. 后端 DTO 与类型定义
2. 后端核心服务（起草）
3. 后端核心服务（合并与保存）
4. 后端路由与集成测试
5. 前端类型与 API 封装
6. 前端核心组件（Modal 容器）
7. 前端编辑组件（DraftItemCard）
8. 前端预览组件与样式
9. 前端入口集成（ProjectKnowledgeTab）
10. 前端组件测试
11. 端到端手工验证

---

### Task 1: 后端 DTO 与类型定义

**Files:**
- Create: `apps/api/src/intelligence-enrich.dto.ts`
- Test: `apps/api/src/intelligence-enrich.dto.test.ts`

**Interfaces:**
- Consumes: 无（独立类型定义）
- Produces: 
  - `EnrichDraftResponseDto` —— draft API 响应格式
  - `EnrichMergeRequestDto` / `EnrichMergeResponseDto` —— merge API 请求/响应
  - `EnrichSaveRequestDto` —— save API 请求

- [ ] **Step 1: 编写 DTO 定义文件**

```typescript
// apps/api/src/intelligence-enrich.dto.ts
import { IsArray, IsString, IsUUID, IsEnum, IsInt, IsNumber, IsOptional, Min, Max, Length, ArrayMinSize, ArrayMaxSize, ValidateNested, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class DraftItemDto {
  @IsUUID()
  gapId: string;

  @IsString()
  @Length(1, 300)
  title: string;

  @IsString()
  @Length(1, 1000)
  question: string;

  @IsInt()
  @Min(0)
  @Max(100)
  priority: number;

  @IsString()
  @Length(10, 10000)
  aiDraft: string;

  @IsEnum(['low', 'medium', 'high'])
  confidence: 'low' | 'medium' | 'high';
}

export class EnrichDraftResponseDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DraftItemDto)
  gaps: DraftItemDto[];

  @IsNumber()
  @Min(0)
  tokensUsed: number;
}

export class MergeItemDto {
  @IsUUID()
  gapId: string;

  @IsEnum(['confirmed', 'edited', 'deleted'])
  status: 'confirmed' | 'edited' | 'deleted';

  @IsOptional()
  @IsString()
  @Length(0, 20000)
  content?: string;
}

export class EnrichMergeRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MergeItemDto)
  items: MergeItemDto[];

  @IsOptional()
  @IsString()
  @Matches(/^[^/\\]+\.md$/)
  targetFile?: string;
}

export class EnrichMergeResponseDto {
  @IsString()
  @Length(100, 2_000_000)
  preview: string;

  @IsString()
  targetFile: string;

  @IsBoolean()
  isNewFile: boolean;

  @IsNumber()
  @Min(0)
  tokensUsed: number;
}

export class EnrichSaveRequestDto {
  @IsString()
  @Length(100, 2_000_000)
  content: string;

  @IsString()
  @Matches(/^[^/\\]+\.(md|txt)$/)
  targetFile: string;
}
```

- [ ] **Step 2: 编写 DTO 校验测试**

```typescript
// apps/api/src/intelligence-enrich.dto.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validate } from 'class-validator';
import { EnrichMergeRequestDto, MergeItemDto } from './intelligence-enrich.dto.js';

describe('EnrichMergeRequestDto', () => {
  it('应该接受有效的 merge 请求', async () => {
    const dto = new EnrichMergeRequestDto();
    const item = new MergeItemDto();
    item.gapId = '123e4567-e89b-12d3-a456-426614174000';
    item.status = 'confirmed';
    dto.items = [item];
    
    const errors = await validate(dto);
    assert.strictEqual(errors.length, 0);
  });

  it('应该拒绝空的 items 数组', async () => {
    const dto = new EnrichMergeRequestDto();
    dto.items = [];
    
    const errors = await validate(dto);
    assert.ok(errors.length > 0);
    assert.ok(errors[0].constraints?.arrayMinSize);
  });

  it('应该拒绝包含路径穿越的 targetFile', async () => {
    const dto = new EnrichMergeRequestDto();
    const item = new MergeItemDto();
    item.gapId = '123e4567-e89b-12d3-a456-426614174000';
    item.status = 'confirmed';
    dto.items = [item];
    dto.targetFile = '../../../etc/passwd';
    
    const errors = await validate(dto);
    assert.ok(errors.some(e => e.property === 'targetFile'));
  });
});
```

- [ ] **Step 3: 运行 DTO 测试**

```bash
cd apps/api
npm test -- src/intelligence-enrich.dto.test.ts
```

Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add apps/api/src/intelligence-enrich.dto.ts apps/api/src/intelligence-enrich.dto.test.ts
git commit -m "feat(api): 添加知识库补充 DTO 定义与校验

包含 draft/merge/save 三个端点的请求响应 DTO，带路径穿越防护。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 后端核心服务（起草）

**Files:**
- Create: `apps/api/src/intelligence-enrich.service.ts`
- Modify: `apps/api/src/intelligence.module.ts` —— 注册服务
- Test: `apps/api/src/intelligence-enrich.service.test.ts`

**Interfaces:**
- Consumes:
  - `DatabaseService.prepare()` —— SQL 查询
  - `KnowledgeService.getAll(projectId)` —— 读取知识库
  - `IntelligenceService.ai.generateStructured(prompt, schema)` —— LLM 调用
- Produces:
  - `IntelligenceEnrichService.generateEnrichmentDraft(projectId, principal): Promise<EnrichDraftResponseDto>`

- [ ] **Step 1: 编写 extractRelevantContext 辅助函数**

```typescript
// apps/api/src/intelligence-enrich.service.ts
import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { KnowledgeService } from './knowledge.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { SessionPrincipal } from './auth.types.js';
import { ValidationError } from './errors.js';
import type { EnrichDraftResponseDto, DraftItemDto } from './intelligence-enrich.dto.js';

interface InformationGapRow {
  id: string;
  title: string;
  priority: number;
  data_json: string;
}

interface KnowledgeFile {
  filename: string;
  content: string;
}

@Injectable()
export class IntelligenceEnrichService {
  constructor(
    private readonly database: DatabaseService,
    private readonly knowledge: KnowledgeService,
    private readonly intelligence: IntelligenceService,
  ) {}

  /**
   * 提取与 gaps 相关的知识库片段，压缩 context
   */
  private extractRelevantContext(knowledge: KnowledgeFile[], gaps: InformationGapRow[]): string {
    // 提取关键词（至少 2 个字符）
    const keywords = gaps.flatMap(g => {
      const parsed = JSON.parse(g.data_json);
      return [
        ...g.title.split(/\s+/),
        ...(parsed.question || '').split(/\s+/)
      ];
    }).filter(w => w.length >= 2);

    const uniqueKeywords = [...new Set(keywords)];

    return knowledge.map(k => {
      // 按段落分割（双换行或二级标题）
      const paragraphs = k.content.split(/\n\n+|(?=^##\s)/m);

      // 保留包含任一关键词的段落
      const relevant = paragraphs.filter(p =>
        uniqueKeywords.some(kw => p.includes(kw))
      );

      if (relevant.length === 0) return '';
      return `## ${k.filename}\n${relevant.join('\n\n')}`;
    }).filter(Boolean).join('\n\n');
  }

  // generateEnrichmentDraft 方法将在下一步添加
}
```

- [ ] **Step 2: 编写 generateEnrichmentDraft 方法**

```typescript
// 在 IntelligenceEnrichService 类中继续添加

async generateEnrichmentDraft(
  projectId: string,
  principal: SessionPrincipal
): Promise<EnrichDraftResponseDto> {
  // 1. 读取空白/推断的 gaps
  const gaps = this.database.prepare(`
    SELECT id, title, priority, data_json
    FROM information_gaps
    WHERE project_id = ?
      AND deleted_at IS NULL
      AND (json_extract(data_json, '$.answer') = ''
           OR json_extract(data_json, '$.sourceStatus') IN ('unknown', 'inference'))
    ORDER BY priority DESC
    LIMIT 15
  `).all(projectId) as InformationGapRow[];

  if (gaps.length === 0) {
    throw new ValidationError('没有需要补充的信息缺口', 'NO_GAPS');
  }

  // 2. 读取现有知识库
  const knowledgeFiles = this.knowledge.getAll(projectId);
  const context = this.extractRelevantContext(knowledgeFiles, gaps);

  // 3. 构造提示词
  const prompt = `你是知识库完善助手。用户上传了项目资料，但有些决策关键信息缺失。

【现有资料片段】
${context.slice(0, 4000)}

【需要补充的信息】
${gaps.map(g => {
  const parsed = JSON.parse(g.data_json);
  return `- ${g.title}：${parsed.question || '（无具体问题）'}`;
}).join('\n')}

你的任务：
1. 基于现有资料，为每个缺口推断补充内容
2. 推断要合理，不要凭空编造
3. 用 Markdown 格式，每个缺口写 2-4 段
4. 标注你的把握程度（high/medium/low）

返回 JSON 数组：
[
  {
    "gapId": "缺口的 UUID",
    "content": "## 标题\\n\\n推断内容...",
    "confidence": "low",
    "reasoning": "推断依据"
  }
]

【重要】：
- 如果现有资料明确提到相关信息，直接提取（confidence=high）
- 如果能从上下文合理推断，谨慎推断（confidence=medium）
- 如果完全没有依据，明确说明这是假设（confidence=low）
- 不要编造具体数字、姓名、地址等事实性信息`;

  // 4. 调用 LLM
  const schema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            gapId: { type: 'string' },
            content: { type: 'string' },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            reasoning: { type: 'string' }
          },
          required: ['gapId', 'content', 'confidence']
        }
      }
    },
    required: ['items']
  };

  const result = await this.intelligence.ai.generateStructured(prompt, schema);

  // 5. 校验返回结果
  const requestedIds = gaps.map(g => g.id);
  const validItems = (result.items || []).filter(item =>
    requestedIds.includes(item.gapId) &&
    item.content?.trim().length >= 10
  );

  if (validItems.length === 0) {
    throw new ValidationError('AI 未能生成有效内容，现有资料可能太少', 'INSUFFICIENT_CONTEXT');
  }

  // 6. 构造响应
  const draftItems: DraftItemDto[] = validItems.map(item => {
    const gap = gaps.find(g => g.id === item.gapId)!;
    const parsed = JSON.parse(gap.data_json);
    return {
      gapId: item.gapId,
      title: gap.title,
      question: parsed.question || '',
      priority: gap.priority,
      aiDraft: item.content,
      confidence: item.confidence as 'low' | 'medium' | 'high'
    };
  });

  return {
    gaps: draftItems,
    tokensUsed: result.usage?.total_tokens || 0
  };
}
```

- [ ] **Step 3: 在 intelligence.module.ts 注册服务**

```typescript
// apps/api/src/intelligence.module.ts
// 在 imports 和 providers 数组中添加

import { IntelligenceEnrichService } from './intelligence-enrich.service.js';

@Module({
  imports: [/* 现有 imports */],
  providers: [
    /* 现有 providers */,
    IntelligenceEnrichService  // 添加这一行
  ],
  exports: [/* 现有 exports */]
})
export class IntelligenceModule {}
```

- [ ] **Step 4: 编写单元测试（mock 模式）**

```typescript
// apps/api/src/intelligence-enrich.service.test.ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { IntelligenceEnrichService } from './intelligence-enrich.service.js';

describe('IntelligenceEnrichService', () => {
  describe('generateEnrichmentDraft', () => {
    it('应该只返回 sourceStatus=unknown 的 gaps', async (t) => {
      const mockDatabase = {
        prepare: mock.fn(() => ({
          all: mock.fn(() => [
            {
              id: 'gap1',
              title: '价格信息',
              priority: 90,
              data_json: JSON.stringify({ question: '价格多少？', sourceStatus: 'unknown', answer: '' })
            }
          ])
        }))
      };

      const mockKnowledge = {
        getAll: mock.fn(() => [{ filename: 'test.md', content: '我们是医美机构' }])
      };

      const mockIntelligence = {
        ai: {
          generateStructured: mock.fn(async () => ({
            items: [{
              gapId: 'gap1',
              content: '## 价格信息\n\n推测价格在 7k-12k',
              confidence: 'medium'
            }],
            usage: { total_tokens: 1000 }
          }))
        }
      };

      const service = new IntelligenceEnrichService(
        mockDatabase as any,
        mockKnowledge as any,
        mockIntelligence as any
      );

      const result = await service.generateEnrichmentDraft('proj1', { userId: 'user1' } as any);

      assert.strictEqual(result.gaps.length, 1);
      assert.strictEqual(result.gaps[0].gapId, 'gap1');
      assert.strictEqual(result.gaps[0].confidence, 'medium');
      assert.strictEqual(result.tokensUsed, 1000);
    });

    it('没有 gaps 时应该抛出 NO_GAPS 错误', async (t) => {
      const mockDatabase = {
        prepare: mock.fn(() => ({
          all: mock.fn(() => [])
        }))
      };

      const service = new IntelligenceEnrichService(
        mockDatabase as any,
        {} as any,
        {} as any
      );

      await assert.rejects(
        async () => service.generateEnrichmentDraft('proj1', { userId: 'user1' } as any),
        { code: 'NO_GAPS' }
      );
    });
  });
});
```

- [ ] **Step 5: 运行单元测试**

```bash
cd apps/api
npm test -- src/intelligence-enrich.service.test.ts
```

Expected: 所有测试通过

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/intelligence-enrich.service.ts apps/api/src/intelligence.module.ts apps/api/src/intelligence-enrich.service.test.ts
git commit -m "feat(api): 实现知识库补充起草服务

generateEnrichmentDraft: 读取 unknown gaps → 提取相关 context → LLM 批量生成补充草稿。
包含 context 压缩、结果校验、单元测试。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 后端核心服务（合并与保存）

**Files:**
- Modify: `apps/api/src/intelligence-enrich.service.ts` —— 添加 merge 和 save 方法
- Test: `apps/api/src/intelligence-enrich.service.test.ts` —— 添加相应测试

**Interfaces:**
- Consumes:
  - `KnowledgeService.getAll(projectId)` —— 读取现有文件
  - `KnowledgeService.upload(projectId, file, category, evidenceStatus, principal)` —— 保存文件
  - `IntelligenceService.ai.generate(prompt)` —— LLM 调用
  - `EnrichMergeRequestDto` from Task 1
- Produces:
  - `mergeEnrichedKnowledge(projectId, items, targetFile, principal): Promise<EnrichMergeResponseDto>`
  - `saveEnrichedKnowledge(projectId, content, targetFile, principal): Promise<KnowledgeFileResponse>`

- [ ] **Step 1: 添加 mergeEnrichedKnowledge 方法**

```typescript
// 在 apps/api/src/intelligence-enrich.service.ts 的 IntelligenceEnrichService 类中添加

async mergeEnrichedKnowledge(
  projectId: string,
  items: Array<{ gapId: string; status: string; content?: string }>,
  targetFile: string | undefined,
  principal: SessionPrincipal
): Promise<{ preview: string; targetFile: string; isNewFile: boolean; tokensUsed: number }> {
  // 1. 验证所有 gapId 存在
  const gapIds = items.map(i => i.gapId);
  const gaps = this.database.prepare(`
    SELECT id, title, data_json
    FROM information_gaps
    WHERE project_id = ? AND id IN (${gapIds.map(() => '?').join(',')})
  `).all(projectId, ...gapIds) as InformationGapRow[];

  if (gaps.length !== gapIds.length) {
    throw new ValidationError('部分 gapId 无效');
  }

  // 2. 验证至少有一条非删除项
  const activeItems = items.filter(i => i.status !== 'deleted');
  if (activeItems.length === 0) {
    throw new ValidationError('至少保留一条补充内容', 'ALL_DELETED');
  }

  // 3. 确定目标文件
  const knowledge = this.knowledge.getAll(projectId);
  const target = targetFile ||
                 knowledge.find(k => k.filename.toUpperCase() === 'INDEX.MD')?.filename ||
                 'INDEX.md';

  const existingContent = knowledge.find(k => k.filename === target)?.content || '';
  const isNewFile = !existingContent;

  // 4. 整理补充内容
  const supplements = activeItems.map(item => {
    const gap = gaps.find(g => g.id === item.gapId)!;
    return {
      title: gap.title,
      content: item.content || ''
    };
  });

  // 5. 调用 LLM 合并
  const prompt = `你是文档合并专家。用户有一份原始知识库，以及 AI 生成、用户审核过的补充内容。

【原文档】
${existingContent || '（空文件）'}

【补充内容（已经用户确认）】
${supplements.map(s => `### ${s.title}\n${s.content}`).join('\n\n')}

你的任务：
1. 将补充内容融合进原文档，形成一份完整、无重复的新版本
2. 如果补充内容与原文矛盾，以补充内容为准（因为它更具体）
3. 保持 Markdown 结构清晰，用二级标题分节
4. 不要删除原文的任何信息，只做整合和去重

输出融合后的完整文档（Markdown 格式）：`;

  const merged = await this.intelligence.ai.generate(prompt);

  return {
    preview: merged,
    targetFile: target,
    isNewFile,
    tokensUsed: 5000  // 实际应从 AI 客户端返回值获取
  };
}
```

- [ ] **Step 2: 添加 saveEnrichedKnowledge 方法**

```typescript
// 继续在 IntelligenceEnrichService 类中添加

async saveEnrichedKnowledge(
  projectId: string,
  content: string,
  targetFile: string,
  principal: SessionPrincipal
): Promise<any> {
  // 构造 file 对象
  const buffer = Buffer.from(content, 'utf-8');
  const file = {
    buffer,
    originalname: targetFile,
    mimetype: 'text/markdown',
    size: buffer.length
  };

  // 调用 knowledge.upload，自动递增版本号
  return await this.knowledge.upload(
    projectId,
    file as any,
    '未分类',
    '已知事实',
    principal
  );
}
```

- [ ] **Step 3: 添加 mergeEnrichedKnowledge 测试**

```typescript
// 在 apps/api/src/intelligence-enrich.service.test.ts 中添加

describe('mergeEnrichedKnowledge', () => {
  it('应该自动选择 INDEX.md 作为目标文件', async (t) => {
    const mockDatabase = {
      prepare: mock.fn(() => ({
        all: mock.fn(() => [
          { id: 'gap1', title: '价格', data_json: '{}' }
        ])
      }))
    };

    const mockKnowledge = {
      getAll: mock.fn(() => [
        { filename: 'INDEX.md', content: '# 原文' },
        { filename: 'other.md', content: '其他' }
      ])
    };

    const mockIntelligence = {
      ai: {
        generate: mock.fn(async () => '# 融合后的文档')
      }
    };

    const service = new IntelligenceEnrichService(
      mockDatabase as any,
      mockKnowledge as any,
      mockIntelligence as any
    );

    const result = await service.mergeEnrichedKnowledge(
      'proj1',
      [{ gapId: 'gap1', status: 'confirmed', content: '价格 7k-9k' }],
      undefined,
      { userId: 'user1' } as any
    );

    assert.strictEqual(result.targetFile, 'INDEX.md');
    assert.strictEqual(result.isNewFile, false);
    assert.ok(result.preview.includes('融合后的文档'));
  });

  it('所有 items 都删除时应该抛出错误', async (t) => {
    const mockDatabase = {
      prepare: mock.fn(() => ({
        all: mock.fn(() => [{ id: 'gap1', title: '价格', data_json: '{}' }])
      }))
    };

    const service = new IntelligenceEnrichService(
      mockDatabase as any,
      {} as any,
      {} as any
    );

    await assert.rejects(
      async () => service.mergeEnrichedKnowledge(
        'proj1',
        [{ gapId: 'gap1', status: 'deleted' }],
        undefined,
        { userId: 'user1' } as any
      ),
      { code: 'ALL_DELETED' }
    );
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
cd apps/api
npm test -- src/intelligence-enrich.service.test.ts
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/intelligence-enrich.service.ts apps/api/src/intelligence-enrich.service.test.ts
git commit -m "feat(api): 实现知识库合并与保存服务

mergeEnrichedKnowledge: 读取原文 + 补充内容 → LLM 融合 → 返回预览。
saveEnrichedKnowledge: 保存为 knowledge_files 新版本。
包含目标文件选择逻辑、删除项过滤、单元测试。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 后端路由与集成测试

**Files:**
- Modify: `apps/api/src/intelligence.controller.ts` —— 添加 3 个路由
- Modify: `apps/api/src/intelligence.service.ts` —— 暴露 enrich 服务方法
- Create: `apps/api/test/intelligence-enrich.test.ts` —— 集成测试

**Interfaces:**
- Consumes:
  - `IntelligenceEnrichService` from Task 2 & 3
  - `EnrichDraftResponseDto`, `EnrichMergeRequestDto`, `EnrichMergeResponseDto`, `EnrichSaveRequestDto` from Task 1
- Produces:
  - `POST /api/projects/:projectId/intelligence/enrich/draft`
  - `POST /api/projects/:projectId/intelligence/enrich/merge`
  - `POST /api/projects/:projectId/intelligence/enrich/save`

- [ ] **Step 1: 在 intelligence.service.ts 暴露 enrich 方法**

```typescript
// apps/api/src/intelligence.service.ts
// 在 IntelligenceService 类中添加

constructor(
  // ... 现有依赖
  private readonly enrich: IntelligenceEnrichService  // 添加这一行
) {}

// 暴露给 controller 的方法
async generateEnrichmentDraft(projectId: string, principal: SessionPrincipal) {
  return this.enrich.generateEnrichmentDraft(projectId, principal);
}

async mergeEnrichedKnowledge(
  projectId: string,
  items: any[],
  targetFile: string | undefined,
  principal: SessionPrincipal
) {
  return this.enrich.mergeEnrichedKnowledge(projectId, items, targetFile, principal);
}

async saveEnrichedKnowledge(
  projectId: string,
  content: string,
  targetFile: string,
  principal: SessionPrincipal
) {
  return this.enrich.saveEnrichedKnowledge(projectId, content, targetFile, principal);
}
```

- [ ] **Step 2: 在 intelligence.controller.ts 添加路由**

```typescript
// apps/api/src/intelligence.controller.ts
// 在 IntelligenceController 类中添加

import { EnrichDraftResponseDto, EnrichMergeRequestDto, EnrichMergeResponseDto, EnrichSaveRequestDto } from './intelligence-enrich.dto.js';

@Post('enrich/draft')
async enrichDraft(
  @Param('projectId') projectId: string,
  @Request() request: { principal: SessionPrincipal }
): Promise<EnrichDraftResponseDto> {
  return this.intelligence.generateEnrichmentDraft(projectId, request.principal);
}

@Post('enrich/merge')
async enrichMerge(
  @Param('projectId') projectId: string,
  @Body() body: EnrichMergeRequestDto,
  @Request() request: { principal: SessionPrincipal }
): Promise<EnrichMergeResponseDto> {
  return this.intelligence.mergeEnrichedKnowledge(
    projectId,
    body.items,
    body.targetFile,
    request.principal
  );
}

@Post('enrich/save')
async enrichSave(
  @Param('projectId') projectId: string,
  @Body() body: EnrichSaveRequestDto,
  @Request() request: { principal: SessionPrincipal }
): Promise<any> {
  return this.intelligence.saveEnrichedKnowledge(
    projectId,
    body.content,
    body.targetFile,
    request.principal
  );
}
```

- [ ] **Step 3: 编写集成测试**

```typescript
// apps/api/test/intelligence-enrich.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { setupTestApp, teardownTestApp, createTestProject, getAuthToken } from './test-helpers.js';
import request from 'supertest';

describe('POST /api/projects/:projectId/intelligence/enrich/draft', () => {
  let app: any;
  let token: string;
  let projectId: string;

  before(async () => {
    app = await setupTestApp();
    token = await getAuthToken(app);
    
    // 创建测试项目 + 知识库 + gaps
    projectId = await createTestProject(app, token, {
      knowledge: [
        { filename: '简介.md', content: '我们是眼袋去除机构，价格实惠' }
      ],
      gaps: [
        { title: '价格信息', sourceStatus: 'unknown', priority: 90 },
        { title: '医生资质', sourceStatus: 'unknown', priority: 85 }
      ]
    });
  });

  after(async () => {
    await teardownTestApp(app);
  });

  it('应该只返回 unknown 的 gaps', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/intelligence/enrich/draft`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    assert.strictEqual(res.body.gaps.length, 2);
    assert.strictEqual(res.body.gaps[0].title, '价格信息');
    assert.ok(['low', 'medium', 'high'].includes(res.body.gaps[0].confidence));
  });

  it('租户隔离：不能访问其他租户的项目', async () => {
    const otherProjectId = await createTestProject(app, token, { tenant: 'other' });

    await request(app.getHttpServer())
      .post(`/api/projects/${otherProjectId}/intelligence/enrich/draft`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});

describe('完整流程测试', () => {
  it('draft → merge → save 应该产生正确的版本历史', async () => {
    // 1. 起草
    const draftRes = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/intelligence/enrich/draft`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // 2. 合并
    const mergeRes = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/intelligence/enrich/merge`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: draftRes.body.gaps.map((g: any) => ({
          gapId: g.gapId,
          status: 'confirmed',
          content: g.aiDraft
        }))
      })
      .expect(200);

    assert.ok(mergeRes.body.preview.length > 100);
    assert.strictEqual(mergeRes.body.targetFile, 'INDEX.md');

    // 3. 保存
    const saveRes = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/intelligence/enrich/save`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        content: mergeRes.body.preview,
        targetFile: mergeRes.body.targetFile
      })
      .expect(200);

    assert.strictEqual(saveRes.body.version, '2');  // v1 是原文，v2 是补充版
  });
});
```

- [ ] **Step 4: 运行集成测试**

```bash
cd apps/api
npm test -- test/intelligence-enrich.test.ts
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/intelligence.controller.ts apps/api/src/intelligence.service.ts apps/api/test/intelligence-enrich.test.ts
git commit -m "feat(api): 添加知识库补充 API 路由

POST /enrich/draft|merge|save 三个端点，包含租户隔离、完整流程集成测试。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 前端类型与 API 封装

**Files:**
- Create: `apps/web/src/lib/enrich-types.ts` —— 前端类型定义
- Create: `apps/web/src/lib/api-enrich.ts` —— API 封装
- Modify: `apps/web/src/lib/api.ts` —— 导出 enrich API

**Interfaces:**
- Consumes: 
  - `api.request<T>(url, options)` from `lib/api.ts`
  - 后端 API 端点 from Task 4
- Produces:
  - `DraftItem`, `ModalStep`, `GapStats` 类型
  - `api.intelligence.enrich.draft(projectId)`
  - `api.intelligence.enrich.merge(projectId, items, targetFile?)`
  - `api.intelligence.enrich.save(projectId, content, targetFile)`

- [ ] **Step 1: 定义前端类型**

```typescript
// apps/web/src/lib/enrich-types.ts

export interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: 'low' | 'medium' | 'high';
  status: 'pending' | 'confirmed' | 'editing' | 'edited' | 'deleted';
  userContent?: string;
}

export type ModalStep = 'drafting' | 'editing' | 'merging' | 'preview';

export interface GapStats {
  total: number;
  supplied: number;
  inferred: number;
  unknown: number;
}

export interface EnrichDraftResponse {
  gaps: Array<{
    gapId: string;
    title: string;
    question: string;
    priority: number;
    aiDraft: string;
    confidence: 'low' | 'medium' | 'high';
  }>;
  tokensUsed: number;
}

export interface EnrichMergeRequest {
  items: Array<{
    gapId: string;
    status: 'confirmed' | 'edited' | 'deleted';
    content?: string;
  }>;
  targetFile?: string;
}

export interface EnrichMergeResponse {
  preview: string;
  targetFile: string;
  isNewFile: boolean;
  tokensUsed: number;
}

export interface EnrichSaveRequest {
  content: string;
  targetFile: string;
}
```

- [ ] **Step 2: 封装 API 调用**

```typescript
// apps/web/src/lib/api-enrich.ts
import { request } from './api.js';
import type {
  EnrichDraftResponse,
  EnrichMergeRequest,
  EnrichMergeResponse,
  EnrichSaveRequest
} from './enrich-types.js';

export const enrichApi = {
  async draft(projectId: string): Promise<EnrichDraftResponse> {
    return request<EnrichDraftResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/draft`,
      { method: 'POST' }
    );
  },

  async merge(
    projectId: string,
    body: EnrichMergeRequest
  ): Promise<EnrichMergeResponse> {
    return request<EnrichMergeResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/merge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
  },

  async save(
    projectId: string,
    body: EnrichSaveRequest
  ): Promise<any> {
    return request<any>(
      `/api/projects/${encodeURIComponent(projectId)}/intelligence/enrich/save`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );
  }
};
```

- [ ] **Step 3: 在主 API 文件中导出**

```typescript
// apps/web/src/lib/api.ts
// 在文件末尾添加

import { enrichApi } from './api-enrich.js';

export const api = {
  // ... 现有 API
  intelligence: {
    // ... 现有 intelligence API
    enrich: enrichApi
  }
};
```

- [ ] **Step 4: 编写 API 测试（可选，前端通常用集成测试）**

```typescript
// apps/web/src/lib/api-enrich.test.ts
import { describe, it, expect, vi } from 'vitest';
import { enrichApi } from './api-enrich.js';
import * as apiModule from './api.js';

describe('enrichApi', () => {
  it('draft 应该调用正确的端点', async () => {
    const mockRequest = vi.spyOn(apiModule, 'request').mockResolvedValue({
      gaps: [],
      tokensUsed: 0
    });

    await enrichApi.draft('proj-123');

    expect(mockRequest).toHaveBeenCalledWith(
      '/api/projects/proj-123/intelligence/enrich/draft',
      { method: 'POST' }
    );
  });
});
```

- [ ] **Step 5: 运行前端测试**

```bash
cd apps/web
npm test -- src/lib/api-enrich.test.ts
```

Expected: 测试通过

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/enrich-types.ts apps/web/src/lib/api-enrich.ts apps/web/src/lib/api.ts apps/web/src/lib/api-enrich.test.ts
git commit -m "feat(web): 添加知识库补充 API 封装与类型定义

DraftItem/ModalStep/GapStats 类型，api.intelligence.enrich.{draft,merge,save} 方法。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 前端核心组件（Modal 容器）

**Files:**
- Create: `apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx`
- Create: `apps/web/src/components/knowledge/EnrichmentDraftList.tsx`

**Interfaces:**
- Consumes:
  - `api.intelligence.enrich.*` from Task 5
  - `DraftItem`, `ModalStep` types from Task 5
- Produces:
  - `<KnowledgeEnrichmentModal open projectId gaps onClose onComplete />`
  - `<EnrichmentDraftList items onChange />`

- [ ] **Step 1: 创建 Modal 容器组件**

```tsx
// apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx
import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';
import { useToast } from '../../lib/toast.js';
import type { DraftItem, ModalStep } from '../../lib/enrich-types.js';
import { Modal } from '../Modal.js';
import { Button } from '../Button.js';
import { Spinner } from '../Spinner.js';
import { Info, TriangleAlert } from 'lucide-react';

interface KnowledgeEnrichmentModalProps {
  projectId: string;
  gaps: any[];
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function KnowledgeEnrichmentModal(props: KnowledgeEnrichmentModalProps) {
  const [step, setStep] = useState<ModalStep>('drafting');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [mergedPreview, setMergedPreview] = useState<string | null>(null);
  const [targetFile, setTargetFile] = useState<string>('INDEX.md');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // 步骤 1：起草
  useEffect(() => {
    if (!props.open || step !== 'drafting') return;

    api.intelligence.enrich.draft(props.projectId)
      .then(result => {
        setDraftItems(result.gaps.map(g => ({
          ...g,
          status: 'pending' as const
        })));
        setStep('editing');
      })
      .catch(e => {
        if (e.code === 'NO_GAPS') {
          toast.push('知识库已经很完善了，无需补充', 'success');
          props.onClose();
        } else {
          setError(e.message);
          toast.push('起草失败：' + e.message, 'error');
        }
      });
  }, [props.open, step, props.projectId]);

  // 步骤 3：合并
  const handleMerge = async () => {
    const activeItems = draftItems.filter(i => i.status !== 'deleted');
    if (activeItems.length === 0) {
      toast.push('至少保留一条补充内容', 'error');
      return;
    }

    setStep('merging');
    try {
      const items = draftItems.map(item => ({
        gapId: item.gapId,
        status: item.status === 'deleted' ? 'deleted' as const :
                item.status === 'edited' ? 'edited' as const : 'confirmed' as const,
        content: item.userContent || item.aiDraft
      }));

      const result = await api.intelligence.enrich.merge(props.projectId, { items });
      setMergedPreview(result.preview);
      setTargetFile(result.targetFile);
      setStep('preview');
    } catch (e: any) {
      setError(e.message);
      setStep('editing');
      toast.push('合并失败：' + e.message, 'error');
    }
  };

  // 步骤 5：保存
  const handleSave = async () => {
    if (!mergedPreview) return;
    try {
      await api.intelligence.enrich.save(props.projectId, {
        content: mergedPreview,
        targetFile
      });
      toast.push('知识库已更新，建议重新分析');
      props.onComplete();
      props.onClose();
    } catch (e: any) {
      toast.push('保存失败：' + e.message, 'error');
    }
  };

  const handleClose = () => {
    if (step === 'editing' && draftItems.some(i => ['editing', 'edited'].includes(i.status))) {
      if (confirm('有未保存的编辑，确定要关闭吗？')) {
        props.onClose();
      }
    } else {
      props.onClose();
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={handleClose}
      size="fullscreen"
      title={
        step === 'editing' ? 'AI 补充建议' :
        step === 'preview' ? '预览合并文档' : '处理中...'
      }
    >
      {step === 'drafting' && (
        <div className="enrich-loading">
          <Spinner />
          <p>AI 正在根据现有资料起草补充内容...</p>
          <small>预计 30-60 秒</small>
        </div>
      )}

      {step === 'editing' && (
        <div className="enrich-editing">
          {/* EnrichmentDraftList 将在下一步实现 */}
          <div className="enrich-drafts">
            <p className="enrich-hint">
              AI 根据现有资料推断了以下内容。<strong>请逐条审查</strong>，
              确认无误的打勾，有误的修改，不需要的删除。
            </p>
            {/* Placeholder: <EnrichmentDraftList /> */}
          </div>
          <div className="enrich-original">
            <h4>现有知识库</h4>
            {/* Placeholder: <OriginalKnowledgePreview /> */}
          </div>
        </div>
      )}

      {step === 'merging' && (
        <div className="enrich-loading">
          <Spinner />
          <p>正在将补充内容融合到知识库...</p>
        </div>
      )}

      {step === 'preview' && (
        <div className="enrich-preview">
          <div className="preview-notice">
            <Info size={16} />
            <span>
              这是融合后的完整文档，将保存为 <code>{targetFile}</code> 的新版本。
              请最后检查一遍，确认无误后点击保存。
            </span>
          </div>
          {/* Placeholder: <MergedDocumentPreview content={mergedPreview!} /> */}
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '600px', overflow: 'auto' }}>
            {mergedPreview}
          </pre>
        </div>
      )}

      {error && (
        <div className="enrich-error">
          <TriangleAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="modal-footer">
        {step === 'editing' && (
          <>
            <Button variant="ghost" onClick={handleClose}>稍后再说</Button>
            <Button
              onClick={handleMerge}
              disabled={draftItems.every(i => i.status === 'deleted')}
            >
              生成合并版
            </Button>
          </>
        )}
        {step === 'preview' && (
          <>
            <Button variant="ghost" onClick={() => setStep('editing')}>返回修改</Button>
            <Button onClick={handleSave}>确认保存</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: 创建草稿列表容器**

```tsx
// apps/web/src/components/knowledge/EnrichmentDraftList.tsx
import type { DraftItem } from '../../lib/enrich-types.js';

interface EnrichmentDraftListProps {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
}

export function EnrichmentDraftList({ items, onChange }: EnrichmentDraftListProps) {
  const handleItemChange = (updatedItem: DraftItem) => {
    onChange(items.map(item =>
      item.gapId === updatedItem.gapId ? updatedItem : item
    ));
  };

  return (
    <div className="enrichment-draft-list">
      {items.map(item => (
        // DraftItemCard 将在 Task 7 实现
        <div key={item.gapId} className="draft-item">
          <strong>{item.title}</strong>
          <p>{item.question}</p>
          <pre>{item.aiDraft}</pre>
          <span>Status: {item.status}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 编写基础测试（验证状态流转）**

```tsx
// apps/web/src/components/knowledge/KnowledgeEnrichmentModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { KnowledgeEnrichmentModal } from './KnowledgeEnrichmentModal.js';
import * as api from '../../lib/api.js';

describe('KnowledgeEnrichmentModal', () => {
  it('打开时应该自动调用 draft API', async () => {
    const mockDraft = vi.spyOn(api.api.intelligence.enrich, 'draft')
      .mockResolvedValue({ gaps: [], tokensUsed: 0 });

    render(
      <KnowledgeEnrichmentModal
        projectId="test-proj"
        gaps={[]}
        open={true}
        onClose={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockDraft).toHaveBeenCalledWith('test-proj');
    });
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
cd apps/web
npm test -- src/components/knowledge/KnowledgeEnrichmentModal.test.tsx
```

Expected: 测试通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx apps/web/src/components/knowledge/EnrichmentDraftList.tsx apps/web/src/components/knowledge/KnowledgeEnrichmentModal.test.tsx
git commit -m "feat(web): 添加知识库补充 Modal 容器组件

KnowledgeEnrichmentModal: 流程协调（drafting → editing → merging → preview）。
EnrichmentDraftList: 草稿列表容器（占位实现）。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 前端编辑组件（DraftItemCard）

**Files:**
- Create: `apps/web/src/components/knowledge/DraftItemCard.tsx`
- Modify: `apps/web/src/components/knowledge/EnrichmentDraftList.tsx` —— 使用 DraftItemCard
- Test: `apps/web/src/components/knowledge/DraftItemCard.test.tsx`

**Interfaces:**
- Consumes:
  - `DraftItem` type from Task 5
  - `Badge`, `Button` 组件（已有）
- Produces:
  - `<DraftItemCard item onChange />`

- [ ] **Step 1: 创建 DraftItemCard 组件**

```tsx
// apps/web/src/components/knowledge/DraftItemCard.tsx
import { useState } from 'react';
import type { DraftItem } from '../../lib/enrich-types.js';
import { Button } from '../Button.js';
import { Badge } from '../Badge.js';
import { CheckCircle2, Edit, Trash2 } from 'lucide-react';

interface DraftItemCardProps {
  item: DraftItem;
  onChange: (updated: DraftItem) => void;
}

export function DraftItemCard({ item, onChange }: DraftItemCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(item.aiDraft);

  const handleConfirm = () => {
    onChange({ ...item, status: 'confirmed' });
  };

  const handleEdit = () => {
    setIsEditing(true);
    onChange({ ...item, status: 'editing' });
  };

  const handleSaveEdit = () => {
    onChange({
      ...item,
      status: 'edited',
      userContent: editContent
    });
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent(item.userContent || item.aiDraft);
    onChange({
      ...item,
      status: item.userContent ? 'edited' : 'pending'
    });
  };

  const handleDelete = () => {
    onChange({ ...item, status: 'deleted' });
  };

  const handleRestore = () => {
    onChange({ ...item, status: 'pending' });
  };

  if (item.status === 'deleted') {
    return (
      <div className="draft-item draft-item--deleted">
        <span className="draft-item__title">{item.title}</span>
        <span className="draft-item__deleted-label">已删除</span>
        <Button variant="ghost" size="small" onClick={handleRestore}>
          恢复
        </Button>
      </div>
    );
  }

  return (
    <div className={`draft-item draft-item--${item.confidence}`}>
      <div className="draft-item__header">
        <div>
          <strong>{item.title}</strong>
          <Badge tone={
            item.confidence === 'high' ? 'success' :
            item.confidence === 'medium' ? 'warning' : 'danger'
          }>
            {item.confidence === 'high' ? '高把握' :
             item.confidence === 'medium' ? '中等把握' : '低把握'}
          </Badge>
        </div>
        <span className="draft-item__priority">优先级 {item.priority}</span>
      </div>

      <p className="draft-item__question">{item.question}</p>

      {isEditing ? (
        <div className="draft-item__editor">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={8}
            className="draft-item__textarea"
          />
          <div className="draft-item__editor-actions">
            <Button variant="ghost" size="small" onClick={handleCancelEdit}>
              取消
            </Button>
            <Button size="small" onClick={handleSaveEdit}>保存修改</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="draft-item__content">
            <pre style={{ whiteSpace: 'pre-wrap' }}>
              {item.userContent || item.aiDraft}
            </pre>
          </div>

          <div className="draft-item__actions">
            {item.status === 'confirmed' ? (
              <div className="draft-item__confirmed">
                <CheckCircle2 size={16} />
                <span>已确认</span>
                <Button variant="ghost" size="small" onClick={handleEdit}>修改</Button>
              </div>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="small"
                  icon={<Trash2 size={14} />}
                  onClick={handleDelete}
                >
                  删除
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  icon={<Edit size={14} />}
                  onClick={handleEdit}
                >
                  修改
                </Button>
                <Button
                  size="small"
                  icon={<CheckCircle2 size={14} />}
                  onClick={handleConfirm}
                >
                  确认无误
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 在 EnrichmentDraftList 中使用 DraftItemCard**

```tsx
// apps/web/src/components/knowledge/EnrichmentDraftList.tsx
import { DraftItemCard } from './DraftItemCard.js';
import type { DraftItem } from '../../lib/enrich-types.js';

interface EnrichmentDraftListProps {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
}

export function EnrichmentDraftList({ items, onChange }: EnrichmentDraftListProps) {
  const handleItemChange = (updatedItem: DraftItem) => {
    onChange(items.map(item =>
      item.gapId === updatedItem.gapId ? updatedItem : item
    ));
  };

  return (
    <div className="enrichment-draft-list">
      {items.map(item => (
        <DraftItemCard
          key={item.gapId}
          item={item}
          onChange={handleItemChange}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 编写 DraftItemCard 测试**

```tsx
// apps/web/src/components/knowledge/DraftItemCard.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { DraftItemCard } from './DraftItemCard.js';
import type { DraftItem } from '../../lib/enrich-types.js';

describe('DraftItemCard', () => {
  const mockItem: DraftItem = {
    gapId: 'gap1',
    title: '价格信息',
    question: '价格多少？',
    priority: 90,
    aiDraft: '推测价格 7k-9k',
    confidence: 'medium',
    status: 'pending'
  };

  it('点击"确认无误"应该更新 status', () => {
    const onChange = vi.fn();
    const { getByText } = render(<DraftItemCard item={mockItem} onChange={onChange} />);

    fireEvent.click(getByText('确认无误'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed' })
    );
  });

  it('用户编辑后点保存应该传递 userContent', () => {
    const onChange = vi.fn();
    const { getByText, getByRole } = render(<DraftItemCard item={mockItem} onChange={onChange} />);

    fireEvent.click(getByText('修改'));

    const textarea = getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '用户改了内容' } });
    fireEvent.click(getByText('保存修改'));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'edited',
        userContent: '用户改了内容'
      })
    );
  });

  it('删除后应该显示恢复按钮', () => {
    const onChange = vi.fn();
    const deletedItem = { ...mockItem, status: 'deleted' as const };
    const { getByText } = render(<DraftItemCard item={deletedItem} onChange={onChange} />);

    expect(getByText('已删除')).toBeTruthy();
    expect(getByText('恢复')).toBeTruthy();
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
cd apps/web
npm test -- src/components/knowledge/DraftItemCard.test.tsx
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/knowledge/DraftItemCard.tsx apps/web/src/components/knowledge/EnrichmentDraftList.tsx apps/web/src/components/knowledge/DraftItemCard.test.tsx
git commit -m "feat(web): 实现草稿编辑卡片组件

DraftItemCard: 逐条确认/编辑/删除逻辑，confidence 标注，状态转换。
包含完整的单元测试覆盖。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 前端预览组件与样式

**Files:**
- Create: `apps/web/src/components/knowledge/MergedDocumentPreview.tsx`
- Create: `apps/web/src/components/knowledge/OriginalKnowledgePreview.tsx`
- Modify: `apps/web/src/styles.css` —— 添加 enrich 相关样式

**Interfaces:**
- Consumes:
  - `api.knowledge.getAll(projectId)` —— 读取原文
- Produces:
  - `<MergedDocumentPreview content />`
  - `<OriginalKnowledgePreview projectId />`
  - CSS 类：`.enrich-*`, `.draft-item*`

- [ ] **Step 1: 创建合并文档预览组件**

```tsx
// apps/web/src/components/knowledge/MergedDocumentPreview.tsx
import ReactMarkdown from 'react-markdown';

interface MergedDocumentPreviewProps {
  content: string;
}

export function MergedDocumentPreview({ content }: MergedDocumentPreviewProps) {
  return (
    <div className="merged-document-preview">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: 创建原文预览组件**

```tsx
// apps/web/src/components/knowledge/OriginalKnowledgePreview.tsx
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import ReactMarkdown from 'react-markdown';

interface OriginalKnowledgePreviewProps {
  projectId: string;
}

export function OriginalKnowledgePreview({ projectId }: OriginalKnowledgePreviewProps) {
  const [files, setFiles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.knowledge.getAll(projectId)
      .then(setFiles)
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <p>加载中...</p>;

  return (
    <div className="original-knowledge-preview">
      {files.map((file, index) => (
        <details key={index} open={index === 0}>
          <summary>{file.filename}</summary>
          <ReactMarkdown>{file.content}</ReactMarkdown>
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: 添加样式**

```css
/* apps/web/src/styles.css 末尾添加 */

/* 知识库补充 Modal */
.enrich-loading {
  min-height: 400px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.enrich-editing {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 20px;
  padding: 20px;
  min-height: 600px;
}

.enrich-drafts {
  overflow-y: auto;
}

.enrich-hint {
  margin: 0 0 16px;
  padding: 12px;
  border-radius: 8px;
  background: var(--blue-soft);
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.5;
}

.enrichment-draft-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.draft-item {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}

.draft-item--low {
  border-left: 4px solid var(--red);
}

.draft-item--medium {
  border-left: 4px solid var(--amber);
}

.draft-item--high {
  border-left: 4px solid var(--green);
}

.draft-item--deleted {
  opacity: 0.5;
  background: var(--muted-soft);
}

.draft-item__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.draft-item__header > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.draft-item__priority {
  color: var(--muted);
  font-size: 11px;
}

.draft-item__question {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12px;
}

.draft-item__content {
  margin: 12px 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--muted-soft);
}

.draft-item__content pre {
  margin: 0;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
}

.draft-item__editor {
  margin: 12px 0;
}

.draft-item__textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}

.draft-item__editor-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}

.draft-item__actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 12px;
}

.draft-item__confirmed {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--green);
  font-size: 13px;
}

.enrich-original {
  position: sticky;
  top: 20px;
  max-height: 600px;
  overflow-y: auto;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--muted-soft);
}

.enrich-original h4 {
  margin: 0 0 12px;
  font-size: 14px;
}

.original-knowledge-preview details {
  margin-bottom: 12px;
}

.original-knowledge-preview summary {
  padding: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
}

.enrich-preview {
  padding: 20px;
}

.preview-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 8px;
  background: var(--blue-soft);
  color: var(--ink-2);
  font-size: 13px;
}

.merged-document-preview {
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  max-height: 600px;
  overflow-y: auto;
}

.enrich-error {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  background: var(--red-soft);
  color: var(--red);
  font-size: 13px;
}
```

- [ ] **Step 4: 在 Modal 中集成预览组件**

```tsx
// apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx
// 替换之前的占位符

import { EnrichmentDraftList } from './EnrichmentDraftList.js';
import { MergedDocumentPreview } from './MergedDocumentPreview.js';
import { OriginalKnowledgePreview } from './OriginalKnowledgePreview.js';

// 在 editing 步骤中
{step === 'editing' && (
  <div className="enrich-editing">
    <div className="enrich-drafts">
      <p className="enrich-hint">
        AI 根据现有资料推断了以下内容。<strong>请逐条审查</strong>，
        确认无误的打勾，有误的修改，不需要的删除。
      </p>
      <EnrichmentDraftList items={draftItems} onChange={setDraftItems} />
    </div>
    <div className="enrich-original">
      <h4>现有知识库</h4>
      <OriginalKnowledgePreview projectId={props.projectId} />
    </div>
  </div>
)}

// 在 preview 步骤中
{step === 'preview' && (
  <div className="enrich-preview">
    <div className="preview-notice">
      <Info size={16} />
      <span>
        这是融合后的完整文档，将保存为 <code>{targetFile}</code> 的新版本。
        请最后检查一遍，确认无误后点击保存。
      </span>
    </div>
    <MergedDocumentPreview content={mergedPreview!} />
  </div>
)}
```

- [ ] **Step 5: Typecheck 和构建**

```bash
cd apps/web
npm run typecheck && npm run build
```

Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/knowledge/MergedDocumentPreview.tsx apps/web/src/components/knowledge/OriginalKnowledgePreview.tsx apps/web/src/components/knowledge/KnowledgeEnrichmentModal.tsx apps/web/src/styles.css
git commit -m "feat(web): 添加预览组件与完整样式

MergedDocumentPreview: 融合文档预览。
OriginalKnowledgePreview: 原文对比视图。
完整的 .enrich-* 和 .draft-item* 样式。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: 前端入口集成（ProjectKnowledgeTab）

**Files:**
- Modify: `apps/web/src/pages/ProjectKnowledgeTab.tsx` —— 添加三档统计 + 补充按钮

**Interfaces:**
- Consumes:
  - `KnowledgeEnrichmentModal` from Task 6-8
  - `api.intelligence.gaps.list(projectId)` —— 读取 gaps
- Produces:
  - 三档统计显示
  - "AI 帮我补充" 按钮

- [ ] **Step 1: 添加 gaps 统计计算**

```tsx
// apps/web/src/pages/ProjectKnowledgeTab.tsx
// 在组件顶部添加

import { useState, useMemo } from 'react';
import { KnowledgeEnrichmentModal } from '../components/knowledge/KnowledgeEnrichmentModal.js';
import { Sparkles, Info } from 'lucide-react';
import type { GapStats } from '../lib/enrich-types.js';

// 在组件内部添加

const [enrichModalOpen, setEnrichModalOpen] = useState(false);

const gapStats: GapStats | null = useMemo(() => {
  if (!intel?.id) return null;

  // 假设 intel 对象包含 gaps 数据，或者需要调用 API 获取
  // const gaps = await api.intelligence.gaps.list(projectId);
  // 这里简化为从 intel 对象读取
  const gaps = intel.informationGaps || [];

  return {
    total: gaps.length,
    supplied: gaps.filter((g: any) => g.sourceStatus === 'supplied_fact').length,
    inferred: gaps.filter((g: any) =>
      ['inference', 'hypothesis'].includes(g.sourceStatus)
    ).length,
    unknown: gaps.filter((g: any) =>
      g.sourceStatus === 'unknown' || !g.answer
    ).length
  };
}, [intel]);
```

- [ ] **Step 2: 在 V2Instrument 区域添加统计显示**

```tsx
// 在 V2Instrument 组件内部或附近添加

{gapStats && gapStats.unknown > 0 && (
  <V2InstrumentCell
    tone="warn"
    icon={<Info size={14} />}
    label="知识库完整度"
    value={`${gapStats.supplied}/${gapStats.total}`}
    note={`${gapStats.unknown} 个缺口无资料，${gapStats.inferred} 个靠推断`}
  />
)}
```

- [ ] **Step 3: 添加"AI 帮我补充"按钮**

```tsx
// 在合适的位置添加按钮（可能在 V2Instrument 下方）

{gapStats && gapStats.unknown > 0 && (
  <Button
    variant="secondary"
    icon={<Sparkles size={16} />}
    onClick={() => setEnrichModalOpen(true)}
  >
    AI 帮我补充（{gapStats.unknown} 项）
  </Button>
)}
```

- [ ] **Step 4: 添加 Modal 组件**

```tsx
// 在组件 return 的末尾添加

<KnowledgeEnrichmentModal
  projectId={projectId}
  gaps={intel?.informationGaps || []}
  open={enrichModalOpen}
  onClose={() => setEnrichModalOpen(false)}
  onComplete={() => {
    // 补充完成后的回调，可能需要刷新 intel 数据
    toast.push('知识库已更新，建议重新分析', 'success');
    setEnrichModalOpen(false);
  }}
/>
```

- [ ] **Step 5: 测试页面集成**

```bash
cd apps/web
npm run dev
```

手工测试：
1. 打开项目知识库页面
2. 确认有分析结果时显示三档统计
3. 点击"AI 帮我补充"按钮打开 Modal
4. （此时后端 API 可能还未启动，会看到网络错误，这是正常的）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/ProjectKnowledgeTab.tsx
git commit -m "feat(web): 集成知识库补充入口

在 ProjectKnowledgeTab 添加三档统计显示和"AI 帮我补充"按钮。
点击后打开 KnowledgeEnrichmentModal 完整流程。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 前端组件测试

**Files:**
- Create: `apps/web/src/components/knowledge/EnrichmentFlow.test.tsx` —— 完整流程测试

**Interfaces:**
- Consumes: 所有前端组件 from Task 6-9
- Produces: 端到端组件测试覆盖

- [ ] **Step 1: 编写完整流程测试**

```tsx
// apps/web/src/components/knowledge/EnrichmentFlow.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { KnowledgeEnrichmentModal } from './KnowledgeEnrichmentModal.js';
import * as api from '../../lib/api.js';

describe('知识库补充完整流程', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应该完成 draft → 编辑 → merge → 保存 流程', async () => {
    // Mock draft API
    const mockDraft = vi.spyOn(api.api.intelligence.enrich, 'draft')
      .mockResolvedValue({
        gaps: [{
          gapId: 'gap1',
          title: '价格信息',
          question: '价格多少？',
          priority: 90,
          aiDraft: '推测价格 7k-9k',
          confidence: 'medium'
        }],
        tokensUsed: 1000
      });

    // Mock merge API
    const mockMerge = vi.spyOn(api.api.intelligence.enrich, 'merge')
      .mockResolvedValue({
        preview: '# 融合后的文档\n\n## 价格\n7k-9k',
        targetFile: 'INDEX.md',
        isNewFile: false,
        tokensUsed: 2000
      });

    // Mock save API
    const mockSave = vi.spyOn(api.api.intelligence.enrich, 'save')
      .mockResolvedValue({ fileId: 'file1', version: 2 });

    const onComplete = vi.fn();

    const { getByText, getByRole } = render(
      <KnowledgeEnrichmentModal
        projectId="proj1"
        gaps={[]}
        open={true}
        onClose={vi.fn()}
        onComplete={onComplete}
      />
    );

    // 1. 等待起草完成
    await waitFor(() => {
      expect(mockDraft).toHaveBeenCalledWith('proj1');
    });

    await waitFor(() => {
      expect(getByText('价格信息')).toBeTruthy();
    });

    // 2. 确认草稿
    fireEvent.click(getByText('确认无误'));

    // 3. 生成合并版
    fireEvent.click(getByText('生成合并版'));

    await waitFor(() => {
      expect(mockMerge).toHaveBeenCalled();
    });

    // 4. 确认保存
    await waitFor(() => {
      expect(getByText('确认保存')).toBeTruthy();
    });

    fireEvent.click(getByText('确认保存'));

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith('proj1', expect.objectContaining({
        content: '# 融合后的文档\n\n## 价格\n7k-9k',
        targetFile: 'INDEX.md'
      }));
    });

    expect(onComplete).toHaveBeenCalled();
  });

  it('所有草稿删除后应该禁用"生成合并版"按钮', async () => {
    vi.spyOn(api.api.intelligence.enrich, 'draft')
      .mockResolvedValue({
        gaps: [{
          gapId: 'gap1',
          title: '价格信息',
          question: '价格多少？',
          priority: 90,
          aiDraft: '推测价格 7k-9k',
          confidence: 'medium'
        }],
        tokensUsed: 1000
      });

    const { getByText } = render(
      <KnowledgeEnrichmentModal
        projectId="proj1"
        gaps={[]}
        open={true}
        onClose={vi.fn()}
        onComplete={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getByText('价格信息')).toBeTruthy();
    });

    // 删除草稿
    fireEvent.click(getByText('删除'));

    // 按钮应该被禁用
    const mergeButton = getByText('生成合并版') as HTMLButtonElement;
    expect(mergeButton.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: 运行所有前端测试**

```bash
cd apps/web
npm test
```

Expected: 所有测试通过（预计 403 + 新增的若干测试）

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/knowledge/EnrichmentFlow.test.tsx
git commit -m "test(web): 添加知识库补充完整流程测试

覆盖 draft → 编辑 → merge → 保存 的端到端流程，
包含边缘情况（全部删除、取消编辑）。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: 端到端手工验证

**Files:**
- 无新增文件，本任务是手工测试验证

**Interfaces:**
- Consumes: 所有已实现的前后端代码
- Produces: 验证报告（口头或文档）

- [ ] **Step 1: 启动后端服务**

```bash
cd apps/api
npm run dev
```

Expected: 服务运行在 http://localhost:3000

- [ ] **Step 2: 启动前端服务**

```bash
cd apps/web
npm run dev
```

Expected: 前端运行在 http://localhost:5173

- [ ] **Step 3: 创建测试项目**

1. 登录系统
2. 创建新项目"测试项目 - 知识库补充"
3. 上传知识库文件（至少一个 .md 文件，内容简单，如"我们是一家眼袋去除机构"）
4. 点击"分析知识库"
5. 等待分析完成

- [ ] **Step 4: 验证三档统计显示**

预期：
- 分析完成后，页面显示类似"知识库完整度 5/18"的统计
- 显示"6 个缺口无资料，7 个靠推断"
- 出现"AI 帮我补充（6 项）"按钮

- [ ] **Step 5: 验证起草流程**

1. 点击"AI 帮我补充"按钮
2. 预期：Modal 打开，显示 loading 状态"AI 正在根据现有资料起草补充内容..."
3. 等待 30-60 秒
4. 预期：显示草稿列表，每条有标题、问题、AI 推断内容、confidence 标注

- [ ] **Step 6: 验证编辑功能**

1. 选择一条 low confidence 的草稿，点击"修改"
2. 在文本框中编辑内容
3. 点击"保存修改"
4. 预期：草稿显示为"已确认"状态，内容是用户修改后的版本

- [ ] **Step 7: 验证删除功能**

1. 选择一条草稿，点击"删除"
2. 预期：草稿显示为"已删除"状态，变灰
3. 点击"恢复"
4. 预期：草稿恢复为 pending 状态

- [ ] **Step 8: 验证合并流程**

1. 确认至少一条草稿后，点击"生成合并版"
2. 预期：显示 loading "正在将补充内容融合到知识库..."
3. 等待 10-20 秒
4. 预期：显示预览界面，内容是融合后的完整文档，包含原文 + 补充内容

- [ ] **Step 9: 验证保存功能**

1. 检查预览内容是否合理
2. 点击"确认保存"
3. 预期：
   - Toast 提示"知识库已更新，建议重新分析"
   - Modal 关闭
   - 刷新页面后，知识库文件列表里看到 INDEX.md v2

- [ ] **Step 10: 验证版本历史**

1. 在知识库文件列表中，查看 INDEX.md 的版本历史
2. 预期：
   - v1：原始上传的内容
   - v2：AI 补充后的内容
3. 对比两个版本，确认补充内容已融合进去

- [ ] **Step 11: 验证租户隔离**

1. 用另一个用户账号登录
2. 尝试访问第一个用户的项目 ID（通过 URL 直接访问）
3. 预期：403 Forbidden

- [ ] **Step 12: 记录验证结果**

在本地或文档中记录：
- ✅ 哪些功能正常工作
- ❌ 哪些功能有问题（包括错误信息、复现步骤）
- 💡 改进建议

- [ ] **Step 13: 提交验证报告（可选）**

如果发现问题，创建 issue 或在计划中记录：

```bash
# 如果一切正常
git commit --allow-empty -m "test: 端到端手工验证通过

验证了完整的 draft → 编辑 → merge → 保存 流程，
包括三档统计、confidence 标注、版本历史、租户隔离。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 自查清单

在完成所有任务后，使用此清单验证实现完整性：

### 规格覆盖

- [ ] ✅ 三档统计（有据/推断/空白）已实现并显示
- [ ] ✅ AI 起草功能正常，只读取 `sourceStatus=unknown` 的 gaps
- [ ] ✅ 用户可以逐条确认/编辑/删除草稿
- [ ] ✅ 合并功能正常，自动选择 INDEX.md 或创建新文件
- [ ] ✅ 保存功能正常，版本号自动递增
- [ ] ✅ 停在知识库区展示（不自动跳转到创作区）

### 占位符扫描

- [ ] ✅ 无 TBD / TODO / 待定
- [ ] ✅ 所有代码块都有具体实现
- [ ] ✅ 所有类型定义完整

### 类型一致性

- [ ] ✅ `DraftItem` 在前后端定义一致
- [ ] ✅ `confidence` 类型在所有文件中一致
- [ ] ✅ API 请求/响应格式匹配

### 测试覆盖

- [ ] ✅ 后端单元测试：DTO 校验、service 方法
- [ ] ✅ 后端集成测试：API 端点、租户隔离、完整流程
- [ ] ✅ 前端组件测试：Modal、DraftItemCard、状态转换
- [ ] ✅ 端到端手工验证通过

### 文档与提交

- [ ] ✅ 每个任务都有清晰的提交信息
- [ ] ✅ 提交信息遵循 Conventional Commits 格式
- [ ] ✅ 所有提交包含 Co-Authored-By 行

---

## 执行建议

**推荐执行顺序**：按任务 1-11 顺序执行，每个任务完成后立即提交。

**分支策略**：
- 从 `main` 切出 `feat/knowledge-enrichment`
- 所有任务在此分支上完成
- 最后提 PR 合并回 `main`

**时间估算**：
- Task 1-5（后端 + API）：3-4 小时
- Task 6-9（前端组件 + 集成）：3-4 小时
- Task 10-11（测试 + 验证）：1-2 小时
- **总计：7-10 小时**

**并行机会**：
- Task 1-4 可以独立完成（后端）
- Task 5-9 可以在后端完成后立即开始（前端）
- Task 10-11 需要前后端都完成

---

## 下一步

计划已完整，包含 11 个任务、约 150 个步骤。

执行选项：

**1. Subagent-Driven (推荐)** - 我为每个任务派发一个新 subagent，任务间审查，快速迭代

**2. Inline Execution** - 在当前会话中使用 executing-plans 批量执行，有检查点供审查

你选择哪种方式？
