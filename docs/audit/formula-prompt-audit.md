# 公式—提示词全链路审计（严格第一阶段）

> 历史说明：本文记录 R01—R07 实施前的审查基线，不应再作为当前执行状态表。R01—R06 的当前行为以 `p0-implementation-report.md` 为准，R07 的逐式真值以 `r07-implementation-report.md` 为准；R08/R09 更新分别见 `r08-implementation-report.md`、`r09-core-implementation-report.md` 与当前证据目录。下方旧矩阵保留用于追溯问题来源。
>
> 审计版本：`2026-07-13.audit-1`  
> 对应默认公式版本：`1.1.0`，digest `c81931523eeb8913f4c6dd71b66865c94d7cfc834193133191e7935e5a2230aa`  
> 范围：F01—F43、信息闭合（M-CLOSE）、发现式问答（M-DISCOVERY）、参数、预设、行业分析、规划、模型提示、校验、持久化和 UI 陈述。

## 0. 本阶段的边界

本文在审计时只记录事实、证据、问题和候选修正；其后获批的 R01—R06 已按清单进入生产实现。其余建议仍需逐条批准。

**实施后注记（2026-07-13）：** R07 已获批实施。当前注册表不再沿用本基线中的 `active 23 / partial 9 / conditional 3 / protocol-only 8`，而是按逐式代码真值登记为 `active 7 / partial 19 / conditional 3 / protocol-only 14`，并另列 execution class、实际阶段、声明阶段、dispatcher 缺口与 control mode。本文下方旧矩阵保留用于说明问题来源，不代表当前 UI 或运行时声明。

**R08/R09 注记（2026-07-13）：** F12/F13/F41 已改为可修正情景合同，项目证据不再冒充读者已知，未提供历史保持 unknown，心理状态只显示未标定等级。F17/F21 已具备服务端条件计算器与真实 UI：F17 只有单位一致时计算；F21 使用明确条件概率变量并拒绝 `[0,1]` 外输入；两式不进入生成、规划或选稿。当前合并版本以 `r08-implementation-report.md`、`r09-core-implementation-report.md` 和证据目录为准。

**R10 注记（2026-07-13）：** F19/F40 已区分来源素材观察、ImagePlan、ImageBrief、最终图片资产、真实入口截图和实际部署。当前只完成 `EntryDraft/OrchDraft`；最终图片与入口截图缺失时一致性为 `not_evaluated`，部署计划不等于已发布。当前默认公式 `1.4.0`、执行策略 `3.3.0`，以 `r10-implementation-report.md` 和证据目录为准。

**R11 注记（2026-07-13）：** 当前固定权重选题排序已独立命名为 `OpportunityRankHeuristicV1`，公开分项、来源、unknown、策略快照和未标定/非因果边界。F28 仍为未运行的研究协议；排序审计不会进入写作或修复提示词。当前默认公式 `1.4.0`、执行策略 `3.4.0`，以 `r11-implementation-report.md` 和证据目录为准。

**R12 注记（2026-07-14）：** F30 已收缩为“热点匹配手工情景”：只有显式来源类型、通过格式校验的具体来源引用、带时区 RFC3339 观察时间和三项 `[0,1]` 手工值齐全时才计算 `TrendFit`。格式通过只代表用户声明可解析，系统不联网确认页面、官方归属或观察真实性。它只属于 `calculation`，不被生成、规划、选稿、校验或触达预测消费。`qualifiedIncrementalReach` 是另一个 `not_executed` 对照观察协议；官方“热点榜”与“热议话题”不得互相冒充，标签也不是触达保证。当前默认公式 `1.5.1`、执行策略 `3.5.1`，以 `r12-implementation-report.md` 和证据目录为准。

