# 公式与提示词修正审批清单

> 状态：R01—R13 已获批并完成；R14 以后仍默认 **未批准**。  
> 原则：只有用户明确批准的编号，才进入生产代码、提示词、参数或 UI 修改。

## P0：先修真实来源与硬边界

- [x] **R01｜统一 InformationGap 与通道分配真源**  
  涉及 F04/F05/F09/M-CLOSE。删除参数侧与规划侧两套互不相知的分配；一张 gap 卡统一保存答案、框架、边界、优先级、证据和 planned placement。  
  验收：required 优先；关闭评论不再分配 Cref；prompt、fallback、ledger 读取同一对象。

- [x] **R02｜建立逐声明 claim—source 映射**  
  涉及 F06/F25/F34/F39。禁止把全部 selected document IDs 复制到每个 gap；事实需引用能直接支持它的来源片段、范围和来源角色。  
  验收：只有文档 ID 而无支持片段不能过关；正文和评论事实不能借 omission from reasoning 绕过检查。

- [x] **R03｜生成后重新计算真实闭合**  
  涉及 F09/M-CLOSE。把 `closureRate` 改名为 `ledgerCompleteness`，另从实际正文/评论计算 `resolvedRate`；核验答案、条件、边界、证据和可找到位置。  
  验收：删掉正文答案后 `body_resolved` 必须失败；线程 ID 存在但 primaryGap 错位也必须失败。

- [x] **R04｜unknown 不得自动变成小数**  
  涉及 F28/F30/F39 与项目智能归一化。缺失 relevance/proofability/novelty/risk 等输入时保存 `null/unknown`，进入待复核而非默认排名。  
  验收：缺关键变量的 opportunity 不计算伪精确 finalScore，也不能自动成为 eligible。

- [x] **R05｜建立公式执行 handler 注册表**  
  只登记已经真实接线的 parameter、prompt、calculator 与 diagnostic handler；planning、binder、validator、evaluation、knowledge-update 在未接入 dispatcher 前必须列为 non-dispatched，不能冒充运行。硬安全不变量单独标记为不可禁用。  
  验收：关闭公式会停掉可禁用 handler；canonical 语义指纹覆盖方程、AST、变量和提示字段，任一改变后自动变 `pending_review`，不沿用旧证据/执行声明。

- [x] **R06｜把间接公式审计移出写作模型上下文**  
  `formula_execution_audit` 仍保存在服务器生成快照，但模型只收到直接写作公式和已求出的 planning contract。  
  验收：提示预览中无 F15/F27 等研究协议全文；运行包仍能追溯全部 ownership。

## P1：修正执行语义和可调参数

- [x] **R07｜按真实程度修正 F01—F43 implementationStatus/ownership**  
  第一批至少调整 F02/F08/F11/F12/F13/F18/F19/F20/F23/F25/F26/F28/F30/F32/F33/F38—F43。  
  验收：`active` 只表示当前方程在所列阶段真实执行；conditional/protocol 不再显示为生成质量公式。

- [x] **R08｜重构 F12/F13/F41 为“假设场景”，不是用户分布真值**  
  `known` 改为用户提供的 `preContactKnown`，默认空；项目事实另列 `availableEvidence`。未标定 0.x 值改为等级/区间或明确 heuristic。  
  验收：项目 verifiedFacts 不再冒充读者已知；history 未提供时明确 unknown。

- [x] **R09｜完善 F17/F21 条件计算器**  
  F17 校验共同单位；F21 改为 `pExposure`、`pNoticeGivenExposure`、`pEnterGivenNotice`、`pConsumeGivenEnter` 并限制 `[0,1]`。  
  验收：输入不足仍为 unknown；UI 明确“手工情景计算，不参与生成/选稿”。  
  完成记录（2026-07-13）：Core 单位/范围/unknown、服务端计算端点、Web 输入/清空/错误展示和“不参与生成/规划/选稿”边界均已验收。详见 `r09-core-implementation-report.md`。

- [x] **R10｜限定 F19/F40 的“预览/多模态”范围**  
  区分图片观察、imagePlan、imageBrief、最终图片资产、真实入口截图与实际部署。  
  验收：没有最终资产/入口快照时不显示 Preview 或 Img 已执行；可见图文承诺做语义一致性校验。  
  完成记录（2026-07-13）：新增六阶段 `productionArtifacts`、三层 alignment、来源素材 DB/API 边界、修订图像观察复用、导出与 UI 状态账本。详见 `r10-implementation-report.md`。

- [x] **R11｜把当前机会排序另命名为 `OpportunityRankHeuristicV1`**  
  涉及 F28。保留可解释分项，但不声称等于 Proofable×Demand×Importance×(1−Coverage)…；无竞品/需求数据时 F28 保持协议。  
  验收：UI 同时显示输入来源、unknown、固定权重未标定和非因果边界。
  完成记录（2026-07-13）：Core 单一排序合同、来源与 unknown 资格门、审批/生成/导出快照、提示词隔离和 Web 审计视图均已验收。详见 `r11-implementation-report.md`。

