import assert from "node:assert/strict";
import test from "node:test";
import { demoGenerations } from "../src/lib/fixtures";
import {
  diagnosticsFromValidationIssues,
  generationRecordNotice,
  ordinaryDiagnosticsForDisplay,
} from "../src/lib/generation-record";
import type { Candidate } from "../src/types";

const baseCandidate: Candidate = {
  id: "candidate",
  title: "title",
  body: "body",
  tags: [],
  comments: [],
};

test("fallback diagnostics ignore uncontracted subjective quality judgments", () => {
  const candidate: Candidate = {
    ...baseCandidate,
    diagnostics: [
      { name: "自然表达", status: "pass" },
      { name: "真实表达", status: "pass" },
      { name: "认知差异度", status: "pass" },
      { name: "平台适配", status: "warn", message: "主观判断" },
    ],
    validation: { valid: true, repairAttempts: 0, issues: [] },
  };

  assert.deepEqual(ordinaryDiagnosticsForDisplay(candidate, true), []);
});

test("fallback renders only diagnostics derived from explicit validation issues", () => {
  const issues: NonNullable<Candidate["validation"]>["issues"] = [
    { code: "forbidden_claim", severity: "error", message: "出现禁止承诺" },
    { code: "manual_review", severity: "warning", message: "需要人工复核来源" },
  ];
  const candidate: Candidate = {
    ...baseCandidate,
    diagnostics: [{ name: "平台适配", status: "pass" }],
    validation: { valid: false, repairAttempts: 0, issues },
  };

  const visible = ordinaryDiagnosticsForDisplay(candidate, true);
  assert.deepEqual(visible, diagnosticsFromValidationIssues(issues));
  assert.deepEqual(visible.map((item) => item.name), ["系统硬约束问题", "系统复核警告"]);
  assert.deepEqual(visible.map((item) => item.status), ["fail", "warn"]);
  assert.ok(visible.every((item) => item.status !== "pass"));
});

test("demo fixture diagnostics have a one-to-one validation issue source", () => {
  for (const job of demoGenerations) {
    for (const candidate of job.candidates || []) {
      const issues = candidate.validation?.issues || [];
      assert.deepEqual(candidate.diagnostics || [], diagnosticsFromValidationIssues(issues));
      assert.ok((candidate.diagnostics || []).every((item) =>
        !["信息缺口覆盖", "事实可追溯", "自然表达", "真实表达", "认知差异度", "平台适配"].includes(item.name),
      ));
    }
  }
});

test("fallback provenance explicitly says it is demo data without a real record", () => {
  const notice = generationRecordNotice(true);
  assert.equal(notice.isFallback, true);
  assert.match(notice.label, /演示数据.*未连接真实生成记录/u);
  assert.match(notice.detail, /不代表服务端已经生成、校验或保存/u);
  assert.doesNotMatch(`${notice.label}${notice.detail}`, /系统校验快照已记录/u);
});
