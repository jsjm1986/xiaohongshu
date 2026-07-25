import assert from "node:assert/strict";
import { test } from "node:test";
import { factLedgerView, locateInText } from "../src/lib/fact-ledger.ts";
import type { ReaderCandidate } from "../src/types.ts";

function reasoning(entries: ReaderCandidate["reasoning"]): Pick<ReaderCandidate, "reasoning"> {
  return { reasoning: entries };
}

test("按落点通道分组,并给出每组有据条数", () => {
  const view = factLedgerView(reasoning([
    { statement: "正文一句", status: "hypothesis", field: "body", evidenceIds: [] },
    { statement: "正文两句", status: "fact", field: "body", evidenceIds: ["e-1"] },
    { statement: "标题句", status: "hypothesis", field: "title", evidenceIds: [] },
  ]))!;
  assert.deepEqual(view.groups.map((g) => g.label), ["标题", "正文"]);
  const body = view.groups.find((g) => g.label === "正文")!;
  assert.equal(body.total, 2);
  assert.equal(body.groundedCount, 1);
});

test("标成 fact 但没有证据编号的不算有据", () => {
  const view = factLedgerView(reasoning([
    { statement: "有据", status: "fact", field: "body", evidenceIds: ["e-1"] },
    { statement: "空口", status: "fact", field: "body", evidenceIds: [] },
  ]))!;
  assert.equal(view.groundedCount, 1);
  const items = view.groups[0]!.items;
  assert.equal(items.find((i) => i.statement === "有据")?.grounded, true);
  assert.equal(items.find((i) => i.statement === "空口")?.grounded, false);
});

test("全部无证据时结论直说,不含糊", () => {
  const view = factLedgerView(reasoning([
    { statement: "a", status: "hypothesis", field: "body", evidenceIds: [] },
    { statement: "b", status: "hypothesis", field: "body", evidenceIds: [] },
  ]))!;
  assert.equal(view.headline, "2 句陈述全部没有证据支撑，属于假设或推断");
});

test("有据时结论给出比例", () => {
  const view = factLedgerView(reasoning([
    { statement: "a", status: "fact", field: "body", evidenceIds: ["e"] },
    { statement: "b", status: "hypothesis", field: "body", evidenceIds: [] },
    { statement: "c", status: "hypothesis", field: "body", evidenceIds: [] },
  ]))!;
  assert.equal(view.headline, "3 句陈述里 1 句有证据支撑");
});

test("状态译成中文,并区分色调", () => {
  const view = factLedgerView(reasoning([
    { statement: "a", status: "fact", field: "body", evidenceIds: ["e"] },
    { statement: "b", status: "hypothesis", field: "body", evidenceIds: [] },
    { statement: "c", status: "sample", field: "body", evidenceIds: [] },
    { statement: "d", status: "inference", field: "body", evidenceIds: [] },
  ]))!;
  const byText = new Map(view.groups[0]!.items.map((i) => [i.statement, i]));
  assert.equal(byText.get("a")?.statusText, "有证据的事实");
  assert.equal(byText.get("a")?.tone, "ok");
  assert.equal(byText.get("b")?.statusText, "假设");
  assert.equal(byText.get("b")?.tone, "warn");
  assert.equal(byText.get("c")?.statusText, "来自样本/范式");
  assert.equal(byText.get("c")?.tone, "muted");
  assert.equal(byText.get("d")?.statusText, "推断");
});

test("评论的提问与回答分成两组:field 才分得清,location 分不清", () => {
  const view = factLedgerView(reasoning([
    { statement: "问", status: "hypothesis", location: "Cref.thread", field: "question", evidenceIds: [] },
    { statement: "答", status: "hypothesis", location: "Cref.thread", field: "answer", evidenceIds: [] },
  ]))!;
  assert.deepEqual(view.groups.map((g) => g.label), ["评论提问", "评论回答"]);
});

test("没有 field 的历史条目归到「其他」,不丢也不假装能定位", () => {
  const view = factLedgerView(reasoning([
    { statement: "老包条目", status: "hypothesis", location: "N.body", evidenceIds: [] },
  ]))!;
  assert.equal(view.groups[0]?.label, "其他");
  assert.equal(view.groups[0]?.items[0]?.fieldLabel, undefined);
});

test("未识别的状态原样显示,不当成有据", () => {
  const view = factLedgerView(reasoning([
    { statement: "a", status: "brand_new_status", field: "body", evidenceIds: ["e"] },
  ]))!;
  assert.equal(view.groups[0]?.items[0]?.statusText, "brand_new_status");
  assert.equal(view.groups[0]?.items[0]?.grounded, false);
});

test("分组顺序按阅读顺序:标题→正文→图片→标签→评论", () => {
  const view = factLedgerView(reasoning([
    { statement: "e", status: "hypothesis", field: "answer", evidenceIds: [] },
    { statement: "d", status: "hypothesis", field: "hashtags", evidenceIds: [] },
    { statement: "c", status: "hypothesis", field: "imageBrief", evidenceIds: [] },
    { statement: "b", status: "hypothesis", field: "body", evidenceIds: [] },
    { statement: "a", status: "hypothesis", field: "title", evidenceIds: [] },
  ]))!;
  assert.deepEqual(view.groups.map((g) => g.label), ["标题", "正文", "图片说明", "标签", "评论回答"]);
});

test("没有标注(历史包)返回 null", () => {
  assert.equal(factLedgerView(undefined), null);
  assert.equal(factLedgerView({ reasoning: [] }), null);
});

test("locateInText 精确匹配才给位置,不做模糊匹配", () => {
  const body = "卫生间墙角这两天渗水，给客服打了电话。保修范围没说清。";
  const hit = locateInText(body, "保修范围没说清。")!;
  assert.equal(body.slice(hit.start, hit.end), "保修范围没说清。");
  assert.equal(locateInText(body, "保修范围 没说清"), null);
  assert.equal(locateInText("", "x"), null);
  assert.equal(locateInText(body, ""), null);
});
