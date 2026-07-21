import assert from "node:assert/strict";
import test from "node:test";

import {
  F32_DIAGNOSTIC_CONTRACT,
  F33_DIAGNOSTIC_CONTRACT,
  FORMULA_EXECUTION_HANDLER_REGISTRY,
} from "../../../packages/agent-core/src/formula.js";

import {
  CANONICAL_DIAGNOSTIC_CONTRACTS,
  CANONICAL_DIAGNOSTIC_FINGERPRINTS,
  hasCanonicalDiagnosticContract,
  hasCanonicalDiagnosticReport,
  resolveDiagnosticProxyView,
  resolveValidationReadinessHeuristic,
} from "../src/lib/diagnostic-proxy.js";
import {
  applyConfirmedFormulaActivation,
  parseReviewedDefaultsSyncResult,
  requestConfirmedFormulaActivation,
  resolveReviewedDefaultsRefresh,
  resolveImageFormulaOutputBoundary,
  resolveFormulaRuntimeView,
} from "../src/lib/formula-ui.js";
import {
  absentProductionArtifacts,
  resolveProductionArtifactView,
} from "../src/lib/image-production.js";
import {
  buildFormulaCalculationVariables,
  calculatorIssueMessage,
  calculatorResultLabel,
  hasAuthoritativeCalculationBoundary,
  isCalculationBoundToFormulaVersion,
} from "../src/lib/formula-calculator.js";
import {
  f30ParameterLinkWarning,
  hasCanonicalTrendFitContractShape,
  hasCanonicalTrendFitVariableContract,
  hasConsistentTrendFitCalculationResult,
  isReviewedTrendFitCalculatorContract,
  resolveHistoricalTrendFitSnapshot,
  resolveTrendSourceBadge,
  resolveTrendSourceView,
  sameTrendFitContract,
  trendSourceOptionsFromAllowedValues,
  TREND_FIT_NON_CONSUMPTION_COPY,
  TREND_FIT_SETTINGS_BOUNDARY_COPY,
  TREND_FIT_SIMPLE_BOUNDARY_COPY,
} from "../src/lib/trend-fit.js";
import type { FormulaCalculationResult, FormulaCalculatorContract, FormulaDefinition, FormulaVariableDefinition, FormulaVersion } from "../src/types.js";

function diagnosticReport(formulaId: "F32" | "F33", emphasis: Record<string, number> = {}) {
  const diagnosticContract = structuredClone(CANONICAL_DIAGNOSTIC_CONTRACTS[formulaId]);
  const components = diagnosticContract.componentDefinitions
    .map((definition, canonicalIndex) => ({ definition, canonicalIndex, emphasis: emphasis[definition.id] ?? 50 }))
    .sort((left, right) => right.emphasis - left.emphasis || left.canonicalIndex - right.canonicalIndex);
  let previous: number | undefined;
  let rank = 0;
  return {
    formulaId,
    formulaSemanticFingerprint: CANONICAL_DIAGNOSTIC_FINGERPRINTS[formulaId],
    name: formulaId === "F32" ? "正文分项检查清单" : "评论分项检查清单",
    semantics: "ordered_component_review_metadata",
    status: "unknown",
    evaluationStatus: "not_evaluated",
    aggregateValue: null,
    scoreProduced: false,
    evidenceStatus: "unvalidated_proxy",
    aggregation: "components_only",
    components: components.map(({ definition, emphasis: value }, index) => {
      if (previous === undefined || previous !== value) rank = index + 1;
      previous = value;
      return {
        id: definition.id,
        label: definition.label,
        direction: definition.direction,
        evidenceStatus: definition.evidenceStatus,
        boundary: definition.boundary,
        emphasis: value,
        displayOrder: index + 1,
        manualReviewRank: rank,
        emphasisSemantics: "display_and_manual_review_priority_only",
        status: "unknown",
        evaluationStatus: "not_evaluated",
        value: null,
        source: { kind: "not_observed", reference: null },
      };
    }),
    warning: formulaId === "F32"
      ? "正文分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分。"
      : "评论分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分；线程数和规则通过数不是质量分。",
    diagnosticContract,
  };
}

const formula = (patch: Partial<FormulaDefinition> = {}): FormulaDefinition => ({
  id: "F01",
  title: "内容包定义",
  type: "architecture",
  evidenceStatus: "definition",
  equation: "H + N + Cref",
  plainLanguage: "定义完整内容包。",
  purpose: "组织内容",
  variables: [],
  ...patch,
});

const trendFitContract: FormulaCalculatorContract = {
  mode: "manual_scenario",
  outputMetric: "TrendFit",
  outputSemantics: "unvalidated_scenario_index",
  outputRange: [0, 1],
  consumedBy: { generation: false, planning: false, selection: false, validation: false },
  prohibitedUses: ["generation", "planning", "selection", "validation"],
  excludedResearchOutputs: [{
    metric: "qualifiedIncrementalReach",
    protocolId: "qualified_incremental_reach_protocol",
    status: "not_executed",
    outputProduced: false,
    notProducedByCalculator: true,
    reason: "TrendFit has no exposure counterfactual, qualified-audience outcome, or deduplicated incremental-reach observation.",
    requiredObservations: [
      "预先定义的合格触达结果与合格受众口径",
      "同一口径下无热点桥接基线、热点桥接处理及可解释反事实",
      "可比入口、投放位置、平台条件、曝光机会与预先约定的归因时间窗",
      "去重后的增量触达结果，以及风险、过期和混杂处理；不能用标签数量或榜单身份代替",
    ],
  }],
  boundaries: [
    "xiaohongshu_hotspot_rank 只表示用户声明在 sourceObservedAt 观察到一个具体小红书热点榜条目；系统只校验声明格式，不联网核验榜单身份、观察时间、持续热度或触达增量。",
    "xiaohongshu_hot_discussion 只表示用户声明了一个具体小红书热议对象；系统不联网核验其存在性，也不得把该声明冒充热点榜条目。",
    "other_explicit_source 必须由用户声明具体来源对象；系统不联网核验来源存在性，且不得把它改写成小红书热点榜或热议来源。",
    "relevance、bridgeClarity、timeliness 都是用户手工情景输入，未校准且不是平台观测值。",
    "标签与热点词只能表达内容关联，不能保证曝光、推荐、进入或合格触达。",
  ],
};