**R13 注记（2026-07-14）：** F32/F33 已选择 A 方案，改为“正文/评论分项检查清单”。`emphasis` 只控制页面显示顺序和人工复核优先级；同值按规范分项顺序稳定展示并保留并列排名。所有分项在没有校准观测时固定为 `status=unknown`、`value=null`，不设阈值、不合成总分，也不进入生成、规划、选稿或系统校验。API、JSON/Markdown/DOCX/PDF 与 Web 均保留完整合同；历史记录缺少合同或指纹不匹配时按 unknown 降级，不显示遗留数字。当前默认公式 `1.6.0`、执行策略 `3.6.0`，以 `r13-implementation-report.md` 和证据目录为准。

“已使用”不是一个二元状态。本审计分别检查：

1. 参数是否真的改变配置；
2. 规划器是否执行了公式所述操作；
3. 公式是否作为直接写作指令进入模型；
4. 模型收到的是公式、已经求出的计划，还是仅供审计的元数据；
5. 校验器是否检查实际产物，而不只是检查计划；
6. 是否有真实观察支持评价或知识更新；
7. UI 是否如实说明上述阶段。

## 1. 结论摘要

当前注册表把 43 条公式标为：`active 23 / partial 9 / conditional 3 / protocol-only 8`。按真实执行重新审计后：

| 审计结论 | 数量 | 含义 |
|---|---:|---|
| 本地架构基本吻合 | 2 | F01、F03 在当前离线生成范围内基本成立。 |
| 部分执行 | 15 | 含 M-DISCOVERY；结构存在，但缺少公式的一部分、实际产物核验或现实观测。 |
| 定义/执行错位 | 12 | 含 M-CLOSE；系统执行了相似机制，但不能据此声称执行了当前公式。 |
| 条件计算器 | 3 | F17、F21、F30 仅在手工变量及其边界条件齐全时计算，结果不参与选稿。 |
| 研究协议，尚未执行 | 13 | 需要真实分母、对照、线上结果或实验数据。 |

最优先的六个问题：

- **同一缺口有两套通道分配。** `parameters.ts::channelAllocation()` 与 `planning.ts::makeAllocation()` 可能让正文按一套写、闭合台账按另一套记。
- **文档被选中不等于支持某条答案。** 当前默认把全部已选文档 ID 赋给每个缺口，随后又把“有任一 evidenceId”视为有依据。
- **闭合率几乎恒为 100%。** `closureRate=entries.length/gaps.length` 只证明每个 gap 建了记录，未证明正文或评论真的回答了它。
- **unknown 被默认小数替代。** 行业分析缺值会被填入 `0.8/0.6/0.5…`，这些未标定数字随后真实参与选题排名。
- **公式启停/版本不是执行真源。** 它只影响直接公式提示和三个 AST 计算；硬编码规划、绑定和校验不会随公式关闭或改式而变化。
- **间接公式审计元数据进入写作提示。** `formula_execution_audit` 对写作模型没有必要，增加上下文噪声，也可能让协议公式获得错误注意。

## 2. 当前真实执行链

```text
项目知识 / 已批准行业卡 / 已批准图片观察
    ↓
参数编译：行为说明 + 统一通道合同
    ├── 独立条件计算器：F17/F21/F30 → impactReport/UI 审计快照（不进写作提示）
    ↓
规划器：机会筛选/排序 + 状态种子 + 规划侧通道分配 + 三套编排 + 闭合台账
    ↓
提示词：11 条直接公式 + 参数行为说明 + 已求出的编排计划
        （不含间接公式审计元数据、formulaResults 或 TrendFit）
    ↓
模型生成 H / imageBrief / title / body / Cref
    ↓
绑定器强制覆盖评论规划字段、发现式揭示和证据 ID
    ↓
校验器：格式、身份、禁用声明、部分证据/评论/闭合规则
    ↓
保存三稿、参数快照、规划快照、覆盖签名
```

直接进入 `formula_guidance` 的只有：F01、F03、F04、F05、F06、F07、F09、F10、F19、F25、F40。其余公式即使出现在模型上下文中，也只是 `formula_execution_audit` 的间接元数据，不等于模型执行。

## 3. 逐式审计矩阵

状态缩写：**吻合**=当前本地范围基本成立；**部分**=有真实结构但缺关键环节；**错位**=公式与实际算法不等价；**条件**=只有显式变量齐全才计算；**协议**=尚无执行所需观察/实验。

