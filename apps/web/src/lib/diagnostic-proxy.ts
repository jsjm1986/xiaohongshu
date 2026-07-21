import type {
  DiagnosticProxyFormulaId,
  FormulaDiagnosticComponentContract,
  FormulaDiagnosticContract,
  ValidationReadinessHeuristic,
} from "../types.js";

const POSITIVE_BOUNDARY = "没有经过校准的分项观测时状态必须为 unknown；emphasis 不是满足程度、证据或质量值。";
const COST_RISK_BOUNDARY = "没有经过校准的分项观测时状态必须为 unknown；emphasis 不是成本或风险的测量值。";

const component = (
  id: string,
  label: string,
  direction: FormulaDiagnosticComponentContract["direction"],
): FormulaDiagnosticComponentContract => ({
  id,
  label,
  direction,
  evidenceStatus: "unvalidated_proxy",
  sourceRequirement: "calibrated_component_observation",
  boundary: direction === "positive" ? POSITIVE_BOUNDARY : COST_RISK_BOUNDARY,
});

const BODY_COMPONENTS = [
  component("stateMatch", "读者状态匹配", "positive"),
  component("stageClarity", "阶段是否清楚", "positive"),
  component("sceneDiagnosticity", "场景是否帮助判断", "positive"),
  component("traceCredibility", "可感知痕迹是否可信", "positive"),
  component("visualAnchoring", "图文是否互相承接", "positive"),
  component("gapClarity", "信息缺口是否清楚", "positive"),
  component("directInformation", "直接有效信息", "positive"),
  component("cognitiveCost", "阅读认知成本", "cost"),
  component("adSuspicion", "广告怀疑风险", "risk"),
  component("logicError", "逻辑错误风险", "risk"),
];

const COMMENT_COMPONENTS = [
  component("gapCoverage", "残余缺口覆盖", "positive"),
  component("incrementalInformation", "相对正文的新增信息", "positive"),
  component("questionFit", "问题与阶段匹配", "positive"),
  component("answerGrounding", "回答有知识依据", "positive"),
  component("liveness", "问答推进感", "positive"),
  component("routeClarity", "查找和承接清楚", "positive"),
  component("conditionalClarity", "条件与边界清楚", "positive"),
  component("cognitiveCost", "打开与阅读成本", "cost"),
  component("contradiction", "跨通道矛盾风险", "risk"),
  component("overMarketing", "过度营销风险", "risk"),
];

const commonContract = (componentDefinitions: FormulaDiagnosticComponentContract[], finalBoundary: string): FormulaDiagnosticContract => ({
  mode: "display_priority_metadata",
  semantics: "ordered_component_review_metadata",
  aggregation: "components_only",
  evaluationStatus: "not_evaluated",
  aggregateStatus: "unknown",
  aggregateValue: null,
  scoreProduced: false,
  missingDataPolicy: "unknown_not_zero",
  emphasis: {
    range: [0, 100],
    semantics: "display_and_manual_review_priority_only",
    affects: ["display_order", "manual_review_priority"],
    doesNotAffect: [
      "component_value",
      "component_status",
      "threshold",
      "diagnostic_conclusion",
      "generation",
      "planning",
      "selection",
      "validation",
    ],
    tieBreak: "canonical_component_order",
  },
  consumedBy: { generation: false, planning: false, selection: false, validation: false },
  componentDefinitions,
  boundaries: [
    "emphasis 只改变分项显示顺序和人工检查优先级，不改变阈值、分项状态或诊断结论。",
    "当前没有冻结盲评校准观测，所有分项值为 null、状态为 unknown，缺失不得换算为 0。",
    "分项之间没有共同且已标定的量纲，禁止求和、平均、加权或生成 0—100 总分。",
    finalBoundary,
  ],
});

export const CANONICAL_DIAGNOSTIC_CONTRACTS: Readonly<Record<DiagnosticProxyFormulaId, FormulaDiagnosticContract>> = Object.freeze({
  F32: commonContract(BODY_COMPONENTS, "该清单不参与生成、规划、选稿或校验。"),
  F33: commonContract(COMMENT_COMPONENTS, "线程条数、角色数、关键词覆盖和独立硬校验通过数都不是 F33 分项值；该清单不参与生成、规划、选稿或校验。"),
});