const trendFitVariables: FormulaVariableDefinition[] = [
  { path: "trendSourceKind", description: "来源类型", valueType: "string", required: true, allowedValues: ["xiaohongshu_hotspot_rank", "xiaohongshu_hot_discussion", "other_explicit_source"] },
  { path: "trendSourceRef", description: "来源对象", valueType: "string", required: true, nonEmpty: true, format: "trend_source_ref" },
  { path: "sourceObservedAt", description: "观察时间", valueType: "string", required: true, nonEmpty: true, format: "rfc3339_timestamp" },
  { path: "relevance", description: "相关性", valueType: "number", required: true, minimum: 0, maximum: 1 },
  { path: "bridgeClarity", description: "桥接清晰度", valueType: "number", required: true, minimum: 0, maximum: 1 },
  { path: "timeliness", description: "时效", valueType: "number", required: true, minimum: 0, maximum: 1 },
];

const version = (patch: Partial<FormulaVersion> = {}): FormulaVersion => ({
  id: "version-draft",
  projectId: "project-1",
  version: "2.0.0-draft",
  digest: "digest-draft",
  name: "测试公式",
  status: "draft",
  formulas: [formula()],
  ...patch,
});

test("an activation request failure never produces local active state", async () => {
  const active = version({ id: "version-active", version: "1.0.0", status: "active" });
  const draft = version();
  const versions = [active, draft];
  const snapshot = structuredClone(versions);

  const result = await requestConfirmedFormulaActivation(
    versions,
    draft,
    async () => { throw new Error("network unavailable"); },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /启用失败/u);
    assert.match(result.message, /当前启用状态未改变/u);
    assert.match(result.message, /network unavailable/u);
  }
  assert.deepEqual(versions, snapshot);
  assert.equal(versions[0]?.status, "active");
  assert.equal(versions[1]?.status, "draft");
});

test("activation accepts only a matching active server response", async () => {
  const draft = version();
  const other = version({ id: "other-version", status: "active" });
  assert.throws(
    () => applyConfirmedFormulaActivation([draft], draft, other),
    /不匹配/u,
  );
  assert.throws(
    () => applyConfirmedFormulaActivation([draft], draft, { ...draft, status: "draft" }),
    /尚未确认/u,
  );

  const prior = version({ id: "prior", version: "1.0.0", status: "active" });
  const response = { ...draft, status: "active" as const, activatedAt: "2026-07-13T00:00:00.000Z" };
  const confirmed = applyConfirmedFormulaActivation([prior, draft], draft, response);
  assert.equal(confirmed.selected, response);
  assert.deepEqual(confirmed.versions.map((item) => item.status), ["archived", "active"]);
});

test("explicit reviewed-default sync accepts only the matching refreshed active version", () => {
  const response = parseReviewedDefaultsSyncResult({
    projectId: "project-1",
    formulaVersionId: "version-new",
    formulaVersionDigest: "digest-new",
    changed: true,
    operation: "ensure_reviewed_defaults",
  }, "project-1");
  const archived = version({ id: "version-old", status: "archived", digest: "digest-old" });
  const active = version({ id: "version-new", status: "active", digest: "digest-new" });
  const state = resolveReviewedDefaultsRefresh([active, archived], response);
  assert.equal(state.selected, active);
  assert.deepEqual(state.versions, [active, archived]);

  assert.throws(() => parseReviewedDefaultsSyncResult({ ...response, operation: "silent_upgrade" }, "project-1"), /同步确认不完整/u);
  assert.throws(() => parseReviewedDefaultsSyncResult({ ...response, projectId: "other-project" }, "project-1"), /同步确认不完整/u);
  assert.throws(
    () => resolveReviewedDefaultsRefresh([{ ...active, digest: "stale-digest" }], response),
    /没有返回.*匹配.*active/u,
  );
  assert.throws(
    () => resolveReviewedDefaultsRefresh([active], { ...response, changed: false }),
    /没有派生新公式版本/u,
  );
});

test("pending_review never appears executable even with stale handlers", () => {
  const view = resolveFormulaRuntimeView(formula({
    compatibilityStatus: "pending_review",
    handlerState: "enabled",
    effectiveHandlers: { prompt: ["prompt:F01"] },
  }));
  assert.equal(view.state, "pending_review");
  assert.equal(view.effectiveHandlersEnabled, false);
  assert.equal(view.directGenerationMechanism, false);
  assert.deepEqual(view.effectiveHandlers, []);
  assert.equal(view.hasServerMetadata, true);
});

