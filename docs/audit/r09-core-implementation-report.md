# R09 条件计算器 Core 实施报告

> 日期：2026-07-13  
> R09/R08 合并版本：默认公式 `1.3.0`、执行策略 `3.2.0`；R10 后当前仓库为 `1.4.0/3.3.0`（F17/F21 语义指纹未变）  
> 范围：F17、F21 的 Core 变量、JSON AST、输入校验、API 计算端点、Web 输入控件、结果解释与审计指纹。

## 实施结果

F17 现在要求三个数值分别携带单位：`regretBeforeUnit`、`regretAfterUnit`、`cognitiveCostUnit`。三个单位必须非空且完全一致，才计算：

`V* = regretBefore − regretAfter − cognitiveCost`

缺少任一数值或单位时结果为 `unknown`；单位不一致或类型错误时结果同样为 `unknown`，并附带 `Validation error`。系统不尝试换算单位，也不会假设“元、分钟、分值”等可以直接相减。

F21 使用明确的条件概率变量：

`Ppath = pExposure × pNoticeGivenExposure × pEnterGivenNotice × pConsumeGivenEnter`

每个输入都必须位于闭区间 `[0,1]`。缺失输入保持 `unknown`；负数、超过 1 或错误类型不会被截断、补值或继续相乘，而会产生校验信息。

## 运行边界

两式仍为 `conditional / derived-calculator / calculation-only / fully-gated`。它们是用户显式填写后的手工情景计算器：

- `directGenerationInstruction=false`，不会进入写作公式提示；
- 计算结果只作为公式页手工情景结果供界面与审计查看；
- 规划、生成和选稿没有读取 `formulaResults` 的路径；
- 这些值不是平台概率、生成质量分或业务效果预测。

## 证据与验证

本轮没有增加或替换论文，也没有改变 F17/F21 的 `sourceIds`。现有来源只支持价值信息与顺序路径建模的概念边界，不提供项目数值。`formula-evidence-catalog.json` 已同步两个新 canonical fingerprint、公式版本 digest 和执行策略 digest。

定向测试覆盖：合法计算、缺失输入、单位冲突、概率越界、旧变量名淘汰及不参与直接生成。API 新增 `POST /api/formulas/:versionId/:formulaId/calculate`，只允许已复核、已启用的条件计算器，并统一调用 Core 校验。响应固定声明 `calculationOnly=true`、`directGeneration=false`，且生成、规划、选稿三个消费者均为 `false`。

公式页为 F17/F21 提供输入、计算和清空控件；浏览器不复制 AST 计算逻辑。输入不足显示 `unknown`，非法输入显示结构化错误，结果分别标为“净决策价值情景值”和“路径情景概率”，并醒目标明不是质量分。若服务端缺少上述边界声明，界面拒绝展示结果。

公式版本 digest 改变会派生新的三候选种子。本轮因此暴露并修复了离线 fallback 的标题碰撞：即使多个候选抽到同一种开头策略，也会按候选编号使用三种语义一致的标题变体，不再依赖某一组历史种子碰巧去重。

R09 分项验证：Core 完整测试 102/102；API 测试 27/27；Web 测试 32/32；各工作区类型检查与生产构建通过。最终合并验证以仓库根测试结果为准；证据目录中的 F17/F21 指纹与来源映射未因 R08 合并改变。
