import type { CandidateQualityStatus, ContentValidationIssue } from "./types.js";
export type { CandidateQualityStatus } from "./types.js";

export const CANDIDATE_QUALITY_STATUS_LABELS: Readonly<Record<CandidateQualityStatus, string>> = Object.freeze({
  passed: "校验通过",
  needs_review: "建议复核（可复制导出）",
  blocked: "硬阻断（不可交付）",
});

/**
 * 交付硬门禁政策 —— 全系统唯一权威来源。
 *
 * 这份白名单是产品合规承诺的物理载体:命中即阻断复制/导出/只读 API 读取。
 * 它曾有三份平行实现(agent-core 权威版 / web 手抄 29 个 code 靠注释对齐 /
 * harness 独立词表),web 副本一旦漏抄新增 code,被阻断内容就会从前端复制
 * 出口漏走。现在抽成**零运行时依赖**的独立模块并通过包的 `./delivery-policy`
 * 子路径导出:api 与 web 消费同一份(浏览器打包安全——本文件只含纯逻辑与
 * 类型导入,不碰 node 内建模块,新增依赖前先想清楚这一条)。
 *
 * Publication is permissive by default. Only mechanically provable integrity
 * failures may block a model-generated candidate. Any semantic, editorial,
 * completeness, policy, wording, range, grounding or AI-judge conclusion that
 * is not listed here is review-only — including future codes added elsewhere.
 *
 * This is intentionally an allowlist, not a downgrade list: a newly introduced
 * validator can never silently become a publication gate merely by emitting an
 * error or `disposition: block`.
 */
export const NON_OVERRIDABLE_CONTENT_ISSUE_CODES = new Set<string>([
  // No formal model artifact exists.
  "model_not_invoked",
  "deterministic_preview_non_deliverable",

  // Minimum visible artifact shape.
  "title_required",
  "body_required",

  // Confidential/internal material or model-control text reached public copy.
  "restricted_source_content_visible",
  "internal_audit_artifact_visible",
  "frontstage_instruction_leak",
  "comment_context_meta_leak",
  "comment_source_language_surface_leak",
  "comment_plan_language_surface_leak",

  // Mechanical evidence authenticity: IDs, source availability, exact quotes,
  // evidence role and ledger identity must not be fabricated or substituted.
  "unknown_evidence",
  "evidence_quote_empty",
  "evidence_quote_not_exact",
  "evidence_source_unavailable",
  "evidence_reference_metadata_missing",
  "evidence_role_cannot_support_fact",
  "package_evidence_ledger_mismatch",
  "fact_source_id_mismatch",
  "author_fact_reference_invalid",
  "author_fact_confirmation_mismatch",
  "author_fact_project_evidence_mixed",

  // Accountable identity ownership and frozen responder attribution.
  "unaccountable_answer_identity",
  "comment_identity_violation",
  "host_reply_identity_violation",
  "host_reply_unconfirmed_author",
  "org_answer_identity_violation",
  "comment_answer_identity_mismatch",
  "publisher_narrative_identity_alias",
  "reply_identity_plan_drift",
  "reply_display_role_plan_drift",
]);

export function isNonOverridableContentIssueCode(code: string): boolean {
  return NON_OVERRIDABLE_CONTENT_ISSUE_CODES.has(code);
}

export function issueDisposition(
  issue: Pick<ContentValidationIssue, "code" | "severity" | "disposition">,
): NonNullable<ContentValidationIssue["disposition"]> {
  if (isNonOverridableContentIssueCode(issue.code)) return "block";
  if (issue.disposition === "review" || issue.disposition === "block" || issue.severity === "error") return "review";
  return "advisory";
}

export function issueOverridePolicy(
  issue: Pick<ContentValidationIssue, "code" | "severity" | "disposition" | "overridePolicy">,
): NonNullable<ContentValidationIssue["overridePolicy"]> {
  if (isNonOverridableContentIssueCode(issue.code)) return "non_overridable";
  return issueDisposition(issue) === "advisory" ? "not_required" : "human_reviewable";
}

export function candidateQualityStatus(
  validation: {
    valid?: boolean;
    issues: readonly Pick<ContentValidationIssue, "code" | "severity" | "disposition">[];
  },
): CandidateQualityStatus {
  if (validation.issues.some((issue) => isNonOverridableContentIssueCode(issue.code))) return "blocked";
  if (validation.issues.some((issue) => issueDisposition(issue) === "review") || validation.valid === false) return "needs_review";
  return "passed";
}

/**
 * 读取已落盘候选的交付真值。新记录显式携带的 qualityStatus 优先；只有历史记录
 * 缺该字段时才回退 valid。当前硬门禁白名单始终拥有最高优先级，避免陈旧的
 * `passed` 序列化值放行机械不可交付内容。
 */
export function resolveCandidateQualityStatus(
  validation?: {
    valid?: boolean;
    qualityStatus?: unknown;
    issues?: readonly { code?: string }[];
  },
): CandidateQualityStatus {
  if (!validation) return "blocked";
  const issues = validation.issues ?? [];
  if (issues.some((issue) => (
    typeof issue.code === "string" && isNonOverridableContentIssueCode(issue.code)
  ))) return "blocked";
  if (
    validation.qualityStatus === "passed"
    || validation.qualityStatus === "needs_review"
    || validation.qualityStatus === "blocked"
  ) {
    return validation.qualityStatus;
  }
  if (validation.qualityStatus !== undefined) {
    return "blocked";
  }
  return validation.valid === true ? "passed" : "needs_review";
}

export function candidateQualityStatusLabel(status: CandidateQualityStatus): string {
  return CANDIDATE_QUALITY_STATUS_LABELS[status];
}

/** Recompute action metadata from the hard-gate allowlist. Stale serialized
 * `block/non_overridable` fields never outrank the current central policy. */
export function normalizeContentValidationIssue(issue: ContentValidationIssue): ContentValidationIssue {
  const disposition = issueDisposition(issue);
  const overridePolicy = issueOverridePolicy({ ...issue, disposition });
  if (disposition === "block") {
    return { ...issue, severity: "error", disposition, overridePolicy };
  }
  if (disposition === "review") {
    return { ...issue, severity: "warning", disposition, overridePolicy };
  }
  return { ...issue, severity: "warning", disposition, overridePolicy };
}
