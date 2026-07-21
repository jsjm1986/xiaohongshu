import { describe, expect, it } from "vitest";

import {
  createFormulaVersion,
  DEFAULT_FORMULAS,
  DEFAULT_FORMULA_VERSION,
  deriveCandidateSeed,
  directGenerationFormulas,
  evaluateFormula,
  evaluateFormulaDefinition,
  F30_CALCULATOR_CONTRACT,
  F30_MIGRATION_DESCRIPTOR,
  F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS,
  F30_TREND_SOURCE_TYPES,
  F32_DIAGNOSTIC_CONTRACT,
  F32_F33_MIGRATION_DESCRIPTOR,
  F33_DIAGNOSTIC_CONTRACT,
  FORMULA_EXECUTION_HANDLER_REGISTRY,
  FORMULA_EXECUTION_OWNERSHIP,
  FORMULA_EXECUTION_POLICY_DIGEST,
  FORMULA_EXECUTION_POLICY_VERSION,
  FORMULA_EXECUTION_STAGES,
  FORMULA_EXPRESSION_JSON_SCHEMA,
  FORMULA_HANDLER_KINDS,
  formulaEquationFingerprint,
  formulaExecutionAudit,
  formulaVersionDigest,
  HARD_SAFETY_INVARIANTS,
  isLegacyOfficialF30,
  isLegacyOfficialF32OrF33,
  LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
  LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT,
  LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT,
  PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
  renderFormulaInstructions,
  resolveFormulaExecution,
  validateFormulaDsl,
  validateFormulaVersion,
} from "../src/index.js";