test("reviewed formulas report enabled handlers without overstating equation execution", () => {
  const definition = formula();
  const reviewedVersion = version({
    formulas: [definition],
    executionAudit: {
      formulaTrace: [{
        id: "F01",
        compatibilityStatus: "reviewed",
        reviewStatus: "approved",
        handlerState: "enabled",
        implementationStatus: "active",
        executionClass: "direct-executable",
        executionRoles: ["direct-generation"],
        controlMode: "fully-gated",
        implementationRuntimeState: "handler-active",
        disableable: true,
        implementedStages: ["generation"],
        declaredStages: ["generation"],
        registeredDispatchStages: ["generation"],
        effectiveDispatchStages: ["generation"],
        nonDispatchedStages: [],
        actualExecution: "The drafting prompt applies the package contract.",
        implementationBoundary: "This is a local generation contract, not an outcome guarantee.",
        declaredEvidenceStatus: "definition",
        effectiveEvidenceStatus: "definition",
        registeredHandlers: { prompt: ["prompt:F01"] },
        effectiveHandlers: { prompt: ["prompt:F01"], planning: [] },
      }],
    },
  });
  const view = resolveFormulaRuntimeView(definition, reviewedVersion);
  assert.equal(view.state, "handlers_enabled");
  assert.equal(view.effectiveHandlersEnabled, true);
  assert.equal(view.directGenerationMechanism, true);
  assert.equal(view.implementationStatus, "active");
  assert.equal(view.executionClass, "direct-executable");
  assert.equal(view.implementationRuntimeState, "handler-active");
  assert.deepEqual(view.effectiveHandlers, [{ kind: "prompt", handlers: ["prompt:F01"] }]);

  const noHandler = resolveFormulaRuntimeView(formula({
    compatibilityStatus: "reviewed",
    handlerState: "enabled",
    effectiveHandlers: {},
  }));
  assert.equal(noHandler.state, "no_effective_handler");
  assert.equal(noHandler.effectiveHandlersEnabled, false);
});

test("missing runtime DTO metadata remains unknown rather than inferred active", () => {
  const view = resolveFormulaRuntimeView(formula(), version());
  assert.equal(view.state, "unknown");
  assert.equal(view.effectiveHandlersEnabled, false);
  assert.equal(view.directGenerationMechanism, false);
  assert.equal(view.hasServerMetadata, false);
});

test("pending and unreviewed audit collections are honored without formulaTrace", () => {
  const definition = formula();
  const pending = resolveFormulaRuntimeView(definition, version({
    executionAudit: { pendingReviewFormulas: [{ id: "F01" }] },
  }));
  assert.equal(pending.state, "pending_review");
  assert.equal(pending.effectiveHandlersEnabled, false);

  const unreviewed = resolveFormulaRuntimeView(definition, version({
    formulaExecutionAudit: { unreviewedFormulas: [{ id: "F01" }] },
  }));
  assert.equal(unreviewed.state, "unreviewed");
  assert.equal(unreviewed.effectiveHandlersEnabled, false);
});

test("partial diagnostics expose their boundary and stage gap without becoming generation formulas", () => {
  const definition = formula({ id: "F32", type: "proxy", evidenceStatus: "unvalidated" });
  const view = resolveFormulaRuntimeView(definition, version({
    formulas: [definition],
    executionAudit: { formulaTrace: [{
      id: "F32",
      compatibilityStatus: "reviewed",
      handlerState: "enabled",
      implementationStatus: "partial",
      executionClass: "diagnostic-proxy",
      executionRoles: ["diagnostic-proxy"],
      controlMode: "fully-gated",
      implementationRuntimeState: "handler-active",
      disableable: true,
      implementedStages: ["diagnostic"],
      declaredStages: ["diagnostic", "validation"],
      registeredDispatchStages: ["diagnostic"],
      effectiveDispatchStages: ["diagnostic"],
      nonDispatchedStages: ["validation"],
      actualExecution: "Emits ten components-only body diagnostics.",
      implementationBoundary: "No calibrated total quality score exists.",
      codeLocations: ["packages/agent-core/src/parameters.ts"],
      declaredEvidenceStatus: "unvalidated",
      effectiveEvidenceStatus: "unvalidated",
      registeredHandlers: { diagnostic: ["diagnostic:F32"] },
      effectiveHandlers: { diagnostic: ["diagnostic:F32"] },
    }] },
  }));

  assert.equal(view.state, "handlers_enabled");
  assert.equal(view.implementationStatus, "partial");
  assert.equal(view.executionClass, "diagnostic-proxy");
  assert.equal(view.directGenerationMechanism, false);
  assert.deepEqual(view.nonDispatchedStages, ["validation"]);
  assert.match(view.implementationBoundary || "", /No calibrated total quality score/u);
  assert.equal(view.effectiveEvidenceStatus, "unvalidated");
});

test("a conditional calculator can be ready without claiming a result or generation effect", () => {
  const definition = formula({ id: "F17", type: "normative", evidenceStatus: "bounded" });
  const view = resolveFormulaRuntimeView(definition, version({
    formulas: [definition],
    executionAudit: { formulaTrace: [{
      id: "F17",
      compatibilityStatus: "reviewed",
      handlerState: "enabled",
      implementationStatus: "conditional",
      executionClass: "derived-calculator",
      executionRoles: ["conditional-calculator"],
      controlMode: "fully-gated",
      implementationRuntimeState: "calculator-ready",
      disableable: true,
      implementedStages: ["calculation"],
      declaredStages: ["calculation"],
      registeredDispatchStages: ["calculation"],
      effectiveDispatchStages: ["calculation"],
      nonDispatchedStages: [],
      declaredEvidenceStatus: "bounded",
      effectiveEvidenceStatus: "bounded",
      registeredHandlers: { calculator: ["calculator:F17"] },
      effectiveHandlers: { calculator: ["calculator:F17"] },
    }] },
  }));

  assert.equal(view.effectiveHandlersEnabled, true);
  assert.equal(view.implementationRuntimeState, "calculator-ready");
  assert.equal(view.executionClass, "derived-calculator");
  assert.equal(view.directGenerationMechanism, false);
  assert.deepEqual(view.effectiveDispatchStages, ["calculation"]);
});

