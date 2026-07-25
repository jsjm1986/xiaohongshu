import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, LONG_WAIT_SECONDS, waitStatus } from "../src/lib/wait-status.ts";
import type { GenerationJob } from "../src/types.ts";

const BASE = Date.parse("2026-07-25T10:00:00.000Z");

function job(patch: Partial<GenerationJob>): GenerationJob {
  return {
    id: "j1",
    projectId: "p1",
    topic: "选题",
    mode: "simple",
    status: "queued",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...patch,
  } as GenerationJob;
}

test("queued 显示排队位次与总数", () => {
  const status = waitStatus(job({ queuePosition: 3, queueLength: 24 }), BASE);
  assert.equal(status.phase, "queued");
  assert.equal(status.headline, "排队中 · 第 3/24 位");
});

test("只有位次没有总数时不写出一个空的分母", () => {
  const status = waitStatus(job({ queuePosition: 3 }), BASE);
  assert.equal(status.headline, "排队中 · 第 3 位");
});

test("总数小于位次(队列刚被消费)时退回只报位次,不显示 3/1", () => {
  const status = waitStatus(job({ queuePosition: 3, queueLength: 1 }), BASE);
  assert.equal(status.headline, "排队中 · 第 3 位");
});

test("拿不到位次时说明在等名额,而不是留空", () => {
  const status = waitStatus(job({}), BASE);
  assert.equal(status.headline, "排队中 · 等待空闲名额");
});

test("running 用进度百分比,不再报排队位次", () => {
  const status = waitStatus(job({ status: "running", progress: 44, queuePosition: 2 }), BASE);
  assert.equal(status.phase, "running");
  assert.equal(status.headline, "生成中 · 44%");
});

test("终态返回 settled,调用方据此不显示等待卡片", () => {
  assert.equal(waitStatus(job({ status: "completed" }), BASE).phase, "settled");
  assert.equal(waitStatus(job({ status: "failed" }), BASE).phase, "settled");
});

test("已等待时长按 createdAt 算,跟着传入的 now 走", () => {
  const status = waitStatus(job({}), BASE + 42 * 60 * 1000);
  assert.equal(status.elapsedLabel, "已等待 42 分钟");
});

test("超过 1 小时用「小时+分钟」,不写成 95 分钟", () => {
  const status = waitStatus(job({}), BASE + 95 * 60 * 1000);
  assert.equal(status.elapsedLabel, "已等待 1 小时 35 分钟");
});

test("createdAt 缺失或不可解析时不产出 NaN 文案", () => {
  assert.equal(waitStatus(job({ createdAt: undefined }), BASE).elapsedLabel, undefined);
  assert.equal(waitStatus(job({ createdAt: "不是时间" }), BASE).elapsedLabel, undefined);
});

test("批量任务的经验耗时区间比单篇长:排队是主要成本", () => {
  const single = waitStatus(job({}), BASE).etaLabel;
  const batch = waitStatus(job({ batchId: "b1" }), BASE).etaLabel;
  assert.equal(single, "单篇任务通常 10–30 分钟");
  assert.equal(batch, "批量任务通常 30–90 分钟");
});

test("等待超过阈值置 longWait,终态不置", () => {
  assert.equal(waitStatus(job({}), BASE + (LONG_WAIT_SECONDS - 1) * 1000).longWait, false);
  assert.equal(waitStatus(job({}), BASE + LONG_WAIT_SECONDS * 1000).longWait, true);
  assert.equal(
    waitStatus(job({ status: "completed" }), BASE + LONG_WAIT_SECONDS * 2000).longWait,
    false,
  );
});

test("formatDuration 覆盖秒/分/整小时", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(59), "59 秒");
  assert.equal(formatDuration(60), "1 分钟");
  assert.equal(formatDuration(7200), "2 小时");
});
