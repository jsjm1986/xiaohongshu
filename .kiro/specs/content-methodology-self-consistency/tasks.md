# 实现计划：内容方法论自洽性修复

## Overview（概述）

按设计的组件依赖顺序落地五处 A 类方法论自洽性修复，顶层任务共 8 个，顺序为：任务1 组件A·M10（地基：分离结构有效性与预测表现）→ 任务2 组件B·M2 后端（放开度量门禁 + 保留硬门禁）→ 任务3 组件B·M2 前端（停止默认注入）→ 任务4 检查点 → 任务5 组件C·M3（排序建议化）→ 任务6 组件D·M6（三阶段串联）→ 任务7 组件E·M7（中等偏保守收敛）→ 任务8 整体校验收尾。语言为 TypeScript；属性测试用 `fast-check`（`numRuns ≥ 100`）覆盖 P1–P9，作为相关实现任务的带 `*` 子任务。

## Tasks

- [x] 1. 组件A · M10：分离"结构有效性"与"预测表现"（地基）
  - [x] 1.1 解耦 `opportunityMetricReview`
    - `apps/api/src/intelligence.service.ts`：不再用 `unknownMetrics` 覆盖资格状态；输出 `metricStatus`/`unknownMetrics` 作为预测轴独立字段，`eligibility` 由用户/分析显式断言
    - _需求: 1.1, 1.2_ _设计: 组件A_
  - [x] 1.2 规范化函数两轴分列
    - `canonicalOpportunityData`/`normalizeOpportunity`/`normalizeGap`/`normalizeImageAnalysis`：结构字段（`eligibility`/`gapIds`/依赖快照）与预测字段（度量/`metricStatus`）分列、互不推导；未知时 `score=null` 不补零
    - _需求: 1.2, 1.6_ _设计: 组件A / Data Models §1_
  - [x] 1.3 呈现层标注参考性
    - `mapOpportunity` 输出保留 `heuristic(weightsCalibrated:false)`/`scoreSemantics` 标识，前端据此标注"参考、非授权依据"
    - _需求: 1.5_ _设计: 组件A_
  - [x]* 1.4 P1 属性测试（fast-check）：结构与预测字段相互独立
    - **Property 1：结构有效性与预测表现字段相互独立**
    - **Validates: Requirements 1.2**
    - _设计: 组件A_
- [x] 2. 组件B · M2（后端）：放开度量门禁，未知度量放行，保留硬门禁
  - [x] 2.1 放开 `assertResourceMetricsReady` 的度量完备性门禁
    - `apps/api/src/intelligence.service.ts`：移除 `information_gaps` 三项（importance/decisionLeverage/proofability）与 `image_analysis_versions` 三项（clarity/relevance/textLegibility）的度量必填分支；未知度量放行
    - _需求: 2.1, 2.2, 2.3_ _设计: 组件B(B2)_
  - [x] 2.2 放开 `assertOpportunityReviewFields`
    - 移除"未知度量→抛错"分支；仅保留 `status==='blocked'→抛错` 与非 `eligible→抛错` 的结构判定
    - _需求: 2.4_ _设计: 组件B(B2)_
  - [x] 2.3 放开 `assertOpportunitySelectable`/`prepareGeneration`/`approveResource`
    - 不再因"未知度量导致的 review_required"阻断；仅结构原因（blocked/空 topic/空 gapIds）阻断；未知度量沿正常路径原样透传给规划引擎，不补零/中位值/默认值
    - _需求: 2.5, 2.6, 2.7_ _设计: 组件B(B2)_
  - [x] 2.4 明确保留全部硬门禁（一字不动） + 命中即拒绝不持久化
    - 保留：禁止声明、证据落地、蓝图完整性、缺口引用、依赖新鲜度、`blocked`；命中任一硬门禁则拒绝对应审批/生成、抛错在持久化之前、不写入任何审批结果或生成输出，并返回指明门禁的原因；仅移除"强制编造数值度量"这一项
    - _需求: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_ _设计: 组件B(B3) / Error Handling_
  - [x] 2.5 历史 0.5/0.3 数据处理策略
    - 读取即按已知数值解释，不做破坏性迁移（数据层无法区分默认与真实输入）；从此刻起留空一律为未知
    - _需求: 2.2_ _设计: 组件B(B5)_
  - [x]* 2.6 P2 属性测试（fast-check）：未知度量往返保真
    - **Property 2：未知度量往返保真**
    - **Validates: Requirements 2.1, 2.2, 2.6, 2.8**
    - _设计: 组件B(B1)_
  - [x]* 2.7 P3 属性测试（fast-check）：未知度量不改变硬门禁结论
    - **Property 3：未知度量不改变硬门禁结论**
    - **Validates: Requirements 1.3, 1.6, 2.3, 2.4, 2.5, 2.7, 3.9**
    - _设计: 组件A / 组件B(B3)_
  - [x]* 2.8 P6 属性测试 + 硬门禁示例（fast-check）：保留门禁恒阻断且命中即拒绝
    - **Property 6：保留的硬门禁恒阻断且命中即拒绝**
    - **Validates: Requirements 3.1, 3.2, 3.6, 3.8, 3.10**
    - 补充示例：缺蓝图模块(3.3)/空缺口引用(3.4)/依赖快照过期(3.5)各一例抛错且不持久化；确认仅移除度量门禁(3.7)
    - _需求: 3.3, 3.4, 3.5, 3.7_ _设计: 组件B(B3)_