test("protocols and always-on core mechanisms remain distinct from optional handlers", () => {
  const protocolDefinition = formula({ id: "F15", type: "normative", evidenceStatus: "bounded" });
  const protocol = resolveFormulaRuntimeView(protocolDefinition, version({
    formulas: [protocolDefinition],
    executionAudit: { formulaTrace: [{
      id: "F15",
      compatibilityStatus: "reviewed",
      handlerState: "enabled",
      implementationStatus: "protocol-only",
      executionClass: "protocol",
      executionRoles: ["research-protocol"],
      controlMode: "not-running",
      implementationRuntimeState: "not-running",
      disableable: false,
      implementedStages: [],
      declaredStages: ["evaluation"],
      registeredDispatchStages: [],
      effectiveDispatchStages: [],
      nonDispatchedStages: ["evaluation"],
      declaredEvidenceStatus: "bounded",
      effectiveEvidenceStatus: "bounded",
      registeredHandlers: {},
      effectiveHandlers: {},
    }] },
  }));
  assert.equal(protocol.state, "no_effective_handler");
  assert.equal(protocol.implementationStatus, "protocol-only");
  assert.equal(protocol.implementationRuntimeState, "not-running");
  assert.equal(protocol.directGenerationMechanism, false);

  const alwaysOnDefinition = formula({ id: "F25", type: "normative", evidenceStatus: "bounded" });
  const alwaysOn = resolveFormulaRuntimeView(alwaysOnDefinition, version({
    formulas: [alwaysOnDefinition],
    executionAudit: { formulaTrace: [{
      id: "F25",
      compatibilityStatus: "reviewed",
      handlerState: "disabled",
      implementationStatus: "active",
      executionClass: "direct-executable",
      executionRoles: ["deterministic-mechanism"],
      controlMode: "always-on",
      implementationRuntimeState: "always-on-core-only",
      disableable: false,
      implementedStages: ["validation"],
      declaredStages: ["validation"],
      registeredDispatchStages: [],
      effectiveDispatchStages: [],
      nonDispatchedStages: [],
      declaredEvidenceStatus: "bounded",
      effectiveEvidenceStatus: "bounded",
      registeredHandlers: {},
      effectiveHandlers: {},
    }] },
  }));
  assert.equal(alwaysOn.state, "handlers_disabled");
  assert.equal(alwaysOn.implementationRuntimeState, "always-on-core-only");
  assert.equal(alwaysOn.controlMode, "always-on");
  assert.equal(alwaysOn.effectiveHandlersEnabled, false);
});

test("not-implemented metadata remains visible while all optional execution stays blocked", () => {
  const definition = formula({ id: "F99", evidenceStatus: "unknown" });
  const view = resolveFormulaRuntimeView(definition, version({
    formulas: [definition],
    executionAudit: { formulaTrace: [{
      id: "F99",
      compatibilityStatus: "unreviewed",
      handlerState: "unreviewed",
      implementationStatus: "not-implemented",
      executionClass: "not-implemented",
      executionRoles: [],
      controlMode: "not-running",
      implementationRuntimeState: "not-reviewed",
      disableable: false,
      implementedStages: [],
      declaredStages: [],
      registeredDispatchStages: [],
      effectiveDispatchStages: [],
      nonDispatchedStages: [],
      actualExecution: "No reviewed implementation is registered.",
      implementationBoundary: "Review is required before execution.",
      declaredEvidenceStatus: "unknown",
      effectiveEvidenceStatus: "unreviewed",
      registeredHandlers: {},
      effectiveHandlers: { prompt: ["stale:must-not-run"] },
    }] },
  }));

  assert.equal(view.state, "unreviewed");
  assert.equal(view.implementationStatus, "not-implemented");
  assert.equal(view.implementationRuntimeState, "not-reviewed");
  assert.equal(view.effectiveEvidenceStatus, "unreviewed");
  assert.deepEqual(view.effectiveHandlers, []);
  assert.equal(view.effectiveHandlersEnabled, false);
  assert.equal(view.directGenerationMechanism, false);
});

test("F17 calculator form only serializes explicit inputs and never calculates in the browser", () => {
  const definition = formula({
    id: "F17",
    variables: [
      { path: "regretBefore", description: "阅读前遗憾", valueType: "number", required: true, unitPath: "regretBeforeUnit", unitGroup: "decisionValue" },
      { path: "regretAfter", description: "阅读后遗憾", valueType: "number", required: true, unitPath: "regretAfterUnit", unitGroup: "decisionValue" },
      { path: "cognitiveCost", description: "认知成本", valueType: "number", required: true, unitPath: "cognitiveCostUnit", unitGroup: "decisionValue" },
      { path: "regretBeforeUnit", description: "单位", valueType: "string", required: true },
      { path: "regretAfterUnit", description: "单位", valueType: "string", required: true },
      { path: "cognitiveCostUnit", description: "单位", valueType: "string", required: true },
    ],
  });

  assert.deepEqual(buildFormulaCalculationVariables(definition, {
    regretBefore: "8",
    regretAfter: " 3.5 ",
    cognitiveCost: "",
    regretBeforeUnit: " 同一问卷分 ",
    regretAfterUnit: "同一问卷分",
    cognitiveCostUnit: "",
  }), {
    regretBefore: 8,
    regretAfter: 3.5,
    regretBeforeUnit: "同一问卷分",
    regretAfterUnit: "同一问卷分",
  });
});

