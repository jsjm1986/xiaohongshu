import type {
  FormulaControlMode,
  FormulaDefinition,
  EnsureReviewedFormulaDefaultsResult,
  FormulaEffectiveEvidenceStatus,
  FormulaExecutionAudit,
  FormulaExecutionClass,
  FormulaExecutionRole,
  FormulaExecutionStage,
  FormulaExecutionTrace,
  FormulaImplementationStatus,
  FormulaImplementationRuntimeState,
  FormulaVersion,
} from "../types.js";

export type FormulaRuntimeState =
  | "handlers_enabled"
  | "pending_review"
  | "unreviewed"
  | "handlers_disabled"
  | "no_effective_handler"
  | "unknown";

export interface FormulaRuntimeView {
  state: FormulaRuntimeState;
  semanticFingerprint?: string;
  compatibilityStatus?: string;
  reviewStatus?: string;
  handlerState?: string;
  implementationStatus?: FormulaImplementationStatus;
  executionClass?: FormulaExecutionClass;
  executionRoles: FormulaExecutionRole[];
  controlMode?: FormulaControlMode;
  implementationRuntimeState?: FormulaImplementationRuntimeState;
  disableable?: boolean;
  implementedStages: FormulaExecutionStage[];
  declaredStages: FormulaExecutionStage[];
  registeredDispatchStages: FormulaExecutionStage[];
  effectiveDispatchStages: FormulaExecutionStage[];
  nonDispatchedStages: FormulaExecutionStage[];
  actualExecution?: string;
  implementationBoundary?: string;
  dataRequirement?: string;
  codeLocations: string[];
  declaredEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  effectiveEvidenceStatus?: FormulaEffectiveEvidenceStatus;
  registeredHandlers: Array<{ kind: string; handlers: string[] }>;
  effectiveHandlers: Array<{ kind: string; handlers: string[] }>;
  hasServerMetadata: boolean;
  effectiveHandlersEnabled: boolean;
  /** True only for a fully implemented, effectively dispatched generation mechanism. */
  directGenerationMechanism: boolean;
}

export interface ImageFormulaOutputBoundary {
  formulaId: "F19" | "F40";
  label: string;
  completedScope: string[];
  absentScope: string[];
  detail: string;
}

/**
 * F19/F40 can dispatch planning/prompt handlers without producing a rendered
 * image, an observed entry preview, or a deployment. Keep that boundary visible
 * even when the handler itself is enabled.
 */
