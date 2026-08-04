import { describe, expect, it } from "vitest";

import {
  buildGenerationPrompt,
  buildRepairPrompt,
  buildKnowledgeLedger,
  BUILT_IN_GENERATION_PRESETS,
  BUILT_IN_STYLE_PROFILES,
  compileGenerationParameters,
  CONFIRMED_REFERENCE_SAMPLE_BASELINE,
  ContentGenerationAgent,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  DEFAULT_METHOD_PARAMETERS,
  GENERATION_PARAMETER_REGISTRY,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  GENERATION_OUTPUT_TOKENS,
  indexKnowledgeSource,
  selectKnowledgeContext,
} from "../src/index.js";

const project = {
  id: "parameter-project",
  name: "参数测试项目",
  domain: "决策信息",
  productPoints: ["资料确认了一个项目要点"],
  organizationPoints: [],
  cities: ["成都"],
  doctors: [],
};

function sharedTaskData(text: string): Record<string, any> {
  const match = text.match(/<task_data scope="shared">\n([\s\S]*?)\n<\/task_data>/u);
  return JSON.parse(match?.[1] ?? "{}");
}

function baseConfig() {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = "方案怎么选";
  config.informationWindow.gaps = ["适合什么情况", "恢复怎样判断", "价格包含什么", "怎么预约"];
  config.informationWindow.boundaries = ["个体结论需要结合实际条件核实"];
  return config;
}

const presetSemanticExpectations = {
  real_minimal: {
    label: "真实极简",
    description: "用一个人物处境和一个窄问题起帖，评论区自然接住细节。",
    values: { audience_stage: "collecting", entry_route: "recommendation", body_completeness: 32, body_min_chars: 25, body_max_chars: 75, comment_expansion: 88 },
    directive: "一个可识别人物处境",
  },
  first_research: {
    label: "新手功课",
    description: "帮助刚开始了解的人建立问题清单和判断顺序。",
    values: { audience_stage: "discovering", entry_route: "search", information_breadth: 85, decision_information_depth: 72, body_min_chars: 30, body_max_chars: 95 },
    directive: "模糊担心拟人成一个具体生活问题",
  },
  rational_compare: {
    label: "理性比较",
    description: "不直接给唯一答案，重点解释方案差异和适用条件。",
    values: { audience_stage: "comparing", entry_route: "search", decision_information_depth: 92, comment_conditionality: 92, boundary_visibility: 98, body_max_chars: 150 },
    directive: "已经做过功课的人",
  },
  hesitation_completion: {
    label: "犹豫补全",
    description: "承认不确定性，优先补风险、边界和下一步信息。",
    values: { audience_stage: "hesitating", decision_information_depth: 85, state_information_strength: 88, comment_conditionality: 95, boundary_visibility: 100, follow_up_depth: 2 },
    directive: "具体时点和生活限制",
  },
  local_choice: {
    label: "本地选择",
    description: "面向已准备行动的用户，补全城市、人物和筛选依据。",
    values: { audience_stage: "ready", entry_route: "profile", decision_information_depth: 90, route_specificity: 100, evidence_strictness: 98, body_max_chars: 110 },
    directive: "地点和对象只使用任务及项目模型已有值",
  },
  balanced_information: {
    label: "均衡信息补全",
    description: "正文保留共同主线，评论展开条件分支。",
    values: { information_breadth: 65, decision_information_depth: 70, body_completeness: 45, comment_expansion: 78, body_min_chars: 40, body_max_chars: 140 },
    directive: "人物、现场和窄问题成立",
  },
  search_decision: {
    label: "搜索决策补全",
    description: "主动搜索/比较，直接答疑、依据和经验方法。",
    values: { audience_stage: "comparing", entry_route: "search", decision_information_depth: 90, route_specificity: 95, body_completeness: 52, body_max_chars: 155 },
    directive: "正在比较的人来讲",
  },
  minimal_body_conditional_comments: {
    label: "短正文＋条件问答",
    description: "正文保持最小充分，评论承担可查找的长尾分支。",
    values: { audience_stage: "collecting", entry_route: "recommendation", body_completeness: 28, comment_expansion: 92, comment_conditionality: 82, body_min_chars: 20, body_max_chars: 70, comment_thread_max: 5 },
    directive: "人物关系网逐层补全",
  },
  comparison_framework: {
    label: "比较核验清单",
    description: "把模糊纠结变成可比较条件和筛选步骤。",
    values: { audience_stage: "comparing", decision_information_depth: 95, route_specificity: 95, novelty_angle: 55, paragraph_target: 3, body_max_chars: 165 },
    directive: "比较清单隐藏在一个真实纠结里",
  },
  state_experience_entry: {
    label: "状态/经历入口",
    description: "用有依据的状态和生活线索建立相关性，再进入判断信息。",
    values: { audience_stage: "discovering", entry_route: "recommendation", state_information_strength: 95, experience_information_strength: 95, decision_information_depth: 55, route_specificity: 55 },
    directive: "普通生活瞬间承载主题",
  },
} as const;