### F01—F14

| ID | 当前声明 | 真实路径 | 结论 | 关键发现 |
|---|---|---|---|---|
| F01 | active；直接生成 | Schema、生成包和快照联合输出 H/N/Cref | 吻合 | 当前离线对象成立；关闭评论时与规划分配/M-CLOSE 的冲突需另修。 |
| F02 | active；planning | 保存 `Ucopy`、deploymentPlan、orchestrationSnapshot | 部分 | 没有 Deploy、平台扰动 `ξt`、真实评论 `Cuser,t` 或 `Ureal,t`；不能显示成“现实层已执行”。 |
| F03 | active；直接生成+校验 | 免责声明、模拟读者/可追责回复者、口碑禁写校验 | 吻合 | 无参数映射但确实执行，是 UI“无参数=不影响生成”的直接反例。 |
| F04 | active；planning+生成 | gap 数据、两套 channel allocation、参数说明 | 错位 | `priorities` 只影响参数侧分配；规划排序还把 `required` 排在后面。两套分配可能互相矛盾。 |
| F05 | active；planning+生成 | voice/form/sequence 参数说明；规划器另选策略 | 错位 | 参数表达窗与项目/内置 ExpressionStrategy 未统一；fallback 未完整落实 voice/sequence；规划未遵守所有 enabled channels。 |
| F06 | active；生成+校验 | selected document IDs、reasoning evidence 校验 | 错位 | 全部已选文档 ID 被复制给每个 gap；仅验证 ID 可见，不验证“声明—来源片段”的语义支持。 |
| F07 | active；直接生成 | 多模态输入、图片观察边界、imagePlan/imageBrief | 部分 | 输出是图片规划而非实际 Img；未校验图片—标题—正文承诺的语义一致性。 |
| F08 | partial；planning/诊断/评价 | 多轴候选和重复检查 | 协议 | 没有同一信息的通道反事实、随机位置或真实 `q`；当前结构差异不能识别通道因果。 |
| F09 | active；planning+生成 | 预分配 residual gaps、评论主 gap | 错位 | residual 由计划推断，不是读取实际 H⊕N 后计算；`body_resolved` 不检查正文是否真的出现答案。 |
| F10 | active；直接生成 | 根线程、角色卡、回复/发现计划、线程扩容 | 部分 | 不是按 `(q,s,history,KB,H,N)` 的逐轮状态转移；follow-up 多为通用模板，未验证增量。 |
| F11 | active；planning+evaluation | deploymentPlan 文本 | 协议 | 没有发布、置顶/折叠/排序、时点、实际可见率或真实评论。 |
| F12 | active；planning+diagnostic | 单个 `stateSeed` | 错位 | 没有 `π(s)` 分布；`known` 错把项目 verifiedFacts 当作接触前读者已知。 |
| F13 | active；planning+diagnostic | 三个固定阶段启发值 | 错位 | 缺多个状态维度与 t→t+1 更新；0.x 常数未经标定，只能叫假设种子。 |
| F14 | partial；diagnostic+validation | certainty/unknown 正则检查 | 错位 | 不计算 FalseClosure；公式缺少“确信/正确性”观测，只能解释为主观低估客观缺口的风险代理；防假闭合参数还未映射 F14。 |

### F15—F31