export function resolveImageFormulaOutputBoundary(
  formulaId: string,
  runtime: FormulaRuntimeView,
): ImageFormulaOutputBoundary | undefined {
  if (formulaId !== "F19" && formulaId !== "F40") return undefined;
  const enabledCopy = runtime.effectiveHandlersEnabled
    ? "当前有效处理器只证明下面列出的计划/文字范围被派发。"
    : "当前没有有效可选处理器；即使历史快照含有计划文字，也不能据此推断本版本执行。";
  if (formulaId === "F19") {
    return {
      formulaId,
      label: "仅完成入口计划 / 文字草稿",
      completedScope: ["获批源素材观察（若提供，仅作为规划输入）", "图片职责与构图计划", "imageBrief、标题、标签和正文开头的文字候选"],
      absentScope: ["最终图片资产 Img", "真实入口截图", "已观察的 VisibleTags / Excerpt / Preview", "实际部署"],
      detail: `${enabledCopy} 没有最终图片与真实入口截图时，Preview 仍是未落实的生产目标。`,
    };
  }
  return {
    formulaId,
    label: "仅完成多通道计划 / 文本内容包",
    completedScope: ["获批源素材观察（若提供，仅作为规划输入）", "标签、图片计划/imageBrief、标题、正文与评论的联合规划", "部署计划文字草稿"],
    absentScope: ["最终图片资产 Img", "真实入口截图 Preview", "实际部署与平台观测"],
    detail: `${enabledCopy} 规划对象存在不等于 Img、Preview 或部署已经完成。`,
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function normalizeHandlers(value: unknown): Array<{ kind: string; handlers: string[] }> {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record)
    .map(([kind, raw]) => ({
      kind,
      handlers: Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    }))
    .filter((item) => item.handlers.length > 0);
}

const stringArray = <T extends string>(value: unknown): T[] => Array.isArray(value)
  ? value.filter((item): item is T => typeof item === "string" && item.trim().length > 0)
  : [];

function findAuditTrace(formulaId: string, audit?: FormulaExecutionAudit): FormulaExecutionTrace | undefined {
  if (!audit) return undefined;
  const direct = audit.formulaTrace?.find((item) => item.id === formulaId);
  if (direct) return direct;
  const pending = audit.pendingReviewFormulas?.find((item) => item.id === formulaId);
  if (pending) return { ...pending, compatibilityStatus: pending.compatibilityStatus || "pending_review", handlerState: pending.handlerState || "pending_review" };
  const unreviewed = audit.unreviewedFormulas?.find((item) => item.id === formulaId);
  if (unreviewed) return { ...unreviewed, compatibilityStatus: unreviewed.compatibilityStatus || "unreviewed", handlerState: unreviewed.handlerState || "unreviewed" };
  return undefined;
}

/**
 * Resolve only server-disclosed execution metadata. A Schema parameter link is
 * deliberately not treated as proof that a formula executes at runtime.
 */
export function resolveFormulaRuntimeView(
  formula: FormulaDefinition,
  version?: FormulaVersion,
): FormulaRuntimeView {
  const audit = version?.executionAudit ?? version?.formulaExecutionAudit;
  const trace = findAuditTrace(formula.id, audit);
  const semanticFingerprint = trace?.semanticFingerprint ?? trace?.equationFingerprint;
  const compatibilityStatus = trace?.compatibilityStatus ?? formula.compatibilityStatus;
  const reviewStatus = trace?.reviewStatus ?? formula.reviewStatus;
  const handlerState = trace?.handlerState ?? formula.handlerState;
  const implementationStatus = trace?.implementationStatus ?? formula.implementationStatus;
  const executionClass = trace?.executionClass ?? formula.executionClass;
  const executionRoles = stringArray<FormulaExecutionRole>(trace?.executionRoles ?? formula.executionRoles);
  const controlMode = trace?.controlMode ?? formula.controlMode;
  const implementationRuntimeState = trace?.implementationRuntimeState ?? formula.implementationRuntimeState;
  const disableable = trace?.disableable ?? formula.disableable;
  const implementedStages = stringArray<FormulaExecutionStage>(trace?.implementedStages ?? trace?.stages ?? formula.implementedStages);
  const declaredStages = stringArray<FormulaExecutionStage>(trace?.declaredStages ?? formula.declaredStages);
  const registeredDispatchStages = stringArray<FormulaExecutionStage>(trace?.registeredDispatchStages ?? formula.registeredDispatchStages);
  let effectiveDispatchStages = stringArray<FormulaExecutionStage>(trace?.effectiveDispatchStages ?? formula.effectiveDispatchStages);
  const nonDispatchedStages = stringArray<FormulaExecutionStage>(trace?.nonDispatchedStages ?? formula.nonDispatchedStages);
  const actualExecution = trace?.actualExecution ?? formula.actualExecution;
  const implementationBoundary = trace?.implementationBoundary ?? formula.implementationBoundary;
  const dataRequirement = trace?.dataRequirement;
  const codeLocations = stringArray<string>(trace?.codeLocations ?? formula.codeLocations);
  const declaredEvidenceStatus = trace?.declaredEvidenceStatus ?? formula.declaredEvidenceStatus ?? formula.evidenceStatus;
  const effectiveEvidenceStatus = trace?.effectiveEvidenceStatus ?? formula.effectiveEvidenceStatus;
  const registeredHandlers = normalizeHandlers(trace?.registeredHandlers ?? formula.registeredHandlers);
  let effectiveHandlers = normalizeHandlers(trace?.effectiveHandlers ?? formula.effectiveHandlers);
  const hasServerMetadata = Boolean(
    trace
    || compatibilityStatus
    || reviewStatus
    || handlerState
    || implementationStatus
    || executionClass
    || controlMode
    || implementationRuntimeState
    || registeredHandlers.length
    || effectiveHandlers.length,
  );
  const reviewSignals = [compatibilityStatus, reviewStatus, handlerState].filter(Boolean);

  const build = (
    state: FormulaRuntimeState,
    effectiveHandlersEnabled: boolean,
  ): FormulaRuntimeView => ({
    state,
    semanticFingerprint,
    compatibilityStatus,
    reviewStatus,
    handlerState,
    implementationStatus,
    executionClass,
    executionRoles,
    controlMode,
    implementationRuntimeState,
    disableable,
    implementedStages,
    declaredStages,
    registeredDispatchStages,
    effectiveDispatchStages,
    nonDispatchedStages,
    actualExecution,
    implementationBoundary,
    dataRequirement,
    codeLocations,
    declaredEvidenceStatus,
    effectiveEvidenceStatus,
    registeredHandlers,
    effectiveHandlers,
    hasServerMetadata,
    effectiveHandlersEnabled,
    directGenerationMechanism: effectiveHandlersEnabled
      && implementationStatus === "active"
      && executionClass === "direct-executable"
      && effectiveDispatchStages.includes("generation")
      && effectiveHandlers.some((item) => item.kind === "prompt"),
  });

  // A pending/unreviewed signal always wins, even if a malformed DTO also
  // contains stale effective handlers. The UI must never imply execution.
  if (reviewSignals.includes("pending_review")) {
    effectiveHandlers = [];
    effectiveDispatchStages = [];
    return build("pending_review", false);
  }
  if (reviewSignals.includes("unreviewed")) {
    effectiveHandlers = [];
    effectiveDispatchStages = [];
    return build("unreviewed", false);
  }
  if (handlerState === "disabled") {
    effectiveHandlers = [];
    effectiveDispatchStages = [];
    return build("handlers_disabled", false);
  }

  const reviewed = compatibilityStatus === "reviewed"
    && (reviewStatus === undefined || reviewStatus === "reviewed" || reviewStatus === "approved");
  const enabled = handlerState === "enabled" || (handlerState === undefined && effectiveHandlers.length > 0);
  if (reviewed && enabled && effectiveHandlers.length > 0) {
    return build("handlers_enabled", true);
  }
  if (reviewed || trace) {
    return build("no_effective_handler", false);
  }
  return build("unknown", false);
}

export interface ActivationState {
  versions: FormulaVersion[];
  selected: FormulaVersion;
}

export function parseReviewedDefaultsSyncResult(
  value: unknown,
  projectId: string,
): EnsureReviewedFormulaDefaultsResult {
  const record = asRecord(value);
  if (!record
    || record.operation !== "ensure_reviewed_defaults"
    || record.projectId !== projectId
    || typeof record.formulaVersionId !== "string"
    || !record.formulaVersionId.trim()
    || typeof record.formulaVersionDigest !== "string"
    || !record.formulaVersionDigest.trim()
    || typeof record.changed !== "boolean") {
    throw new Error("服务端返回的默认公式同步确认不完整，页面未更新本地状态");
  }
  return record as unknown as EnsureReviewedFormulaDefaultsResult;
}

export function resolveReviewedDefaultsRefresh(
  versions: FormulaVersion[],
  result: EnsureReviewedFormulaDefaultsResult,
): ActivationState {
  if (!result.changed) throw new Error("服务端没有派生新公式版本");
  const active = versions.find((version) => version.id === result.formulaVersionId && version.status === "active");
  if (!active
    || active.projectId !== result.projectId
    || active.digest !== result.formulaVersionDigest) {
    throw new Error("刷新后的公式列表没有返回与同步确认匹配的新 active 版本");
  }
  return { versions, selected: active };
}

/** Apply an activation only after a matching, active server response. */
export function applyConfirmedFormulaActivation(
  versions: FormulaVersion[],
  requested: FormulaVersion,
  response: FormulaVersion,
): ActivationState {
  if (response.id !== requested.id) {
    throw new Error("服务端返回了不匹配的公式版本");
  }
  if (response.projectId !== requested.projectId) {
    throw new Error("服务端返回了其他项目的公式版本");
  }
  if (response.status !== "active") {
    throw new Error("服务端尚未确认该版本已启用");
  }
  return {
    versions: versions.map((item) => {
      if (item.id === response.id) return response;
      return item.status === "active" ? { ...item, status: "archived" as const } : item;
    }),
    selected: response,
  };
}

export function formulaActivationErrorMessage(version: FormulaVersion, error: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? `：${error.message}` : "";
  return `${version.version} 启用失败${detail}。当前启用状态未改变`;
}

export type FormulaActivationResult =
  | { ok: true; state: ActivationState }
  | { ok: false; message: string };

/**
 * Keep request failure and response validation outside React state mutation so
 * a rejected activation can never be presented as a local success.
 */
export async function requestConfirmedFormulaActivation(
  versions: FormulaVersion[],
  requested: FormulaVersion,
  activate: (id: string) => Promise<FormulaVersion>,
): Promise<FormulaActivationResult> {
  try {
    const response = await activate(requested.id);
    return { ok: true, state: applyConfirmedFormulaActivation(versions, requested, response) };
  } catch (error) {
    return { ok: false, message: formulaActivationErrorMessage(requested, error) };
  }
}