- [x] **R12｜拆分 F30 的 TrendFit 与合格触达**  
  TrendFit 保留为条件计算器；qualified incremental reach 另列研究协议。明确区分官方“热点榜”和“热议话题”。  
  验收：planning/validation ownership 只在真正消费结果后显示；标签不被描述为触达保证。
  完成记录（2026-07-14）：F30 已改名“热点匹配手工情景”，只登记 `calculation`。计算必须显式声明热点榜条目、热议话题或其他来源，来源引用通过 HTTP(S) 或 `id:`/`title:`/`source:` 格式校验，观察时间通过带时区 RFC3339 校验，并提供三项 `[0,1]` 未标定手工值；格式通过不代表联网身份核验。结果不进入生成、规划、选稿、校验或触达预测。`qualifiedIncrementalReach` 以 `not_executed` 研究协议独立记录，两个已知官方父语义只在完整指纹精确匹配时通过显式管理写操作派生迁移，自定义版本保持 `pending_review`。详见 `r12-implementation-report.md`。

- [x] **R13｜让 F32/F33 emphasis 真正有定义，或降为显示偏好**  
  选择 A：emphasis 只控制审查排序，明确不改门槛；选择 B：实现可追踪的检查优先级。禁止合成伪总分。  
  验收：UI、API、导出均保留 formulaId、components、evidenceStatus，不再把 unknown 代理包装成普通 0—100 分。
  完成记录（2026-07-14）：采用 A 方案。F32/F33 只输出按 emphasis 排列的 `unknown/null` 分项与人工复核顺序，不进入初稿或修复提示、生成、规划、选稿和校验。API 与四种导出严格匹配完整合同；历史、自定义或被篡改记录统一 fail closed，旧分数与主观评价不会继续显示。结果页另行清除了会冒充真实系统校验的演示诊断。详见 `r13-implementation-report.md`。

- [ ] **R14｜实现或收缩 F34 来源聚合声明**  
  若实现：记录 source role、独立来源簇、依赖关系和原始声明；若不实现：改名为“证据引用与批准状态”，保持 partial。  
  验收：同源重复不增加“独立证据数”；聚合过程可解释且不发明权重。

- [ ] **R15｜区分知识更新、覆盖记忆与草稿记忆**  
  涉及 F36/F43。生成候选只进入 draft coverage；用户采纳/发布后才进入 adopted/published coverage；真实结果经审批后才能进入 observation ledger。  
  验收：未选稿不污染“已发布覆盖”；生成文字不会回写为项目事实。

- [ ] **R16｜完善 M-DISCOVERY 的可见实现**  
  cue 按语义事实单元提取，禁止字符截断；Reveal、SelfCheck、Boundary 都必须出现在用户可见回复；Vdiscover 只输出分项 unknown/protocol。  
  验收：高强度不变成吊胃口；低强度表示更直接，不关闭同线程揭示和事实边界。

- [ ] **R17｜检查每层 follow-up 的信息增量**  
  涉及 F10/F22/F33。追问必须承接上一轮、增加条件/核验路径，不能重复通用“准备条件/注意边界”模板。  
  验收：重复、无新增信息或与角色状态无关的 follow-up 触发修复。

- [ ] **R18｜让简单模式显示真正必要的输入和当前值**  
  保留入口、阶段、选题、证据状态、正文/评论分配、关键安全边界和评论发现档位；复杂代理、研究变量隐藏但可查看。  
  验收：不进入设置模式也能理解并完成一次生成；每个显示值说明它影响哪个执行阶段。

- [ ] **R19｜增加公式执行轨迹与脱敏提示预览**  
  公式页作为审计中心；参数页、预览页、结果页显示本次实际执行阶段、代码/提示落点和证据链接。  
  验收：无参数映射不再显示“不影响生成”；提示预览不暴露密钥、完整私有知识或敏感日志。

- [ ] **R20｜把案例数据拆成表达库与评价集**  
  70 篇原文只学习表达形式；含 human 标签的 50 条及旧评分结果先完成主键、评分说明、版本和泄漏审计，再用于离线比较。  
  验收：案例内容不能给项目事实提供证据；任何样本长度/高分相关都不被表述为平台因果规律。

## P2：真实数据和实验协议

- [ ] **R21｜F08 通道位置实验**：固定信息，随机正文/评论位置，预注册理解、找到率、努力与错误率。
- [ ] **R22｜F11 部署可见性观测**：记录实际发布身份、置顶/折叠、时间和可见状态，不把 deploymentPlan 当现实。
- [ ] **R23｜F15—F18 决策价值测量**：定义终点、损失量纲、before/after 与认知成本；无共同量纲只分项报告。
- [ ] **R24｜F20—F24 路径分母**：区分 exposure、notice、enter、consume、find、participate 的条件分母和位置偏差。
- [ ] **R25｜F27 鲁棒选择**：先定义 Θ、情景分值与保守预算，再比较 max-min；不能用结构距离冒充。
- [ ] **R26｜F29/F31/F35 现实结果**：需要竞品组合、查询需求、合格触达、风险/过期成本与合格行动定义。
- [ ] **R27｜F37 2×2 实验执行器**：随机分配、样本量、主要指标、停止规则和分析计划完整后才升级状态。
- [ ] **R28｜代理诊断校准**：使用冻结盲评集检查 F32/F33 分项的可靠性、区分度、冲突和边界，不追求单一总分。

## 批准记录格式

后续可直接回复，例如：

```text
批准 R01、R02、R03；
R04 先给我看 null/unknown 对简单模式的交互方案；
拒绝 R11，保留当前名称但降级标注。
```

每个被批准项实施后应附：修改文件、行为差异、测试、迁移影响、提示词 diff 和一组正反例。