describe("explainable generation parameter registry", () => {
  it("has one unique, UI-ready source of truth with novice/effect/formula/channel/evidence metadata", () => {
    expect(GENERATION_PARAMETER_REGISTRY.length).toBeGreaterThan(40);
    expect(new Set(GENERATION_PARAMETER_REGISTRY.map((item) => item.id)).size).toBe(GENERATION_PARAMETER_REGISTRY.length);
    expect(new Set(GENERATION_PARAMETER_REGISTRY.map((item) => item.path)).size).toBe(GENERATION_PARAMETER_REGISTRY.length);
    const formulaIds = new Set(DEFAULT_FORMULA_VERSION.formulas.map((item) => item.id));
    for (const definition of GENERATION_PARAMETER_REGISTRY) {
      expect(definition.path).not.toBe("");
      expect(definition.noviceExplanation).not.toBe("");
      expect(definition.increaseEffect).not.toBe("");
      expect(definition.decreaseEffect).not.toBe("");
      expect(definition.formulaIds.length).toBeGreaterThan(0);
      expect(definition.formulaIds.every((id) => formulaIds.has(id))).toBe(true);
      expect(definition.channels.length).toBeGreaterThan(0);
      expect(definition.evidenceNote).not.toBe("");
      expect(definition.control).toMatchObject({ simpleMode: expect.any(Boolean), advanced: expect.any(Boolean) });
      // 执行强度必须逐个显式标注,不允许漏标(漏标会让 UI 对用户高估约束力)。
      expect(["validated", "derived", "guidance", "display"]).toContain(definition.enforcement);
    }
    expect(GENERATION_PARAMETER_REGISTRY.map((item) => item.id)).toEqual(expect.arrayContaining([
      "comment_role_diversity", "comment_constraint_density", "comment_gap_multiplexing", "comment_reply_increment", "question_compression", "comment_inference_effort",
      "comment_platform_register", "comment_conversation_rate", "comment_branching_strength", "comment_organic_variation",
    ]));
    expect(DEFAULT_METHOD_PARAMETERS).toMatchObject({
      commentRoleDiversity: 85, commentConstraintDensity: 55, commentGapMultiplexing: 55, commentReplyIncrement: 58, questionCompression: 78,
      commentInferenceEffort: expect.any(Number), commentPlatformRegister: 68, commentConversationRate: 48,
      commentBranchingStrength: 62, commentOrganicVariation: 58,
    });
  });

  it("exposes the 64K standard output budget and 384K DeepSeek ceiling", () => {
    const definition = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === "max_output_tokens");
    expect(definition?.defaultValue).toBe(GENERATION_OUTPUT_TOKENS);
    expect(definition?.control).toMatchObject({ kind: "number", max: DEEPSEEK_MAX_OUTPUT_TOKENS });
  });

  it("compiles social-register and conversation-network controls into executable instructions", () => {
    // 多轮相关指令只有在生长开关打开时才是"可执行的":开关关闭时 multiTurnTarget
    // 恒为 [0,0],此处必须显式打开,否则 conversation_rate/branching_strength 会
    // 被判为空转并按设计不再下发指令(见下一条用例)。
    const growthOn = baseConfig();
    growthOn.content.commentMultiTurnGrowthEnabled = true;
    const compiled = compileGenerationParameters(growthOn, DEFAULT_FORMULA_VERSION, {
      overrides: {
        comment_platform_register: 85,
        comment_conversation_rate: 70,
        comment_branching_strength: 80,
        comment_organic_variation: 75,
      },
    });
    expect(compiled.config.parameters).toMatchObject({
      commentPlatformRegister: 85,
      commentConversationRate: 70,
      commentBranchingStrength: 80,
      commentOrganicVariation: 75,
    });
    const instructions = compiled.impactReport.behaviorInstructions.join("\n");
    expect(instructions).toContain("平台语域偏强");
    expect(instructions).toContain("约 70% 的根评论");
    expect(instructions).toContain("相邻缺口");
    expect(instructions).toContain("整齐销售漏斗");
  });

  describe("执行强度标注与实际消费路径一致", () => {
    const enforcementOf = (id: string) =>
      GENERATION_PARAMETER_REGISTRY.find((item) => item.id === id)?.enforcement;

    it("仅提示词引导的参数标为 guidance,不冒充硬约束", () => {
      // 这几个逐个实测确认 planning/engine/content 都不读值,只有一句提示词。
      for (const id of [
        "evidence_strictness", "boundary_visibility", "body_completeness",
        "state_information_strength", "redundancy_tolerance", "thread_style",
      ]) {
        expect(enforcementOf(id)).toBe("guidance");
      }
    });

    it("有校验层复核的参数标为 validated", () => {
      for (const id of ["body_min_chars", "comment_thread_max", "forbidden_phrases", "comment_gap_multiplexing"]) {
        expect(enforcementOf(id)).toBe("validated");
      }
    });

    it("只推导不校验的参数标为 derived", () => {
      for (const id of ["comment_role_diversity", "question_compression", "comment_expansion"]) {
        expect(enforcementOf(id)).toBe("derived");
      }
    });

    it("诊断强调滑杆标为 display", () => {
      expect(enforcementOf("comment_diagnostic_gapCoverage")).toBe("display");
      expect(enforcementOf("body_diagnostic_stateMatch")).toBe("display");
    });

    it("evidenceStatus 与 enforcement 是正交维度:高风险不等于强执行", () => {
      const strictness = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === "evidence_strictness")!;
      // 调低证据严格度确实高风险,所以 evidenceStatus 保持 normative_boundary;
      // 但系统对它只有提示词引导,两者必须能同时如实表达。
      expect(strictness.evidenceStatus).toBe("normative_boundary");
      expect(strictness.enforcement).toBe("guidance");
    });
  });

  describe("空转参数标注 inertReason", () => {
    const traceOf = (compiled: ReturnType<typeof compileGenerationParameters>, id: string) =>
      compiled.impactReport.parameterTraces.find((trace) => trace.parameterId === id)!;

    it("生长开关关闭时,接话比例被标为空转且不再下发指令", () => {
      const config = baseConfig();
      config.content.commentMultiTurnGrowthEnabled = false;
      const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION, {
        overrides: { comment_conversation_rate: 70 },
      });
      const trace = traceOf(compiled, "comment_conversation_rate");
      expect(trace.inertReason).toContain("开关关闭");
      expect(trace.behaviorInstructions).toEqual([]);
      // 空转的那句话也不能从整篇指令里泄漏出去。
      expect(compiled.impactReport.behaviorInstructions.join("\n")).not.toContain("约 70% 的根评论");
    });

    it("生长开关打开时,接话比例不再是空转且指令回归", () => {
      const config = baseConfig();
      config.content.commentMultiTurnGrowthEnabled = true;
      const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION, {
        overrides: { comment_conversation_rate: 70 },
      });
      const trace = traceOf(compiled, "comment_conversation_rate");
      expect(trace.inertReason).toBeUndefined();
      expect(trace.behaviorInstructions.join("\n")).toContain("约 70% 的根评论");
    });

    it("线程上下限相同时,展开力度被标为空转", () => {
      const config = baseConfig();
      config.content.commentThreadMin = 4;
      config.content.commentThreadMax = 4;
      const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION, {
        overrides: { comment_expansion: 90 },
      });
      expect(traceOf(compiled, "comment_expansion").inertReason).toContain("没有可调空间");
    });

    it("诊断强调滑杆恒为显示用途,不进模型也不进校验", () => {
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION);
      const trace = traceOf(compiled, "comment_diagnostic_gapCoverage");
      expect(trace.inertReason).toContain("显示顺序");
      expect(trace.behaviorInstructions).toEqual([]);
    });

    it("真正生效的参数不带 inertReason", () => {
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION);
      expect(traceOf(compiled, "question_compression").inertReason).toBeUndefined();
      expect(traceOf(compiled, "comment_role_diversity").inertReason).toBeUndefined();
      expect(traceOf(compiled, "comment_thread_max").inertReason).toBeUndefined();
    });
  });

  it("compiles comment inference effort as a real generation parameter", () => {
    const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, {
      overrides: { comment_inference_effort: 100 },
    });
    expect(compiled.config.parameters?.commentInferenceEffort).toBe(100);
    expect(compiled.resolutionSnapshot.sourceByParameter.comment_inference_effort).toEqual({ source: "override" });
  });

  it("registers the multi-turn growth switch and compiles it to the config path (P2-11)", () => {
    const definition = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === "comment_multi_turn_growth");
    expect(definition).toBeDefined();
    expect(definition).toMatchObject({
      path: "content.commentMultiTurnGrowthEnabled",
      group: "channel",
      defaultValue: false,
      evidenceStatus: "operational_default",
      control: { kind: "toggle" },
    });
    // Conservative default: an old config without the field compiles to off.
    const defaulted = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION);
    expect(defaulted.config.content.commentMultiTurnGrowthEnabled).toBe(false);
    expect(defaulted.resolutionSnapshot.sourceByParameter.comment_multi_turn_growth).toEqual({ source: "default" });
    expect(defaulted.impactReport.behaviorInstructions.join("\n")).toContain("根评论直接成稿");
    // Explicit opt-in flows through the override channel onto the config path.
    const enabled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, {
      overrides: { comment_multi_turn_growth: true },
    });
    expect(enabled.config.content.commentMultiTurnGrowthEnabled).toBe(true);
    expect(enabled.resolutionSnapshot.sourceByParameter.comment_multi_turn_growth).toEqual({ source: "override" });
    expect(enabled.impactReport.behaviorInstructions.join("\n")).toContain("无自然话头不续");
    // Toggle values must be boolean; nothing is silently coerced.
    expect(() => compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, {
      overrides: { comment_multi_turn_growth: 1 as unknown as boolean },
    })).toThrow(/must be boolean/u);
  });

  it("compiles the comment density formulas into actionable Chinese instructions", () => {
    const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, {
      overrides: { comment_gap_multiplexing: 80, comment_reply_increment: 90, question_compression: 85 },
    });
    const instructions = compiled.impactReport.behaviorInstructions.join("\n");
    expect(instructions).toContain("Gap=1×PrimaryGap＋Aux(0…2)");
    expect(instructions).toContain("单条回复只承担一个主要增量");
    expect(instructions).toContain("surfaceRoleCard已经暗示的维度");
  });

  it("keeps old ResolvedGenerationConfig objects compatible by compiling missing method defaults", () => {
    const legacy = baseConfig();
    delete legacy.parameters;
    const result = compileGenerationParameters(legacy, DEFAULT_FORMULA_VERSION);
    expect(result.config.parameters).toEqual(DEFAULT_METHOD_PARAMETERS);
    expect(result.resolutionSnapshot.sourceByParameter.information_breadth).toEqual({ source: "default" });
    expect(result.resolutionSnapshot.sourceByParameter.body_min_chars).toEqual({ source: "config" });
  });

  it("resolves config then preset then style then explicit override with provenance", () => {
    const result = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, {
      presetId: "minimal_body_conditional_comments",
      styleProfileId: "natural_concise",
      overrides: { body_max_chars: 160, question_naturalness: 88 },
    });
    expect(result.config.content).toMatchObject({ bodyMinChars: 20, bodyMaxChars: 160, commentThreadMin: 3, commentThreadMax: 5 });
    expect(result.config.parameters).toMatchObject({ titleTargetChars: 12, questionNaturalness: 88 });
    expect(result.resolutionSnapshot.sourceByParameter.body_min_chars).toEqual({ source: "preset", sourceId: "minimal_body_conditional_comments" });
    expect(result.resolutionSnapshot.sourceByParameter.title_target_chars).toEqual({ source: "style_profile", sourceId: "natural_concise" });
    expect(result.resolutionSnapshot.sourceByParameter.question_naturalness).toEqual({ source: "override" });
  });

  it("rejects unknown and out-of-range overrides rather than silently coercing them", () => {
    expect(() => compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { overrides: { does_not_exist: 1 } })).toThrow(/Unknown generation parameter/u);
    expect(() => compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { overrides: { evidence_strictness: 101 } })).toThrow(/exceeds/u);
  });

  it("exports built-in presets and style profiles without claiming style causes performance", () => {
    expect(BUILT_IN_GENERATION_PRESETS.map((item) => item.id)).toEqual(expect.arrayContaining(["balanced_information", "minimal_body_conditional_comments", "comparison_framework"]));
    expect(BUILT_IN_STYLE_PROFILES.map((item) => item.id)).toContain("reference_compact_70");
    const reference = BUILT_IN_STYLE_PROFILES.find((item) => item.id === "reference_compact_70")!;
    expect(reference.evidenceStatus).toBe("sample_observation");
    expect(reference.safetyBoundary).toContain("不得把样本分位数解释为质量阈值");
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      expect(() => compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: preset.id })).not.toThrow();
    }
    for (const style of BUILT_IN_STYLE_PROFILES) {
      expect(() => compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { styleProfileId: style.id })).not.toThrow();
    }
  });

  it("多轮生长开关必须带成本告知,且写明依赖前置条件", () => {
    const growth = GENERATION_PARAMETER_REGISTRY.find((item) => item.id === "comment_multi_turn_growth")!;
    expect(growth.costNotice).toBeDefined();
    expect(growth.costNotice!.headline).toContain("行数预算");
    expect(growth.costNotice!.extraModelCalls).toContain("2.2");
    // 依赖项必须点明另外两个会让它失效的前置条件,否则用户开了却没效果无从判断。
    const depends = growth.costNotice!.dependsOn!.join("");
    expect(depends).toContain("follow_up_depth");
    expect(depends).toContain("comment_conversation_rate");
  });

  it("十个预设都开启多轮生长,让 comment_conversation_rate 真正生效", () => {
    // 卡片文案承诺「评论区自然接住细节」「承担可查找的长尾分支」「评论展开条件
    // 分支」,而 comment_conversation_rate 的三处读取全在 commentMultiTurnGrowth
    // 门后。开关关闭时 multiTurnTarget 恒为 [0,0]、评论永远停在一问一答,文案
    // 就成了兑现不了的承诺。预设显式开启它,让实现与卡片一致。
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      expect(
        preset.parameterValues.comment_multi_turn_growth,
        `${preset.id} 必须显式开启多轮生长,否则它设的 comment_conversation_rate 是死值`,
      ).toBe(true);
      expect(Number(preset.parameterValues.comment_conversation_rate)).toBeGreaterThan(0);
      expect(Number(preset.parameterValues.follow_up_depth ?? 2)).toBeGreaterThan(0);
    }
  });

  it("开启生长后接话比例不再被标为空转", () => {
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: preset.id });
      const trace = compiled.impactReport.parameterTraces.find((item) => item.parameterId === "comment_conversation_rate")!;
      expect(trace.inertReason, `${preset.id} 的接话比例仍被判空转`).toBeUndefined();
      expect(trace.behaviorInstructions.join("")).toContain("根评论长出自然接话");
    }
  });

  it("每个可见预设都显式声明送达阶段与入口,不靠 registry 默认兜底", () => {
    // 预设是"这张卡面向谁"的声明。漏设 audience_stage/entry_route 会让该卡静默
    // 落到 registry 默认(collecting/search)、与别的卡撞车,且 resolutionSnapshot
    // 里 source 记为 config 而不是 preset——用户看不出这张卡到底定位在哪一步。
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      expect(preset.parameterValues.audience_stage, `${preset.id} 缺 audience_stage`).toBeDefined();
      expect(preset.parameterValues.entry_route, `${preset.id} 缺 entry_route`).toBeDefined();
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: preset.id });
      expect(compiled.resolutionSnapshot.sourceByParameter.audience_stage).toMatchObject({ source: "preset", sourceId: preset.id });
      expect(compiled.resolutionSnapshot.sourceByParameter.entry_route).toMatchObject({ source: "preset", sourceId: preset.id });
    }
  });

  it("gives all ten visible preset cards distinct resolved semantics matching their descriptions", () => {
    expect(BUILT_IN_GENERATION_PRESETS.map((item) => item.id)).toEqual(Object.keys(presetSemanticExpectations));
    const effectiveConfigs = new Set<string>();
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      const expected = presetSemanticExpectations[preset.id as keyof typeof presetSemanticExpectations];
      expect(expected, `missing semantic assertion for ${preset.id}`).toBeDefined();
      expect(preset.label).toBe(expected.label);
      expect(preset.description).toBe(expected.description);
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: preset.id });
      expect(compiled.resolutionSnapshot.values).toMatchObject(expected.values);
      for (const parameterId of Object.keys(expected.values)) {
        expect(compiled.resolutionSnapshot.sourceByParameter[parameterId]).toEqual({ source: "preset", sourceId: preset.id });
      }
      expect(compiled.impactReport.behaviorInstructions.join("\n")).toContain(expected.directive);
      effectiveConfigs.add(JSON.stringify(compiled.resolutionSnapshot.values));
    }
    expect(effectiveConfigs.size).toBe(BUILT_IN_GENERATION_PRESETS.length);
  });
});