- [x] 3. 组件B · M2（前端）：停止默认注入
  - [x] 3.1 `saveGap` 停止默认注入
    - `apps/web/src/pages/IntelligentSimpleFlow.tsx`：删除 `importance ?? 0.5 / decisionLeverage ?? 0.5 / proofability ?? 0.3` 注入；留空字段不写入该键（提交为未知）；用户显式的 `0..1` 值原样提交
    - _需求: 4.1, 4.2, 4.5_ _设计: 组件B(B4)_
  - [x] 3.2 `saveOpportunity` 停止默认注入
    - 删除七项 `?? 0.5 / ?? 0.3` 注入与 `eligibilityStatus || 'eligible'` 隐式兜底；留空即未知；资格状态由用户显式选择，不因度量留空被改写
    - _需求: 4.1, 4.3, 4.5_ _设计: 组件B(B4)_
  - [x] 3.3 图片质量度量三态控件
    - `qualityDraft`/`openQualityEditor`/`approveAsset`/`saveQuality`：不再以 `0.5` 预填；质量度量（clarity/relevance/textLegibility）未设置=未知；滑杆改为"可清空/未设置"三态
    - _需求: 4.1, 4.4_ _设计: 组件B(B4)_
  - [x] 3.4 移除 `approvePlanningResources` 的 `gapMetricsMissing` 前置拦截
    - 不再要求补齐度量才能确认；未知度量沿正常路径提交
    - _需求: 2.3_ _设计: 组件B(B4)_
  - [x] 3.5 未知呈现与无效输入处理
    - 度量为未知时显示"未知/待复核"（复用 `resolveOpportunityRankView` 的 unknown 分支），不显示 0/默认值；非数值或越界输入不提交该值、不以默认替代，并就地提示更正
    - _需求: 4.6, 4.7_ _设计: 组件B(B4)_
  - [x]* 3.6 P5 属性测试（fast-check）：前端留空即未知、填值原样、无默认注入
    - **Property 5：前端留空即未知、填值即原样、绝不注入默认**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
    - 建议将载荷构造抽为纯函数以便测试
    - _设计: 组件B(B4)_

- [x] 4. 检查点 —— 地基与 M10/M2 收口
  - 运行相关测试确保任务 1–3 全部通过；如有疑问询问用户后再继续
