import assert from "node:assert/strict";
import { test } from "node:test";
import { commentFunctionLabel, commentSectionView, gapNameMap, identityLabel, stageLabel } from "../src/lib/comment-view.ts";
import type { ReaderComment } from "../src/types.ts";

const REAL: ReaderComment[] = [
  {
    id: "t-1",
    question: "我也怕这个！医生怎么说？",
    answer: "面诊的时候医生提过，说会留一点缓冲。",
    function: "clarify",
    postingIdentity: "staff",
    personaRole: "skeptical_returning_reader",
    stage: "comparing",
    gap: "gap-1",
    boundary: "具体看个人结构",
    nextStep: "先补充可信来源",
    simulated: true,
    displayName: "小李",
    followUps: [{ question: "要加钱吗", answer: "不加" }],
  },
  {
    id: "t-2",
    question: "有没有失败案例",
    answer: "我们不代填，得看医生评估。",
    function: "verification",
    postingIdentity: "expert",
    stage: "hesitating",
    gap: "gap-2",
    simulated: true,
    followUps: [],
  },
];

test("提问方标模拟读者、回答方标可追责身份", () => {
  const view = commentSectionView(REAL)!;
  assert.equal(view.rows[0]?.askerLabel, "模拟读者");
  assert.equal(view.rows[0]?.answererLabel, "员工身份");
  assert.equal(view.rows[1]?.answererLabel, "专业人士");
});

test("线程功能与读者阶段译成中文", () => {
  const view = commentSectionView(REAL)!;
  assert.equal(view.rows[0]?.functionLabel, "澄清条件");
  assert.equal(view.rows[0]?.stageLabel, "正在比较");
  assert.equal(view.rows[1]?.functionLabel, "要求核验");
  assert.equal(view.rows[1]?.stageLabel, "犹豫中");
});

test("缺口显示名称,查不到就不显示 UUID", () => {
  const names = new Map([["gap-1", "班组更换"]]);
  const view = commentSectionView(REAL, names)!;
  assert.equal(view.rows[0]?.gapLabel, "班组更换");
  assert.equal(view.rows[1]?.gapLabel, undefined);
});

test("追问条数单独统计:实测只有 42/834 有追问,大多数不该显示追问区", () => {
  const view = commentSectionView(REAL)!;
  assert.equal(view.withFollowUps, 1);
  assert.equal(view.rows[1]?.followUps.length, 0);
});

test("汇总回答方身份种类,说明「答复都由谁发」", () => {
  const view = commentSectionView(REAL)!;
  assert.deepEqual(view.identitySummary, ["员工身份", "专业人士"]);
});

test("personaRole 是开放文本,原样保留不猜译", () => {
  const view = commentSectionView(REAL)!;
  assert.equal(view.rows[0]?.personaRole, "skeptical_returning_reader");
});

test("simulated 缺失时不断言成真实读者", () => {
  const view = commentSectionView([{ question: "q", answer: "a", followUps: [] }])!;
  assert.equal(view.rows[0]?.askerLabel, "模拟读者");
});

test("simulated=false 时如实说明未标记,不谎称是模拟", () => {
  const view = commentSectionView([{ question: "q", answer: "a", simulated: false, followUps: [] }])!;
  assert.equal(view.rows[0]?.askerLabel, "未标记为模拟");
});

test("未识别的身份/功能/阶段原样返回", () => {
  assert.equal(identityLabel("brand_new_identity"), "brand_new_identity");
  assert.equal(commentFunctionLabel("brand_new_fn"), "brand_new_fn");
  assert.equal(stageLabel("brand_new_stage"), "brand_new_stage");
  assert.equal(identityLabel(undefined), undefined);
});

test("四种发布身份都有中文", () => {
  assert.equal(identityLabel("author"), "作者本人");
  assert.equal(identityLabel("publisher"), "发布账号");
  assert.equal(identityLabel("staff"), "员工身份");
  assert.equal(identityLabel("expert"), "专业人士");
});

test("六种线程功能都有中文", () => {
  for (const [code, label] of [
    ["clarify", "澄清条件"], ["verification", "要求核验"], ["counterexample", "反例追问"],
    ["surface_gap", "暴露缺口"], ["next_step", "下一步动作"], ["answer", "直接回答"],
  ] as const) {
    assert.equal(commentFunctionLabel(code), label);
  }
});

test("没有评论时返回 null", () => {
  assert.equal(commentSectionView(undefined), null);
  assert.equal(commentSectionView([]), null);
});

test("gapNameMap 以 gapCards 优先,台账兜底", () => {
  const map = gapNameMap(
    [{ gapId: "g-1", label: "卡片名" }],
    [{ gapId: "g-1", label: "台账名" }, { gapId: "g-2", label: "只有台账" }],
  );
  assert.equal(map.get("g-1"), "卡片名");
  assert.equal(map.get("g-2"), "只有台账");
  assert.equal(gapNameMap().size, 0);
});
