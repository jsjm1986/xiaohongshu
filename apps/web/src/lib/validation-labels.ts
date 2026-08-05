/**
 * 校验结论卡的 code → 中文说明(纯展示映射):
 * 已按 packages/agent-core/src/content.ts 与 engine.ts 的全部 add()/code 枚举
 * 逐一翻译;未识别的 code 返回 null,界面回落为展示系统原文 message + code,
 * 不猜译、不丢原文。
 */
export function validationIssueLabel(code?: string) {
  const labels: Record<string, string> = {
    // 必填与长度
    title_required: "缺少标题",
    body_required: "缺少正文",
    image_brief_required: "缺少图片简报",
    body_too_short: "正文低于最少字数",
    body_too_long: "正文超出最多字数",
    hashtag_count: "标签数量不符合要求",
    comment_thread_count: "评论线程数量不符合编排要求",
    comment_capacity_expanded: "为保信息完整,评论线程超出容量目标",
    // 后台语言泄露
    internal_audit_artifact_visible: "可见文案出现内部审计字段或证据编号",
    frontstage_instruction_leak: "可见文案泄露了后台指令或模型身份",
    audit_language_surface_leak: "可见文案混入大量审计/公式术语",
    audit_language_surface_drift: "可见文案带有审计/公式腔",
    comment_plan_language_surface_leak: "评论里出现写作指令而非真人说话",
    comment_source_language_surface_leak: "评论暴露了源资料/审计语言",
    comment_context_meta_leak: "评论出现“正文说/文中提到”等提示词痕迹",
    // 样本形态
    sample_title_shape_drift: "标题长度偏离样本形态目标",
    sample_body_shape_drift: "正文长度偏离样本形态目标",
    sample_comment_line_shape_drift: "评论行数偏离样本形态目标",
    comment_network_overexpanded: "评论区整体过长,读起来像文章而非评论",
    comment_network_length_drift: "评论区密度明显高于参考样本",
    image_product_shape_drift: "图片简报没有呈现生活场景",
    // 评论区结构与声音
    comment_surface_roles_flat: "评论社会角色单一,像同一个人在问答",
    comment_host_meta_question: "评论用了主持人/采访腔",
    comment_network_under_grown: "评论自然生长不足",
    comment_network_over_grown: "评论生长轮数超出自然触发",
    comment_platform_register_overloaded: "单条评论堆砌过多平台腔标记",
    comment_network_all_questions: "评论全是提问,缺少反应、经历或观察",
    comment_reply_voice_repetition: "多条回复开头雷同,像一个声音",
    comment_network_symmetric_shape: "主评论与回复长度整齐划一,像填空",
    comment_disclaimer: "评论区缺少“问答参考”声明",
    simulation_disclaimer: "评论区缺少“模拟情景”声明",
    comment_inference_effort_high: "评论的推断门槛偏高",
    thread_unit_incomplete: "评论线程字段不完整",
    scenario_metadata_missing: "评论线程缺少模拟情景元数据",
    invalid_scenario_speaker: "提问者未标记为模拟读者",
    unaccountable_answer_identity: "答复方不是可追责身份",
    accountable_identity_incomplete: "项目双号身份配置不完整,答复展示名回落兜底",
    comment_identity_violation: "评论发布身份不合法",
    unsupported_narrative_history: "机构账号正文出现未经确认的个人经历",
    author_fact_scope_exceeded: "个人作者文案超出已确认事实范围",
    publishing_topology_voice_mismatch: "正文口吻与冻结的发布账号类型不一致",
    host_reply_identity_violation: "楼主回复没有使用已确认作者身份",
    org_answer_identity_violation: "项目答疑没有使用合法机构身份",
    host_reply_unconfirmed_author: "未确认个人作者却生成了楼主回复",
    host_reply_evidence_violation: "楼主回复错误挂载项目证据",
    host_reply_author_fact_mismatch: "楼主回复无法追溯到已确认作者事实",
    host_reply_controlled_claim: "楼主越权回答了项目事实或受控宣称",
    host_reply_followup_violation: "楼主线程在缺少节点身份时继续生长",
    organic_reaction_answer_violation: "漂浮短反应不应包含答复",
    comment_display_name_institutional: "昵称含机构感词,容易被误认",
    comment_display_name_identity_clash: "昵称与机构身份重名,读者分不清",
    marketing_claim_grounding: "营销向说法缺少依据支撑",
    fabricated_operational_experience: "模拟角色声称完成项目或效果,属于编造",
    reader_exchange_controlled_claim: "读者互聊夹带价格/机构/效果类宣称",
    comment_host_state_inconsistency: "答复声称“已做”而正文只说“打算做”,人设不一致",
    publisher_narrative_identity_alias: "机构发布账号被错误署成楼主/博主，身份不一致",
    reply_identity_plan_drift: "答复身份偏离生成前冻结计划",
    reply_display_role_plan_drift: "答复角色名偏离生成前冻结计划",
    reply_question_plan_drift: "提问偏离生成前冻结的主问题职责",
    reader_question_plan_drift: "模型提问偏题，已回退到冻结主问题",
    verified_claim_without_evidence: "标记“有证据”但没有证据",
    verified_thread_claim_not_mapped: "已核验线程缺少事实映射",
    thread_evidence_ledger_mismatch: "线程证据编号与引用不一致",
    followup_evidence_ledger_mismatch: "追问的证据编号与引用不一致",
    fabricated_testimonial: "用读者模板冒充亲身经历",
    comment_reply_plan_missing: "线程缺少答复规划(历史内容)",
    comment_discovery_plan_missing: "线程缺少发现式规划(历史内容)",
    comment_discovery_withholding: "发现式线索故意不揭示",
    comment_discovery_false_closure: "把线索误当成确定结论",
    comment_discovery_as_evidence: "把推断当成了证据",
    comment_density_metadata_incomplete: "评论密度元数据不完整",
    comment_primary_gap_mismatch: "主缺口标识不一致",
    comment_role_stage_mismatch: "角色卡阶段与线程阶段不一致",
    comment_gap_multiplexing_exceeded: "单条线程承担的辅助维度超限",
    comment_density_proxy_mismatch: "评论密度结构与说明不符",
    comment_role_constraint_ungrounded: "角色约束没有出处也未标核验",
    comment_question_not_compressed: "提问超出压缩目标",
    comment_keyword_pile: "提问在堆砌关键词",
    duplicate_comment_question: "重复提问",
    duplicate_comment_answer: "重复回答",
    near_duplicate_comment_answer: "回答与已有内容过于相似",
    comment_repeats_body: "评论照抄正文",
    duplicate_channel_information: "评论逐字重复了正文段落",
    // 事实与证据
    unknown_evidence: "引用了未披露的证据编号",
    package_evidence_ledger_mismatch: "证据编号与推理引用不一致",
    reasoning_location_missing: "推理条目没有可见落点",
    reasoning_statement_not_visible: "推理陈述没有出现在可见文案中",
    comment_reasoning_occurrence_missing: "评论事实没有标明准确出处位置",
    evidence_quote_empty: "证据引用为空",
    evidence_source_unavailable: "证据没有可用的源文本",
    evidence_quote_not_exact: "证据引用不是源文原文",
    evidence_quote_not_supportive: "证据引用与事实陈述关联不足",
    evidence_reference_metadata_missing: "证据缺少身份元数据",
    evidence_role_cannot_support_fact: "这类证据不能支撑事实宣称",
    evidence_scope_not_visible: "事实没有写出证据的适用范围",
    evidence_caveat_not_visible: "证据附带的保留说明没有写出来",
    ungrounded_fact: "事实没有证据引用",
    fact_source_span_missing: "事实缺少精确的源文片段",
    fact_source_id_mismatch: "事实的证据编号与引用片段不一致",
    visible_claim_not_in_ledger: "可见说法没有在事实账本中登记",
    sensitive_claim_without_evidence: "敏感宣称(医疗/价格/效果)缺少事实证据",
    unknown_as_fact: "把未知信息当成了事实",
    prohibited_claim: "出现了禁止的宣称",
    missing_required_phrase: "缺少必须出现的表述",
    forbidden_phrase: "出现了被禁止的表述",
    conflict_as_fact: "把未解决的冲突信息当成了定论",
    knowledge_backed_claim_unrecorded: "知识型说法没有在事实账本登记",
    blueprint_prohibited_history_unspecified: "项目分析未给出禁止声称的经历(建议重跑分析)",
    // 追问层级(L1 补条件 → L2 反例 → L3 核验)
    comment_follow_up_level_not_ascending: "追问层级没有递进(应 L1→L2→L3)",
    comment_follow_up_stop_not_final: "标了停止理由却还在继续追问",
    // 缺口与覆盖
    comment_gap_coverage_ledger_missing: "缺少缺口覆盖台账(历史内容)",
    comment_coverage_capacity_mismatch: "覆盖台账与编排线程数不一致",
    comment_gap_silently_dropped: "有缺口没有被任何通道承担",
    comment_gap_missing_primary: "评论缺口没有主线程承担",
    comment_auxiliary_false_resolution: "仅靠辅助维度就标记缺口已解决",
    comment_required_gap_deferred: "必要缺口被延后处理",
    comment_gap_input_unspecified: "等待用户输入的缺口没有说明需要什么",
    comment_gap_verification_unspecified: "未知缺口缺少核验路径",
    allocated_unknown_path_not_visible: "分配的未知缺口在可见内容中没有交代完整",
    comment_gap_primary_thread_missing: "缺口引用的主线程不存在",
    comment_gap_primary_thread_mismatch: "线程没有绑定它规划的主缺口",
    gap_resolution_not_realized: "规划要解决的缺口在成稿里没有完整落地",
    body_gap_false_resolution: "正文缺口被误标为已解决",
    planned_body_gap_not_realized: "计划由正文回答的缺口没有完整实现",
    planned_comment_gap_not_realized: "计划由评论回答的缺口没有完整实现",
    // 图文对齐与模型运行
    plan_to_copy_alignment: "图片说明与计划锚点需要人工复核",
    repair_parse_failed: "模型输出没有完整解析,本次生成不完整",
    model_ledger_failed: "事实账本生成失败(文案可用,事实锚定待人工复核)",
    model_comment_growth_failed: "评论多轮生长失败",
  };
  return (code && labels[code]) || null;
}

/**
 * 全部未通过项的说明清单(按原顺序、去重)。
 *
 * 与 firstValidationIssueLabel 的分工:一句话结论用首条,展开清单用这个。
 * 只显示首条会让用户改完一处又冒出下一处,始终不知道还剩几个问题。
 * 不可识别的 code 原样保留——宁可露出英文 code 供人工核对,也不猜译、不丢。
 */
export function allValidationIssueLabels(codes?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of codes ?? []) {
    if (!code) continue;
    const label = validationIssueLabel(code) ?? code;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/** 返回首个可识别 code 的中文说明;全部不可识别或列表为空时返回 null。 */
export function firstValidationIssueLabel(codes?: string[]): string | null {
  for (const code of codes ?? []) {
    const label = validationIssueLabel(code);
    if (label) return label;
  }
  return null;
}
