import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateDiffView, prototypeLabel } from "../src/lib/candidate-diff.ts";
import type { ReaderCandidate } from "../src/types.ts";

type Src = Pick<ReaderCandidate, "id" | "seed" | "strategy" | "validation">;

/** 取自实测:同一任务三个候选的真实表达轴。 */
const REAL_THREE: Src[] = [
  {
    id: "c0", seed: 221104226,
    validation: { valid: true, repairAttempts: 0, issues: [] },
    strategy: { label: "长期效果（受控交叉编排）", prototype: "live_moment", openingMode: "acknowledge_concern", narrativeMode: "dialogue", bodyRole: "explain", commentMode: "none", voice: "professional_courteous" },
  },
  {
    id: "c1", seed: 920609278,
    validation: { valid: false, repairAttempts: 1, issues: [{ severity: "error", message: "x" }] },
    strategy: { label: "价格咨询（受控交叉编排）", prototype: "narrow_request", openingMode: "direct", narrativeMode: "question-answer", bodyRole: "contrast", commentMode: "attentive", voice: "transparent" },
  },
  {
    id: "c2", seed: 588367285,
    validation: { valid: true, repairAttempts: 0, issues: [] },
    strategy: { label: "政策确认（受控交叉编排）", prototype: "process_log", openingMode: "clarify", narrativeMode: "sequential", bodyRole: "source_attribution", commentMode: "none", voice: "reassuring_but_honest" },
  },
];

test("三个候选不再都叫「随机候选」,标签用 prototype 的中文短词", () => {
  const view = candidateDiffView(REAL_THREE);
  const labels = view.tabs.map((t) => t.label);
  assert.equal(new Set(labels).size, 3, `标签应互不相同,实际 ${labels.join(" / ")}`);
  // prototype 是唯一的封闭枚举,映射出来是 4 字词,放 tab 上刚好
  assert.deepEqual(labels, ["现场片刻", "一个窄问题", "过程记录"]);
});

test("标签不用开放词表的轴:那些实测能长到 30 字,截断后看不出区别", () => {
  const long = "用一个项目适配的普通生活动作或熟人一句话承载变化，不写项目说明书";
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { prototype: "process_log", bodyRole: long } },
    { id: "b", seed: 2, strategy: { prototype: "live_moment", bodyRole: "explain" } },
  ]);
  assert.deepEqual(view.tabs.map((t) => t.label), ["过程记录", "现场片刻"]);
  // 全文仍在差异表里
  assert.equal(view.differingAxes.find((a) => a.label === "正文角色")!.values[0], long);
});

test("只列真正不同的轴,全同的轴不占版面", () => {
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { prototype: "live_moment", bodyRole: "explain", voice: "same" } },
    { id: "b", seed: 2, strategy: { prototype: "live_moment", bodyRole: "contrast", voice: "same" } },
  ]);
  assert.deepEqual(view.differingAxes.map((a) => a.label), ["正文角色"]);
});

test("prototype 是封闭枚举,译成中文", () => {
  const view = candidateDiffView(REAL_THREE);
  const axis = view.differingAxes.find((a) => a.label === "表层原型")!;
  assert.deepEqual(axis.values, ["现场片刻", "一个窄问题", "过程记录"]);
});

test("开放词表的轴原样显示,不猜译", () => {
  // bodyRole 实测有 70+ 种取值,包含模型产出的中文自由文本
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { bodyRole: "列出可能加项（拆结、药浴）及收费标准。" } },
    { id: "b", seed: 2, strategy: { bodyRole: "explain" } },
  ]);
  const axis = view.differingAxes.find((a) => a.label === "正文角色")!;
  assert.deepEqual(axis.values, ["列出可能加项（拆结、药浴）及收费标准。", "explain"]);
});

test("未识别的 prototype 原样返回,不丢", () => {
  assert.equal(prototypeLabel("process_log"), "过程记录");
  assert.equal(prototypeLabel("brand_new_prototype"), "brand_new_prototype");
  assert.equal(prototypeLabel(undefined), undefined);
});

test("没有 prototype 时用策略名,过长才截断", () => {
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { label: "预期反转/重新考虑（受控交叉编排）", bodyRole: "x" } },
    { id: "b", seed: 2, strategy: { label: "短名", bodyRole: "y" } },
  ]);
  assert.ok(view.tabs[0]!.label.endsWith("…"), `应截断,实际 ${view.tabs[0]!.label}`);
  assert.equal(view.tabs[1]!.label, "短名");
});

test("单个候选没有「差异」可言", () => {
  const view = candidateDiffView([REAL_THREE[0]!]);
  assert.deepEqual(view.differingAxes, []);
  assert.equal(view.identical, true);
  assert.equal(view.tabs.length, 1);
});

test("表达轴全同时标记 identical,让界面不显示差异条", () => {
  const s = { prototype: "live_moment", bodyRole: "explain", narrativeMode: "dialogue", openingMode: "direct", commentMode: "none", voice: "v" };
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { ...s } },
    { id: "b", seed: 2, strategy: { ...s } },
  ]);
  assert.equal(view.identical, true);
  assert.deepEqual(view.differingAxes, []);
});

test("没有表达轴的历史包退到策略名,再退到「版本N」", () => {
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { label: "只有名字" } },
    { id: "b", seed: 2 },
  ]);
  assert.equal(view.tabs[0]!.label, "只有名字");
  assert.equal(view.tabs[1]!.label, "版本2");
});

test("部分成功时优先使用原始候选槽位，不把候选3压缩成候选2", () => {
  const view = candidateDiffView([
    { id: "a", candidateIndex: 0, seed: 1 },
    { id: "c", candidateIndex: 2, seed: 3 },
  ]);
  assert.deepEqual(view.tabs.map((tab) => tab.label), ["版本1", "版本3"]);
});

test("可发布性带进 tab,让用户切换前就知道哪个能用", () => {
  const view = candidateDiffView(REAL_THREE);
  assert.deepEqual(view.tabs.map((t) => t.publishable), [true, false, true]);
});

test("seed 保留:同款重跑要靠它", () => {
  const view = candidateDiffView(REAL_THREE);
  assert.deepEqual(view.tabs.map((t) => t.seed), [221104226, 920609278, 588367285]);
});

test("某个候选缺某个轴时,该轴仍算有差异并留 undefined 占位", () => {
  const view = candidateDiffView([
    { id: "a", seed: 1, strategy: { voice: "transparent" } },
    { id: "b", seed: 2, strategy: {} },
  ]);
  const axis = view.differingAxes.find((a) => a.label === "语气")!;
  assert.deepEqual(axis.values, ["transparent", undefined]);
});