| ID | 当前声明 | 真实路径 | 结论 | 关键发现 |
|---|---|---|---|---|
| F15 | protocol-only | 无 AST/真实损失 | 协议 | 更接近固定终点的规范“超额期望损失”，不是 Bell/Loomes–Sugden 的心理遗憾本身。 |
| F16 | protocol-only | 无前后测 | 协议 | 没有同一读者/可比人群的 before/after 状态，不能从文案自动推断 ΔL。 |
| F17 | conditional；evaluation | 三变量 AST → impactReport | 条件 | 只做手工情景计算，不参与规划/提示/选稿；三项必须同量纲，字数不能直接当 cognitiveCost。 |
| F18 | partial | 仅有相邻诊断维度 | 协议 | 没有 ΔL、AdRisk、λΔFalseClosure 的专属分项或共同量纲，当前 partial 仍偏强。 |
| F19 | active；planning+直接生成 | imageBrief/title/tags | 部分 | 没有真实入口截图、VisibleTags、Excerpt 或最终图片资产，不能评价入口效果。 |
| F20 | partial | 通道分配的概念关联 | 协议 | 无 RouteFit、Popen、Q_C 场景值或计算，不能声称执行离线完整稿代理。 |
| F21 | conditional；evaluation | 四变量乘法 AST | 条件 | 变量名未表达条件分母，未校验 `[0,1]`；只进 impactReport，不参与生产。 |
| F22 | partial | 评论查找/线程结构启发 | 部分 | 没有 Needs、Pfind、InformationValue、Costopen、Clutter 的观测或分项，只能称机制启发。 |
| F23 | partial | 无真实评论/参与数据 | 协议 | 参考问答不等于真实评论增量；没有打开、参与或交互价值分母。 |
| F24 | protocol-only | stateSeed 结构 | 协议 | seed 不是 `π⁻` 人群分布，无法在同一送达前人群上求均值。 |
| F25 | active；直接生成+校验 | 禁词、unknown、允许 evidence IDs、结构门槛 | 部分 | 校验只检查 reasoning 中主动声明为 fact 的条目；正文/评论事实可绕过 reasoning，Ω 尚不完整。 |
| F26 | active；planning | 每稿最多 48 次候选，选三稿 | 部分 | 是受控候选抽样，不是完整 `WI×Ψ(WX)×AC` 枚举；事实一致性也未做声明级核验。 |
| F27 | protocol-only | 结构距离减近期重合 | 协议 | 没有 Θ、不确定情景得分或最坏值；现有选择不是 `max-min` 鲁棒优化。 |
| F28 | partial；planning | 固定权重加法排名 | 错位 | 没有 Demand、竞品有效 Coverage，也不是门槛乘积/成本比；应把现算法另命名为启发式。 |
| F29 | protocol-only | 无竞品组合/查询分布 | 协议 | 目前没有双方 portfolio 的 `Iq` 或可比较前沿。 |
| F30 | conditional；calculation | 带用户来源声明与时间快照的 `TrendFit` 服务端安全 AST | 条件 | 来源引用只接受绝对 HTTP(S) URL 或 `id:`/`title:`/`source:` 具体引用，观察时间只接受带秒和时区的有效 RFC3339；这只是本地格式校验，不是联网身份核验。三项 `[0,1]` 手工值的输出未标定，且不被生成、规划、选稿或校验消费。`qualifiedIncrementalReach` 另列未执行研究协议。 |
| F31 | protocol-only | 标签/热点概念关联 | 协议 | 无 qualifiedReach、共同效用单位、RiskCost、ExpiryCost 或真实热点数据。 |

### F32—F43

