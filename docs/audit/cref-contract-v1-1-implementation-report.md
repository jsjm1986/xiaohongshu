# Cref（评论区）契约 v1.1 实施报告（2026-07-23）

> 范围：评论参考范式（Cref）的结构、提示词、编排、校验、知识证据链与展示层。
> 依据：9 个真实生成包（43 线程）审查 + 最终方法论《小红书完整文案方法论_最终版.html》目标契约 + 70 篇真实语料评论区统计。
> 本报告同时是 release 重新激活与 P0 数据确认的操作指引。

---

## 1. 修了什么（问题 → 修复对照）

### A. 结构性

| 问题 | 根因（行号为修复前） | 修复 |
|---|---|---|
| 多轮接龙永不触发（43/43 单轮） | 开关 `commentMultiTurnGrowthEnabled` 无注册表/预设/简单模式入口（types.ts:437）；2A 强制清空 followUps；multiTurnTarget 不看开关 → `comment_network_under_grown` 必然误报 | 新参数 `comment_multi_turn_growth` 入注册表（parameters.ts:337，默认关，evidenceStatus=operational_default）；三档丰富度映射（克制关/均衡开/高密度开，simple-generation.ts:34-46）；planning.ts:816-832/1194-1197 multiTurnTarget 与 multiTurnCount 随开关（关=[0,0]，不误报）；2B 提示词原文未动（质量本就好） |
| 回复身份体系失效 | postingIdentity 硬编码 "author"（planning.ts:1320）；蓝图角色 replyDisplayRoles=["AI客服"]、accountable=false → 无人能合法答事实；replyDisplayRole 不绑定 answer 声音 | planning 产出 "publisher"（发布账号/楼主）；2A 重写身份契约（prompt.ts:683-688）：答复=publisher 延续 host 声音、绑定 replyDisplayRole、accountable 规则接通；蓝图 role_model 数据修正模板已交付（P0，待用户确认） |
| 身份/经历矛盾漏检 | 无 body↔Cref 一致性校验；fabricated_operational_experience 依赖的蓝图词表是口号非动作 | 新增 error 级 `comment_identity_violation`（答复方非可追责身份）与 `comment_host_state_inconsistency`（正文意向态时答复不得声称完成式经历，领域中立实现+认知动词豁免）；fabricated 增第三支（正文意向态+问题侧完成式）；scenario_model 词表修正模板已交付 |
| Q/A schema 表达力不足 | 仅 question/answer 两槽，角色倒置 | 契约 v1.1：线程 kind/answerKind/boundary/function 显式字段（六值 function 由模型按内容标注，planning 内容派生兜底，删除 functionCycle 位置轮换）；包级 ownedFirstComment/uncoveredGaps |
| 角色丰富性不足 | role_model 仅 3 角色且全是提问侧；生成提示词无覆盖要求（intelligence.service.ts:2249） | 蓝图分析提示词加覆盖矩阵（≥6 提问角色、utteranceModes≥3、恰 1 个 accountable 答复身份、hostVoiceTraits 与真实身份一致）；role_model 数据模板（1 答复者+7 提问者）已交付待确认；校验 comment_surface_roles_flat 升级为覆盖度检查（warning，待数据达标） |

### B. 功能性

| 问题 | 根因 | 修复 |
|---|---|---|
| 踢皮球/无证声明二选一 | 知识全文在上下文（mode=full 已核实），但①full 模式整篇 1 个证据 ID（knowledge.ts:369-378）；②frontmatter 损坏；③台账 179 条仅 5 条 fact、citedEvidence 全 0；④15 缺口 answer 全空，知识库现成口径（§5.1/§6.2/§9）未变成缺口答案 | full 模式改用 splitDocument 分节（knowledge.ts:369-374，与 progressive 同节同证据 ID）；台账提示词加硬要求"命中知识口径必须记 fact 挂节级 sourceSpan"（prompt.ts:801-802）；2A 答复三路径优先级（引用口径+限定语 → 路由式回答 → 保留未知）；缺口答案模板+知识按状态拆分 4 文件模板已交付（P0 待用户确认填入） |
| 跨候选/跨任务雷同 | 去重只在单包内；demo 生成器罐头文案按 utteranceMode 重复 | demo 生成器：模板织入缺口片段 + 碰撞时轮换结构不同的模板（engine.ts:798-880）；同义指名放宽（sharesContiguousFragment） |
| function/置顶/aC | functionCycle 轮换；pinPriority 含非法枚举 "boundary"；nextStep 常量；deploymentPlan 静态 | function 内容化（模型标注+deriveThreadFunction 兜底）；pinPriority 修合法枚举；nextStep 按卡生成（deriveThreadNextStep 三分支）；aC 结构化：sla、liveRouting {route,condition,action}、updatePolicy，与 Cref 严格分离（F03） |

### C. 校验与工程

