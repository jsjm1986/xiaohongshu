import type {
  ArtifactAlignmentCheck,
  ArtifactAlignmentEvaluation,
  ContentPackageContent,
  ImageAssetAnalysis,
  ImagePlan,
  OrchestrationPlan,
  ProductionArtifacts,
} from "./types.js";

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string): Set<string> {
  const text = normalized(value);
  return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));
}

/**
 * A deliberately weak semantic proxy. It can find an explainable connection,
 * but a miss is only a warning because Chinese paraphrases need not share an
 * exact phrase or the same word order.
 */
function semanticallyConnected(left: string, right: string): boolean {
  const a = normalized(left);
  const b = normalized(right);
  if (a.length < 2 || b.length < 2) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const leftPairs = bigrams(a);
  const rightPairs = bigrams(b);
  const commonPairs = [...leftPairs].filter((pair) => rightPairs.has(pair)).length;
  const pairDice = (2 * commonPairs) / Math.max(1, leftPairs.size + rightPairs.size);
  if (commonPairs >= 2 && pairDice >= 0.2) return true;
  const leftChars = new Set([...a]);
  const rightChars = new Set([...b]);
  const commonChars = [...leftChars].filter((character) => rightChars.has(character)).length;
  return commonChars >= 2 && commonChars / Math.max(1, Math.min(leftChars.size, rightChars.size)) >= 0.42;
}