describe("safe formula JSON DSL", () => {
  it("evaluates numeric expressions without eval", () => {
    const expression = {
      op: "clamp" as const,
      value: { op: "subtract" as const, args: [{ op: "var" as const, path: "before" }, { op: "var" as const, path: "after" }] },
      min: { op: "literal" as const, value: 0 },
      max: { op: "literal" as const, value: 1 },
    };
    expect(evaluateFormula(expression, { before: 0.9, after: 0.2 })).toEqual({ value: 0.7, unknownPaths: [], warnings: [] });
  });

  it("propagates missing values as null instead of inventing 0.5", () => {
    const result = evaluateFormula({ op: "multiply", args: [{ op: "var", path: "known" }, { op: "var", path: "missing" }] }, { known: 0.8 });
    expect(result.value).toBeNull();
    expect(result.unknownPaths).toEqual(["missing"]);
  });

  it("uses explicit coalesce only when the formula author supplies a fallback", () => {
    const result = evaluateFormula({ op: "coalesce", args: [{ op: "var", path: "missing" }, { op: "literal", value: 0 }] }, {});
    expect(result.value).toBe(0);
    expect(result.unknownPaths).toEqual(["missing"]);
  });

  it("implements three-valued boolean logic and safe division", () => {
    expect(evaluateFormula({ op: "and", args: [{ op: "var", path: "missing" }, { op: "literal", value: false }] }, {}).value).toBe(false);
    const division = evaluateFormula({ op: "divide", args: [{ op: "literal", value: 1 }, { op: "literal", value: 0 }] }, {});
    expect(division.value).toBeNull();
    expect(division.warnings[0]).toMatch(/zero/u);
  });

  it("rejects arbitrary operators, prototype paths, excessive depth and non-JSON literals", () => {
    expect(validateFormulaDsl({ op: "eval", code: "process.exit()" })[0]?.code).toBe("unknown_operator");
    expect(validateFormulaDsl({ op: "var", path: "x.__proto__.secret" })[0]?.code).toBe("unsafe_variable_path");
    expect(validateFormulaDsl({ op: "literal", value: { unsafe: true } })[0]?.code).toBe("invalid_literal");
    const deep: any = { op: "literal", value: 1 };
    let current = deep;
    for (let index = 0; index < 5; index += 1) current = { op: "negate", arg: current };
    expect(validateFormulaDsl(current, { maxDepth: 2 }).some((item) => item.code === "depth_limit")).toBe(true);
  });

  it("exports a recursive JSON Schema for the advanced formula editor", () => {
    expect(FORMULA_EXPRESSION_JSON_SCHEMA).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/expression",
    });
    expect((FORMULA_EXPRESSION_JSON_SCHEMA.$defs as any).expression.oneOf).toHaveLength(6);
  });

  it("requires one explicit comparable unit before F17 can produce a scenario value", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F17")!;
    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F17?.semanticFingerprint).toBe("1d727fd246d7852bf158e7223ef4eaccdde4b4c0769e5fcd7fe78076166235e5");
    const valid = evaluateFormulaDefinition(formula, {
      regretBefore: 8,
      regretAfter: 3,
      cognitiveCost: 2,
      regretBeforeUnit: "decision-loss-point",
      regretAfterUnit: "decision-loss-point",
      cognitiveCostUnit: "decision-loss-point",
    });
    expect(valid).toEqual({ value: 3, unknownPaths: [], warnings: [] });

    const mismatched = evaluateFormulaDefinition(formula, {
      regretBefore: 8,
      regretAfter: 3,
      cognitiveCost: 2,
      regretBeforeUnit: "yuan",
      regretAfterUnit: "yuan",
      cognitiveCostUnit: "minutes",
    });
    expect(mismatched.value).toBeNull();
    expect(mismatched.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Validation error: F17.*one comparable unit/u)]));

    const missing = evaluateFormulaDefinition(formula, {
      regretBefore: 8,
      regretAfter: 3,
      cognitiveCost: 2,
      regretBeforeUnit: "decision-loss-point",
      regretAfterUnit: "decision-loss-point",
    });
    expect(missing.value).toBeNull();
    expect(missing.unknownPaths).toContain("cognitiveCostUnit");
  });

  it("uses explicit conditional-probability names and rejects F21 values outside [0,1]", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F21")!;
    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F21?.semanticFingerprint).toBe("4aae8ac2005bf3d9632e593697c6ee0478ec8a1321eb5b245e5ceaa7f70962fb");
    expect(formula.variables.map((variable) => variable.path)).toEqual([
      "pExposure",
      "pNoticeGivenExposure",
      "pEnterGivenNotice",
      "pConsumeGivenEnter",
    ]);
    const validContext = {
      pExposure: 0.5,
      pNoticeGivenExposure: 0.4,
      pEnterGivenNotice: 0.3,
      pConsumeGivenEnter: 0.2,
    };
    expect(evaluateFormulaDefinition(formula, validContext).value).toBeCloseTo(0.012);

    const outOfRange = { ...validContext, pNoticeGivenExposure: 1.01 };
    expect(evaluateFormula(formula.expression!, outOfRange).value).toBeNull();
    const rejected = evaluateFormulaDefinition(formula, outOfRange);
    expect(rejected.value).toBeNull();
    expect(rejected.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Validation error: F21 pNoticeGivenExposure.*\[0, 1\]/u)]));

    const { pConsumeGivenEnter: _missing, ...missingContext } = validContext;
    const missing = evaluateFormulaDefinition(formula, missingContext);
    expect(missing.value).toBeNull();
    expect(missing.unknownPaths).toContain("pConsumeGivenEnter");

    const changedConstraint = structuredClone(formula);
    changedConstraint.variables[0]!.maximum = 2;
    expect(resolveFormulaExecution(changedConstraint, ["F21"])).toMatchObject({
      compatibilityStatus: "pending_review",
      handlerState: "pending_review",
      effectiveHandlers: { calculator: [] },
    });
  });

  it("calculates F30 only as a bounded, source-explicit TrendFit manual scenario", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F30")!;
    expect(formula.title).toBe("热点匹配手工情景");
    expect(formula.variables.map((variable) => variable.path)).toEqual([
      "trendSourceKind",
      "trendSourceRef",
      "sourceObservedAt",
      "relevance",
      "bridgeClarity",
      "timeliness",
    ]);
    expect(formula.variables.find((variable) => variable.path === "trendSourceKind")?.allowedValues).toEqual(F30_TREND_SOURCE_TYPES);
    expect(formula.variables.find((variable) => variable.path === "trendSourceRef")?.format).toBe("trend_source_ref");
    expect(formula.variables.find((variable) => variable.path === "sourceObservedAt")?.format).toBe("rfc3339_timestamp");
    for (const path of ["relevance", "bridgeClarity", "timeliness"]) {
      expect(formula.variables.find((variable) => variable.path === path)).toMatchObject({ minimum: 0, maximum: 1 });
      expect(formula.variables.find((variable) => variable.path === path)?.description).toContain("手工情景值");
    }
    const valid = {
      trendSourceKind: "xiaohongshu_hotspot_rank",
      trendSourceRef: "title:具体榜单条目",
      sourceObservedAt: "2026-07-14T08:00:00+08:00",
      relevance: 0.8,
      bridgeClarity: 0.7,
      timeliness: 0.6,
    };
    const evaluated = evaluateFormulaDefinition(formula, valid);
    expect(evaluated.value).toBeCloseTo(0.336);
    expect(evaluated.calculatorContract).toEqual(F30_CALCULATOR_CONTRACT);
    expect(evaluated.calculatorContract).toMatchObject({
      mode: "manual_scenario",
      outputMetric: "TrendFit",
      outputSemantics: "unvalidated_scenario_index",
      outputRange: [0, 1],
      consumedBy: { generation: false, planning: false, selection: false, validation: false },
    });
    expect(evaluated.calculatorContract?.excludedResearchOutputs).toContainEqual(expect.objectContaining({
      metric: "qualifiedIncrementalReach",
      protocolId: "qualified_incremental_reach_protocol",
      status: "not_executed",
      outputProduced: false,
      notProducedByCalculator: true,
    }));
    expect(evaluated.calculatorContract?.boundaries.join(" ")).toContain("不能保证曝光");
    expect(evaluated.calculatorContract?.boundaries.join(" ")).toContain("不联网核验");

    const discussion = evaluateFormulaDefinition(formula, { ...valid, trendSourceKind: "xiaohongshu_hot_discussion", trendSourceRef: "title:具体热议话题" });
    const other = evaluateFormulaDefinition(formula, { ...valid, trendSourceKind: "other_explicit_source", trendSourceRef: "source:其他明确来源对象" });
    expect(discussion.value).toBeCloseTo(0.336);
    expect(other.value).toBeCloseTo(0.336);
  });

  it("accepts only specific declared trend references and rejects hashtag-only or vague source claims", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F30")!;
    const base = {
      trendSourceKind: "other_explicit_source",
      trendSourceRef: "id:rank-123",
      sourceObservedAt: "2026-07-14T08:00:00+08:00",
      relevance: 0.8,
      bridgeClarity: 0.7,
      timeliness: 0.6,
    };
    const accepted = [
      "https://example.com/hotspot/items/123?from=rank",
      "id:rank-123",
      "title：恢复期常见问题",
      "source:小红书客户端截图 2026-07-14",
      "title:#眼袋 恢复期常见问题",
    ];
    for (const trendSourceRef of accepted) {
      const result = evaluateFormulaDefinition(formula, { ...base, trendSourceRef });
      expect(result.value, trendSourceRef).toBeCloseTo(0.336);
      expect(result.warnings, trendSourceRef).toEqual([]);
    }

    for (const trendSourceRef of ["#眼袋", "#眼袋 #恢复期", "title:#眼袋", "title：#眼袋 #恢复期"]) {
      const result = evaluateFormulaDefinition(formula, { ...base, trendSourceRef });
      expect(result.value, trendSourceRef).toBeNull();
      expect(result.warnings.join(" "), trendSourceRef).toContain("[source_ref_hashtag_only]");
      expect(result.warnings.join(" "), trendSourceRef).toContain("does not verify the source online");
    }

    const vague = [
      "热点", "热门", "热议", "话题", "榜单", "趋势", "推荐", "unknown", "n-a", "未知", "暂无",
      "小红书", "平台", "小红书热点", "平台热门话题", "小红书平台热议榜单",
    ];
    for (const payload of vague) {
      const result = evaluateFormulaDefinition(formula, { ...base, trendSourceRef: `title:${payload}` });
      expect(result.value, payload).toBeNull();
      expect(result.warnings.join(" "), payload).toContain("[source_ref_not_specific]");
    }
    for (const trendSourceRef of ["热点", "title:", "https://user:secret@example.com/hotspot", "source:https://user@example.com/item"]) {
      const result = evaluateFormulaDefinition(formula, { ...base, trendSourceRef });
      expect(result.value, trendSourceRef).toBeNull();
      expect(result.warnings.join(" "), trendSourceRef).toContain("[source_ref_not_specific]");
    }
  });

  it("requires a real RFC3339 observation timestamp with seconds and a bounded timezone offset", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F30")!;
    const base = {
      trendSourceKind: "other_explicit_source",
      trendSourceRef: "source:明确来源对象",
      sourceObservedAt: "2026-07-14T08:00:00+08:00",
      relevance: 0.8,
      bridgeClarity: 0.7,
      timeliness: 0.6,
    };
    for (const sourceObservedAt of [
      "2024-02-29T23:59:59Z",
      "2026-07-14T08:00:00.1+08:00",
      "2026-07-14T08:00:00.123456789+14:00",
      "2026-07-14T08:00:00-14:00",
    ]) {
      expect(evaluateFormulaDefinition(formula, { ...base, sourceObservedAt }).value, sourceObservedAt).toBeCloseTo(0.336);
    }

    for (const sourceObservedAt of [
      "2026-07-14 08:00:00",
      "2026-07-14T08:00+08:00",
      "2026-07-14T08:00:00",
      "2026-07-14T08:00:00z",
      "2026-07-14T08:00:00.1234567890Z",
      " 2026-07-14T08:00:00Z",
    ]) {
      const result = evaluateFormulaDefinition(formula, { ...base, sourceObservedAt });
      expect(result.value, sourceObservedAt).toBeNull();
      expect(result.warnings.join(" "), sourceObservedAt).toContain("[observed_at_invalid_format]");
      expect(result.warnings.join(" "), sourceObservedAt).toContain("does not verify an observation");
    }

    for (const sourceObservedAt of [
      "2026-02-30T00:00:00+08:00",
      "2025-02-29T00:00:00Z",
      "0000-01-01T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-07-14T24:00:00Z",
      "2026-07-14T23:60:00Z",
      "2026-07-14T23:59:60Z",
      "2026-07-14T08:00:00+14:01",
      "2026-07-14T08:00:00-15:00",
    ]) {
      const result = evaluateFormulaDefinition(formula, { ...base, sourceObservedAt });
      expect(result.value, sourceObservedAt).toBeNull();
      expect(result.warnings.join(" "), sourceObservedAt).toContain("[observed_at_invalid_value]");
    }
  });

  it("keeps F30 missing, invalid and out-of-range inputs unknown rather than clamping or guessing", () => {
    const formula = DEFAULT_FORMULAS.find((item) => item.id === "F30")!;
    const valid = {
      trendSourceKind: "xiaohongshu_hot_discussion",
      trendSourceRef: "title:明确热议对象",
      sourceObservedAt: "2026-07-14T08:00:00+08:00",
      relevance: 0.8,
      bridgeClarity: 0.7,
      timeliness: 0.6,
    };
    const outOfRange = { ...valid, timeliness: 1.01 };
    expect(evaluateFormula(formula.expression!, outOfRange).value).toBeNull();
    const rejectedRange = evaluateFormulaDefinition(formula, outOfRange);
    expect(rejectedRange.value).toBeNull();
    expect(rejectedRange.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/F30 timeliness.*\[0, 1\]/u)]));

    const { trendSourceRef: _missing, ...missingContext } = valid;
    const missing = evaluateFormulaDefinition(formula, missingContext);
    expect(missing.value).toBeNull();
    expect(missing.unknownPaths).toContain("trendSourceRef");

    const wrongKind = evaluateFormulaDefinition(formula, { ...valid, trendSourceKind: "platform_rank_claim_without_source" });
    expect(wrongKind.value).toBeNull();
    expect(wrongKind.warnings.join(" ")).toContain("must be one of");

    const emptyRef = evaluateFormulaDefinition(formula, { ...valid, trendSourceRef: "   " });
    expect(emptyRef.value).toBeNull();
    expect(emptyRef.warnings.join(" ")).toContain("non-empty string");
  });

  it("recognizes only the two exact known former official F30 semantics for fail-closed migration", () => {
    const legacyOfficial = {
      id: "F30",
      title: "热点相关性与合格触达",
      type: "proxy",
      evidenceStatus: "unvalidated",
      equation: "TrendFit=Relevance·BridgeClarity·Timeliness",
      plainLanguage: "热点相关性与合格触达：先通过相关性门槛。它是待验证的推理或离线代理，不是平台经验定律。",
      purpose: "先通过相关性门槛",
      variables: ["relevance", "bridgeClarity", "timeliness"].map((path) => ({ path, description: path, valueType: "number", required: true })),
      expression: { op: "multiply", args: ["relevance", "bridgeClarity", "timeliness"].map((path) => ({ op: "var", path })) },
    } as any;
    expect(formulaEquationFingerprint(legacyOfficial, false)).toBe(LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT);
    expect(isLegacyOfficialF30(legacyOfficial)).toBe(true);
    const customized = structuredClone(legacyOfficial);
    customized.purpose = "自定义旧公式";
    expect(isLegacyOfficialF30(customized)).toBe(false);

    const previousReviewed = structuredClone(DEFAULT_FORMULAS.find((item) => item.id === "F30")!);
    const previousKind = previousReviewed.variables.find((variable) => variable.path === "trendSourceKind")!;
    previousKind.description = "热点来源类型：xiaohongshu_hotspot_rank=指定时间观察到的小红书热点榜条目；xiaohongshu_hot_discussion=小红书热议话题但不宣称进入榜单；other_explicit_source=其他明确来源且不得伪装成前两类";
    const previousRef = previousReviewed.variables.find((variable) => variable.path === "trendSourceRef")!;
    previousRef.description = "具体热点榜条目、热议话题或其他来源对象；不是待生成的标签";
    delete previousRef.format;
    const previousObservedAt = previousReviewed.variables.find((variable) => variable.path === "sourceObservedAt")!;
    previousObservedAt.description = "判断热点来源与时效性的观察时间或快照时间";
    delete previousObservedAt.format;
    previousReviewed.calculatorContract!.boundaries = [
      "xiaohongshu_hotspot_rank 只表示在 sourceObservedAt 观察到一个具体小红书热点榜条目，不证明持续热度或触达增量。",
      "xiaohongshu_hot_discussion 只表示一个具体小红书热议对象，不得冒充热点榜条目。",
      "other_explicit_source 必须填写具体来源对象，且不得改写成小红书热点榜或热议来源。",
      "relevance、bridgeClarity、timeliness 都是用户手工情景输入，未校准且不是平台观测值。",
      "标签与热点词只能表达内容关联，不能保证曝光、推荐、进入或合格触达。",
    ];
    expect(formulaEquationFingerprint(previousReviewed, false)).toBe(PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT);
    expect(isLegacyOfficialF30(previousReviewed)).toBe(true);
    const customizedPrevious = structuredClone(previousReviewed);
    customizedPrevious.calculatorContract!.boundaries[0] += " custom";
    expect(isLegacyOfficialF30(customizedPrevious)).toBe(false);
    expect(isLegacyOfficialF30(DEFAULT_FORMULAS.find((item) => item.id === "F30")!)).toBe(false);
    expect(F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS).toEqual([
      LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
      PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
    ]);
    expect(F30_MIGRATION_DESCRIPTOR).toMatchObject({
      formulaId: "F30",
      legacyOfficialSemanticFingerprint: LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
      previousReviewedSemanticFingerprint: PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
      eligibleSourceSemanticFingerprints: [
        LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
        PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
      ],
      eligibility: "official_exact_match_only",
      customFormulaPolicy: "fail_closed_pending_review",
    });
    expect(F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS).not.toContain(F30_MIGRATION_DESCRIPTOR.targetSemanticFingerprint);
  });

  it("migrates only exact former built-in F32/F33 semantics to the ordered-component contracts", () => {
    const legacyF32 = structuredClone(DEFAULT_FORMULAS.find((formula) => formula.id === "F32")!);
    legacyF32.title = "正文诊断卡";
    legacyF32.equation = "Q̂B=positive signals-costs-risks-errors";
    legacyF32.purpose = "逐项体检正文";
    legacyF32.plainLanguage = "正文诊断卡：逐项体检正文。它是待验证的推理或离线代理，不是平台经验定律。";
    delete legacyF32.diagnosticContract;
    const legacyF33 = structuredClone(DEFAULT_FORMULAS.find((formula) => formula.id === "F33")!);
    legacyF33.title = "评论诊断卡";
    legacyF33.equation = "Q̂C=coverage+increment+fit+grounding+liveness-contradiction-marketing";
    legacyF33.purpose = "逐项体检问答线程";
    legacyF33.plainLanguage = "评论诊断卡：逐项体检问答线程。它是待验证的推理或离线代理，不是平台经验定律。";
    delete legacyF33.diagnosticContract;

    expect(formulaEquationFingerprint(legacyF32, false)).toBe(LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT);
    expect(formulaEquationFingerprint(legacyF33, false)).toBe(LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT);
    expect(isLegacyOfficialF32OrF33(legacyF32)).toBe(true);
    expect(isLegacyOfficialF32OrF33(legacyF33)).toBe(true);
    const customLegacy = structuredClone(legacyF32);
    customLegacy.purpose = "自定义诊断";
    expect(isLegacyOfficialF32OrF33(customLegacy)).toBe(false);
    expect(F32_F33_MIGRATION_DESCRIPTOR).toMatchObject({
      formulaIds: ["F32", "F33"],
      eligibleSourceSemanticFingerprints: {
        F32: LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT,
        F33: LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT,
      },
      eligibility: "official_exact_match_only",
      customFormulaPolicy: "fail_closed_pending_review",
    });
    expect(F32_F33_MIGRATION_DESCRIPTOR.targetSemanticFingerprints).toEqual({
      F32: FORMULA_EXECUTION_HANDLER_REGISTRY.F32!.semanticFingerprint,
      F33: FORMULA_EXECUTION_HANDLER_REGISTRY.F33!.semanticFingerprint,
    });
  });
});

