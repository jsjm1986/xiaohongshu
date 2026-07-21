# P0 公式与提示词实施报告

> 完成范围：R01—R06；日期：2026-07-13。R07 以后仍未批准，不能把本报告理解为 F01—F43 已全部获得现实效果验证。

## 已改变的生产行为

### R01：单一信息缺口真源

每个缺口现在由 `InformationGapPlanningCard` 同时保存问题、答案或框架、边界、优先级、证据与 `plannedPlacements`。`orchestrationPlan.channelAllocation` 仅是由卡片渲染的兼容视图；参数报告改名为 `advisoryAllocationPreview`，不再与最终位置同名，也不进入写作提示。关闭评论时不会再产生 Cref 分配或线程。

### R02：事实—位置—原文证据闭环

新事实台账必须包含：完整可见 `statement`、实际 `location`、唯一 `occurrence`、证据 ID，以及逐字 `sourceSpans.quote`。评论事实必须定位到 threadId/字段，追问还要定位 followUpIndex，不能跨线程复用同一句短语。校验器同时核对数字与单位、否定/不确定语气、声明覆盖度、来源角色与证据状态；`inference/hypothesis/unknown/prohibited/case` 不能直接支持 fact。

分节证据 ID 现在包含内容摘要；知识内容改变即产生新 ID。内容包保存文档/分节 checksum、全部被引用原文片段，而不是只保留第一段。修订会写入当次知识快照。多模态观察另建只含 `observedFacts/visibleText` 的证据快照，`inferredSignals` 不进入事实来源。

正例：正文出现“资料确认 A”，台账定位 `N.body`，并引用分节原文“资料确认 A”。  
反例：用“恢复期 70 天”支持“7 天”、用“产品”支持“产品采用某材料”、把普通确定性事实从 reasoning 删除，或拿推断材料支持事实——均不能通过。

### R03：计划完整度不等于实际解决率

规划阶段只记录 `ledgerCompleteness`，不再提前标记已解决。最终稿生成或修订后，系统按实际线程数重新检查答案/框架、条件或边界、证据映射、可找到位置及未知项的可见核验路径，写入 `realizedResolvedRate`。重复 gap 不会重复计分；删掉正文答案、漏掉计划位置或把线程绑定到错误主缺口都会失败。

### R04：未知保持未知

机会的七项指标缺失时保存 `null`，并标记 `unknownMetrics`、`metricStatus=unknown` 与 `reviewRequired`；不计算伪精确得分，也不能审批。缺口的 importance/decisionLeverage/proofability 和图片清晰度/相关性/文字可读性同样不得用 0.5 代填后审批；策略采样默认值明确标成 `default_policy`，不是测量值。选题不再隐式创建缺口或策略，且生成入队前会复核依赖的批准时间、内容摘要、启用状态和显式 strategyId；简单模式先阻断 unknown，再进行任何依赖操作。

### R05—R06：公式执行与提示隔离

公式 handler 使用覆盖 ID、方程、AST、变量、类型、标题、小白说明、用途、证据状态和直接提示标记的 canonical 语义指纹。任何可执行语义或提示文字变化都会变为 `pending_review`；未知公式为 `unreviewed`，均不能执行或进入提示。注册表只声明真正接线的 parameter/prompt/diagnostic handler，尚未 dispatch 的阶段单列，不再假装执行。显式空启用集会停止公式结果、公式行为指令、预设写作行为与诊断代理；硬安全不变量始终开启。

公式页只接受服务端确认的激活结果；失败不会本地伪装成功，并展示 review 状态与 effective handlers。写作模型只收到经审核的直接公式和已求出的编排合同；完整 ownership 审计仅保存在 `formulaSnapshot.executionAudit`。

## 提示词差异

- 删除：间接公式的 `<formula_execution_audit>` 全文。
- 删除：参数侧通道分配作为第二套写作真源。
- 新增：`gapPlanningCards[].plannedPlacements` 的唯一真源说明。
- 新增：逐可见事实的 `location + sourceSpans` 强制合同。
- 新增：评论事实的唯一 occurrence，以及图像观察的独立证据 ID。
- 保留：未知、冲突、禁止表达和模拟评论身份等不可关闭边界。

## 迁移影响

旧内容包仍可读取，但缺少 `sourceSpans/occurrence` 或生成后闭合结果时会显示为历史兼容/待核验；新生成包采用内容寻址的分节/图像证据 ID。旧客户端应优先读取 `ledgerCompleteness` 与 `realizedResolvedRate`，`closureRate` 仅为兼容别名；参数预览读取 `advisoryAllocationPreview`。未通过验证的候选可以保存用于诊断，但复制和导出被 UI 与服务端双重阻断。选题审批客户端必须先批准其明确引用的缺口和策略。

## 验证

- `npm run typecheck`
- `npm test`：core 94、web 21、API 26，共 141 项通过。
- `npm run typecheck` 与 `npm run build` 均通过。
- 覆盖：关闭评论、实际闭合、错主缺口、未知审批门槛、依赖过期、显式策略锁、AST/说明文字指纹漂移、空公式集、公式激活失败、间接审计不进提示、7/70 数字冲突、短词背书、普通事实漏台账、来源角色、多段引文、内容寻址和无效候选导出阻断。

## 证据边界

本轮没有把论文中的概念支持升级成平台因果规律。论文与官方平台来源仍保存在 `formula-evidence-catalog.json`，其“支持什么/不能推出什么”继续作为审计信息；将逐公式论文链接、反方证据和本次执行轨迹完整呈现在 UI 属于 R19，仍未获批，不伪装成已完成。
