import type { FormulaCalculationIssue, FormulaCalculationResult, FormulaDefinition } from "../types";

export type FormulaCalculatorRawInputs = Record<string, string>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const hasExactKeys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => actual[index] === key);
};

export function isCalculationBoundToFormulaVersion(
  value: unknown,
  formulaId: string,
  version: { id: string; digest?: string },
): boolean {
  const result = asRecord(value);
  return Boolean(result)
    && result!.formulaId === formulaId
    && result!.formulaVersionId === version.id
    && typeof version.digest === "string"
    && version.digest.trim().length > 0
    && result!.formulaVersionDigest === version.digest;
}

/**
 * Converts form text into the calculator request DTO. It intentionally does
 * not enforce ranges, unit comparability, or evaluate the expression: those
 * decisions belong to the reviewed server-side calculator.
 */
export function buildFormulaCalculationVariables(
  formula: FormulaDefinition,
  rawInputs: FormulaCalculatorRawInputs,
): Record<string, number | string | boolean | null> {
  const variables: Record<string, number | string | boolean | null> = {};

  for (const variable of formula.variables ?? []) {
    const wasExplicitlyEdited = Object.prototype.hasOwnProperty.call(rawInputs, variable.path);
    if (!wasExplicitlyEdited) continue;
    const raw = rawInputs[variable.path]?.trim() ?? "";
    if (!raw) {
      // Preserve an explicitly blank non-empty string so the authoritative
      // server can distinguish invalid `empty_value` from an omitted unknown.
      if (variable.valueType === "string" && variable.nonEmpty === true) {
        variables[variable.path] = "";
      }
      continue;
    }

    if (variable.valueType === "number") {
      const value = Number(raw);
      variables[variable.path] = Number.isFinite(value) ? value : raw;
      continue;
    }

    if (variable.valueType === "boolean") {
      variables[variable.path] = raw === "true" ? true : raw === "false" ? false : raw;
      continue;
    }

    variables[variable.path] = raw;
  }
  return variables;
}

export function calculatorResultLabel(formulaId: string, value: number, unit?: string): string {
  if (formulaId === "F21") {
    return `路径情景概率 ${value.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}（${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}%）`;
  }
  if (formulaId === "F17") {
    return `净决策价值情景值 ${value.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ""}`;
  }
  if (formulaId === "F30") {
    return `TrendFit 手工情景值 ${value.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}`;
  }
  return `情景计算值 ${value.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}${unit ? ` ${unit}` : ""}`;
}

export function calculatorIssueMessage(issue: FormulaCalculationIssue): string {
  if (issue.code === "unit_required") return `${issue.path} 的单位不能为空；F17 三个数值必须各自声明同一可比较单位。`;
  if (issue.code === "unit_mismatch") return "三个单位不一致，不能产生 F17 情景结果。";
  if (issue.code === "out_of_range" && ["relevance", "bridgeClarity", "timeliness"].includes(issue.path)) return `${issue.path} 超出服务端允许范围；F30 三个未标定情景输入必须位于 [0,1]。`;
  if (issue.code === "out_of_range") return `${issue.path} 超出服务端允许范围；F21 概率必须位于 [0,1]。`;
  if (issue.code === "required_input_missing") return `${issue.path} 尚未明确提供，结果保持 unknown；系统不会代填或推断。`;
  if (issue.code === "invalid_value" && issue.path === "trendSourceKind") return "trendSourceKind 来源类型无效；只能显式选择小红书热点榜条目、小红书热议话题或其他明确来源。";
  if (issue.code === "empty_value" && issue.path === "trendSourceRef") return "trendSourceRef 必须填写可回查的具体来源对象；待生成标签或空白文字不算来源。";
  if (issue.code === "empty_value" && issue.path === "sourceObservedAt") return "sourceObservedAt 必须填写实际观察来源的时间或快照时间。";
  if (issue.code === "source_ref_hashtag_only") return "trendSourceRef 不能只写 #标签；请填写 http(s) URL，或以 id:、title:、source: 开头的具体引用。";
  if (issue.code === "source_ref_not_specific") return "trendSourceRef 不够具体；请填写可回查且不含用户名密码的绝对 http(s) URL，或以 id:、title:、source:（也可用全角冒号）开头并带具体内容的引用。";
  if (issue.code === "observed_at_invalid_format") return "sourceObservedAt 格式不正确；请填写带秒和时区的 RFC3339 时间，例如 2026-07-14T10:30:00+08:00 或 2026-07-14T02:30:00Z。";
  if (issue.code === "observed_at_invalid_value") return "sourceObservedAt 时间值不合法；请检查真实存在的年月日、时分秒与时区偏移，数字时区不能超过 ±14:00。";
  if (issue.code === "invalid_value") return `${issue.path} 不属于服务端允许的显式取值。`;
  if (issue.code === "empty_value") return `${issue.path} 不能为空。`;
  if (issue.code === "invalid_type") return `${issue.path} 的输入类型不正确，请填写变量说明要求的数值或文字。`;
  if (issue.code === "unknown_variable") return `${issue.path} 不属于这个已复核公式的输入契约。`;
  return issue.message;
}

/** Reject responses that omit any server-owned non-consumption boundary. */
export function hasAuthoritativeCalculationBoundary(value: unknown): value is FormulaCalculationResult {
  const result = asRecord(value);
  const consumedBy = asRecord(result?.consumedBy);
  const boundary = asRecord(result?.boundary);
  const issues = result && Array.isArray(result.issues) ? result.issues.map(asRecord) : undefined;
  const statusValid = result?.status === "computed" || result?.status === "unknown" || result?.status === "invalid";
  return Boolean(result)
    && typeof result!.formulaVersionId === "string"
    && typeof result!.formulaVersionDigest === "string"
    && typeof result!.formulaId === "string"
    && statusValid
    && (result!.value === null || (typeof result!.value === "number" && Number.isFinite(result!.value)))
    && (result!.unit === null || typeof result!.unit === "string")
    && Array.isArray(result!.unknownPaths)
    && result!.unknownPaths.every((path) => typeof path === "string")
    && Boolean(issues)
    && issues!.every((issue) => issue
      && typeof issue.path === "string"
      && typeof issue.code === "string"
      && typeof issue.message === "string")
    && result!.calculationOnly === true
    && result!.directGeneration === false
    && Boolean(consumedBy)
    && hasExactKeys(consumedBy!, ["generation", "planning", "candidateSelection", "validation", "reachPrediction"])
    && consumedBy!.generation === false
    && consumedBy!.planning === false
    && consumedBy!.candidateSelection === false
    && consumedBy!.validation === false
    && consumedBy!.reachPrediction === false
    && result!.resultSemantics === "manual_conditional_calculation"
    && Boolean(boundary)
    && hasExactKeys(boundary!, ["explicitInputsOnly", "usesLivePlatformData", "predictsReach", "predictsQualifiedReach", "comparesHotTopicRankings"])
    && boundary!.explicitInputsOnly === true
    && boundary!.usesLivePlatformData === false
    && boundary!.predictsReach === false
    && boundary!.predictsQualifiedReach === false
    && boundary!.comparesHotTopicRankings === false;
}
