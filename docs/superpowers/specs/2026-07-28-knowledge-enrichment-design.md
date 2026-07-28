# AI 协助完善知识库 - 设计文档

**日期**: 2026-07-28  
**状态**: 设计阶段  
**负责**: superpowers/brainstorming

## 一、背景与目标

### 当前问题

用户上传知识库后，AI 会分析并生成 `information_gaps`（信息缺口），但存在三个问题：

1. **用户不知道缺什么** —— gaps 存在数据库里，但前端不显示
2. **不知道如何补充** —— 即使意识到要补充，也不知道写什么格式、多详细
3. **补充成本高** —— 需要从零创作文档，门槛高

线上真实数据显示填充率差异明显：

| 项目 | 缺口数 | 有答案 | 其中有据 | 完全未知 |
|---|---|---|---|---|
| 鲁班家装 | 16 | 16 | 16 | 0 |
| 稳行驾校 | 18 | 12 | **5** | 7 |

驾校项目典型：12/18 有答案，但只有 5 个来自知识库，另外 7 个是模型推断，说服力弱。

### 设计目标

1. **可见性** —— 分析完成后显示知识库完整度（有据/推断/空白三档）
2. **省力** —— AI 起草补充内容，用户只需审查和修改，不需要从零写
3. **可控** —— 推断内容必须逐条人工确认，防止 AI 幻觉污染知识库
4. **可审计** —— 补充内容保存为新版本，用户能看到"补充前/后"的对比

## 二、核心设计决策

以下是通过多轮讨论确认的设计选择：

| 决策点 | 选择 | 理由 |
|---|---|---|
| 质量展示方式 | **三档计数**（有据/推断/空白） | 可直接核对的事实，避免合成评分的校准问题 |
| 入口位置 | **停在知识库区展示** | 分析完是唯一愿意读诊断的时刻 |
| 补充模式 | **AI 起草 + 逐条确认** | 省力但可控，确认后的内容才入库 |
| 存储方式 | **智能合并 + 版本历史** | 单一真相源，不重复不矛盾，可回退 |
| 流程节奏 | **单页流程**（方案 1） | 刚好够用，不过度设计 |

## 三、架构与数据流

### 端到端流程

```
用户点"分析知识库"
  ↓
intelligence.service: analyze()
  生成 information_gaps（已有）
  ↓
返回前端，显示三档统计:
  18 个缺口：5 有据 · 7 推断 · 6 空白
  ↓
用户点"AI 帮我补充（6 项）"
  ↓
POST /enrich/draft
  → 后端读 sourceStatus=unknown 的 gaps
  → LLM 生成草稿（每个 gap 一段补充内容）
  → 返回 DraftItem[]
  ↓
Modal 全屏显示
  左侧：逐条草稿（可编辑）
  右侧：原知识库预览
  ↓
用户逐条: 确认/编辑/删除
  ↓
点"生成合并版"
  ↓
POST /enrich/merge
  → 后端读原文件 + 草稿
  → LLM 融合成完整文档
  → 返回预览
  ↓
用户审查预览
  ↓
点"确认保存"
  ↓
POST /enrich/save
  → 调 knowledge.upload()
  → 存为 INDEX.md v2（或新建）
  ↓
提示"建议重新分析"
```

### API 设计

#### 1. 生成草稿

```typescript
POST /api/projects/:projectId/intelligence/enrich/draft

响应:
{
  gaps: [
    {
      gapId: "uuid",
      title: "医生资质与经验",
      question: "操作星零感微孔去眼袋的医生有哪些资质？",
      priority: 85,
      aiDraft: "## 医生资质\n\n根据您提供的资料推断...",
      confidence: "low" | "medium" | "high"
    }
  ],
  tokensUsed: 1234
}
```

**confidence 判定**：
- `high`：从现有资料明确提取
- `medium`：从上下文合理推断
- `low`：无依据纯猜测（前端标黄提示）

**约束**：
- 只读取 `sourceStatus=unknown` 或 `answer=''` 的 gaps
- 按 `priority DESC` 排序，最多返回 15 个
- 无可补充缺口时抛出 `NO_GAPS` 错误

#### 2. 生成合并文档

