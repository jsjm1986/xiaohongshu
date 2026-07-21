import type {
  Candidate,
  ProductionAlignmentReport,
  ProductionAlignmentStatus,
  ProductionArtifacts,
} from "../types.js";

export type ProductionStageTone = "positive" | "warning" | "danger" | "neutral";
export type ProductionStageId =
  | "imageObservation"
  | "imagePlan"
  | "imageBrief"
  | "finalImageAsset"
  | "entrySnapshot"
  | "deployment";

export interface ProductionStageView {
  id: ProductionStageId;
  label: string;
  status: string;
  explanation: string;
  note: string;
  tone: ProductionStageTone;
}

export interface ProductionAlignmentView {
  id: "planToCopyAlignment" | "finalAssetAlignment" | "entrySnapshotAlignment";
  label: string;
  status: ProductionAlignmentStatus;
  evaluated: boolean;
  reasons: string[];
  checks: ProductionAlignmentReport["checks"];
  tone: ProductionStageTone;
}

export interface ProductionArtifactView {
  recorded: boolean;
  sourceAssetId?: string;
  finalAssetId?: string;
  snapshotId?: string;
  stages: ProductionStageView[];
  alignments: ProductionAlignmentView[];
}

const stageTone = (status: string): ProductionStageTone => {
  if (["approved", "planned", "contract_validated", "verified", "observed", "pass"].includes(status)) return "positive";
  if (["drafted", "declared", "captured", "recorded", "unknown", "warn"].includes(status)) return "warning";
  if (status === "fail") return "danger";
  return "neutral";
};

const statusExplanation: Record<ProductionStageId, Record<string, string>> = {
  imageObservation: {
    not_supplied: "没有已批准的源素材观察；不能推断画面里出现了什么。",
    approved: "源素材的可见观察已获批准；它仍不是生成后的最终图片。",
  },
  imagePlan: {
    absent: "没有图片编排计划。",
    planned: "已有图片职责与构图计划；计划不等于图片已生成。",
  },
  imageBrief: {
    disabled: "本次没有图片文字简报。",
    absent: "absent · 图片简报已纳入生产链，但本次没有实际产出文字简报。",
    unknown: "unknown · 历史内容包未记录 imageBrief 状态，无法判断是未启用还是未产出。",
    drafted: "只有供后续制作使用的文字草稿；不是图片资产。",
    contract_validated: "文字简报已通过计划→文案合同校验；仍不是最终图片。",
  },
  finalImageAsset: {
    absent: "absent · 没有最终图片资产，不能显示为 Img 已完成。",
    unknown: "unknown · 历史内容包未记录最终图片资产状态，无法判断是否存在。",
    declared: "已声明一个最终图片资产，但尚未完成独立核验。",
    verified: "最终图片资产已独立核验。",
  },
  entrySnapshot: {
    absent: "absent · 没有真实入口截图，不能声称 Preview 已观察。",
    unknown: "unknown · 历史内容包未记录入口截图状态，无法判断是否采集。",
    captured: "已有入口截图记录，但尚未完成独立核验。",
    verified: "真实入口截图已独立核验。",
  },
  deployment: {
    not_deployed: "not_deployed · 没有实际部署记录；部署计划不等于已发布。",
    recorded: "已有部署记录，但不等于已观察到平台表现。",
    observed: "已记录实际部署观察；这本身仍不证明效果归因。",
    unknown: "unknown · 实际部署状态未记录，不能推断为已发布或未发布。",
  },
};

const labels: Record<ProductionStageId, string> = {
  imageObservation: "源素材观察",
  imagePlan: "图片计划",
  imageBrief: "imageBrief 文字简报",
  finalImageAsset: "最终图片资产",
  entrySnapshot: "真实入口截图",
  deployment: "实际部署",
};

const defaultAlignment = (): ProductionAlignmentReport => ({
  status: "not_evaluated",
  evaluated: false,
  reasons: ["没有对应产物，或历史内容包未记录这项语义校验。"],
  checks: [],
});

const alignmentView = (
  id: ProductionAlignmentView["id"],
  label: string,
  report?: ProductionAlignmentReport,
): ProductionAlignmentView => {
  const normalized = report?.evaluated === true
    ? report
    : { ...(report || defaultAlignment()), status: "not_evaluated" as const, evaluated: false };
  return {
    id,
    label,
    status: normalized.status,
    evaluated: normalized.evaluated,
    reasons: Array.isArray(normalized.reasons) ? normalized.reasons : [],
    checks: Array.isArray(normalized.checks) ? normalized.checks : [],
    tone: stageTone(normalized.status),
  };
};

