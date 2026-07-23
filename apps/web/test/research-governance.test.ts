import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentTransitions, releaseBindingSummary, safeResearchUrl } from "../src/lib/research-governance";

test("research URLs reject executable protocols", () => {
  assert.equal(safeResearchUrl("javascript:alert(1)"), null);
  assert.equal(safeResearchUrl("not a url"), null);
  assert.equal(safeResearchUrl("https://example.org/paper")?.startsWith("https://example.org"), true);
});

test("experiment progression is explicit and release bindings stay countable", () => {
  assert.deepEqual(experimentTransitions("draft"), ["preregistered", "rejected", "archived"]);
  assert.deepEqual(experimentTransitions("preregistered"), ["running", "rejected", "archived"]);
  assert.deepEqual(experimentTransitions("running"), ["completed", "rejected"]);
  assert.deepEqual(experimentTransitions("archived"), []);
  assert.equal(releaseBindingSummary({
    bindings: { datasetSnapshotIds: ["d"], experimentResultIds: ["r1", "r2"], calibrationProposalIds: [] },
  } as any), "1 个数据快照 · 2 个实验结果 · 0 个校准提案");
});
