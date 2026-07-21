# R12 F30 热点匹配手工情景实施报告

## 结论

F30 已从“热点相关性与合格触达”收缩为 **“热点匹配手工情景”**。它只回答一个有限问题：在用户明确指定的某个来源对象和观察时间下，三项主观判断相乘后得到怎样的 `TrendFit` 情景值。它不读取小红书实时数据，不预测热度、推荐或触达，也不进入文案生成、规划、选稿和校验。

`qualifiedIncrementalReach` 已从 F30 输出中明确排除，并作为 `not_executed` 研究协议单独记录。标签、热点词、热点榜身份和热议话题身份都不是触达保证。

## 计算合同与输入边界

公式仍为：

`TrendFit = relevance × bridgeClarity × timeliness`

只有以下六项全部有效时，服务端安全 AST 才返回数值：

| 输入 | 规则 | 含义 |
|---|---|---|
| `trendSourceKind` | 三选一 | 用户声明为 `xiaohongshu_hotspot_rank`、`xiaohongshu_hot_discussion` 或 `other_explicit_source` |
| `trendSourceRef` | `trend_source_ref` | 无 userinfo 的绝对 HTTP(S) URL，或 `id:` / `title:` / `source:` 加具体对象；纯标签和空泛词无效 |
| `sourceObservedAt` | `rfc3339_timestamp` | 带秒和时区的有效 RFC3339，例如 `2026-07-14T10:30:00+08:00` |
| `relevance` | `[0,1]` | 项目内容与该具体对象的实质相关性手工情景值 |
| `bridgeClarity` | `[0,1]` | 内容能否清楚说明关联，而不是只附加热词 |
| `timeliness` | `[0,1]` | 相对所填观察时间的时效性情景值，不预测未来热度 |

三个数值都是用户手工、未校准的情景输入。输出合同固定为 `manual_scenario / unvalidated_scenario_index`，范围 `[0,1]`；缺项返回 `unknown`，空字符串、未知来源枚举、纯标签/空泛来源、无效日期时间、错误类型或越界值返回 `invalid`，系统不补默认小数。来源和时间通过只代表本地格式与用户声明可解析；系统不联网确认页面存在、官方归属、榜单/热议身份或观察真实性。

## 官方来源身份与证据边界

证据目录把三类来源分开：

- 小红书“热点榜”官方规则（`XHS-HOTSPOT-01`）只支持：该榜单说明搜索、传播、互动、点击率等输入并按分钟更新。
- 小红书“热议话题”官方规则（`XHS-HOTDISCUSS-01`）只支持：该产品说明发布/消费、个性化 12 项并按小时更新。
- `other_explicit_source` 必须记录具体来源，且不会被系统改写成前两种官方身份。

三类枚举均是用户声明，不是系统认证。URL、`id:`、`title:`、`source:` 与 RFC3339 校验是防止空值和明显含混输入的操作合同，不是科学证据，也不能证明对应对象真实存在或属于官方榜单。

这些官方说明都不公开普通笔记的完整排序权重，也不证明加标签、使用热词或进入任一榜单会提高普通笔记触达。小红书推荐算法公示（`XHS-ALGO-01`）只支持“推荐会使用内容与交互数据并进行去重、打散和兴趣发现”等有限陈述，同样不能给 `TrendFit` 赋予流量含义。

因果方法证据只支持研究设计边界：Rubin 的潜在结果框架（`SCI-CAUSAL-01`）说明增量效应需要可解释反事实；Kohavi 等人的在线受控实验方法（`SCI-EXPERIMENT-01`）说明需要控制分配、预定指标、护栏和分析纪律。两者都没有验证本项目的三项乘法、阈值或小红书触达效果。

## 合格增量触达研究协议

`calculatorContract.excludedResearchOutputs` 现在明确记录：

- 指标：`qualifiedIncrementalReach`；
- 协议：`qualified_incremental_reach_protocol`；
- 状态：`not_executed`；
- `outputProduced=false`，且不能由 TrendFit 计算器产生。

若未来要估计该结果，至少需要预先定义合格受众与合格触达结果、建立无热点桥接基线和热点桥接处理、保证入口与曝光机会可比、约定归因时间窗，并观察去重后的增量结果，同时处理风险、过期和混杂。当前系统没有这些观测，因此不会显示伪触达率。F31“热点净机会”也继续保持 `protocol-only / not-running`。

## 执行所有权、提示词与界面

F30 的声明阶段和实际阶段均只有 `calculation`；`calculatorContract.consumedBy` 对 generation、planning、selection、validation 全为 `false`。API 另显式返回 `reachPrediction=false`、`predictsQualifiedReach=false`、`usesLivePlatformData=false` 和 `comparesHotTopicRankings=false`。

