import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Images,
  Info,
  Layers3,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
  Unlock,
} from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Field, Modal, Skeleton, useToast } from "../components/Ui";
import { api } from "../lib/api";
import { inspectOpportunityApprovalDependencies, opportunityRequiresReview } from "../lib/opportunity-approval";
import { resolveOpportunityRankView } from "../lib/opportunity-rank";
import { TREND_FIT_SIMPLE_BOUNDARY_COPY } from "../lib/trend-fit";
import {
  buildSimpleGenerateInput,
  COMMENT_RICHNESS_PROFILES,
  resolveSimpleGenerationSettings,
  shouldShowSimpleLocalFields,
  type CommentRichnessLevel,
  type SimpleSettingOverrides,
  type SimpleSettingSource,
} from "../lib/simple-generation";
import type {
  AnalysisTask,
  ContentPreset,
  ExpressionStrategy,
  GenerateInput,
  ImageAsset,
  InformationGap,
  Project,
  ProjectBlueprintModule,
  ProjectIntelligence,
  PlanningRandomizationDimension,
  TopicOpportunity,
} from "../types";

type PoolTab = "gaps" | "strategies";

const blueprintModuleMeta: Record<ProjectBlueprintModule["moduleKey"], { label: string; description: string }> = {
  knowledge_map: { label: "知识来源地图", description: "区分项目事实、行业资料、动态信息、边界与仅供风格分析的样本。" },
  domain_model: { label: "行业与项目语义", description: "项目名词、对象、动作、概念、决策任务和项目词汇。" },
  audience_model: { label: "读者状态模型", description: "不同阶段的目标、知识状态、现实限制、犹豫原因和行动条件。" },
  scenario_model: { label: "人物场景模型", description: "可组合的时间、地点、事件、动作、摩擦、情绪和图片时刻。" },
  role_model: { label: "评论角色模型", description: "角色的社会位置、关系、动机、知识范围、口吻和可贡献信息。" },
  claim_policy: { label: "声明与证据规则", description: "项目中的价格、身份、资质、结果、时效等受控信息及证据要求。" },
  surface_language: { label: "项目自然语言", description: "项目常用词、可选口语、禁用套话和防照抄要求。" },
};

const GAP_METRIC_FIELDS: Array<{ key: "importance" | "decisionLeverage" | "proofability"; label: string; hint: string }> = [
  { key: "importance", label: "重要性", hint: "该信息对读者决策有多重要。" },
  { key: "decisionLeverage", label: "决策撬动", hint: "回答它能多大程度改变读者的选择。" },
  { key: "proofability", label: "可证性", hint: "项目知识库能否给出可核验的回答；无证据时给低值。" },
];

const OPPORTUNITY_METRIC_FIELDS: Array<{ key: "relevance" | "importance" | "proofability" | "novelty" | "decisionLeverage" | "cognitiveCost" | "risk"; label: string; hint: string }> = [
  { key: "relevance", label: "相关性", hint: "选题与项目和读者需求的贴合度。" },
  { key: "importance", label: "重要性", hint: "选题对读者决策的重要程度。" },
  { key: "proofability", label: "可证性", hint: "能否用已核验知识支撑；无证据给低值。" },
  { key: "novelty", label: "新颖度", hint: "相对既有内容的差异化程度。" },
  { key: "decisionLeverage", label: "决策撬动", hint: "内容能多大程度推动读者下一步。" },
  { key: "cognitiveCost", label: "认知成本", hint: "读者理解该选题的负担；越高排序越靠后。" },
  { key: "risk", label: "风险", hint: "合规或表达风险；越高越受排序策略限制。" },
];

const AUDIENCE_STAGE_OPTIONS = [
  { value: "discovering", label: "刚发现问题" },
  { value: "collecting", label: "收集信息中" },
  { value: "comparing", label: "比较选择中" },
  { value: "hesitating", label: "犹豫风险中" },
  { value: "ready", label: "准备行动" },
];

const ENTRY_OPTIONS = [
  { value: "search", label: "搜索进入" },
  { value: "recommendation", label: "推荐流" },
  { value: "profile", label: "主页进入" },
  { value: "return_visit", label: "回访" },
];

const latestBlueprintModules = (items: ProjectBlueprintModule[]) => [...items]
  .sort((left, right) => right.version - left.version)
  .filter((item, index, all) => all.findIndex((candidate) => candidate.moduleKey === item.moduleKey) === index)
  .sort((left, right) => Object.keys(blueprintModuleMeta).indexOf(left.moduleKey) - Object.keys(blueprintModuleMeta).indexOf(right.moduleKey));

function blueprintModuleSummary(module: ProjectBlueprintModule): string {
  const data = module.data ?? {};
  const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
  switch (module.moduleKey) {
    case "knowledge_map": return `当前识别 ${count(data.entries)} 个知识来源区段`;
    case "domain_model": return `当前项目名词：${String(data.projectNoun || "待补充")} · 行业：${String(data.industry || data.domain || "待补充")}`;
    case "audience_model": return `当前覆盖 ${count(data.states)} 类读者状态`;
    case "scenario_model": return `当前可用 ${count(data.families)} 个场景家族`;
    case "role_model": return `当前可用 ${count(data.roles)} 类评论角色`;
    case "claim_policy": return `当前有 ${count(data.rules)} 条声明规则 · ${count(data.prohibitedClaims)} 条禁用声明`;
    case "surface_language": return `当前有 ${count(data.preferredTerms)} 个推荐词 · ${count(data.optionalColloquialisms)} 个可选口语线索`;
  }
}

interface Props {
  projects: Project[];
  projectId: string;
  selectedPresetId?: string;
  selectedPreset?: ContentPreset;
  submitting: boolean;
  onProject: (id: string) => void;
  onPreview: (input: GenerateInput) => void;
}

const intelligenceLabel: Record<ProjectIntelligence["status"], string> = {
  missing: "尚未分析",
  draft: "分析完成，等待确认",
  stale: "需要更新",
  queued: "等待分析",
  analyzing: "正在分析",
  ready: "智能地图已就绪",
  failed: "分析失败",
  rejected: "本版分析已退回",
};

const simpleRandomizationDimensions: PlanningRandomizationDimension[] = [
  "strategy",
  "opening",
  "state_seed",
  "narrative_sequence",
  "channel_allocation",
  "body_role",
  "comment_topology",
  "voice",
  "image_role",
  "gap_order",
];

const simpleStages = [
  { id: "discovering", title: "刚开始了解" },
  { id: "collecting", title: "正在收集信息" },
  { id: "comparing", title: "正在比较选择" },
  { id: "hesitating", title: "已了解但犹豫" },
  { id: "ready", title: "准备采取下一步" },
];

const simpleEntries = [
  { id: "search", title: "主动搜索" },
  { id: "recommendation", title: "推荐流情景（来源未核实）" },
  { id: "profile", title: "主页浏览" },
  { id: "return_visit", title: "再次访问" },
];

const settingSourceLabel: Record<SimpleSettingSource, string> = {
  user: "本次修改",
  opportunity: "选题建议",
  preset: "当前模板",
  project: "项目默认",
  default: "系统默认",
};

function SettingSourceBadge({ source }: { source: SimpleSettingSource }) {
  return <Badge tone={source === "user" ? "blue" : source === "opportunity" ? "purple" : source === "preset" ? "positive" : "neutral"}>{settingSourceLabel[source]}</Badge>;
}

