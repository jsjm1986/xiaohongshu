# 选题多样性、用户引导词与永久保存重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development 逐任务实现本计划。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 解决"换一批"提示词固定导致选题雷同、失去意义的核心问题，同时把选题从"用完即删的草稿"升级为"永久保留、可收藏归档筛选的资产"，并让用户能用一段短引导词控制生成方向（且可保存复用）。

**背景（基于代码实证）：** 当前 `refreshTopicOpportunities`（intelligence.service.ts:884-919）每次换一批都会**软删除所有 draft 选题**，只保留 approved 的；生成走固定 prompt + 写死 `temperature: 0.2`（callAnalysisModel:1440/1447），且 prompt 不含"已生成过什么"的信号。三者叠加 → 每次换一批高度雷同。

**三个已锁定的架构决策（用户拍板）：**
1. **存储**：全部自动保留 + 批次号 + 收藏/归档状态；换一批**新批次追加**，绝不删旧的。
2. **短引导词**：作用于选题生成，且可保存成可复用模板；语义为"强方向，可临时放宽项目知识/缺口的范围"。
3. **多样性 A+B 高强度**：A=换一批调高随机温度；B=把已有选题标题喂回 prompt 令模型避开。

**Architecture:** 后端业务逻辑是唯一事实源。三个正交维度分层：
- `status`（draft/approved/rejected/stale）= **评审状态**，保持不变，不动其 CHECK 约束。
- 新增 `collection_status`（active/collected/archived）= **收藏状态**，独立新列。
- 新增 `batch_id` = **批次归属**，独立新列。
永久保留意味着换一批不再软删除；"清理"改为用户显式 archive。多样性通过给 prompt 注入 `userGuidance` + `existingTitles` 并给换一批路径提高 temperature 实现。

**Tech Stack:** NestJS (apps/api)、React/Vite (apps/web)、SQLite (node:sqlite)、TypeScript strict。**服务器实际运行主目录 main 分支，所有实现落在 `/Users/a1234/Desktop/开发项目/小红书创作/文案/content-agent`。**

## Global Constraints

- **迁移机制**：当前 `PRAGMA user_version = 8`（database.service.ts:681）。新迁移加 version 9 块，紧跟在 685 行 `migrate()` 结束前，模式严格照抄既有块：`if (version < 9) this.transaction(() => { this.db.exec(\`...; PRAGMA user_version = 9;\`); }); if (version < 9) version = 9;`。
- **不改 `status` 的 CHECK 约束**（SQLite 改 CHECK 要重建表，风险大）。收藏/归档用独立列 `collection_status`，`ALTER TABLE ADD COLUMN ... NOT NULL DEFAULT 'active'`。
- **不破坏软删除语义**：`deleted_at` 保留（用户 remove 仍软删）。新增的"归档"是 `collection_status='archived'`，与 `deleted_at` 不同——归档仍可见可筛选，删除才隐藏。
- 度量канонical 0–1，前端滑块 0–100，照抄既有 gap/opportunity 处理。
- 写入时绝不发送 server-derived 字段，沿用 `opportunityResourceData`/`canonicalOpportunityData` 清洗模式。
- 所有面向用户文案用简体中文，匹配现有 UI 语气。
- 无新依赖。TypeScript strict 必须通过（两个 app 各跑 `npx tsc --noEmit`）。
- 不触碰 research/workspace 等无关域。

---

### Task 1: 数据库迁移 — 批次号 + 收藏状态 + 引导词模板表

**为什么：** 永久保留需要 `batch_id` 归属每次生成、`collection_status` 承载收藏/归档；可复用引导词需要新表。这是所有后续任务的地基。

**Files:**
- Modify: `apps/api/src/database.service.ts` — 在 685 行 `migrate()` 结束前加 version 9 块

**Interfaces:**
- topic_opportunities 新增列：`batch_id TEXT`（可空，老数据为 NULL）、`collection_status TEXT NOT NULL DEFAULT 'active'`（active/collected/archived）
- 新表 `opportunity_batches`：记录每次生成批次的元信息（引导词、温度、触发方式）
- 新表 `opportunity_prompt_templates`：用户可复用的引导词模板

- [ ] **Step 1: 加 version 9 迁移块**

在 `apps/api/src/database.service.ts` 第 685 行（`migrate()` 方法内、最后一个 `if (version < 8) version = 8;` 之后、方法闭合 `}` 之前）加入：

