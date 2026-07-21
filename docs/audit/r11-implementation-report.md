# R11 机会排序启发式实施报告

## 结论

当前候选选题排序已正式命名为 `OpportunityRankHeuristicV1`。它是确定性的产品内部排序工具，不是 F28“竞争信息机会”乘法公式，不是经过样本标定的预测模型，也不预测阅读量、转化率或因果效果。F28 继续保持 `protocol-only / not-running`；真实 Demand、竞品 Coverage 等观测不足时不计算。

## 算法与适用条件

七个输入都必须是 `[0,1]` 内的显式数值：相关性 `r`、重要性 `i`、可证实性 `p`、决策推动力 `l`、新颖度 `n`、认知成本 `c` 和风险 `q`。V1 的当前内部计算是：

`B = clip01(0.22r + 0.20i + 0.22p + 0.18l + 0.10n + 0.08(1-c) - 0.18q)`

`S = max(0, B - clip01(recentSimilarity × recentPenaltyWeight))`

七项固定权重随结果公开，并永久标记 `weightsCalibrated=false`。近期覆盖惩罚不是固定权重的一部分；本次 `recentPenaltyWeight`、资格阈值和冷却条数保存在独立 `policy` 快照。`S` 的语义是 `ordinal_noncausal_heuristic`，只用于同一候选集内排序。

列表、审批和生成共用 Core 导出的 `OpportunityRankHeuristicV1DefaultPolicy`，避免“界面可选、生成时却因另一套默认阈值被拒绝”。用户显式覆盖策略时，实际值与来源仍单独进入本次快照。

缺失、非有限或越界指标不会再被 `clamp` 成 0。近期历史未提供时也不会被当成“明确没有重合”：相关值和 `finalScore` 保持 `null`，候选进入 `review_required`。旧裸数值来源不明时可以保留清楚标识的预览，但 `rank=null`，不得自动选中。旧 `opportunity.score` 仅进入 `legacyInputScore`，并固定 `used=false`。

## 来源、审批与选择审计

每个分项都保存 `{source, sourceRef, note}`。用户直接填写标为 `user`；项目分析模型只能标为 `model_heuristic`；缺值标为 `unknown`；旧值标为 `legacy_unspecified`。客户端提交的派生排序字段和伪造来源会被清理。

机会列表、详情和审批都调用 Core 的同一排序器，API 不复制公式。审批时冻结 `approvalRankAudit`；再次编辑会使该审计和依赖快照失效。覆盖查询返回显式 `[]` 时表示“已查询且为零条”，省略才表示 unknown。

自动选择保存 `heuristic_ranked / applied` 和完整 `selectedOpportunityRank`；用户明确选中已审批机会时保存 `explicit_locked / not_applied`，不伪造排名。默认构造、修订继承和历史 unknown 在 UI 中分别陈述，不能统一冒充“用户锁定”。生成任务、三个内容包及 JSON/Markdown/DOCX/PDF 导出都保留该服务端快照。

## 提示词与界面边界

项目分析提示只允许模型逐项给出七个启发式判断或 `null`，明确禁止输出 score、rank、权重、F28 标签或因果声明。排序发生在 Core。排序审计、权重、贡献和旧 score 只保存在服务器/UI/导出中，已从初次写作和修复提示词剔除；写作模型只接收已经选定的主题依赖与具体编排合同。

选题卡显示分项原值、变换、固定权重、贡献、来源、unknown、复核原因、覆盖状态和策略阈值。结果页只读取生成时冻结的审计，不在浏览器重算。F28 页面明确显示“协议 ≠ 启发式”。

正例：七项均为用户复核值，覆盖账本已查询且为空；系统可给出可解释的 V1 顺序值，但仍显示“未标定、非因果、不是 F28”。

反例：风险缺失，或七项虽有数值却没有来源；系统显示 `unknown/review_required`，不会把缺失风险当低风险，也不会让旧 score 决定选题。

## 版本、迁移与验证

没有新增数据库列；现有 JSON 字段承载可向后兼容的审计。历史记录没有 V1 元数据时显示“历史值不参与当前排序”。默认公式仍为 `1.4.0`，digest `a84e41007c16a1e3a66e7bd88c36bcba3d29b0829cce4cdf7eba6df07540a902`；执行策略升级为 `3.4.0`，digest `233cfb983ebb431e6a8910e8e46e65b219fa37d8b6c6dfc892a3353a031b326d`。

根级验证通过：Core 117/117、Web 42/42、API 30/30；三工作区类型检查和生产构建均通过。证据目录含 43 条编号公式和两种方法；43 条编号公式与运行时方程、语义指纹、状态、实际执行、边界和阶段逐项比对为 0 差异。Web 构建仅保留既有的单 chunk 超过 500 kB 提示。
