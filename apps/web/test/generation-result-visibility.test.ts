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

test("全部候选未通过时仍展示草稿，只有可复核候选能人工解锁，硬阻断必须修复", () => {
  assert.doesNotMatch(page, /if \(deliveryState\.allRejected\)/u);
  assert.match(page, /<h2>\{selected\.title\}<\/h2>/u);
  assert.match(page, /selected\.body[\s\S]*?split\("\\n"\)/u);
  assert.match(page, /selected\.comments\.map/u);
  assert.match(page, /const deliverable = candidateDeliverable\(/u);
  assert.match(page, /const reviewable = readiness === "human_reviewable"/u);
  assert.match(page, /reviewable && \(/u);
  assert.match(page, /manuallyConfirmed \? "已人工确认，可复制与导出"/u);
  assert.match(page, /我已核对事实、证据、身份与风险/u);
  assert.match(page, /仅限当前用户与候选，自动校验结论保留/u);
  assert.match(page, /setManualConfirmChecked\(false\)/u);
  assert.match(page, /存在硬阻断 · 必须修复/u);
});

test("结果页把校验、人工确认和运行版本压缩为按需展开信息", () => {
  assert.match(page, /<details className="validation-summary">/u);
  assert.match(page, /<details className="generation-release-proof">/u);
  assert.doesNotMatch(page, /没有候选通过自动校验，可以怎么用/u);
  assert.match(page, /manual-delivery-confirmation__action--ready/u);
  assert.match(page, />复制全部<\/Button>/u);
  assert.match(page, /api\.generations\.exportUrl\(job\.id, selected\.id/u);
  assert.doesNotMatch(page, /没有候选通过自动校验，可以怎么用/u);
  assert.match(css, /\.manual-delivery-confirmation \{[^}]*display: flex/u);
  assert.match(css, /\.manual-delivery-confirmation\.is-confirmed/u);
});


test("部分候选成功时按实际数量展示，不把降级交付误报成完整三候选", () => {
  assert.match(page, /const candidateCount = job\?\.candidates\?\.length \?\? 0/u);
  assert.match(page, /const partiallyGenerated = candidateCount > 0 && candidateCount < 3/u);
  assert.match(page, /<h2>\{candidateCount\} 个候选版本<\/h2>/u);
  assert.match(page, /目标生成 3 个，实际完成 \$\{candidateCount\} 个/u);
  assert.match(page, /部分生成完成/u);
  assert.match(page, /对比 \{candidateCount\} 个候选/u);
  assert.match(page, /candidate\.candidateIndex \+ 1/u);
  assert.match(css, /repeat\(var\(--candidate-count, 3\), 1fr\)/u);
});


test("正式交付降级原因在首屏单独展示，而不是埋在一般 warning 中", () => {
  assert.match(page, /formalReviewIssues/u);
  assert.match(page, /issue\.disposition === "review"/u);
  assert.match(page, /model_not_invoked/u);
  assert.match(page, /gap_evidence_binding_degraded/u);
  assert.match(page, /required_information_not_realized/u);
  assert.match(page, /当前是可查看草稿，不是可直接交付成品/u);
  assert.match(css, /\.formal-delivery-review/u);
});
