# R13 F32/F33 分项显示与人工复核排序合同实施报告

## 结论

R13 采用 **A 方案**：F32/F33 的 `emphasis` 是显示与人工复核排序偏好，不是系统检查调度、分项测量、权重、合格线或质量分。审查没有发现可追踪的检查执行队列，因此不能把现有滑块包装成 B 方案。

F32/F33 已分别改名为“正文分项检查清单”和“评论分项检查清单”。旧的 Q̂ 加减式容易暗示分项可以合成总分，现改为：

- `BodyReview=OrderForReview({componentᵢ}); missing sourceᵢ ⇒ statusᵢ=unknown`
- `CommentReview=OrderForReview({componentᵢ}); missing sourceᵢ ⇒ statusᵢ=unknown`

这两式表达的是排序与缺失值规则，不是质量计算。

## 可执行合同

每个 F32/F33 报告固定携带 `formulaId`、公式语义指纹、`diagnosticContract`、`components`、`evidenceStatus` 与下列认识状态：

| 字段 | 固定值 | 含义 |
|---|---|---|
| `semantics` | `ordered_component_review_metadata` | 只是有序分项元数据 |
| `status` | `unknown` | 当前没有分项结论 |
| `evaluationStatus` | `not_evaluated` | 没有执行校准后的分项求值 |
| `aggregateValue` | `null` | 不存在可报告的聚合值 |
| `scoreProduced` | `false` | 禁止产生分数 |
| `evidenceStatus` | `unvalidated_proxy` | 分项代理尚未标定 |
| `aggregation` | `components_only` | 只报告分项，禁止求和、平均或加权 |

每个分项都保存 `emphasis`、`displayOrder`、`manualReviewRank`、方向、`status=unknown`、`value=null`、`source.kind=not_observed` 和分项边界。缺失值不能替换成 0，也不能改写为 pass 或 warn。

排序规则是：先按 `emphasis` 从高到低排列；同值按合同中的规范分项顺序稳定排列。`displayOrder` 永远为 1—10；同值分项共享 `manualReviewRank`，例如两个最高分项都是 90，则展示顺序是 1、2，但人工复核排名都是 1。该排名只是一张给人的清单，不代表系统先执行了哪些检查。

## 明确不受 emphasis 影响的路径

合同把以下消费端全部固定为 `false`：generation、planning、selection、validation。F32/F33 的 parameter handler 已移除；初稿与修复提示绝对不携带公式编号、诊断强调名称、参数 ID、强调值或相关警告。调高或调低 emphasis 只能改变报告里的排序字段，不能改变：

- 正文、标签、图片简报或评论内容；
- 信息缺口规划、评论线程计划或候选顺序；
- 硬校验器是否运行、阈值、问题严重度与修复结论；
- 分项值、分项状态、总分或现实效果预测。

F33 附近确实存在评论线程、来源身份、信息闭合等硬校验，但这些是独立安全机制，不是 F33 分项的测量结果，也不受 F33 开关或 emphasis 控制。

## API、持久化与导出

候选 API 不再把 `unknown` 改成 `warn`，也不再丢弃 `formulaId/components/evidenceStatus`。任务级参数影响报告与候选内容包都返回完整诊断快照。JSON 原样保留合同；Markdown、DOCX 和 PDF 单列“F32/F33 分项审查元数据（非质量分）”，逐项输出排序、unknown/null、证据状态和边界。

历史数据采用 fail-closed：只有公式指纹、完整合同、规范分项集合、稳定排序和字段值全部匹配时，才显示当前语义。旧记录或自定义记录缺任一字段时，API 将其标成 `historical_contract_incomplete`，清空遗留分数、分项值、emphasis 与排序含义；Web 还会独立复核精确字段、规范名称与说明。UI 和导出只显示中性的 unknown/“历史分项”，不复用原始评价文字，也不根据公式名称猜测。

原候选 `score` 实际来自校验问题数量，而非 F32/F33。为兼容旧客户端，传输层暂时保留该字段；新客户端只认精确的 `validationHeuristic` 合同：

`value=max(0,100−25×errorCount−5×warningCount)`

它明确标记为 `operational_heuristic / non_quality_score / calibrated=false`，并声明排除 F32、F33、emphasis 和缺失代理。它只能帮助查看校验问题数量，不能解释为内容质量、营销效果或平台表现；历史裸 `score` 没有合同就不显示数字。

## 界面行为