/** Updated together with the reviewed Core formula registry. Unknown revisions fail closed. */
export const CANONICAL_DIAGNOSTIC_FINGERPRINTS: Readonly<Record<DiagnosticProxyFormulaId, string>> = Object.freeze({
  F32: "b1e3d133995e6773ff0d89cd389bc384a881d857b4e290dfdbe29711a807c0a9",
  F33: "06b84308f3fd72c8c066ab819b70524a01f56ab922ad2d76d1578e85822fe6f4",
});

const CANONICAL_DIAGNOSTIC_METADATA = {
  F32: {
    name: "正文分项检查清单",
    warning: "正文分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分。",
    parameterPrefix: "body",
    channels: ["N.imageBrief", "N.title", "N.body"],
  },
  F33: {
    name: "评论分项检查清单",
    warning: "评论分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分；线程数和规则通过数不是质量分。",
    parameterPrefix: "comment",
    channels: ["Cref"],
  },
} as const;

const PROXY_REPORT_KEYS = [
  "formulaId", "formulaSemanticFingerprint", "name", "semantics", "status", "evaluationStatus",
  "aggregateValue", "scoreProduced", "evidenceStatus", "aggregation", "components", "warning",
  "diagnosticContract",
] as const;

const CONTENT_DIAGNOSTIC_KEYS = [
  "formulaId", "formulaSemanticFingerprint", "name", "status", "explanation", "semantics",
  "evaluationStatus", "aggregateValue", "scoreProduced", "parameterIds", "channels", "evidenceStatus",
  "aggregation", "components", "diagnosticContract",
] as const;

const COMPONENT_REPORT_KEYS = [
  "id", "label", "emphasis", "displayOrder", "manualReviewRank", "emphasisSemantics", "direction",
  "status", "evaluationStatus", "value", "source", "evidenceStatus", "boundary",
] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const stableJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    const record = asRecord(item);
    if (!record) return item;
    return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
};

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
};

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

export const isDiagnosticProxyFormulaId = (value: unknown): value is DiagnosticProxyFormulaId =>
  value === "F32" || value === "F33";

export const isDiagnosticEmphasisParameterId = (value: unknown): boolean =>
  typeof value === "string" && /^(body|comment)_diagnostic_[A-Za-z][A-Za-z0-9]*$/u.test(value);

export function hasCanonicalDiagnosticContract(
  formulaId: unknown,
  value: unknown,
): value is FormulaDiagnosticContract {
  return isDiagnosticProxyFormulaId(formulaId)
    && stableJson(value) === stableJson(CANONICAL_DIAGNOSTIC_CONTRACTS[formulaId]);
}

const finiteInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

function hasCanonicalComponentReport(
  formulaId: DiagnosticProxyFormulaId,
  value: unknown,
): value is Record<string, unknown>[] {
  if (!Array.isArray(value)) return false;
  const definitions = CANONICAL_DIAGNOSTIC_CONTRACTS[formulaId].componentDefinitions;
  if (value.length !== definitions.length) return false;
  const records = value.map(asRecord);
  if (records.some((item) => !item)) return false;
  const typed = records as Record<string, unknown>[];
  const byId = new Map(typed.map((item) => [item.id, item]));
  if (byId.size !== definitions.length) return false;

  for (const definition of definitions) {
    const item = byId.get(definition.id);
    if (!item
      || !hasExactKeys(item, COMPONENT_REPORT_KEYS)
      || item.label !== definition.label
      || item.direction !== definition.direction
      || item.evidenceStatus !== "unvalidated_proxy"
      || item.boundary !== definition.boundary
      || item.emphasisSemantics !== "display_and_manual_review_priority_only"
      || item.status !== "unknown"
      || item.evaluationStatus !== "not_evaluated"
      || item.value !== null
      || stableJson(item.source) !== stableJson({ kind: "not_observed", reference: null })
      || !finiteInRange(item.emphasis, 0, 100)) return false;
  }

  const ordered = definitions
    .map((definition, canonicalIndex) => ({ canonicalIndex, item: byId.get(definition.id)! }))
    .sort((left, right) => Number(right.item.emphasis) - Number(left.item.emphasis) || left.canonicalIndex - right.canonicalIndex);
  let rank = 0;
  let previousEmphasis: number | undefined;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const emphasis = Number(current.item.emphasis);
    if (previousEmphasis === undefined || emphasis !== previousEmphasis) rank = index + 1;
    if (current.item.displayOrder !== index + 1 || current.item.manualReviewRank !== rank) return false;
    if (typed[index]?.id !== current.item.id) return false;
    previousEmphasis = emphasis;
  }
  return true;
}

