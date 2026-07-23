import type { DeploymentPlan, InformationGapPlanningCard } from "../types";

/**
 * Pure display helpers for the Cref contract v1.1 fields (thread kind /
 * answerKind / boundary, Cref-level ownedFirstComment / uncoveredGaps, and the
 * structured aC deployment rules). Every helper tolerates absent fields so
 * historical packages render exactly as before — never "undefined".
 */

/** Dialogic node kind → Chinese badge label; unknown values pass through raw. */
export const commentNodeKindLabel = (value?: string): string => {
  const labels: Record<string, string> = {
    question: "问题",
    answer: "回答",
    follow_up: "追问",
    clarification: "澄清",
  };
  return value ? labels[value] || value : "未标注";
};

/**
 * Accountable posting identity for display. `publisher` (v1.1) is the
 * publishing account itself; historical enum/raw values pass through.
 */
export const postingIdentityText = (value?: string): string => {
  if (!value) return "";
  return value === "publisher" ? "发布账号（publisher）" : value;
};

type LiveRoutingEntry = NonNullable<DeploymentPlan["liveRouting"]>[number];

/**
 * Render one liveRouting entry as a display line. Handles the v1.1 structured
 * {route,condition,action} rule, the legacy {intent,target,reason} object and
 * the historical plain-string form. Non-usable entries are dropped.
 */
export const liveRoutingLine = (item: LiveRoutingEntry): string => {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const structured = item as { route?: string; condition?: string; action?: string };
  if (structured.route || structured.condition || structured.action) {
    const head = [structured.route, structured.condition].filter(Boolean).join("（") + (structured.route && structured.condition ? "）" : "");
    return [head, structured.action].filter(Boolean).join(" → ");
  }
  const legacy = item as { intent?: string; target?: string; reason?: string };
  if (legacy.intent || legacy.target) {
    return `${legacy.intent || "未命名意图"} → ${legacy.target || "未命名去向"}${legacy.reason ? `：${legacy.reason}` : ""}`;
  }
  return "";
};

export const liveRoutingLines = (value: DeploymentPlan["liveRouting"]): string[] =>
  (Array.isArray(value) ? value : []).map(liveRoutingLine).filter(Boolean);

/** SLA display value: current `sla` wins; the deprecated historical alias stays readable. */
export const deploymentSla = (plan: DeploymentPlan): string | undefined =>
  plan.sla || plan.responseSla || undefined;

/**
 * Resolve Cref-level uncovered gap ids to human labels via the orchestration
 * gap planning cards; unresolved ids pass through raw (they are honest ids,
 * not fabricated labels).
 */
export const uncoveredGapLabels = (
  ids: string[] | undefined,
  cards?: InformationGapPlanningCard[],
): string[] =>
  (ids || []).map((id) => cards?.find((card) => card.gapId === id)?.label || id);
