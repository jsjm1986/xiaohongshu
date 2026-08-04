import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPublishingTopology,
  DEFAULT_PUBLISHING_TOPOLOGY_DRAFT,
} from "../src/lib/publishing-topology";
import type { GenerateInput } from "../src/types";

const input: GenerateInput = {
  projectId: "p1",
  mode: "simple",
  audienceStage: "collecting",
  entryPoint: "search",
};

test("默认冻结机构发布且不携带作者事实", () => {
  const result = applyPublishingTopology(input, DEFAULT_PUBLISHING_TOPOLOGY_DRAFT);
  assert.equal(result.publishingTopology, "institution_owned");
  assert.deepEqual(result.authorContext, { status: "not_provided", facts: [] });
});

test("个人作者模式要求事实、确认人和有效确认时间", () => {
  const base = { ...DEFAULT_PUBLISHING_TOPOLOGY_DRAFT, topology: "confirmed_individual_author" as const };
  assert.throws(() => applyPublishingTopology(input, base), /作者事实/u);
  assert.throws(() => applyPublishingTopology(input, { ...base, factStatement: "我还没决定" }), /确认人/u);
  assert.throws(() => applyPublishingTopology(input, { ...base, factStatement: "我还没决定", confirmedBy: "u1" }), /确认时间/u);
});

test("个人作者事实被规范化并冻结进请求", () => {
  const result = applyPublishingTopology(input, {
    topology: "confirmed_individual_author",
    factStatement: "  我目前还没决定  ",
    factCategory: "current_state",
    confirmedBy: " user-1 ",
    confirmedAt: "2026-08-04T12:00",
  });
  assert.equal(result.publishingTopology, "confirmed_individual_author");
  assert.deepEqual(result.authorContext?.facts[0], {
    id: "author_fact_1",
    statement: "我目前还没决定",
    category: "current_state",
    confirmedBy: "user-1",
    confirmedAt: new Date("2026-08-04T12:00").toISOString(),
  });
});