test("F21 sends out-of-range and malformed explicit values to the authoritative server validator", () => {
  const definition = formula({
    id: "F21",
    variables: [
      { path: "pExposure", description: "曝光概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "pNoticeGivenExposure", description: "注意条件概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
    ],
  });

  assert.deepEqual(buildFormulaCalculationVariables(definition, {
    pExposure: "1.2",
    pNoticeGivenExposure: "不是数值",
  }), {
    pExposure: 1.2,
    pNoticeGivenExposure: "不是数值",
  });
  assert.equal(calculatorResultLabel("F21", 0.012), "路径情景概率 0.012（1.2%）");
  assert.doesNotMatch(calculatorResultLabel("F21", 0.012), /质量|得分/u);
  assert.equal(calculatorIssueMessage({
    path: "pExposure",
    code: "out_of_range",
    message: "Validation error: F21 pExposure must be within [0, 1].",
  }), "pExposure 超出服务端允许范围；F21 概率必须位于 [0,1]。");
});

test("F30 sends only explicit provenance and three manual inputs without browser calculation or source inference", () => {
  const definition = formula({
    id: "F30",
    calculatorContract: trendFitContract,
    variables: trendFitVariables,
  });
  assert.deepEqual(buildFormulaCalculationVariables(definition, {
    trendSourceKind: "xiaohongshu_hot_discussion",
    trendSourceRef: " 具体热议对象 ",
    sourceObservedAt: "2026-07-14T10:30:00+08:00",
    relevance: "0.8",
    bridgeClarity: "1.2",
    timeliness: "",
    inferredReach: "0.99",
  }), {
    trendSourceKind: "xiaohongshu_hot_discussion",
    trendSourceRef: "具体热议对象",
    sourceObservedAt: "2026-07-14T10:30:00+08:00",
    relevance: 0.8,
    bridgeClarity: 1.2,
  });
  assert.deepEqual(buildFormulaCalculationVariables(definition, {
    trendSourceRef: "   ",
    sourceObservedAt: "",
  }), {
    trendSourceRef: "",
    sourceObservedAt: "",
  });
  assert.equal(calculatorResultLabel("F30", 0.48), "TrendFit 手工情景值 0.48");
  assert.doesNotMatch(calculatorResultLabel("F30", 0.48), /%|触达|概率/u);
  assert.match(calculatorIssueMessage({ path: "bridgeClarity", code: "out_of_range", message: "invalid" }), /F30.*\[0,1\]/u);
  assert.match(calculatorIssueMessage({ path: "trendSourceKind", code: "invalid_value", message: "invalid" }), /来源类型无效/u);
  assert.match(calculatorIssueMessage({ path: "trendSourceRef", code: "empty_value", message: "empty" }), /具体来源对象/u);
  assert.match(calculatorIssueMessage({ path: "sourceObservedAt", code: "empty_value", message: "empty" }), /观察.*时间/u);
  assert.match(calculatorIssueMessage({ path: "trendSourceRef", code: "source_ref_hashtag_only", message: "invalid" }), /不能只写 #标签.*http\(s\).*id:.*title:.*source:/u);
  assert.match(calculatorIssueMessage({ path: "trendSourceRef", code: "source_ref_not_specific", message: "invalid" }), /不够具体.*可回查.*http\(s\)/u);
  assert.match(calculatorIssueMessage({ path: "sourceObservedAt", code: "observed_at_invalid_format", message: "invalid" }), /带秒和时区.*RFC3339.*2026-07-14T10:30:00\+08:00/u);
  assert.match(calculatorIssueMessage({ path: "sourceObservedAt", code: "observed_at_invalid_value", message: "invalid" }), /时间值不合法.*年月日.*时区偏移/u);
});

test("trend source categories require exact reviewed enums and never infer official status from wording", () => {
  assert.equal(resolveTrendSourceView("xiaohongshu_hotspot_rank").type, "xiaohongshu_hotspot_rank");
  assert.match(resolveTrendSourceView("xiaohongshu_hotspot_rank").explanation, /只记录用户声明.*不联网核验官方身份/u);
  assert.equal(resolveTrendSourceView("xiaohongshu_hot_discussion").type, "xiaohongshu_hot_discussion");
  assert.equal(resolveTrendSourceView("other_explicit_source").type, "other_explicit_source");
  assert.equal(resolveTrendSourceView("官方热点榜同款热门标签").type, "unknown");
  assert.equal(resolveTrendSourceView(undefined).type, "unknown");
  assert.match(resolveTrendSourceView(undefined).explanation, /不会.*自动归类/u);
  assert.deepEqual(resolveTrendSourceBadge(resolveTrendSourceView(undefined)), { label: "unknown", formatAccepted: false });
  assert.deepEqual(resolveTrendSourceBadge(resolveTrendSourceView("xiaohongshu_hotspot_rank")), {
    label: "显式声明 / 格式待服务端校验",
    formatAccepted: false,
  });
});

test("TrendFit contract and calculate response must preserve every non-consumption boundary", () => {
  const response: FormulaCalculationResult = {
    formulaVersionId: "v1", formulaVersionDigest: "digest", formulaId: "F30",
    status: "computed", value: 0.4, unit: null, unknownPaths: [], issues: [],
    calculationOnly: true, directGeneration: false,
    consumedBy: { generation: false, planning: false, candidateSelection: false, validation: false, reachPrediction: false },
    resultSemantics: "manual_conditional_calculation",
    boundary: { explicitInputsOnly: true, usesLivePlatformData: false, predictsReach: false, predictsQualifiedReach: false, comparesHotTopicRankings: false },
    calculatorContract: trendFitContract,
  };
  assert.equal(hasCanonicalTrendFitContractShape(trendFitContract), true);
  assert.equal(hasCanonicalTrendFitVariableContract(trendFitVariables), true);
  assert.deepEqual(
    trendSourceOptionsFromAllowedValues(trendFitVariables[0]?.allowedValues).map((option) => option.value),
    ["xiaohongshu_hotspot_rank", "xiaohongshu_hot_discussion", "other_explicit_source"],
  );
  assert.equal(hasCanonicalTrendFitVariableContract([
    ...trendFitVariables,
    { path: "inferredReach", description: "不得出现", valueType: "number", required: false },
  ]), false);
  assert.equal(sameTrendFitContract(trendFitContract, structuredClone(trendFitContract)), true);
  assert.equal(hasAuthoritativeCalculationBoundary(response), true);
  assert.equal(isCalculationBoundToFormulaVersion(response, "F30", { id: "v1", digest: "digest" }), true);
  assert.equal(isCalculationBoundToFormulaVersion(response, "F30", { id: "v1", digest: "stale-digest" }), false);
  assert.equal(isCalculationBoundToFormulaVersion(response, "F30", { id: "v1" }), false);
  assert.equal(isCalculationBoundToFormulaVersion({ ...response, formulaVersionId: "stale-id" }, "F30", { id: "v1", digest: "digest" }), false);
  assert.equal(hasAuthoritativeCalculationBoundary({ ...response, consumedBy: { ...response.consumedBy, reachPrediction: true } } as unknown as FormulaCalculationResult), false);
  assert.equal(hasAuthoritativeCalculationBoundary({ ...response, consumedBy: { ...response.consumedBy, guaranteesReach: true } } as unknown), false);
  assert.equal(hasAuthoritativeCalculationBoundary({ ...response, boundary: { ...response.boundary, usesTrendForGeneration: true } } as unknown), false);
  assert.equal(hasAuthoritativeCalculationBoundary(null), false);
  assert.equal(isCalculationBoundToFormulaVersion(null, "F30", { id: "v1", digest: "digest" }), false);
  assert.equal(hasCanonicalTrendFitContractShape({ ...trendFitContract, excludedResearchOutputs: [] }), false);
  assert.equal(hasCanonicalTrendFitContractShape({ ...trendFitContract, boundaries: [] }), false);
  assert.equal(hasCanonicalTrendFitContractShape({ ...trendFitContract, boundaries: trendFitContract.boundaries.map((item, index) => index === 4 ? "标签保证触达。" : item) }), false);
  assert.equal(hasCanonicalTrendFitContractShape({ ...trendFitContract, excludedResearchOutputs: {} } as unknown), false);
  assert.equal(hasCanonicalTrendFitVariableContract(null), false);
  assert.equal(hasCanonicalTrendFitVariableContract([
    { ...trendFitVariables[0]!, allowedValues: [...(trendFitVariables[0]!.allowedValues || []), "invented_source"] },
    ...trendFitVariables.slice(1),
  ]), false);
  assert.equal(hasCanonicalTrendFitVariableContract(trendFitVariables.map((variable) => variable.path === "trendSourceRef"
    ? { ...variable, format: undefined }
    : variable)), false);
  assert.equal(hasCanonicalTrendFitVariableContract(trendFitVariables.map((variable) => variable.path === "sourceObservedAt"
    ? { ...variable, format: "date" }
    : variable)), false);
  assert.equal(isReviewedTrendFitCalculatorContract(trendFitContract, {
    state: "handlers_enabled", effectiveHandlersEnabled: true, compatibilityStatus: "reviewed", reviewStatus: "approved", handlerState: "enabled", effectiveHandlers: [{ kind: "calculator", handlers: ["calculator:F30"] }],
  }, trendFitVariables), true);
  assert.equal(isReviewedTrendFitCalculatorContract(trendFitContract, {
    state: "pending_review", effectiveHandlersEnabled: false, compatibilityStatus: "pending_review", handlerState: "pending_review", effectiveHandlers: [],
  }, trendFitVariables), false);
  assert.equal(isReviewedTrendFitCalculatorContract(trendFitContract, {
    state: "handlers_enabled", effectiveHandlersEnabled: true, compatibilityStatus: "reviewed", handlerState: "enabled", effectiveHandlers: [{ kind: "calculator", handlers: ["calculator:F17"] }],
  }, trendFitVariables), false);
  assert.equal(isReviewedTrendFitCalculatorContract(trendFitContract, {
    state: "no_effective_handler", effectiveHandlersEnabled: false, compatibilityStatus: "reviewed", reviewStatus: "rejected", handlerState: "enabled", effectiveHandlers: [{ kind: "calculator", handlers: ["calculator:F30"] }],
  }, trendFitVariables), false);
  assert.equal(hasConsistentTrendFitCalculationResult(response), true);
  assert.deepEqual(resolveTrendSourceBadge(resolveTrendSourceView("xiaohongshu_hotspot_rank"), response), {
    label: "格式通过但未联网核验",
    formatAccepted: true,
  });
  assert.equal(hasConsistentTrendFitCalculationResult({ ...response, value: 1.01 }), false);
  assert.equal(hasConsistentTrendFitCalculationResult({ ...response, status: "unknown", value: 0.4 }), false);
  assert.equal(hasConsistentTrendFitCalculationResult({ ...response, unknownPaths: ["timeliness"] }), false);
  assert.equal(hasConsistentTrendFitCalculationResult({
    ...response,
    status: "unknown",
    value: null,
    unknownPaths: ["timeliness"],
    issues: [{ path: "timeliness", code: "required_input_missing", message: "missing" }],
  }), true);
  assert.equal(hasConsistentTrendFitCalculationResult({ ...response, status: "unknown", value: null, unknownPaths: [], issues: [] }), false);
  assert.equal(hasConsistentTrendFitCalculationResult({
    ...response,
    status: "invalid",
    value: null,
    issues: [{ path: "trendSourceKind", code: "invalid_value", message: "invalid" }],
  }), true);
  assert.equal(hasConsistentTrendFitCalculationResult({ ...response, status: "invalid", value: null, issues: [] }), false);
});

test("simple, settings and historical TrendFit views preserve unknown and audit-only boundaries", () => {
  assert.match(TREND_FIT_NON_CONSUMPTION_COPY, /显式手工情景输入.*不参与生成.*触达预测/u);
  assert.match(TREND_FIT_SETTINGS_BOUNDARY_COPY, /公式页.*高级 JSON.*impactReport 审计快照.*不参与生成/u);
  assert.match(TREND_FIT_SIMPLE_BOUNDARY_COPY, /unknown.*不会自动归类.*热点榜.*热议话题.*不保证.*触达.*不参与生成排序/u);

  const unknown = resolveHistoricalTrendFitSnapshot(0.4, undefined);
  assert.equal(unknown.displayValue, null);
  assert.match(`${unknown.summary}${unknown.detail}`, /原始数值不展示.*unknown.*无法.*判断/u);
  const canonical = resolveHistoricalTrendFitSnapshot(0.4, trendFitContract);
  assert.equal(canonical.displayValue, 0.4);
  assert.match(`${canonical.summary}${canonical.detail}`, /合同声明.*禁止.*页面未持有.*不能据此断言/u);
  assert.equal(resolveHistoricalTrendFitSnapshot(1.01, trendFitContract).displayValue, null);
  assert.equal(resolveHistoricalTrendFitSnapshot(0.4, { ...trendFitContract, boundaries: [] }).displayValue, null);
});

test("legacy F30 parameter links are explanatory only and never become TrendFit inputs", () => {
  assert.match(f30ParameterLinkWarning(["F20", "F30"]) || "", /不代表.*生成参数.*TrendFit 输入/u);
  assert.equal(f30ParameterLinkWarning(["F20"]), undefined);
});

test("F19 and F40 remain plan/text-only even when prompt handlers are enabled", () => {
  const runtime = resolveFormulaRuntimeView(formula({
    compatibilityStatus: "reviewed",
    reviewStatus: "approved",
    handlerState: "enabled",
    implementationStatus: "partial",
    executionClass: "direct-executable",
    effectiveDispatchStages: ["planning", "generation"],
    effectiveHandlers: { prompt: ["prompt:F19"] },
  }));
  assert.equal(runtime.effectiveHandlersEnabled, true);

  const f19 = resolveImageFormulaOutputBoundary("F19", runtime);
  assert.equal(f19?.label, "仅完成入口计划 / 文字草稿");
  assert.ok(f19?.absentScope.some((item) => item.includes("最终图片资产 Img")));
  assert.ok(f19?.absentScope.some((item) => item.includes("真实入口截图")));
  assert.match(f19?.detail || "", /Preview 仍是未落实/u);

  const f40 = resolveImageFormulaOutputBoundary("F40", runtime);
  assert.equal(f40?.label, "仅完成多通道计划 / 文本内容包");
  assert.ok(f40?.absentScope.some((item) => item.includes("实际部署")));
  assert.match(f40?.detail || "", /规划对象存在不等于/u);
  assert.equal(resolveImageFormulaOutputBoundary("F01", runtime), undefined);
});

test("historical packages leave unrecorded final image, snapshot and deployment states unknown", () => {
  const view = resolveProductionArtifactView({
    imagePlan: {
      primaryAssetId: "source-legacy-1",
      role: "cover",
      composition: "封面规划文字",
    },
    imageBrief: "文字简报草稿",
    deploymentPlan: { postingIdentity: "author" },
  });

  assert.equal(view.recorded, false);
  assert.equal(view.sourceAssetId, "source-legacy-1");
  assert.equal(view.stages.find((item) => item.id === "imagePlan")?.status, "planned");
  assert.equal(view.stages.find((item) => item.id === "imageBrief")?.status, "drafted");
  assert.equal(view.stages.find((item) => item.id === "finalImageAsset")?.status, "unknown");
  assert.equal(view.stages.find((item) => item.id === "entrySnapshot")?.status, "unknown");
  assert.equal(view.stages.find((item) => item.id === "deployment")?.status, "unknown");
  assert.match(view.stages.find((item) => item.id === "finalImageAsset")?.explanation || "", /无法判断是否存在/u);
  assert.match(view.stages.find((item) => item.id === "deployment")?.explanation || "", /不能推断为已发布或未发布/u);
  assert.ok(view.alignments.every((item) => item.status === "not_evaluated" && item.evaluated === false));

  const noBriefRecord = resolveProductionArtifactView({
    imagePlan: { role: "cover", composition: "只有计划，没有旧版简报字段" },
  });
  const unknownBrief = noBriefRecord.stages.find((item) => item.id === "imageBrief");
  assert.equal(unknownBrief?.status, "unknown");
  assert.match(unknownBrief?.explanation || "", /无法判断是未启用还是未产出/u);
});

test("production ledger exposes plan-to-copy evaluation without inventing final or snapshot evaluation", () => {
  const productionArtifacts = absentProductionArtifacts();
  productionArtifacts.imageObservation = {
    status: "approved",
    sourceAssetId: "source-1",
    analysisAssetIds: ["analysis-1"],
    note: "源素材观察已确认。",
  };
  productionArtifacts.imagePlan = {
    status: "planned",
    sourceAssetId: "source-1",
    note: "图片计划已生成。",
  };
  productionArtifacts.imageBrief = {
    status: "contract_validated",
    note: "计划到文案一致性通过。",
  };
  productionArtifacts.planToCopyAlignment = {
    status: "pass",
    evaluated: true,
    reasons: ["计划锚点均可在文案中找到。"],
    checks: [{ id: "role", status: "pass", reason: "职责一致。", anchors: ["cover"] }],
  };

  const view = resolveProductionArtifactView({ productionArtifacts });
  assert.equal(view.recorded, true);
  assert.equal(view.sourceAssetId, "source-1");
  assert.deepEqual(view.alignments.map((item) => [item.id, item.status, item.evaluated]), [
    ["planToCopyAlignment", "pass", true],
    ["finalAssetAlignment", "not_evaluated", false],
    ["entrySnapshotAlignment", "not_evaluated", false],
  ]);
  assert.equal(view.stages.find((item) => item.id === "finalImageAsset")?.status, "absent");
  assert.equal(view.stages.find((item) => item.id === "entrySnapshot")?.status, "absent");
  assert.equal(view.stages.find((item) => item.id === "deployment")?.status, "not_deployed");
});

test("imageBrief absent stays distinct from disabled and never becomes a draft", () => {
  const productionArtifacts = absentProductionArtifacts();
  productionArtifacts.imageBrief = {
    status: "absent",
    note: "图片简报已启用，但本次没有产出。",
  };
  const view = resolveProductionArtifactView({ productionArtifacts });
  const brief = view.stages.find((item) => item.id === "imageBrief");
  assert.equal(brief?.status, "absent");
  assert.match(brief?.explanation || "", /没有实际产出/u);
});

test("F32/F33 current contracts expose ordered unknown components without a score", () => {
  assert.equal(hasCanonicalDiagnosticContract("F32", F32_DIAGNOSTIC_CONTRACT), true);
  assert.equal(hasCanonicalDiagnosticContract("F33", F33_DIAGNOSTIC_CONTRACT), true);
  assert.equal(CANONICAL_DIAGNOSTIC_FINGERPRINTS.F32, FORMULA_EXECUTION_HANDLER_REGISTRY.F32?.semanticFingerprint);
  assert.equal(CANONICAL_DIAGNOSTIC_FINGERPRINTS.F33, FORMULA_EXECUTION_HANDLER_REGISTRY.F33?.semanticFingerprint);
  assert.equal(hasCanonicalDiagnosticContract("F32", CANONICAL_DIAGNOSTIC_CONTRACTS.F32), true);
  assert.equal(hasCanonicalDiagnosticContract("F33", CANONICAL_DIAGNOSTIC_CONTRACTS.F33), true);

  const report = diagnosticReport("F32", { gapClarity: 90, stateMatch: 75, stageClarity: 75, logicError: 10 });
  assert.equal(hasCanonicalDiagnosticReport(report), true);
  const { warning, ...candidateDiagnostic } = report;
  assert.equal(hasCanonicalDiagnosticReport({
    ...candidateDiagnostic,
    explanation: warning,
    message: warning,
    parameterIds: report.components.map((item) => `body_diagnostic_${item.id}`),
    channels: ["N.imageBrief", "N.title", "N.body"],
  }), true);
  const view = resolveDiagnosticProxyView(report);
  assert.equal(view.contractState, "current");
  assert.equal(view.status, "unknown");
  assert.equal(view.aggregateValue, null);
  assert.equal(view.scoreProduced, false);
  assert.equal(view.components[0]?.id, "gapClarity");
  assert.equal(view.components[1]?.id, "stateMatch");
  assert.equal(view.components[2]?.id, "stageClarity");
  assert.equal(view.components[1]?.manualReviewRank, 2);
  assert.equal(view.components[2]?.manualReviewRank, 2);
  assert.ok(view.components.every((item) => item.status === "unknown" && item.emphasis !== null));
  assert.match(view.summary, /显示顺序.*人工复核.*没有.*总分.*不改变生成/u);
});

test("F32/F33 malformed, custom and historical snapshots fail closed without orphan numbers", () => {
  const report = diagnosticReport("F33", { gapCoverage: 90 });
  assert.equal(hasCanonicalDiagnosticContract("F33", { ...CANONICAL_DIAGNOSTIC_CONTRACTS.F33, scoreProduced: true }), false);
  assert.equal(hasCanonicalDiagnosticContract("F33", { ...CANONICAL_DIAGNOSTIC_CONTRACTS.F33, componentDefinitions: [] }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, score: 92 }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, aggregateValue: 0 }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, formulaSemanticFingerprint: "custom" }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, name: "正文质量93/100" }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, warning: "正文质量93/100" }), false);
  assert.equal(hasCanonicalDiagnosticReport({ ...report, message: report.warning }), false);
  assert.equal(hasCanonicalDiagnosticReport({
    ...report,
    components: report.components.map((item, index) => index === 0 ? { ...item, contractStatus: "current" } : item),
  }), false);
  assert.equal(hasCanonicalDiagnosticReport({
    ...report,
    components: report.components.map((item, index) => index === 0 ? { ...item, value: 0, status: "pass" } : item),
  }), false);

  const historical = resolveDiagnosticProxyView({
    formulaId: "F33",
    name: "评论质量93/100，优秀",
    semantics: "unknown",
    aggregation: "unknown",
    status: "unknown",
    scoreProduced: false,
    aggregateValue: null,
    diagnosticContract: null,
    components: [{ id: "gapCoverage", label: "质量93/100", emphasis: 95, value: 88 }],
  });
  assert.equal(historical.contractState, "unknown");
  assert.equal(historical.aggregateValue, null);
  assert.equal(historical.components[0]?.emphasis, null);
  assert.equal(historical.components[0]?.displayOrder, null);
  assert.equal(historical.name, "F33 历史诊断");
  assert.equal(historical.components[0]?.label, "历史分项 1");
  assert.doesNotMatch(JSON.stringify(historical), /质量93|优秀|gapCoverage/u);
  assert.match(`${historical.summary}${historical.warning}`, /原始数字不显示.*missing 不是 0/u);
});

