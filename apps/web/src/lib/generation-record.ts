import type { Candidate, ContentDiagnostic } from "../types";
import { isDiagnosticProxyFormulaId } from "./diagnostic-proxy";

type ValidationIssue = NonNullable<Candidate["validation"]>["issues"][number];

export interface GenerationRecordNotice {
  label: string;
  detail: string;
  isFallback: boolean;
}

export function diagnosticsFromValidationIssues(
  issues: ValidationIssue[] | undefined,
): ContentDiagnostic[] {
  return (issues || []).map((issue) => ({
    name: issue.severity === "error" ? "系统硬约束问题" : "系统复核警告",
    status: issue.severity === "error" ? "fail" : "warn",
    message: issue.message,
    explanation: `来源：validation.issues${issue.code ? ` · ${issue.code}` : ""}；这是约束或复核记录，不是主观质量判断。`,
    evidenceStatus: "operational_validation_issue",
  }));
}

/**
 * A fallback package is not an auditable generation record. Only explicit
 * validation issues may be rendered as ordinary diagnostics in that state.
 */
export function ordinaryDiagnosticsForDisplay(
  candidate: Candidate | undefined,
  isFallback: boolean,
): ContentDiagnostic[] {
  if (!candidate) return [];
  if (isFallback) return diagnosticsFromValidationIssues(candidate.validation?.issues);
  return candidate.diagnostics?.filter(
    (diagnostic) => !isDiagnosticProxyFormulaId(diagnostic.formulaId),
  ) || [];
}

export function generationRecordNotice(isFallback: boolean): GenerationRecordNotice {
  return isFallback
    ? {
        label: "演示数据 · 未连接真实生成记录",
        detail: "接口未返回可核验的生成记录，当前展示本地演示内容；不代表服务端已经生成、校验或保存。",
        isFallback: true,
      }
    : {
        label: "候选与系统校验快照已记录",
        detail: "当前内容来自服务端生成记录。",
        isFallback: false,
      };
}