- 公式页展示 F32/F33 专属边界卡：10 个 unknown/null 分项、无阈值、无总分、不参与下游；指纹或合同不匹配时整卡 fail closed。
- 参数页把诊断组改称“人工诊断排序”，滑块说明只谈页面/人工清单先后，不再声称减少检查资源。
- 结果页把原“质量分/质量诊断”拆为“校验问题启发式（非质量分）”与 F32/F33 分项卡；缺合同显示 unknown，不用 0 填补。
- 仪表盘只统计候选明确的 `validation.valid` 通过状态，不再平均候选裸分数。
- 接口失败时只显示“演示数据 · 未连接真实生成记录”；演示诊断只能从明确的 `validation.issues` 一对一产生，不再把无合同的主观 pass/warn 冒充系统校验。

## 证据与数据边界

本次改动是对产品字段的操作定义，不是新提出的心理学或平台因果规律，因此没有用论文为“显示排序合同”制造实证背书。证据目录继续保留：F32 的 `DATA-REFERENCE-70`、`SCI-LOAD-01`，以及 F33 的 `DATA-REFERENCE-70`、`SCI-REVIEWS-01/02`。这些资料最多支持样本中存在相应内容维度、阅读负荷或评论信息相关概念，不能推出 0—100 权重、阈值、分项可靠性、平台推荐或转化效果。

现有 70 篇样本和人类总体评分没有逐分项、冻结、独立的校准标签，所以不能给 `stateMatch`、`gapCoverage` 等字段填数。后续 R28 需要冻结盲评集、分项标注协议、重复测量、区分度/冲突检查和外部验证；即使完成，也仍不应为了方便而强制合成单一总分。

## 迁移与版本

- 默认公式版本：`1.6.0`
- 默认公式 digest：`59ea9291887f1c9b4ae534a6d93adf2471348de68613d6714c0dc76e4a711c3c`
- 执行策略：`3.6.0`
- 执行策略 digest：`607e6af95a91104b38c452b9e3947d32f0665068229e0ff566422dc8c6b92111`
- F32 当前指纹：`b1e3d133995e6773ff0d89cd389bc384a881d857b4e290dfdbe29711a807c0a9`
- F33 当前指纹：`06b84308f3fd72c8c066ab819b70524a01f56ab922ad2d76d1578e85822fe6f4`

`diagnosticContract` 已进入完整语义指纹。已有项目只可通过受 `formula.manage` 保护的显式“同步已复核默认公式”操作迁移；服务端仅接受旧官方 F32/F33 的完整精确指纹，派生新 active 版本、归档父版本并写审计。自定义标题、方程、说明、合同或边界不匹配时不会被覆盖，继续 `pending_review / fail closed`。

## 正反例

正例：把“广告怀疑风险” emphasis 从 40 调到 90。它在人工清单中前移；正文、评论、校验问题、候选顺序和分项状态完全不变，仍是 `value=null/status=unknown`。

正例：两个评论分项 emphasis 都是 80。两项按规范顺序显示，`manualReviewRank` 都是 1；这不表示系统给它们相同质量分。

反例：历史记录只有 `{formulaId:"F32", score:86}`。API 删除 86，返回合同 unknown；UI 不画 86 分圆环，也不把它改成 warn。

反例：评论通过全部硬规则。它只能说明已配置的硬校验没有发现对应问题，不能据此把 F33 分项填成 1、100 或“优秀”。

反例：把十个 emphasis 相加或平均。emphasis 没有质量量纲，聚合违反 `components_only` 与 `scoreProduced=false` 合同。

## 修改落点与验证

- Core：类型、公式合同与指纹、参数排序、提示隔离及回归测试；
- API：候选/内容包/任务映射、历史合同归一化、显式公式迁移、v1 输出与多格式导出；
- Web：严格合同守卫、公式页、参数页、结果页、仪表盘、演示数据与界面测试；
- 审计：证据目录、总审计注记、审批清单和本报告。

最终验收（2026-07-14）：

- 根级 `npm test`：220/220 通过（Core 129、Web 56、API 35）；
- 根级 `npm run typecheck`：三工作区通过；
- 根级 `npm run build`：三工作区通过，仅保留既有 Vite 500 kB 包体提示；
- 证据目录：45 条记录完整，43 条编号公式的方程、语义指纹、公式版本/digest 与执行策略版本/digest 对 Core 均为零 mismatch。
