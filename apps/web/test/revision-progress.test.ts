import assert from "node:assert/strict";
import test from "node:test";
import { isRevisionInFlight, revisionDoneSummary, revisionStageText } from "../src/lib/revision-progress";
import type { RevisionTask } from "../src/types";

function task(patch: Partial<RevisionTask> = {}): RevisionTask {
  return {
    id: "rev-1", jobId: "job-1", candidateId: "cand-1", instruction: "正文不要有价格",
    status: "running", progress: 40, attemptCount: 0, error: null,
    rerunChannels: ["N.body", "Cref"], resultPackageId: null,
    createdAt: "2026-07-27T14:00:00.000Z", updatedAt: "2026-07-27T14:01:00.000Z", completedAt: null,
    ...patch,
  };
}

/**
 * 阶段文案独立于首次生成的 progressStageText:后者说的是「解析选题」「生成初稿」,
 * 套到 revise 上会说谎——revise 不解析选题、不生成初稿,它只重跑受影响的通道。
 */
test("阶段文案覆盖 revise 的真实里程碑", () => {
  assert.equal(revisionStageText(0), "排队等待中");
  assert.equal(revisionStageText(10), "分析修改影响范围");
  assert.equal(revisionStageText(25), "载入知识与证据");
  assert.equal(revisionStageText(40), "重写受影响的环节");
  assert.equal(revisionStageText(70), "证据锚定复核");
  assert.equal(revisionStageText(85), "声明合规判定");
  assert.equal(revisionStageText(95), "质检与落库");
  assert.equal(revisionStageText(100), "完成");
});

test("progress 缺失按排队处理,不假装在跑", () => {
  assert.equal(revisionStageText(undefined), "排队等待中");
});

test("文案不复用首次生成的措辞", () => {
  // revise 不做这两件事;出现这些词说明误用了 progressStageText。
  const all = [0, 10, 25, 40, 70, 85, 95, 100].map(revisionStageText).join(" ");
  assert.ok(!all.includes("选题"), `不该出现「选题」：${all}`);
  assert.ok(!all.includes("初稿"), `不该出现「初稿」：${all}`);
});

test("进行中判定:只有 queued/running 算在跑", () => {
  assert.equal(isRevisionInFlight(task({ status: "queued" })), true);
  assert.equal(isRevisionInFlight(task({ status: "running" })), true);
  assert.equal(isRevisionInFlight(task({ status: "completed" })), false);
  assert.equal(isRevisionInFlight(task({ status: "failed" })), false);
  assert.equal(isRevisionInFlight(undefined), false);
});

test("完成提示列出实际重跑的通道", () => {
  const summary = revisionDoneSummary(task({ status: "completed", progress: 100, rerunChannels: ["N.body", "Cref"] }));
  assert.match(summary, /修改完成/u);
  assert.match(summary, /正文/u, "通道要翻成人话,不裸露 N.body");
  assert.match(summary, /评论区/u);
  assert.ok(!summary.includes("N.body"), `不该裸露内部通道名：${summary}`);
});

test("没有通道信息时不编造范围", () => {
  const summary = revisionDoneSummary(task({ status: "completed", rerunChannels: [] }));
  assert.match(summary, /修改完成/u);
  assert.ok(!summary.includes("已更新"), `拿不到通道就不该声称更新了什么：${summary}`);
});