| ID | 当前声明 | 真实路径 | 结论 | 关键发现 |
|---|---|---|---|---|
| F32 | partial；diagnostic | 10 个正文分项以 `unknown/null/components_only` 输出并按 emphasis 排列 | 部分 | emphasis 只改变显示/人工复核顺序，不调度系统检查、不改门槛、不进提示词；API、导出和 UI 保留完整合同，不存在正文质量总分。 |
| F33 | partial；diagnostic | 10 个评论分项以 `unknown/null/components_only` 输出；硬评论校验独立运行 | 部分 | emphasis 不驱动评论生成或校验；线程数、角色数和规则通过数都不是分项值或总分，历史不完整合同按 unknown 降级。 |
| F34 | partial；diagnostic/validation/KB update | evidence IDs 与批准状态 | 错位 | 没有 `AggregateBySource`、来源角色或依赖折扣；当前反而会把同一批文档复制给所有 gap。 |
| F35 | protocol-only | 无真实行动数据 | 协议 | 没有 AudienceMass、Ppath、Pqualified，且业务行动与用户价值尚无共同观测。 |
| F36 | partial；knowledge-update | 手工/模型分析后审批资源 | 部分 | 有审批式资源更新，但没有真实结果观测自动回写；生成文本本身不应成为事实。 |
| F37 | protocol-only | 无实验执行器 | 协议 | 没有 2×2 随机分配、样本量、结果指标或分析计划。 |
| F38 | active；planning | LLM 项目分析提示要求 ≥12 gaps/8 strategies/12 opportunities | 部分 | 实际执行者是分析模型＋人工审批，不是注册表所称 deterministic planner；sourceStatus 虽被模型输出，归一化后未进入生成规划；数量下限不保证穷尽。 |
| F39 | active；planning+validation | status/proofability/risk/topic/gap gate | 错位 | 门槛未检查 Relevant、直接证据和完整 Ω；缺值默认 eligible/0.x，选择机会还会级联批准 gap/strategy，可能把未知过早放行。 |
| F40 | active；planning+直接生成 | H、imagePlan、title、body、Cref、deploymentPlan 联合规划 | 部分 | 规划阶段基本真实，生成落实仍部分：Img 是观察/计划/brief 而非最终资产，aC 未部署，标签/标题/图片/序列也没有完整 plan→output trace。 |
| F41 | active；planning+diagnostic | entry/stage/constraints + 三个启发值 | 错位 | 没有 history 输入的可靠使用，也不是动态或校准状态；与 F12/F13 重复声称过强。 |
| F42 | active；planning | 固定三稿、48 次候选、结构距离与种子 | 部分 | 受控结构采样真实存在；但结构距离权重未标定，“事实一致”缺声明级语义检查。 |
| F43 | active；planning+knowledge-update | coverage hash、近期重合惩罚、SQLite 记录 | 部分 | 真实执行去重，但所有生成候选完成即写入 coverage，不是已发布/批准观察；knowledge-update 所有权表述过强。 |

### 未编号方法卡

| ID | 真实路径 | 结论 | 关键发现 |
|---|---|---|---|
| M-CLOSE | gapCoverageLedger、线程扩容、required/unknown/deferred 校验 | 错位 | `closureRate` 近乎恒为 1，只是台账登记率；Resolved 未检查正文实际文本、声明—证据、完整条件/边界；明确延后也未保存完整承接通道/时点。 |
| M-DISCOVERY | Cue/EasyInference/Reveal/SelfCheck/Boundary、same-thread reveal、低/中难度、四参数、绑定器与校验 | 部分 | 结构是真实执行，不是摆设；但 `Vdiscover` 未计算，cue 可能按字符截断，已有 Reveal 时 binder 不一定把 SelfCheck/Boundary 强制写进可见回答，效果也完全未观测。低强度表示“表达变直接”，不是关闭安全边界。 |

## 4. 参数、预设和提示词融合审计

### 4.1 参数映射不等于公式执行

31 条公式至少映射一个参数，但映射只说明“UI/行为说明关联”。它不能证明规划器、fallback、模型和 validator 都执行了参数影响。F03、F40 没有或很少依赖参数，仍直接影响生成；反过来，F27 映射参数也不代表系统做了鲁棒优化。

以下参数目前主要是模型行为说明，未改变声称的确定性阶段：

| 参数 | 当前实际 | 缺失的确定性作用 |
|---|---|---|
| `information_breadth` | 写进 prompt | 不改变 F38 枚举或实际 gap 数。 |
| `experience_information_strength` | 写进 prompt | fallback/规划器不稳定落实。 |
| `redundancy_tolerance` | 写进 prompt | validator 没有随数值变化的阈值。 |
| `evidence_strictness` | 写进 prompt | 硬事实门槛不随档位变化；这部分可作为安全不变量，但 UI 需说明。 |
| `boundary_visibility` | 写进 prompt | 关键边界由硬编码保留，不是滑块的连续效应。 |
| `route_specificity` | 写进 prompt | 不直接改变 title/tag 规划逻辑。 |
| `novelty_angle` | 写进 prompt | 不改变机会枚举或固定权重排名。 |
| F32/F33 emphasis | 生成稳定的显示顺序和并列人工复核排名 | 只影响 UI/人工清单排序；不改变系统执行顺序、阈值、分项状态、结论、提示词、生成、规划、选稿或校验。 |

