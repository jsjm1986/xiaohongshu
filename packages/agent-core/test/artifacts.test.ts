import { describe, expect, it } from "vitest";

import {
  buildProductionArtifacts,
  createDefaultGenerationConfig,
  DEFAULT_FORMULA_VERSION,
  evaluatePlanToCopyAlignment,
  planTopicOrchestrations,
} from "../src/index.js";
import type { ContentPackageContent, ImageAssetAnalysis, InformationGap, TopicOpportunity } from "../src/index.js";

const project = {
  id: "artifact-project",
  name: "内容项目",
  domain: "决策信息",
  productPoints: [],
  organizationPoints: [],
  cities: [],
  doctors: [],
};

const gap: InformationGap = {
  id: "fit",
  label: "适用条件",
  question: "如何核验适用条件？",
  category: "decision",
  audienceStages: ["comparing"],
  importance: 0.9,
  decisionLeverage: 0.9,
  proofability: 0.8,
  framework: "逐项核验适用条件",
  boundary: "不得使用前后对比",
  evidenceIds: ["evidence-1"],
  required: true,
};

const opportunity: TopicOpportunity = {
  id: "topic-1",
  topic: "选择方案前先核验",
  angle: "核验适用条件",
  gapIds: [gap.id],
  audienceStage: "comparing",
  entry: "search",
  relevance: 0.9,
  importance: 0.9,
  proofability: 0.8,
  novelty: 0.5,
  decisionLeverage: 0.9,
  cognitiveCost: 0.2,
  risk: 0.2,
  evidenceIds: ["evidence-1"],
  boundaries: ["不得使用前后对比"],
  tags: [],
  imageAssetIds: ["source-image"],
  status: "eligible",
};

const imageAnalysis: ImageAssetAnalysis = {
  assetId: "source-image",
  observedFacts: ["画面里有一张核验清单"],
  inferredSignals: [],
  unknowns: ["拍摄时间未知"],
  visibleText: ["核验清单"],
  roles: ["cover", "evidence"],
  quality: { clarity: 0.9, relevance: 0.9, textLegibility: 0.9 },
  safetyFlags: [],
  evidenceIds: ["evidence-1"],
  source: "uploaded",
};

function plan() {
  const config = createDefaultGenerationConfig(project, DEFAULT_FORMULA_VERSION);
  config.task.theme = opportunity.topic;
  config.task.audienceStage = "comparing";
  config.informationWindow.boundaries = [...opportunity.boundaries];
  const selected = planTopicOrchestrations({
    opportunity,
    gaps: [gap],
    config,
    seeds: [1, 2, 3],
    imageAnalyses: [imageAnalysis],
  })[0];
  selected.imagePlan = {
    sourceAssetId: "source-image",
    primaryAssetId: "source-image",
    role: "cover",
    coverText: "选择方案前先核验",
    frames: ["核验清单", "适用边界"],
    composition: "用核验清单承接选择条件",
    altText: "方案核验清单",
    evidenceIds: ["evidence-1"],
    boundaries: ["不得使用前后对比"],
  };
  selected.boundaries = ["不得使用前后对比"];
  return selected;
}

function content(overrides: Partial<ContentPackageContent["N"]> = {}): ContentPackageContent {
  return {
    H: { hashtags: [] },
    N: {
      imageBrief: "用核验清单做封面，并明确不使用前后对比",
      title: "选择方案前先核验",
      body: "先逐项核验适用条件，不得使用前后对比。",
      ...overrides,
    },
    Cref: { disclaimer: "模拟问答参考模板", threads: [] },
  };
}

describe("production artifact truth states", () => {
  it("separates an approved source observation and plan from a final image, entry snapshot and deployment", () => {
    const artifacts = buildProductionArtifacts({
      plan: plan(),
      content: content(),
      imageAnalyses: [imageAnalysis],
      imageBriefEnabled: true,
    });

    expect(artifacts).toMatchObject({
      schemaVersion: "1.0",
      imageObservation: { status: "approved", sourceAssetId: "source-image", analysisAssetIds: ["source-image"] },
      imagePlan: { status: "planned", sourceAssetId: "source-image" },
      imageBrief: { status: "contract_validated" },
      finalImageAsset: { status: "absent" },
      entrySnapshot: { status: "absent" },
      deployment: { status: "not_deployed" },
      planToCopyAlignment: { status: "pass", evaluated: true },
      finalAssetAlignment: { status: "not_evaluated", evaluated: false },
      entrySnapshotAlignment: { status: "not_evaluated", evaluated: false },
    });
  });

  it("warns instead of rejecting an ordinary Chinese paraphrase with no exact lexical match", () => {
    const alignment = evaluatePlanToCopyAlignment(plan(), content({
      imageBrief: "把需要确认的事项整理成一页",
      title: "先问清楚再决定",
      body: "逐项查证个人条件，再决定是否继续。",
    }));

    expect(alignment.evaluated).toBe(true);
    expect(alignment.status).not.toBe("fail");
    expect(alignment.checks.some((item) => item.status === "warn")).toBe(true);
    expect(alignment.reasons.join(" ")).toContain("人工复核");
  });

  it("marks an enabled but empty image brief as absent rather than drafted", () => {
    const artifacts = buildProductionArtifacts({
      plan: plan(),
      content: content({ imageBrief: "" }),
      imageBriefEnabled: true,
    });

    expect(artifacts.imageBrief.status).toBe("absent");
    expect(artifacts.planToCopyAlignment.status).toBe("warn");
  });

  it("retains historical observation indexes without calling them approved when raw analyses are not supplied again", () => {
    const previous = buildProductionArtifacts({
      plan: plan(),
      content: content(),
      imageAnalyses: [imageAnalysis],
    });
    const revised = buildProductionArtifacts({
      plan: plan(),
      content: content(),
      previous,
    });

    expect(revised.imageObservation).toMatchObject({
      status: "not_supplied",
      analysisAssetIds: ["source-image"],
    });
    expect(revised.imageObservation.note).toContain("没有重新提供原始分析");
  });

  it("fails only an explicit positive instruction that reverses a prohibitive boundary", () => {
    const alignment = evaluatePlanToCopyAlignment(plan(), content({
      imageBrief: "制作前后对比图，并把效果放在封面中央",
      title: "选择方案前先核验",
      body: "先逐项核验适用条件。",
    }));

    expect(alignment.status).toBe("fail");
    expect(alignment.checks).toContainEqual(expect.objectContaining({ id: "boundary_continuity", status: "fail" }));
  });
});