```typescript
POST /api/projects/:projectId/intelligence/enrich/merge

请求:
{
  items: [
    {
      gapId: "uuid",
      status: "confirmed" | "edited" | "deleted",
      content: "用户编辑后的内容（status=edited 时）"
    }
  ],
  targetFile?: "INDEX.md"  // 可选，不传则自动判断
}

响应:
{
  preview: "# 项目知识库\n\n## 基本信息\n...",
  targetFile: "INDEX.md",
  isNewFile: false,
  tokensUsed: 2345
}
```

**目标文件选择逻辑**：
1. 如果用户指定 `targetFile`，使用之
2. 否则查找 `INDEX.md`（不区分大小写）
3. 不存在则创建 `INDEX.md`

**约束**：
- 至少一条 `status !== 'deleted'`，否则抛出 `ALL_DELETED`
- 所有 `gapId` 必须存在于 `information_gaps` 表
- 总内容长度不超过 500KB

#### 3. 保存合并文档

```typescript
POST /api/projects/:projectId/intelligence/enrich/save

请求:
{
  content: "合并后的完整文档",
  targetFile: "INDEX.md"
}

响应:
{
  fileId: "uuid",
  filename: "INDEX.md",
  version: 2
}
```

**实现**：直接调用 `knowledge.upload()`，自动递增版本号。

**为什么分 merge 和 save 两步**：让用户有最后一次人工审查。`merge` 返回只读预览，用户看完确认才调 `save`。

## 四、后端实现

### intelligence.service.ts 新增方法

```typescript
async generateEnrichmentDraft(
  projectId: string, 
  principal: SessionPrincipal
): Promise<EnrichmentDraftResponse>

async mergeEnrichedKnowledge(
  projectId: string,
  items: MergeItem[],
  targetFile: string | undefined,
  principal: SessionPrincipal
): Promise<MergePreviewResponse>

async saveEnrichedKnowledge(
  projectId: string,
  content: string,
  targetFile: string,
  principal: SessionPrincipal
): Promise<KnowledgeFileResponse>
```

### LLM 提示词策略

#### 起草提示词（generateEnrichmentDraft）

```
你是知识库完善助手。用户上传了项目资料，但有些决策关键信息缺失。

【现有资料】
${context}

【需要补充的信息】
${gaps.map(g => `- ${g.title}：${g.question}`).join('\n')}

你的任务：
1. 基于现有资料，为每个缺口推断补充内容
2. 推断要合理，不要凭空编造
3. 用 Markdown 格式，每个缺口写 2-4 段
4. 标注你的把握程度（high/medium/low）

返回 JSON 数组：
[
  {
    "gapId": "uuid",
    "content": "## 医生资质\n\n推断内容...",
    "confidence": "low",
    "reasoning": "现有资料未提及医生信息，此为行业常规推测"
  }
]

【重要】：
- 如果现有资料明确提到相关信息，直接提取（confidence=high）
- 如果能从上下文合理推断，谨慎推断（confidence=medium）
- 如果完全没有依据，明确说明这是假设（confidence=low）
- 不要编造具体数字、姓名、地址等事实性信息
```

**优化点**：

**Context 压缩策略**：
```typescript
// 提取与 gaps 相关的段落
function extractRelevantContext(knowledge: KnowledgeFile[], gaps: InformationGap[]): string {
  const keywords = gaps.flatMap(g => [
    ...g.title.split(/\s+/),
    ...g.question.split(/\s+/)
  ]).filter(w => w.length > 2);  // 至少 3 个字符
  
  return knowledge.map(k => {
    // 按段落分割（\n\n 或 ## 标题）
    const paragraphs = k.content.split(/\n\n+|(?=^##\s)/m);
    
    // 保留包含任一关键词的段落
    const relevant = paragraphs.filter(p => 
      keywords.some(kw => p.includes(kw))
    );
    
    if (relevant.length === 0) return '';
    return `## ${k.filename}\n${relevant.join('\n\n')}`;
  }).filter(Boolean).join('\n\n');
}
```

如果压缩后仍超过 4000 tokens，按段落相关度排序，取前 4000 tokens。

**批量生成**：
- 一次 LLM 调用生成所有 gaps 的草稿（不逐条调用）
- 提示词中用 JSON 数组格式，要求模型一次返回所有 gaps 的补充

#### 合并提示词（mergeEnrichedKnowledge）

```
你是文档合并专家。用户有一份原始知识库，以及 AI 生成、用户审核过的补充内容。

【原文档】
${existingContent}

【补充内容（已经用户确认）】
${supplements.map(s => `### ${s.title}\n${s.content}`).join('\n\n')}