计算结果可以作为 `impactReport.formulaResults` 中的 UI/审计快照保存；“被保存和展示”不等于“被下游消费”。`compactParameterContract` 和写作提示不携带 `formulaResults`，低/高 TrendFit 的回归任务必须得到相同的内容、编排和 coverage 结果。

提示词差异是“继续隔离并消除旁路暗示”：

- F30 仍不进入直接写作公式，也不把计算结果注入初稿或修复提示词；
- 标签数量、入口具体度和新颖度不再映射为 F30 输入；
- 生成提示只保留“不要用无关热点”，参数说明明确标签是主题/路由线索而非流量公式；
- 公式页单独收集六项显式输入，计算在服务端完成，浏览器不复制公式；高级 JSON 走同一个 Core 校验器，不能绕过来源和时间合同；
- 简单模式、设置模式和结果页均说明“标签 ≠ 触达保证”，未知来源不自动分类。

因此，即使 `TrendFit=1`，系统也不会改变标题、标签、正文、评论计划、候选顺序或校验结论。

## 版本与迁移

- 默认公式版本：`1.5.1`
- 默认公式 digest：`ccf4da84b3652010756c4800fcad2b731e9a2cecfe49241e1565866e78134196`
- F30 当前语义指纹：`13f7a3cd5e8b645ec69cfec64eb17c10e9953c1030b180c2da3f8af5b004fb45`
- 执行策略：`3.5.1`
- 执行策略 digest：`8c2f25b14fdd3db547f8ef909af8e1508f2b00ee8e7f3629e77b58c6ab23b0d8`

语义指纹包含变量格式和 `calculatorContract`，合同变化不能沿用旧 handler。迁移只接受两个完整精确匹配的官方父语义：pre-R12 指纹 `ce32ee3ff6cb74cc6c0f923fb73f1e64f4d68b63008a8ed22686ca767c646145`，以及未含格式校验的 R12 v1 指纹 `08bd0753814130b5b236585dc7f2c64b7de8083c426b3afab77a2924fd09553b`。迁移通过受 `formula.manage` 保护的显式写接口触发，派生新活动版本、归档父版本并写入真实操作者审计；任何角色的 GET 与 ContentEditor 生成都不会暗中迁移。任一自定义标题、变量、格式、AST、说明或合同仍保持 `pending_review`、关闭 handler 并拒绝计算。

## 正反例

正例：用户明确选择“热议话题”，填写具体话题 URL、`2026-07-14T10:30:00+08:00`，以及 `0.8 / 0.75 / 0.5`。服务端返回 `TrendFit=0.3`，UI 同时显示“格式通过但未联网核验、未标定手工情景、不参与生成、qualifiedIncrementalReach 未执行”。

正例：来源是行业会议议程而非小红书官方页面。用户选择 `other_explicit_source` 并填写会议页面，不会被界面包装成“热点榜”。

反例：只输入 `#眼袋` 或 `title:#眼袋` 并选择“热点榜”。服务端返回 `source_ref_hashtag_only`；系统不会从标签反推官方身份。`title:#眼袋 恢复期常见问题` 可通过格式校验，但仍只是未联网核验的用户声明。

反例：观察时间写成 `2026-02-30T10:30:00+08:00`、省略时区或只写日期。服务端分别返回无效取值或无效格式，不用当前时间代填。

反例：输入 `relevance=1.2`，或把来源类型写成任意字符串。服务端拒绝，不截断成 1，也不改用默认来源。

反例：某次 `TrendFit` 很高。系统仍不得表述为“会获得更多流量”，不得自动加标签、提高候选排名或通过内容校验。

## 修改落点

- Core：`packages/agent-core/src/types.ts`、`formula.ts`、`parameters.ts` 与对应测试；
- API：`apps/api/src/formula.service.ts`、`formula.controller.ts`、项目初始化与计算/完整性/权限/迁移测试；
- Web：公式计算器、来源边界组件、显式默认公式同步、生成设置、简单模式、结果页与对应测试；
- 审计：`formula-evidence-catalog.json`、`formula-prompt-audit.md`、`formula-review-checklist.md`。

## 根级最终验证

- Core 测试：`126/126`
- Web 测试：`48/48`
- API 测试：`32/32`
- 三工作区 typecheck：通过
- Core、Web、API 生产构建：通过（Web 仅有既存的单 chunk 体积提示）
- 证据目录：43 条编号公式与 Core 语义指纹、公式版本 digest、执行策略 digest 全部一致，零 mismatch
