import assert from "node:assert/strict";
import test from "node:test";

import { resolveReaderStateView } from "../src/lib/reader-state.js";
import type { AudienceStateSeedProxy, LegacyReaderStateProxy } from "../src/types.js";

const hypothesis = (level: "low" | "medium" | "high", range: [number, number], basis: string) => ({
  level,
  range,
  calibrated: false as const,
  source: "stage_heuristic" as const,
  basis,
});

const scenario = (patch: Partial<AudienceStateSeedProxy> = {}): AudienceStateSeedProxy => ({
  entry: "search",
  stage: "collecting",
  preContactKnown: [],
  availableEvidence: ["项目证据 A"],
  hypothesizedGaps: ["需要补什么信息？"],
  readerConstraints: [],
  availableBoundaries: ["不能承诺统一结果"],
  history: { status: "unknown", items: [] },
  stateHypotheses: {
    skepticism: hypothesis("medium", [0.34, 0.66], "仅按 collecting 阶段形成。"),
    fatigue: hypothesis("low", [0, 0.33], "仅按 collecting 阶段形成。"),
    closureNeed: hypothesis("high", [0.67, 1], "仅按 collecting 阶段形成。"),
  },
  status: "hypothesis",
  calibrationStatus: "unvalidated",
  ...patch,
});

const detail = (view: ReturnType<typeof resolveReaderStateView>, id: string) => {
  const item = view.details.find((candidate) => candidate.id === id);
  assert.ok(item, `missing detail ${id}`);
  return item;
};

test("scenario keeps user-known information separate from agent-available evidence", () => {
  const view = resolveReaderStateView(scenario());

  assert.equal(view.kind, "scenario");
  assert.equal(detail(view, "pre-contact-known").value, "未提供");
  assert.equal(detail(view, "available-evidence").value, "项目证据 A");
  assert.doesNotMatch(detail(view, "pre-contact-known").value, /项目证据 A/u);
  assert.match(detail(view, "available-evidence").explanation, /不代表读者/u);
  assert.match(detail(view, "history").value, /unknown/u);
});

test("scenario renders every supplied field and uncalibrated hypothesis basis", () => {
  const view = resolveReaderStateView(scenario({
    preContactKnown: ["读者已明确知道 A"],
    readerConstraints: ["只能周末安排"],
    history: { status: "provided", items: ["比较过方案 B"] },
  }));

  assert.equal(detail(view, "pre-contact-known").value, "读者已明确知道 A");
  assert.equal(detail(view, "reader-constraints").value, "只能周末安排");
  assert.equal(detail(view, "available-boundaries").value, "不能承诺统一结果");
  assert.equal(detail(view, "hypothesized-gaps").value, "需要补什么信息？");
  assert.equal(detail(view, "history").value, "比较过方案 B");
  assert.deepEqual(view.hypotheses.map((item) => [item.level, item.range]), [
    ["中", "0.34–0.66"],
    ["低", "0–0.33"],
    ["高", "0.67–1"],
  ]);
  assert.ok(view.hypotheses.every((item) => item.basis.includes("collecting")));
  assert.match(view.notice, /尚未标定/u);
  assert.match(view.notice, /不是概率/u);
});

test("provided empty history remains distinct from unknown history", () => {
  const view = resolveReaderStateView(scenario({ history: { status: "provided", items: [] } }));
  assert.equal(detail(view, "history").value, "已明确提供为空");
  assert.doesNotMatch(detail(view, "history").value, /unknown/u);
});

test("legacy snapshots never relabel known as pre-contact knowledge", () => {
  const legacy: LegacyReaderStateProxy = {
    stage: "collecting",
    known: ["可能来自项目知识的旧字段"],
    perceivedGaps: ["旧缺口"],
    constraints: ["来源未区分的约束"],
    skepticism: 0.8,
  };
  const view = resolveReaderStateView(legacy);

  assert.equal(view.kind, "legacy");
  assert.match(detail(view, "legacy-known").label, /来源未区分/u);
  assert.match(detail(view, "legacy-known").explanation, /不能视为读者接触前已知/u);
  assert.match(detail(view, "legacy-skepticism").value, /未标定数值/u);
  assert.match(view.notice, /不是概率/u);
  assert.equal(view.hypotheses.length, 0);
});