describe("parameter compilation semantics", () => {
  it("evaluates formulas when inputs exist and preserves unknown when they do not", () => {
    const config = baseConfig();
    config.formula.enabledFormulaIds = ["F17", "F21"];
    config.formula.variables = {
      pExposure: 0.5,
      pNoticeGivenExposure: 0.4,
      pEnterGivenNotice: 0.3,
      pConsumeGivenEnter: 0.2,
    };
    const result = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
    expect(result.impactReport.formulaResults.find((item) => item.formulaId === "F21")?.value).toBeCloseTo(0.012);
    const missing = result.impactReport.formulaResults.find((item) => item.formulaId === "F17")!;
    expect(missing.value).toBeNull();
    expect(missing.interpretation).toContain("不得用0.5");
  });

  it("returns unknown with validation details for incomparable F17 units and out-of-range F21 probabilities", () => {
    const config = baseConfig();
    config.formula.enabledFormulaIds = ["F17", "F21"];
    config.formula.variables = {
      regretBefore: 10,
      regretAfter: 4,
      cognitiveCost: 2,
      regretBeforeUnit: "yuan",
      regretAfterUnit: "yuan",
      cognitiveCostUnit: "minutes",
      pExposure: 0.5,
      pNoticeGivenExposure: 1.2,
      pEnterGivenNotice: 0.3,
      pConsumeGivenEnter: 0.2,
    };
    const result = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
    const f17 = result.impactReport.formulaResults.find((item) => item.formulaId === "F17")!;
    const f21 = result.impactReport.formulaResults.find((item) => item.formulaId === "F21")!;
    expect(f17.value).toBeNull();
    expect(f17.warnings.join(" ")).toContain("one comparable unit");
    expect(f17.interpretation).toContain("未通过校验");
    expect(f21.value).toBeNull();
    expect(f21.warnings.join(" ")).toContain("[0, 1]");
    expect(f21.interpretation).toContain("手工情景计算");
  });

  it("keeps F30 as a display-only calculator result with no generation-parameter ownership", () => {
    const config = baseConfig();
    config.formula.enabledFormulaIds = ["F30"];
    config.formula.variables = {
      trendSourceKind: "xiaohongshu_hotspot_rank",
      trendSourceRef: "title:F30_PROMPT_ISOLATION_MARKER 具体榜单条目",
      sourceObservedAt: "2026-07-14T08:00:00+08:00",
      relevance: 0.8,
      bridgeClarity: 0.75,
      timeliness: 0.5,
    };
    const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
    const f30 = compiled.impactReport.formulaResults.find((item) => item.formulaId === "F30")!;
    expect(f30.value).toBeCloseTo(0.3);
    expect(f30.interpretation).toContain("不输出 qualifiedIncrementalReach");
    expect(f30.interpretation).toContain("标签和热点词不能保证触达");
    expect(f30.calculatorContract).toMatchObject({
      outputMetric: "TrendFit",
      consumedBy: { generation: false, planning: false, selection: false, validation: false },
      excludedResearchOutputs: [expect.objectContaining({ status: "not_executed", outputProduced: false })],
    });
    expect(GENERATION_PARAMETER_REGISTRY.filter((definition) => definition.formulaIds.includes("F30"))).toEqual([]);
    expect(compiled.impactReport.behaviorInstructions).toEqual([]);

    const knowledge = selectKnowledgeContext({
      documents: [],
      query: "F30 calculator isolation",
      budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    const prompt = buildGenerationPrompt({
      config: compiled.config,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      ledger: buildKnowledgeLedger([]),
      candidateIndex: 0,
      seed: 1,
      variation: { opening: "question", pacing: "short", structure: "compare", phrasing: "restrained" },
      impactReport: compiled.impactReport,
    });
    const text = prompt.messages.map((item) => item.content).join("\n");
    expect(text).not.toContain("F30_PROMPT_ISOLATION_MARKER");
    expect(text).not.toContain("TrendFit");
    const taskData = sharedTaskData(text);
    expect(taskData).not.toHaveProperty("compiledParameters");
  });

  it("applies F30 source and observation validators to advanced formula variable JSON", () => {
    const invalidCases = [
      { trendSourceRef: "#眼袋", sourceObservedAt: "2026-07-14T08:00:00+08:00", warningCode: "[source_ref_hashtag_only]" },
      { trendSourceRef: "title:具体榜单条目", sourceObservedAt: "2026-02-30T00:00:00+08:00", warningCode: "[observed_at_invalid_value]" },
    ];
    for (const invalidCase of invalidCases) {
      const config = baseConfig();
      config.formula.enabledFormulaIds = ["F30"];
      config.formula.variables = {
        trendSourceKind: "xiaohongshu_hotspot_rank",
        trendSourceRef: invalidCase.trendSourceRef,
        sourceObservedAt: invalidCase.sourceObservedAt,
        relevance: 0.8,
        bridgeClarity: 0.75,
        timeliness: 0.5,
      };
      const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
      const f30 = compiled.impactReport.formulaResults.find((item) => item.formulaId === "F30")!;
      expect(f30.value, invalidCase.warningCode).toBeNull();
      expect(f30.warnings.join(" "), invalidCase.warningCode).toContain(invalidCase.warningCode);
    }
  });

  it("does not execute formula calculators when the enabled set is explicitly empty", () => {
    const config = baseConfig();
    config.formula.enabledFormulaIds = [];
    config.formula.variables = {
      pExposure: 0.5,
      pNoticeGivenExposure: 0.4,
      pEnterGivenNotice: 0.3,
      pConsumeGivenEnter: 0.2,
    };
    const result = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
    expect(result.impactReport.formulaResults).toEqual([]);
    expect(result.impactReport.behaviorInstructions).toEqual([]);
    expect(result.impactReport.parameterTraces.every((trace) => trace.behaviorInstructions.length === 0)).toBe(true);
    expect(result.impactReport.diagnosticProxies).toEqual([]);

    const knowledge = selectKnowledgeContext({
      documents: [],
      query: "empty-formula-contract",
      budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    const prompt = buildGenerationPrompt({
      config: result.config,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      ledger: buildKnowledgeLedger([]),
      candidateIndex: 0,
      seed: 1,
      variation: { opening: "question", pacing: "short", structure: "compare", phrasing: "restrained" },
      impactReport: result.impactReport,
    });
    const text = prompt.messages.map((item) => item.content).join("\n");
    const taskData = sharedTaskData(text);
    expect(taskData).not.toHaveProperty("compiledParameters");
    expect(taskData.contentConstraints).toMatchObject({
      bodyMinChars: result.config.content.bodyMinChars,
      bodyMaxChars: result.config.content.bodyMaxChars,
    });
    expect(text).toContain("没有已启用且经审核的参数公式行为指令");
  });

  it("allocates critical shared information to body and conditional residual gaps to comments", () => {
    const config = baseConfig();
    config.task.mustMention = ["必须公开说明"];
    const report = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION, { overrides: { body_completeness: 40 } }).impactReport;
    expect(report.advisoryAllocationPreview["N.body"].information).toEqual(expect.arrayContaining([
      expect.objectContaining({ information: "必须公开说明", critical: true }),
      expect.objectContaining({ information: "个体结论需要结合实际条件核实", critical: true }),
    ]));
    expect(report.advisoryAllocationPreview.Cref.information.length).toBeGreaterThan(0);
    expect(report.advisoryAllocationPreview.Cref.constraints.join(" ")).toContain("Stage/Gap/Function/Q/A/Follow-up/Next/Role/Source");
    expect(report.advisoryAllocationPreview["N.body"].constraints.join(" ")).toContain("Specific∧DecisionRelevant∧Answerable∧Findable");
  });

  it("moves all gaps into the required package channels when optional channels are disabled", () => {
    const config = baseConfig();
    config.expressionWindow.channels = ["title", "body"];
    const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION);
    expect(compiled.config.content).toMatchObject({ hashtagMin: 0, hashtagMax: 0, commentThreadMin: 0, commentThreadMax: 0, imageBriefEnabled: false });
    expect(compiled.impactReport.advisoryAllocationPreview["N.body"].information.map((item) => item.information).join(" ")).toContain("怎么预约");
    expect(compiled.impactReport.advisoryAllocationPreview.Cref.information).toEqual([]);
  });

  it("reports F32/F33 as ordered unknown components without a score or missing-to-zero coercion", () => {
    const config = baseConfig();
    config.parameters!.bodyDiagnosticEmphasis.adSuspicion = 90;
    config.parameters!.bodyDiagnosticEmphasis.logicError = 90;
    config.parameters!.bodyDiagnosticEmphasis.stateMatch = 20;
    const report = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION).impactReport;
    expect(report.diagnosticProxies).toHaveLength(2);
    for (const diagnostic of report.diagnosticProxies) {
      expect(diagnostic).toMatchObject({
        formulaSemanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        semantics: "ordered_component_review_metadata",
        status: "unknown",
        evaluationStatus: "not_evaluated",
        aggregateValue: null,
        scoreProduced: false,
        evidenceStatus: "unvalidated_proxy",
        aggregation: "components_only",
        diagnosticContract: {
          mode: "display_priority_metadata",
          missingDataPolicy: "unknown_not_zero",
          emphasis: { semantics: "display_and_manual_review_priority_only" },
          consumedBy: { generation: false, planning: false, selection: false, validation: false },
        },
      });
      expect(diagnostic.components).toHaveLength(10);
      expect(diagnostic.warning).toContain("禁止合成总分");
      expect(diagnostic).not.toHaveProperty("score");
      expect(diagnostic.components.every((component) => component.status === "unknown"
        && component.evaluationStatus === "not_evaluated"
        && component.value === null
        && component.source.kind === "not_observed"
        && component.source.reference === null
        && component.evidenceStatus === "unvalidated_proxy"
        && component.boundary.length > 0)).toBe(true);
      expect(diagnostic.components.map((component) => component.displayOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
    const body = report.diagnosticProxies.find((diagnostic) => diagnostic.formulaId === "F32")!;
    expect(body.components.slice(0, 2).map((component) => component.id)).toEqual(["adSuspicion", "logicError"]);
    expect(body.components.slice(0, 2).map((component) => component.manualReviewRank)).toEqual([1, 1]);
    expect(body.components.at(-1)).toMatchObject({ id: "stateMatch", emphasis: 20, manualReviewRank: 10 });
    expect(report.parameterTraces.filter((trace) => /_diagnostic_/u.test(trace.parameterId))
      .every((trace) => trace.behaviorInstructions.length === 0)).toBe(true);
  });

  it("contains only aggregate 70-item statistics with explicit descriptive caveats", () => {
    const baseline = CONFIRMED_REFERENCE_SAMPLE_BASELINE;
    expect(baseline.metrics.find((item) => item.id === "title_chars")?.statistics).toMatchObject({ min: 1, p25: 5, median: 8.5, p75: 13, max: 22 });
    expect(baseline.metrics.find((item) => item.id === "body_chars_without_hashtags")?.statistics).toMatchObject({ min: 0, p25: 36, median: 77, p75: 143, max: 267 });
    expect(baseline.metrics.find((item) => item.id === "comment_line_chars")?.statistics).toMatchObject({ min: 1, p25: 6, median: 10, p75: 15, max: 95 });
    expect(baseline.caveats.join(" ")).toContain("不是高质量阈值");
    expect(JSON.stringify(baseline)).not.toContain("原文内容");
  });

  it("injects the compact executable contract without duplicating UI-only diagnostics", () => {
    const config = baseConfig();
    const compiled = compileGenerationParameters(config, DEFAULT_FORMULA_VERSION, { presetId: "comparison_framework" });
    const document = indexKnowledgeSource({ projectId: project.id, id: "d1", path: "facts.md", content: "# 事实\n只使用这一条事实。" });
    const knowledge = selectKnowledgeContext({ documents: [document], query: "方案", budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 } });
    const prompt = buildGenerationPrompt({
      config: compiled.config,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      ledger: buildKnowledgeLedger([]),
      candidateIndex: 0,
      seed: 1,
      variation: { opening: "问题", pacing: "短句", structure: "比较", phrasing: "克制" },
      impactReport: compiled.impactReport,
    });
    const text = prompt.messages.map((item) => item.content).join("\n");
    expect(text).toContain("compiledParameters");
    expect(text).toContain("把比较清单隐藏在一个真实纠结里");
    expect(text).toContain('"content":{"H":{"hashtags":[]}');
    expect(text).not.toContain("components_only");
    expect(text).not.toContain("reference_copy_70_descriptive_v1");
    const taskData = sharedTaskData(text);
    expect(taskData.compiledParameters).not.toHaveProperty("channelAllocation");
  });

  it("uses the orchestration allocation as the only repair-prompt allocation", () => {
    const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: "comparison_framework" });
    compiled.impactReport.advisoryAllocationPreview["N.body"].information = [{
      information: "legacy-impact-allocation",
      reason: "legacy advisory only",
      critical: false,
      formulaIds: ["F04"],
    }];
    const knowledge = selectKnowledgeContext({ documents: [], query: "repair", budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 } });
    const prompt = buildRepairPrompt({
      current: { content: { H: { hashtags: [] }, N: { imageBrief: "", title: "", body: "" }, Cref: { disclaimer: "", threads: [] } }, evidenceIds: [], reasoning: [], unknowns: [] },
      issues: [{ code: "test", severity: "warning", channel: "N.body", message: "repair", repairable: true }],
      channels: ["N.body"],
      config: compiled.config,
      knowledge,
      seed: 1,
      attempt: 1,
      impactReport: compiled.impactReport,
      imageAnalyses: [],
      evidenceReferences: [{
        id: "evidence_section_authoritative",
        documentId: "d1",
        path: "facts.md",
        section: "事实",
        quote: "仅这一段可引用",
        kind: "fact",
        evidenceStatus: "observed",
        scope: ["repair"],
        caveats: [],
      }],
      orchestrationPlan: {
        channelAllocation: { "N.body": ["authoritative-orchestration-gap"] },
      } as any,
    });
    const text = prompt.messages.map((item) => item.content).join("\n");
    expect(text).toContain("authoritative-orchestration-gap");
    expect(text).not.toContain("legacy-impact-allocation");
    expect(text).toContain("evidence_section_authoritative");
    expect(text).toContain("仅这一段可引用");
    expect(text).toContain("只能使用上面 usableEvidenceIds 中的 ID");
  });

  it("injects every visible preset's dedicated behavior instructions into the generation prompt", () => {
    const document = indexKnowledgeSource({ projectId: project.id, id: "preset-prompts", path: "facts.md", content: "# 事实\n只使用这一条事实。" });
    const knowledge = selectKnowledgeContext({ documents: [document], query: "方案", budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 } });
    for (const preset of BUILT_IN_GENERATION_PRESETS) {
      const compiled = compileGenerationParameters(baseConfig(), DEFAULT_FORMULA_VERSION, { presetId: preset.id });
      const prompt = buildGenerationPrompt({
        config: compiled.config,
        formulaVersion: DEFAULT_FORMULA_VERSION,
        knowledge,
        ledger: buildKnowledgeLedger([]),
        candidateIndex: 0,
        seed: 1,
        variation: { opening: "问题", pacing: "短句", structure: "比较", phrasing: "克制" },
        impactReport: compiled.impactReport,
      });
      const text = prompt.messages.map((item) => item.content).join("\n");
      for (const instruction of preset.behaviorInstructions) expect(text).toContain(instruction);
    }
  });
});

