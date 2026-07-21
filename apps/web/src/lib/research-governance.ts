import type { ResearchReleaseManifest } from "../types";

export const researchStatusLabel: Record<string, string> = {
  draft: "草稿",
  under_review: "复核中",
  approved: "已批准",
  deprecated: "已弃用",
  rejected: "已拒绝",
  preregistered: "已预注册",
  running: "运行中",
  completed: "已完成",
  replicated: "已复现",
  archived: "已归档",
  applied: "已随版本应用",
  active: "当前运行版本",
};

export function researchStatusTone(status: string): "neutral" | "positive" | "warning" | "danger" | "purple" | "blue" {
  if (["approved", "completed", "replicated", "active", "applied"].includes(status)) return "positive";
  if (["rejected", "deprecated"].includes(status)) return "danger";
  if (["under_review", "preregistered", "running"].includes(status)) return "warning";
  if (status === "draft") return "blue";
  return "neutral";
}

export function experimentTransitions(status: string): string[] {
  const transitions: Record<string, string[]> = {
    draft: ["preregistered", "rejected", "archived"],
    preregistered: ["running", "rejected", "archived"],
    running: ["completed", "archived"],
    completed: ["replicated", "archived"],
    replicated: ["archived"],
    rejected: [],
    archived: [],
  };
  return transitions[status] ?? [];
}

export function safeResearchUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function releaseBindingSummary(release: ResearchReleaseManifest): string {
  const bindings = release.bindings ?? { datasetSnapshotIds: [], experimentResultIds: [], calibrationProposalIds: [] };
  return `${bindings.datasetSnapshotIds?.length ?? 0} 个数据快照 · ${bindings.experimentResultIds?.length ?? 0} 个实验结果 · ${bindings.calibrationProposalIds?.length ?? 0} 个校准提案`;
}