```typescript
    if (version < 9) this.transaction(() => {
      this.db.exec(`
        ALTER TABLE topic_opportunities ADD COLUMN batch_id TEXT;
        ALTER TABLE topic_opportunities ADD COLUMN collection_status TEXT NOT NULL DEFAULT 'active';
        CREATE INDEX IF NOT EXISTS topic_opportunities_batch_idx
          ON topic_opportunities(project_id, batch_id, deleted_at);
        CREATE INDEX IF NOT EXISTS topic_opportunities_collection_idx
          ON topic_opportunities(project_id, collection_status, deleted_at, updated_at DESC);
        CREATE TABLE opportunity_batches (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          analysis_task_id TEXT,
          trigger TEXT NOT NULL DEFAULT 'refresh',
          user_guidance TEXT NOT NULL DEFAULT '',
          temperature REAL,
          opportunity_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX opportunity_batches_project_idx
          ON opportunity_batches(project_id, created_at DESC);
        CREATE TABLE opportunity_prompt_templates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          guidance TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX opportunity_prompt_templates_project_idx
          ON opportunity_prompt_templates(project_id, deleted_at, updated_at DESC);
        PRAGMA user_version = 9;
      `);
    });
    if (version < 9) version = 9;
```

先 Read 683-685 行确认 `migrate()` 的确切结尾，把新块插在 `PRAGMA user_version = 8` 对应的 `if (version < 8) version = 8;` 之后。

- [ ] **Step 2: 验证迁移**

```bash
cd apps/api && npx tsc --noEmit
```
预期 PASS。迁移的运行时验证放在 Task 6 端到端。若本地有 dev DB，重启 API 后用 `PRAGMA user_version` 应为 9，`PRAGMA table_info(topic_opportunities)` 应含 batch_id/collection_status。

- [ ] **Step 3: 提交**

```bash
git add apps/api/src/database.service.ts
git commit -m "feat(db): add batch_id/collection_status columns and batch/prompt-template tables (v9)"
```

---

### Task 2: 后端多样性核心 — 温度透传 + prompt 注入引导词与已有标题 + 换一批改为批次追加

**为什么：** 这是解决"雷同"的根治任务。当前换一批：固定 prompt + 写死 temperature 0.2 + 软删旧草稿。改造后：高温度（A）+ prompt 注入已有标题令模型避开（B）+ 注入用户引导词 + 新批次追加不删除。

**Files:**
- Modify: `apps/api/src/intelligence.service.ts` — 改 `callAnalysisModel`/`retryAnalysis`/`analyzeWithCurrentModel` 加 temperature 透传；改 `projectOpportunityAnalysisPrompt` 加 userGuidance/existingTitles 参数；重写 `refreshTopicOpportunities`；改 `insertAnalyzedOpportunity` 接收 batchId

**Interfaces:**
- `callAnalysisModel(prompt, images, settings, task, temperature?: number)` — 默认仍 0.2，换一批传高温
- `analyzeWithCurrentModel(project, principal, prompt, images, taskId, temperature?: number)` — 透传
- `projectOpportunityAnalysisPrompt(sourceJson, gaps, strategies?, options?: { userGuidance?: string; existingTitles?: string[] })` — 新增可选 options
- `refreshTopicOpportunities(projectId, principal, input?: { userGuidance?: string })` — 新签名，返回含新 batch

- [ ] **Step 1: temperature 三层透传**

在 `apps/api/src/intelligence.service.ts`：

(a) `callAnalysisModel`（约 1431 行）签名加末位可选参数 `temperature = 0.2`，把 body 里两处写死的 `temperature: 0.2`（1440、1447 行）改为 `temperature`。

(b) `retryAnalysis`（约 1410 行）签名加末位 `temperature = 0.2`，调用 `callAnalysisModel(...)` 时透传（1420 行）。

(c) `analyzeWithCurrentModel`（约 1398 行）签名加末位 `temperature = 0.2`，透传给 `retryAnalysis`/`callAnalysisModel`（1407 行）。

先 Read 1396-1466 确认这三个方法的确切调用形态（探查报告显示实参顺序为 `(prompt, images, settings, task)`，以磁盘实际为准）。**其余 5 个 `analyzeWithCurrentModel` 调用点不传第 6 参，行为不变（仍 0.2）。**

- [ ] **Step 2: prompt 注入引导词 + 已有标题**

改 `projectOpportunityAnalysisPrompt`（约 2167 行）。签名改为：

```typescript
function projectOpportunityAnalysisPrompt(
  sourceJson: string,
  gaps: Record<string, unknown>[],
  strategies: Record<string, unknown>[] = [],
  options: { userGuidance?: string; existingTitles?: string[] } = {},
): string
```

在 sections 组装处（`APPROVED_STAGE_2_GAP_CATALOG` 那段之后、`'Produce 12 to 18 diverse opportunities'` 那条指令之前）追加：

```typescript
  const existing = (options.existingTitles ?? []).filter(Boolean).slice(0, 60);
  if (existing.length) {
    sections.push(`ALREADY_GENERATED_TITLES=${JSON.stringify(existing)}`);
    sections.push('These titles were already generated for this project. Produce topics that are clearly DIFFERENT in angle, entry point, audience stage or decision task — do not paraphrase, re-order or lightly reword any listed title. Prefer unexplored gaps and scenario families.');
  }
  const guidance = (options.userGuidance ?? '').trim().slice(0, 600);
  if (guidance) {
    sections.push(`USER_DIRECTION=${JSON.stringify(guidance)}`);
    sections.push('Treat USER_DIRECTION as a strong steer for topic angle, theme and emphasis. You MAY reach slightly beyond the strict knowledge/gap scope to satisfy it, but project ANSWERS and factual claims still must use only supplied evidence: when the direction outruns the evidence, keep the topic but mark unprovable parts via sourceStatus (inference/hypothesis) and status. Never fabricate project facts.');
  }
```

保持 `'Produce 12 to 18 diverse opportunities'` 那条不变。注意：引导词是"方向"不是"事实来源"——安全护栏（只用已有证据下事实结论）不放宽。

- [ ] **Step 3: insertAnalyzedOpportunity 接收 batchId**

改 `insertAnalyzedOpportunity`（约 1521 行）签名加 `batchId: string` 参数，INSERT 语句加入 `batch_id` 列与对应 `?`，值传 `batchId`。`collection_status` 走列默认值 `'active'`，不必显式写。

- [ ] **Step 4: 重写 refreshTopicOpportunities（批次追加，不删除）**

替换 `refreshTopicOpportunities`（884-919 行）为：

```typescript
  async refreshTopicOpportunities(
    projectId: string,
    principal: SessionPrincipal,
    input: { userGuidance?: string } = {},
  ): Promise<Record<string, unknown>> {
    const project = this.resources.projectRow(projectId);
    const source = await this.projectAnalysisSource(project);
    const gapRows = this.approvedRows('information_gaps', projectId, 'priority DESC');
    const gaps = gapRows.map(normalizeGap);
    const gapIdMap = new Map<string, string>(gapRows.map((row) => [String(row.id), String(row.id)]));
    // B: 收集该项目现存（未删除）选题标题，喂回 prompt 令模型避开
    const existingTitles = (this.database.prepare(
      `SELECT title FROM topic_opportunities WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 60`,
    ).all(projectId) as Array<{ title: string }>).map((row) => row.title);
    const userGuidance = typeof input.userGuidance === 'string' ? input.userGuidance.trim().slice(0, 600) : '';
    const batchId = randomUUID();
    const DIVERSITY_TEMPERATURE = 0.85; // A: 换一批用高温提升多样性（分析/蓝图仍 0.2）
    const task = this.createTask(projectId, 'project', null, `${source.fingerprint}:topic-refresh:${batchId}`, principal);
    try {
      const opportunityPayload = await this.analyzeWithCurrentModel(
        project,
        principal,
        projectOpportunityAnalysisPrompt(source.sourceJson, gaps, [], { userGuidance, existingTitles }),
        [],
        task.id,
        DIVERSITY_TEMPERATURE,
      );
      const opportunities = recordArray(opportunityPayload.topicOpportunities);
      const now = nowIso();
      this.database.transaction(() => {
        // 永久保留：不再软删旧草稿，只追加新批次
        this.database.prepare(
          `INSERT INTO opportunity_batches
             (id, project_id, analysis_task_id, trigger, user_guidance, temperature, opportunity_count, created_by, created_at)
           VALUES (?, ?, ?, 'refresh', ?, ?, ?, ?, ?)`,
        ).run(batchId, projectId, task.id, userGuidance, DIVERSITY_TEMPERATURE, Math.min(opportunities.length, 100), principal.userId, now);
        for (const opportunity of opportunities.slice(0, 100)) {
          this.insertAnalyzedOpportunity(projectId, task.id, opportunity, gapIdMap, principal.userId, now, batchId);
        }
        this.database.prepare(
          `UPDATE analysis_tasks SET status='completed', error=NULL, completed_at=?, updated_at=? WHERE id=?`,
        ).run(now, now, task.id);
      });
      this.record(project, principal, 'topic-opportunity.refresh', 'analysis_task', task.id, {
        projectId, batchId, opportunityCount: opportunities.length, gapCatalogSize: gaps.length,
        hasUserGuidance: Boolean(userGuidance), existingTitleCount: existingTitles.length,
      });
      return {
        task: this.mapTask(this.taskRow(task.id)),
        batchId,
        topicOpportunities: this.listOpportunities(projectId),
      };
    } catch (error) {
      this.failTask(task.id, error);
      throw error;
    }
  }
```

关键变化：①删掉 898-901 的软删循环；②新建 batch 记录；③insertAnalyzedOpportunity 传 batchId；④prompt 传 userGuidance+existingTitles；⑤第 6 参传高温 0.85。

> **注意 fingerprint 缓存**：原指纹 `${fingerprint}:topic-refresh` 现加 `:${batchId}` 后缀，保证每次换一批都是新任务（不命中缓存）。确认 `createTask` 不会因指纹重复而复用旧任务——Read `createTask` 与 `cachedTask` 确认换一批本就不查缓存（原代码就没查，直接 createTask）。

- [ ] **Step 5: 验证 tsc + 现有测试**

```bash
cd apps/api && npx tsc --noEmit && npm test
```
预期：tsc PASS。测试对比基线——已知 4 个 pre-existing 失败（generation/intelligence 的 model-provider Invalid JSON），只要不新增失败即可。若新增失败，root-cause 后再提交。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/intelligence.service.ts
git commit -m "feat(api): diverse refresh via high temperature + prompt anti-repeat + user guidance; batches append instead of deleting"
```

---

### Task 3: 后端 — 收藏/归档 + 批次筛选 + 引导词模板 CRUD

**为什么：** 永久保留的选题需要能收藏、归档、按批次/状态筛选；用户引导词需要能存成模板复用。这些是新的读写能力。

**Files:**
- Modify: `apps/api/src/intelligence.service.ts` — 加 `setOpportunityCollectionStatus`、`listBatches`、扩展 `listOpportunities` 支持筛选；加引导词模板 CRUD 方法
- Modify: `apps/api/src/intelligence.controller.ts` — 加对应路由

**Interfaces:**
- `setOpportunityCollectionStatus(projectId, id, status: 'active'|'collected'|'archived', principal)` → 更新单个选题收藏状态
- `listBatches(projectId)` → 返回该项目所有批次元信息
- 引导词模板：`listPromptTemplates` / `createPromptTemplate` / `deletePromptTemplate`

- [ ] **Step 1: 收藏/归档方法**

在 `intelligence.service.ts` 加（放在 `refreshTopicOpportunities` 附近）：

```typescript
  setOpportunityCollectionStatus(
    projectId: string,
    opportunityId: string,
    status: 'active' | 'collected' | 'archived',
    principal: SessionPrincipal,
  ): Record<string, unknown> {
    const project = this.resources.projectRow(projectId);
    const row = this.row('topic_opportunities', projectId, opportunityId); // this.row 已带 deleted_at IS NULL 校验
    this.database.prepare(
      `UPDATE topic_opportunities SET collection_status=?, updated_at=? WHERE id=?`,
    ).run(status, nowIso(), opportunityId);
    this.record(project, principal, 'topic-opportunity.collection', 'topic_opportunity', opportunityId, { projectId, status });
    return this.mapOpportunity(this.row('topic_opportunities', projectId, opportunityId));
  }
```

先 Read `this.row` 与 `mapOpportunity` 签名确认实参（探查报告：`row(table, projectId, id)`；`mapOpportunity(row, ranked?)` 可只传 row）。

- [ ] **Step 2: listOpportunities 支持筛选 + listBatches**

扩展 `listOpportunities`（370 行）为可选筛选（保持无参调用向后兼容）：

```typescript
  listOpportunities(
    projectId: string,
    filter: { batchId?: string; collectionStatus?: 'active' | 'collected' | 'archived' } = {},
  ): Record<string, unknown>[] {
    this.resources.projectRow(projectId);
    const clauses = ['project_id=?', 'deleted_at IS NULL'];
    const params: unknown[] = [projectId];
    if (filter.batchId) { clauses.push('batch_id=?'); params.push(filter.batchId); }
    if (filter.collectionStatus) { clauses.push('collection_status=?'); params.push(filter.collectionStatus); }
    const rows = this.database.prepare(
      `SELECT * FROM topic_opportunities WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    ).all(...params) as Record<string, unknown>[];
    return this.mapOpportunityRows(projectId, rows);
  }

  listBatches(projectId: string): Record<string, unknown>[] {
    this.resources.projectRow(projectId);
    return (this.database.prepare(
      `SELECT b.*, COUNT(o.id) AS live_count
       FROM opportunity_batches b
       LEFT JOIN topic_opportunities o ON o.batch_id=b.id AND o.deleted_at IS NULL
       WHERE b.project_id=? GROUP BY b.id ORDER BY b.created_at DESC`,
    ).all(projectId) as Record<string, unknown>[]).map((row) => ({
      id: row.id, projectId: row.project_id, trigger: row.trigger,
      userGuidance: row.user_guidance, temperature: row.temperature,
      opportunityCount: Number(row.opportunity_count), liveCount: Number(row.live_count),
      createdAt: row.created_at,
    }));
  }
```

> `mapOpportunity`/`mapOpportunityRows` 需把新列 `collection_status`、`batch_id` 带到输出。Read `mapOpportunity`（约 1883 行）在返回对象里加 `collectionStatus: row.collection_status, batchId: row.batch_id`。

- [ ] **Step 3: 引导词模板 CRUD**

```typescript
  listPromptTemplates(projectId: string): Record<string, unknown>[] {
    this.resources.projectRow(projectId);
    return (this.database.prepare(
      `SELECT * FROM opportunity_prompt_templates WHERE project_id=? AND deleted_at IS NULL ORDER BY updated_at DESC`,
    ).all(projectId) as Record<string, unknown>[]).map((row) => ({
      id: row.id, projectId: row.project_id, label: row.label, guidance: row.guidance,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  createPromptTemplate(projectId: string, label: string, guidance: string, principal: SessionPrincipal): Record<string, unknown> {
    const project = this.resources.projectRow(projectId);
    const cleanLabel = label.trim().slice(0, 80);
    const cleanGuidance = guidance.trim().slice(0, 600);
    if (!cleanLabel || !cleanGuidance) throw new BadRequestException('模板名称和引导词不能为空');
    const id = randomUUID();
    const now = nowIso();
    this.database.prepare(
      `INSERT INTO opportunity_prompt_templates (id, project_id, label, guidance, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, cleanLabel, cleanGuidance, principal.userId, now, now);
    this.record(project, principal, 'prompt-template.create', 'prompt_template', id, { projectId });
    return this.listPromptTemplates(projectId).find((t) => t.id === id)!;
  }

  deletePromptTemplate(projectId: string, templateId: string, principal: SessionPrincipal): void {
    const project = this.resources.projectRow(projectId);
    this.database.prepare(
      `UPDATE opportunity_prompt_templates SET deleted_at=? WHERE id=? AND project_id=?`,
    ).run(nowIso(), templateId, projectId);
    this.record(project, principal, 'prompt-template.delete', 'prompt_template', templateId, { projectId });
  }
```

- [ ] **Step 4: 控制器路由**

在 `intelligence.controller.ts` 加（放在现有 topic-opportunities 路由附近，注意具体路由要在 `:id` 参数路由之前避免匹配冲突）：

```typescript
  @Post('topic-opportunities/:id/collection')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  setCollection(@Req() request: Request, @Param('projectId') projectId: string, @Param('id') id: string, @Body() body: unknown) {
    const b = requireObject(body);
    const status = b.status === 'collected' || b.status === 'archived' || b.status === 'active' ? b.status : undefined;
    if (!status) throw new BadRequestException('status 必须是 active/collected/archived');
    return this.intelligence.setOpportunityCollectionStatus(projectId, id, status, this.principal(request));
  }

  @Get('topic-opportunity-batches')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listBatches(@Req() request: Request, @Param('projectId') projectId: string) {
    return this.intelligence.listBatches(projectId);
  }

  @Get('opportunity-prompt-templates')
  @RequirePermission({ permission: 'project.read', projectParam: 'projectId' })
  listTemplates(@Req() request: Request, @Param('projectId') projectId: string) {
    return this.intelligence.listPromptTemplates(projectId);
  }

  @Post('opportunity-prompt-templates')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  createTemplate(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const b = requireObject(body);
    return this.intelligence.createPromptTemplate(projectId, String(b.label ?? ''), String(b.guidance ?? ''), this.principal(request));
  }

  @Delete('opportunity-prompt-templates/:templateId')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  deleteTemplate(@Req() request: Request, @Param('projectId') projectId: string, @Param('templateId') templateId: string) {
    this.intelligence.deletePromptTemplate(projectId, templateId, this.principal(request));
    return { ok: true };
  }
```

同时改换一批路由，让它接收 userGuidance body：

```typescript
  @Post('topic-opportunities/refresh')
  @RequirePermission({ permission: 'project.write', projectParam: 'projectId' })
  refresh(@Req() request: Request, @Param('projectId') projectId: string, @Body() body: unknown) {
    const b = requireObject(body ?? {});
    const userGuidance = typeof b.userGuidance === 'string' ? b.userGuidance : undefined;
    return this.intelligence.refreshTopicOpportunities(projectId, this.principal(request), { userGuidance });
  }
```

先 Read 现有 refresh 路由与 topic-opportunities 路由块，确认 `@Delete`/`@Get`/`requireObject`/`RequirePermission` 已导入、路由前缀（`@Controller` 的 base path）与 `:id` 顺序。**具体静态路由必须声明在 `:id` 动态路由之前。**

- [ ] **Step 5: 验证 + 提交**

```bash
cd apps/api && npx tsc --noEmit && npm test
git add apps/api/src/intelligence.service.ts apps/api/src/intelligence.controller.ts
git commit -m "feat(api): opportunity collection status, batch listing, and reusable prompt templates"
```

---

### Task 4: 前端 — API 客户端与类型

**为什么：** 前端需要新的 api 方法调用收藏/归档/批次/模板/带引导词的换一批，以及对应类型。

**Files:**
- Modify: `apps/web/src/lib/api.ts` — 扩展 `opportunities`，加 `promptTemplates`
- Modify: `apps/web/src/types.ts` — 加 `OpportunityBatch`、`PromptTemplate`；给 `TopicOpportunity` 加 `collectionStatus`/`batchId`

**Interfaces:**
- `opportunities.refresh(projectId, userGuidance?: string)` — body 带引导词
- `opportunities.setCollection(projectId, id, status)`
- `opportunities.listBatches(projectId)`
- `promptTemplates.list/create/remove`

- [ ] **Step 1: types.ts**

```typescript
export interface OpportunityBatch {
  id: string;
  projectId: string;
  trigger: string;
  userGuidance: string;
  temperature: number | null;
  opportunityCount: number;
  liveCount: number;
  createdAt: string;
}

export interface PromptTemplate {
  id: string;
  projectId: string;
  label: string;
  guidance: string;
  createdAt: string;
  updatedAt: string;
}
```

给现有 `TopicOpportunity` 接口加两字段：`collectionStatus?: "active" | "collected" | "archived";` 和 `batchId?: string | null;`（先 Read `TopicOpportunity` 定义确认位置）。

- [ ] **Step 2: api.ts — opportunities 扩展**

改 `refresh`（约 878 行）带 body，并新增方法：

```typescript
    refresh: async (projectId: string, userGuidance?: string) => {
      const result = await request<{ topicOpportunities: JsonRecord[] }>(
        `/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/refresh`,
        { method: "POST", body: JSON.stringify(userGuidance ? { userGuidance } : {}) },
      );
      return { items: (result.topicOpportunities ?? []).map(normalizeOpportunity) };
    },
    setCollection: (projectId: string, id: string, status: "active" | "collected" | "archived") =>
      request<JsonRecord>(
        `/api/projects/${encodeURIComponent(projectId)}/topic-opportunities/${encodeURIComponent(id)}/collection`,
        { method: "POST", body: JSON.stringify({ status }) },
      ).then(normalizeOpportunity),
    listBatches: (projectId: string) =>
      request<OpportunityBatch[]>(`/api/projects/${encodeURIComponent(projectId)}/topic-opportunity-batches`),
```

先 Read 现有 `opportunities.refresh`/`normalizeOpportunity` 确认返回形态（探查报告：refresh 现返回 `topicOpportunities` 数组）。

- [ ] **Step 3: api.ts — promptTemplates 块**

新增顶层块（与 `opportunities` 平级）：

```typescript
  promptTemplates: {
    list: (projectId: string) =>
      request<PromptTemplate[]>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates`),
    create: (projectId: string, label: string, guidance: string) =>
      request<PromptTemplate>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates`,
        { method: "POST", body: JSON.stringify({ label, guidance }) }),
    remove: (projectId: string, templateId: string) =>
      request<void>(`/api/projects/${encodeURIComponent(projectId)}/opportunity-prompt-templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE" }),
  },
```

把 `OpportunityBatch`/`PromptTemplate` 加进 `../types` 导入。

- [ ] **Step 4: 验证 + 提交**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/lib/api.ts apps/web/src/types.ts
git commit -m "feat(web): api client for opportunity collection, batches, and prompt templates"
```

---

### Task 5: 前端 — 换一批引导词输入 + 收藏/归档/筛选交互

**为什么：** 把新能力接入第二步 UI：换一批前可填引导词（可选模板）、选题卡可收藏/归档、按状态/批次筛选。

**Files:**
- Modify: `apps/web/src/pages/IntelligentSimpleFlow.tsx`
- Modify: `apps/web/src/styles.css`（复用现有类，必要时加少量）

**Interfaces:** 消费 Task 4 的 api 方法。

- [ ] **Step 1: 状态与数据加载**

在选题相关 state 附近加：

```typescript
  const [guidance, setGuidance] = useState("");
  const [showGuidance, setShowGuidance] = useState(false);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [collectionFilter, setCollectionFilter] = useState<"all" | "active" | "collected" | "archived">("all");
```

在加载 opportunities 的 effect 里并行拉模板：`api.promptTemplates.list(projectId).then(setTemplates).catch(() => undefined);`

- [ ] **Step 2: 换一批改造**

`refreshOpportunities`（约 422 行）改为传引导词，并在成功后刷新批次/清空引导词输入：

```typescript
  const refreshOpportunities = async () => {
    setRefreshing(true);
    try {
      const result = await api.opportunities.refresh(projectId, guidance.trim() || undefined);
      setOpportunities(result.items);
      setSelectedOpportunityId("");
      toast.push(`已追加一批新选题（${result.items.length} 个）；旧选题已保留`, "info");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "选题刷新失败", "error");
    } finally {
      setRefreshing(false);
    }
  };
```

> 注意：不再 `await load()` 全量重置，避免覆盖筛选态；`result.items` 已含全部保留的选题（后端 refresh 返回 `listOpportunities` 全量）。

- [ ] **Step 3: 引导词输入区（换一批按钮旁）**

在第二步标题区/按钮旁加一个可展开的引导词输入：

```tsx
  <div className="opportunity-guidance">
    <button type="button" className="link-button" onClick={() => setShowGuidance((v) => !v)}>
      {showGuidance ? "收起方向引导" : "＋ 添加方向引导（可选）"}
    </button>
    {showGuidance && (
      <div className="guidance-panel">
        <textarea
          value={guidance} rows={2} maxLength={600}
          placeholder="用一句话引导本批选题方向，例如：多聚焦术后恢复期的真实顾虑；可临时放宽到相邻话题。"
          onChange={(e) => setGuidance(e.target.value)}
        />
        {templates.length > 0 && (
          <div className="guidance-templates">
            {templates.map((t) => (
              <button type="button" key={t.id} className="chip" onClick={() => setGuidance(t.guidance)}>{t.label}</button>
            ))}
          </div>
        )}
        <div className="guidance-actions">
          <button type="button" className="link-button" disabled={!guidance.trim()}
            onClick={async () => {
              const label = window.prompt("给这段引导词起个名字，方便复用");
              if (!label?.trim()) return;
              try {
                const created = await api.promptTemplates.create(projectId, label.trim(), guidance.trim());
                setTemplates((cur) => [created, ...cur]);
                toast.push("引导词已保存为模板", "info");
              } catch (err) { toast.push(err instanceof Error ? err.message : "保存失败", "error"); }
            }}>保存为模板</button>
        </div>
      </div>
    )}
  </div>
```

- [ ] **Step 4: 收藏状态筛选 + 卡片操作**

(a) 筛选器（选题网格上方）：

```tsx
  <div className="opportunity-filter">
    {(["all", "active", "collected", "archived"] as const).map((f) => (
      <button type="button" key={f} className={collectionFilter === f ? "chip chip--active" : "chip"}
        onClick={() => setCollectionFilter(f)}>
        {{ all: "全部", active: "未处理", collected: "已收藏", archived: "已归档" }[f]}
      </button>
    ))}
  </div>
```

(b) 渲染前按筛选过滤（替换现有直接 map `opportunities`）：

```typescript
  const visibleOpportunities = useMemo(
    () => opportunities.filter((o) => collectionFilter === "all" || (o.collectionStatus ?? "active") === collectionFilter),
    [opportunities, collectionFilter],
  );
```

把 753 区块的 `opportunities`/`showAllOpportunities ? opportunities : opportunities.slice(0,12)` 改用 `visibleOpportunities`。

(c) 卡片加收藏/归档按钮（在现有"编辑度量""删除"旁）：

```tsx
  <button type="button" className="icon-button" title={item.collectionStatus === "collected" ? "取消收藏" : "收藏"}
    onClick={(e) => { e.stopPropagation(); void toggleCollection(item, "collected"); }}>
    <Star size={15} className={item.collectionStatus === "collected" ? "filled" : ""} />
  </button>
  <button type="button" className="icon-button" title={item.collectionStatus === "archived" ? "取消归档" : "归档"}
    onClick={(e) => { e.stopPropagation(); void toggleCollection(item, "archived"); }}>
    <Archive size={15} />
  </button>
```

(d) `toggleCollection` 处理：

```typescript
  const toggleCollection = async (item: TopicOpportunity, target: "collected" | "archived") => {
    const next = item.collectionStatus === target ? "active" : target;
    try {
      const updated = await api.opportunities.setCollection(projectId, item.id, next);
      setOpportunities((cur) => cur.map((o) => (o.id === updated.id ? updated : o)));
    } catch (err) { toast.push(err instanceof Error ? err.message : "操作失败", "error"); }
  };
```

从 `lucide-react` 导入 `Star`、`Archive`（先确认未导入）。

- [ ] **Step 5: 更新换一批说明文案**

之前那条 `.opportunity-refresh-note` 要改：不再说"只替换未确认的草稿"，改为反映新语义：

> "换一批"会基于现有蓝图和已确认信息缺口**重新生成一批新选题并追加保留**（约几十秒，消耗一次模型额度）；可填写方向引导词控制生成重点。旧选题不会被删除，可在上方按"未处理/已收藏/已归档"筛选。

- [ ] **Step 6: 样式**

在 styles.css 加（复用现有 chip/panel 风格；先 grep 是否已有 `.chip`）：

```css
.opportunity-guidance { margin: 8px 0 4px; }
.guidance-panel { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.guidance-panel textarea { width: 100%; resize: vertical; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border, #e5e7eb); font-size: 13px; }
.guidance-templates, .opportunity-filter { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border, #e5e7eb); background: #fff; font-size: 12px; cursor: pointer; }
.chip--active { background: var(--accent-soft, rgba(59,130,246,0.1)); border-color: var(--accent, #3b82f6); color: var(--accent, #3b82f6); }
.icon-button .filled { fill: currentColor; color: #f59e0b; }
```

若 `.chip` 已存在则不重复定义，只加缺失的。

- [ ] **Step 7: 验证 + 提交**

```bash
cd apps/web && npx tsc --noEmit
git add apps/web/src/pages/IntelligentSimpleFlow.tsx apps/web/src/styles.css
git commit -m "feat(web): guidance-driven refresh, collection/archive, and status filtering for topics"
```

---
### Task 6: 端到端验证（迁移 + 多样性 + 永久保留 + 引导词）

**为什么：** 这次改了 schema、生成逻辑、交互，纯 tsc 不足以证明真的可用。需要对真实运行的 API 做端到端验证。

**前置：** 服务器跑主目录 main 分支（tsx --watch 会自动重载后端改动）。前端 Vite HMR 自动生效。

- [ ] **Step 1: 迁移落库验证**

重启后（或 watch 重载后）对 dev DB 查：`PRAGMA user_version` = 9；`PRAGMA table_info(topic_opportunities)` 含 `batch_id`、`collection_status`；`opportunity_batches`、`opportunity_prompt_templates` 表存在。用只读脚本查，不改数据。

- [ ] **Step 2: 换一批多样性验证（核心）**

对同一项目连续调两次 `refresh`（一次无引导词、一次带引导词），比较两批选题标题：
- 两批应有**明显不同**的标题（B 生效：已有标题被喂回、模型避开）。
- 带引导词那批应体现方向（如引导"聚焦术后恢复"则相关选题占比上升）。
- DB 中旧批次选题**仍在**（永久保留生效，`deleted_at IS NULL`，`batch_id` 不同）。
- `opportunity_batches` 新增两行，记录 trigger/user_guidance/temperature。

- [ ] **Step 3: 收藏/归档/筛选验证**

调 `setCollection` 把一个选题设 collected、一个设 archived，`listOpportunities` 返回的对应 `collectionStatus` 正确；前端筛选切换按预期显示/隐藏。

- [ ] **Step 4: 引导词模板验证**

`promptTemplates.create` → `list` 返回该模板；`remove` 后软删不再出现。

- [ ] **Step 5: 回归验证**

- 生成流程（选题→预览→生成）仍能走通（收藏状态不影响可选性；只有评审 `status` 和依赖门控影响）。
- `cd apps/api && npm test` 与基线一致（探查报告基线：4 个预存失败，无新增回归）。

- [ ] **Step 6: 清理临时验证脚本**

删除验证过程中在 `$CLAUDE_JOB_DIR/tmp` 建的脚本，不留在仓库。

---

## Self-Review

**需求覆盖：**
- 用户决策1（全部保留+批次+收藏/归档/筛选）→ Task 1（schema）+ Task 2（换一批改追加）+ Task 3（collection API）+ Task 5（筛选 UI）。
- 用户决策2（引导词作用于生成+可保存复用）→ Task 2（prompt 注入 userGuidance）+ Task 3（模板 CRUD）+ Task 5（输入+模板 UI）。
- 用户决策3（A+B 高强度）→ Task 2（A：温度透传调高；B：existingTitles 喂回 prompt 令避开）。
- 换一批未收藏草稿处理（新批次追加，全保留）→ Task 2 删除软删循环 + batch_id。
- 引导词与项目知识关系（强方向可临时放宽）→ Task 2 prompt 文案明确 "strong steer, may broaden scope"。

**正交性检查：** `status`（评审）/`collection_status`（收藏）/`batch_id`（批次）三维独立，互不干扰；不动 `status` CHECK 约束，规避 SQLite 重建表风险。

**占位符扫描：** 所有代码步骤含具体代码；类名/行号标注为"以磁盘为准需 Read 确认"，非 TBD。

**风险与缓解：**
1. temperature 三层透传易漏改调用点 → Task 2 Step 1 明确其余 5 个调用点不传参、行为不变。
2. 前端 refresh 不再 `load()` 全量重置 → 明确 `result.items` 已含全量保留选题，避免筛选态被覆盖。
3. 高温度可能偶发 JSON 不合法 → 现有 `retryAnalysis` 重试 + `response_format: json_object` 兜底；若频繁失败，Task 6 记录并把换一批温度从 0.9 降到 0.7。

**待你确认的开放项（实现前）：**
- 换一批温度定多少（建议 0.8；范围 0.7–0.9）。
- `existingTitles` 上限 60 条是否够（大项目选题多时，喂太多会挤占 prompt；60 条约 2–3 千字）。
- 是否需要"按批次查看/对比"UI（当前 Task 5 只做状态筛选，批次列表 API 备好但未做 UI，可留 P2）。