`comment_false_closure_guard` 不应允许低值关闭事实边界；当前硬规则没有随滑块降低是合理的安全不变量。但它遗漏了 F14 参数关联，且 UI 应把“表达显著度”和“不可关闭的安全底线”分开。

### 4.2 公式定义并不是执行真源

当前已按 `公式ID + 完整语义指纹 + handler兼容性` 管理可分派执行；指纹覆盖 AST、变量、`calculatorContract` 和提示语义。自定义公式即使保留相同 ID，只要语义变化就进入 `pending_review`，不能继承旧证据和 handler。F30 旧内置合同也只有精确匹配官方旧指纹时才派生迁移，自定义 F30 保持 fail-closed。

边界仍然存在：`enabledFormulaIds` 只控制已登记 dispatcher；部分规划器、评论绑定器和 validator 属于硬编码机制或安全不变量，不能因为公式开关而声称全部可禁用。具体以执行注册表的 `registeredDispatchStages`、`nonDispatchedStages` 和 hard-safety 标记为准。

### 4.3 提示词既有正确边界，也有噪声

正确之处：

- 只把 11 条生产相关公式列为 direct generation；
- 明确假设、代理和离线指标不是平台规律；
- `compactParameterContract()` 排除了 F17/F21/F30 的诊断计算值；
- 间接公式审计和 `formulaResults` 已从写作/修复提示剥离；F30 结果只可保存为 UI/审计快照；
- 评论要求同时保留角色、来源、回复五部分、发现式揭示与身份透明。

问题：

- direct formula 的 `plainLanguage` 多为认识地位模板，不是足够具体的可执行说明；真正执行规则主要来自手写 output requirements 和参数 behavior instructions；
- 审计基线中 indirect formulas 和冲突 allocation 曾进入写作上下文；R01/R06 已分别统一分配真源并剥离间接审计；
- 规划字段随后被 binder 覆盖，模型对这些字段的生成有一部分是无效 token；
- evidence ID 约束没有升级为逐声明 source span/claim mapping。

## 5. 现实数据校验

### 5.1 70 篇参考样本

系统硬编码了 70 篇的标题、正文、评论长度分布，并明确标注为描述性基线。这个边界是正确的：样本没有完整曝光、点击、收藏、咨询、失败对照或随机分配，因此不能推出“短正文更好”“评论越多越好”或平台推荐阈值。

当前生产 prompt **不会注入 70 篇原文**；只有一个“样本中段形态”预设会参考聚合长度。原始 70 篇文件也不在当前项目知识库中。现有 app.db 只加载 `星零感微孔去眼袋_AI知识库.md`。

### 5.2 人类评分/旧实验产物

仓库外层存在 50 条含 `human` 字段的评分汇总及多轮模型评分产物，但 `content-agent` 没有读取这些文件的生产代码。它们目前既未用于风格检索，也未用于参数校准或独立验证。

这批数据可以用于后续“表达范式归纳/离线候选比较”，但必须先补齐：样本内容到评分的稳定主键、评分者与量表说明、盲评/重复测量信息、生成版本、任务分层、泄漏检查。它们不能直接证明推荐、咨询或成交效果。

### 5.3 建议的数据分层（待批准后实现）

- **事实知识库**：项目事实、边界、证据，只能支持可发布声明；
- **表达案例库**：70 篇和高分样本，只学习形式、节奏、问答组织，不作为项目事实；
- **评价集**：冻结样本、盲评标签和失败样本，只用于离线比较；
- **线上观察集**：真实曝光路径、消费、评论可见、合格行动等，才可用于 F08/F11/F15—F24/F31/F35/F37。

## 6. 论文与平台证据如何使用

完整、机器可读的“支持/不能推出/反方边界”在 `formula-evidence-catalog.json`。本报告只列关键原则：

