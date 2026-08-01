import { conservativeEvidenceSupport } from '@content-agent/agent-core';

export type EvidenceValidationReason =
  | 'missing_ledger'
  | 'invalid_source_status'
  | 'unknown_evidence'
  | 'unsupported_statement';

export interface AnalysisEvidenceEntry {
  id: string;
  text: string;
  sourceStatus: 'supplied_fact' | 'approved_observation' | 'inference' | 'unknown';
}

export interface EvidenceValidationIssue {
  path: string;
  statement: string;
  reason: EvidenceValidationReason;
  evidenceIds?: string[];
}

export interface AnalysisEvidenceValidationResult {
  intelligence: Record<string, unknown>;
  blueprintModules: Record<string, unknown>;
  issues: EvidenceValidationIssue[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function supportedByCatalog(
  statement: string,
  evidenceIds: string[],
  catalog: ReadonlyMap<string, AnalysisEvidenceEntry>,
  expectedStatus: AnalysisEvidenceEntry['sourceStatus'],
): boolean {
  return evidenceIds.some((id) => {
    const evidence = catalog.get(id);
    return evidence?.sourceStatus === expectedStatus
      ? conservativeEvidenceSupport(statement, evidence.text)
      : false;
  });
}

function validateSource(
  path: string,
  statement: string,
  source: Record<string, unknown>,
  catalog: ReadonlyMap<string, AnalysisEvidenceEntry>,
  requireTextSupport: boolean,
): EvidenceValidationIssue | undefined {
  const status = String(source.status ?? source.sourceStatus ?? '');
  if (status !== 'supplied_fact' && status !== 'approved_observation') return undefined;
  const evidenceIds = strings(source.evidenceIds);
  if (!evidenceIds.length || evidenceIds.some((id) => !catalog.has(id))) {
    return { path, statement, reason: 'unknown_evidence', evidenceIds };
  }
  if (evidenceIds.some((id) => catalog.get(id)?.sourceStatus !== status)) {
    return { path, statement, reason: 'invalid_source_status', evidenceIds };
  }
  if (!requireTextSupport) return undefined;
  if (!statement || !supportedByCatalog(statement, evidenceIds, catalog, status)) {
    return { path, statement, reason: 'unsupported_statement', evidenceIds };
  }
  return undefined;
}

function sourceStatement(parent: Record<string, unknown>): string {
  const direct = [parent.statement, parent.label, parent.displayRole, parent.name, parent.title]
    .find((value) => typeof value === 'string' && value.trim());
  if (typeof direct === 'string') return direct.trim();
  for (const key of ['terms', 'goals', 'constraints', 'actionConditions', 'observableActions']) {
    const values = strings(parent[key]);
    if (values.length) return values.join('；');
  }
  return '';
}

function sanitizeBlueprintSources(
  value: unknown,
  catalog: ReadonlyMap<string, AnalysisEvidenceEntry>,
  issues: EvidenceValidationIssue[],
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => sanitizeBlueprintSources(item, catalog, issues, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const parent = value as Record<string, unknown>;
  const source = record(parent.source);
  if (Object.keys(source).length) {
    const statement = sourceStatement(parent);
    const requireTextSupport = !path.startsWith('blueprintModules.knowledge_map.entries[');
    const issue = validateSource(`${path}.source`, statement, source, catalog, requireTextSupport);
    if (issue) {
      issues.push(issue);
      source.status = 'inference';
      source.evidenceIds = [];
      parent.source = source;
    }
  }
  for (const [key, child] of Object.entries(parent)) {
    if (key !== 'source') sanitizeBlueprintSources(child, catalog, issues, `${path}.${key}`);
  }
}

export function validateAnalysisEvidence(input: {
  intelligence: Record<string, unknown>;
  blueprintModules: Record<string, unknown>;
  evidence: readonly AnalysisEvidenceEntry[];
}): AnalysisEvidenceValidationResult {
  const intelligence = structuredClone(input.intelligence);
  const blueprintModules = structuredClone(input.blueprintModules);
  const catalog = new Map(input.evidence.map((entry) => [entry.id, entry]));
  const issues: EvidenceValidationIssue[] = [];
  const ledger = Array.isArray(intelligence.evidenceLedger)
    ? intelligence.evidenceLedger.map(record)
    : [];
  const verifiedFacts = strings(intelligence.verifiedFacts);
  const validFacts: string[] = [];

  for (let index = 0; index < verifiedFacts.length; index += 1) {
    const fact = verifiedFacts[index]!;
    const path = `intelligence.verifiedFacts[${index}]`;
    const item = ledger.find((candidate) => typeof candidate.statement === 'string'
      && normalized(candidate.statement) === normalized(fact));
    if (!item) {
      issues.push({ path, statement: fact, reason: 'missing_ledger' });
      continue;
    }
    const sourceStatus = String(item.sourceStatus ?? item.status ?? '');
    if (sourceStatus !== 'supplied_fact' && sourceStatus !== 'approved_observation') {
      issues.push({ path, statement: fact, reason: 'invalid_source_status', evidenceIds: strings(item.evidenceIds) });
      continue;
    }
    const evidenceIds = strings(item.evidenceIds);
    if (!evidenceIds.length || evidenceIds.some((id) => !catalog.has(id))) {
      issues.push({ path, statement: fact, reason: 'unknown_evidence', evidenceIds });
      continue;
    }
    if (evidenceIds.some((id) => catalog.get(id)?.sourceStatus !== sourceStatus)) {
      issues.push({ path, statement: fact, reason: 'invalid_source_status', evidenceIds });
      continue;
    }
    if (!supportedByCatalog(fact, evidenceIds, catalog, sourceStatus)) {
      issues.push({ path, statement: fact, reason: 'unsupported_statement', evidenceIds });
      continue;
    }
    validFacts.push(fact);
  }

  intelligence.verifiedFacts = validFacts;
  sanitizeBlueprintSources(blueprintModules, catalog, issues, 'blueprintModules');
  intelligence.evidenceValidationIssues = issues;
  return { intelligence, blueprintModules, issues };
}

export function blueprintEvidenceIssues(input: {
  moduleKey: string;
  data: Record<string, unknown>;
  evidence: readonly AnalysisEvidenceEntry[];
}): EvidenceValidationIssue[] {
  const clone = structuredClone(input.data);
  const issues: EvidenceValidationIssue[] = [];
  sanitizeBlueprintSources(
    clone,
    new Map(input.evidence.map((entry) => [entry.id, entry])),
    issues,
    `blueprintModules.${input.moduleKey}`,
  );
  return issues;
}
