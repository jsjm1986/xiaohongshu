import { createHash } from "node:crypto";

import type {
  DslValidationIssue,
  FormulaDefinition,
  FormulaCalculatorContract,
  FormulaDiagnosticContract,
  FormulaEvaluationResult,
  FormulaExpression,
  FormulaPrimitive,
  FormulaType,
  FormulaVersion,
} from "./types.js";

const SAFE_PATH = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const VALID_OPS = new Set([
  "literal", "var", "not", "negate", "add", "subtract", "multiply", "divide", "min", "max",
  "and", "or", "eq", "ne", "gt", "gte", "lt", "lte", "concat", "clamp", "if", "coalesce",
]);

/** JSON Schema for editor-side validation; validateFormulaDsl remains the security boundary. */
export const FORMULA_EXPRESSION_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $ref: "#/$defs/expression",
  $defs: {
    expression: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "value"],
          properties: { op: { const: "literal" }, value: { type: ["string", "number", "boolean", "null"] } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "path"],
          properties: { op: { const: "var" }, path: { type: "string", minLength: 1, maxLength: 256 } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "arg"],
          properties: { op: { enum: ["not", "negate"] }, arg: { $ref: "#/$defs/expression" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "args"],
          properties: {
            op: { enum: ["add", "subtract", "multiply", "divide", "min", "max", "and", "or", "eq", "ne", "gt", "gte", "lt", "lte", "concat", "coalesce"] },
            args: { type: "array", maxItems: 512, items: { $ref: "#/$defs/expression" } },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "value", "min", "max"],
          properties: {
            op: { const: "clamp" },
            value: { $ref: "#/$defs/expression" },
            min: { $ref: "#/$defs/expression" },
            max: { $ref: "#/$defs/expression" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["op", "condition", "then", "else"],
          properties: {
            op: { const: "if" },
            condition: { $ref: "#/$defs/expression" },
            then: { $ref: "#/$defs/expression" },
            else: { $ref: "#/$defs/expression" },
          },
        },
      ],
    },
  },
};

export interface FormulaValidationOptions {
  maxDepth?: number;
  maxNodes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is FormulaPrimitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

const TREND_SOURCE_REF_PREFIX = /^(id|title|source)\s*[:：]\s*(.*)$/iu;
const ABSOLUTE_HTTP_URL_PREFIX = /^https?:\/\//iu;
const HASHTAG_TOKEN = /#[\p{L}\p{N}_-]+/gu;
const VAGUE_TREND_SOURCE_TERMS = [
  "小红书", "平台", "热点", "热门", "热议", "话题", "榜单", "趋势", "推荐", "unknown", "n-a", "未知", "暂无",
].map((term) => term.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s\p{P}\p{S}_]+/gu, ""));
const VALID_FORMULA_STRING_FORMATS = new Set(["trend_source_ref", "rfc3339_timestamp"]);
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