- 级别重排：growth 开启后 `comment_network_under_grown` 升 error；voice_repetition/symmetric_shape 重度升 error；all_questions 在有 followUps 时豁免；`allocated_unknown_path_not_visible` namesGap 放宽 + preservesUnknown 补自然表述（还没定/没确认/不敢定/别自己定等）。
- 证据闭环：新增 `knowledge_backed_claim_unrecorded`（warning，命中知识口径未记 fact 时提示）。
- 修复协议：agent-core 自实现宽松 JSON 解析（围栏/全角）+ Cref patch 按 id 键控合并（容忍乱序/部分）+ 彻底失败不 throw（needs_review 存活）。`repair_parse_failed` 基线 4/9 包，协议脆度已消除。
- 展示层：结果页/导出/投影适配 v1.1 全部新字段（首评区、kind 徽章、boundary、next_step、证据引用、aC 区块、未展开缺口；历史包字段缺失即不渲染、导出逐字兼容）；缺口池新增答案+证据ID+边界编辑（走 draft→approve）。

## 2. 契约变更（fail-closed 预期行为）

- `PROMPT_CONTRACT_VERSION` 2.0.0 → **2.1.0**（staged schema 扩展进 digest）。
- `ContentPackage.schemaVersion` "1.0" → **"1.1"**（新字段全可选，历史包直接可读、不回填）。
- 参数注册表新增 `comment_multi_turn_growth` → `PARAMETER_POLICY_DIGEST` 变化。
- **影响**：现有 active release（0.1.0-baseline）的 prompt/parameter digest 与运行时不一致，按设计 fail-closed——生成会被 `ACTIVE_RELEASE_REQUIRED` 类错误阻断，直到新发布清单激活。

### release 重新激活操作（部署本代码后必做）
1. 侧栏「研究与证据」→「发布版本」→ 新建发布清单（绑定当前 active 公式版本；快照/结果/校准按实际勾选）。
2. 批准该清单 → 点「激活到生成运行时」。激活时服务端重新校验四个 digest（公式/执行策略/提示合同/参数政策），与新运行时一致即通过。
3. 此后每个生成任务冻结新 release 快照，历史包不受影响。

## 3. 量化对照

| 指标 | 修复前（9 真实包） | 修复后（demo 端到端，真实冻结输入重放 ×2 配置） |
|---|---|---|
| 单轮线程占比 | 43/43（100%） | growth 关：15/15；**growth 开：9/15 单轮、6/15 生长** |
| 答复身份 | author（元数据标 AI客服，三层不一致） | **publisher，零 `comment_identity_violation`** |
| 身份矛盾 | pkg_9018 valid=true 带矛盾 | 新校验在位；demo 零误伤（"刚注意到"类认知动词已豁免） |
| kind/boundary 字段 | 无 | 全线程齐备 |
| 首评（ownedFirstComment） | 无 | 有，且不含内部词 |
| nextStep | 43/43 同一常量 | 按卡生成（≥2 变体，随缺口答案接入更丰富） |
| 角色去重 | 5 线程 3 角色（压线） | 同（蓝图数据待 P0 填入后 ≥6） |
| 校验结论 | 6/9 valid=false（含误伤与漏检并存） | **6/6 valid=true（无 error；warning 均为数据待修或既有正文形态项）** |
| 修复协议 | repair_parse_failed 4/9 包 | 宽松解析+id 键控合并+失败存活，无假失败 |
| 台账 fact 率 | 5/179（词组级） | demo 不适用（确定性台账本就极简）——**待真实模型 smoke 验证** |

## 4. 测试状态

- agent-core **182 全绿**（基线 145 + 新增 37）；web **68 全绿**（基线 59 含 1 项顺手修复的过期测试 + 新增 8）；api **51 通过 / 2 失败**（api.test.ts 两项权限用例，为基线既有失败：夹具换公式后未重建匹配 release，属产品行为符合设计、夹具过期，未扩大）。
- 新增覆盖：v1.1 契约正/反用例、身份契约、楼主状态一致性（含认知动词豁免）、开关两态、function 派生、nextStep 三分支、修复协议（围栏/全角/乱序/彻底失败）、full 模式分节与节级证据、导出新结构与历史包逐字兼容、缺口编辑 payload。
- 附带修复：web 过期测试 `research-governance.test.ts`（lib 改名 nextExperimentStatus→experimentTransitions 未同步）。

## 5. 遗留事项（按优先级）

1. **P0 数据确认（用户动作，模板已备好）**：`docs/p0-data-templates/` — 知识 4 文件上传+旧文件删除、8 个缺口答案+证据 ID 填入（7 个保持 unknown）、role_model 替换、scenario_model 词表修正；全部走 draft→approve。价格/资质等口径需机构确认后再批准。
2. **真实模型 smoke（需密钥，供应商不稳属已知风险）**：验证 2A/2B/台账在真实模型的表现——重点指标：台账 fact 率（基线 5/179）、citedEvidence、踢皮球句式占比、Reveal 落实率、角色去重（P0 数据后）。
3. **api 基线 2 项失败**（夹具过期，与本次无关，建议另起小任务修夹具）。
4. `comment_surface_roles_flat` 保持 warning，P0 role_model 生效后自然达标；如需更早硬约束可再升 error。
5. 范围外未动：H 标签独立入口、hardening spec Batch B–E、正文形态、Cuser,t 观测、真实投放标定。

