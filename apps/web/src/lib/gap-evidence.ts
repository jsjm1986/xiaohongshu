import type { KnowledgeEvidenceDocument } from "../types";

/**
 * Pure helpers for the gap editor's evidence picker (Cref contract v1.1:
 * answer evidence is picked from knowledge sections, never typed by hand).
 *
 * Extracted from IntelligentSimpleFlow.tsx so the select / deselect /
 * stale-reference behaviour can be unit tested without the browser-only
 * globals api.ts touches at module scope.
 *
 * Shared contract: a saved evidence id the current knowledge sections no
 * longer contain (old id, or the document was edited/deleted) is a stale
 * reference. It must stay visible and be removed explicitly — the v1.1
 * failure mode was silently dropping it, which downgraded a "verified"
 * answer without the operator noticing.
 */

export interface SelectedEvidenceRef {
  evidenceId: string;
  heading: string;
  documentTitle: string;
}

export interface GapEvidencePartition {
  /** Saved ids resolvable against the current knowledge sections, in selection order. */
  known: SelectedEvidenceRef[];
  /** Saved ids the current sections no longer contain; kept visible, never dropped. */
  stale: string[];
}

/** A document group collapses when it has more sections than this. */
export const EVIDENCE_GROUP_COLLAPSE_THRESHOLD = 6;

/** The search box appears once the whole picker has more sections than this. */
export const EVIDENCE_SEARCH_THRESHOLD = 6;

/** Toggle one evidence id in the gap's selection; returns a new list, never mutates. */
export const toggleGapEvidenceId = (selected: readonly string[], evidenceId: string): string[] =>
  selected.includes(evidenceId)
    ? selected.filter((item) => item !== evidenceId)
    : [...selected, evidenceId];

/** Split saved evidence ids into refs resolvable against current sections and stale ones. */
export const partitionGapEvidenceIds = (
  selected: readonly string[],
  documents: readonly KnowledgeEvidenceDocument[],
): GapEvidencePartition => {
  const index = new Map<string, SelectedEvidenceRef>();
  for (const document of documents) {
    for (const section of document.sections) {
      index.set(section.evidenceId, {
        evidenceId: section.evidenceId,
        heading: section.heading,
        documentTitle: document.title,
      });
    }
  }
  const known: SelectedEvidenceRef[] = [];
  const stale: string[] = [];
  for (const evidenceId of new Set(selected)) {
    const ref = index.get(evidenceId);
    if (ref) known.push(ref);
    else stale.push(evidenceId);
  }
  return { known, stale };
};

/** Total section count across documents (drives the search/collapse affordances). */
export const countEvidenceSections = (documents: readonly KnowledgeEvidenceDocument[]): number =>
  documents.reduce((total, document) => total + document.sections.length, 0);

/**
 * Case-insensitive search over document title/path and section heading/excerpt.
 * A document-level match keeps all its sections; an empty query returns everything.
 */
export const filterEvidenceDocuments = (
  documents: readonly KnowledgeEvidenceDocument[],
  query: string,
): KnowledgeEvidenceDocument[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...documents];
  return documents
    .map((document) => {
      if (document.title.toLowerCase().includes(needle) || document.path.toLowerCase().includes(needle)) {
        return document;
      }
      const sections = document.sections.filter((section) =>
        section.heading.toLowerCase().includes(needle) || section.excerpt.toLowerCase().includes(needle));
      return sections.length ? { ...document, sections } : null;
    })
    .filter((document): document is KnowledgeEvidenceDocument => Boolean(document));
};
