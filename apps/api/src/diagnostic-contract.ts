import { isDeepStrictEqual } from 'node:util';
import {
  F32_DIAGNOSTIC_CONTRACT,
  F33_DIAGNOSTIC_CONTRACT,
  FORMULA_EXECUTION_HANDLER_REGISTRY,
  type ContentDiagnostic,
  type DiagnosticProxyComponent,
  type DiagnosticProxyReport,
  type ParameterImpactReport,
} from '@content-agent/agent-core';
type JsonObject = Record<string, unknown>;

const DIAGNOSTIC_FORMULA_IDS = new Set(['F32', 'F33']);
const SEMANTICS = 'ordered_component_review_metadata';
const EMPHASIS_SEMANTICS = 'display_and_manual_review_priority_only';
const DIAGNOSTIC_METADATA = {
  F32: {
    contract: F32_DIAGNOSTIC_CONTRACT,
    name: '正文分项检查清单',
    warning: '正文分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分。',
    parameterPrefix: 'body',
    channels: ['N.imageBrief', 'N.title', 'N.body'],
  },
  F33: {
    contract: F33_DIAGNOSTIC_CONTRACT,
    name: '评论分项检查清单',
    warning: '评论分项尚无校准观测，全部保持 unknown/null；emphasis 只控制显示与人工检查优先级，禁止合成总分；线程数和规则通过数不是质量分。',
    parameterPrefix: 'comment',
    channels: ['Cref'],
  },
} as const;
const PROXY_KEYS = [
  'formulaId', 'formulaSemanticFingerprint', 'name', 'semantics', 'status', 'evaluationStatus',
  'aggregateValue', 'scoreProduced', 'evidenceStatus', 'aggregation', 'components', 'warning',
  'diagnosticContract',
] as const;
const CONTENT_DIAGNOSTIC_KEYS = [
  'formulaId', 'formulaSemanticFingerprint', 'name', 'status', 'explanation', 'semantics',
  'evaluationStatus', 'aggregateValue', 'scoreProduced', 'parameterIds', 'channels',
  'evidenceStatus', 'aggregation', 'components', 'diagnosticContract',
] as const;
const COMPONENT_KEYS = [
  'id', 'label', 'emphasis', 'displayOrder', 'manualReviewRank', 'emphasisSemantics', 'direction',
  'status', 'evaluationStatus', 'value', 'source', 'evidenceStatus', 'boundary',
] as const;
const SOURCE_KEYS = ['kind', 'reference'] as const;

export interface HistoricalDiagnosticUnknown {
  status: 'unknown';
  reason: 'historical_contract_incomplete';
  missingFields: string[];
}

/**
 * Public API normalization is deliberately fail-closed. New Core reports pass
 * through unchanged. Historical F32/F33 records with an incomplete contract
 * keep their descriptive text, but never inherit current meaning, evidence
 * status, emphasis, order, component values, or a score by name matching.
 */
export function normalizeDiagnosticForApi(raw: unknown): JsonObject {
  const diagnostic = cloneObject(raw);
  if (!isDiagnosticFormulaId(diagnostic.formulaId)) return diagnostic;
  const missingFields = diagnosticMissingFields(diagnostic);
  if (!missingFields.length) return diagnostic;
  return historicalDiagnostic(diagnostic.formulaId, diagnostic.components, missingFields, 'content');
}

export function normalizeDiagnosticProxyForApi(raw: unknown): JsonObject {
  const proxy = cloneObject(raw);
  if (!isDiagnosticFormulaId(proxy.formulaId)) return proxy;
  const missingFields = proxyMissingFields(proxy);
  if (!missingFields.length) return proxy;
  return historicalDiagnostic(proxy.formulaId, proxy.components, missingFields, 'proxy');
}

export function normalizeImpactReportForApi(raw: unknown): JsonObject {
  const report = cloneObject(raw);
  if (!Array.isArray(report.diagnosticProxies)) return report;
  report.diagnosticProxies = report.diagnosticProxies.map(normalizeDiagnosticProxyForApi);
  return report;
}

export function normalizeContentPackageForApi<T>(raw: T): T {
  if (!isRecord(raw)) return raw;
  const pkg = structuredClone(raw) as JsonObject;
  if (Array.isArray(pkg.diagnostics)) {
    pkg.diagnostics = pkg.diagnostics.map(normalizeDiagnosticForApi);
  }
  if (isRecord(pkg.impactReport)) {
    pkg.impactReport = normalizeImpactReportForApi(pkg.impactReport);
  }
  return pkg as T;
}

