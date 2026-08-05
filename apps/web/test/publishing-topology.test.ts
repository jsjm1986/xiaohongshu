import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPublishingTopology,
  createDefaultPublishingTopologyDraft,
  createSimplePublishingTopologyDraft,
} from "../src/lib/publishing-topology";
import type { GenerateInput } from "../src/types";

const input: GenerateInput = {
  projectId: "p1",
  mode: "simple",
  audienceStage: "collecting",
  entryPoint: "search",
};

test("默认使用选题驱动的自动用户情景且不提交作者事实", () => {
  const result = applyPublishingTopology(input, createDefaultPublishingTopologyDraft());
  assert.equal(result.publishingTopology, "creative_scenario");
  assert.deepEqual(result.authorFacts, []);
  assert.equal(result.authorFactsConfirmed, false);
  assert.equal(result.authorContext, undefined);
});

test("简单模式二选一会生成对应请求合同", () => {
  const creative = applyPublishingTopology(input, createSimplePublishingTopologyDraft("creative_scenario"));
  const institution = applyPublishingTopology(input, createSimplePublishingTopologyDraft("institution_owned"));
  assert.equal(creative.publishingTopology, "creative_scenario");
  assert.equal(institution.publishingTopology, "institution_owned");
  assert.deepEqual(institution.authorFacts, []);
});

test("机构账号覆盖会清空隐藏的作者事实", () => {
  const result = applyPublishingTopology(input, {
    topology: "institution_owned",
    narrative: "不会提交",
    facts: [{ id: "af1", statement: "不会提交", category: "current_state" }],
    confirmed: true,
  });
  assert.equal(result.publishingTopology, "institution_owned");
  assert.deepEqual(result.authorFacts, []);
  assert.equal(result.authorFactsConfirmed, false);
});

test("个人作者模式要求原子事实与明确确认", () => {
  const empty = { topology: "confirmed_individual_author" as const, facts: [], confirmed: false };
  assert.throws(() => applyPublishingTopology(input, empty), /作者事实/u);
  const fact = { id: "af1", statement: "我还没决定", category: "current_state" as const };
  assert.throws(() => applyPublishingTopology(input, { ...empty, facts: [fact] }), /确认/u);
  assert.throws(() => applyPublishingTopology(input, { ...empty, facts: [fact, { ...fact, statement: "" }], confirmed: true }), /空白/u);
});

test("个人作者多条原子事实被规范化，客户端不提交确认人和时间", () => {
  const result = applyPublishingTopology(input, {
    topology: "confirmed_individual_author",
    facts: [
      { id: "af1", statement: "  我目前还没决定  ", category: "current_state" },
      { id: "af2", statement: "  我只能周末安排  ", category: "constraint" },
    ],
    confirmed: true,
  });
  assert.equal(result.publishingTopology, "confirmed_individual_author");
  assert.deepEqual(result.authorFacts, [
    { id: "af1", statement: "我目前还没决定", category: "current_state" },
    { id: "af2", statement: "我只能周末安排", category: "constraint" },
  ]);
  assert.equal(result.authorFactsConfirmed, true);
  assert.equal(result.authorContext, undefined);
  assert.equal("confirmedBy" in result.authorFacts![0]!, false);
  assert.equal("confirmedAt" in result.authorFacts![0]!, false);
});