function OpportunityRankDisclosure({ opportunity }: { opportunity: TopicOpportunity }) {
  const view = resolveOpportunityRankView(opportunity);
  return <section className={`opportunity-rank-disclosure ${view.historical ? "is-historical" : view.sortable ? "is-sortable" : "needs-review"}`} aria-label="机会排序审计">
    <header>
      <div><strong>{view.title}{view.version ? ` · ${view.version}` : ""}</strong><p>固定权重、未标定的内部排序工具；不是 F28，也不是阅读量、转化率或因果效果预测。</p></div>
      <div><Badge tone={view.sortable ? "positive" : "warning"}>{view.stateLabel}</Badge><b>{view.valueLabel}</b>{view.rankLabel && <small>{view.rankLabel}</small>}</div>
    </header>
    {view.warning && <div className="opportunity-rank-warning"><TriangleAlert size={15} /><span>{view.warning}</span></div>}
    {view.components.length > 0 ? <div className="opportunity-rank-components">
      {view.components.map((component) => <article className={component.unknown ? "is-unknown" : ""} key={component.metric}>
        <span><strong>{component.label}</strong><Badge tone={component.unknown ? "warning" : "neutral"}>{component.unknown ? "unknown" : `值 ${component.value}`}</Badge></span>
        <small>变换值 {component.transformedValue} · 固定权重 {component.weight} · 贡献 {component.contribution}</small>
        <p>来源：{component.source}</p>
      </article>)}
    </div> : <p className="opportunity-rank-empty">没有服务端分项审计，页面不会根据旧字段自行重算或补零。</p>}
    {(view.inputSources.length > 0 || view.policy?.length) && <div className="opportunity-rank-provenance">
      <span><strong>排序输入来源</strong>{view.inputSources.map((item) => <small key={item.label}>{item.label}：{item.source}</small>)}</span>
      <span><strong>本次阈值策略</strong>{view.policy?.map((item) => <small key={item.label}>{item.label}：{item.value}</small>) || <small>unknown（未记录）</small>}</span>
    </div>}
    <footer>
      <span><strong>历史覆盖</strong>{view.recentCoverage.value}<small>来源：{view.recentCoverage.source}</small></span>
      <span><strong>unknown</strong>{view.unknownMetrics.length ? view.unknownMetrics.join("、") : "无"}</span>
      <span><strong>复核原因</strong>{view.reviewReasons.length ? view.reviewReasons.join("；") : view.sortable ? "无" : "服务端未提供完整可排序条件"}</span>
    </footer>
  </section>;
}