function isHashtagOnlySourceReference(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  if (!HASHTAG_TOKEN.test(normalized)) return false;
  HASHTAG_TOKEN.lastIndex = 0;
  const remainder = normalized
    .replace(HASHTAG_TOKEN, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  HASHTAG_TOKEN.lastIndex = 0;
  return remainder.length === 0;
}

function normalizedSourceSpecificity(value: string): string {
  HASHTAG_TOKEN.lastIndex = 0;
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(HASHTAG_TOKEN, "")
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
  HASHTAG_TOKEN.lastIndex = 0;
  return normalized;
}

function consistsOnlyOfVagueTrendTerms(value: string): boolean {
  let remaining = normalizedSourceSpecificity(value);
  if (!remaining) return true;
  while (remaining) {
    const term = VAGUE_TREND_SOURCE_TERMS.find((candidate) => remaining.startsWith(candidate));
    if (!term) return false;
    remaining = remaining.slice(term.length);
  }
  return true;
}

function isAbsoluteHttpUrlWithoutUserInfo(value: string): boolean {
  if (!ABSOLUTE_HTTP_URL_PREFIX.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function trendSourceReferenceIssue(value: string): "source_ref_hashtag_only" | "source_ref_not_specific" | undefined {
  const reference = value.normalize("NFKC").trim();
  if (isHashtagOnlySourceReference(reference)) return "source_ref_hashtag_only";
  if (isAbsoluteHttpUrlWithoutUserInfo(reference)) return undefined;

  const declared = reference.match(TREND_SOURCE_REF_PREFIX);
  if (!declared) return "source_ref_not_specific";
  const payload = (declared[2] ?? "").trim();
  if (isHashtagOnlySourceReference(payload)) return "source_ref_hashtag_only";
  if (ABSOLUTE_HTTP_URL_PREFIX.test(payload) && !isAbsoluteHttpUrlWithoutUserInfo(payload)) {
    return "source_ref_not_specific";
  }
  return consistsOnlyOfVagueTrendTerms(payload) ? "source_ref_not_specific" : undefined;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function rfc3339TimestampIssue(value: string): "observed_at_invalid_format" | "observed_at_invalid_value" | undefined {
  const match = value.match(RFC3339_TIMESTAMP);
  if (!match) return "observed_at_invalid_format";

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = month === 2
    ? isLeapYear(year) ? 29 : 28
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const invalidCalendarOrTime = year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59;
  if (invalidCalendarOrTime) return "observed_at_invalid_value";

  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return "observed_at_invalid_value";
    }
  }
  return undefined;
}

function stringFormatValidationWarning(
  formulaId: FormulaDefinition["id"],
  path: string,
  format: "trend_source_ref" | "rfc3339_timestamp",
  value: string,
): string | undefined {
  if (format === "trend_source_ref") {
    const issue = trendSourceReferenceIssue(value);
    if (issue === "source_ref_hashtag_only") {
      return `Validation error: ${formulaId} ${path} [source_ref_hashtag_only] cannot be only one hashtag or a hashtag list; declare a concrete source. This validates only the declaration format and does not verify the source online.`;
    }
    if (issue === "source_ref_not_specific") {
      return `Validation error: ${formulaId} ${path} [source_ref_not_specific] must be an absolute http/https URL without userinfo, or id:/title:/source: (full-width colon allowed) followed by a concrete payload. This validates only the declaration format and does not verify the source online.`;
    }
    return undefined;
  }

  const issue = rfc3339TimestampIssue(value);
  if (issue === "observed_at_invalid_format") {
    return `Validation error: ${formulaId} ${path} [observed_at_invalid_format] must use RFC3339 YYYY-MM-DDTHH:mm:ss(.1-9)?(Z|±HH:mm). This validates only the declared timestamp format and does not verify an observation or query any network.`;
  }
  if (issue === "observed_at_invalid_value") {
    return `Validation error: ${formulaId} ${path} [observed_at_invalid_value] contains an impossible date, time, or timezone offset; numeric offsets cannot exceed ±14:00. This validates only the declared timestamp value and does not verify an observation or query any network.`;
  }
  return undefined;
}

export function validateFormulaDsl(
  expression: unknown,
  options: FormulaValidationOptions = {},
): DslValidationIssue[] {
  const issues: DslValidationIssue[] = [];
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 512;
  let nodes = 0;

  function issue(path: string, code: string, message: string): void {
    issues.push({ path, code, message });
  }

  function visit(value: unknown, path: string, depth: number): void {
    nodes += 1;
    if (nodes > maxNodes) {
      if (!issues.some((item) => item.code === "node_limit")) issue(path, "node_limit", `Formula exceeds ${maxNodes} AST nodes.`);
      return;
    }
    if (depth > maxDepth) {
      issue(path, "depth_limit", `Formula exceeds maximum depth ${maxDepth}.`);
      return;
    }
    if (!isRecord(value)) {
      issue(path, "invalid_node", "Every expression node must be a JSON object.");
      return;
    }
    const op = value.op;
    if (typeof op !== "string" || !VALID_OPS.has(op)) {
      issue(`${path}.op`, "unknown_operator", `Unsupported formula operator: ${String(op)}`);
      return;
    }
    if (op === "literal") {
      if (!isPrimitive(value.value) || (typeof value.value === "number" && !Number.isFinite(value.value))) {
        issue(`${path}.value`, "invalid_literal", "Literal values must be finite JSON primitives.");
      }
      return;
    }
    if (op === "var") {
      if (typeof value.path !== "string" || !SAFE_PATH.test(value.path)) {
        issue(`${path}.path`, "invalid_variable_path", "Variable paths must be dot-separated identifiers.");
      } else if (value.path.split(".").some((part) => UNSAFE_SEGMENTS.has(part))) {
        issue(`${path}.path`, "unsafe_variable_path", "Prototype-related variable paths are forbidden.");
      }
      return;
    }
    if (op === "not" || op === "negate") {
      visit(value.arg, `${path}.arg`, depth + 1);
      return;
    }
    if (op === "clamp") {
      visit(value.value, `${path}.value`, depth + 1);
      visit(value.min, `${path}.min`, depth + 1);
      visit(value.max, `${path}.max`, depth + 1);
      return;
    }
    if (op === "if") {
      visit(value.condition, `${path}.condition`, depth + 1);
      visit(value.then, `${path}.then`, depth + 1);
      visit(value.else, `${path}.else`, depth + 1);
      return;
    }
    if (!Array.isArray(value.args)) {
      issue(`${path}.args`, "missing_arguments", `Operator ${op} requires an args array.`);
      return;
    }
    const exactTwo = new Set(["subtract", "divide", "eq", "ne", "gt", "gte", "lt", "lte"]);
    if (exactTwo.has(op) && value.args.length !== 2) issue(`${path}.args`, "argument_count", `Operator ${op} requires exactly two arguments.`);
    if (!exactTwo.has(op) && op !== "concat" && value.args.length === 0) issue(`${path}.args`, "argument_count", `Operator ${op} requires at least one argument.`);
    value.args.forEach((argument, index) => visit(argument, `${path}.args[${index}]`, depth + 1));
  }

  visit(expression, "$", 0);
  return issues;
}

const UNKNOWN = Symbol("formula_unknown");
type InternalValue = Exclude<FormulaPrimitive, null> | typeof UNKNOWN;

function getOwnPath(context: Record<string, unknown>, path: string): InternalValue {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (UNSAFE_SEGMENTS.has(segment) || !isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return UNKNOWN;
    current = current[segment];
  }
  if (current === null || current === undefined || !isPrimitive(current) || (typeof current === "number" && !Number.isFinite(current))) return UNKNOWN;
  return current;
}

export function evaluateFormula(
  expression: FormulaExpression,
  context: Record<string, unknown>,
  options: FormulaValidationOptions = {},
): FormulaEvaluationResult {
  const validation = validateFormulaDsl(expression, options);
  if (validation.length) throw new Error(`Invalid formula DSL: ${validation.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  const unknownPaths = new Set<string>();
  const warnings: string[] = [];

  function asNumber(value: InternalValue, op: string): number | typeof UNKNOWN {
    if (value === UNKNOWN) return UNKNOWN;
    if (typeof value !== "number") {
      warnings.push(`${op} expected a number but received ${typeof value}.`);
      return UNKNOWN;
    }
    return value;
  }

  function asBoolean(value: InternalValue, op: string): boolean | typeof UNKNOWN {
    if (value === UNKNOWN) return UNKNOWN;
    if (typeof value !== "boolean") {
      warnings.push(`${op} expected a boolean but received ${typeof value}.`);
      return UNKNOWN;
    }
    return value;
  }

  function visit(node: FormulaExpression): InternalValue {
    switch (node.op) {
      case "literal": return node.value === null ? UNKNOWN : node.value;
      case "var": {
        const value = getOwnPath(context, node.path);
        if (value === UNKNOWN) unknownPaths.add(node.path);
        return value;
      }
      case "not": {
        const value = asBoolean(visit(node.arg), "not");
        return value === UNKNOWN ? UNKNOWN : !value;
      }
      case "negate": {
        const value = asNumber(visit(node.arg), "negate");
        return value === UNKNOWN ? UNKNOWN : -value;
      }
      case "if": {
        const condition = asBoolean(visit(node.condition), "if");
        if (condition !== UNKNOWN) return visit(condition ? node.then : node.else);
        const left = visit(node.then);
        const right = visit(node.else);
        return left !== UNKNOWN && left === right ? left : UNKNOWN;
      }
      case "coalesce": {
        for (const argument of node.args) {
          const value = visit(argument);
          if (value !== UNKNOWN) return value;
        }
        return UNKNOWN;
      }
      case "and": {
        let sawUnknown = false;
        for (const argument of node.args) {
          const value = asBoolean(visit(argument), "and");
          if (value === false) return false;
          if (value === UNKNOWN) sawUnknown = true;
        }
        return sawUnknown ? UNKNOWN : true;
      }
      case "or": {
        let sawUnknown = false;
        for (const argument of node.args) {
          const value = asBoolean(visit(argument), "or");
          if (value === true) return true;
          if (value === UNKNOWN) sawUnknown = true;
        }
        return sawUnknown ? UNKNOWN : false;
      }
      case "concat": {
        const values = node.args.map(visit);
        if (values.includes(UNKNOWN)) return UNKNOWN;
        return values.map(String).join("");
      }
      case "eq":
      case "ne": {
        const [left, right] = node.args.map(visit);
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
        return node.op === "eq" ? left === right : left !== right;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const [rawLeft, rawRight] = node.args.map(visit);
        const left = asNumber(rawLeft ?? UNKNOWN, node.op);
        const right = asNumber(rawRight ?? UNKNOWN, node.op);
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
        if (node.op === "gt") return left > right;
        if (node.op === "gte") return left >= right;
        if (node.op === "lt") return left < right;
        return left <= right;
      }
      case "clamp": {
        const value = asNumber(visit(node.value), "clamp");
        const min = asNumber(visit(node.min), "clamp");
        const max = asNumber(visit(node.max), "clamp");
        if (value === UNKNOWN || min === UNKNOWN || max === UNKNOWN) return UNKNOWN;
        if (min > max) {
          warnings.push("clamp minimum exceeds maximum.");
          return UNKNOWN;
        }
        return Math.min(max, Math.max(min, value));
      }
      default: {
        const values = node.args.map(visit);
        const numbers = values.map((value) => asNumber(value, node.op));
        if (numbers.includes(UNKNOWN)) return UNKNOWN;
        const concrete = numbers as number[];
        if (node.op === "add") return concrete.reduce((sum, value) => sum + value, 0);
        if (node.op === "subtract") return (concrete[0] ?? 0) - (concrete[1] ?? 0);
        if (node.op === "multiply") return concrete.reduce((product, value) => product * value, 1);
        if (node.op === "divide") {
          if (concrete[1] === 0) {
            warnings.push("Division by zero produced unknown, not an invented fallback.");
            return UNKNOWN;
          }
          return (concrete[0] ?? 0) / (concrete[1] ?? 1);
        }
        if (node.op === "min") return Math.min(...concrete);
        return Math.max(...concrete);
      }
    }
  }

  const value = visit(expression);
  return { value: value === UNKNOWN ? null : value, unknownPaths: [...unknownPaths].sort(), warnings };
}

/**
 * Evaluates a formula through its reviewed input contract. The JSON AST remains
 * the only arithmetic engine; this layer rejects supplied values that violate
 * declared ranges or comparable-unit requirements instead of clamping or
 * inventing a fallback.
 */
export function evaluateFormulaDefinition(
  formula: FormulaDefinition,
  context: Record<string, unknown>,
  options: FormulaValidationOptions = {},
): FormulaEvaluationResult {
  if (!formula.expression) {
    return {
      value: null,
      unknownPaths: [],
      warnings: [`Validation error: ${formula.id} has no executable expression.`],
      ...(formula.calculatorContract ? { calculatorContract: structuredClone(formula.calculatorContract) } : {}),
    };
  }

  const result = evaluateFormula(formula.expression, context, options);
  const unknownPaths = new Set(result.unknownPaths);
  const warnings = [...result.warnings];
  const unitsByGroup = new Map<string, Array<{ path: string; unit: string }>>();
  let validationFailed = false;

  for (const variable of formula.variables) {
    const value = getOwnPath(context, variable.path);
    if (value === UNKNOWN) {
      if (variable.required) unknownPaths.add(variable.path);
      continue;
    }
    if (typeof value !== variable.valueType) {
      warnings.push(`Validation error: ${formula.id} ${variable.path} must be ${variable.valueType}.`);
      validationFailed = true;
      continue;
    }
    if (variable.nonEmpty && typeof value === "string" && value.trim().length === 0) {
      warnings.push(`Validation error: ${formula.id} ${variable.path} must be a non-empty string.`);
      validationFailed = true;
    }
    if (variable.format && typeof value === "string" && value.trim().length > 0) {
      const warning = stringFormatValidationWarning(formula.id, variable.path, variable.format, value);
      if (warning) {
        warnings.push(warning);
        validationFailed = true;
      }
    }
    if (variable.allowedValues && !variable.allowedValues.some((allowed) => Object.is(allowed, value))) {
      warnings.push(`Validation error: ${formula.id} ${variable.path} must be one of ${variable.allowedValues.map((allowed) => JSON.stringify(allowed)).join(", ")}.`);
      validationFailed = true;
    }
    if (typeof value === "number") {
      if (variable.minimum !== undefined && value < variable.minimum) {
        warnings.push(`Validation error: ${formula.id} ${variable.path} must be within [${variable.minimum}, ${variable.maximum ?? "∞"}].`);
        validationFailed = true;
      }
      if (variable.maximum !== undefined && value > variable.maximum) {
        warnings.push(`Validation error: ${formula.id} ${variable.path} must be within [${variable.minimum ?? "−∞"}, ${variable.maximum}].`);
        validationFailed = true;
      }
      if (variable.unitPath && variable.unitGroup) {
        const rawUnit = getOwnPath(context, variable.unitPath);
        if (rawUnit === UNKNOWN) {
          unknownPaths.add(variable.unitPath);
        } else if (typeof rawUnit !== "string" || rawUnit.trim().length === 0) {
          warnings.push(`Validation error: ${formula.id} ${variable.unitPath} must be a non-empty comparable unit.`);
          validationFailed = true;
        } else {
          const units = unitsByGroup.get(variable.unitGroup) ?? [];
          units.push({ path: variable.unitPath, unit: rawUnit.trim() });
          unitsByGroup.set(variable.unitGroup, units);
        }
      }
    }
  }

  for (const [group, units] of unitsByGroup) {
    const distinctUnits = [...new Set(units.map((item) => item.unit))];
    if (distinctUnits.length > 1) {
      warnings.push(`Validation error: ${formula.id} ${group} inputs must use one comparable unit; received ${distinctUnits.map((unit) => JSON.stringify(unit)).join(", ")}.`);
      validationFailed = true;
    }
  }

  return {
    value: validationFailed || unknownPaths.size > 0 ? null : result.value,
    unknownPaths: [...unknownPaths].sort(),
    warnings: [...new Set(warnings)],
    ...(formula.calculatorContract ? { calculatorContract: structuredClone(formula.calculatorContract) } : {}),
  };
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function formulaVersionDigest(version: Omit<FormulaVersion, "digest">): string {
  return createHash("sha256").update(canonicalize(version), "utf8").digest("hex");
}

export function createFormulaVersion(input: Omit<FormulaVersion, "digest">): FormulaVersion {
  // Formula versions are persisted as JSON. Normalize away optional `undefined`
  // properties before hashing so a JSON round-trip cannot invalidate the digest.
  const normalized = JSON.parse(JSON.stringify(input)) as Omit<FormulaVersion, "digest">;
  const issues = validateFormulaVersion({ ...normalized, digest: "" });
  if (issues.length) throw new Error(`Invalid formula version: ${issues.map((item) => item.message).join("; ")}`);
  return { ...normalized, digest: formulaVersionDigest(normalized) };
}

const DIAGNOSTIC_CONTRACT_KEYS = [
  "mode", "semantics", "aggregation", "evaluationStatus", "aggregateStatus", "aggregateValue",
  "scoreProduced", "missingDataPolicy", "emphasis", "consumedBy", "componentDefinitions", "boundaries",
] as const;
const DIAGNOSTIC_EMPHASIS_KEYS = ["range", "semantics", "affects", "doesNotAffect", "tieBreak"] as const;
const DIAGNOSTIC_COMPONENT_KEYS = ["id", "label", "direction", "evidenceStatus", "sourceRequirement", "boundary"] as const;
const DIAGNOSTIC_CONSUMER_KEYS = ["generation", "planning", "selection", "validation"] as const;
const BODY_DIAGNOSTIC_COMPONENT_IDS = [
  "stateMatch", "stageClarity", "sceneDiagnosticity", "traceCredibility", "visualAnchoring",
  "gapClarity", "directInformation", "cognitiveCost", "adSuspicion", "logicError",
] as const;
const COMMENT_DIAGNOSTIC_COMPONENT_IDS = [
  "gapCoverage", "incrementalInformation", "questionFit", "answerGrounding", "liveness",
  "routeClarity", "conditionalClarity", "cognitiveCost", "contradiction", "overMarketing",
] as const;

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function sameLiteralArray(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function validateDiagnosticContractShape(
  value: unknown,
  formulaId: FormulaDefinition["id"],
  path: string,
): DslValidationIssue[] {
  const issues: DslValidationIssue[] = [];
  const reject = (suffix: string, code: string, message: string): void => {
    issues.push({ path: `${path}${suffix}`, code, message });
  };
  if (formulaId !== "F32" && formulaId !== "F33") {
    reject("", "diagnostic_contract_wrong_formula", "A diagnosticContract is currently valid only for F32 or F33.");
    return issues;
  }
  if (!isRecord(value) || !hasExactKeys(value, DIAGNOSTIC_CONTRACT_KEYS)) {
    reject("", "invalid_diagnostic_contract_shape", "diagnosticContract must contain only the reviewed contract fields.");
    return issues;
  }
  const exactLiterals: Array<[keyof typeof value, unknown]> = [
    ["mode", "display_priority_metadata"],
    ["semantics", "ordered_component_review_metadata"],
    ["aggregation", "components_only"],
    ["evaluationStatus", "not_evaluated"],
    ["aggregateStatus", "unknown"],
    ["aggregateValue", null],
    ["scoreProduced", false],
    ["missingDataPolicy", "unknown_not_zero"],
  ];
  for (const [key, expected] of exactLiterals) {
    if (value[key] !== expected) reject(`.${String(key)}`, "invalid_diagnostic_contract_literal", `diagnosticContract.${String(key)} must be ${JSON.stringify(expected)}.`);
  }
  const emphasis = value.emphasis;
  if (!isRecord(emphasis) || !hasExactKeys(emphasis, DIAGNOSTIC_EMPHASIS_KEYS)) {
    reject(".emphasis", "invalid_diagnostic_emphasis_shape", "diagnosticContract.emphasis must contain only the reviewed emphasis fields.");
  } else {
    if (!sameLiteralArray(emphasis.range, [0, 100])) reject(".emphasis.range", "invalid_diagnostic_emphasis_range", "Diagnostic emphasis range must be exactly [0,100].");
    if (emphasis.semantics !== "display_and_manual_review_priority_only") reject(".emphasis.semantics", "invalid_diagnostic_emphasis_semantics", "Diagnostic emphasis is display and manual-review priority metadata only.");
    if (!sameLiteralArray(emphasis.affects, ["display_order", "manual_review_priority"])) reject(".emphasis.affects", "invalid_diagnostic_emphasis_effects", "Diagnostic emphasis may affect only display order and manual-review priority.");
    if (!sameLiteralArray(emphasis.doesNotAffect, ["component_value", "component_status", "threshold", "diagnostic_conclusion", "generation", "planning", "selection", "validation"])) reject(".emphasis.doesNotAffect", "invalid_diagnostic_emphasis_boundaries", "Diagnostic emphasis non-effects must remain explicit and complete.");
    if (emphasis.tieBreak !== "canonical_component_order") reject(".emphasis.tieBreak", "invalid_diagnostic_tie_break", "Equal emphasis values must use canonical component order.");
  }
  const consumedBy = value.consumedBy;
  if (!isRecord(consumedBy) || !hasExactKeys(consumedBy, DIAGNOSTIC_CONSUMER_KEYS)
    || DIAGNOSTIC_CONSUMER_KEYS.some((consumer) => consumedBy[consumer] !== false)) {
    reject(".consumedBy", "invalid_diagnostic_consumers", "F32/F33 component metadata must not be consumed by generation, planning, selection, or validation.");
  }
  const expectedIds = formulaId === "F32" ? BODY_DIAGNOSTIC_COMPONENT_IDS : COMMENT_DIAGNOSTIC_COMPONENT_IDS;
  const definitions = value.componentDefinitions;
  if (!Array.isArray(definitions) || definitions.length !== expectedIds.length) {
    reject(".componentDefinitions", "invalid_diagnostic_components", `diagnosticContract for ${formulaId} must define exactly ${expectedIds.length} components.`);
  } else {
    const seen = new Set<string>();
    definitions.forEach((component, index) => {
      const componentPath = `.componentDefinitions[${index}]`;
      if (!isRecord(component) || !hasExactKeys(component, DIAGNOSTIC_COMPONENT_KEYS)) {
        reject(componentPath, "invalid_diagnostic_component_shape", "Each diagnostic component must contain only id, label, direction, evidenceStatus, sourceRequirement, and boundary.");
        return;
      }
      if (typeof component.id !== "string" || !(expectedIds as readonly string[]).includes(component.id) || seen.has(component.id)) {
        reject(`${componentPath}.id`, "invalid_diagnostic_component_id", `Diagnostic component IDs must be the unique reviewed ${formulaId} component IDs.`);
      } else {
        seen.add(component.id);
      }
      if (typeof component.label !== "string" || !component.label.trim()) reject(`${componentPath}.label`, "invalid_diagnostic_component_label", "Diagnostic component labels must be non-empty strings.");
      if (component.direction !== "positive" && component.direction !== "cost" && component.direction !== "risk") reject(`${componentPath}.direction`, "invalid_diagnostic_component_direction", "Diagnostic component direction must be positive, cost, or risk.");
      if (component.evidenceStatus !== "unvalidated_proxy") reject(`${componentPath}.evidenceStatus`, "invalid_diagnostic_component_evidence", "Diagnostic component evidenceStatus must remain unvalidated_proxy.");
      if (component.sourceRequirement !== "calibrated_component_observation") reject(`${componentPath}.sourceRequirement`, "invalid_diagnostic_component_source", "Diagnostic values require a calibrated component observation.");
      if (typeof component.boundary !== "string" || !component.boundary.trim()) reject(`${componentPath}.boundary`, "invalid_diagnostic_component_boundary", "Diagnostic component boundaries must be non-empty strings.");
    });
    if (seen.size !== expectedIds.length) reject(".componentDefinitions", "incomplete_diagnostic_components", `diagnosticContract for ${formulaId} must contain every reviewed component ID exactly once.`);
  }
  if (!Array.isArray(value.boundaries) || value.boundaries.length === 0
    || value.boundaries.some((boundary) => typeof boundary !== "string" || !boundary.trim())) {
    reject(".boundaries", "invalid_diagnostic_boundaries", "diagnosticContract boundaries must be a non-empty array of non-empty strings.");
  }
  return issues;
}

export function validateFormulaVersion(version: FormulaVersion): DslValidationIssue[] {
  const issues: DslValidationIssue[] = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version.version)) {
    issues.push({ path: "$.version", code: "invalid_version", message: "Formula version must be semantic version text." });
  }
  const ids = new Set<string>();
  version.formulas.forEach((formula, index) => {
    if (!/^F\d{2,}$/u.test(formula.id)) issues.push({ path: `$.formulas[${index}].id`, code: "invalid_formula_id", message: "Formula IDs use F followed by at least two digits." });
    if (ids.has(formula.id)) issues.push({ path: `$.formulas[${index}].id`, code: "duplicate_formula_id", message: `Duplicate formula ID ${formula.id}.` });
    ids.add(formula.id);
    if (formula.expression) {
      issues.push(...validateFormulaDsl(formula.expression).map((issue) => ({ ...issue, path: `$.formulas[${index}].expression${issue.path.slice(1)}` })));
    }
    const diagnosticContract = (formula as { diagnosticContract?: unknown }).diagnosticContract;
    if (diagnosticContract !== undefined) {
      issues.push(...validateDiagnosticContractShape(diagnosticContract, formula.id, `$.formulas[${index}].diagnosticContract`));
    }
    formula.variables.forEach((variable, variableIndex) => {
      const format = (variable as { format?: unknown }).format;
      const formatPath = `$.formulas[${index}].variables[${variableIndex}].format`;
      if (format !== undefined && (typeof format !== "string" || !VALID_FORMULA_STRING_FORMATS.has(format))) {
        issues.push({
          path: formatPath,
          code: "unknown_variable_format",
          message: "Formula variable format must be trend_source_ref or rfc3339_timestamp.",
        });
      } else if (format !== undefined && variable.valueType !== "string") {
        issues.push({
          path: formatPath,
          code: "format_requires_string",
          message: "Formula variable format can only be used with string variables.",
        });
      }
    });
  });
  if (version.digest) {
    const { digest: _digest, ...unsigned } = version;
    if (formulaVersionDigest(unsigned) !== version.digest) {
      issues.push({ path: "$.digest", code: "digest_mismatch", message: "Formula version content no longer matches its immutable digest." });
    }
  }
  return issues;
}

export function deriveCandidateSeed(baseSeed: number, formulaDigest: string, jobId: string, candidateIndex: number): number {
  const hash = createHash("sha256").update(`${baseSeed}:${formulaDigest}:${jobId}:${candidateIndex}`, "utf8").digest();
  return hash.readUInt32BE(0) & 0x7fffffff;
}

interface FormulaSeedRow {
  id: FormulaDefinition["id"];
  title: string;
  type: FormulaType;
  equation: string;
  purpose: string;
}

const FORMULA_ROWS: FormulaSeedRow[] = [
  { id: "F01", title: "完整文案装配式", type: "architecture", equation: "Ucopy = Render(WIinst, ψ) = H ⊕ N ⊕ Cref", purpose: "规定生成对象" },
  { id: "F02", title: "稿件、执行计划与线上现实", type: "architecture", equation: "Uplan=(Ucopy,aC); Ureal,t=(Uplan,ξt,Cuser,t)", purpose: "分开设计、执行和现实" },
  { id: "F03", title: "评论三对象不可混用", type: "architecture", equation: "Cref ≠ aC ≠ Cuser,t", purpose: "避免把问答参考当作真实口碑" },
  { id: "F04", title: "信息补全窗口", type: "architecture", equation: "WI=(G,Ans,E,Φ,Priority,Boundary)", purpose: "决定补什么" },
  { id: "F05", title: "表达补全窗口", type: "architecture", equation: "WX=(Channel,Form,Voice,Sequence,Thread)", purpose: "决定怎样补" },
  { id: "F06", title: "信息卡与知识可行域", type: "normative", equation: "WIinst={xi}⊆Feasible(KBt)", purpose: "阻止无依据生成" },
  { id: "F07", title: "图文联合对象", type: "architecture", equation: "N=(Img,Ttitle,B)", purpose: "联合看图、标题和正文" },
  { id: "F08", title: "跨通道边际比较", type: "hypothesis", equation: "Vmcompare=E[q(Um←x)-q(U-x)]", purpose: "比较同一信息放在哪里" },
  { id: "F09", title: "正文后的残余缺口", type: "architecture", equation: "Gres=Gdecision\\Resolve(H⊕N)", purpose: "找出仍需回答的问题" },
  { id: "F10", title: "评论关系网策略与展开", type: "architecture", equation: "Cref=Rollout(ρC|Role×Scene×Register×Topology×Gap)", purpose: "生成有角色、有触发和有分支的评论关系网" },
  { id: "F11", title: "评论部署与实际可见", type: "architecture", equation: "Cref — Deploy(aC,t) → Crefvis(t)", purpose: "区分设计稿和实际可见内容" },
  { id: "F12", title: "入口条件化写作情景", type: "hypothesis", equation: "Sscenario=Hypothesize(entry,stage;preContactKnown?,history?)", purpose: "按入口与阶段组织可修正情景，不估计人群分布" },
  { id: "F13", title: "未标定状态假设", type: "hypothesis", equation: "ŝscenario=(stage,hypothesizedGaps,preContactKnown?,readerConstraints?,history?)", purpose: "用定性等级调节表达，不诊断真实心理" },
  { id: "F14", title: "虚假闭合", type: "hypothesis", equation: "FalseClosure=Σ wj max(0,Gobj-Ĝ)", purpose: "识别更确信却更可能出错" },
  { id: "F15", title: "固定终点决策遗憾", type: "normative", equation: "LT★=当前决策期望损失-可行最小损失", purpose: "用真值标准定义用户价值" },
  { id: "F16", title: "状态转移与遗憾变化", type: "normative", equation: "ΔLT★=LT★(before)-LT★(after)", purpose: "记录内容改善或恶化判断" },
  { id: "F17", title: "净决策价值", type: "normative", equation: "V*=regretBefore-regretAfter-cognitiveCost", purpose: "用减损而非成交定义价值" },
  { id: "F18", title: "图文离线代理", type: "proxy", equation: "V̂N=ΔL̂-CogCost-AdRisk-λΔFalseClosure", purpose: "数据不足时分项诊断" },
  { id: "F19", title: "入口草稿与真实预览", type: "architecture", equation: "EntryDraft=Plan(ImagePlan,ImageBrief,Ttitle,Tags,Excerpt|r); PreviewObserved=Observe(FinalImg,Ttitle,VisibleTags,Excerpt|EntrySnapshot,r)", purpose: "分开入口制作合同与实际入口观察" },
  { id: "F20", title: "离线完整稿代理", type: "proxy", equation: "Q̂gen=RouteFit̂·[V̂N+P̂open·Q̂C]", purpose: "发布前做情景比较" },
  { id: "F21", title: "顺序路径概率", type: "architecture", equation: "Ppath=pExposure·pNoticeGivenExposure·pEnterGivenNotice·pConsumeGivenEnter", purpose: "保留路径各环节损耗" },
  { id: "F22", title: "评论被找到后的价值", type: "hypothesis", equation: "V̂Cread=Needs·Pfind·InformationValue-Costopen-Clutter", purpose: "纳入打开、找到和杂乱成本" },
  { id: "F23", title: "消费后总价值", type: "hypothesis", equation: "Vafter=V̂N+Popen·[V̂Cread+ΔV̂Creal+Pparticipate·V̂Cinteract]", purpose: "分开图文、FAQ、真实评论与互动" },
  { id: "F24", title: "入口状态价值均值", type: "architecture", equation: "Ir=Es∼π⁻r,t[qr(Uplan|s,ξ)]", purpose: "在同一送达前人群上比较" },
  { id: "F25", title: "硬约束集合", type: "normative", equation: "Uplan∈Ω(KBt)", purpose: "让违规候选无法被效果抵消" },
  { id: "F26", title: "联合候选空间", type: "architecture", equation: "X=WI×Ψ(WX)×AC", purpose: "联合枚举信息、表达和承接" },
  { id: "F27", title: "鲁棒最大最小选择", type: "normative", equation: "x*=arg maxx minϑ Ĵr(x;ϑ)", purpose: "不依赖单一乐观参数选稿" },
  { id: "F28", title: "竞争信息机会", type: "proxy", equation: "Opportunity=Proofable·Demand·Importance·(1-Coverage)·Leverage/(e+CogCost)", purpose: "寻找重要、可证、未讲清的缺口" },
  { id: "F29", title: "相对竞争优势", type: "hypothesis", equation: "Advantage=Eq[max portfolio Iq-max competitor Iq]", purpose: "有完整竞品数据后比较前沿" },
  { id: "F30", title: "热点匹配手工情景", type: "proxy", equation: "TrendFit=Relevance·BridgeClarity·Timeliness", purpose: "手工检查已命名热点对象与内容之间的相关性、桥接清晰度和时效性；不计算触达" },
  { id: "F31", title: "热点净机会", type: "proxy", equation: "TrendOpportunity=qualifiedReach·value-RiskCost-ExpiryCost", purpose: "扣除错位、规则和过期成本" },
  { id: "F32", title: "正文分项检查清单", type: "proxy", equation: "BodyReview=OrderForReview({componentᵢ}); missing sourceᵢ ⇒ statusᵢ=unknown", purpose: "按显示与人工检查优先级排列正文分项，不计算总分" },
  { id: "F33", title: "评论分项检查清单", type: "proxy", equation: "CommentReview=OrderForReview({componentᵢ}); missing sourceᵢ ⇒ statusᵢ=unknown", purpose: "按显示与人工检查优先级排列问答分项，不计算总分" },
  { id: "F34", title: "证据原始值与来源聚合", type: "architecture", equation: "Eeff=AggregateBySource({eraw},SourceRole,SourceDependence)", purpose: "防止同源重复冒充独立证据" },
  { id: "F35", title: "合格行动与总决策价值", type: "hypothesis", equation: "ExpectedQualifiedActions=Σ AudienceMass·Ppath·Pqualified", purpose: "分开业务目标和用户目标" },
  { id: "F36", title: "知识台账更新", type: "architecture", equation: "KBt+1=Update(KBt,Observations)", purpose: "让真实观测进入下一轮" },
  { id: "F37", title: "问题形成与2×2位置实验", type: "validation", equation: "GapSpecificity(high/low) × AnswerLocation(body/comment FAQ)", purpose: "把假设升级或推翻" },
  { id: "F38", title: "行业信息空间枚举", type: "architecture", equation: "IndustrySpace=Enumerate(DomainNoun,DomainPrior,KBt,Constraints)", purpose: "从项目名词与行业先验广泛发现问题空间；知识库只提供项目事实、特色与边界，行业先验保持推理或假设身份" },
  { id: "F39", title: "可行选题机会集", type: "normative", equation: "Ofeasible={o∈O:Proofable(o)∧Relevant(o)∧Ω(o)}", purpose: "先过滤无依据、低相关或违反边界的选题" },
  { id: "F40", title: "多模态编排草稿与落实", type: "architecture", equation: "OrchDraft=Plan(H,ImagePlan,ImageBrief,T,B,Cref,DeploymentPlan|o,s,KBt); OrchRealized requires FinalImg∧DeploymentObserved", purpose: "把编排草稿与最终图片、实际部署的落实状态分开" },
  { id: "F41", title: "情景状态种子合同", type: "hypothesis", equation: "sseed=(entry,stage,preContactKnown,availableEvidence,hypothesizedGaps,readerConstraints,availableBoundaries,history,status=hypothesis)", purpose: "显式分开用户提供信息、项目证据、未知历史与写作假设" },
  { id: "F42", title: "受控结构采样", type: "architecture", equation: "(O1,O2,O3)=SampleControlled(Ofeasible,seed,diversity)", purpose: "围绕同一选题生成三套结构不同而事实一致的编排" },
  { id: "F43", title: "内容覆盖签名", type: "architecture", equation: "σ(U)=Hash(topic,gaps,allocation,strategy,imageRole)", purpose: "记录已覆盖的选题、缺口和结构并降低近期重复" },
];

export const FORMULA_EXECUTION_STAGES = [
  "configuration",
  "calculation",
  "generation",
  "planning",
  "binding",
  "diagnostic",
  "evaluation",
  "validation",
  "knowledge-update",
] as const;

export type FormulaExecutionStage = typeof FORMULA_EXECUTION_STAGES[number];

export interface FormulaExecutionOwnership {
  formulaId: FormulaDefinition["id"];
  /** Stages in which the current code realizes at least part of this exact equation. */
  stages: FormulaExecutionStage[];
  /** Methodology stages claimed by the formula, including stages not yet wired. */
  declaredStages: FormulaExecutionStage[];
  /** Declared stages with no registered, disableable dispatcher. */
  nonDispatchedStages: FormulaExecutionStage[];
  /** Only these formulas may be rendered as direct instructions to the drafting model. */
  directGenerationInstruction: boolean;
  implementationStatus: FormulaImplementationStatus;
  executionClass: FormulaExecutionClass;
  executionRoles: FormulaExecutionRole[];
  /** Whether formula enablement can stop the full reviewed implementation. */
  disableable: boolean;
  controlMode: FormulaControlMode;
  dataRequirement: string;
  actualExecution: string;
  implementationBoundary: string;
  codeLocations: string[];
}

export type FormulaImplementationStatus = "active" | "partial" | "conditional" | "protocol-only" | "not-implemented";
export type FormulaExecutionClass =
  | "direct-executable"
  | "derived-calculator"
  | "diagnostic-proxy"
  | "protocol"
  | "hypothesis"
  | "not-implemented";
export type FormulaExecutionRole =
  | "direct-generation"
  | "parameter-guidance"
  | "conditional-calculator"
  | "diagnostic-proxy"
  | "deterministic-mechanism"
  | "research-protocol";
export type FormulaControlMode = "fully-gated" | "partially-gated" | "always-on" | "not-running";

export const FORMULA_HANDLER_KINDS = [
  "parameter",
  "calculator",
  "planning",
  "prompt",
  "binder",
  "validator",
  "diagnostic",
  "evaluation",
  "knowledge-update",
] as const;

export type FormulaHandlerKind = typeof FORMULA_HANDLER_KINDS[number];
export type FormulaHandlerCompatibilityStatus = "reviewed" | "pending_review" | "unreviewed";
export type FormulaHandlerState = "enabled" | "disabled" | "pending_review" | "unreviewed";

export interface FormulaExecutionHandlerRegistration extends FormulaExecutionOwnership {
  semanticFingerprint: string;
  /** @deprecated Alias retained for persisted 2.0 audit readers. */
  equationFingerprint: string;
  reviewedEquation: string;
  reviewedEvidenceStatus: FormulaDefinition["evidenceStatus"];
  handlers: Readonly<Record<FormulaHandlerKind, readonly string[]>>;
}

export interface FormulaExecutionResolution {
  formulaId: FormulaDefinition["id"];
  semanticFingerprint: string;
  /** @deprecated Alias retained for persisted 2.0 audit readers. */
  equationFingerprint: string;
  compatibilityStatus: FormulaHandlerCompatibilityStatus;
  handlerState: FormulaHandlerState;
  requestedEnabled: boolean;
  effectiveEvidenceStatus: FormulaDefinition["evidenceStatus"] | "unreviewed";
  registration?: FormulaExecutionHandlerRegistration;
  effectiveHandlers: Readonly<Record<FormulaHandlerKind, readonly string[]>>;
}

export interface HardSafetyInvariant {
  id: string;
  title: string;
  disableable: false;
  relatedFormulaIds: readonly FormulaDefinition["id"][];
  handlers: readonly string[];
}

export interface FormulaStageDefinition {
  stage: FormulaExecutionStage;
  executor: string;
  execution: string;
}

export const FORMULA_STAGE_DEFINITIONS: readonly FormulaStageDefinition[] = [
  { stage: "configuration", executor: "parameter-compiler", execution: "Compiles a user-visible parameter into bounded drafting guidance. A parameter link is not proof that the linked equation itself has been calculated." },
  { stage: "calculation", executor: "safe-formula-calculator", execution: "Evaluates a reviewed JSON-AST only when every required variable is supplied. The result remains a scenario calculation unless another stage explicitly consumes it." },
  { stage: "generation", executor: "drafting-model", execution: "The drafting model directly applies the formula to the current H/N/Cref package." },
  { stage: "planning", executor: "deterministic-planner", execution: "Executed before drafting through topic, gap, strategy, state, image, and channel orchestration; the model receives the result, not the formula as a law." },
  { stage: "binding", executor: "post-draft-binder", execution: "Binds generated fields back to an approved plan. No formula currently has a disableable binder dispatcher." },
  { stage: "diagnostic", executor: "post-draft-diagnostics", execution: "Emits reviewed component metadata after a draft. Without a calibrated component source, value remains null and status remains unknown; emphasis may order display/manual review only and never changes thresholds, conclusions, or drafting." },
  { stage: "evaluation", executor: "offline-evaluator", execution: "Used only when the required observations exist for comparison or experiments; hypotheses stay unvalidated until evidence is collected." },
  { stage: "validation", executor: "deterministic-validator", execution: "Enforced after drafting as a gate or repair trigger; it is not an invitation to invent compliant-looking evidence." },
  { stage: "knowledge-update", executor: "approved-observation-ledger", execution: "Runs only after accountable observations are reviewed and approved; generated text is never written back as fact." },
];

const OWNERSHIP_ROWS: Array<[FormulaDefinition["id"], FormulaExecutionStage[], boolean]> = [
  ["F01", ["generation"], true],
  ["F02", ["planning"], false],
  ["F03", ["generation", "validation"], true],
  ["F04", ["planning", "generation"], true],
  ["F05", ["planning", "generation"], true],
  ["F06", ["planning", "generation", "validation"], true],
  ["F07", ["planning", "generation"], true],
  ["F08", ["planning", "diagnostic", "evaluation"], false],
  ["F09", ["planning", "generation", "validation"], true],
  ["F10", ["planning", "generation", "validation"], true],
  ["F11", ["planning", "evaluation"], false],
  ["F12", ["planning"], false],
  ["F13", ["planning"], false],
  ["F14", ["validation"], false],
  ["F15", ["evaluation"], false],
  ["F16", ["evaluation"], false],
  ["F17", ["calculation", "evaluation"], false],
  ["F18", ["diagnostic", "evaluation"], false],
  ["F19", ["planning", "generation", "validation"], true],
  ["F20", ["diagnostic", "evaluation"], false],
  ["F21", ["calculation", "evaluation"], false],
  ["F22", ["planning", "evaluation"], false],
  ["F23", ["evaluation"], false],
  ["F24", ["planning", "evaluation"], false],
  ["F25", ["generation", "validation"], true],
  ["F26", ["planning"], false],
  ["F27", ["planning", "evaluation", "validation"], false],
  ["F28", ["planning", "diagnostic", "evaluation"], false],
  ["F29", ["evaluation"], false],
  ["F30", ["calculation"], false],
  ["F31", ["planning", "evaluation", "validation"], false],
  ["F32", ["diagnostic"], false],
  ["F33", ["diagnostic"], false],
  ["F34", ["diagnostic", "validation", "knowledge-update"], false],
  ["F35", ["evaluation"], false],
  ["F36", ["knowledge-update"], false],
  ["F37", ["validation", "knowledge-update"], false],
  ["F38", ["planning"], false],
  ["F39", ["planning", "validation"], false],
  ["F40", ["planning", "generation", "validation"], true],
  ["F41", ["planning"], false],
  ["F42", ["planning"], false],
  ["F43", ["planning"], false],
];

interface FormulaImplementationReview {
  status: FormulaImplementationStatus;
  implementedStages: FormulaExecutionStage[];
  actualExecution: string;
  boundary: string;
  codeLocations: string[];
}

/**
 * Per-equation truth table reviewed for R07. This is intentionally explicit:
 * adding a formula ID can no longer inherit `active` merely by omission.
 */
const FORMULA_IMPLEMENTATION_REVIEWS: Readonly<Record<string, FormulaImplementationReview>> = Object.freeze({
  F01: { status: "active", implementedStages: ["generation"], actualExecution: "输出合同与写作提示会装配同一个 H＋N＋Cref 完整内容包。", boundary: "只在本地内容包定义上完整执行，不代表触达或效果公式成立。", codeLocations: ["packages/agent-core/src/prompt.ts", "packages/agent-core/src/types.ts"] },
  F02: { status: "partial", implementedStages: ["planning"], actualExecution: "草稿、编排计划与部署计划分别保存快照。", boundary: "系统没有执行平台部署，也没有观测平台扰动、真实用户评论或 Ureal。", codeLocations: ["packages/agent-core/src/engine.ts", "packages/agent-core/src/types.ts"] },
  F03: { status: "active", implementedStages: ["generation", "validation"], actualExecution: "参考问答、部署说明和真实评论使用不同身份；模拟内容会标注并校验。", boundary: "校验器只证明本地产物的身份字段，不证明平台实际如何展示或审核线程。", codeLocations: ["packages/agent-core/src/prompt.ts", "packages/agent-core/src/content.ts"] },
  F04: { status: "active", implementedStages: ["planning", "generation"], actualExecution: "同一张缺口卡把问题、答案/框架、证据、优先级、边界和计划位置传入写作。", boundary: "它是完整执行的生产数据模型；重要性仍是项目判断，不是人群分布真值。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F05: { status: "partial", implementedStages: ["planning", "generation"], actualExecution: "表达策略会落成通道、形式、口吻、顺序和线程选择，并把选中计划交给写作。", boundary: "可配置表达窗与采样策略尚未成为一个完全受公式开关控制的单一真源，也没有哪种表达已被证明效果更好。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F06: { status: "active", implementedStages: ["planning", "generation", "validation"], actualExecution: "缺口规划保留获批原文片段；可发布声明受这些片段约束，无支持内容保持 unknown，最终包会重新校验。", boundary: "可行域只覆盖已加载并获批的项目证据；系统不能证明资料之外的外部完整性或真值。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/engine.ts", "packages/agent-core/src/content.ts"] },
  F07: { status: "partial", implementedStages: ["planning", "generation"], actualExecution: "获批图片观察会与标题、正文一起形成图片计划和图片简报。", boundary: "当前内容包通常只有简报，不是已渲染的最终图片，也没有图题文语义一致性的实测分数。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F08: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有执行跨通道位置的反事实实验。", boundary: "现有通道分配和重复检查不能估计因果边际价值。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F09: { status: "partial", implementedStages: ["planning", "generation", "validation"], actualExecution: "计划会分配残余缺口；最终校验会重新检查答案、边界、证据和位置是否真实可见。", boundary: "系统只审计已选缺口集，不会发现阅读后的全部潜在残余缺口，也不会根据真实读者观测重新规划。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/content.ts"] },
  F10: { status: "partial", implementedStages: ["planning", "generation", "validation"], actualExecution: "系统会把角色知情位置、人物场景、平台语域、对话拓扑和知识缺口交叉编排，按目标比例生成单轮、两轮与第三人分支，并检查元问题、FAQ同构和计划接话数。", boundary: "语域与自然度来自样本形态和生产假设，尚未用真实平台实验校准；系统也没有逐字预测真实用户会如何互动。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts", "packages/agent-core/src/content.ts"] },
  F11: { status: "protocol-only", implementedStages: [], actualExecution: "系统会写部署计划，但不会实际发布或观测评论可见性。", boundary: "计划不能证明置顶、折叠、排序、审核或特定时点的实际可见状态。", codeLocations: ["packages/agent-core/src/engine.ts", "docs/audit/formula-review-checklist.md"] },
  F12: { status: "partial", implementedStages: ["planning"], actualExecution: "系统只按用户选择的入口与阶段建立一组可修正写作情景；preContactKnown 仅接收用户明确提供的内容，history 未提供时保持 unknown。", boundary: "这不是抽样、分类或估计得到的人群分布，也不能从一次点击推断个人动机。", codeLocations: ["packages/agent-core/src/config.ts", "packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F13: { status: "partial", implementedStages: ["planning"], actualExecution: "系统把审慎、信息疲劳与收束需要表示为 low/medium/high 写作假设，并附未标定区间、形成依据和 calibrated=false。", boundary: "等级仅按所选阶段启发式形成；不是心理测量、个人诊断、人群比例，也没有实现阅读前后状态转移。", codeLocations: ["packages/agent-core/src/types.ts", "packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F14: { status: "partial", implementedStages: ["validation"], actualExecution: "系统把 unknown 冒充事实和过度确定表达作为假闭合风险进行检查。", boundary: "系统没有测量客观缺口、感知缺口和确信度，因此不会数值计算展示的公式。", codeLocations: ["packages/agent-core/src/content.ts"] },
  F15: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有采集决策损失终点或遗憾观测。", boundary: "它是规范性评价协议，不会给生成文案打分。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F16: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有执行可比的阅读前后决策损失测量。", boundary: "仅凭生成文本不能识别读者遗憾是否变化。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F17: { status: "conditional", implementedStages: ["calculation"], actualExecution: "仅当用户提供三个数值及各自非空、完全一致的可比较单位时，安全 AST 才计算 regretBefore－regretAfter－cognitiveCost。", boundary: "输入不足或单位不一致时结果保持 unknown 并报告校验错误；该手工情景值不会被规划、选稿或写作消费。", codeLocations: ["packages/agent-core/src/formula.ts", "packages/agent-core/src/parameters.ts"] },
  F18: { status: "protocol-only", implementedStages: [], actualExecution: "系统有相邻诊断设置，但不会计算展示的代理公式。", boundary: "决策损失变化、认知成本、广告风险和假闭合目前没有共同量纲。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F19: { status: "partial", implementedStages: ["planning", "generation", "validation"], actualExecution: "系统联合生成 ImagePlan、ImageBrief、标题、标签和正文入口草稿，并用 planToCopyAlignment 检查制作计划与可见文案的承接；productionArtifacts 分别记录最终图片和入口截图是否存在。", boundary: "当前最终图片资产与真实入口截图均为 absent，finalAssetAlignment/entrySnapshotAlignment 为 not_evaluated；因此只完成 EntryDraft，绝不声称 PreviewObserved 已执行或预测打开效果。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/artifacts.ts", "packages/agent-core/src/content.ts", "packages/agent-core/src/engine.ts", "packages/agent-core/src/prompt.ts"] },
  F20: { status: "protocol-only", implementedStages: [], actualExecution: "当前不会计算 RouteFit、打开概率或评论质量表达式。", boundary: "相关参数只是写作指引，不能被报告成这条离线质量公式。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F21: { status: "conditional", implementedStages: ["calculation"], actualExecution: "仅当用户提供 pExposure、pNoticeGivenExposure、pEnterGivenNotice、pConsumeGivenEnter 且四者都位于 [0,1] 时，安全 AST 才计算顺序路径概率。", boundary: "输入不足或越界时结果保持 unknown 并报告校验错误；该手工情景值不会用于生成、规划或选稿。", codeLocations: ["packages/agent-core/src/formula.ts", "packages/agent-core/src/parameters.ts"] },
  F22: { status: "partial", implementedStages: ["planning"], actualExecution: "评论计划会优先安排可找到的残余缺口、新增答案、边界并控制杂乱。", boundary: "Needs、Pfind、信息价值、打开成本与杂乱成本都没有被观测或合并计算。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/content.ts"] },
  F23: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有真实评论增量、参与或互动价值观测。", boundary: "参考问答不能替代公式里的真实评论。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F24: { status: "protocol-only", implementedStages: [], actualExecution: "当前不会对接触内容前的人群分布求期望。", boundary: "单个启发式状态种子不是人群分布。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F25: { status: "active", implementedStages: ["generation", "validation"], actualExecution: "获批证据、禁止声明、未知边界、来源身份和最终有效性会作为本地硬门槛。", boundary: "只对本地配置的 Ω 完整执行；不代表已覆盖所有最新平台、法律或外部约束。", codeLocations: ["packages/agent-core/src/prompt.ts", "packages/agent-core/src/content.ts", "packages/agent-core/src/engine.ts"] },
  F26: { status: "partial", implementedStages: ["planning"], actualExecution: "规划器会在缺口卡、表达策略、通道和部署选择组成的有界联合空间中采样。", boundary: "这是受控采样，不是对 WI×Ψ(WX)×AC 的穷尽枚举。", codeLocations: ["packages/agent-core/src/planning.ts"] },
  F27: { status: "protocol-only", implementedStages: [], actualExecution: "当前不会计算不确定集合或最坏情景目标。", boundary: "结构距离与近期重合惩罚不是 max-min 鲁棒优化。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F28: { status: "protocol-only", implementedStages: [], actualExecution: "当前不会计算展示的乘法机会公式。候选排序由独立的 OpportunityRankHeuristicV1 执行，并随结果保存分项、输入来源、unknown 与复核状态。", boundary: "OpportunityRankHeuristicV1 使用固定且未标定的内部权重，不含 F28 所需的真实需求和竞品覆盖观测，也不是因果效果预测；它不能继承 F28 的公式身份。", codeLocations: ["packages/agent-core/src/planning.ts", "packages/agent-core/src/engine.ts", "apps/api/src/intelligence.service.ts", "apps/web/src/pages/IntelligentSimpleFlow.tsx", "docs/audit/formula-review-checklist.md"] },
  F29: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有观测可比较的项目与竞品内容组合。", boundary: "新颖度指引不是测量得到的相对竞争前沿。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F30: { status: "conditional", implementedStages: ["calculation"], actualExecution: "仅当用户声明来源类型，trendSourceRef 填写无 userinfo 的绝对 http/https URL 或 id:/title:/source: 加具体对象，sourceObservedAt 填写带秒和时区的 RFC3339 时间，并手工提供三个 [0,1] 情景因子时，安全 AST 才计算 TrendFit=relevance×bridgeClarity×timeliness。", boundary: "系统只校验用户声明的来源引用格式与时间格式/取值，不联网核验来源存在性、榜单身份或实际观察行为。TrendFit 只是未标定的手工匹配情景，不进入生成、规划、选稿或校验，也不输出 qualifiedIncrementalReach；合格增量触达需要当前未执行的独立对照观察协议。", codeLocations: ["packages/agent-core/src/formula.ts", "packages/agent-core/src/parameters.ts"] },
  F31: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有观测合格触达、共同价值单位、风险成本或过期成本。", boundary: "标签与热点设置不是这条净机会公式。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F32: { status: "partial", implementedStages: ["diagnostic"], actualExecution: "系统会按 emphasis 降序输出十个正文分项；同值按合同固定顺序展示，并保留并列人工检查优先级。", boundary: "emphasis 只控制展示与人工检查优先级，不改变阈值、分项状态或结论；当前分项没有校准观测，value=null/status=unknown，不生成总分，也不进入生成、规划、选稿或校验。", codeLocations: ["packages/agent-core/src/formula.ts", "packages/agent-core/src/parameters.ts"] },
  F33: { status: "partial", implementedStages: ["diagnostic"], actualExecution: "系统会按 emphasis 降序输出十个评论分项；同值按合同固定顺序展示，并保留并列人工检查优先级。", boundary: "emphasis 只控制展示与人工检查优先级，不改变阈值、分项状态或结论；当前分项没有校准观测，value=null/status=unknown。独立硬校验器不属于 F33 分项，线程数和规则通过数也不是质量分。", codeLocations: ["packages/agent-core/src/formula.ts", "packages/agent-core/src/parameters.ts", "packages/agent-core/src/content.ts"] },
  F34: { status: "partial", implementedStages: [], actualExecution: "系统已具备声明级来源片段、来源角色和获批证据引用这些前置数据。", boundary: "展示的 AggregateBySource、独立来源聚类与依赖建模尚未实现；现有引用校验归属 F06/F25。", codeLocations: ["packages/agent-core/src/engine.ts", "packages/agent-core/src/content.ts"] },
  F35: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有观测受众规模、完整路径概率或合格行动结果。", boundary: "业务行动和用户决策价值仍是两个分开的未测结果。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F36: { status: "partial", implementedStages: ["knowledge-update"], actualExecution: "项目智能与资源可以先版本化、审批，再供后续任务使用。", boundary: "生成文本和未经复核的现实结果不会自动升级为事实。", codeLocations: ["apps/api/src/intelligence.service.ts"] },
  F37: { status: "protocol-only", implementedStages: [], actualExecution: "当前没有执行随机 2×2 实验器或分析计划。", boundary: "这条公式是实验设计，不是当前已有验证证据。", codeLocations: ["docs/audit/formula-review-checklist.md"] },
  F38: { status: "partial", implementedStages: ["planning"], actualExecution: "多模态分析模型会结合行业先验与获批项目证据枚举行业缺口、策略和机会。", boundary: "这是模型辅助且必须复核的过程，不是穷尽结果，也不是对整个行业空间的确定性证明。", codeLocations: ["apps/api/src/intelligence.service.ts"] },
  F39: { status: "partial", implementedStages: ["planning", "validation"], actualExecution: "unknown 指标会被阻断；获批相关性、证据、可证性、风险和依赖版本共同约束可选机会。", boundary: "配置门槛只是有界的本地可行性检查，不是全部可能 Ω 约束的完整实现。", codeLocations: ["packages/agent-core/src/planning.ts", "apps/api/src/generation.service.ts"] },
  F40: { status: "partial", implementedStages: ["planning", "generation", "validation"], actualExecution: "标签、来源图片观察、图片计划、图片简报、标题、正文、参考问答和部署计划会装配为同一 OrchDraft，并附六阶段 productionArtifacts 状态账本和三层一致性结果。", boundary: "来源素材不是 FinalImg，ImageBrief 不是像素资产，DeploymentPlan 不是实际发布；当前 finalImageAsset=absent、entrySnapshot=absent、deployment=not_deployed，所以 OrchRealized 未完成。", codeLocations: ["packages/agent-core/src/types.ts", "packages/agent-core/src/planning.ts", "packages/agent-core/src/artifacts.ts", "packages/agent-core/src/content.ts", "packages/agent-core/src/engine.ts", "packages/agent-core/src/prompt.ts"] },
  F41: { status: "partial", implementedStages: ["planning"], actualExecution: "状态种子合同分别保存 preContactKnown、availableEvidence、hypothesizedGaps、readerConstraints、availableBoundaries、history 与未标定状态假设。", boundary: "项目 verifiedFacts 只能进入 availableEvidence，不能冒充读者原本已知；项目边界也不能冒充读者个人约束。", codeLocations: ["packages/agent-core/src/types.ts", "packages/agent-core/src/planning.ts", "packages/agent-core/src/prompt.ts"] },
  F42: { status: "active", implementedStages: ["planning"], actualExecution: "带种子的受控采样会精确返回三套结构不同且保留获批依赖的计划。", boundary: "只在本地采样合同上完整执行；多样性权重不证明效果更好或语义原创。", codeLocations: ["packages/agent-core/src/planning.ts"] },
  F43: { status: "active", implementedStages: ["planning"], actualExecution: "内容寻址签名会记录选题、缺口、分配、策略和图片角色，用于控制近期重合。", boundary: "只在草稿规划记忆上完整执行；草稿覆盖不等于发布记忆、结果观测或知识更新。", codeLocations: ["packages/agent-core/src/planning.ts", "apps/api/src/generation.service.ts"] },
});

function implementationReview(formulaId: FormulaDefinition["id"]): FormulaImplementationReview | undefined {
  return FORMULA_IMPLEMENTATION_REVIEWS[formulaId];
}

const FORMULA_DATA_REQUIREMENTS: Readonly<Record<string, string>> = Object.freeze({
  F01: "当前任务、启用通道与完整输出 Schema。",
  F02: "如要完成现实层，需要真实部署记录、平台展示状态、时间点和真实用户评论。",
  F03: "每条参考问答的发言身份、模拟标记与可追责回复者。",
  F04: "获批缺口、答案或框架、证据片段、优先级、边界与计划位置。",
  F05: "获批表达策略及通道、形式、口吻、顺序、线程选择；效果比较另需实验。",
  F06: "已加载且获批的声明级原文片段、来源角色和适用范围。",
  F07: "获批图片观察与计划；要验证完整公式还需最终图片资产和一致性核验。",
  F08: "固定信息、随机通道位置、预注册指标及真实理解/找到/错误结果。",
  F09: "最终正文与评论可见文本、缺口卡、边界和逐声明证据映射。",
  F10: "获批缺口、角色知情位置、人物场景、平台语域、线程拓扑、回答契约与逐层新增信息。",
  F11: "真实发布身份、置顶/折叠/排序、审核状态、时间点和可见性观察。",
  F12: "用户选择的入口与阶段；preContactKnown/history 只有用户明确提供时才可使用。若要估计人群分布，另需有定义的抽样框和代表性样本。",
  F13: "当前只需阶段与已选缺口形成未标定写作假设；若要声称真实心理或状态变化，另需有效测量、校准样本与 before/after 观察。",
  F14: "客观缺口、读者感知缺口、确信度及各维度可解释权重。",
  F15: "固定决策终点、可行动集合、状态真值、损失函数和真实选择观察。",
  F16: "同一读者或可比样本的 before/after 决策损失。",
  F17: "regretBefore、regretAfter、cognitiveCost 三个显式数值及各自非空且完全一致的可比较单位；当前结果只供手工情景计算。",
  F18: "决策损失变化、认知成本、广告风险、假闭合与共同量纲。",
  F19: "入口草稿需要来源观察、ImagePlan、ImageBrief、标题、标签和摘要；只有核验后的 FinalImg 与真实 EntrySnapshot 才能评价 PreviewObserved。",
  F20: "RouteFit、打开概率、正文价值和评论价值的同一情景输入。",
  F21: "pExposure、pNoticeGivenExposure、pEnterGivenNotice、pConsumeGivenEnter 四个有明确条件分母且位于 [0,1] 的路径概率。",
  F22: "评论需求、找到率、信息价值、打开成本与杂乱成本观察。",
  F23: "真实评论增量、打开、参与和互动价值的条件分母。",
  F24: "同一入口在接触内容前的人群状态分布和状态价值观察。",
  F25: "当前项目获批证据、禁止项、unknown、来源身份和本地安全规则。",
  F26: "完整候选维度与枚举预算；当前只有有界受控采样。",
  F27: "明确不确定集合 Θ、情景目标和最坏情景评分。",
  F28: "可证性、需求、重要性、竞品覆盖、杠杆与认知成本的可比观测。",
  F29: "项目与竞品组合、同一查询分布和可比 Iq 评价。",
  F30: "用户声明的 trendSourceKind；trendSourceRef 必须是无 userinfo 的绝对 http/https URL，或 id:/title:/source: 加具体对象；sourceObservedAt 必须是带秒和时区的有效 RFC3339 时间；另需 relevance、bridgeClarity、timeliness 三个 [0,1] 用户手工情景输入。系统只做本地声明校验、不联网核验；合格增量触达另需真实对照观察。",
  F31: "合格增量触达、共同价值单位、风险成本和过期成本。",
  F32: "正文十个分项的校准观测来源；当前只有显示/人工检查优先级，缺失必须为 unknown，且不合成总分。",
  F33: "评论十个分项的校准观测来源；当前只有显示/人工检查优先级，缺失必须为 unknown，且不合成总分。",
  F34: "原始声明、独立来源簇、来源依赖图和明确聚合规则。",
  F35: "受众规模、完整路径分母、合格行动定义与真实结果。",
  F36: "经审批的现实观察与来源；生成文本本身不能成为事实。",
  F37: "随机分配、样本量、主要指标、停止规则和分析计划。",
  F38: "行业名词、行业先验、获批项目证据、约束与人工复核。",
  F39: "获批相关性、可证性、直接证据、风险、边界与最新依赖版本。",
  F40: "获批选题、状态、知识、来源图片观察、计划、简报和完整文本编排；OrchRealized 另需最终图片资产、入口快照及实际部署观察。",
  F41: "入口、阶段、用户提供的接触前已知/历史/读者约束，以及模型可用项目证据和内容边界；各字段身份不得互换，未知项必须保持 unknown。",
  F42: "获批机会/缺口/策略、随机种子、多样性设置与证据门槛。",
  F43: "选题、缺口、通道分配、策略、图片角色及草稿/采纳/发布状态。",
});

function dataRequirement(formulaId: FormulaDefinition["id"]): string {
  return FORMULA_DATA_REQUIREMENTS[formulaId] ?? "需要完成实现与语义复核后才能执行。";
}

function reviewedEvidenceStatus(type: FormulaType): FormulaDefinition["evidenceStatus"] {
  if (type === "architecture") return "definition";
  if (type === "normative" || type === "validation") return "bounded";
  return "unvalidated";
}

export const F30_TREND_SOURCE_TYPES = Object.freeze([
  "xiaohongshu_hotspot_rank",
  "xiaohongshu_hot_discussion",
  "other_explicit_source",
] as const);

const F30_CALCULATOR_CONTRACT_VALUE: FormulaCalculatorContract = {
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

export const F30_CALCULATOR_CONTRACT: FormulaCalculatorContract = Object.freeze(F30_CALCULATOR_CONTRACT_VALUE);

const DIAGNOSTIC_EMPHASIS_CONTRACT: FormulaDiagnosticContract["emphasis"] = {
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
};

const DIAGNOSTIC_NON_CONSUMPTION: FormulaDiagnosticContract["consumedBy"] = {
  generation: false,
  planning: false,
  selection: false,
  validation: false,
};

const POSITIVE_COMPONENT_BOUNDARY = "没有经过校准的分项观测时状态必须为 unknown；emphasis 不是满足程度、证据或质量值。";
const COST_RISK_COMPONENT_BOUNDARY = "没有经过校准的分项观测时状态必须为 unknown；emphasis 不是成本或风险的测量值。";

const F32_DIAGNOSTIC_CONTRACT_VALUE: FormulaDiagnosticContract = {
  mode: "display_priority_metadata",
  semantics: "ordered_component_review_metadata",
  aggregation: "components_only",
  evaluationStatus: "not_evaluated",
  aggregateStatus: "unknown",
  aggregateValue: null,
  scoreProduced: false,
  missingDataPolicy: "unknown_not_zero",
  emphasis: DIAGNOSTIC_EMPHASIS_CONTRACT,
  consumedBy: DIAGNOSTIC_NON_CONSUMPTION,
  componentDefinitions: [
    { id: "stateMatch", label: "读者状态匹配", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "stageClarity", label: "阶段是否清楚", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "sceneDiagnosticity", label: "场景是否帮助判断", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "traceCredibility", label: "可感知痕迹是否可信", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "visualAnchoring", label: "图文是否互相承接", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "gapClarity", label: "信息缺口是否清楚", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "directInformation", label: "直接有效信息", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "cognitiveCost", label: "阅读认知成本", direction: "cost", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
    { id: "adSuspicion", label: "广告怀疑风险", direction: "risk", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
    { id: "logicError", label: "逻辑错误风险", direction: "risk", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
  ],
  boundaries: [
    "emphasis 只改变分项显示顺序和人工检查优先级，不改变阈值、分项状态或诊断结论。",
    "当前没有冻结盲评校准观测，所有分项值为 null、状态为 unknown，缺失不得换算为 0。",
    "分项之间没有共同且已标定的量纲，禁止求和、平均、加权或生成 0—100 总分。",
    "该清单不参与生成、规划、选稿或校验。",
  ],
};

const F33_DIAGNOSTIC_CONTRACT_VALUE: FormulaDiagnosticContract = {
  mode: "display_priority_metadata",
  semantics: "ordered_component_review_metadata",
  aggregation: "components_only",
  evaluationStatus: "not_evaluated",
  aggregateStatus: "unknown",
  aggregateValue: null,
  scoreProduced: false,
  missingDataPolicy: "unknown_not_zero",
  emphasis: DIAGNOSTIC_EMPHASIS_CONTRACT,
  consumedBy: DIAGNOSTIC_NON_CONSUMPTION,
  componentDefinitions: [
    { id: "gapCoverage", label: "残余缺口覆盖", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "incrementalInformation", label: "相对正文的新增信息", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "questionFit", label: "问题与阶段匹配", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "answerGrounding", label: "回答有知识依据", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "liveness", label: "问答推进感", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "routeClarity", label: "查找和承接清楚", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "conditionalClarity", label: "条件与边界清楚", direction: "positive", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: POSITIVE_COMPONENT_BOUNDARY },
    { id: "cognitiveCost", label: "打开与阅读成本", direction: "cost", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
    { id: "contradiction", label: "跨通道矛盾风险", direction: "risk", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
    { id: "overMarketing", label: "过度营销风险", direction: "risk", evidenceStatus: "unvalidated_proxy", sourceRequirement: "calibrated_component_observation", boundary: COST_RISK_COMPONENT_BOUNDARY },
  ],
  boundaries: [
    "emphasis 只改变分项显示顺序和人工检查优先级，不改变阈值、分项状态或诊断结论。",
    "当前没有冻结盲评校准观测，所有分项值为 null、状态为 unknown，缺失不得换算为 0。",
    "分项之间没有共同且已标定的量纲，禁止求和、平均、加权或生成 0—100 总分。",
    "线程条数、角色数、关键词覆盖和独立硬校验通过数都不是 F33 分项值；该清单不参与生成、规划、选稿或校验。",
  ],
};

function freezeDiagnosticContract(contract: FormulaDiagnosticContract): FormulaDiagnosticContract {
  Object.freeze(contract.emphasis.range);
  Object.freeze(contract.emphasis.affects);
  Object.freeze(contract.emphasis.doesNotAffect);
  Object.freeze(contract.emphasis);
  Object.freeze(contract.consumedBy);
  contract.componentDefinitions.forEach((component) => Object.freeze(component));
  Object.freeze(contract.componentDefinitions);
  Object.freeze(contract.boundaries);
  return Object.freeze(contract);
}

export const F32_DIAGNOSTIC_CONTRACT: FormulaDiagnosticContract = freezeDiagnosticContract(F32_DIAGNOSTIC_CONTRACT_VALUE);
export const F33_DIAGNOSTIC_CONTRACT: FormulaDiagnosticContract = freezeDiagnosticContract(F33_DIAGNOSTIC_CONTRACT_VALUE);

export const LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT = "ce32ee3ff6cb74cc6c0f923fb73f1e64f4d68b63008a8ed22686ca767c646145";
export const PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT = "08bd0753814130b5b236585dc7f2c64b7de8083c426b3afab77a2924fd09553b";
export const F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS = Object.freeze([
  LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
  PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
] as const);
export const LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT = "0c8c107336173f87561c706115a5ff639315c923426335918d40a257f12555b8";
export const LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT = "45a6fe53cc1916a6d7c2f112023e9d0f79a085f1d894e26b90d2d1a49840e328";

const COMPUTABLE: Partial<Record<FormulaDefinition["id"], Pick<FormulaDefinition, "variables" | "expression" | "calculatorContract">>> = {
  F17: {
    variables: [
      { path: "regretBefore", description: "阅读前决策遗憾", valueType: "number", required: true, unitPath: "regretBeforeUnit", unitGroup: "decisionValue" },
      { path: "regretAfter", description: "阅读后决策遗憾", valueType: "number", required: true, unitPath: "regretAfterUnit", unitGroup: "decisionValue" },
      { path: "cognitiveCost", description: "认知成本", valueType: "number", required: true, unitPath: "cognitiveCostUnit", unitGroup: "decisionValue" },
      { path: "regretBeforeUnit", description: "阅读前决策遗憾的可比较单位", valueType: "string", required: true },
      { path: "regretAfterUnit", description: "阅读后决策遗憾的可比较单位", valueType: "string", required: true },
      { path: "cognitiveCostUnit", description: "认知成本的可比较单位", valueType: "string", required: true },
    ],
    expression: {
      op: "if",
      condition: {
        op: "and",
        args: [
          { op: "eq", args: [{ op: "var", path: "regretBeforeUnit" }, { op: "var", path: "regretAfterUnit" }] },
          { op: "eq", args: [{ op: "var", path: "regretAfterUnit" }, { op: "var", path: "cognitiveCostUnit" }] },
          { op: "ne", args: [{ op: "var", path: "regretBeforeUnit" }, { op: "literal", value: "" }] },
        ],
      },
      then: { op: "subtract", args: [{ op: "subtract", args: [{ op: "var", path: "regretBefore" }, { op: "var", path: "regretAfter" }] }, { op: "var", path: "cognitiveCost" }] },
      else: { op: "literal", value: null },
    },
  },
  F21: {
    variables: [
      { path: "pExposure", description: "目标入口发生曝光的概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "pNoticeGivenExposure", description: "已曝光条件下被注意到的概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "pEnterGivenNotice", description: "已注意条件下进入内容的概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "pConsumeGivenEnter", description: "已进入条件下实际消费信息的概率", valueType: "number", required: true, minimum: 0, maximum: 1 },
    ],
    expression: {
      op: "if",
      condition: {
        op: "and",
        args: ["pExposure", "pNoticeGivenExposure", "pEnterGivenNotice", "pConsumeGivenEnter"].flatMap((path) => [
          { op: "gte" as const, args: [{ op: "var" as const, path }, { op: "literal" as const, value: 0 }] },
          { op: "lte" as const, args: [{ op: "var" as const, path }, { op: "literal" as const, value: 1 }] },
        ]),
      },
      then: { op: "multiply", args: ["pExposure", "pNoticeGivenExposure", "pEnterGivenNotice", "pConsumeGivenEnter"].map((path) => ({ op: "var" as const, path })) },
      else: { op: "literal", value: null },
    },
  },
  F30: {
    variables: [
      {
        path: "trendSourceKind",
        description: "用户声明的热点来源类型：xiaohongshu_hotspot_rank=声称在指定时间观察到的小红书热点榜条目；xiaohongshu_hot_discussion=声称为小红书热议话题但不宣称进入榜单；other_explicit_source=其他明确来源且不得伪装成前两类；系统不联网核验该分类",
        valueType: "string",
        required: true,
        allowedValues: [...F30_TREND_SOURCE_TYPES],
      },
      { path: "trendSourceRef", description: "用户声明的具体来源引用：绝对 http/https URL（不得含 userinfo），或 id:/title:/source: 加具体对象；纯标签和空泛词无效，系统只校验格式、不联网核验来源", valueType: "string", required: true, nonEmpty: true, format: "trend_source_ref" },
      { path: "sourceObservedAt", description: "用户声明的来源观察或快照时间，必须是带秒和时区的 RFC3339 时间；系统校验日期时间值但不核验实际观察行为", valueType: "string", required: true, nonEmpty: true, format: "rfc3339_timestamp" },
      { path: "relevance", description: "项目主题与该具体热点对象的实质相关度手工情景值；关键词相同不自动等于相关", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "bridgeClarity", description: "内容是否清楚解释为何与该热点相关的手工情景值；仅添加标签不构成清晰桥接", valueType: "number", required: true, minimum: 0, maximum: 1 },
      { path: "timeliness", description: "相对 sourceObservedAt 快照的时效性手工情景值；不预测未来热度", valueType: "number", required: true, minimum: 0, maximum: 1 },
    ],
    expression: {
      op: "if",
      condition: {
        op: "and",
        args: [
          {
            op: "or",
            args: F30_TREND_SOURCE_TYPES.map((value) => ({
              op: "eq" as const,
              args: [{ op: "var" as const, path: "trendSourceKind" }, { op: "literal" as const, value }],
            })),
          },
          { op: "ne", args: [{ op: "var", path: "trendSourceRef" }, { op: "literal", value: "" }] },
          { op: "ne", args: [{ op: "var", path: "sourceObservedAt" }, { op: "literal", value: "" }] },
          ...["relevance", "bridgeClarity", "timeliness"].flatMap((path) => [
            { op: "gte" as const, args: [{ op: "var" as const, path }, { op: "literal" as const, value: 0 }] },
            { op: "lte" as const, args: [{ op: "var" as const, path }, { op: "literal" as const, value: 1 }] },
          ]),
        ],
      },
      then: { op: "multiply", args: ["relevance", "bridgeClarity", "timeliness"].map((path) => ({ op: "var" as const, path })) },
      else: { op: "literal", value: null },
    },
    calculatorContract: F30_CALCULATOR_CONTRACT,
  },
};

const DIAGNOSTIC_CONTRACTS: Partial<Record<FormulaDefinition["id"], FormulaDiagnosticContract>> = {
  F32: F32_DIAGNOSTIC_CONTRACT,
  F33: F33_DIAGNOSTIC_CONTRACT,
};

function defaultPlainLanguage(row: FormulaSeedRow): string {
  return `${row.title}：${row.purpose}。它是${row.type === "hypothesis" || row.type === "proxy" ? "待验证的推理或离线代理，不是平台经验定律" : "生产定义或安全约束"}。`;
}

function reviewedFormulaDefinition(row: FormulaSeedRow): FormulaDefinition {
  return {
    ...row,
    evidenceStatus: reviewedEvidenceStatus(row.type),
    plainLanguage: defaultPlainLanguage(row),
    variables: COMPUTABLE[row.id]?.variables ?? [],
    expression: COMPUTABLE[row.id]?.expression,
    calculatorContract: COMPUTABLE[row.id]?.calculatorContract,
    diagnosticContract: DIAGNOSTIC_CONTRACTS[row.id],
  };
}

function defaultDirectPromptSetting(formulaId: FormulaDefinition["id"]): boolean {
  return OWNERSHIP_ROWS.find(([id]) => id === formulaId)?.[2] ?? false;
}

/**
 * Backward-compatible name for the reviewed semantic fingerprint. It binds
 * dispatch to every field that can change execution or direct prompt meaning,
 * rather than trusting an unchanged display equation.
 */
export function formulaEquationFingerprint(
  formula: FormulaDefinition,
  directGenerationInstruction = defaultDirectPromptSetting(formula.id),
): string {
  const directPromptReview = directGenerationInstruction ? implementationReview(formula.id) : undefined;
  const semanticContract = {
    id: formula.id,
    equation: formula.equation,
    expression: formula.expression,
    variables: [...formula.variables].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    calculatorContract: formula.calculatorContract,
    diagnosticContract: formula.diagnosticContract,
    type: formula.type,
    title: formula.title,
    plainLanguage: formula.plainLanguage,
    purpose: formula.purpose,
    evidenceStatus: formula.evidenceStatus,
    directGenerationInstruction,
    directPromptExecutionScope: directPromptReview ? {
      actualExecution: directPromptReview.actualExecution,
      implementationBoundary: directPromptReview.boundary,
    } : undefined,
  };
  return createHash("sha256").update(canonicalize(semanticContract), "utf8").digest("hex");
}

/** Only one of the exact, known former built-in F30 semantics may enter the official migration path. */
export function isLegacyOfficialF30(formula: FormulaDefinition): boolean {
  if (formula.id !== "F30") return false;
  const fingerprint = formulaEquationFingerprint(formula, false);
  return F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS.some((candidate) => candidate === fingerprint);
}

/** Exact former built-in semantics eligible for the reviewed R13 contract migration. */
export function isLegacyOfficialF32OrF33(formula: FormulaDefinition): boolean {
  if (formula.id !== "F32" && formula.id !== "F33") return false;
  const fingerprint = formulaEquationFingerprint(formula, false);
  return formula.id === "F32"
    ? fingerprint === LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT
    : fingerprint === LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT;
}

const PARAMETER_HANDLER_FORMULAS = new Set<FormulaDefinition["id"]>([
  "F01", "F04", "F05", "F06", "F07", "F09", "F10", "F12", "F13", "F14",
  "F19", "F22", "F25", "F26",
]);
const CALCULATOR_HANDLER_FORMULAS = new Set<FormulaDefinition["id"]>(["F17", "F21", "F30"]);

const DERIVED_CALCULATORS = new Set<FormulaDefinition["id"]>(["F17", "F21", "F30"]);
const DIAGNOSTIC_PROXIES = new Set<FormulaDefinition["id"]>(["F14", "F32", "F33"]);
const PROTOCOL_FORMULAS = new Set<FormulaDefinition["id"]>(["F08", "F11", "F15", "F16", "F20", "F23", "F24", "F27", "F29", "F31", "F35", "F37"]);
const HYPOTHESIS_FORMULAS = new Set<FormulaDefinition["id"]>(["F12", "F13", "F22", "F41"]);
const NOT_IMPLEMENTED_FORMULAS = new Set<FormulaDefinition["id"]>(["F18", "F28", "F34"]);

function executionClass(formulaId: FormulaDefinition["id"]): FormulaExecutionClass {
  if (DERIVED_CALCULATORS.has(formulaId)) return "derived-calculator";
  if (DIAGNOSTIC_PROXIES.has(formulaId)) return "diagnostic-proxy";
  if (PROTOCOL_FORMULAS.has(formulaId)) return "protocol";
  if (HYPOTHESIS_FORMULAS.has(formulaId)) return "hypothesis";
  if (NOT_IMPLEMENTED_FORMULAS.has(formulaId)) return "not-implemented";
  return "direct-executable";
}

function handlerBindings(
  formulaId: FormulaDefinition["id"],
  directGenerationInstruction: boolean,
): Readonly<Record<FormulaHandlerKind, readonly string[]>> {
  return Object.freeze({
    parameter: PARAMETER_HANDLER_FORMULAS.has(formulaId) ? [`parameter:${formulaId}`] : [],
    calculator: CALCULATOR_HANDLER_FORMULAS.has(formulaId) ? [`calculator:${formulaId}`] : [],
    // Only executors that currently resolve this registry at runtime may be
    // advertised as dispatch handlers. Stage ownership remains available in
    // `stages`, but is not evidence of a wired, disableable dispatcher.
    planning: [],
    prompt: directGenerationInstruction ? [`prompt:${formulaId}`] : [],
    binder: [],
    validator: [],
    diagnostic: formulaId === "F32" || formulaId === "F33" ? [`diagnostic:${formulaId}`] : [],
    evaluation: [],
    "knowledge-update": [],
  });
}

const HANDLER_STAGE: Readonly<Record<FormulaHandlerKind, FormulaExecutionStage>> = Object.freeze({
  parameter: "configuration",
  calculator: "calculation",
  planning: "planning",
  prompt: "generation",
  binder: "binding",
  validator: "validation",
  diagnostic: "diagnostic",
  evaluation: "evaluation",
  "knowledge-update": "knowledge-update",
});

function dispatchedStages(handlers: Readonly<Record<FormulaHandlerKind, readonly string[]>>): FormulaExecutionStage[] {
  return FORMULA_HANDLER_KINDS
    .filter((kind) => handlers[kind].length > 0)
    .map((kind) => HANDLER_STAGE[kind])
    .filter((stage, index, all) => all.indexOf(stage) === index);
}

function formulaExecutionRoles(
  formulaId: FormulaDefinition["id"],
  review: FormulaImplementationReview,
  handlers: Readonly<Record<FormulaHandlerKind, readonly string[]>>,
): FormulaExecutionRole[] {
  const roles: FormulaExecutionRole[] = [];
  if (handlers.prompt.length) roles.push("direct-generation");
  if (handlers.parameter.length) roles.push("parameter-guidance");
  if (handlers.calculator.length) roles.push("conditional-calculator");
  if (handlers.diagnostic.length) roles.push("diagnostic-proxy");
  const registeredStages = dispatchedStages(handlers);
  if (review.implementedStages.some((stage) => !registeredStages.includes(stage))) roles.push("deterministic-mechanism");
  if (review.status === "protocol-only" && executionClass(formulaId) === "protocol") roles.push("research-protocol");
  return roles;
}

function controlMode(
  formulaId: FormulaDefinition["id"],
  review: FormulaImplementationReview,
  handlers: Readonly<Record<FormulaHandlerKind, readonly string[]>>,
): FormulaControlMode {
  if (review.status === "protocol-only" || review.status === "not-implemented" || review.implementedStages.length === 0) return "not-running";
  if (review.status === "conditional" || formulaId === "F32" || formulaId === "F33") return "fully-gated";
  if (!Object.values(handlers).some((items) => items.length > 0)) return "always-on";
  return "partially-gated";
}

/**
 * Reviewed handler registrations. These are compatibility records, not a claim
 * that a formula with the same ID but different semantics is equivalent.
 */
export const FORMULA_EXECUTION_HANDLER_REGISTRY: Readonly<Record<string, FormulaExecutionHandlerRegistration>> = Object.freeze(
  Object.fromEntries(OWNERSHIP_ROWS.map(([formulaId, declaredStages, directGenerationInstruction]) => {
    const seedRow = FORMULA_ROWS.find((row) => row.id === formulaId);
    if (!seedRow) throw new Error(`Missing reviewed formula seed for ${formulaId}.`);
    const seed = reviewedFormulaDefinition(seedRow);
    if (formulaId === "F32" || formulaId === "F33") {
      if (!seed.diagnosticContract) throw new Error(`Missing reviewed diagnostic contract for ${formulaId}.`);
      const contractIssues = validateDiagnosticContractShape(seed.diagnosticContract, formulaId, `${formulaId}.diagnosticContract`);
      if (contractIssues.length) throw new Error(`Invalid reviewed diagnostic contract for ${formulaId}: ${contractIssues.map((issue) => issue.message).join("; ")}`);
    }
    const review = implementationReview(formulaId);
    if (!review) throw new Error(`Missing R07 implementation review for ${formulaId}.`);
    const handlers = handlerBindings(formulaId, directGenerationInstruction);
    const registeredDispatchStages = dispatchedStages(handlers);
    const mode = controlMode(formulaId, review, handlers);
    const semanticFingerprint = formulaEquationFingerprint(seed, directGenerationInstruction);
    const registration: FormulaExecutionHandlerRegistration = {
      formulaId,
      stages: [...review.implementedStages],
      declaredStages: [...declaredStages],
      nonDispatchedStages: declaredStages.filter((stage) => !registeredDispatchStages.includes(stage)),
      directGenerationInstruction,
      implementationStatus: review.status,
      executionClass: executionClass(formulaId),
      executionRoles: formulaExecutionRoles(formulaId, review, handlers),
      dataRequirement: dataRequirement(formulaId),
      actualExecution: review.actualExecution,
      implementationBoundary: review.boundary,
      codeLocations: [...review.codeLocations],
      semanticFingerprint,
      equationFingerprint: semanticFingerprint,
      reviewedEquation: seed.equation,
      reviewedEvidenceStatus: reviewedEvidenceStatus(seed.type),
      disableable: mode === "fully-gated",
      controlMode: mode,
      handlers,
    };
    return [formulaId, Object.freeze(registration)];
  })),
);

export const F30_MIGRATION_DESCRIPTOR = Object.freeze({
  formulaId: "F30" as const,
  legacyOfficialSemanticFingerprint: LEGACY_OFFICIAL_F30_SEMANTIC_FINGERPRINT,
  previousReviewedSemanticFingerprint: PREVIOUS_REVIEWED_F30_SEMANTIC_FINGERPRINT,
  eligibleSourceSemanticFingerprints: F30_MIGRATION_SOURCE_SEMANTIC_FINGERPRINTS,
  targetSemanticFingerprint: FORMULA_EXECUTION_HANDLER_REGISTRY.F30!.semanticFingerprint,
  eligibility: "official_exact_match_only" as const,
  customFormulaPolicy: "fail_closed_pending_review" as const,
  note: "Only an exact canonical match to one of the two known former built-in F30 semantics may be derived into the current reviewed TrendFit manual-scenario contract; customized F30 definitions require explicit review.",
});

export const F32_F33_MIGRATION_DESCRIPTOR = Object.freeze({
  formulaIds: ["F32", "F33"] as const,
  eligibleSourceSemanticFingerprints: {
    F32: LEGACY_OFFICIAL_F32_SEMANTIC_FINGERPRINT,
    F33: LEGACY_OFFICIAL_F33_SEMANTIC_FINGERPRINT,
  },
  targetSemanticFingerprints: {
    F32: FORMULA_EXECUTION_HANDLER_REGISTRY.F32!.semanticFingerprint,
    F33: FORMULA_EXECUTION_HANDLER_REGISTRY.F33!.semanticFingerprint,
  },
  eligibility: "official_exact_match_only" as const,
  customFormulaPolicy: "fail_closed_pending_review" as const,
  note: "Only exact former built-in F32/F33 semantics may migrate to the reviewed ordered-component display-priority contract; customized definitions require explicit review.",
});

const HARD_SAFETY_INVARIANT_ROWS: HardSafetyInvariant[] = [
  {
    id: "SI01_EPISTEMIC_GROUNDING",
    title: "Unsupported claims remain unknown or explicitly qualified",
    disableable: false,
    relatedFormulaIds: ["F06", "F25", "F34"],
    handlers: ["system-prompt:epistemic-grounding", "validator:evidence-and-unknown-boundaries"],
  },
  {
    id: "SI02_SIMULATED_COMMENT_IDENTITY",
    title: "Reference comments cannot masquerade as real users or outcomes",
    disableable: false,
    relatedFormulaIds: ["F03", "F11"],
    handlers: ["system-prompt:simulated-comment-identity", "validator:comment-provenance"],
  },
  {
    id: "SI03_SCOPE_AND_UNCERTAINTY",
    title: "Scope, conflicts, limitations and uncertainty remain visible",
    disableable: false,
    relatedFormulaIds: ["F14", "F25"],
    handlers: ["system-prompt:scope-and-uncertainty", "validator:false-closure-boundary"],
  },
  {
    id: "SI04_FORBIDDEN_CLAIMS",
    title: "Forbidden claims and absolute outcome promises remain blocked",
    disableable: false,
    relatedFormulaIds: ["F25"],
    handlers: ["system-prompt:forbidden-claims", "validator:forbidden-content"],
  },
];

/** Safety boundaries execute independently of optional methodology formulas. */
export const HARD_SAFETY_INVARIANTS: readonly HardSafetyInvariant[] = Object.freeze(
  HARD_SAFETY_INVARIANT_ROWS.map((invariant) => Object.freeze({
    ...invariant,
    relatedFormulaIds: Object.freeze([...invariant.relatedFormulaIds]),
    handlers: Object.freeze([...invariant.handlers]),
  })),
);

/** Backward-compatible ownership view; compatibility must be resolved through the handler registry. */
export const FORMULA_EXECUTION_OWNERSHIP: Readonly<Record<string, FormulaExecutionOwnership>> = Object.freeze(
  Object.fromEntries(Object.values(FORMULA_EXECUTION_HANDLER_REGISTRY).map((registration) => [
    registration.formulaId,
    {
      formulaId: registration.formulaId,
      stages: [...registration.stages],
      declaredStages: [...registration.declaredStages],
      nonDispatchedStages: [...registration.nonDispatchedStages],
      directGenerationInstruction: registration.directGenerationInstruction,
      implementationStatus: registration.implementationStatus,
      executionClass: registration.executionClass,
      executionRoles: [...registration.executionRoles],
      disableable: registration.disableable,
      controlMode: registration.controlMode,
      dataRequirement: registration.dataRequirement,
      actualExecution: registration.actualExecution,
      implementationBoundary: registration.implementationBoundary,
      codeLocations: [...registration.codeLocations],
    },
  ])),
);

export const FORMULA_EXECUTION_POLICY_VERSION = "3.6.0";
export const FORMULA_EXECUTION_POLICY_DIGEST = createHash("sha256")
  .update(canonicalize({
    version: FORMULA_EXECUTION_POLICY_VERSION,
    stages: FORMULA_STAGE_DEFINITIONS,
    registrations: FORMULA_EXECUTION_HANDLER_REGISTRY,
    hardSafetyInvariants: HARD_SAFETY_INVARIANTS,
  }), "utf8")
  .digest("hex");

function emptyHandlers(): Readonly<Record<FormulaHandlerKind, readonly string[]>> {
  return Object.freeze(Object.fromEntries(FORMULA_HANDLER_KINDS.map((kind) => [kind, []])) as unknown as Record<FormulaHandlerKind, readonly string[]>);
}

function enabledFormulaSet(enabledIds?: readonly string[]): Set<string> | undefined {
  return enabledIds === undefined ? undefined : new Set(enabledIds);
}

export function resolveFormulaExecution(
  formula: FormulaDefinition,
  enabledIds?: readonly string[],
): FormulaExecutionResolution {
  const registration = FORMULA_EXECUTION_HANDLER_REGISTRY[formula.id];
  const semanticFingerprint = formulaEquationFingerprint(
    formula,
    registration?.directGenerationInstruction ?? defaultDirectPromptSetting(formula.id),
  );
  const compatibilityStatus: FormulaHandlerCompatibilityStatus = !registration
    ? "unreviewed"
    : registration.semanticFingerprint === semanticFingerprint
      ? "reviewed"
      : "pending_review";
  const enabled = enabledFormulaSet(enabledIds);
  const requestedEnabled = enabled === undefined || enabled.has(formula.id);
  const handlerState: FormulaHandlerState = compatibilityStatus !== "reviewed"
    ? compatibilityStatus
    : requestedEnabled
      ? "enabled"
      : "disabled";
  return {
    formulaId: formula.id,
    semanticFingerprint,
    equationFingerprint: semanticFingerprint,
    compatibilityStatus,
    handlerState,
    requestedEnabled,
    effectiveEvidenceStatus: compatibilityStatus === "reviewed" ? registration!.reviewedEvidenceStatus : "unreviewed",
    registration,
    effectiveHandlers: handlerState === "enabled" ? registration!.handlers : emptyHandlers(),
  };
}

export function directGenerationFormulas(version: FormulaVersion, enabledIds?: readonly string[]): FormulaDefinition[] {
  return version.formulas.filter((formula) => {
    const resolution = resolveFormulaExecution(formula, enabledIds);
    return resolution.handlerState === "enabled" && resolution.effectiveHandlers.prompt.length > 0;
  });
}

export function formulaExecutionAudit(version: FormulaVersion, enabledIds?: readonly string[]): Record<string, unknown> {
  const resolutions = version.formulas.map((formula) => ({ formula, resolution: resolveFormulaExecution(formula, enabledIds) }));
  const directIds = new Set(directGenerationFormulas(version, enabledIds).map((formula) => formula.id));
  const trace = resolutions.map(({ formula, resolution }) => {
    const registeredHandlers = resolution.registration?.handlers ?? emptyHandlers();
    const effectiveHandlers = resolution.effectiveHandlers;
    const registeredDispatchStages = dispatchedStages(registeredHandlers);
    const effectiveDispatchStages = dispatchedStages(effectiveHandlers);
    const controlMode = resolution.registration?.controlMode ?? "not-running";
    const implementationStatus = resolution.registration?.implementationStatus ?? "not-implemented";
    const implementationRuntimeState = resolution.compatibilityStatus !== "reviewed"
      ? "not-reviewed"
      : controlMode === "not-running"
        ? "not-running"
        : controlMode === "always-on"
          ? "always-on"
          : controlMode === "partially-gated"
            ? resolution.handlerState === "enabled" ? "mixed-active" : "always-on-core-only"
            : implementationStatus === "conditional"
              ? resolution.handlerState === "enabled" ? "calculator-ready" : "disabled"
              : resolution.handlerState === "enabled" ? "handler-active" : "disabled";
    return ({
    id: formula.id,
    title: formula.title,
    semanticFingerprint: resolution.semanticFingerprint,
    equationFingerprint: resolution.equationFingerprint,
    compatibilityStatus: resolution.compatibilityStatus,
    handlerState: resolution.handlerState,
    requestedEnabled: resolution.requestedEnabled,
    declaredEvidenceStatus: formula.evidenceStatus,
    effectiveEvidenceStatus: resolution.effectiveEvidenceStatus,
    stages: resolution.registration?.stages ?? [],
    implementedStages: resolution.registration?.stages ?? [],
    declaredStages: resolution.registration?.declaredStages ?? [],
    registeredDispatchStages,
    effectiveDispatchStages,
    nonDispatchedStages: resolution.registration?.nonDispatchedStages ?? [],
    implementationStatus,
    implementationRuntimeState,
    executionClass: resolution.registration?.executionClass ?? "not-implemented",
    executionRoles: resolution.registration?.executionRoles ?? [],
    disableable: resolution.registration?.disableable ?? false,
    controlMode,
    dataRequirement: resolution.registration?.dataRequirement ?? "review-required-before-execution",
    actualExecution: resolution.registration?.actualExecution ?? "No reviewed implementation is registered for this semantic fingerprint.",
    implementationBoundary: resolution.registration?.implementationBoundary ?? "Review is required before any execution or evidence claim.",
    codeLocations: resolution.registration?.codeLocations ?? [],
    diagnosticContract: formula.diagnosticContract ? structuredClone(formula.diagnosticContract) : undefined,
    registeredHandlers,
    effectiveHandlers,
  });
  });
  const enabled = enabledFormulaSet(enabledIds);
  const versionIds = new Set<string>(version.formulas.map((formula) => formula.id));
  const hasEffectiveHandler = (item: typeof trace[number]): boolean => Object.values(item.effectiveHandlers).some((handlers) => handlers.length > 0);
  return {
    executionPolicyVersion: FORMULA_EXECUTION_POLICY_VERSION,
    executionPolicyDigest: FORMULA_EXECUTION_POLICY_DIGEST,
    stageDefinitions: FORMULA_STAGE_DEFINITIONS,
    hardSafetyInvariants: HARD_SAFETY_INVARIANTS,
    handlerGatingCoverage: {
      audit: "authoritative",
      prompt: "authoritative",
      parameter: "authoritative",
      calculator: "authoritative-for-reviewed-safe-AST-scenario-calculations",
      diagnostic: "authoritative-for-F32-F33-ordered-component-display-priority-metadata",
      otherStages: "declared-ownership-only; no runtime dispatch handler is registered",
      hardSafetyInvariants: "always-on and independent of optional formula enablement",
    },
    requestedEnabledFormulaIds: enabled === undefined ? version.formulas.map((formula) => formula.id) : [...enabled],
    unknownEnabledFormulaIds: enabled === undefined ? [] : [...enabled].filter((id) => !versionIds.has(id)),
    formulaTrace: trace,
    directGenerationFormulaIds: [...directIds],
    directGenerationFormulas: trace
      .filter((item) => directIds.has(item.id))
      .map((item) => ({ ...item, instructionMode: "direct-executable-generation" })),
    indirectFormulas: trace
      .filter((item) => item.handlerState === "enabled" && !directIds.has(item.id) && hasEffectiveHandler(item))
      .map((item) => ({ ...item, instructionMode: "registered-indirect-dispatch" })),
    nonDispatchedFormulas: trace
      .filter((item) => item.handlerState === "enabled" && !hasEffectiveHandler(item))
      .map((item) => ({ ...item, instructionMode: "declared-stage-not-dispatched" })),
    stageDispatchGaps: trace
      .filter((item) => item.nonDispatchedStages.length > 0)
      .map((item) => ({
        id: item.id,
        declaredStages: item.declaredStages,
        registeredDispatchStages: item.registeredDispatchStages,
        nonDispatchedStages: item.nonDispatchedStages,
        controlMode: item.controlMode,
        note: "A declared stage without a dispatcher may be an always-on mechanism, a partial prerequisite, or an unimplemented protocol; inspect implementationStatus and actualExecution.",
      })),
    disabledFormulas: trace.filter((item) => item.handlerState === "disabled"),
    pendingReviewFormulas: trace.filter((item) => item.handlerState === "pending_review"),
    unreviewedFormulas: trace.filter((item) => item.handlerState === "unreviewed"),
    unassignedFormulaIds: trace
      .filter((item) => item.compatibilityStatus !== "reviewed")
      .map((item) => item.id),
    epistemicGuard: "Hypotheses, proxies, diagnostics, and offline evaluation formulas are not direct drafting laws and must not be optimized as platform-performance truth.",
  };
}

export const DEFAULT_FORMULAS: FormulaDefinition[] = FORMULA_ROWS.map(reviewedFormulaDefinition);

export const DEFAULT_FORMULA_VERSION: FormulaVersion = createFormulaVersion({
  id: "formula_default_f01_f43",
  version: "1.6.0",
  status: "active",
  createdAt: "2026-07-14T00:00:00.000Z",
  formulas: DEFAULT_FORMULAS,
});
