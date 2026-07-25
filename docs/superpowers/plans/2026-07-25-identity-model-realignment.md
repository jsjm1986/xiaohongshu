# 身份模型按方法论重整 + 参数分侧接通

## 背景：三处结构性偏离

对照 `小红书完整文案方法论_最终版.html` 原文（已逐条核实，非转述）：

| 方法论 | 我们的实现 | 偏离 |
|---|---|---|
| L1738 ROLE 04 · publisher「用实际发布身份给**直接回答、条件、反例和下一步**；自有账号不能冒充独立消费者」 | publisher =「楼主(顾客人设)，只说自己的经历、功课，**不答项目事实**」 | **语义反转**，且商业主体以消费者身份说话 |
| L1750-1772 六个读者角色**各自带**「禁止代替的证据」禁令（首次调研者「不能说我已经体验过」…） | `experienceCarrier` 每篇至多一条线程可说亲历（名额制） | 方法论无此概念，配额是臆造 |
| L1634「postingIdentity 不属于滑杆，任何档位都不能降低」 | `commentStage` 是死字段，4 个评论阶段拿不到任何参数指令 | 参数链路断裂 |

已对齐、不动的部分：`CommentPersonaRole` 六值 == 方法论六读者角色；`CommentSpeakerType` == `simulated_reader|accountable_responder`；`STAGED_COMMENT_DISCLAIMER` 已满足 L1729/L1793 标注要求。

## 关键约束（决定实现形态）

1. **不改 wire type、不重命名。** `types.ts:916` 已含方法论四值 `author|brand|staff|expert` + `publisher|reader_question_template`；`prompt.ts:96` 模型 schema 已恰好是方法论四值。`author`/`brand` 全仓**无任何运行时赋值点**（只在类型、schema、解析白名单里）。保留三值 `publisher|staff|expert` 只改语义 → 避开 119 处字面量与 30 文件的迁移。
2. **只注入 trace 级 `behaviorInstructions`，绝不带 preset/style 散文。** `search_decision` 预设 directive 含「避免单个楼主回复包办全部信息」，整份塞入 staff 侧会撞穿隔离测试的 `not.toContain("楼主")` —— 该测试是对的，散文跨身份、塞给单一身份就是漏另一侧角色概念。
3. **`personaScenePlan.host` 不删。** 它是正文的声音，方法论 L1594 允许拟人情境（「职业、城市、经历可作为明确的拟人情境，但不能冒充项目事实、真实消费者证词或独立口碑」）。改的是 publisher 在评论里**做什么**，不是删掉声音。
4. **校验层 error+repairable 是 repair 回路的反馈信号**（`prompt.ts:1528-1535` 原样回灌 `{code,channel,message}`，驱动最多 2 轮重写）。不拆反馈线；只回退本轮新加的关键词探测器。

---

## Phase 1 · publisher 语义翻转

### 1a. planning.ts

- `buildReplyIdentityAssignmentBrief` 三身份职责（1295-1297）重写：
  - `publisher`: 发布账号本人（可追责）——直接回答＋适用条件＋证据＋边界；答不出标 unknown 或转专业核验；不冒充独立消费者、不说亲历口碑。
  - `staff` / `expert` 描述保留（营销承接 / 专业解答）。
- `分布要求`（1300-1303）：删除「情绪、正文细节与个人经历类话头给 publisher」，改为「事实、条件、边界类话头默认 publisher（可追责主答）」。
- `forcedReplyDisplayRole` publisher 分支：`"楼主"` → 新增 `resolvePublisherDisplayRole(blueprint)`（取 `relationToHost` 指向发布账号本人的 accountable 角色 displayRole），兜底 `config.project.name`。
- `routeReplyPostingIdentity` 兜底仍为 `publisher` —— 与 ROLE 04「publisher 是主答」一致，无需改。

### 1b. prompt.ts

- `orgSideCommentContext` publisher 分支（972-1000）**整段重写**：
  - 身份说明：发布账号本人，可追责答复方。
  - 答复契约按 L1744 的 `直接答案 + 条件 + evidenceIds + boundary`；动态信息带「以当期确认为准」；无口径 → 保留 unknown 或转专业核验。
  - 保留 host 的 `voiceTraits`/`speechMarkers` 作为**语气**；删除「顾客人设 / 只说自己的事 / 不答项目事实 / 你问他们官方助理」。
  - 保留硬句「禁止每条都写…」（L1999 已有）。
  - 副作用：修掉当前 2 个失败测试对 publisher 上下文 `not.toContain("助理")` 的违反（997 行那句「你问他们官方/助理」随之消失）。
- `orgSideCommentContext` staff 分支（1034 附近）：补硬句「禁止每条都写"直接回答＋条件＋边界＋未知＋下一步"」，与 publisher/expert 对齐 → 修掉另 2 个失败测试。
- `ownedFirstCommentRule`（1126-1127）：按 L780「发布账号整理常见问题**可以明确标注**为常见问题/FAQ」补上显式标注要求。