- 信息觅食和好奇理论支持“人会权衡信息价值、线索与获取成本”“感知缺口可能引发信息寻找”，不支持“小红书搜索者必开评论”或任何转化权重。
- 高涉入研究显示论证质量的作用可能更强，因此不能用“点击路径长”直接推出警惕和理性下降。
- 闭合需要、动机性推理和选择性接触支持把它们当作相互竞争的状态维度，不能给当前 stateSeed 的 0.x 常数赋值。
- generation/self-explanation 研究主要来自记忆、学习或实验说服任务；存在任务难度和复现边界，不能推出“让用户自己发现就更信、更买”。
- 真实评论研究不能外推到作者自建的模拟 FAQ，更不能把模拟问答当口碑。
- 鲁棒优化需要明确不确定集合；多样化检索支持相关性与新颖性权衡，但不能给 F27/F28/F29 的业务变量自动赋值。
- 小红书官方公示只证明推荐会使用内容与交互数据并存在去重/打散/兴趣发现，不公开普通笔记排名权重。
- 官方“热点榜”与“热议话题”是不同产品口径：前者公开搜索/传播/互动/点击率与分钟更新；后者公开发布/消费、个性化 12 项与小时更新。两者都不证明“加标签即可提高普通笔记触达”。其他来源必须明确记录，不能自动改写成这两类官方来源。

## 7. UI 陈述审计

公式页目前以“是否映射参数”解释“是否直接影响生成”，这是错误模型。后续 UI 应按阶段显示：

- 配置参数；
- 规划器执行；
- 直接写作指令；
- 产物绑定；
- 校验器门槛；
- 诊断/条件计算；
- 研究协议；
- 现实观测/知识更新。

每条公式还应同时显示：当前方程指纹、实现状态、代码落点、所需数据、论文支持、论文不能推出什么、反方/边界证据、官方平台说明，以及“该公式在本次生成实际运行了哪一步”。

## 8. 审计所依据的代码落点

- 公式、方程、ownership、direct 白名单：`packages/agent-core/src/formula.ts`
- F30 手工来源枚举、输入边界、`calculatorContract`、研究协议排除项与旧版精确迁移指纹：`packages/agent-core/src/formula.ts`、`packages/agent-core/src/types.ts`
- F32/F33 `diagnosticContract`、稳定排序、unknown/null 分项与提示隔离：`packages/agent-core/src/formula.ts`、`packages/agent-core/src/parameters.ts`、`packages/agent-core/src/prompt.ts`
- 参数注册、预设、行为说明、样本基线、F17/F21/F30 计算、参数侧 allocation：`packages/agent-core/src/parameters.ts`
- 机会筛选/排序、状态种子、规划侧 allocation、评论计划、M-CLOSE、F42、F43：`packages/agent-core/src/planning.ts`
- 默认 gap/evidence、fallback、评论 provenance binder、生成包：`packages/agent-core/src/engine.ts`
- 模型 Schema、direct/indirect 公式提示、输出规则：`packages/agent-core/src/prompt.ts`
- 事实/身份/评论/发现式/闭合校验：`packages/agent-core/src/content.ts`
- F38 分析、审批资源、unknown 数值归一化、coverage 存储：`apps/api/src/intelligence.service.ts`
- 生成、三稿覆盖记录、诊断合同 API 映射与历史降级：`apps/api/src/generation.service.ts`、`apps/api/src/diagnostic-contract.ts`
- 公式页与结果页陈述：`apps/web/src/pages/FormulasPage.tsx`、`apps/web/src/pages/GenerationResultPage.tsx`
- F32/F33 导出合同：`apps/api/src/export.service.ts`
- F30 服务端计算与精确旧版迁移：`apps/api/src/formula.service.ts`
- 方法论原文：`../小红书完整文案方法论_最终版.html`

## 9. 下一阶段入口

需要变更的事项已拆成独立审批项，见 `formula-review-checklist.md`。R01—R13 已实施；R14 以后在用户批准相应编号以前，不应把本报告中的建议直接合入生产行为。