const stage = (
  id: ProductionStageId,
  status: string,
  note?: string,
): ProductionStageView => ({
  id,
  label: labels[id],
  status,
  explanation: statusExplanation[id][status] || "当前状态没有可核验说明。",
  note: note?.trim() || "未提供补充记录。",
  tone: stageTone(status),
});

/**
 * Resolve a truth-preserving view. Historical fields may prove that a plan or
 * text brief exists, but never prove a final image, entry snapshot or deployment.
 */
export function resolveProductionArtifactView(candidate: Pick<Candidate,
  "imagePlan" | "imageBrief" | "deploymentPlan" | "productionArtifacts" | "orchestrationSnapshot"
>): ProductionArtifactView {
  const artifacts = candidate.productionArtifacts ?? candidate.orchestrationSnapshot?.productionArtifacts;
  const legacySourceAssetId = candidate.imagePlan?.sourceAssetId ?? candidate.imagePlan?.primaryAssetId;
  if (!artifacts) {
    const planStatus = candidate.imagePlan ? "planned" : "absent";
    const briefStatus = candidate.imageBrief?.trim() ? "drafted" : "unknown";
    const historical = "历史内容包未记录 productionArtifacts；这里只按现有文字字段保守展示。";
    return {
      recorded: false,
      sourceAssetId: legacySourceAssetId,
      stages: [
        stage("imageObservation", "not_supplied", historical),
        stage("imagePlan", planStatus, historical),
        stage("imageBrief", briefStatus, historical),
        stage("finalImageAsset", "unknown", historical),
        stage("entrySnapshot", "unknown", historical),
        stage("deployment", "unknown", candidate.deploymentPlan
          ? "历史包只有部署计划，没有可用于判断实际部署状态的账本记录。"
          : historical),
      ],
      alignments: [
        alignmentView("planToCopyAlignment", "计划→文案语义一致性"),
        alignmentView("finalAssetAlignment", "最终图片→文案语义一致性"),
        alignmentView("entrySnapshotAlignment", "入口截图→文案语义一致性"),
      ],
    };
  }

  return {
    recorded: true,
    sourceAssetId: artifacts.imagePlan.sourceAssetId
      ?? artifacts.imageObservation.sourceAssetId
      ?? legacySourceAssetId,
    finalAssetId: artifacts.finalImageAsset.assetId,
    snapshotId: artifacts.entrySnapshot.snapshotId,
    stages: [
      stage("imageObservation", artifacts.imageObservation.status, artifacts.imageObservation.note),
      stage("imagePlan", artifacts.imagePlan.status, artifacts.imagePlan.note),
      stage("imageBrief", artifacts.imageBrief.status, artifacts.imageBrief.note),
      stage("finalImageAsset", artifacts.finalImageAsset.status, artifacts.finalImageAsset.note),
      stage("entrySnapshot", artifacts.entrySnapshot.status, artifacts.entrySnapshot.note),
      stage("deployment", artifacts.deployment.status, artifacts.deployment.note),
    ],
    alignments: [
      alignmentView("planToCopyAlignment", "计划→文案语义一致性", artifacts.planToCopyAlignment),
      alignmentView("finalAssetAlignment", "最终图片→文案语义一致性", artifacts.finalAssetAlignment),
      alignmentView("entrySnapshotAlignment", "入口截图→文案语义一致性", artifacts.entrySnapshotAlignment),
    ],
  };
}

/** Build a complete absent ledger for fixtures and API normalization without implying execution. */
export function absentProductionArtifacts(): ProductionArtifacts {
  const report = defaultAlignment();
  return {
    schemaVersion: "1.0",
    imageObservation: { status: "not_supplied", analysisAssetIds: [], note: "未提供源素材观察。" },
    imagePlan: { status: "absent", note: "未生成图片计划。" },
    imageBrief: { status: "disabled", note: "图片文字简报未启用。" },
    finalImageAsset: { status: "absent", note: "未提供最终图片资产。" },
    entrySnapshot: { status: "absent", note: "未提供真实入口截图。" },
    deployment: { status: "not_deployed", note: "没有实际部署记录。" },
    planToCopyAlignment: structuredClone(report),
    finalAssetAlignment: structuredClone(report),
    entrySnapshotAlignment: structuredClone(report),
  };
}