你的任务：
1. 将补充内容融合进原文档，形成一份完整、无重复的新版本
2. 如果补充内容与原文矛盾，以补充内容为准（因为它更具体）
3. 保持 Markdown 结构清晰，用二级标题分节
4. 不要删除原文的任何信息，只做整合和去重

输出格式示例：
# 项目知识库

## 基本信息
[融合原文 + 补充]

## 价格体系
[补充内容在这里，替换原文的模糊表述]

## 医生资质
[补充内容]

...
```

### 版本管理

利用现有的 `knowledge_files` 版本机制：

- 同一 `filename` 的多个 `version` 存成多条记录
- `getAll()` 用窗口函数取每个文件的最新版本
- `upload()` 已经实现自动 `version++`

**不需要新增表或字段。**

## 五、前端实现

### 组件结构

```
ProjectKnowledgeTab.tsx
  ├─ V2Instrument（已有）
  │   └─ 新增第四格：三档统计
  ├─ [AI 帮我补充] 按钮
  └─ KnowledgeEnrichmentModal（新增）
       ├─ Step 1: 起草中（loading）
       ├─ Step 2: 逐条确认界面
       │   ├─ EnrichmentDraftList
       │   │   └─ DraftItemCard × N
       │   └─ OriginalKnowledgePreview（右侧）
       ├─ Step 3: 合并中（loading）
       └─ Step 4: 预览合并文档
           ├─ MergedDocumentPreview
           └─ [确认保存] [返回修改]
```

### 核心状态管理

```typescript
interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: 'low' | 'medium' | 'high';
  status: 'pending' | 'confirmed' | 'editing' | 'edited' | 'deleted';
  userContent?: string;  // status=edited 时有值
}

type ModalStep = 'drafting' | 'editing' | 'merging' | 'preview';

// Modal 内状态
const [step, setStep] = useState<ModalStep>('drafting');
const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
const [mergedPreview, setMergedPreview] = useState<string | null>(null);
```

### DraftItem 状态转换

```
pending → confirmed   // 用户点"确认无误"
pending → editing     // 用户点"修改"
editing → edited      // 用户保存修改
editing → pending     // 用户取消修改
* → deleted           // 用户点"删除"
deleted → pending     // 用户点"恢复"
```

### 三档统计显示

在 `ProjectKnowledgeTab` 的 `V2Instrument` 区域新增一格：

```tsx
const gapStats = useMemo(() => {
  const gaps = /* api.intelligence.gaps.list(projectId) */;
  
  return {
    total: gaps.length,
    supplied: gaps.filter(g => g.sourceStatus === 'supplied_fact').length,
    inferred: gaps.filter(g => ['inference','hypothesis'].includes(g.sourceStatus)).length,
    unknown: gaps.filter(g => g.sourceStatus === 'unknown' || !g.answer).length,
  };
}, [projectId]);

// 只在有空白缺口时显示
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

## 六、错误处理

### 起草阶段

| 错误类型 | 处理策略 |
|---|---|
| `NO_GAPS` | toast 提示"已经很完善"，关闭 Modal |
| `LLM_TIMEOUT` | 显示错误 + [重试] 按钮 |
| `INSUFFICIENT_CONTEXT` | 提示"资料太少，建议先手工补充" + [去上传] |

### 合并阶段

| 错误类型 | 处理策略 |
|---|---|
| `ALL_DELETED` | 前端预检：至少保留一条，否则禁用按钮 |
| `TARGET_FILE_CONFLICT` | toast "文件已被修改，请刷新" |
| `LLM_MERGE_FAILED` | 显示错误，回到编辑步骤 |

### 保存阶段

| 错误类型 | 处理策略 |
|---|---|
| `FILE_TOO_LARGE` | toast "文档超过 2MB，请减少内容"，回到编辑 |
| `QUOTA_EXCEEDED` | toast "存储配额已满" |
| `PERMISSION_DENIED` | toast "权限不足" |

### 用户中途关闭

```typescript
const handleClose = () => {
  if (step === 'editing' && draftItems.some(i => ['editing','edited'].includes(i.status))) {
    if (confirm('有未保存的编辑，确定要关闭吗？')) {
      props.onClose();
    }
  } else {
    props.onClose();
  }
};
```

## 七、数据校验

### 输入校验（DTO）