export function hasCanonicalDiagnosticReport(value: unknown): boolean {
  const report = asRecord(value);
  if (!report || !isDiagnosticProxyFormulaId(report.formulaId)) return false;
  const formulaId = report.formulaId;
  const metadata = CANONICAL_DIAGNOSTIC_METADATA[formulaId];
  const isProxy = hasExactKeys(report, PROXY_REPORT_KEYS);
  const isContent = hasExactKeys(report, CONTENT_DIAGNOSTIC_KEYS)
    || hasExactKeys(report, [...CONTENT_DIAGNOSTIC_KEYS, "message"]);
  if (!isProxy && !isContent) return false;
  const components = Array.isArray(report.components)
    ? report.components.map(asRecord)
    : [];
  const expectedParameterIds = components.map((item) =>
    `${metadata.parameterPrefix}_diagnostic_${String(item?.id)}`,
  );
  return report.formulaSemanticFingerprint === CANONICAL_DIAGNOSTIC_FINGERPRINTS[formulaId]
    && report.semantics === "ordered_component_review_metadata"
    && report.status === "unknown"
    && report.evaluationStatus === "not_evaluated"
    && report.aggregateValue === null
    && report.scoreProduced === false
    && report.evidenceStatus === "unvalidated_proxy"
    && report.aggregation === "components_only"
    && report.name === metadata.name
    && (isProxy
      ? report.warning === metadata.warning
      : report.explanation === metadata.warning
        && stableJson(report.parameterIds) === stableJson(expectedParameterIds)
        && stableJson(report.channels) === stableJson(metadata.channels)
        && (!Object.hasOwn(report, "message") || report.message === metadata.warning))
    && !("score" in report)
    && hasCanonicalDiagnosticContract(formulaId, report.diagnosticContract)
    && hasCanonicalComponentReport(formulaId, report.components);
}

export interface DiagnosticProxyComponentView {
  id: string;
  label: string;
  direction?: "positive" | "cost" | "risk";
  emphasis: number | null;
  displayOrder: number | null;
  manualReviewRank: number | null;
  status: "unknown";
  evidenceStatus: "unvalidated_proxy" | "unknown";
  boundary: string;
}

export interface DiagnosticProxyView {
  formulaId: DiagnosticProxyFormulaId | "unknown";
  name: string;
  contractState: "current" | "unknown";
  semantics: "ordered_component_review_metadata" | "unknown";
  status: "unknown";
  evaluationStatus: "not_evaluated";
  aggregateValue: null;
  scoreProduced: false;
  evidenceStatus: "unvalidated_proxy" | "unknown";
  components: DiagnosticProxyComponentView[];
  summary: string;
  warning: string;
}