export function diagnosticProxiesFromImpactReport(raw: unknown): JsonObject[] {
  const report = normalizeImpactReportForApi(raw);
  return Array.isArray(report.diagnosticProxies)
    ? report.diagnosticProxies.filter(isRecord)
    : [];
}

/** Compile-time guards: keep this adapter aligned with the Core contract. */
export function assertCoreDiagnosticTypes(
  _report: DiagnosticProxyReport,
  _component: DiagnosticProxyComponent,
  _diagnostic: ContentDiagnostic,
  _impact: ParameterImpactReport,
): void {}

function historicalDiagnostic(
  formulaId: 'F32' | 'F33',
  rawComponents: unknown,
  missingFields: string[],
  kind: 'content' | 'proxy',
): JsonObject {
  const components = Array.isArray(rawComponents)
    ? rawComponents.slice(0, 10).map((component, index) => historicalComponent(formulaId, component, index))
    : [];
  const neutralMessage = '历史诊断合同不完整，语义、强调值、顺序与分项值均为 unknown；不得据此生成分数或质量结论。';
  return {
    formulaId,
    formulaSemanticFingerprint: null,
    name: `${formulaId} 历史诊断`,
    semantics: 'unknown',
    status: 'unknown',
    evaluationStatus: 'not_evaluated',
    aggregateValue: null,
    scoreProduced: false,
    evidenceStatus: 'unknown',
    aggregation: 'unknown',
    components,
    diagnosticContract: null,
    contractStatus: 'unknown',
    unknown: {
      status: 'unknown',
      reason: 'historical_contract_incomplete',
      missingFields: [...missingFields],
    } satisfies HistoricalDiagnosticUnknown,
    ...(kind === 'content'
      ? { explanation: neutralMessage, parameterIds: [], channels: [] }
      : { warning: neutralMessage }),
  };
}

function historicalComponent(
  formulaId: 'F32' | 'F33',
  raw: unknown,
  index: number,
): JsonObject {
  const component = cloneObject(raw);
  const allowedIds = new Set<string>(DIAGNOSTIC_METADATA[formulaId].contract.componentDefinitions.map((item) => item.id));
  const safeId = typeof component.id === 'string' && allowedIds.has(component.id)
    ? component.id
    : `historical_component_${index + 1}`;
  return {
    id: safeId,
    label: `历史分项 ${index + 1}`,
    emphasis: null,
    displayOrder: null,
    manualReviewRank: null,
    emphasisSemantics: 'unknown',
    direction: 'unknown',
    status: 'unknown',
    evaluationStatus: 'not_evaluated',
    value: null,
    source: null,
    evidenceStatus: 'unknown',
    boundary: null,
    contractStatus: 'unknown',
  };
}

function diagnosticMissingFields(value: JsonObject): string[] {
  const missing = proxyMissingFields(value);
  const formulaId = isDiagnosticFormulaId(value.formulaId) ? value.formulaId : undefined;
  if (!hasExactKeys(value, CONTENT_DIAGNOSTIC_KEYS)) missing.push('contentDiagnostic.keys');
  if (!formulaId) return unique(missing);
  const metadata = DIAGNOSTIC_METADATA[formulaId];
  if (value.name !== metadata.name) missing.push('name');
  if (value.explanation !== metadata.warning) missing.push('explanation');
  const components = Array.isArray(value.components) ? value.components.filter(isRecord) : [];
  const expectedParameterIds = components.map((component) => `${metadata.parameterPrefix}_diagnostic_${String(component.id)}`);
  if (!arrayEquals(value.parameterIds, expectedParameterIds)) missing.push('parameterIds');
  if (!arrayEquals(value.channels, [...metadata.channels])) missing.push('channels');
  return unique(missing);
}