```typescript
class EnrichMergeRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  items: MergeItemDto[];

  @IsOptional()
  @Matches(/^[^/\\]+\.md$/)  // 防止路径穿越
  targetFile?: string;
}

class MergeItemDto {
  @IsUUID()
  gapId: string;

  @IsEnum(['confirmed', 'edited', 'deleted'])
  status: string;

  @IsOptional()
  @Length(0, 20000)
  content?: string;
}

class EnrichSaveRequestDto {
  @IsString()
  @Length(100, 2_000_000)
  content: string;

  @IsString()
  @Matches(/^[^/\\]+\.(md|txt)$/)
  targetFile: string;
}
```

### 业务逻辑校验

```typescript
// mergeEnrichedKnowledge 内部

// 1. 验证所有 gapId 都存在
const gaps = db.prepare(`
  SELECT id FROM information_gaps 
  WHERE project_id=? AND id IN (${gapIds.map(() => '?').join(',')})
`).all(projectId, ...gapIds);

if (gaps.length !== gapIds.length) {
  throw new ValidationError('部分 gapId 无效');
}

// 2. 验证至少有一条非删除项
const activeItems = items.filter(i => i.status !== 'deleted');
if (activeItems.length === 0) {
  throw new ValidationError('至少保留一条补充内容', 'ALL_DELETED');
}

// 3. 验证内容总长度
const totalLength = activeItems.reduce((sum, i) => sum + (i.content?.length || 0), 0);
if (totalLength > 500_000) {
  throw new ValidationError('补充内容总长度超过 500KB');
}
```

### LLM 输出校验

```typescript
// 验证返回的 gapId 都在请求范围内
const requestedIds = gaps.map(g => g.id);
const invalidIds = result.items.filter(item => !requestedIds.includes(item.gapId));
if (invalidIds.length > 0) {
  throw new LLMError('AI 返回了不存在的 gapId');
}

// 过滤掉空草稿
const validDrafts = result.items.filter(item => item.content?.trim().length >= 10);
if (validDrafts.length === 0) {
  throw new LLMError('AI 未能生成有效内容', 'INSUFFICIENT_CONTEXT');
}
```

## 八、性能优化

### 1. 并发控制

```typescript
// 全局限制同时进行的 enrich 任务数
private enrichSemaphore = new Semaphore(3);

async generateEnrichmentDraft(...) {
  return this.enrichSemaphore.use(async () => {
    // 实际逻辑
  });
}
```

### 2. 缓存策略

```typescript
// 草稿生成结果缓存 5 分钟
// fingerprint = hash(projectId + gapIds)
private draftCache = new Map<string, { result: any; expireAt: number }>();
```

### 3. LLM 调用优化

- **只传相关 context**：提取与 gaps 相关的段落，不传整个知识库
- **批量生成**：一次调用生成所有 gaps 的草稿，不逐条调用

## 九、监控指标

### 业务指标

- `enrich_draft_requests_total` —— 总请求数
- `enrich_draft_success_rate` —— 成功率
- `enrich_draft_duration_ms` —— 耗时（P50/P95/P99）
- `enrich_draft_gaps_count` —— 每次处理的 gaps 数量
- `enrich_draft_tokens_used` —— token 消耗
- `enrich_draft_confidence_distribution` —— low/medium/high 占比
- `enrich_merge_similarity` —— 合并后与原文的相似度
- `enrich_save_version` —— 保存时的版本号分布

### 用户行为指标

```typescript
// 用户点击"AI 帮我补充"
analytics.track('enrich_modal_opened', {
  projectId,
  gapsTotal,
  gapsUnknown,
});

// 用户编辑草稿
analytics.track('enrich_draft_edited', {
  gapId,
  confidence,
  originalLength,
  editedLength,
});

// 用户删除草稿
analytics.track('enrich_draft_deleted', {
  gapId,
  confidence,
});

// 用户保存最终文档
analytics.track('enrich_completed', {
  projectId,
  totalItems,
  confirmedItems,
  editedItems,
  deletedItems,
  timeSpent,
});
```

**关键问题**：
- 有多少用户点了"AI 帮我补充"后放弃？
- 用户最常编辑哪种 confidence 的草稿？
- 平均每次补充花多少时间？
- 补充后有多少用户真的重新分析了？

## 十、测试策略

### 单元测试