- [x] 5. 组件C · M3：机会排序启发式仅作建议,不作门禁
  - [x] 5.1 `filterTopicOpportunities` 降为结构过滤
    - `packages/agent-core/src/planning.ts`：移除 `minProofability`/`maxRisk` 筛除;仅保留结构条件（非 `blocked`、有 topic、有 `gapIds`）;未知度量不再被排除
    - _需求: 5.3, 5.4_ _设计: 组件C(C1)_
  - [x] 5.2 `evaluateOpportunity` 阈值移出 `hardReasons`
    - 从 `hardReasons` 移除 `proofability<minProofability`、`risk>maxRisk` 两条;`hardReasons` 仅留结构原因,`effectiveEligibility` 的 `ineligible` 仅由结构触发;阈值转为 `advisoryNote` 排序输入
    - _需求: 5.2, 5.4_ _设计: 组件C(C2)_
  - [x] 5.3 `engine.ts · resolveGenerationPlanning` 保留全部结构可选择候选
    - 锁定路径不因阈值判 "not feasible"（仅结构不合法才拒绝）;排序路径在结构可选集合内按 `rank` 取默认,`finalScore=null` 不排除候选;排序仅决定默认呈现/默认选择,不决定可选择性
    - _需求: 5.2, 5.3, 5.7_ _设计: 组件C(C3)_
  - [x] 5.4 披露:未标定状态与非预测说明
    - 确认 `OpportunityRankHeuristicV1` 描述符含 `weightsCalibrated:false`;披露视图展示未标定状态与"非平台效果/阅读量/转化预测"说明;审批/生成门禁路径不读取 `finalScore`/`baseScore`
    - _需求: 5.1, 5.5, 5.6_ _设计: 组件C(C4)_
  - [x]* 5.5 P7 属性测试（fast-check）：候选可选择性在排序下守恒
    - **Property 7：候选可选择性在排序下守恒**
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - _设计: 组件C_
  - [x]* 5.6 P4 属性测试（fast-check）：排序分数不作为门禁依据
    - **Property 4：排序分数不作为门禁依据**
    - **Validates: Requirements 1.4, 5.7**
    - _设计: 组件A / 组件C_

- [x] 6. 组件D · M6：串联三阶段项目分析
  - [x] 6.1 阶段串联数据流
    - `apps/api/src/intelligence.service.ts · analyzeProject`：阶段2 消费阶段1 结构化蓝图,阶段3 消费阶段2 `gapCatalog` + `expressionStrategies` 摘要;`projectPlanningResourcesPrompt`/`projectOpportunityAnalysisPrompt` 新增上一阶段结构化输入参数（schema 不变）
    - _需求: 6.1, 6.2, 6.3_ _设计: 组件D(D1)_
  - [x] 6.2 前阶段缺必需内容即刻报错终止（fail-fast）
    - 蓝图完整性校验前移至阶段1后、阶段2前,缺失即抛错终止并指明缺失模块;阶段2后 `informationGaps` 为空即抛错终止;不以空输入发起后续阶段
    - _需求: 6.6_ _设计: 组件D(D2)_
  - [x] 6.3 保留审批检查点与下游 schema
    - 各阶段产物仍以 `status='draft'` 落库并独立审批;下游依赖的输出 schema 不变;三阶段各自重试/缓存不变
    - _需求: 6.4, 6.5_ _设计: 组件D_
  - [x]* 6.4 P8 属性测试（fast-check）：缺必需内容即刻报错终止
    - **Property 8：三阶段串联缺必需内容即刻报错终止**
    - **Validates: Requirements 6.6**
    - _设计: 组件D_
  - [x]* 6.5 三阶段装配单测：顺序与串联入参
    - mock provider 记录调用顺序与入参;断言顺序固定、阶段2/3 入参含上一阶段结构化输出、各产物 `status='draft'`、schema 齐全
    - _需求: 6.1, 6.2, 6.3, 6.4, 6.5_ _设计: 组件D_