### 1c. web

- `comment-cref.ts` `orgAnswerIdentityBadge`：publisher `"楼主 · 发布者本人"` → `"发布账号 · 可追责答复"`。
- `GenerationResultPage.tsx:917-918`：`"楼主"` → `"发布账号"`。
- `postingIdentityText` 已是「发布账号（publisher）」，不动。

## Phase 2 · experienceCarrier 名额制 → 标注制

删（4 src + 5 test，共 9 处引用）：
- `types.ts:1557` 字段定义
- `planning.ts:1938-1940` carrier 指派
- `prompt.ts:856` `经历位: true`
- `content.ts:1621-1650` 配额校验 → **回退到 git HEAD 版本**（连同我本轮加的 `大前天|前天` 正则一起退，`content.ts:759` / `1637`）
- `dual-identity-comments.test.ts` 313-390、521-565 的 carrier/配额用例

加（正确层：steering，进 prompt 文本）：
- `prompt.ts` `readerSideCommentContext` 第 823 行「只有规格里标记了经历位的线程…」→ 替换为**逐读者角色的禁止代替的证据表**，照 L1750-1772 原文：
  - 首次调研者 → 不能说「我已经体验过」或预设某方案一定适合
  - 信息收集者 → 不能把行业常见说法当当前项目事实
  - 方案比较者 → 不能制造脱离条件的唯一赢家或虚假竞品数据
  - 风险关注者 → 不能用恐惧叙事或无依据极端案例替代风险证据
  - 本地行动者 → 缺少城市或人物资料时不得自动补名、排名或口碑
  - 怀疑复核者 → 不能扮演独立第三方背书，也不能把质疑数量当可信度
- 该表按 `personaRole` 投影进每个角色卡（角色池已有 `personaRole`）。

同时保留 `content.ts` 里由蓝图 `prohibitedUnsupportedHistories` 驱动的 `fabricated_operational_experience` 硬 error —— 那是项目数据锚定的合规红线（E 桶），不是关键词猜测。

## Phase 3 · 参数分侧接通（`commentStage` 激活）

- `parameters.ts`：
  - 修 `information_breadth` 漏标 `commentStage`（channels 含 Cref 却会被静默排除）。
  - 新增 `commentStageInstructions(report, "reader" | "answer")`：按 `parameterId` 回 `GENERATION_PARAMETER_REGISTRY` join 读 `commentStage`（`ParameterImpactTrace` 无此字段），取 `both` ∪ 本侧，排除 `isDisplayOnlyDiagnosticParameter`，**不含 preset/style 散文**。
  - `experience_information_strength` 只能按 `commentStage` 认，不能按 channel 认（它 channels 无 Cref）。
- `prompt.ts`：`readerSideCommentContext` 注入 reader 侧、`orgSideCommentContext` 注入 answer 侧。四个 builder 已持有 `input.impactReport`，**无需改签名**。
- `PROMPT_CONTRACT_VERSION` 按既有约定 bump（digest 只哈希 system prompt 与 schema，纯 phase 文本不移动 digest —— 显式决定 bump 版本号）。

## 验证

按 Phase 顺序，每阶段跑完再进下一阶段：

1. `npx vitest run test/cref-contract-v1-1.test.ts test/comment-role-isolation.test.ts` —— Phase 1 后当前 4 个失败必须转绿（publisher 契约断言需按新语义改写，staff 硬句是实现补齐）。
2. `npx vitest run test/dual-identity-comments.test.ts` —— Phase 2 后 carrier 用例已删，配额用例已删。
3. `npx tsc --noEmit`（agent-core + web）。
4. 全量 `npx vitest run`（agent-core 268 + web 124）。
5. Phase 3 新增测试：
   - 评论侧滑杆移动 → 评论阶段 prompt 文本改变（当前**无任何测试**钉这个行为）。
   - 隔离禁词表在注入后仍然成立（reader 侧无「助理/机构/楼主/staff」，staff 侧无「楼主/publisher」）。
   - L1634 守门：注入集合不含任何能改 `postingIdentity`／证据严格度／unknown 标记的指令。

## 风险与取舍

- **输出风格会变。** publisher 从「素人楼主聊自己」变成「发布账号带证据答问」，评论区观感明显不同。这是方法论 L1738 要求的合规形态（自有账号不得冒充独立消费者），已确认接受。
- **Phase 3 最后做。** 参数注入会改动全部四个评论阶段的 prompt 文本，隔离禁词表是唯一防线；必须在 Phase 1/2 的隔离测试全绿之后才动，否则无法区分是注入漏了角色概念还是身份重整本身的问题。
- **不做的事**：不重命名 `publisher`→`author`；不补 `author`/`brand` 的运行时赋值；不实现方法论的 L0–L3 追问层级与 `stopWhen`（`followUpDepth` 目前是纯计数，补层级语义是独立一件事，本轮不含）。
