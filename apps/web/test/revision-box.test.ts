import assert from "node:assert/strict";
import test from "node:test";
import { revisionBoxState, submitRevision } from "../src/lib/revision-progress";
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

test("失败:按钮恢复,文案改成重新发送", () => {
  const state = revisionBoxState(job({
    activeRevision: revision({ status: "failed", error: "模型服务暂时不可用，修改没有完成。" }),
  }));
  assert.equal(state.phase, "failed");
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.buttonLabel, "重新发送");
});

test("完成:按钮恢复", () => {
  const state = revisionBoxState(job({ activeRevision: revision({ status: "completed", progress: 100 }) }));
  assert.equal(state.phase, "done");
  assert.equal(state.buttonDisabled, false);
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

/** 记录 submitRevision 的全部副作用,便于断言"什么没有发生"。 */
function recorder(submit: () => Promise<GenerationJob>) {
  const calls = {
    instruction: "正文不要有价格" as string,
    jobs: [] as GenerationJob[],
    notices: [] as Array<{ message: string; kind: string }>,
    cleared: false,
  };
  return {
    calls,
    deps: {
      submit,
      setJob: (next: GenerationJob) => { calls.jobs.push(next); },
      setInstruction: (value: string) => { calls.instruction = value; calls.cleared = value === ""; },
      notify: (message: string, kind: "success" | "error") => { calls.notices.push({ message, kind }); },
    },
  };
}

test("受理成功:更新 job、报已受理、清空输入框", async () => {
  const next = job({ activeRevision: revision({ status: "queued", progress: 0 }) });
  const { calls, deps } = recorder(async () => next);
  await submitRevision(deps);
  assert.deepEqual(calls.jobs, [next]);
  assert.equal(calls.notices[0]?.kind, "success");
  assert.equal(calls.cleared, true, "受理成功要清空,否则用户以为没发出去");
  assert.equal(calls.instruction, "");
});

test("受理失败:保留输入框里的指令", async () => {
  // 这条锁住本任务的硬约束。原实现在 finally 里无条件 setRevision(""),失败也清空,
  // 用户得重打一遍。把清空挪回 finally 会让这条变红。
  const { calls, deps } = recorder(async () => { throw new Error("模型服务暂时不可用，修改没有完成。"); });
  await submitRevision(deps);
  assert.equal(calls.cleared, false, "失败必须保留原指令");
  assert.equal(calls.instruction, "正文不要有价格");
});

test("受理失败:绝不改动 job(演示模式兜底会污染正文)", async () => {
  const { calls, deps } = recorder(async () => { throw new Error("网关超时"); });
  await submitRevision(deps);
  assert.deepEqual(calls.jobs, [], "失败时不得写 job,正文必须原样");
});

test("受理失败:按错误提示,不说成已记录", async () => {
  const { calls, deps } = recorder(async () => { throw new Error("模型服务暂时不可用，修改没有完成。"); });
  await submitRevision(deps);
  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0]?.kind, "error");
  assert.equal(calls.notices[0]?.message, "模型服务暂时不可用，修改没有完成。");
});

test("非 Error 抛出物也给一句人话,不显示 undefined", async () => {
  const { calls, deps } = recorder(async () => { throw "字符串错误"; });
  await submitRevision(deps);
  assert.equal(calls.notices[0]?.message, "提交修改失败，请重试");
  assert.equal(calls.notices[0]?.kind, "error");
});