describe("engine parameter trace", () => {
  it("does not consume F30 TrendFit in generation, planning or topic selection", async () => {
    const makeConfig = (score: number) => {
      const config = baseConfig();
      config.formula.enabledFormulaIds = ["F30"];
      config.formula.variables = {
        trendSourceKind: "other_explicit_source",
        trendSourceRef: "title:同一个明确外部话题",
        sourceObservedAt: "2026-07-14T08:00:00+08:00",
        relevance: score,
        bridgeClarity: score,
        timeliness: score,
      };
      return config;
    };
    const knowledge = [indexKnowledgeSource({ projectId: project.id, id: "f30-isolation", path: "facts.md", content: "# 事实\n项目资料只确认当前要点。" })];
    const agent = new ContentGenerationAgent({ now: () => new Date("2026-07-14T00:00:00Z") });
    const low = await agent.generate({ jobId: "f30-isolation-job", config: makeConfig(0.2), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const high = await agent.generate({ jobId: "f30-isolation-job", config: makeConfig(0.9), formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    expect(low.impactReport?.formulaResults.find((item) => item.formulaId === "F30")?.value).toBeCloseTo(0.008);
    expect(high.impactReport?.formulaResults.find((item) => item.formulaId === "F30")?.value).toBeCloseTo(0.729);
    expect(high.packages.map((item) => item.content)).toEqual(low.packages.map((item) => item.content));
    expect(high.packages.map((item) => item.orchestrationSnapshot)).toEqual(low.packages.map((item) => item.orchestrationSnapshot));
    expect(high.packages.map((item) => item.coverageSignature)).toEqual(low.packages.map((item) => item.coverageSignature));
  });

  it("lets F32/F33 emphasis change only display/manual-review ordering metadata", async () => {
    const makeConfig = (emphasis: number) => {
      const config = baseConfig();
      for (const id of Object.keys(config.parameters!.bodyDiagnosticEmphasis)) config.parameters!.bodyDiagnosticEmphasis[id as keyof typeof config.parameters.bodyDiagnosticEmphasis] = emphasis;
      for (const id of Object.keys(config.parameters!.commentDiagnosticEmphasis)) config.parameters!.commentDiagnosticEmphasis[id as keyof typeof config.parameters.commentDiagnosticEmphasis] = emphasis;
      return config;
    };
    const lowCompilation = compileGenerationParameters(makeConfig(0), DEFAULT_FORMULA_VERSION);
    const highCompilation = compileGenerationParameters(makeConfig(100), DEFAULT_FORMULA_VERSION);
    expect(highCompilation.impactReport.behaviorInstructions).toEqual(lowCompilation.impactReport.behaviorInstructions);
    expect(highCompilation.impactReport.advisoryAllocationPreview).toEqual(lowCompilation.impactReport.advisoryAllocationPreview);
    expect(highCompilation.impactReport.formulaResults).toEqual(lowCompilation.impactReport.formulaResults);

    const document = indexKnowledgeSource({ projectId: project.id, id: "diagnostic-isolation", path: "facts.md", content: "# 事实\n项目资料只确认当前要点。" });
    const selected = selectKnowledgeContext({ documents: [document], query: "方案", budget: { maxInputTokens: 5000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 } });
    const promptInput = {
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge: selected,
      ledger: buildKnowledgeLedger([]),
      candidateIndex: 0 as const,
      seed: 77,
      variation: { opening: "问题", pacing: "短句", structure: "比较", phrasing: "克制" },
    };
    const lowPrompt = buildGenerationPrompt({ ...promptInput, config: lowCompilation.config, impactReport: lowCompilation.impactReport });
    const highPrompt = buildGenerationPrompt({ ...promptInput, config: highCompilation.config, impactReport: highCompilation.impactReport });
    expect(highPrompt.messages).toEqual(lowPrompt.messages);
    for (const prompt of [lowPrompt, highPrompt]) {
      const serialized = JSON.stringify(prompt.messages);
      expect(serialized).not.toContain("body_diagnostic_");
      expect(serialized).not.toContain("comment_diagnostic_");
      expect(serialized).not.toContain("F32");
      expect(serialized).not.toContain("F33");
      expect(serialized).not.toContain("诊断强调");
    }

    const repairBase = {
      current: { content: { H: { hashtags: [] }, N: { imageBrief: "", title: "", body: "" }, Cref: { disclaimer: "", threads: [] } }, evidenceIds: [], reasoning: [], unknowns: [] },
      issues: [{ code: "same_issue", severity: "error" as const, channel: "N.body" as const, message: "same", repairable: true }],
      channels: ["N.body" as const],
      knowledge: selected,
      seed: 77,
      attempt: 1,
    };
    const lowRepair = buildRepairPrompt({ ...repairBase, config: lowCompilation.config, impactReport: lowCompilation.impactReport });
    const highRepair = buildRepairPrompt({ ...repairBase, config: highCompilation.config, impactReport: highCompilation.impactReport });
    expect(highRepair.messages).toEqual(lowRepair.messages);
    for (const prompt of [lowRepair, highRepair]) {
      const serialized = JSON.stringify(prompt.messages);
      expect(serialized).not.toContain("body_diagnostic_");
      expect(serialized).not.toContain("comment_diagnostic_");
      expect(serialized).not.toContain("F32");
      expect(serialized).not.toContain("F33");
      expect(serialized).not.toContain("诊断强调");
    }

    const disabledConfig = makeConfig(50);
    disabledConfig.formula.enabledFormulaIds = disabledConfig.formula.enabledFormulaIds
      .filter((formulaId) => formulaId !== "F32" && formulaId !== "F33");
    const disabledCompilation = compileGenerationParameters(disabledConfig, DEFAULT_FORMULA_VERSION);
    const disabledRepair = buildRepairPrompt({
      ...repairBase,
      config: disabledCompilation.config,
      impactReport: disabledCompilation.impactReport,
    });
    const disabledRepairText = JSON.stringify(disabledRepair.messages);
    expect(disabledRepairText).not.toMatch(/(?:body|comment)_diagnostic_/u);
    expect(disabledRepairText).not.toMatch(/F32|F33|诊断强调/u);

    const knowledge = [document];
    const agent = new ContentGenerationAgent({ now: () => new Date("2026-07-14T00:00:00Z") });
    const low = await agent.generate({ jobId: "diagnostic-isolation-job", config: lowCompilation.config, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    const high = await agent.generate({ jobId: "diagnostic-isolation-job", config: highCompilation.config, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge });
    expect(high.packages.map((item) => item.content)).toEqual(low.packages.map((item) => item.content));
    expect(high.packages.map((item) => item.orchestrationSnapshot)).toEqual(low.packages.map((item) => item.orchestrationSnapshot));
    expect(high.packages.map((item) => item.validation)).toEqual(low.packages.map((item) => item.validation));
    expect(high.packages.map((item) => item.diagnostics.filter((diagnostic) => !diagnostic.formulaId)))
      .toEqual(low.packages.map((item) => item.diagnostics.filter((diagnostic) => !diagnostic.formulaId)));
    for (const item of [...low.packages, ...high.packages]) {
      for (const diagnostic of item.diagnostics.filter((entry) => entry.formulaId === "F32" || entry.formulaId === "F33")) {
        expect(diagnostic).not.toHaveProperty("score");
        expect(diagnostic).toMatchObject({
          status: "unknown",
          semantics: "ordered_component_review_metadata",
          evaluationStatus: "not_evaluated",
          aggregateValue: null,
          scoreProduced: false,
          evidenceStatus: "unvalidated_proxy",
          aggregation: "components_only",
        });
        expect(diagnostic.components?.every((component) => component.value === null && component.status === "unknown")).toBe(true);
      }
    }
  });

  it("keeps style-analysis corpora out of writer context even when explicitly selected", async () => {
    const config = baseConfig();
    const facts = indexKnowledgeSource({ projectId: project.id, id: "facts", path: "facts.md", content: "# 事实\n可用于生成。" });
    const corpus = indexKnowledgeSource({
      projectId: project.id,
      id: "corpus",
      path: "70篇对标内容.md",
      content: "# 样本原文\n只用于离线风格分析。",
      metadata: { kind: "case", scope: ["style-analysis-only"] },
    });
    const agent = new ContentGenerationAgent();
    const automatic = await agent.generate({ jobId: "style-filter-auto", config, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [facts, corpus] });
    expect(automatic.knowledgeContext.selectedDocumentIds).toContain("facts");
    expect(automatic.knowledgeContext.selectedDocumentIds).not.toContain("corpus");

    const explicitConfig = baseConfig();
    explicitConfig.knowledge.selectedFileIds = ["corpus"];
    const explicit = await agent.generate({ jobId: "style-filter-explicit", config: explicitConfig, formulaVersion: DEFAULT_FORMULA_VERSION, knowledge: [facts, corpus] });
    expect(explicit.knowledgeContext.selectedDocumentIds).toEqual([]);
  });

  it("uses the compact preset in deterministic fallback and persists explainable impact", async () => {
    const config = baseConfig();
    const knowledge = [indexKnowledgeSource({ projectId: project.id, id: "d1", path: "facts.md", content: "# 事实\n项目资料只确认当前要点，其他情况需要核实。" })];
    const result = await new ContentGenerationAgent({ now: () => new Date("2026-07-13T00:00:00Z") }).generate({
      jobId: "compact-job",
      config,
      formulaVersion: DEFAULT_FORMULA_VERSION,
      knowledge,
      parameterSelection: { presetId: "minimal_body_conditional_comments", styleProfileId: "natural_concise" },
    });
    expect(result.resolutionSnapshot?.presetId).toBe("minimal_body_conditional_comments");
    expect(result.impactReport?.warnings.join(" ")).toContain("70篇统计只描述样本形态");
    for (const item of result.packages) {
      const bodyLength = [...item.content.N.body].length;
      expect(bodyLength).toBeGreaterThanOrEqual(20);
      expect(bodyLength).toBeLessThanOrEqual(70);
      expect(item.configSnapshot.content).toMatchObject({ bodyMinChars: 20, bodyMaxChars: 70 });
      expect(item.resolutionSnapshot?.styleProfileId).toBe("natural_concise");
      expect(item.impactReport?.behaviorInstructions.join(" ")).toContain("人物关系网逐层补全");
      expect(item.content.Cref.threads
        .filter((thread) => (thread.threadKind ?? "org_answer") === "org_answer")
        .every((thread) => Boolean(thread.stage && thread.gap && thread.function && thread.nextStep))).toBe(true);
      expect(item.content.Cref.threads
        .filter((thread) => (thread.threadKind ?? "org_answer") !== "org_answer")
        .every((thread) => !thread.gap && !thread.nextStep && !thread.primaryGapId && !thread.replyPlan)).toBe(true);
      const proxyDiagnostics = item.diagnostics.filter((diagnostic) => diagnostic.aggregation === "components_only");
      expect(proxyDiagnostics).toHaveLength(2);
      expect(proxyDiagnostics.every((diagnostic) => diagnostic.score === undefined)).toBe(true);
    }
  });
});