describe("formula versions and methodology seed", () => {
  it("ships exactly F01-F43 with explicit epistemic status", () => {
    expect(DEFAULT_FORMULA_VERSION.version).toBe("1.6.0");
    expect(DEFAULT_FORMULAS).toHaveLength(43);
    expect(DEFAULT_FORMULAS.map((item) => item.id)).toEqual(Array.from({ length: 43 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`));
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F03")?.plainLanguage).toContain("生产定义");
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F30")?.evidenceStatus).toBe("unvalidated");
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F32")).toMatchObject({
      title: "正文分项检查清单",
      equation: expect.stringContaining("OrderForReview"),
      diagnosticContract: F32_DIAGNOSTIC_CONTRACT,
    });
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F33")).toMatchObject({
      title: "评论分项检查清单",
      equation: expect.stringContaining("OrderForReview"),
      diagnosticContract: F33_DIAGNOSTIC_CONTRACT,
    });
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F32")?.equation).not.toMatch(/[+\-]|Q̂/u);
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F33")?.equation).not.toMatch(/[+\-]|Q̂/u);
    expect(Object.isFrozen(F32_DIAGNOSTIC_CONTRACT)).toBe(true);
    expect(Object.isFrozen(F32_DIAGNOSTIC_CONTRACT.emphasis.doesNotAffect)).toBe(true);
    expect(F32_DIAGNOSTIC_CONTRACT.componentDefinitions.every((component) => Object.isFrozen(component))).toBe(true);
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F38")?.equation).toContain("DomainPrior");
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F38")?.purpose).toContain("知识库只提供项目事实");
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F39")?.type).toBe("normative");
    expect(DEFAULT_FORMULAS.find((item) => item.id === "F43")?.equation).toContain("Hash");
  });

  it("records the reviewed R07 truth class and implementation status for every formula", () => {
    const expectedByStatus = {
      active: ["F01", "F03", "F04", "F06", "F25", "F42", "F43"],
      partial: ["F02", "F05", "F07", "F09", "F10", "F12", "F13", "F14", "F19", "F22", "F26", "F32", "F33", "F34", "F36", "F38", "F39", "F40", "F41"],
      conditional: ["F17", "F21", "F30"],
      "protocol-only": ["F08", "F11", "F15", "F16", "F18", "F20", "F23", "F24", "F27", "F28", "F29", "F31", "F35", "F37"],
    } as const;
    const expectedByClass = {
      "direct-executable": ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F09", "F10", "F19", "F25", "F26", "F36", "F38", "F39", "F40", "F42", "F43"],
      "derived-calculator": ["F17", "F21", "F30"],
      "diagnostic-proxy": ["F14", "F32", "F33"],
      protocol: ["F08", "F11", "F15", "F16", "F20", "F23", "F24", "F27", "F29", "F31", "F35", "F37"],
      hypothesis: ["F12", "F13", "F22", "F41"],
      "not-implemented": ["F18", "F28", "F34"],
    } as const;
    const ids = DEFAULT_FORMULAS.map((formula) => formula.id);
    expect(Object.keys(FORMULA_EXECUTION_OWNERSHIP).sort()).toEqual([...ids].sort());
    expect(FORMULA_EXECUTION_POLICY_VERSION).toBe("3.6.0");
    expect(FORMULA_EXECUTION_POLICY_DIGEST).toMatch(/^[a-f0-9]{64}$/u);

    for (const [status, expectedIds] of Object.entries(expectedByStatus)) {
      expect(Object.values(FORMULA_EXECUTION_OWNERSHIP)
        .filter((item) => item.implementationStatus === status)
        .map((item) => item.formulaId)).toEqual(expectedIds);
    }
    for (const [executionClass, expectedIds] of Object.entries(expectedByClass)) {
      expect(Object.values(FORMULA_EXECUTION_OWNERSHIP)
        .filter((item) => item.executionClass === executionClass)
        .map((item) => item.formulaId)).toEqual(expectedIds);
    }
    for (const id of ids) {
      const ownership = FORMULA_EXECUTION_OWNERSHIP[id]!;
      const registration = FORMULA_EXECUTION_HANDLER_REGISTRY[id]!;
      expect(ownership.stages.every((stage) => FORMULA_EXECUTION_STAGES.includes(stage))).toBe(true);
      expect(ownership.declaredStages.every((stage) => FORMULA_EXECUTION_STAGES.includes(stage))).toBe(true);
      expect(ownership.dataRequirement.length).toBeGreaterThan(0);
      expect(ownership.actualExecution.length).toBeGreaterThan(0);
      expect(ownership.implementationBoundary.length).toBeGreaterThan(0);
      expect(ownership.codeLocations.length).toBeGreaterThan(0);
      expect(Object.keys(registration.handlers).sort()).toEqual([...FORMULA_HANDLER_KINDS].sort());
      expect(registration.handlers.planning).toEqual([]);
      expect(registration.handlers.binder).toEqual([]);
      expect(registration.handlers.validator).toEqual([]);
      expect(registration.handlers.evaluation).toEqual([]);
      expect(registration.handlers["knowledge-update"]).toEqual([]);
    }
  });

  it("defines F12, F13 and F41 as revisable scenarios rather than audience truth", () => {
    const f12 = DEFAULT_FORMULAS.find((item) => item.id === "F12")!;
    const f13 = DEFAULT_FORMULAS.find((item) => item.id === "F13")!;
    const f41 = DEFAULT_FORMULAS.find((item) => item.id === "F41")!;

    expect(f12).toMatchObject({ type: "hypothesis", title: "入口条件化写作情景" });
    expect(f12.equation).toContain("Hypothesize(entry,stage");
    expect(f12.equation).not.toContain("P(st|");
    expect(f13).toMatchObject({ type: "hypothesis", title: "未标定状态假设" });
    expect(f13.equation).toContain("preContactKnown?");
    expect(f41.equation).toContain("availableEvidence");
    expect(f41.equation).toContain("status=hypothesis");

    const audit = formulaExecutionAudit(DEFAULT_FORMULA_VERSION) as {
      formulaTrace: Array<{ id: string; actualExecution: string; implementationBoundary: string; dataRequirement: string }>;
    };
    const byId = new Map(audit.formulaTrace.map((item) => [item.id, item]));
    expect(byId.get("F12")?.implementationBoundary).toContain("不是抽样、分类或估计得到的人群分布");
    expect(byId.get("F13")?.actualExecution).toContain("calibrated=false");
    expect(byId.get("F41")?.implementationBoundary).toContain("不能冒充读者原本已知");
    expect(byId.get("F41")?.dataRequirement).toContain("各字段身份不得互换");
  });

  it("keeps F19 and F40 at draft scope until final image, entry snapshot and deployment exist", () => {
    const f19 = DEFAULT_FORMULAS.find((item) => item.id === "F19")!;
    const f40 = DEFAULT_FORMULAS.find((item) => item.id === "F40")!;
    expect(f19.title).toBe("入口草稿与真实预览");
    expect(f19.equation).toContain("EntryDraft=Plan");
    expect(f19.equation).toContain("PreviewObserved=Observe");
    expect(f40.title).toBe("多模态编排草稿与落实");
    expect(f40.equation).toContain("OrchRealized requires FinalImg∧DeploymentObserved");

    const audit = formulaExecutionAudit(DEFAULT_FORMULA_VERSION) as {
      formulaTrace: Array<{ id: string; implementedStages: string[]; actualExecution: string; implementationBoundary: string }>;
    };
    const byId = new Map(audit.formulaTrace.map((item) => [item.id, item]));
    expect(byId.get("F19")?.implementedStages).toEqual(["planning", "generation", "validation"]);
    expect(byId.get("F19")?.implementationBoundary).toContain("PreviewObserved");
    expect(byId.get("F40")?.actualExecution).toContain("productionArtifacts");
    expect(byId.get("F40")?.implementationBoundary).toContain("OrchRealized 未完成");
  });

  it("runs only F17/F21/F30 as reviewed conditional calculators", () => {
    for (const id of ["F17", "F21", "F30"] as const) {
      const registration = FORMULA_EXECUTION_HANDLER_REGISTRY[id]!;
      const formula = DEFAULT_FORMULAS.find((item) => item.id === id)!;
      expect(registration).toMatchObject({
        implementationStatus: "conditional",
        executionClass: "derived-calculator",
        stages: ["calculation"],
        controlMode: "fully-gated",
        disableable: true,
        directGenerationInstruction: false,
      });
      expect(registration.handlers.calculator).toEqual([`calculator:${id}`]);
      expect(formula.expression).toBeDefined();
      expect(formula.variables.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_FORMULAS.filter((item) => item.expression).map((item) => item.id)).toEqual(["F17", "F21", "F30"]);
    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F30).toMatchObject({
      stages: ["calculation"],
      declaredStages: ["calculation"],
      nonDispatchedStages: [],
      executionRoles: ["conditional-calculator"],
      handlers: {
        calculator: ["calculator:F30"],
        parameter: [],
        planning: [],
        prompt: [],
        validator: [],
        evaluation: [],
      },
    });
    const f30Ownership = FORMULA_EXECUTION_OWNERSHIP.F30!;
    expect(f30Ownership.actualExecution).toContain("id:/title:/source:");
    expect(f30Ownership.actualExecution).toContain("带秒和时区的 RFC3339");
    expect(f30Ownership.dataRequirement).toContain("无 userinfo 的绝对 http/https URL");
    expect(f30Ownership.dataRequirement).toContain("本地声明校验、不联网核验");
    expect(f30Ownership.implementationBoundary).toContain("只校验用户声明");
    expect(f30Ownership.implementationBoundary).toContain("不联网核验");
    expect(f30Ownership.implementationBoundary).toContain("不进入生成、规划、选稿或校验");
  });

  it("keeps protocols and unimplemented equations non-running with no dispatch handlers", () => {
    const nonRunning = ["F08", "F11", "F15", "F16", "F18", "F20", "F23", "F24", "F27", "F28", "F29", "F31", "F34", "F35", "F37"];
    for (const id of nonRunning) {
      const registration = FORMULA_EXECUTION_HANDLER_REGISTRY[id]!;
      expect(registration.stages).toEqual([]);
      expect(registration.controlMode).toBe("not-running");
      expect(registration.disableable).toBe(false);
      expect(Object.values(registration.handlers).flat()).toEqual([]);
      expect(registration.directGenerationInstruction).toBe(false);
    }
  });

  it("separates partial semantic gaps from dispatcher coverage and reports control mode truthfully", () => {
    const expectedByControlMode = {
      "fully-gated": ["F17", "F21", "F30", "F32", "F33"],
      "partially-gated": ["F01", "F03", "F04", "F05", "F06", "F07", "F09", "F10", "F12", "F13", "F14", "F19", "F22", "F25", "F26", "F40"],
      "always-on": ["F02", "F36", "F38", "F39", "F41", "F42", "F43"],
      "not-running": ["F08", "F11", "F15", "F16", "F18", "F20", "F23", "F24", "F27", "F28", "F29", "F31", "F34", "F35", "F37"],
    } as const;
    for (const [mode, expectedIds] of Object.entries(expectedByControlMode)) {
      expect(Object.values(FORMULA_EXECUTION_HANDLER_REGISTRY)
        .filter((item) => item.controlMode === mode)
        .map((item) => item.formulaId)).toEqual(expectedIds);
    }

    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F09).toMatchObject({
      implementationStatus: "partial",
      stages: ["planning", "generation", "validation"],
      nonDispatchedStages: ["planning", "validation"],
      controlMode: "partially-gated",
    });
    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F33).toMatchObject({
      implementationStatus: "partial",
      stages: ["diagnostic"],
      nonDispatchedStages: [],
      controlMode: "fully-gated",
      handlers: { parameter: [], prompt: [], diagnostic: ["diagnostic:F33"] },
    });
    expect(FORMULA_EXECUTION_HANDLER_REGISTRY.F34).toMatchObject({
      implementationStatus: "partial",
      executionClass: "not-implemented",
      stages: [],
      controlMode: "not-running",
    });
  });

  it("keeps only reviewed production formulas in direct drafting guidance and exposes stage gaps in audit", () => {
    const direct = directGenerationFormulas(DEFAULT_FORMULA_VERSION).map((formula) => formula.id);
    expect(direct).toEqual(["F01", "F03", "F04", "F05", "F06", "F07", "F09", "F10", "F19", "F25", "F40"]);
    expect(directGenerationFormulas(DEFAULT_FORMULA_VERSION).every((formula) => formula.type !== "hypothesis" && formula.type !== "proxy")).toBe(true);

    const audit = formulaExecutionAudit(DEFAULT_FORMULA_VERSION) as {
      executionPolicyVersion: string;
      handlerGatingCoverage: { calculator: string };
      directGenerationFormulas: Array<{ id: string; stages: string[]; executionClass: string; instructionMode: string }>;
      indirectFormulas: Array<{ id: string; stages: string[]; executionClass: string; instructionMode: string }>;
      nonDispatchedFormulas: Array<{ id: string; stages: string[]; controlMode: string; instructionMode: string }>;
      stageDispatchGaps: Array<{ id: string; nonDispatchedStages: string[]; controlMode: string }>;
      unassignedFormulaIds: string[];
    };
    expect(audit.executionPolicyVersion).toBe("3.6.0");
    expect(audit.handlerGatingCoverage.calculator).toContain("reviewed-safe-AST");
    expect(audit.unassignedFormulaIds).toEqual([]);
    expect(audit.directGenerationFormulas).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "F04", stages: ["planning", "generation"], executionClass: "direct-executable", instructionMode: "direct-executable-generation" }),
    ]));
    expect(audit.indirectFormulas).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "F17", stages: ["calculation"], executionClass: "derived-calculator", instructionMode: "registered-indirect-dispatch" }),
      expect.objectContaining({ id: "F32", stages: ["diagnostic"], executionClass: "diagnostic-proxy" }),
    ]));
    expect(audit.nonDispatchedFormulas).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "F38", stages: ["planning"], controlMode: "always-on", instructionMode: "declared-stage-not-dispatched" }),
      expect.objectContaining({ id: "F41", stages: ["planning"], controlMode: "always-on" }),
      expect.objectContaining({ id: "F43", stages: ["planning"], controlMode: "always-on" }),
    ]));
    expect(audit.stageDispatchGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "F09", nonDispatchedStages: ["planning", "validation"], controlMode: "partially-gated" }),
      expect.objectContaining({ id: "F34", nonDispatchedStages: ["diagnostic", "validation", "knowledge-update"], controlMode: "not-running" }),
    ]));
  });

  it("inherits handlers and evidence only for an exact reviewed semantic fingerprint", () => {
    const reviewed = DEFAULT_FORMULAS[0]!;
    expect(formulaEquationFingerprint(reviewed)).toMatch(/^[a-f0-9]{64}$/u);
    expect(formulaEquationFingerprint(reviewed)).toBe(FORMULA_EXECUTION_HANDLER_REGISTRY.F01?.equationFingerprint);
    expect(resolveFormulaExecution(reviewed, ["F01"])).toMatchObject({
      compatibilityStatus: "reviewed",
      handlerState: "enabled",
      effectiveEvidenceStatus: "definition",
    });

    const changed = { ...reviewed, equation: `${reviewed.equation} + custom` };
    expect(resolveFormulaExecution(changed, ["F01"])).toMatchObject({
      compatibilityStatus: "pending_review",
      handlerState: "pending_review",
      effectiveEvidenceStatus: "unreviewed",
      effectiveHandlers: { prompt: [] },
    });
    const changedAst = { ...reviewed, expression: { op: "literal" as const, value: 0.999 } };
    expect(resolveFormulaExecution(changedAst, ["F01"])).toMatchObject({
      compatibilityStatus: "pending_review",
      handlerState: "pending_review",
      effectiveHandlers: { parameter: [], prompt: [] },
    });
    const changedPlainLanguage = { ...reviewed, plainLanguage: `${reviewed.plainLanguage} custom behavior` };
    expect(resolveFormulaExecution(changedPlainLanguage, ["F01"])).toMatchObject({
      compatibilityStatus: "pending_review",
      handlerState: "pending_review",
      effectiveHandlers: { parameter: [], prompt: [] },
    });
    expect(formulaEquationFingerprint(reviewed, false)).not.toBe(formulaEquationFingerprint(reviewed, true));
    const semanticMutationVersion = createFormulaVersion({
      id: "semantic-mutation",
      version: "1.0.0",
      status: "active",
      createdAt: "2026-07-13T00:00:00.000Z",
      formulas: [changedAst],
    });
    expect(directGenerationFormulas(semanticMutationVersion, ["F01"])).toEqual([]);
    expect(renderFormulaInstructions(semanticMutationVersion, ["F01"])).toBe("");
    const unreviewed = { ...reviewed, id: "F99" as const };
    expect(resolveFormulaExecution(unreviewed, ["F99"])).toMatchObject({
      compatibilityStatus: "unreviewed",
      handlerState: "unreviewed",
      effectiveEvidenceStatus: "unreviewed",
    });

    const customVersion = createFormulaVersion({
      id: "custom-formula-equation",
      version: "1.0.0",
      status: "active",
      createdAt: "2026-07-13T00:00:00.000Z",
      formulas: [changed, unreviewed],
    });
    expect(directGenerationFormulas(customVersion, ["F01", "F99"])).toEqual([]);
    const audit = formulaExecutionAudit(customVersion, ["F01", "F99"]) as {
      pendingReviewFormulas: Array<{ id: string; effectiveEvidenceStatus: string }>;
      unreviewedFormulas: Array<{ id: string; effectiveEvidenceStatus: string }>;
    };
    expect(audit.pendingReviewFormulas).toEqual([
      expect.objectContaining({ id: "F01", effectiveEvidenceStatus: "unreviewed" }),
    ]);
    expect(audit.unreviewedFormulas).toEqual([
      expect.objectContaining({ id: "F99", effectiveEvidenceStatus: "unreviewed" }),
    ]);
  });

  it("treats an explicit empty enabled set as disabled while keeping safety invariants always on", () => {
    expect(directGenerationFormulas(DEFAULT_FORMULA_VERSION, [])).toEqual([]);
    const audit = formulaExecutionAudit(DEFAULT_FORMULA_VERSION, []) as {
      directGenerationFormulaIds: string[];
      disabledFormulas: Array<{ id: string; handlerState: string; effectiveHandlers: Record<string, string[]> }>;
      hardSafetyInvariants: Array<{ id: string; disableable: boolean }>;
    };
    expect(audit.directGenerationFormulaIds).toEqual([]);
    expect(audit.disabledFormulas).toHaveLength(43);
    expect(audit.disabledFormulas[0]).toMatchObject({ handlerState: "disabled" });
    expect(Object.values(audit.disabledFormulas[0]!.effectiveHandlers).flat()).toEqual([]);
    expect(audit.hardSafetyInvariants).toEqual(HARD_SAFETY_INVARIANTS);
    expect(audit.hardSafetyInvariants.every((item) => item.disableable === false)).toBe(true);
    expect(Object.isFrozen(HARD_SAFETY_INVARIANTS)).toBe(true);
    expect(HARD_SAFETY_INVARIANTS.every((item) => Object.isFrozen(item) && Object.isFrozen(item.handlers))).toBe(true);
  });

  it("creates a content-addressed immutable-version snapshot", () => {
    const input = {
      id: "project-v1",
      projectId: "p1",
      version: "1.0.0",
      status: "draft" as const,
      createdAt: "2026-07-12T00:00:00.000Z",
      formulas: DEFAULT_FORMULAS.slice(0, 2),
    };
    const first = createFormulaVersion(input);
    const second = createFormulaVersion(structuredClone(input));
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(formulaVersionDigest(input));
    expect(DEFAULT_FORMULA_VERSION.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps the immutable digest valid after a JSON database round-trip", () => {
    const created = createFormulaVersion({
      id: "json-round-trip",
      projectId: "p1",
      version: "1.0.0",
      status: "active",
      createdAt: "2026-07-13T00:00:00.000Z",
      formulas: DEFAULT_FORMULAS,
    });
    const restored = JSON.parse(JSON.stringify(created));
    expect(validateFormulaVersion(restored)).toEqual([]);
  });

  it("fails closed on unknown variable formats and formats attached to non-string variables", () => {
    const unknownFormat = structuredClone(DEFAULT_FORMULA_VERSION) as any;
    unknownFormat.digest = "";
    const f30Index = unknownFormat.formulas.findIndex((formula: any) => formula.id === "F30");
    unknownFormat.formulas[f30Index].variables[1].format = "unreviewed_external_format";
    expect(validateFormulaVersion(unknownFormat)).toContainEqual(expect.objectContaining({
      path: `$.formulas[${f30Index}].variables[1].format`,
      code: "unknown_variable_format",
    }));

    const wrongValueType = structuredClone(DEFAULT_FORMULA_VERSION) as any;
    wrongValueType.digest = "";
    wrongValueType.formulas.find((formula: any) => formula.id === "F17").variables[0].format = "rfc3339_timestamp";
    expect(validateFormulaVersion(wrongValueType)).toContainEqual(expect.objectContaining({
      code: "format_requires_string",
    }));
  });

  it("validates diagnostic contracts at runtime and keeps well-formed semantic changes pending review", () => {
    expect(validateFormulaVersion(DEFAULT_FORMULA_VERSION)).toEqual([]);

    const malformed = structuredClone(DEFAULT_FORMULA_VERSION) as any;
    malformed.digest = "";
    malformed.formulas.find((formula: any) => formula.id === "F32").diagnosticContract.scoreProduced = true;
    expect(validateFormulaVersion(malformed)).toContainEqual(expect.objectContaining({
      code: "invalid_diagnostic_contract_literal",
      path: expect.stringContaining("diagnosticContract.scoreProduced"),
    }));
    expect(() => createFormulaVersion({
      id: "malformed-diagnostic-contract",
      version: "1.0.0",
      status: "draft",
      createdAt: "2026-07-14T00:00:00.000Z",
      formulas: malformed.formulas,
    })).toThrow(/scoreProduced/u);

    const extraScore = structuredClone(DEFAULT_FORMULAS.find((formula) => formula.id === "F33")!) as any;
    extraScore.diagnosticContract.score = 88;
    expect(() => createFormulaVersion({
      id: "diagnostic-contract-with-score",
      version: "1.0.0",
      status: "draft",
      createdAt: "2026-07-14T00:00:00.000Z",
      formulas: [extraScore],
    })).toThrow(/reviewed contract fields/u);

    const wellFormedCustom = structuredClone(DEFAULT_FORMULAS.find((formula) => formula.id === "F32")!);
    wellFormedCustom.diagnosticContract!.boundaries[0] += " 自定义展示说明。";
    const customVersion = createFormulaVersion({
      id: "well-formed-custom-diagnostic",
      version: "1.0.0",
      status: "draft",
      createdAt: "2026-07-14T00:00:00.000Z",
      formulas: [wellFormedCustom],
    });
    expect(resolveFormulaExecution(customVersion.formulas[0]!, ["F32"])).toMatchObject({
      compatibilityStatus: "pending_review",
      handlerState: "pending_review",
      effectiveHandlers: { diagnostic: [] },
    });
  });

  it("detects formula content changed behind an immutable digest", () => {
    const changed = structuredClone(DEFAULT_FORMULA_VERSION);
    changed.formulas[0]!.purpose = "被静默修改";
    expect(validateFormulaVersion(changed)).toEqual(expect.arrayContaining([expect.objectContaining({ code: "digest_mismatch" })]));
  });

  it("derives stable but distinct candidate seeds from formula digest", () => {
    const seeds = [0, 1, 2].map((index) => deriveCandidateSeed(42, DEFAULT_FORMULA_VERSION.digest, "job", index));
    expect(new Set(seeds).size).toBe(3);
    expect(deriveCandidateSeed(42, DEFAULT_FORMULA_VERSION.digest, "job", 0)).toBe(seeds[0]);
  });
});
