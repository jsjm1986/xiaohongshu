import assert from "node:assert/strict";
import test from "node:test";
import { isRevisionInFlight, revisionDoneSummary, revisionFailureNotice, revisionStageText } from "../src/lib/revision-progress";
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
  assert.equal(revisionStageText(95), "质检与落库");
  assert.equal(revisionStageText(100), "完成");
});

/*
 * 档位集合必须与后端真正推进的进度值一一对应。
 *
 * 后端只推 10/25/40/95(processRevision 里的全部 revisionProgress 调用点)。原来多出的
 * 70「证据锚定复核」与 85「声明合规判定」描述的是 engine.ts 里条件触发的调用,后端一次
 * 都不会推到那两个值——UI 声称做了一件可能被 if 跳过的事,踩「不过度声称」的线。
 *
 * 断言写成「40 与 94 之间同一句」:重新插入一档中间文案就会变红。
 */
test("不存在后端到不了的档位:40 到 95 之间只有一句文案", () => {
  const between = [40, 55, 69, 70, 71, 84, 85, 86, 94].map(revisionStageText);
  assert.deepEqual(
    [...new Set(between)], ["重写受影响的环节"],
    `40~94 只该有一句文案,实际：${[...new Set(between)].join(" / ")}`,
  );
  const all = [0, 10, 25, 40, 70, 85, 95, 100].map(revisionStageText).join(" ");
  assert.ok(!all.includes("证据锚定复核"), `不可达档位不该留着：${all}`);
  assert.ok(!all.includes("声明合规判定"), `不可达档位不该留着：${all}`);
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

/*
 * 阅读页的失败可见性。
 *
 * 异步化后这条路径一度完全不可见:任务失败时局部 loading 已清、WaitCard 因
 * job.status 仍是 completed 而返回 null,activeRevision.error 一处都没渲染。用户只看到
 * 内容没变、按钮解锁,不知道失败也不知道额度退没退,大概率再提交一次。
 */
test("失败任务给出可显示的原因,原样透出后端文案", () => {
  const message = "模型服务暂时不可用，修改没有完成。已退还本次额度，请稍后重试；若持续失败请联系客服。";
  assert.equal(revisionFailureNotice(task({ status: "failed", error: message })), message);
});

test("非失败态不出提示:不能把在跑或已完成说成失败", () => {
  for (const status of ["queued", "running", "completed"] as const) {
    assert.equal(revisionFailureNotice(task({ status })), undefined, `${status} 不该出失败提示`);
  }
  assert.equal(revisionFailureNotice(undefined), undefined);
});

test("后端没给原因时只说没完成,不猜原因也不声称退了额度", () => {
  for (const error of [null, "", "   "]) {
    const notice = revisionFailureNotice(task({ status: "failed", error }))!;
    assert.match(notice, /没有完成/u);
    assert.ok(!notice.includes("额度"), `拿不到原因时不该声称退额度：${notice}`);
  }
});