test("validation readiness is shown only under its exact non-quality heuristic contract", () => {
  const heuristic = {
    schemaVersion: "1.0",
    kind: "validation_issue_count_heuristic",
    semantics: "non_quality_score",
    status: "computed",
    value: 70,
    range: [0, 100],
    inputs: { errorCount: 1, warningCount: 1, errorPenalty: 25, warningPenalty: 5 },
    evidenceStatus: "operational_heuristic",
    calibrated: false,
    predicts: { quality: false, effect: false },
    excludes: { formulaIds: ["F32", "F33"], diagnosticProxies: true, emphasis: true, missingValues: true },
    consumedBy: { generation: false, planning: false, selection: false, validation: false },
  };
  const current = resolveValidationReadinessHeuristic(heuristic, 70);
  assert.equal(current.state, "current");
  assert.equal(current.value, 70);
  assert.match(`${current.label}${current.detail}`, /非质量分.*排除 F32\/F33/u);

  const legacy = resolveValidationReadinessHeuristic(undefined, 88);
  assert.equal(legacy.state, "unknown");
  assert.equal(legacy.value, null);
  assert.match(legacy.detail, /历史 score.*不显示/u);
  assert.equal(resolveValidationReadinessHeuristic(heuristic, 88).value, null);
  assert.equal(resolveValidationReadinessHeuristic({ ...heuristic, predicts: { quality: true, effect: false } }, 70).value, null);
  assert.equal(resolveValidationReadinessHeuristic({ ...heuristic, value: 0 }, 0).value, null);
});