export function resolveDiagnosticProxyView(value: unknown): DiagnosticProxyView {
  const report = asRecord(value);
  const formulaId = isDiagnosticProxyFormulaId(report?.formulaId) ? report.formulaId : "unknown";
  if (report && hasCanonicalDiagnosticReport(report)) {
    return {
      formulaId,
      name: String(report.name),
      contractState: "current",
      semantics: "ordered_component_review_metadata",
      status: "unknown",
      evaluationStatus: "not_evaluated",
      aggregateValue: null,
      scoreProduced: false,
      evidenceStatus: "unvalidated_proxy",
      components: (report.components as Record<string, unknown>[]).map((item) => ({
        id: String(item.id),
        label: String(item.label),
        direction: item.direction as DiagnosticProxyComponentView["direction"],
        emphasis: Number(item.emphasis),
        displayOrder: Number(item.displayOrder),
        manualReviewRank: Number(item.manualReviewRank),
        status: "unknown",
        evidenceStatus: "unvalidated_proxy",
        boundary: String(item.boundary),
      })),
      summary: "emphasis 只决定页面显示顺序与人工复核清单先后；没有分项测量、合格线或总分，也不改变生成与系统校验。",
      warning: typeof report.warning === "string" ? report.warning : String(report.explanation),
    };
  }

  const rawComponents = Array.isArray(report?.components) ? report.components : [];
  return {
    formulaId,
    name: formulaId === "unknown" ? "历史诊断" : `${formulaId} 历史诊断`,
    contractState: "unknown",
    semantics: "unknown",
    status: "unknown",
    evaluationStatus: "not_evaluated",
    aggregateValue: null,
    scoreProduced: false,
    evidenceStatus: "unknown",
    components: rawComponents.slice(0, 10).map((_item, index) => {
      return {
        id: `historical-component-${index + 1}`,
        label: `历史分项 ${index + 1}`,
        direction: undefined,
        emphasis: null,
        displayOrder: null,
        manualReviewRank: null,
        status: "unknown",
        evidenceStatus: "unknown",
        boundary: "历史或自定义合同不匹配；原始 emphasis、分项值和排序语义均不展示。",
      };
    }),
    summary: "合同、公式指纹或必要字段与当前已复核定义不匹配；语义保持 unknown，原始数字不显示。",
    warning: "missing 不是 0；该记录不能生成 0—100 总分，也不能被解释为通过或警告。",
  };
}

export interface ValidationReadinessView {
  state: "current" | "unknown";
  value: number | null;
  label: string;
  detail: string;
}

export function hasCanonicalValidationReadinessHeuristic(value: unknown, legacyScore?: unknown): value is ValidationReadinessHeuristic {
  const item = asRecord(value);
  const inputs = asRecord(item?.inputs);
  if (!item || !inputs) return false;
  const errorCount = inputs.errorCount;
  const warningCount = inputs.warningCount;
  const expected = typeof errorCount === "number" && typeof warningCount === "number"
    ? Math.max(0, 100 - errorCount * 25 - warningCount * 5)
    : Number.NaN;
  return hasOnlyKeys(item, ["schemaVersion", "kind", "semantics", "status", "value", "range", "inputs", "evidenceStatus", "calibrated", "predicts", "excludes", "consumedBy"])
    && hasOnlyKeys(inputs, ["errorCount", "warningCount", "errorPenalty", "warningPenalty"])
    && item.schemaVersion === "1.0"
    && item.kind === "validation_issue_count_heuristic"
    && item.semantics === "non_quality_score"
    && item.status === "computed"
    && finiteInRange(item.value, 0, 100)
    && stableJson(item.range) === stableJson([0, 100])
    && Number.isInteger(errorCount) && Number(errorCount) >= 0
    && Number.isInteger(warningCount) && Number(warningCount) >= 0
    && inputs.errorPenalty === 25
    && inputs.warningPenalty === 5
    && item.value === expected
    && item.evidenceStatus === "operational_heuristic"
    && item.calibrated === false
    && stableJson(item.predicts) === stableJson({ quality: false, effect: false })
    && stableJson(item.excludes) === stableJson({ formulaIds: ["F32", "F33"], diagnosticProxies: true, emphasis: true, missingValues: true })
    && stableJson(item.consumedBy) === stableJson({ generation: false, planning: false, selection: false, validation: false })
    && (legacyScore === undefined || legacyScore === item.value);
}

export function resolveValidationReadinessHeuristic(value: unknown, legacyScore?: unknown): ValidationReadinessView {
  if (!hasCanonicalValidationReadinessHeuristic(value, legacyScore)) {
    return {
      state: "unknown",
      value: null,
      label: "校验启发式：unknown",
      detail: legacyScore === undefined
        ? "没有完整的校验启发式合同，不能补成 0 或质量分。"
        : "历史 score 没有匹配的语义合同，原始数字不显示。",
    };
  }
  return {
    state: "current",
    value: value.value,
    label: `校验问题启发式 ${value.value}/100`,
    detail: `只按 ${value.inputs.errorCount} 个错误与 ${value.inputs.warningCount} 个警告做运维排序；未校准、非质量分，并明确排除 F32/F33。`,
  };
}