export function IntelligentSimpleFlow({ projects, projectId, selectedPresetId, selectedPreset, submitting, onProject, onPreview }: Props) {
  const [intelligence, setIntelligence] = useState<ProjectIntelligence | null>(null);
  const [latestTask, setLatestTask] = useState<AnalysisTask | null>(null);
  const [blueprintModules, setBlueprintModules] = useState<ProjectBlueprintModule[]>([]);
  const [opportunities, setOpportunities] = useState<TopicOpportunity[]>([]);
  const [gaps, setGaps] = useState<InformationGap[]>([]);
  const [strategies, setStrategies] = useState<ExpressionStrategy[]>([]);
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolTab, setPoolTab] = useState<PoolTab>("gaps");
  const [search, setSearch] = useState("");
  const [editingGap, setEditingGap] = useState<Partial<InformationGap> | null>(null);
  const [editingStrategy, setEditingStrategy] = useState<Partial<ExpressionStrategy> | null>(null);
  const [editingBlueprintModule, setEditingBlueprintModule] = useState<ProjectBlueprintModule | null>(null);
  const [editingBlueprintJson, setEditingBlueprintJson] = useState("");
  const [editingOpportunity, setEditingOpportunity] = useState<Partial<TopicOpportunity> | null>(null);
  const [editingQuality, setEditingQuality] = useState<ImageAsset | null>(null);
  const [qualityDraft, setQualityDraft] = useState<{ clarity: number; relevance: number; textLegibility: number }>({ clarity: 0.5, relevance: 0.5, textLegibility: 0.5 });
  const [settingOverrides, setSettingOverrides] = useState<SimpleSettingOverrides>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // Surface the most recent analysis task so background failures/retries stay
  // visible; never coerced from intelligence.status alone. Non-fatal.
  const refreshLatestTask = () => {
    if (!projectId) return Promise.resolve();
    return api.intelligence.tasks.list(projectId).then((tasks) => {
      const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setLatestTask(sorted[0] ?? null);
    }).catch(() => { /* non-fatal */ });
  };

  const load = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [nextIntelligence, nextBlueprintModules, nextOpportunities, nextGaps, nextStrategies, nextAssets] = await Promise.all([
        api.intelligence.get(projectId).catch(() => ({ projectId, status: "missing" as const })),
        api.blueprintModules.list(projectId).catch(() => []),
        api.opportunities.list(projectId).catch(() => ({ items: [], total: 0 })),
        api.informationGaps.list(projectId).catch(() => ({ items: [], total: 0 })),
        api.expressionStrategies.list(projectId).catch(() => ({ items: [], total: 0 })),
        api.imageAssets.list(projectId).catch(() => ({ items: [], total: 0 })),
      ]);
      setIntelligence(nextIntelligence);
      setBlueprintModules(latestBlueprintModules(nextBlueprintModules));
      setOpportunities(nextOpportunities.items);
      setGaps(nextGaps.items);
      setStrategies(nextStrategies.items);
      setAssets(nextAssets.items.map((asset) => ({ ...asset, previewUrl: asset.previewUrl || api.imageAssets.contentUrl(projectId, asset.id) })));
    } finally {
      setLoading(false);
    }
    refreshLatestTask();
  };

  useEffect(() => {
    setSelectedOpportunityId("");
    setSelectedAssetIds([]);
    setSettingOverrides({});
    void load();
  }, [projectId]);

  useEffect(() => {
    if (!intelligence || !["queued", "analyzing"].includes(intelligence.status)) return;
    const timer = window.setInterval(() => {
      api.intelligence.get(projectId).then((next) => {
        setIntelligence(next);
        if (next.status === "ready") {
          window.clearInterval(timer);
          void refreshOpportunities();
        }
      }).catch(() => undefined);
      refreshLatestTask();
    }, 1800);
    return () => window.clearInterval(timer);
  }, [intelligence?.status, projectId]);

  const selectedOpportunity = opportunities.find((item) => item.id === selectedOpportunityId);
  const blueprintReady = blueprintModules.length === Object.keys(blueprintModuleMeta).length
    && blueprintModules.every((module) => module.status === "approved");
  const currentProject = projects.find((project) => project.id === projectId);
  const resolvedSettings = useMemo(() => resolveSimpleGenerationSettings({
    overrides: settingOverrides,
    opportunity: selectedOpportunity,
    preset: selectedPreset,
    project: currentProject,
  }), [currentProject, selectedOpportunity, selectedPreset, settingOverrides]);
  const showLocalFields = shouldShowSimpleLocalFields(resolvedSettings.audienceStage.value, selectedPreset?.id);
  const opportunityGaps = selectedOpportunity?.gapIds
    .map((id) => gaps.find((gap) => gap.id === id))
    .filter((gap): gap is InformationGap => Boolean(gap)) || [];
  const compatibleStrategies = selectedOpportunity?.compatibleStrategyIds
    .map((id) => strategies.find((strategy) => strategy.id === id))
    .filter((strategy): strategy is ExpressionStrategy => Boolean(strategy)) || [];
  const opportunityDependencies = useMemo(
    () => inspectOpportunityApprovalDependencies(selectedOpportunity, gaps, strategies),
    [gaps, selectedOpportunity, strategies],
  );
  const pendingDependencyCount = opportunityDependencies.unapprovedGaps.length
    + opportunityDependencies.unapprovedStrategies.length;
  const missingDependencyCount = opportunityDependencies.missingGapIds.length
    + opportunityDependencies.missingStrategyIds.length;
  const lockedStrategy = strategies.find((strategy) => strategy.enabled && strategy.locked && strategy.status === "approved");
  const filteredGaps = useMemo(() => gaps.filter((item) => !search || `${item.label}${item.question}${item.category}`.toLowerCase().includes(search.toLowerCase())), [gaps, search]);
  const filteredStrategies = useMemo(() => strategies.filter((item) => !search || `${item.name}${item.description}`.toLowerCase().includes(search.toLowerCase())), [strategies, search]);

  const analyzeProject = async () => {
    setAnalyzing(true);
    try {
      const result = await api.intelligence.analyze(projectId, true);
      setIntelligence(result.intelligence);
      setBlueprintModules(latestBlueprintModules(result.blueprintModules));
      setGaps(result.informationGaps);
      setStrategies(result.expressionStrategies);
      setOpportunities(result.topicOpportunities);
      setSelectedOpportunityId("");
      await refreshLatestTask();
      toast.push("项目分析完成，请确认分析结果后用于创作", "info");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "项目分析失败", "error");
    } finally {
      setAnalyzing(false);
    }
  };

  const refreshOpportunities = async () => {
    setRefreshing(true);
    try {
      const result = await api.opportunities.refresh(projectId);
      setOpportunities(result.items);
      setSelectedOpportunityId("");
      await load();
      toast.push(`已生成 ${result.items.length} 张待确认选题卡`, "info");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "选题刷新失败", "error");
    } finally {
      setRefreshing(false);
    }
  };

  const uploadImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files.slice(0, 9)) {
        if (!/^image\/(jpeg|png|webp)$/u.test(file.type) || file.size > 8 * 1024 * 1024) {
          toast.push(`${file.name} 不是支持的图片或超过 8 MiB`, "error");
          continue;
        }
        const created = await api.imageAssets.upload(projectId, file);
        const analyzed = await api.imageAssets.analyze(projectId, created.id).catch(() => created);
        setAssets((current) => [{ ...analyzed, previewUrl: api.imageAssets.contentUrl(projectId, analyzed.id) }, ...current.filter((item) => item.id !== analyzed.id)]);
      }
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const openQualityEditor = (asset: ImageAsset) => {
    const q = asset.analysis?.quality;
    setQualityDraft({
      clarity: q?.clarity ?? 0.5,
      relevance: q?.relevance ?? 0.5,
      textLegibility: q?.textLegibility ?? 0.5,
    });
    setEditingQuality(asset);
  };

  const approveAsset = async (asset: ImageAsset) => {
    const q = asset.analysis?.quality;
    const missing = !q || [q.clarity, q.relevance, q.textLegibility].some((v) => v === null || v === undefined);
    if (missing) {
      openQualityEditor(asset);
      return;
    }
    const updated = await api.imageAssets.approve(projectId, asset.id, asset.latestAnalysisId);
    setAssets((current) => current.map((item) => item.id === asset.id ? { ...updated, previewUrl: item.previewUrl } : item));
    toast.push("图片观察已确认，可用于支撑可见事实");
  };

  const saveQuality = async () => {
    if (!editingQuality?.latestAnalysisId) return;
    const saved = await api.imageAssets.updateAnalysis(projectId, editingQuality.id, editingQuality.latestAnalysisId, qualityDraft);
    setAssets((current) => current.map((item) => (item.id === saved.id ? { ...saved, previewUrl: item.previewUrl } : item)));
    setEditingQuality(null);
    toast.push("源素材质量评估已补全，可确认");
  };

  const gapMetricsMissing = (gap: Partial<InformationGap>): boolean =>
    gap.importance == null || gap.decisionLeverage == null || gap.proofability == null;

  const approvePlanningResources = async () => {
    if (!intelligence?.id) return;
    const pendingGaps = gaps.filter((item) => item.status !== "approved");
    const gapsMissingMetrics = pendingGaps.filter(gapMetricsMissing);
    if (gapsMissingMetrics.length) {
      toast.push(
        `有 ${gapsMissingMetrics.length} 个信息缺口缺少评审度量（重要性/决策撬动/可证性），无法确认：${gapsMissingMetrics.slice(0, 3).map((item) => item.label).join("、")}${gapsMissingMetrics.length > 3 ? " 等" : ""}。点击缺口的编辑按钮补齐这三项后再确认。`,
        "error",
      );
      setEditingGap(gapsMissingMetrics[0]);
      setPoolTab("gaps");
      setPoolOpen(true);
      return;
    }
    setApproving(true);
    try {
      const approvedModules = await Promise.all(
        blueprintModules.filter((item) => item.status !== "approved").map((item) => api.blueprintModules.approve(projectId, item.id)),
      );
      const [approvedGaps, approvedStrategies] = await Promise.all([
        Promise.all(gaps.filter((item) => item.status !== "approved").map((item) => api.informationGaps.approve(projectId, item.id))),
        Promise.all(strategies.filter((item) => item.status !== "approved").map((item) => api.expressionStrategies.approve(projectId, item.id))),
      ]);
      const approvedIntelligence = await api.intelligence.approve(projectId, intelligence.id);
      setIntelligence(approvedIntelligence);
      setBlueprintModules((current) => current.map((item) => approvedModules.find((next) => next.id === item.id) || item));
      setGaps((current) => current.map((item) => approvedGaps.find((next) => next.id === item.id) || item));
      setStrategies((current) => current.map((item) => approvedStrategies.find((next) => next.id === item.id) || item));
      toast.push("项目创作模型、信息缺口和表达策略已分别确认");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "确认分析结果失败", "error");
    } finally {
      setApproving(false);
    }
  };

  const saveGap = async () => {
    if (!editingGap?.label?.trim() || !editingGap.question?.trim()) return;
    // Metrics are edited as 0..1 in state; default any untouched metric to a
    // conservative estimate so the gap can pass the backend approval gate.
    const withMetrics: Partial<InformationGap> = {
      ...editingGap,
      importance: editingGap.importance ?? 0.5,
      decisionLeverage: editingGap.decisionLeverage ?? 0.5,
      proofability: editingGap.proofability ?? 0.3,
    };
    const saved = editingGap.id
      ? await api.informationGaps.update(projectId, editingGap.id, withMetrics)
      : await api.informationGaps.create(projectId, {
          ...withMetrics,
          projectId,
          stages: editingGap.stages || ["collecting"],
          decisionTasks: editingGap.decisionTasks || [],
          sourceType: "user",
          evidenceStatus: "user_supplied",
          answerability: editingGap.answerability || "verifiable",
          evidenceIds: editingGap.evidenceIds || [],
          priority: editingGap.priority ?? 60,
          enabled: true,
          locked: false,
          category: editingGap.category || "用户补充",
        });
    setGaps((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setEditingGap(null);
  };

  const saveOpportunity = async () => {
    if (!editingOpportunity?.id) return;
    // Metrics are edited as 0..1 in state; default untouched ones conservatively.
    const saved = await api.opportunities.update(projectId, editingOpportunity.id, {
      ...editingOpportunity,
      relevance: editingOpportunity.relevance ?? 0.5,
      importance: editingOpportunity.importance ?? 0.5,
      proofability: editingOpportunity.proofability ?? 0.3,
      novelty: editingOpportunity.novelty ?? 0.5,
      decisionLeverage: editingOpportunity.decisionLeverage ?? 0.5,
      cognitiveCost: editingOpportunity.cognitiveCost ?? 0.5,
      risk: editingOpportunity.risk ?? 0.3,
      eligibilityStatus: editingOpportunity.eligibilityStatus || "eligible",
    });
    setOpportunities((current) => current.map((item) => item.id === saved.id ? saved : item));
    setEditingOpportunity(null);
    toast.push("选题度量已保存；卡片回到待确认，需重新确认选题", "info");
  };

  const deleteOpportunity = async (item: TopicOpportunity) => {
    if (!window.confirm(`确定删除选题「${item.title}」吗？`)) return;
    await api.opportunities.remove(projectId, item.id);
    setOpportunities((current) => current.filter((opp) => opp.id !== item.id));
    if (selectedOpportunityId === item.id) setSelectedOpportunityId("");
  };

  const openBlueprintEditor = (module: ProjectBlueprintModule) => {
    setEditingBlueprintModule(module);
    setEditingBlueprintJson(JSON.stringify(module.data, null, 2));
  };

  const saveBlueprintModule = async () => {
    if (!editingBlueprintModule) return;
    try {
      const parsed = JSON.parse(editingBlueprintJson) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模块内容必须是 JSON 对象");
      const saved = await api.blueprintModules.update(projectId, editingBlueprintModule.id, parsed);
      setBlueprintModules((current) => latestBlueprintModules([
        saved,
        ...current.filter((item) => item.id !== editingBlueprintModule.id),
      ]));
      setIntelligence((current) => current ? { ...current, status: "stale" } : current);
      setEditingBlueprintModule(null);
      setEditingBlueprintJson("");
      toast.push("模块已保存；受影响的下游模块和选题需要重新确认", "info");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "项目创作模型保存失败", "error");
    }
  };

  const saveStrategy = async () => {
    if (!editingStrategy?.name?.trim() || !editingStrategy.description?.trim()) return;
    const input: Partial<ExpressionStrategy> = {
      ...editingStrategy,
      projectId,
      routePolicy: editingStrategy.routePolicy || "标签与标题直接对应选题和入口",
      imagePolicy: editingStrategy.imagePolicy || "图片承担状态与场景，不能证明的内容不写成事实",
      imageRole: editingStrategy.imageRole || "other",
      titlePolicy: editingStrategy.titlePolicy || "标题形成具体查询入口",
      bodyPolicy: editingStrategy.bodyPolicy || "正文保留共同前提、核心回答和必要边界",
      commentPolicy: editingStrategy.commentPolicy || "评论按状态人设展开残余缺口",
      deploymentPolicy: editingStrategy.deploymentPolicy || "发布身份透明，专业问题转接",
      compatibleGapTypes: editingStrategy.compatibleGapTypes || [],
      incompatibleConditions: editingStrategy.incompatibleConditions || [],
      randomizableDimensions: editingStrategy.randomizableDimensions || ["state", "allocation", "thread"],
      weight: editingStrategy.weight ?? 60,
      enabled: editingStrategy.enabled ?? true,
      locked: editingStrategy.locked ?? false,
      source: editingStrategy.source || "user",
    };
    const saved = editingStrategy.id
      ? await api.expressionStrategies.update(projectId, editingStrategy.id, input)
      : await api.expressionStrategies.create(projectId, input);
    setStrategies((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    setEditingStrategy(null);
  };

  const preview = async () => {
    if (!selectedOpportunity) return;
    const unapprovedImages = assets.filter((asset) => selectedAssetIds.includes(asset.id) && !asset.approved);
    if (unapprovedImages.length) {
      toast.push("请先确认已选图片的 AI 观察；未经确认的图片不会作为事实依据", "error");
      return;
    }
    if (intelligence?.status !== "ready" || !blueprintReady) {
      toast.push("请先确认项目分析及全部七个项目创作模型模块", "error");
      return;
    }
    // This gate intentionally precedes dependency approvals. Otherwise a
    // non-selectable opportunity could leave gaps/strategies partially approved.
    if (opportunityRequiresReview(selectedOpportunity)) {
      const missing = selectedOpportunity.unknownMetrics?.length
        ? `（待补充：${selectedOpportunity.unknownMetrics.join("、")}）`
        : "";
      toast.push(`这张选题的评估信息尚不完整${missing}，请先完成审核或换一张选题。`, "error");
      return;
    }
    if (!selectedOpportunity.gapIds.length) {
      toast.push("这张选题没有引用任何信息缺口，无法确认。请点击“换一批”，或在信息缺口池修复选题来源。", "error");
      return;
    }
    if (missingDependencyCount) {
      const missing = [
        opportunityDependencies.missingGapIds.length
          ? `信息缺口 ${opportunityDependencies.missingGapIds.join("、")}`
          : "",
        opportunityDependencies.missingStrategyIds.length
          ? `表达策略 ${opportunityDependencies.missingStrategyIds.join("、")}`
          : "",
      ].filter(Boolean).join("；");
      toast.push(`选题引用的资源已缺失（${missing}）。请点击“换一批”，或打开资源池修复引用后再生成。`, "error");
      return;
    }
    setPreparing(true);
    try {
      const approvedGaps: InformationGap[] = [];
      for (const gap of opportunityDependencies.unapprovedGaps) {
        approvedGaps.push(await api.informationGaps.approve(projectId, gap.id));
      }
      if (approvedGaps.length) {
        setGaps((current) => current.map((item) => approvedGaps.find((next) => next.id === item.id) || item));
      }

      const approvedStrategies: ExpressionStrategy[] = [];
      for (const strategy of opportunityDependencies.unapprovedStrategies) {
        approvedStrategies.push(await api.expressionStrategies.approve(projectId, strategy.id));
      }
      if (approvedStrategies.length) {
        setStrategies((current) => current.map((item) => approvedStrategies.find((next) => next.id === item.id) || item));
      }
      if (approvedGaps.length || approvedStrategies.length) {
        toast.push(`已通过独立审批确认 ${approvedGaps.length} 个信息缺口和 ${approvedStrategies.length} 个表达策略；现在确认选题。`, "info");
      }

      const approvedOpportunity = selectedOpportunity.status === "approved"
        ? selectedOpportunity
        : await api.opportunities.approve(projectId, selectedOpportunity.id);
      setOpportunities((current) => current.map((item) => item.id === approvedOpportunity.id ? approvedOpportunity : item));
      const lockedGapIds = gaps
        .filter((item) => item.enabled && item.locked && item.status === "approved")
        .map((item) => item.id);
      const lockedStrategyId = approvedOpportunity.strategyId
        || strategies.find((item) => item.enabled && item.locked && item.status === "approved")?.id;
      onPreview(buildSimpleGenerateInput({
        projectId,
        opportunity: approvedOpportunity,
        settings: resolvedSettings,
        imageAssetIds: selectedAssetIds,
        lockedGapIds,
        lockedStrategyId,
        presetId: selectedPresetId || undefined,
        localFieldsEnabled: showLocalFields,
        randomizationDimensions: simpleRandomizationDimensions,
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      toast.push(`无法完成选题确认：${reason}。请在信息缺口池/表达策略池确认失败项，或重新分析项目后再试。`, "error");
    } finally {
      setPreparing(false);
    }
  };

  if (loading) return <section className="intelligence-flow"><Skeleton lines={10} /></section>;

  return <div className="intelligence-flow">
    <section className="intelligence-project panel">
      <header><div><span>第 1 步</span><h2>选择项目，让 AI 建立内容地图</h2><p>行业知识负责发现问题，项目知识负责特色答案与事实边界。</p></div><Badge tone={intelligence?.status === "ready" && blueprintReady ? "positive" : "warning"}>{intelligence?.status === "ready" && !blueprintReady ? "项目模型待确认" : intelligence ? intelligenceLabel[intelligence.status] : "尚未分析"}</Badge></header>
      <div className="intelligence-project__body">
        <Field label="当前项目"><select value={projectId} onChange={(event) => onProject(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>
        <div className="intelligence-status"><BrainCircuit size={22} /><div><strong>{intelligence?.entity || "等待识别项目核心名词"}</strong><p>{intelligence?.industry || "分析后形成行业概念树、决策任务和信息缺口池。"}</p>{intelligence?.staleReasons?.length ? <small>需要更新：{intelligence.staleReasons.join("；")}</small> : null}{intelligence?.status === "draft" ? <small>AI 生成的是待审核规划，不会自动升级为项目事实。</small> : null}</div><div className="panel-actions">{intelligence?.id && (intelligence.status !== "ready" || !blueprintReady) && <Button loading={approving} icon={<Check size={15} />} onClick={approvePlanningResources}>逐项确认本批模型</Button>}<Button variant={intelligence?.status === "draft" ? "secondary" : "primary"} loading={analyzing || intelligence?.status === "analyzing"} icon={<RefreshCw size={15} />} onClick={analyzeProject}>{intelligence?.status === "ready" ? "重新分析" : "分析项目"}</Button></div></div>
        {latestTask && latestTask.status === "failed" && <div className="blueprint-missing"><TriangleAlert size={16} /><span>后台分析失败（已尝试 {latestTask.attemptCount} 次）：{latestTask.error || "未知错误"}。请重新分析，或检查项目知识后再试。</span></div>}
        {latestTask && (latestTask.status === "running" || latestTask.status === "queued") && <div className="blueprint-missing"><RefreshCw size={16} /><span>后台分析进行中…（第 {latestTask.attemptCount} 次尝试）完成前请勿离开或重复触发。</span></div>}
        {blueprintModules.length ? <div className="blueprint-module-grid">
          {blueprintModules.map((module) => { const meta = blueprintModuleMeta[module.moduleKey]; return <article key={module.id}>
            <header><div><strong>{meta.label}</strong><small>v{module.version}</small></div><Badge tone={module.status === "approved" ? "positive" : module.status === "stale" ? "warning" : "neutral"}>{module.status === "approved" ? "已确认" : module.status === "stale" ? "受上游修改影响" : "待确认"}</Badge></header>
            <p>{meta.description}</p>
            <small><strong>{blueprintModuleSummary(module)}</strong><br />这里的内容会作为项目参数进入生成；静态提示词不会替你补行业角色和场景。</small>
            <footer>{module.status !== "approved" && <button type="button" onClick={() => void api.blueprintModules.approve(projectId, module.id).then((saved) => setBlueprintModules((current) => current.map((item) => item.id === saved.id ? saved : item)))}>确认模块</button>}<button type="button" onClick={() => openBlueprintEditor(module)}><Pencil size={13} /> 编辑</button></footer>
          </article>; })}
        </div> : intelligence?.id ? <div className="blueprint-missing"><TriangleAlert size={16} /><span>当前分析没有完整项目创作模型，必须重新分析后才能正式生成。</span></div> : null}
      </div>
    </section>

    <section className="opportunity-panel panel">
      <header>
        <div><span>第 2 步</span><h2>选择一个值得写的信息缺口</h2><p>选题来自行业问题与项目可回答空间的交集，不要求你先写提示词。卡片顺序如有排序，仅采用“机会排序启发式 V1”。</p></div>
        <div className="panel-actions">
          <Button variant="ghost" onClick={() => { setPoolTab("gaps"); setPoolOpen(true); }} icon={<Layers3 size={15} />}>信息缺口池</Button>
          <Button variant="ghost" onClick={() => { setPoolTab("strategies"); setPoolOpen(true); }} icon={<Sparkles size={15} />}>表达策略池</Button>
          <Button loading={refreshing} disabled={intelligence?.status !== "ready" || !blueprintReady} onClick={refreshOpportunities} icon={<RefreshCw size={15} />}>换一批</Button>
        </div>
      </header>
      <div className="opportunity-ranking-boundary"><Info size={16} /><div><strong>排序只帮助比较当前候选，不证明平台效果</strong><p>OpportunityRankHeuristicV1 使用固定但未标定的内部权重；它不是 F28 的机会公式，不是需求、竞品、阅读量或转化因果预测。输入 unknown 的卡片保持待复核，不会显示成 0 分。</p></div></div>
      {opportunities.length ? (
        <div className="opportunity-grid">
          {opportunities.slice(0, 12).map((item) => { const rankView = resolveOpportunityRankView(item); return (
            <button type="button" key={item.id} className={`opportunity-card ${selectedOpportunityId === item.id ? "selected" : ""}`} onClick={() => { setSelectedOpportunityId(item.id); setSelectedAssetIds(item.suggestedImageAssetIds || []); }}>
              <div>
                <Badge tone={item.answerability === "approved" ? "positive" : item.answerability === "verifiable" ? "warning" : "neutral"}>{item.answerability === "approved" ? "有批准答案" : item.answerability === "verifiable" ? "可给核验方法" : "保留未知"}</Badge>
                <Badge tone={item.status === "approved" ? "positive" : "neutral"}>{item.status === "approved" ? "选题已确认" : "AI 草案"}</Badge>
                {item.coverageStatus && <Badge>{item.coverageStatus === "new" ? "近期未写" : "近期覆盖"}</Badge>}
              </div>
              <div className={`opportunity-card__rank ${rankView.sortable ? "is-sortable" : "needs-review"}`}><strong>{rankView.title}</strong><Badge tone={rankView.sortable ? "positive" : "warning"}>{rankView.valueLabel}</Badge>{rankView.unknownMetrics.length > 0 && <small>unknown：{rankView.unknownMetrics.map((metric) => metric).join("、")}</small>}<span className="opportunity-card__edit" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); setEditingOpportunity(item); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); setEditingOpportunity(item); } }}><Pencil size={13} /> 编辑度量</span><span className="opportunity-card__edit" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); void deleteOpportunity(item); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); void deleteOpportunity(item); } }}><Trash2 size={13} /> 删除</span></div>
              <h3>{item.title}</h3>
              <p>{item.summary || item.coreQuestion}</p>
              <small><strong>为什么值得写：</strong>{item.whyValuable}</small>
              {item.projectAngle && <small><strong>项目特色：</strong>{item.projectAngle}</small>}
              <span>{selectedOpportunityId === item.id ? <Check size={15} /> : <ChevronRight size={15} />}</span>
            </button>
          ); })}
        </div>
      ) : <EmptyState icon={<BrainCircuit size={24} />} title="还没有选题卡" description={intelligence?.status === "ready" ? "点击“换一批”从信息缺口池生成选题。" : "先完成项目分析，再从行业和项目知识中发现选题。"} />}
      {selectedOpportunity && <OpportunityRankDisclosure opportunity={selectedOpportunity} />}
    </section>

    <section className="simple-key-settings panel">
      <header>
        <div><span>第 3 步 · 本次生成关键设置</span><h2>重要信息在这里确认，简单模式可以直接生成</h2><p>只保留真正影响写给谁、从哪里进入和必须遵守什么的设置；数值权重等复杂参数继续由模板管理。</p></div>
        <Button variant="ghost" disabled={!Object.keys(settingOverrides).length} icon={<RotateCcw size={15} />} onClick={() => setSettingOverrides({})}>恢复智能推荐</Button>
      </header>
      <div className="trendfit-simple-boundary"><Info size={16} /><div><strong>简单模式不会把标签或推荐入口换算成 TrendFit</strong><p>{TREND_FIT_SIMPLE_BOUNDARY_COPY}</p></div><Badge tone="warning">不参与生成排序</Badge></div>
      <div className="simple-key-settings__body">
        <div className="simple-editable-settings">
          <div className="simple-preset-context">
            <div><small>当前模板 <SettingSourceBadge source={selectedPreset ? "preset" : "project"} /></small><strong>{selectedPreset?.name || "项目默认模板"}</strong><p>{selectedPreset?.description || "未手动选择模板，将按项目与系统默认配置生成。"}</p></div>
            <Button variant="ghost" onClick={() => document.querySelector(".preset-shelf")?.scrollIntoView({ behavior: "smooth", block: "start" })}>到上方更换模板</Button>
          </div>

          <div className="simple-settings-grid">
            <label className="simple-setting-field"><span><strong>读者阶段</strong><SettingSourceBadge source={resolvedSettings.audienceStage.source} /></span><select value={resolvedSettings.audienceStage.value} onChange={(event) => setSettingOverrides((current) => ({ ...current, audienceStage: event.target.value }))}>{simpleStages.map((stage) => <option key={stage.id} value={stage.id}>{stage.title}</option>)}</select><small>决定正文与评论先补哪一类决策信息。</small></label>
            <label className="simple-setting-field"><span><strong>内容入口</strong><SettingSourceBadge source={resolvedSettings.entryPoint.source} /></span><select value={resolvedSettings.entryPoint.value} onChange={(event) => setSettingOverrides((current) => ({ ...current, entryPoint: event.target.value }))}>{simpleEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select><small>{resolvedSettings.entryPoint.value === "recommendation" ? "仅设置写作入口情景；未连接热点来源，不认定热点榜/热议话题，也不预测触达。" : "决定标题关键词、首段承接方式和信息密度。"}</small></label>
            <label className="simple-setting-field simple-setting-field--wide"><span><strong>评论信息丰富度</strong><SettingSourceBadge source={resolvedSettings.commentRichness.source} /></span><select value={resolvedSettings.commentRichness.value} onChange={(event) => setSettingOverrides((current) => ({ ...current, commentRichness: event.target.value as CommentRichnessLevel }))}>{(Object.entries(COMMENT_RICHNESS_PROFILES) as Array<[CommentRichnessLevel, (typeof COMMENT_RICHNESS_PROFILES)[CommentRichnessLevel]]>).map(([level, profile]) => <option key={level} value={level}>{profile.label}{level === "balanced" ? "（默认）" : ""}</option>)}</select><small>{COMMENT_RICHNESS_PROFILES[resolvedSettings.commentRichness.value].description}</small></label>
          </div>

          {showLocalFields && <div className="simple-settings-grid simple-local-fields">
            <label className="simple-setting-field"><span><strong>城市</strong><SettingSourceBadge source={resolvedSettings.city.source} /></span><input list="simple-project-cities" value={resolvedSettings.city.value} placeholder="可填写本次要覆盖的城市" onChange={(event) => setSettingOverrides((current) => ({ ...current, city: event.target.value }))} /><datalist id="simple-project-cities">{currentProject?.cities?.map((city) => <option key={city} value={city} />)}</datalist></label>
            <label className="simple-setting-field"><span><strong>关键人物 / 对象</strong><SettingSourceBadge source={resolvedSettings.doctor.source} /></span><input list="simple-project-doctors" value={resolvedSettings.doctor.value} placeholder="可填写本次涉及的服务者、品牌或其他对象" onChange={(event) => setSettingOverrides((current) => ({ ...current, doctor: event.target.value }))} /><datalist id="simple-project-doctors">{currentProject?.doctors?.map((doctor) => <option key={doctor.name} value={doctor.name} />)}</datalist></label>
          </div>}

          <details className="simple-constraints">
            <summary><span><ShieldCheck size={17} /><span><strong>必须提及 / 禁止内容</strong><small>{resolvedSettings.mustInclude.value || resolvedSettings.forbidden.value ? "已有约束，展开可确认或修改" : "当前没有额外约束，可按需补充"}</small></span></span><ChevronDown size={17} /></summary>
            <div className="simple-constraints__body">
              <label className="simple-setting-field"><span><strong>必须提及</strong><SettingSourceBadge source={resolvedSettings.mustInclude.source} /></span><textarea rows={4} value={resolvedSettings.mustInclude.value} placeholder="每行一项，例如：说明适用条件" onChange={(event) => setSettingOverrides((current) => ({ ...current, mustInclude: event.target.value }))} /></label>
              <label className="simple-setting-field"><span><strong>禁止内容</strong><SettingSourceBadge source={resolvedSettings.forbidden.source} /></span><textarea rows={4} value={resolvedSettings.forbidden.value} placeholder="每行一项，例如：不得承诺确定效果" onChange={(event) => setSettingOverrides((current) => ({ ...current, forbidden: event.target.value }))} /></label>
            </div>
          </details>
        </div>

        <aside className="simple-current-info">
          <h3><Target size={17} /> 当前采用的信息</h3>
          <div className="simple-info-grid">
            <div><small>项目 / 知识状态</small><strong>{currentProject?.name || projectId}</strong><p>{intelligence ? intelligenceLabel[intelligence.status] : "尚未分析"}{currentProject?.knowledgeCount !== undefined ? ` · ${currentProject.knowledgeCount} 份知识` : ""}</p></div>
            <div><small>本次目标</small><strong>{selectedOpportunity?.whyValuable || "选择选题后自动带入"}</strong></div>
            <div><small>信息缺口</small><strong>{selectedOpportunity ? `${selectedOpportunity.gapIds.length} 项` : "待选择"}</strong><p>{opportunityGaps.slice(0, 2).map((gap) => gap.label).join("；") || "由选题卡决定"}</p></div>
            <div><small>证据情况</small><strong>{selectedOpportunity ? `${selectedOpportunity.evidenceIds.length} 条 · ${selectedOpportunity.answerability === "approved" ? "有批准答案" : selectedOpportunity.answerability === "verifiable" ? "提供核验方法" : "保留未知"}` : "待选择"}</strong></div>
            <div><small>事实边界</small><strong>{selectedOpportunity?.boundaries.length ? `${selectedOpportunity.boundaries.length} 项` : "按项目知识边界"}</strong><p>{selectedOpportunity?.boundaries.slice(0, 2).join("；") || "不把未知信息写成确定事实"}</p></div>
            <div><small>表达策略</small><strong>{lockedStrategy ? `已锁定：${lockedStrategy.name}` : compatibleStrategies.length ? compatibleStrategies.slice(0, 2).map((strategy) => strategy.name).join(" / ") : "按选题自动匹配"}</strong></div>
            <div><small>选题依赖确认</small><strong>{!selectedOpportunity ? "待选择" : missingDependencyCount ? `${missingDependencyCount} 项引用缺失` : pendingDependencyCount ? `${pendingDependencyCount} 项待独立确认` : "依赖均已确认"}</strong><p>{missingDependencyCount ? "请换一批或在资源池修复引用" : pendingDependencyCount ? "生成前会先调用各资源的独立审批，再确认选题" : "不会由选题审批隐式级联确认"}</p></div>
            <div><small>公式版本</small><strong>{currentProject?.activeFormulaVersion || "项目当前版本"}</strong></div>
          </div>
        </aside>
      </div>
    </section>

    <section className="image-library panel">
      <header><div><span>第 4 步</span><h2>选择源素材，让多模态模型观察并参与规划</h2><p>正式生成时会再次发送原图；这里管理的是源素材与可见观察，只供图片计划和 imageBrief 参考。</p></div><Button loading={uploading} disabled={!selectedOpportunity} icon={<ImagePlus size={16} />} onClick={() => fileInput.current?.click()}>上传源素材</Button><input ref={fileInput} hidden multiple type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadImages} /></header>
      <div className="image-library-boundary"><Images size={17} /><div><strong>这里的状态上限：源素材观察 / 计划参考</strong><p>批准观察只表示“原图中可见什么”已确认；选中只表示“图片计划可以参考它”。这里不会生成最终图片，也不会产生真实入口截图或实际部署记录。</p></div><Badge tone="warning">不是最终图片资产</Badge></div>
      {assets.length ? <div className="asset-grid">{assets.map((asset) => { const selected = selectedAssetIds.includes(asset.id); return <article className={`asset-card ${selected ? "selected" : ""}`} key={asset.id}><button type="button" className="asset-card__image" onClick={() => setSelectedAssetIds((current) => selected ? current.filter((id) => id !== asset.id) : current.length < 9 ? [...current, asset.id] : current)}><img src={asset.previewUrl || api.imageAssets.contentUrl(projectId, asset.id)} alt={asset.filename} /><span>{selected && <Check size={16} />}</span></button><div><strong>{asset.filename}</strong><small>{asset.analysis?.imageType || "等待源素材分析"} · {asset.approved ? "源素材观察已确认" : asset.status === "ready" ? "AI 源素材观察待确认" : asset.status}</small>{asset.analysis && <p title={asset.analysis.visibleFacts.join("；")}>{asset.analysis.scene || asset.analysis.visibleFacts.slice(0, 2).join("；") || "模型未提取到可见事实"}</p>}<div>{selected && <Badge tone="blue">计划参考源素材</Badge>}{asset.approved ? <Badge tone="positive">批准的源素材可见观察</Badge> : asset.status === "ready" ? <button type="button" onClick={() => void approveAsset(asset)}>确认上述源素材观察</button> : null}{asset.analysis && asset.latestAnalysisId ? <button type="button" onClick={() => openQualityEditor(asset)}><Pencil size={13} /> 编辑质量评估</button> : null}</div></div></article>; })}</div> : <EmptyState icon={<Images size={24} />} title="源素材图库还是空的" description="可不选源素材，只生成结构化图片计划和文字简报；上传原图也不会在这里生成最终图片资产。" />}
      <footer className="intelligence-run"><div><strong>{selectedOpportunity ? `已选择：${selectedOpportunity.title}` : "请先选择一张选题卡"}</strong><p>{selectedAssetIds.length} 张源素材已选 · 只作为三套图片计划与 imageBrief 的参考输入</p>{!blueprintReady ? <small>七项项目创作模型尚未全部确认，正式生成已锁定。</small> : selectedOpportunity && missingDependencyCount > 0 ? <small>引用资源缺失：请换一批，或在资源池修复引用。</small> : selectedOpportunity && pendingDependencyCount > 0 ? <small>将先独立确认 {opportunityDependencies.unapprovedGaps.length} 个信息缺口和 {opportunityDependencies.unapprovedStrategies.length} 个表达策略，再确认选题；不会隐式级联。</small> : selectedOpportunity?.status !== "approved" && selectedOpportunity ? <small>继续后会明确确认这张选题卡；AI 草案不会在未确认时进入生成。</small> : selectedOpportunity ? <small>选题及其引用依赖均已独立确认。</small> : null}</div><Button disabled={!selectedOpportunity || intelligence?.status !== "ready" || !blueprintReady} loading={submitting || preparing} icon={<Sparkles size={17} />} onClick={() => void preview()}>{selectedOpportunity && pendingDependencyCount > 0 ? `先确认 ${pendingDependencyCount} 项依赖并预览` : selectedOpportunity?.status === "approved" ? "预览并生成 3 套内容方案" : "确认选题并预览"}</Button></footer>
    </section>

    <Modal open={poolOpen} onClose={() => setPoolOpen(false)} title="内容智能资源池" description="信息缺口决定写什么，完整表达策略决定标签、图文与评论怎样协同。" size="wide">
      <div className="pool-manager"><div className="pool-tabs"><button className={poolTab === "gaps" ? "active" : ""} onClick={() => setPoolTab("gaps")}>信息缺口池 <b>{gaps.length}</b></button><button className={poolTab === "strategies" ? "active" : ""} onClick={() => setPoolTab("strategies")}>完整表达策略池 <b>{strategies.length}</b></button></div><div className="pool-toolbar"><label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资源" /></label><Button icon={<Plus size={15} />} onClick={() => poolTab === "gaps" ? setEditingGap({}) : setEditingStrategy({})}>新增</Button></div>
        {poolTab === "gaps" ? <div className="pool-list">{filteredGaps.map((gap) => <article key={gap.id} className={!gap.enabled ? "disabled" : ""}><div><Badge>{gap.category}</Badge><Badge tone={gap.status === "approved" ? "positive" : "warning"}>{gap.status === "approved" ? "已确认" : "待确认"}</Badge></div><h3>{gap.label}</h3><p>{gap.question}</p><small>{gap.sourceType} · 优先级 {gap.priority}</small><footer>{gap.status !== "approved" && <button onClick={() => void api.informationGaps.approve(projectId, gap.id).then((saved) => setGaps((current) => current.map((item) => item.id === saved.id ? saved : item)))}>确认使用</button>}<button onClick={() => void api.informationGaps.update(projectId, gap.id, { ...gap, enabled: !gap.enabled }).then((saved) => setGaps((current) => current.map((item) => item.id === saved.id ? saved : item)))}>{gap.enabled ? "已启用" : "已停用"}</button><button onClick={() => void api.informationGaps.update(projectId, gap.id, { ...gap, locked: !gap.locked }).then((saved) => setGaps((current) => current.map((item) => item.id === saved.id ? saved : item)))}>{gap.locked ? <Lock size={13} /> : <Unlock size={13} />}</button><button onClick={() => setEditingGap(gap)}><Pencil size={13} /></button><button onClick={() => void api.informationGaps.remove(projectId, gap.id).then(() => setGaps((current) => current.filter((item) => item.id !== gap.id)))}><Trash2 size={13} /></button></footer></article>)}</div> : <div className="pool-list">{filteredStrategies.map((strategy) => <article key={strategy.id} className={!strategy.enabled ? "disabled" : ""}><div><Badge>{strategy.source}</Badge><Badge tone={strategy.status === "approved" ? "positive" : "warning"}>{strategy.status === "approved" ? "已确认" : "待确认"}</Badge></div><h3>{strategy.name}</h3><p>{strategy.description}</p><small>{strategy.imagePolicy}</small><footer>{strategy.status !== "approved" && <button onClick={() => void api.expressionStrategies.approve(projectId, strategy.id).then((saved) => setStrategies((current) => current.map((item) => item.id === saved.id ? saved : item)))}>确认使用</button>}<button onClick={() => void api.expressionStrategies.update(projectId, strategy.id, { ...strategy, enabled: !strategy.enabled }).then((saved) => setStrategies((current) => current.map((item) => item.id === saved.id ? saved : item)))}>{strategy.enabled ? "已启用" : "已停用"}</button><button onClick={() => void api.expressionStrategies.update(projectId, strategy.id, { ...strategy, locked: !strategy.locked }).then((saved) => setStrategies((current) => current.map((item) => item.id === saved.id ? saved : item)))}>{strategy.locked ? <Lock size={13} /> : <Unlock size={13} />}</button><button onClick={() => setEditingStrategy(strategy)}><Pencil size={13} /></button>{strategy.source !== "builtin" && <button onClick={() => void api.expressionStrategies.remove(projectId, strategy.id).then(() => setStrategies((current) => current.filter((item) => item.id !== strategy.id)))}><Trash2 size={13} /></button>}</footer></article>)}</div>}
      </div>
    </Modal>

    <Modal open={Boolean(editingBlueprintModule)} onClose={() => { setEditingBlueprintModule(null); setEditingBlueprintJson(""); }} title={editingBlueprintModule ? `编辑${blueprintModuleMeta[editingBlueprintModule.moduleKey].label}` : "编辑项目创作模型"} description={editingBlueprintModule ? `${blueprintModuleMeta[editingBlueprintModule.moduleKey].description} 保存后该模块回到待确认状态，并使依赖它的下游资源失效。` : undefined} size="wide" footer={<Button onClick={() => void saveBlueprintModule()}>保存模块</Button>}>
      <div className="form-stack">
        <div className="blueprint-editor-boundary"><Info size={15} /><span>这里只填写项目数据，不写提示词。事实项必须保留来源状态和 evidenceIds；角色与场景通常标为 hypothesis。</span></div>
        <Field label="结构化模块内容" hint="当前版本采用可审计 JSON；字段含义由上方中文说明和现有内容共同展示。"><textarea className="blueprint-json-editor" rows={22} value={editingBlueprintJson} onChange={(event) => setEditingBlueprintJson(event.target.value)} spellCheck={false} /></Field>
      </div>
    </Modal>

    <Modal open={Boolean(editingGap)} onClose={() => setEditingGap(null)} title={editingGap?.id ? "编辑信息缺口" : "新增信息缺口"} footer={<Button onClick={() => void saveGap()}>保存</Button>}><div className="form-stack"><Field label="缺口名称" required><input value={editingGap?.label || ""} onChange={(event) => setEditingGap((current) => ({ ...current, label: event.target.value }))} /></Field><Field label="自然问题" required><textarea rows={3} value={editingGap?.question || ""} onChange={(event) => setEditingGap((current) => ({ ...current, question: event.target.value }))} /></Field><Field label="已有批准答案"><textarea rows={3} value={editingGap?.answer || ""} onChange={(event) => setEditingGap((current) => ({ ...current, answer: event.target.value, answerability: event.target.value ? "approved" : "verifiable" }))} /></Field>
      <div className="metric-editor"><p className="metric-editor__hint">以下三项是供人工审核的相对优先级估计（0–100），不是事实断言或平台效果预测。审核批准前必须给出数值。</p>
        {GAP_METRIC_FIELDS.map(({ key, label, hint }) => { const current = editingGap?.[key]; const percent = typeof current === "number" ? Math.round(current * 100) : 50; return <Field key={key} label={`${label}（${percent}）`} hint={hint}><input type="range" min={0} max={100} step={1} value={percent} onChange={(event) => { const next = Number(event.target.value) / 100; setEditingGap((currentGap) => ({ ...currentGap, [key]: next })); }} /></Field>; })}
      </div></div></Modal>
    <Modal open={Boolean(editingOpportunity)} onClose={() => setEditingOpportunity(null)} title="编辑选题度量" description="七项度量是未标定的评审排序启发（0–100），非因果、非平台效果预测。全部给值并将状态设为 eligible 后才能确认；保存后选题回到草稿需重新确认。" footer={<Button onClick={() => void saveOpportunity()}>保存选题</Button>}>
      <div className="form-stack"><Field label="选题标题"><input value={editingOpportunity?.title || ""} onChange={(event) => setEditingOpportunity((current) => ({ ...current, title: event.target.value }))} /></Field>
        <div className="metric-editor">{OPPORTUNITY_METRIC_FIELDS.map(({ key, label, hint }) => { const current = editingOpportunity?.[key]; const percent = typeof current === "number" ? Math.round(current * 100) : 50; return <Field key={key} label={`${label}（${percent}）`} hint={hint}><input type="range" min={0} max={100} step={1} value={percent} onChange={(event) => { const next = Number(event.target.value) / 100; setEditingOpportunity((currentOpp) => ({ ...currentOpp, [key]: next })); }} /></Field>; })}</div>
        <Field label="阶段"><select value={editingOpportunity?.audienceStage || "collecting"} onChange={(event) => setEditingOpportunity((current) => ({ ...current, audienceStage: event.target.value }))}>{AUDIENCE_STAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <Field label="入口"><select value={editingOpportunity?.entry || "search"} onChange={(event) => setEditingOpportunity((current) => ({ ...current, entry: event.target.value }))}>{ENTRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <Field label="资格状态" hint="度量齐全后设为 eligible 才可确认；blocked 表示不安全或禁止的选题。"><select value={editingOpportunity?.eligibilityStatus || "unknown"} onChange={(event) => setEditingOpportunity((current) => ({ ...current, eligibilityStatus: event.target.value }))}><option value="eligible">eligible（可用）</option><option value="blocked">blocked（不安全/禁止）</option><option value="unknown">unknown（待补）</option></select></Field>
      </div></Modal>
    <Modal open={Boolean(editingQuality)} onClose={() => setEditingQuality(null)} title="补全源素材质量评估" description="模型未给出完整质量评估。以下为评审启发值（0–100，非事实断言），补全后即可确认；保存后该分析回到草稿需重新确认。" footer={<Button onClick={() => void saveQuality()}>保存并可确认</Button>}>
      <div className="form-stack"><div className="metric-editor">{([["clarity", "清晰度"], ["relevance", "相关度"], ["textLegibility", "文字可辨识度"]] as const).map(([key, label]) => { const percent = Math.round(qualityDraft[key] * 100); return <Field key={key} label={`${label}（${percent}）`}><input type="range" min={0} max={100} step={1} value={percent} onChange={(event) => { const next = Number(event.target.value) / 100; setQualityDraft((current) => ({ ...current, [key]: next })); }} /></Field>; })}</div></div></Modal>
    <Modal open={Boolean(editingStrategy)} onClose={() => setEditingStrategy(null)} title={editingStrategy?.id ? "编辑完整表达策略" : "新增完整表达策略"} description="用日常语言说明标签、图片、正文和评论如何协同，系统保存为可复用策略。" footer={<Button onClick={() => void saveStrategy()}>保存</Button>}>
      <div className="form-stack">
        <Field label="策略名称" required><input value={editingStrategy?.name || ""} onChange={(event) => setEditingStrategy((current) => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="完整编排说明" required><textarea rows={5} value={editingStrategy?.description || ""} onChange={(event) => setEditingStrategy((current) => ({ ...current, description: event.target.value }))} /></Field>
        <Field label="图片结构角色" hint="这是模型实际执行的图片职责；下面的自然语言用于补充细节。">
          <select value={editingStrategy?.imageRole || "other"} onChange={(event) => setEditingStrategy((current) => ({ ...current, imageRole: event.target.value as ExpressionStrategy["imageRole"] }))}>
            <option value="cover">封面入口：先让读者识别主题</option>
            <option value="evidence">可见证据：展示可核验观察</option>
            <option value="scene">真实场景：交代人物与使用情境</option>
            <option value="diagram">解释图示：承担流程、清单或原理</option>
            <option value="before_after">前后对照：仅用于有边界的真实比较</option>
            <option value="other">其他：由编排说明决定</option>
          </select>
        </Field>
        <Field label="图片职责说明"><textarea rows={2} value={editingStrategy?.imagePolicy || ""} onChange={(event) => setEditingStrategy((current) => ({ ...current, imagePolicy: event.target.value }))} /></Field>
        <Field label="评论线程职责"><textarea rows={2} value={editingStrategy?.commentPolicy || ""} onChange={(event) => setEditingStrategy((current) => ({ ...current, commentPolicy: event.target.value }))} /></Field>
      </div>
    </Modal>
  </div>;
}
