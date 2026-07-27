import assert from "node:assert/strict";
import test from "node:test";
import { revisionBoxState } from "../src/lib/revision-progress";
import type { GenerationJob, RevisionTask } from "../src/types";

function revision(patch: Partial<RevisionTask> = {}): RevisionTask {
  return {
    id: "rev-1", jobId: "job-1", candidateId: "cand-1", instruction: "正文不要有价格",
    status: "running", progress: 40, attemptCount: 0, error: null,
    rerunChannels: [], resultPackageId: null,
    createdAt: "2026-07-27T14:00:00.000Z", updatedAt: "2026-07-27T14:01:00.000Z", completedAt: null,
    ...patch,
  };
}

function job(patch: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job-1", projectId: "p1", topic: "选题", mode: "simple", status: "completed",
    ...patch,
  } as GenerationJob;
}

test("没有修改任务时是空闲态,按钮可用", () => {
  const state = revisionBoxState(job());
  assert.equal(state.phase, "idle");
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.buttonLabel, "发送修改要求");
});

test("进行中:按钮禁用并改文案", () => {
  const state = revisionBoxState(job({ activeRevision: revision({ status: "running" }) }));
  assert.equal(state.phase, "in_flight");
  assert.equal(state.buttonDisabled, true);
  assert.equal(state.buttonLabel, "修改中…");
  assert.equal(state.task?.progress, 40);
});

test("排队中同样算进行中", () => {
  const state = revisionBoxState(job({ activeRevision: revision({ status: "queued", progress: 0 }) }));
  assert.equal(state.phase, "in_flight");
  assert.equal(state.buttonDisabled, true);
});

test("失败:按钮恢复,且要求保留输入框里的指令", () => {
  // 原实现在 finally 里无条件 setRevision(""),失败也清空,用户得重打一遍。
  const state = revisionBoxState(job({
    activeRevision: revision({ status: "failed", error: "模型服务暂时不可用，修改没有完成。" }),
  }));
  assert.equal(state.phase, "failed");
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.keepInstruction, true, "失败必须保留原指令");
});

test("完成:按钮恢复,指令可以清空", () => {
  const state = revisionBoxState(job({ activeRevision: revision({ status: "completed", progress: 100 }) }));
  assert.equal(state.phase, "done");
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.keepInstruction, false);
});

test("只认当前候选的修改任务", () => {
  // 侧边栏改的是"当前选中的候选";别的候选在改不该锁住这个按钮。
  const state = revisionBoxState(job({ activeRevision: revision({ candidateId: "别的候选" }) }), "cand-1");
  assert.equal(state.phase, "idle");
  assert.equal(state.buttonDisabled, false);
});

test("传了候选 id 且匹配时正常进入进行中", () => {
  const state = revisionBoxState(job({ activeRevision: revision({ candidateId: "cand-1" }) }), "cand-1");
  assert.equal(state.phase, "in_flight");
});
