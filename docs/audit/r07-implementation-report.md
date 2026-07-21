# R07 公式执行真值实施报告

> 日期：2026-07-13  
> 执行策略：`3.0.0`  
> 范围：F01—F43 的实现状态、执行类别、实际/声明阶段、handler、控制能力与证据边界。

## 结果

公式不再因“存在相似代码”或“映射了参数”就显示为已执行。当前状态为：

- `active` 7 条：F01、F03、F04、F06、F25、F42、F43；
- `partial` 19 条：F02、F05、F07、F09、F10、F12—F14、F19、F22、F26、F32—F34、F36、F38—F41；
- `conditional` 3 条：F17、F21、F30；
- `protocol-only` 14 条：F08、F11、F15、F16、F18、F20、F23、F24、F27—F29、F31、F35、F37。

另以 `executionClass` 区分 18 条直接执行结构、3 条条件计算器、3 条诊断代理、12 条研究协议、4 条假设和3条未实现方程。`implementationStatus` 表示完成程度，`executionClass` 表示当前究竟是什么，两者不得互相替代。

## 执行与控制边界

- F17、F21、F30 只有在显式变量完整时才由安全 JSON AST 计算；它们不参与规划、写作或选稿。
- F32、F33 只输出 components-only 诊断，不合成质量总分。
- protocol 和 not-implemented 项没有运行 handler，`controlMode=not-running`。
- 只有 calculator 与 F32/F33 diagnostic 等完整 dispatcher 路径显示 `fully-gated`。硬编码规划、校验或知识更新明确显示 `always-on` 或 `partially-gated`，关闭公式不能被描述成已经停止这些机制。
- `stages` 只列当前实际实现；`declaredStages` 保留方法论声称；`nonDispatchedStages` 公开两者与 handler dispatcher 之间的缺口。
- F43 只属于草稿规划记忆，不再声称 knowledge update；F30 只属于条件计算，不再声称 planning/validation 已消费结果。

## 证据目录

`formula-evidence-catalog.json` 保留原有论文、官方来源和 sourceIds 映射，逐式同步当前状态、执行类别、实际机制和适用边界。43 条公式的 `semanticFingerprint` 均由当前 core canonical 指纹函数生成，同时保留 `equationFingerprint` 兼容别名。证据概念支持不会因代码接线而升级为平台因果规律。

## 验证

`packages/agent-core/test/formula.test.ts` 逐式锁定状态与 execution class，并覆盖：

- calculator 仅 F17/F21/F30；
- protocol/not-implemented 无 handler；
- partial 的语义缺口与 dispatcher 缺口分离；
- `fully-gated / partially-gated / always-on / not-running` 四种控制模式；
- direct drafting 白名单与 stage-dispatch audit。

R08 以后仍需单独批准；本轮没有改变论文来源映射，也没有把未执行协议变成生成评分目标。
