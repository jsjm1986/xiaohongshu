import assert from "node:assert/strict";
import test from "node:test";
import {
  countEvidenceSections,
  EVIDENCE_GROUP_COLLAPSE_THRESHOLD,
  EVIDENCE_SEARCH_THRESHOLD,
  filterEvidenceDocuments,
  partitionGapEvidenceIds,
  toggleGapEvidenceId,
} from "../src/lib/gap-evidence";
import type { KnowledgeEvidenceDocument, KnowledgeEvidenceSection } from "../src/types";

const section = (evidenceId: string, heading = "", excerpt = ""): KnowledgeEvidenceSection => ({
  evidenceId,
  sectionId: `doc:${evidenceId}`,
  heading,
  excerpt,
  charLength: excerpt.length,
  kind: "fact",
  evidenceStatus: "observed",
  caveats: [],
});

const documents: KnowledgeEvidenceDocument[] = [
  {
    id: "doc_price",
    path: "price.md",
    title: "价格口径",
    kind: "fact",
    evidenceStatus: "observed",
    sections: [section("evidence_price", "价格", "单次 6800 元，以当期确认为准"), section("evidence_recovery", "恢复期", "约 7 天，因人而异")],
  },
  {
    id: "doc_faq",
    path: "faq.md",
    title: "常见问题",
    kind: "fact",
    evidenceStatus: "user_supplied",
    sections: [section("evidence_faq", "优惠", "以当期顾问确认为准")],
  },
];

test("toggleGapEvidenceId selects and deselects without mutating the input", () => {
  const selected = ["evidence_price"];
  assert.deepEqual(toggleGapEvidenceId(selected, "evidence_faq"), ["evidence_price", "evidence_faq"]);
  assert.deepEqual(toggleGapEvidenceId(selected, "evidence_price"), []);
  assert.deepEqual(selected, ["evidence_price"], "input list must not be mutated");
  assert.deepEqual(toggleGapEvidenceId([], "evidence_price"), ["evidence_price"]);
});

test("partitionGapEvidenceIds resolves known refs and keeps stale ids visible instead of dropping them", () => {
  const partition = partitionGapEvidenceIds(["evidence_price", "evidence_deleted", "evidence_faq", "evidence_price"], documents);
  assert.deepEqual(partition.known.map((ref) => ref.evidenceId), ["evidence_price", "evidence_faq"], "deduped, selection order");
  assert.deepEqual(partition.stale, ["evidence_deleted"], "stale ids are surfaced, never silently dropped");
  assert.deepEqual(partition.known[0], { evidenceId: "evidence_price", heading: "价格", documentTitle: "价格口径" });
});

test("partitionGapEvidenceIds handles empty selection and empty catalogue", () => {
  assert.deepEqual(partitionGapEvidenceIds([], documents), { known: [], stale: [] });
  assert.deepEqual(partitionGapEvidenceIds(["evidence_price"], []), { known: [], stale: ["evidence_price"] });
});

test("filterEvidenceDocuments matches heading, excerpt, title and path; empty query returns everything", () => {
  assert.equal(filterEvidenceDocuments(documents, "").length, 2);
  assert.equal(filterEvidenceDocuments(documents, "   ").length, 2);

  const byHeading = filterEvidenceDocuments(documents, "恢复期");
  assert.deepEqual(byHeading.map((document) => document.id), ["doc_price"]);
  assert.deepEqual(byHeading[0]?.sections.map((item) => item.evidenceId), ["evidence_recovery"], "non-matching sections of the document are filtered out");

  const byExcerpt = filterEvidenceDocuments(documents, "6800");
  assert.deepEqual(byExcerpt[0]?.sections.map((item) => item.evidenceId), ["evidence_price"]);

  const byTitle = filterEvidenceDocuments(documents, "常见");
  assert.deepEqual(byTitle.map((document) => document.id), ["doc_faq"]);
  assert.equal(byTitle[0]?.sections.length, 1, "a document-level match keeps all its sections");

  const byPath = filterEvidenceDocuments(documents, "PRICE.MD");
  assert.deepEqual(byPath.map((document) => document.id), ["doc_price"], "case-insensitive path match");

  assert.deepEqual(filterEvidenceDocuments(documents, "不存在的词"), []);
});

test("countEvidenceSections sums sections across documents", () => {
  assert.equal(countEvidenceSections(documents), 3);
  assert.equal(countEvidenceSections([]), 0);
});

test("picker thresholds stay at six sections", () => {
  assert.equal(EVIDENCE_GROUP_COLLAPSE_THRESHOLD, 6);
  assert.equal(EVIDENCE_SEARCH_THRESHOLD, 6);
});
