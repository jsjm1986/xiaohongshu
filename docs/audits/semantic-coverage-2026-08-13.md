# 语义校验覆盖抽样审计 2026-08-13

> 只读扫描 `/Users/a1234/Desktop/开发项目/小红书创作/文案/content-agent/data/app.db`;包总数 359,可解析 359,损坏 0。
> 护栏失败按重试改造日(2026-08-13)分桶:之前 359 包,之后 0 包。

## 1. 质量状态与生成模式分布

| 质量状态 | 包数 | 占比 |
|---|---|---|
| 字段前时代(旧包) | 222 | 61.8% |
| passed(旧包按 valid 推导) | 89 | 24.8% |
| blocked | 28 | 7.8% |
| needs_review | 19 | 5.3% |
| passed | 1 | 0.3% |

| 生成模式 | 包数 | 占比 |
|---|---|---|
| 字段前时代(旧包) | 338 | 94.2% |
| model_generated | 21 | 5.8% |

## 2. 公式覆盖:包级诊断实测 + 全公式实现状态

包级 diagnostics 按设计只由 F32/F33 与两个聚合视图产出,其余公式的执行
痕迹在规划/生成/校验代码路径里。诊断实测:

| 诊断 | 出现包数 | 占比 |
|---|---|---|
| 聚合:hard_constraints | 359 | 100.0% |
| 聚合:review_warnings | 359 | 100.0% |
| F32 | 359 | 100.0% |
| F33 | 359 | 100.0% |

全公式实现状态(注册表口径,代码内维护的实现审查结论):

| 实现状态 | 数量 | 公式 |
|---|---|---|
| partial | 19 | F02, F05, F07, F09, F10, F12, F13, F14, F19, F22, F26, F32, F33, F34, F36, F38, F39, F40, F41 |
| protocol-only | 14 | F08, F11, F15, F16, F18, F20, F23, F24, F27, F28, F29, F31, F35, F37 |
| active | 7 | F01, F03, F04, F06, F25, F42, F43 |
| conditional | 3 | F17, F21, F30 |

> `protocol-only` = 文档/合同承诺但不在运行时执行;`not_executed` = 声明了但
> 未接线。对外描述能力时必须按 active/partial 口径,不要把 protocol-only 说成已执行。

## 3. 校验 issue 分布(前 30)

| code | 次数 | severity | disposition |
|---|---|---|---|
| knowledge_backed_claim_unrecorded | 631 | warning | -/advisory |
| marketing_claim_grounding | 481 | warning | -/advisory |
| gap_resolution_not_realized | 379 | error/warning | -/block/advisory/review |
| sensitive_claim_without_evidence | 315 | error/warning | -/block/review |
| planned_body_gap_not_realized | 278 | error/warning | -/block/review |
| planned_comment_gap_not_realized | 218 | error/warning | - |
| allocated_unknown_path_not_visible | 205 | warning/error | -/advisory/block/review |
| plan_to_copy_alignment | 202 | warning | - |
| model_ledger_failed | 145 | error/warning | -/review |
| comment_network_length_drift | 142 | warning | - |
| evidence_caveat_not_visible | 129 | warning | -/advisory |
| repair_parse_failed | 110 | error/warning | -/block/review |
| sample_body_shape_drift | 108 | warning | -/advisory |
| creative_persona_experience | 77 | warning | -/advisory |
| visible_claim_not_in_ledger | 52 | error/warning | -/block/review |
| comment_network_under_grown | 51 | warning | - |
| reader_exchange_controlled_claim | 41 | warning | -/advisory |
| accountable_identity_incomplete | 41 | warning | -/review |
| comment_reply_topic_drift | 40 | warning | review |
| thread_unit_incomplete | 38 | warning | -/advisory |
| comment_reply_plan_missing | 38 | warning | -/advisory |
| comment_discovery_plan_missing | 38 | warning | -/advisory |
| fabricated_operational_experience | 35 | error/warning | -/block/review |
| creative_reputation_scene | 32 | warning | - |
| sample_title_shape_drift | 30 | warning | -/advisory |
| comment_keyword_pile | 30 | error | - |
| evidence_scope_not_visible | 27 | warning | advisory |
| model_org_answer_failed | 25 | warning | -/advisory |
| reader_question_plan_drift | 22 | warning | -/advisory |
| required_information_not_realized | 21 | warning | review |

## 4. 模型护栏失败痕迹(重试改造前后)

| code | 改造前 | 改造后 |
|---|---|---|
| model_claim_judge_failed | 8 | 0 |
| model_ledger_failed | 145 | 0 |
| repair_parse_failed | 110 | 0 |
| model_comment_plan_failed | 0 | 0 |

## 5. 自动生成的整改线索

- 最高频 issue `knowledge_backed_claim_unrecorded`(631 次):优先分析它是规则过严还是内容真缺陷。
- 14 条公式是 protocol-only(承诺但不执行):销售与文档措辞按 active/partial 口径收口。
- 重试改造后护栏失败为 0:瞬时故障重试策略生效,保持观察。