## 6. 关键设计决策备忘

- **增量契约而非重写**：现有线程模型已有 id/gap/replyTo/postingIdentity/evidenceIds/nextStep，只新增 kind/answerKind/boundary/function + 包级首评/未展开缺口；未做 dialogue[] 全量重写。
- **answer 证据规则未松绑**：thread.evidenceIds 仍只来自 fact 台账 sourceSpans（"planned evidence is context, not a citation" 原原则保留）；信息承接的打通靠 P0 数据（缺口答案+节级证据）与台账强化，不靠校验放水。
- **2B 开关默认仍关**：M7 保守决策延续；均衡/高密度档开启。提示词"追问只由上一句具体词触发"。
- **领域中立**：agent-core 所有新校验/文案无行业词（blueprint-generalization 护栏通过）；动作词表来自蓝图/配置数据。
- **认知动词豁免**：楼主状态校验跳过"注意到/看到/知道/明白/发现"等认知动词，防"刚注意到"式误伤（api e2e 实证）。
- **demo 去重**：罐头模板按缺口织入+碰撞轮换结构模板（near-dup 为包含感知，后缀无效）。

## 7. 易用性复审与修复（2026-07-23 同日，U1–U6）

复审发现（以运营实际操作路径走查）并已修复：

| # | 问题 | 修复 |
|---|---|---|
| U1 | **阻断级**：证据 ID 无处可查，缺口编辑器只能手输哈希且填错静默降级 | 新只读端点 `GET /api/projects/:id/knowledge/evidence-sections`（知识分节+证据 ID+摘要+状态徽章，reference-corpus 排除）；缺口编辑器改为按文档分组的**证据点选器**（搜索/折叠/已选 chips）；失效引用黄色警示且**阻断保存**（不再静默丢弃） |
| U2 | 重新分析会插入全新 id 缺口，填好的答案变孤儿（顺序陷阱） | `docs/p0-data-templates/README.md` 加顺序红线：填答案后不得再点「分析项目」；要重新分析必须先分析后填答案 |
| U3 | 导出把可执行内容与审计元数据混排，运营没法直接用 | v1.1 包导出改**两段式**：第一部·执行版（发布内容→可发布首评→问答话术→aC 运营规则）+ 审计附录（非发布素材）；历史包逐字兼容（黄金 diff 验证）；web 复制按钮同口径 |
| U4 | release 阻断（ACTIVE_RELEASE_REQUIRED）无 UI 引导 | 生成失败 toast 命中 release 类错误时追加「研究与证据 → 发布版本」激活指引 |
| U5 | needs_review 无下一步指引；丰富度档位未说明成本 | 结果页新增「没有候选通过自动校验，可以怎么用」说明块；均衡/高密度档描述注明开启多轮接龙与耗时 |
| U6 | demo 文案：场景线索入正文、正式问句织口语、首评拼接啰嗦 | demo 生成器：元数据式身份线索过滤（"用户直接问价"类不再入正文）、>10 字正式问句不织入口语（唯一性由模板轮换承担）、首评拼接随之自然 |

复审同时确认业务主干逻辑正确：身份契约（2A→planning→bind→校验→展示→aC）端到端一致；缺口答案→评论的证据链闭环；claim_policy qualify/block 与提示词三路径一致；历史包兼容。

**测试累计**：agent-core 182、web 75、api 58 通过 + 2 项基线失败（未扩大）。新增：分节 API 5 项、证据点选 6 项、导出两段式 2+2 项。

- **增量契约而非重写**：现有线程模型已有 id/gap/replyTo/postingIdentity/evidenceIds/nextStep，只新增 kind/answerKind/boundary/function + 包级首评/未展开缺口；未做 dialogue[] 全量重写。
- **answer 证据规则未松绑**：thread.evidenceIds 仍只来自 fact 台账 sourceSpans（"planned evidence is context, not a citation" 原原则保留）；信息承接的打通靠 P0 数据（缺口答案+节级证据）与台账强化，不靠校验放水。
- **2B 开关默认仍关**：M7 保守决策延续；均衡/高密度档开启。提示词"追问只由上一句具体词触发"。
- **领域中立**：agent-core 所有新校验/文案无行业词（blueprint-generalization 护栏通过）；动作词表来自蓝图/配置数据。
- **认知动词豁免**：楼主状态校验跳过"注意到/看到/知道/明白/发现"等认知动词，防"刚注意到"式误伤（api e2e 实证）。
- **demo 去重**：罐头模板按缺口织入+碰撞轮换结构模板（near-dup 为包含感知，后缀无效）。