function proxyMissingFields(value: JsonObject): string[] {
  const missing: string[] = [];
  if (!hasExactKeys(value, PROXY_KEYS) && !hasExactKeys(value, CONTENT_DIAGNOSTIC_KEYS)) missing.push('report.keys');
  const formulaId = isDiagnosticFormulaId(value.formulaId) ? value.formulaId : undefined;
  if (!formulaId) return unique([...missing, 'formulaId']);
  const metadata = DIAGNOSTIC_METADATA[formulaId];
  const expectedFingerprint = formulaId
    ? FORMULA_EXECUTION_HANDLER_REGISTRY[formulaId]?.semanticFingerprint
    : undefined;
  if (typeof value.formulaSemanticFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.formulaSemanticFingerprint)
    || value.formulaSemanticFingerprint !== expectedFingerprint) missing.push('formulaSemanticFingerprint');
  if (value.semantics !== SEMANTICS) missing.push('semantics');
  if (value.status !== 'unknown') missing.push('status');
  if (value.evaluationStatus !== 'not_evaluated') missing.push('evaluationStatus');
  if (value.aggregateValue !== null) missing.push('aggregateValue');
  if (value.scoreProduced !== false) missing.push('scoreProduced');
  if (value.evidenceStatus !== 'unvalidated_proxy') missing.push('evidenceStatus');
  if (value.aggregation !== 'components_only') missing.push('aggregation');
  if (!isDeepStrictEqual(value.diagnosticContract, metadata.contract)) missing.push('diagnosticContract');
  if (hasExactKeys(value, PROXY_KEYS)) {
    if (value.name !== metadata.name) missing.push('name');
    if (value.warning !== metadata.warning) missing.push('warning');
  }
  if (!Array.isArray(value.components)) {
    missing.push('components');
  } else if (
    value.components.some((component) => !isCurrentComponent(component))
    || !componentsMatchContract(value.components, formulaId)
  ) {
    missing.push('components.contract');
  }
  return unique(missing);
}

function isCurrentComponent(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return hasExactKeys(raw, COMPONENT_KEYS)
    && typeof raw.id === 'string'
    && typeof raw.label === 'string'
    && typeof raw.emphasis === 'number'
    && Number.isFinite(raw.emphasis)
    && raw.emphasis >= 0
    && raw.emphasis <= 100
    && Number.isInteger(raw.displayOrder)
    && Number(raw.displayOrder) >= 1
    && Number.isInteger(raw.manualReviewRank)
    && Number(raw.manualReviewRank) >= 1
    && raw.emphasisSemantics === EMPHASIS_SEMANTICS
    && ['positive', 'cost', 'risk'].includes(String(raw.direction))
    && raw.status === 'unknown'
    && raw.evaluationStatus === 'not_evaluated'
    && raw.value === null
    && !Object.hasOwn(raw, 'score')
    && !Object.hasOwn(raw, 'qualityScore')
    && isRecord(raw.source)
    && hasExactKeys(raw.source, SOURCE_KEYS)
    && raw.source.kind === 'not_observed'
    && raw.source.reference === null
    && raw.evidenceStatus === 'unvalidated_proxy'
    && typeof raw.boundary === 'string'
    && raw.boundary.length > 0;
}

function componentsMatchContract(
  componentsRaw: unknown[],
  formulaId: 'F32' | 'F33',
): boolean {
  const components = componentsRaw.filter(isRecord);
  const definitions = DIAGNOSTIC_METADATA[formulaId].contract.componentDefinitions;
  const expectedIds = definitions.map((definition) => definition.id);
  if (components.length !== expectedIds.length || definitions.length !== expectedIds.length) return false;
  if (new Set(components.map((component) => component.id)).size !== expectedIds.length) return false;
  if (!expectedIds.every((id) => components.some((component) => component.id === id))) return false;

  for (const component of components) {
    const definition = definitions.find((candidate) => candidate.id === component.id);
    if (!definition
      || component.label !== definition.label
      || component.direction !== definition.direction
      || component.evidenceStatus !== definition.evidenceStatus
      || component.boundary !== definition.boundary) return false;
  }

  if (!components.every((component, index) => component.displayOrder === index + 1)) return false;
  const canonicalIndex = new Map<string, number>(expectedIds.map((id, index) => [id, index]));
  const expectedOrder = [...components].sort((left, right) => {
    const emphasisDelta = Number(right.emphasis) - Number(left.emphasis);
    return emphasisDelta || Number(canonicalIndex.get(String(left.id))) - Number(canonicalIndex.get(String(right.id)));
  });
  if (!components.every((component, index) => component.id === expectedOrder[index]?.id)) return false;
  for (let index = 0; index < components.length; index += 1) {
    const previous = components[index - 1];
    const expectedRank = previous && previous.emphasis === components[index]?.emphasis
      ? previous.manualReviewRank
      : index + 1;
    if (components[index]?.manualReviewRank !== expectedRank) return false;
  }
  return true;
}

function isDiagnosticFormulaId(value: unknown): value is 'F32' | 'F33' {
  return typeof value === 'string' && DIAGNOSTIC_FORMULA_IDS.has(value);
}

function cloneObject(value: unknown): JsonObject {
  return isRecord(value) ? structuredClone(value) : {};
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function arrayEquals(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function unique(values: string[]): string[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}
