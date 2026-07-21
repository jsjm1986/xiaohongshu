import assert from "node:assert/strict";
import { test } from "node:test";
import { nextExperimentStatus, releaseBindingSummary, safeResearchUrl } from "../src/lib/research-governance";

test("research URLs reject executable protocols", () => {
  assert.equal(safeResearchUrl("javascript:alert(1)"), null);
  assert.equal(safeResearchUrl("not a url"), null);
  assert.equal(safeResearchUrl("https://example.org/paper")?.startsWith("https://example.org"), true);
});

test("experiment progression is explicit and release bindings stay countable", () => {
  assert.equal(nextExperimentStatus("draft"), "preregistered");
  assert.equal(nextExperimentStatus("preregistered"), "running");
  assert.equal(nextExperimentStatus("running"), "completed");
  assert.equal(nextExperimentStatus("archived"), null);
  assert.equal(releaseBindingSummary({
    bindings: { datasetSnapshotIds: ["d"], experimentResultIds: ["r1", "r2"], calibrationProposalIds: [] },
  } as any), "1 个数据快照 · 2 个实验结果 · 0 个校准提案");
});
