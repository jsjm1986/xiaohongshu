# AI 协助完善知识库 - 设计文档

**日期**: 2026-07-28  
**更新**: 2026-07-31
**状态**: 已实现

## 一、目标与边界

用户上传的 Markdown 可能结构零散或缺少关键项目事实。本功能协助用户把它完善为后续 AI 分析与生成可直接全量使用的 Markdown。

本功能只做两件事：

1. 把现有资料中已经存在的事实整理成清晰 Markdown。
2. 对资料确实缺少、含糊或冲突的项目事实，向用户提出具体问题并收集明确答案。

明确不做：

- 不建立知识图谱或额外的重型知识工作流。
- 不把所有 `information_gaps` 都视为知识文档缺失。
- 不用行业常识、合理推断或假设补写项目事实。
- 不让模型重写整份知识文档。
- 不把“资料未提及”“待确认”等占位语句保存成已知事实。

`information_gaps` 同时服务选题规划、读者问题和内容生成。其中很多 gap 是内容规划问题，并不表示用户的 Markdown 有缺陷。

## 二、分析判定

分析阶段为每条 gap 输出独立字段：

```ts
type KnowledgeAction = 'organize_existing' | 'ask_user' | 'none';

interface InformationGap {
  knowledgeAction: KnowledgeAction;
  knowledgeReason?: string;
}
```

### `organize_existing`

仅在上传资料已经包含项目特定事实，但内容分散、重复或不便后续 AI 使用时选择。

- AI 可以提取、归纳和调整 Markdown 结构。
- AI 不得增加资料之外的事实。
- 分析阶段的 `evidenceIds` 是首选依据；关键词检索只补足上下文预算。

### `ask_user`

仅在缺少、含糊或冲突的项目特定事实会实质影响后续生成，并且只能由项目负责人确认时选择。

- 不调用模型生成答案。
- 前端展示具体问题和 `knowledgeReason`。
- 用户必须填写明确事实，也可以选择暂不处理。

### `none`

用于选题、读者疑问、领域教育、可选内容角度等不需要新增项目事实的 gap。这些 gap 继续参与原有规划流程，但不进入知识完善。

历史数据没有 `knowledgeAction` 时保守回落为 `none`，重新分析后才进入新流程。这样不会因为升级而把旧的规划 gap 突然当成知识缺失。

## 三、端到端流程

```text
用户上传 Markdown
  -> 分析项目
  -> 每条 gap 标记 knowledgeAction / knowledgeReason
  -> 入口显示“完善知识（整理 N · 回答 M）”
  -> POST /enrich/draft
       organize_existing: AI 只基于证据整理
       ask_user: 返回空草稿和具体问题，不调用 AI
  -> 用户逐条确认、修改、填写或暂不处理
  -> POST /enrich/merge
       校验内容是明确事实
       保留原文，确定性追加人工确认内容
  -> 用户预览完整 Markdown
  -> POST /enrich/save
       保存同名文件新版本，旧版本保留
       标记为“已知事实”及 humanConfirmed=true
  -> 用户显式选择重新分析
```

重新分析可能消耗额度且会产生一批新的草稿版内容地图，因此保存后只提示，不静默触发。现有页面提供“重新分析”按钮及影响确认弹窗。

## 四、起草协议

### 请求

```http
POST /api/projects/:projectId/intelligence/enrich/draft
```

可选请求体包含 `gapIds: string[]`；例如只完善一条时传入对应 gap ID。

不传表示处理当前批次的全部知识完善项；单次最多 15 条。

### 响应

```ts
interface DraftItem {
  gapId: string;
  title: string;
  question: string;
  priority: number;
  aiDraft: string;
  confidence: 'low' | 'medium' | 'high';
  knowledgeAction: 'organize_existing' | 'ask_user';
  knowledgeReason: string;
  sources: Array<{
    evidenceId: string;
    filename: string;
    heading: string;
    excerpt: string;
  }>;
}
```

`confidence` 表示整理依据的明确程度，不表示允许推断。模型输出少于 10 字、包含未决占位语句或以问号结尾时直接丢弃。

起草期间如果知识版本或 gap 内容发生变化，返回冲突错误，禁止展示过期草稿。`reference-corpus` 只用于风格参考，不进入项目事实整理上下文。

## 五、人工确认规则

所有写入知识库的条目都必须经过显式操作：

- `confirmed`：用户确认 AI 整理内容属实。
- `edited`：用户修改后确认，或亲自填写 `ask_user` 的答案。
- `deleted`：本轮暂不处理，不写入知识库。
- `pending` / `editing`：不能进入合并。

以下内容不能作为已知事实合并：

- 空内容或少于 10 字的内容。
- “待确认”“资料未提及”“尚未提供”“信息缺失”等未决语句。
- 以中文或英文问号结尾的内容。

前端提供即时校验，服务端再次校验，不能依赖客户端状态。

## 六、确定性 Markdown 合并

合并阶段不调用模型，不做全文改写。行为固定为：

1. 目标缺省时优先选择最新版 `INDEX.md`，不存在则新建。
2. 已有目标原文逐字节保留，不删除、不改写、不重排。
3. 首次追加时加入 `## 人工确认补充`。
4. 每条内容使用 `### gap 标题`，正文内部标题降到四级或更深。
5. 规范化正文已经存在时不重复追加。
6. 所有内容均已存在时拒绝生成无意义的新版本。
7. `reference-corpus` 不能作为合并目标。

示例：

```md
# 项目知识库

[原文保持不变]

## 人工确认补充

### 收费方式
收费方式由双方在委托合同中书面约定。
```

合并读取期间会复核 gap 和目标文件版本。任何并发更新都会返回冲突，用户需刷新后重新生成预览。

## 七、`INDEX.md` 定位

`INDEX.md` 是合理的默认知识入口，但不是原始文件副本：

- 项目没有指定目标文件时，用它承载人工确认后的精简事实汇总。
- 不复制所有上传文件全文，避免后续全量上下文重复和膨胀。
- 用户也可以选择并入现有项目事实文件。
- 同名文件采用版本机制保存，旧版本用于审计和回看。

后续 AI 仍全量读取生效的 Markdown。`INDEX.md` 的价值是提供结构清晰、人工确认的补充事实，不是建立第二套真相源。

## 八、安全与一致性

- 三个端点沿用项目写权限；起草和合并还要求知识读取权限。
- `gapId` 必须属于当前项目和当前分析批次。
- 文件名只允许裸 `.md` / `.txt` 名称，拒绝路径穿越。
- 保存使用 `baseFileId` 乐观锁，预览后目标更新则拒绝旧预览。
- 保存事务内继承目标最新分类，并再次拒绝 `reference-corpus`。
- 人工确认版本写入 `evidenceStatus=已知事实` 和 `humanConfirmed=true`。

## 九、验收标准

- 规划类 gap 不出现知识完善入口。
- `ask_user` 不产生模型调用，空答案不能合并。
- `organize_existing` 优先使用 evidence ID 对应分节，并向用户展示来源。
- AI 不得输出或保存资料外推断和未决占位内容。
- 合并不调用模型，既有原文保持不变，只追加确认事实。
- 并发更新、跨项目 gap、参考语料目标和重复内容均被安全处理。
- 保存产生新版本并保留历史，不自动触发重新分析。
- typecheck、全量测试、构建及 `git diff --check` 全部通过。