- [x] 7. 组件E · M7：收敛评论网络复杂度（中等偏保守）
  - [x] 7.1 `discoveryPlan` 降为可选
    - `packages/agent-core/src/planning.ts`：`dialoguePlans` 允许产出精简形态,不强制完整 discoveryPlan
    - `packages/agent-core/src/content.ts`：缺失维持 `warning`;**保留** discoveryPlan 存在时三条安全校验为 `error`（`comment_discovery_withholding`/`comment_discovery_false_closure`/`comment_discovery_as_evidence`）
    - _需求: 7.1, 7.2, 7.5_ _设计: 组件E(E1/E2)_
  - [x] 7.2 `densityProxy` 降为可选审计
    - `packages/agent-core/src/planning.ts`：`hasDensityContract` 收敛为 `roleCard || primaryGapId`
    - `packages/agent-core/src/content.ts`：移除 `comment_density_metadata_incomplete` 因缺 `densityProxy` 的强制;**保留** `comment_gap_multiplexing_exceeded`
    - _需求: 7.1, 7.5_ _设计: 组件E(E1/E2)_
  - [x] 7.3 多轮 growth 改特性开关（默认保守）
    - `packages/agent-core/src/engine.ts`/`prompt.ts`：以生成参数（`commentConversationRate`/`followUpDepth`）控制 stage 2B;为 0 时跳过额外 LLM 调用,保留根评论优雅降级
    - _需求: 7.1, 7.5_ _设计: 组件E(E2)_
  - [x] 7.4 保留必需机制 + 记录逐机制判定依据
    - persona-scene、`dialoguePlans`、`gapCoverageLedger`、各安全/证据校验保留为正式生成必需项;以代码注释保留每机制"证据(a)/创作价值(b)/皆无(c)"判定及依据
    - _需求: 7.2, 7.6, 7.7_ _设计: 组件E(E1/E4)_
  - [x]* 7.5 P9 属性测试（fast-check）：收敛保持有效输出与管线可运行
    - **Property 9：评论编排收敛保持有效输出与管线可运行**
    - **Validates: Requirements 7.3, 7.4, 7.5**
    - _设计: 组件E_
  - [x]* 7.6 M7 必需性回归单测：证明必需项被保留
    - 禁用 persona-scene / `gapCoverageLedger` 导致校验或管线失败,验证其作为必需项被保留
    - _需求: 7.7_ _设计: 组件E(E3)_

- [x] 8. 整体校验与收尾（检查点）
  - 在 `content-agent/` 下依次运行 `npm run typecheck`、`npm test`（含 P1–P9 属性测试各 ≥100 迭代）、`npm run build`
  - 修复类型/测试/构建问题至全绿;记录任一失败属性测试的最小反例并据此定位;清理临时文件
  - 确保所有测试通过,如有疑问询问用户

## Notes（说明）

- 标记 `*` 的子任务为可选测试任务(属性/单元),可为 MVP 跳过;非标记子任务为核心实现,必须完成
- 任务严格按组件依赖排序:组件A(地基)→组件B(后端→前端)→组件C→组件D→组件E→整体校验
- 每条属性测试注释 `// Feature: content-methodology-self-consistency, Property {n}` 并以单一属性测试实现;属性测试与单元/示例测试互补
- 范围仅 A 类方法论自洽性修复(M2/M3/M6/M10/M7),不触碰 B 类工程缺陷,不引用其它 spec
- 需求覆盖:需求1→任务1;需求2→任务2/3;需求3→任务2(2.4 + P3/P6 于 2.7/2.8);需求4→任务3;需求5→任务5;需求6→任务6;需求7→任务7

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["2.1", "3.1", "5.1", "5.3"] },
    { "id": 4, "tasks": ["2.2", "3.2", "5.2"] },
    { "id": 5, "tasks": ["2.3", "3.3", "5.4", "5.5", "5.6"] },
    { "id": 6, "tasks": ["2.4", "3.4"] },
    { "id": 7, "tasks": ["2.5", "3.5", "2.6", "2.7", "2.8"] },
    { "id": 8, "tasks": ["6.1", "4", "3.6", "7.1"] },
    { "id": 9, "tasks": ["6.2", "7.2", "7.3"] },
    { "id": 10, "tasks": ["6.3", "7.4", "7.5", "6.4"] },
    { "id": 11, "tasks": ["6.5", "7.6"] },
    { "id": 12, "tasks": ["8"] }
  ]
}
```