**intelligence.service.ts**：
- `generateEnrichmentDraft` 只返回 `sourceStatus=unknown` 的 gaps
- 没有 gaps 时抛出 `NO_GAPS`
- 最多返回 15 个，按 priority 降序
- LLM 返回格式错误时抛出 `LLM_ERROR`

**mergeEnrichedKnowledge**：
- 自动选择 INDEX.md 作为目标文件
- 知识库为空时创建 INDEX.md
- 过滤掉 `status=deleted` 的 items
- 所有 items 都删除时抛出 `ALL_DELETED`

**saveEnrichedKnowledge**：
- 调用 `knowledge.upload` 并传递正确参数
- 同一文件名自动递增版本号

### 集成测试

**API 端到端**：
- `POST /enrich/draft` 只返回 unknown 的 gaps
- 每条 gap 有 confidence 字段
- 租户隔离：不能访问其他租户的项目
- `POST /enrich/merge` 返回预览，不修改数据库
- 完整流程 draft → merge → save 产生正确的版本历史

### 前端组件测试

- Modal 打开时自动调用 draft API
- 用户点"确认无误"更新 item.status
- 用户编辑后保存传递 userContent
- 所有 items 删除后"生成合并版"按钮禁用

## 十一、边缘情况处理

1. **起草返回 0 条** → 抛出 `INSUFFICIENT_CONTEXT`
2. **所有草稿都是 low confidence** → 显示警告，建议手工补充
3. **合并后与原文高度相似（>95%）** → 提示"可能不需要保存"，但仍允许
4. **用户中途关闭 Modal** → 如果有未保存的编辑，弹确认框
5. **目标文件在生成过程中被修改** → 抛出 `TARGET_FILE_CONFLICT`，提示刷新

## 十二、成本控制

### LLM 调用次数

每次完整补充流程：
- 起草：1 次（批量生成所有 gaps）
- 合并：1 次（融合原文 + 补充）
- **总计：2 次**

符合"每次补充不超过 3 次调用"的约束。

### Token 消耗估算

假设：
- 15 个 gaps
- 现有知识库 10k tokens（压缩后 3k）
- 每个 gap 生成 200 tokens

**起草阶段**：
- 输入：3k context + 15×50 (gaps) = 3750 tokens
- 输出：15×200 = 3000 tokens
- **合计：6750 tokens**

**合并阶段**：
- 输入：5k 原文 + 3k 补充 = 8000 tokens
- 输出：8k (融合后) = 8000 tokens
- **合计：16000 tokens**

**每次补充总计：~23k tokens** ≈ ¥0.15（按 Claude Opus 价格）

## 十三、向后兼容性

### 数据库

- **不新增表**：利用现有 `information_gaps` 和 `knowledge_files`
- **不新增字段**：`version` 已存在且正常工作
- **不修改现有逻辑**：分析流程不受影响

### API

- **新增端点**：`/enrich/*` 三个，不影响现有路由
- **现有 API 不变**：`/information-gaps` 保持原样

### 前端

- **新增组件**：`KnowledgeEnrichmentModal` 及子组件
- **修改现有组件**：`ProjectKnowledgeTab` 增加统计显示和按钮
- **不破坏现有流程**：分析 → 创作 的路径仍然存在（用户可以不点"补充"）

## 十四、实施风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| LLM 推断质量低 | 用户不信任，放弃使用 | 1. confidence 标注 2. 强制逐条确认 3. 监控编辑率 |
| 合并逻辑出错 | 原文被破坏 | 1. 版本历史可回退 2. 预览门槛 3. 相似度检测 |
| 用户嫌麻烦 | 点开就关，不用 | 1. 行为监控 2. 迭代简化流程 |
| Token 成本高 | 频繁使用费用飙升 | 1. 并发限制 2. 缓存 3. context 压缩 |

## 十五、后续迭代方向

**Phase 2（如果 Phase 1 数据显示有价值）**：
- 支持图片/Excel 上传，OCR + 结构化提取
- "批量补充"：选择多个项目一起补充
- "智能去重"：检测知识库内重复表述并合并
- "补充效果对比"：生成"补充前/后"的内容 A/B 对比

**不做的事**：
- 自动定时补充（违背"人工审查"原则）
- 补充内容直接进入生成（必须重新分析）
- 多轮对话补充（增加复杂度，收益不明确）

## 十六、文档版本历史

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-07-28 | 1.0 | 初始设计 |

---

**下一步**：进入 `writing-plans` 阶段，拆解实施任务。