function anyConnection(anchors: string[], target: string): boolean {
  return anchors.some((anchor) => semanticallyConnected(anchor, target));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * 禁止性边界:要求「不要出现某内容」而不是「要写某内容」。
 *
 * 实测 1835 条边界里 59% 是这一类(「不得贬低其他医疗项目」「不承诺零增项」
 * 「AI不能判断用户是否适合项目」)。它们正确的落实方式就是**可见文案里不出现**,
 * 所以不能要求「在文案中找到该边界的承接」——那样遵守边界反而被判可疑,方向是反的。
 *
 * 这类边界只由 explicitBoundaryContradiction 检查「有没有被正向违反」,
 * 不参与承接检查。
 */
export function isProhibitiveBoundary(boundary: string): boolean {
  const compact = boundary.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  // 「不承接/不覆盖/仅服务…」是经营范围声明,同样不要求在文案里正面出现:
  // 一篇不谈别墅大宅的稿子并没有违反「不承接别墅大宅」。
  return /(?:不得|禁止|不能|不可|不要|不应|避免|无法|不做|不提供|不保证|不承诺|不替代|不夸大|不使用|不承接|不覆盖|不包含|不涉及)/u.test(compact);
}

function prohibitedObject(boundary: string): string | undefined {
  const compact = boundary.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const match = compact.match(/(?:不得|禁止|不能|不可|避免)(?:使用|展示|呈现|加入|制作|生成|发布|伪造)?(.{2,32})/u);
  if (!match?.[1]) return undefined;
  const object = match[1]
    .replace(/^(?:未经支持的|未经核验的|虚假的|伪造的)/u, "")
    .replace(/(?:内容|信息|画面|图片)$/u, "");
  return object.length >= 2 ? object : undefined;
}

function explicitBoundaryContradiction(boundary: string, target: string): string | undefined {
  const object = prohibitedObject(boundary);
  if (!object) return undefined;
  const compactTarget = target.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  const objectIndex = compactTarget.indexOf(object);
  if (objectIndex < 0) return undefined;
  const context = compactTarget.slice(Math.max(0, objectIndex - 14), objectIndex + object.length + 8);
  if (/(?:不得|禁止|不能|不可|避免|不要|未|无|拒绝|谨慎|核验)/u.test(context)) return undefined;
  const positiveAction = new RegExp(`(?:制作|展示|呈现|使用|加入|生成|发布|放上|突出|承诺|保证).{0,12}${escapeRegExp(object)}`, "u");
  return positiveAction.test(compactTarget) ? object : undefined;
}

function check(
  id: string,
  status: ArtifactAlignmentCheck["status"],
  reason: string,
  anchors: string[],
): ArtifactAlignmentCheck {
  return { id, status, reason, anchors: unique(anchors) };
}

function summarize(checks: ArtifactAlignmentCheck[]): ArtifactAlignmentEvaluation {
  const evaluatedChecks = checks.filter((item) => item.status !== "not_evaluated");
  const status: ArtifactAlignmentEvaluation["status"] = evaluatedChecks.length === 0
    ? "not_evaluated"
    : evaluatedChecks.some((item) => item.status === "fail")
      ? "fail"
      : evaluatedChecks.some((item) => item.status === "warn")
        ? "warn"
        : "pass";
  return {
    status,
    evaluated: status !== "not_evaluated",
    reasons: checks.map((item) => item.reason),
    checks,
  };
}

export function notEvaluatedAlignment(reason: string): ArtifactAlignmentEvaluation {
  return {
    status: "not_evaluated",
    evaluated: false,
    reasons: [reason],
    checks: [],
  };
}

export function evaluatePlanToCopyAlignment(
  plan: OrchestrationPlan | undefined,
  content: ContentPackageContent,
  imageBriefEnabled = true,
): ArtifactAlignmentEvaluation {
  if (!plan?.imagePlan) return notEvaluatedAlignment("没有可追溯的图片计划，无法评估计划与文案的一致性。");
  const visibleCopy = [content.N.imageBrief, content.N.title, content.N.body].filter(Boolean).join("\n");
  if (!visibleCopy.trim()) return notEvaluatedAlignment("尚无图片说明、标题或正文，无法评估计划与文案的一致性。");

  const imageAnchors = unique([
    plan.imagePlan.coverText,
    ...plan.imagePlan.frames,
    plan.imagePlan.composition,
    plan.imagePlan.altText,
  ]);
  // 词面比对(bigram Dice / 字符重合)判不出同义改写。实测 imagePlan.frames 去重
  // 只有 16 种抽象编排指令(「保留普通生活背景」「让变化从场景里被看见」),而
  // imageBrief 229 条全不重复且内容具体——两者本就不该有词面重叠,判 warn 是必然
  // 结果,与文案质量无关(202 例误报中 imageBrief 为空的有 0 例)。
  //
  // 所以「有内容但词面对不上」降为 not_evaluated:不参与总状态、不发提醒,
  // 如实表达「这个判据判不了」。真正缺失(imageBrief 为空)仍然 warn。
  const briefCheck = !imageBriefEnabled
    ? check("image_plan_to_brief", "not_evaluated", "图片说明已禁用；本项不参与总状态，但标题和正文仍需接受承接检查。", imageAnchors)
    : !content.N.imageBrief.trim()
      ? check("image_plan_to_brief", "warn", "图片说明为空，无法确认图片计划是否落实；这不是最终图片缺失的证据。", imageAnchors)
      : anyConnection(imageAnchors, content.N.imageBrief)
        ? check("image_plan_to_brief", "pass", "图片说明与至少一个计划锚点存在可解释的语义连接。", imageAnchors)
        : check("image_plan_to_brief", "not_evaluated", "图片说明已写出，但计划锚点多为抽象编排指令，词面比对无法判定是否承接；本项不参与总状态。", imageAnchors);

  const coverAnchors = unique([plan.imagePlan.coverText]);
  const titleAndBody = `${content.N.title}\n${content.N.body}`;
  const coverCheck = coverAnchors.length === 0
    ? check("cover_promise_to_copy", "pass", "计划没有单独的封面承诺，因此没有额外承诺需要核对。", [])
    : anyConnection(coverAnchors, titleAndBody)
      ? check("cover_promise_to_copy", "pass", "封面承诺与标题或正文存在可解释的语义承接。", coverAnchors)
      : check("cover_promise_to_copy", "not_evaluated", "未找到封面承诺与标题/正文的词面连接；同义改写无法用词面判据判定，本项不参与总状态。", coverAnchors);

  const contentAnchors = unique((plan.gapPlanningCards ?? []).flatMap((card) => [
    card.label,
    card.question,
    card.answer,
    card.framework,
  ]));
  const contentCheck = contentAnchors.length === 0
    ? check("planned_anchor_to_copy", "pass", "计划没有可直接比较的内容锚点，本项没有发现冲突。", [])
    : contentAnchors.some((anchor) => semanticallyConnected(anchor, titleAndBody))
      ? check("planned_anchor_to_copy", "pass", "标题或正文承接了至少一个计划内容锚点。", contentAnchors)
      : check("planned_anchor_to_copy", "not_evaluated", "未找到计划内容锚点在标题/正文中的词面承接；极简创作要求口语化改写，词面判据无法判定，本项不参与总状态。", contentAnchors);

  const boundaries = unique([...plan.boundaries, ...plan.imagePlan.boundaries]);
  const contradictions = boundaries.flatMap((boundary) => {
    const object = explicitBoundaryContradiction(boundary, visibleCopy);
    return object ? [`${boundary} -> 正向要求“${object}”`] : [];
  });
  // 承接检查只对**非禁止性**边界做。禁止性边界(实测占 59%)要求的是「不出现」,
  // 遵守它的表现就是文案里找不到它——再要求「找到承接」方向就反了。
  // 反向违反检查(contradictions)对所有边界都做:那是本检查唯一能确定判定的事。
  const positiveBoundaries = boundaries.filter((boundary) => !isProhibitiveBoundary(boundary));
  const connectedBoundaries = positiveBoundaries.filter((boundary) => semanticallyConnected(boundary, visibleCopy));
  const boundaryCheck = boundaries.length === 0
    ? check("boundary_continuity", "pass", "计划没有额外边界，本项没有发现冲突。", [])
    : contradictions.length > 0
      ? check("boundary_continuity", "fail", `发现与禁止性边界方向相反的明确制作要求：${contradictions.join("；")}。`, boundaries)
      : positiveBoundaries.length === 0
        ? check("boundary_continuity", "pass", "计划边界全部是禁止性要求且未被正向违反；这类边界的正确落实就是可见文案中不出现。", boundaries)
        : connectedBoundaries.length > 0
          ? check("boundary_continuity", "pass", "可见文案承接了至少一项非禁止性计划边界，且未发现明确反向要求。", boundaries)
          : check("boundary_continuity", "not_evaluated", "非禁止性边界未找到词面承接；边界也可能作为隐式守则生效，词面判据无法判定，本项不参与总状态。", boundaries);

  return summarize([briefCheck, coverCheck, contentCheck, boundaryCheck]);
}

export interface BuildProductionArtifactsInput {
  plan?: OrchestrationPlan;
  content: ContentPackageContent;
  imageAnalyses?: ImageAssetAnalysis[];
  imageBriefEnabled?: boolean;
  previous?: ProductionArtifacts;
}

export function buildProductionArtifacts(input: BuildProductionArtifactsInput): ProductionArtifacts {
  const plan = input.plan;
  const sourceAssetId = plan?.imagePlan.sourceAssetId ?? plan?.imagePlan.primaryAssetId;
  const suppliedAnalysisIds = unique((input.imageAnalyses ?? []).map((analysis) => analysis.assetId));
  const previousAnalysisIds = input.previous?.imageObservation.analysisAssetIds ?? [];
  const analysisAssetIds = suppliedAnalysisIds.length ? suppliedAnalysisIds : [...previousAnalysisIds];
  const observationApproved = suppliedAnalysisIds.length > 0;
  const planToCopyAlignment = evaluatePlanToCopyAlignment(plan, input.content, input.imageBriefEnabled !== false);
  const briefDisabled = input.imageBriefEnabled === false;
  const hasBrief = Boolean(input.content.N.imageBrief.trim());
  return {
    schemaVersion: "1.0",
    imageObservation: {
      status: observationApproved ? "approved" : "not_supplied",
      ...(sourceAssetId ? { sourceAssetId } : {}),
      analysisAssetIds,
      note: suppliedAnalysisIds.length
        ? "这些图片分析已作为本次生成的审批输入；只有 observedFacts/visibleText 可作为可见事实。"
        : previousAnalysisIds.length
          ? "仅保留前一版本图片观察的资产索引；本次没有重新提供原始分析，因此状态为 not_supplied，索引也没有被当作新的观察或最终图片。"
          : "本次没有提供已审批的图片观察。",
    },
    imagePlan: {
      status: plan?.imagePlan ? "planned" : "absent",
      ...(sourceAssetId ? { sourceAssetId } : {}),
      note: plan?.imagePlan
        ? "这是图片制作计划；sourceAssetId 只指向规划所用来源素材，不代表最终图片。"
        : "历史包没有可追溯的图片计划。",
    },
    imageBrief: {
      status: briefDisabled
        ? "disabled"
        : !hasBrief
          ? "absent"
        : hasBrief && planToCopyAlignment.status === "pass"
          ? "contract_validated"
          : "drafted",
      note: briefDisabled
        ? "本次配置禁用了图片说明。"
        : hasBrief && planToCopyAlignment.status === "pass"
          ? "图片说明已通过计划到文案的一致性代理检查；这仍不代表最终图片已经生成。"
          : hasBrief
            ? "已有图片说明草稿，但一致性检查仍有警告或失败，尚未成为已验证制作契约。"
            : "配置要求图片说明，但当前草稿为空；内容校验会单独报告该问题。",
    },
    finalImageAsset: {
      status: "absent",
      note: "当前流程只生成图片计划和文字说明，没有生成、声明或核验最终图片资产。",
    },
    entrySnapshot: {
      status: "absent",
      note: "当前流程没有采集发布入口截图，因此不能推断真实封面、标题组合或平台呈现。",
    },
    deployment: {
      status: "not_deployed",
      note: "当前内容包尚未部署；deploymentPlan 只是计划，不是发布记录。",
    },
    planToCopyAlignment,
    finalAssetAlignment: notEvaluatedAlignment("没有最终图片资产，无法评估图片成品与计划/文案的一致性。"),
    entrySnapshotAlignment: notEvaluatedAlignment("没有发布入口快照，无法评估用户实际看到的图、题、文组合。"),
  };
}
