import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildKnowledgeIndexMarkdown,
  buildKnowledgeLedger,
  createSectionEvidenceReferences,
  estimateTokens,
  evidenceIdForSection,
  findSupportingSectionEvidenceIds,
  indexKnowledgeSource,
  loadKnowledgeDirectory,
  sectionEvidenceText,
  selectKnowledgeContext,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("knowledge indexing", () => {
  it("indexes MD frontmatter, headings, evidence state and a stable checksum", () => {
    const document = indexKnowledgeSource({
      projectId: "p1",
      path: "facts/product.md",
      content: "---\ntitle: 产品事实\nkind: fact\nevidenceStatus: observed\nkeywords: [\"恢复\", \"边界\"]\nscope: 北京, 成人\ncaveats: 个体差异\n---\n# 核心信息\n只能确认资料明确写出的内容。",
    });
    expect(document.extension).toBe(".md");
    expect(document.metadata).toMatchObject({ title: "产品事实", kind: "fact", evidenceStatus: "observed" });
    expect(document.metadata.keywords).toEqual(expect.arrayContaining(["恢复", "边界"]));
    expect(document.headings).toEqual([{ level: 1, title: "核心信息", line: 1 }]);
    expect(document.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(document.estimatedTokens).toBeGreaterThan(0);
  });

  it("accepts only MD/TXT when recursively loading and does not follow symlinks by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-kb-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "facts"));
    await writeFile(join(root, "INDEX.md"), "# 索引", "utf8");
    await writeFile(join(root, "facts", "one.txt"), "事实一", "utf8");
    await writeFile(join(root, "ignored.json"), "{}", "utf8");
    const documents = await loadKnowledgeDirectory(root, "p1");
    expect(documents.map((item) => item.path)).toEqual(["INDEX.md", "facts/one.txt"]);
    expect(documents[0]?.isIndex).toBe(true);
  });

  it("rejects unsupported direct source extensions", () => {
    expect(() => indexKnowledgeSource({ projectId: "p", path: "facts.pdf", content: "x" })).toThrow(/Unsupported/u);
  });
});

