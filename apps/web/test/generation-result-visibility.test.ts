import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/GenerationResultPage.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("服务器执行轨迹不出现在用户界面", () => {
  assert.doesNotMatch(page, /GenerationExecutionTracePanel|服务器执行轨迹|api\.generations\.trace/u);
  assert.doesNotMatch(api, /\/api\/generations\/\$\{encodeURIComponent\(id\)\}\/trace/u);
  assert.doesNotMatch(css, /generation-execution-trace/u);
});

test("全部候选未通过时仍展示草稿，人工确认后按候选解锁交付", () => {
  assert.doesNotMatch(page, /if \(deliveryState\.allRejected\)/u);
  assert.match(page, /<h2>\{selected\.title\}<\/h2>/u);
  assert.match(page, /selected\.body[\s\S]*?split\("\\n"\)/u);
  assert.match(page, /selected\.comments\.map/u);
  assert.match(page, /const deliverable = publishable \|\| manuallyConfirmed/u);
  assert.match(page, /disabled=\{!deliverable\}/u);
  assert.match(page, /我已逐条核对事实、证据、身份与风险/u);
  assert.match(page, /确认仅绑定当前用户与当前候选/u);
  assert.match(page, /setManualConfirmChecked\(false\)/u);
  assert.match(page, /自动校验未通过 · 确认后可复制与导出/u);
});
