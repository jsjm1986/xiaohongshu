import assert from "node:assert/strict";
import { test } from "node:test";
import { exportBlockReason, issueVerdict } from "../src/lib/issue-verdict.ts";

/**
 * 这些用例锁住的是一个实测缺陷:129 个未通过候选里 110 个(85%)旧实现把 warning
 * 当成了结论。下面第一个用例用的就是截图里那个候选的真实 code 序列。
 */

test("有 error 时结论必须是 error,不能挑到前面的 warning", () => {
  // 截图里「先看演示再说?」的真实顺序:前两条是 warning,第三条起才是 error
  const verdict = issueVerdict({
    valid: false,
    issues: [
      { code: "sample_body_shape_drift", severity: "warning" },
      { code: "comment_network_length_drift", severity: "warning" },
      { code: "visible_claim_not_in_ledger", severity: "error" },
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "knowledge_backed_claim_unrecorded", severity: "warning" },
      { code: "gap_resolution_not_realized", severity: "error" },
      { code: "planned_body_gap_not_realized", severity: "error" },
      { code: "planned_comment_gap_not_realized", severity: "error" },
      { code: "plan_to_copy_alignment", severity: "warning" },
      { code: "repair_parse_failed", severity: "error" },
    ],
  });
  assert.equal(verdict.publishable, false);
  // 出现 3 次的敏感宣称排在最前(同级按次数降序)
  assert.equal(verdict.headline, "敏感宣称(医疗/价格/效果)缺少事实证据");
  assert.notEqual(verdict.headline, "正文长度偏离样本形态目标");
});

test("error 与 warning 分成两组,不混在一个清单里", () => {
  const verdict = issueVerdict({
    valid: false,
    issues: [
      { code: "sample_body_shape_drift", severity: "warning" },
      { code: "ungrounded_fact", severity: "error" },
      { code: "plan_to_copy_alignment", severity: "warning" },
    ],
  });
  assert.deepEqual(verdict.blocking.map((i) => i.code), ["ungrounded_fact"]);
  assert.deepEqual(
    verdict.advisory.map((i) => i.code).sort(),
    ["plan_to_copy_alignment", "sample_body_shape_drift"],
  );
});

test("同一 code 多次出现要合并计数,而不是重复列同一句话", () => {
  const verdict = issueVerdict({
    valid: false,
    issues: [
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "sensitive_claim_without_evidence", severity: "error" },
      { code: "ungrounded_fact", severity: "error" },
    ],
  });
  assert.equal(verdict.blocking.length, 2);
  assert.equal(verdict.blocking[0]?.count, 3);
  assert.equal(verdict.blocking[1]?.count, 1);
});

test("通过校验但有提醒时,结论要同时说明两件事", () => {
  const verdict = issueVerdict({
    valid: true,
    issues: [
      { code: "comment_network_under_grown", severity: "warning" },
      { code: "plan_to_copy_alignment", severity: "warning" },
    ],
  });
  assert.equal(verdict.publishable, true);
  assert.equal(verdict.headline, "已通过可发布校验，另有 2 项建议人工核对");
  assert.equal(verdict.blocking.length, 0);
});

test("干净通过时不编造提醒数", () => {
  const verdict = issueVerdict({ valid: true, issues: [] });
  assert.equal(verdict.headline, "已通过可发布校验");
});

test("未通过但没有 error:如实说明,不假装是某条 warning 导致的", () => {
  const verdict = issueVerdict({
    valid: false,
    issues: [{ code: "sample_title_shape_drift", severity: "warning" }],
  });
  assert.equal(verdict.headline, "未通过可发布校验，1 项待人工核对");
});

test("未通过且没有任何项:不留空白结论", () => {
  const verdict = issueVerdict({ valid: false, issues: [] });
  assert.equal(verdict.headline, "未通过可发布校验，系统未给出具体项");
});

test("不可识别的 code 原样保留,不猜译也不丢", () => {
  const verdict = issueVerdict({
    valid: false,
    issues: [{ code: "brand_new_unmapped_code", severity: "error" }],
  });
  assert.equal(verdict.headline, "brand_new_unmapped_code");
});

test("连 code 都没有时退到系统原文 message", () => {
  const verdict = issueVerdict({
    valid: false,
    issues: [{ severity: "error", message: "raw engine message" }],
  });
  assert.equal(verdict.headline, "raw engine message");
});

test("validation 缺失时不炸,按未通过处理", () => {
  const verdict = issueVerdict(undefined);
  assert.equal(verdict.publishable, false);
  assert.deepEqual(verdict.blocking, []);
  assert.deepEqual(verdict.advisory, []);
});

test("publishable 认后端 valid,不按 error 数自己推断", () => {
  // 没有 error 但后端判不通过 → 仍然不可发布
  assert.equal(issueVerdict({ valid: false, issues: [{ code: "x", severity: "warning" }] }).publishable, false);
  // 有 warning 但后端判通过 → 可发布
  assert.equal(issueVerdict({ valid: true, issues: [{ code: "x", severity: "warning" }] }).publishable, true);
});

test("可发布且带建议项是主路径:advisory 不能算进 blocking", () => {
  // 库里 229 个候选有 46 个是这一态。细条据此走「可直接发布 · N 项建议核对」,
  // 不是黄色的未通过条,所以这三个值要钉住。
  const verdict = issueVerdict({ valid: true, issues: [{ severity: "warning", code: "x" }] });
  assert.equal(verdict.publishable, true);
  assert.equal(verdict.advisory.length, 1);
  assert.equal(verdict.blocking.length, 0);
});

test("导出门槛理由:可发布返回 null,不可发布指向人工确认且保留自动结论", () => {
  assert.equal(exportBlockReason(issueVerdict({ valid: true, issues: [] })), null);
  const reason = exportBlockReason(
    issueVerdict({ valid: false, issues: [{ code: "ungrounded_fact", severity: "error" }] }),
  );
  assert.match(reason ?? "", /1 项必须核对/);
  assert.match(reason ?? "", /完成人工交付确认后可复制与导出/);
  assert.match(reason ?? "", /自动校验结论仍保留/);
});