describe("context budgeting without vectors", () => {
  const docs = [
    indexKnowledgeSource({ projectId: "p", path: "INDEX.md", content: "# 索引\n- product.md 产品与恢复\n- case.md 案例" }),
    indexKnowledgeSource({ projectId: "p", path: "facts/product.md", content: `# 恢复边界\n${"恢复条件需要逐项核实。".repeat(100)}` }),
    indexKnowledgeSource({ projectId: "p", path: "cases/case.md", content: `# 样本\n${"这只是案例不能外推。".repeat(100)}` }),
  ];

  it("injects all files in stable order when they fit", () => {
    const selected = selectKnowledgeContext({
      documents: docs,
      query: "恢复",
      budget: { maxInputTokens: 20_000, systemPromptTokens: 100, formulaPromptTokens: 100, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    expect(selected.mode).toBe("full");
    expect(selected.selectedDocumentIds).toEqual([docs[0]!.id, docs[2]!.id, docs[1]!.id]);
    expect(selected.omittedDocumentIds).toEqual([]);
    expect(selected.content.indexOf("INDEX.md")).toBeLessThan(selected.content.indexOf("facts/product.md"));
  });

  it("discloses INDEX first and prioritizes keyword-matching factual sections when over budget", () => {
    const selected = selectKnowledgeContext({
      documents: docs,
      query: "恢复条件",
      budget: { maxInputTokens: 650, systemPromptTokens: 50, formulaPromptTokens: 50, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    expect(selected.mode).toBe("progressive");
    expect(selected.sections[0]?.path).toBe("INDEX.md");
    expect(selected.sections.some((item) => item.path === "facts/product.md")).toBe(true);
    expect(selected.estimatedTokens).toBeLessThanOrEqual(selected.availableTokens);
    expect(selected.warnings.join(" ")).toMatch(/progressively/u);
  });

  it("generates a metadata index when INDEX.md is absent", () => {
    const selected = selectKnowledgeContext({
      documents: docs.slice(1),
      query: "恢复",
      budget: { maxInputTokens: 500, systemPromptTokens: 50, formulaPromptTokens: 50, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    expect(selected.mode).toBe("progressive");
    expect(selected.generatedIndex).toBe(true);
    expect(selected.sections[0]?.path).toBe("INDEX.generated.md");
    expect(selected.content).toContain("facts/product.md");
  });

  it("can explicitly use progressive disclosure even when every file would fit", () => {
    const selected = selectKnowledgeContext({
      documents: docs,
      query: "恢复",
      forceProgressive: true,
      budget: { maxInputTokens: 20_000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    expect(selected.mode).toBe("progressive");
    expect(selected.sections[0]?.path).toBe("INDEX.md");
  });

  it("builds a readable index with epistemic metadata", () => {
    const index = buildKnowledgeIndexMarkdown(docs.slice(1));
    expect(index).toContain("facts/product.md");
    expect(index).toContain("fact");
    expect(estimateTokens(index)).toBeGreaterThan(10);
  });

  it("binds claims only to disclosed supporting sections instead of every selected document", () => {
    const selected = selectKnowledgeContext({
      documents: docs,
      query: "恢复条件",
      budget: { maxInputTokens: 20_000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    const references = createSectionEvidenceReferences(docs, selected);
    const supportingIds = findSupportingSectionEvidenceIds(["恢复条件需要逐项核实"], selected);
    expect(references.length).toBeGreaterThan(1);
    expect(supportingIds).toHaveLength(1);
    const supporting = references.find((reference) => reference.id === supportingIds[0]);
    expect(supporting).toMatchObject({ path: "facts/product.md", section: "恢复边界" });
    expect(supporting?.id).toMatch(/^evidence_section_/u);
    expect(sectionEvidenceText(selected, supporting!.id)).toContain("恢复条件需要逐项核实");
    expect(references.filter((reference) => reference.path === "cases/case.md").map((reference) => reference.id)).not.toContain(supporting!.id);
  });

  it("content-addresses section evidence and refuses a 7-day claim against a 70-day source", () => {
    const firstDocument = indexKnowledgeSource({ projectId: "p", id: "stable-doc", path: "facts.md", content: "# 恢复\n恢复期为70天。" });
    const changedDocument = indexKnowledgeSource({ projectId: "p", id: "stable-doc", path: "facts.md", content: "# 恢复\n恢复期为7天。" });
    const select = (document: typeof firstDocument) => selectKnowledgeContext({
      documents: [document],
      query: "恢复期",
      budget: { maxInputTokens: 2_000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 },
    });
    const first = select(firstDocument);
    const changed = select(changedDocument);
    const firstReference = createSectionEvidenceReferences([firstDocument], first)[0]!;
    const changedReference = createSectionEvidenceReferences([changedDocument], changed)[0]!;
    expect(firstReference.id).not.toBe(changedReference.id);
    expect(firstReference).toMatchObject({ documentChecksum: firstDocument.checksum, documentVersion: firstDocument.version });
    expect(findSupportingSectionEvidenceIds(["恢复期为7天"], first)).toEqual([]);
    expect(findSupportingSectionEvidenceIds(["恢复期为7天"], changed)).toEqual([changedReference.id]);
  });
});

describe("full mode section disclosure", () => {
  const ampleBudget = { maxInputTokens: 20_000, systemPromptTokens: 10, formulaPromptTokens: 10, outputReserveTokens: 100, safetyMarginTokens: 0 };
  const multiSectionDoc = indexKnowledgeSource({
    projectId: "p",
    path: "facts/clinic.md",
    content: [
      "开篇说明：本资料仅内部使用。",
      "",
      "# 价格",
      "光子嫩肤单次 800 元。",
      "",
      "## 套餐",
      "三次套餐 2000 元。",
      "",
      "# 医生",
      "主治医生为王医生。",
      "",
      "# 恢复",
      "恢复期约 3 天。",
    ].join("\n"),
  });
  const stripSeparators = (value: string) => value.replace(/\s+/gu, "");

  it("selects every split section in document order without scoring or truncation", () => {
    const selected = selectKnowledgeContext({ documents: [multiSectionDoc], query: "价格", budget: ampleBudget });
    expect(selected.mode).toBe("full");
    expect(selected.sections.length).toBeGreaterThan(1);
    expect(selected.sections.map((section) => section.id)).toEqual([
      `${multiSectionDoc.id}:intro`,
      `${multiSectionDoc.id}:h3`,
      `${multiSectionDoc.id}:h6`,
      `${multiSectionDoc.id}:h9`,
      `${multiSectionDoc.id}:h12`,
    ]);
    expect(selected.sections.every((section) => section.score === 0 && !section.truncated)).toBe(true);
    expect(selected.selectedDocumentIds).toEqual([multiSectionDoc.id]);
    expect(selected.omittedDocumentIds).toEqual([]);
    expect(selected.warnings).toEqual([]);
    expect(selected.estimatedTokens).toBe(estimateTokens(selected.content));
  });

  it("keeps every heading and every non-separator character of the document", () => {
    const selected = selectKnowledgeContext({ documents: [multiSectionDoc], query: "价格", budget: ampleBudget });
    for (const heading of ["价格", "套餐", "医生", "恢复"]) {
      expect(selected.content).toContain(heading);
    }
    const disclosed = selected.sections.map((section) => section.content).join("");
    expect(stripSeparators(disclosed)).toBe(stripSeparators(multiSectionDoc.content));
  });

  it("creates one section-level evidence reference per section, matching evidenceIdForSection", () => {
    const selected = selectKnowledgeContext({ documents: [multiSectionDoc], query: "价格", budget: ampleBudget });
    const references = createSectionEvidenceReferences([multiSectionDoc], selected);
    expect(references.map((reference) => reference.id)).toEqual(selected.sections.map((section) => evidenceIdForSection(section)));
    expect(references.map((reference) => reference.section)).toEqual(
      selected.sections.map((section) => section.heading ?? "document"),
    );
    // The price section is now an independently citable evidence source.
    const priceSection = selected.sections.find((section) => section.heading === "价格")!;
    expect(findSupportingSectionEvidenceIds(["光子嫩肤单次 800 元"], selected)).toEqual([evidenceIdForSection(priceSection)]);
    expect(sectionEvidenceText(selected, evidenceIdForSection(priceSection))).toBe(priceSection.content);
  });

  it("gives the same section the same evidence id in full and progressive modes", () => {
    const full = selectKnowledgeContext({ documents: [multiSectionDoc], query: "价格", budget: ampleBudget });
    const progressive = selectKnowledgeContext({ documents: [multiSectionDoc], query: "价格", forceProgressive: true, budget: ampleBudget });
    expect(full.mode).toBe("full");
    expect(progressive.mode).toBe("progressive");
    const progressiveSections = progressive.sections.filter((section) => section.documentId !== "generated");
    expect(progressiveSections.map((section) => section.id).sort()).toEqual(full.sections.map((section) => section.id).sort());
    expect(progressiveSections.map((section) => evidenceIdForSection(section)).sort()).toEqual(
      full.sections.map((section) => evidenceIdForSection(section)).sort(),
    );
  });

  it("handles heading-less, plain-text and empty documents without exploding", () => {
    const plain = indexKnowledgeSource({ projectId: "p", path: "notes.txt", content: "纯文本事实，没有标题。" });
    const noHeadingMd = indexKnowledgeSource({ projectId: "p", path: "notes.md", content: "只有正文，没有任何标题。" });
    const emptyDoc = indexKnowledgeSource({ projectId: "p", path: "empty.md", content: "" });
    const selected = selectKnowledgeContext({ documents: [plain, noHeadingMd, emptyDoc], query: "事实", budget: ampleBudget });
    expect(selected.mode).toBe("full");
    expect(selected.sections.map((section) => section.id)).toEqual([
      `${emptyDoc.id}:all`,
      `${noHeadingMd.id}:all`,
      `${plain.id}:all`,
    ]);
    expect(selected.sections.find((section) => section.documentId === noHeadingMd.id)?.content).toBe(noHeadingMd.content);
    expect(selected.selectedDocumentIds).toEqual([emptyDoc.id, noHeadingMd.id, plain.id]);
    const references = createSectionEvidenceReferences([plain, noHeadingMd, emptyDoc], selected);
    expect(references.map((reference) => reference.id)).toEqual(selected.sections.map((section) => evidenceIdForSection(section)));
  });
});

describe("knowledge ledger", () => {
  it("keeps contradictory values visible, unknown as unknown, and prohibited claims separate", () => {
    const ledger = buildKnowledgeLedger([
      { id: "a", key: "恢复期", value: "3天", statement: "来源A写3天", kind: "fact", evidenceStatus: "observed", sourceIds: ["s1"], scope: [], caveats: [] },
      { id: "b", key: "恢复期", value: "7天", statement: "来源B写7天", kind: "fact", evidenceStatus: "user_supplied", sourceIds: ["s2"], scope: [], caveats: [] },
      { id: "c", key: "价格", value: null, statement: "价格是多少？", kind: "unknown", evidenceStatus: "unknown", sourceIds: [], scope: [], caveats: [] },
      { id: "d", key: "承诺", value: "百分百有效", statement: "禁止绝对承诺", kind: "prohibited", evidenceStatus: "user_supplied", sourceIds: ["policy"], scope: [], caveats: [] },
    ]);
    expect(ledger.conflicts).toHaveLength(1);
    expect(ledger.conflicts[0]).toMatchObject({ key: "恢复期", status: "unresolved" });
    expect(ledger.unknowns).toEqual(expect.arrayContaining([expect.objectContaining({ key: "价格" })]));
    expect(ledger.prohibited.map((item) => item.id)).toEqual(["d"]);
  });
});
