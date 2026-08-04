import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  BookmarkPlus,
  BrainCircuit,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  Eye,
  FileText,
  FlaskConical,
  Info,
  Layers3,
  ListPlus,
  MessageCircleMore,
  RotateCcw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tags,
  Target,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useProjects } from "../components/ProjectContext";
import {
  Badge,
  Button,
  Field,
  Modal,
  Skeleton,
  useToast,
} from "../components/Ui";
import { V2Hero } from "../components/V2";
import { api, ApiError } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  CANONICAL_DIAGNOSTIC_FINGERPRINTS,
  hasCanonicalDiagnosticContract,
  isDiagnosticEmphasisParameterId,
  isDiagnosticProxyFormulaId,
} from "../lib/diagnostic-proxy";
import { resolveFormulaRuntimeView } from "../lib/formula-ui";
import {
  defaultParameterSchema,
  findFormulaDetails,
  normalizeParameterSchema,
} from "../lib/parameter-schema";
import {
  mergePresetShelf,
  preparePresetApplication,
} from "../lib/presets";
import { f30ParameterLinkWarning, TREND_FIT_SETTINGS_BOUNDARY_COPY } from "../lib/trend-fit";
import type {
  AdvancedGenerationConfig,
  ConfigConflict,
  ContentPreset,
  GenerateInput,
  GenerationParameterDefinition,
  GenerationParameterSchema,
  ParameterImpact,
  ResolvedConfigPreview,
} from "../types";
import { IntelligentSimpleFlow } from "./IntelligentSimpleFlow";
import {
  applyPublishingTopology,
  DEFAULT_PUBLISHING_TOPOLOGY_DRAFT,
  type PublishingTopologyDraft,
} from "../lib/publishing-topology";

interface GenerationFormState {
  topic: string;
  goal: string;
  audienceStage: string;
  entryPoint: string;
  city: string;
  doctor: string;
  mustInclude: string;
  forbidden: string;
}

const stages = [
  { id: "discovering", title: "刚开始了解", text: "还不清楚问题与选择范围", icon: CircleHelp },
  { id: "collecting", title: "正在收集信息", text: "在补全方案、成本和恢复等信息", icon: BookOpenText },
  { id: "comparing", title: "正在比较选择", text: "需要看清差异、条件与判断依据", icon: Layers3 },
  { id: "hesitating", title: "已了解但犹豫", text: "需要降低不确定性并说服自己", icon: BrainCircuit },
  { id: "ready", title: "准备采取下一步", text: "开始筛选地点、对象或具体方案", icon: Eye },
];

const entryPoints = [
  { id: "search", title: "主动搜索", text: "用户带着清晰关键词进入" },
  { id: "recommendation", title: "推荐流情景", text: "只描述一种可能入口；来源类型未知，不等于热点榜、热议话题或触达保证" },
  { id: "profile", title: "主页与回访", text: "用户看过相关内容后继续了解" },
];

const defaultAdvanced: AdvancedGenerationConfig = {
  knowledgeScope: "all",
  informationBreadth: 76,
  informationDepth: 64,
  expressionFreedom: 58,
  vigilanceLevel: 44,
  bodyLength: 220,
  commentThreads: 4,
  tone: "真实分享",
  titleStyle: "疑问与缺口",
  model: "项目默认",
  temperature: 0.75,
  repairRounds: 2,
  evidenceMode: "balanced",
};

const defaultForm: GenerationFormState = {
  topic: "",
  goal: "",
  audienceStage: "collecting",
  entryPoint: "search",
  city: "",
  doctor: "",
  mustInclude: "",
  forbidden: "",
};

export function GeneratorPage() {
  const { projects, projectId, setProjectId, currentProject } = useProjects();
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [form, setForm] = useState<GenerationFormState>(defaultForm);
  const [publishingTopology, setPublishingTopology] = useState<PublishingTopologyDraft>({ ...DEFAULT_PUBLISHING_TOPOLOGY_DRAFT });
  const [advanced, setAdvanced] = useState<AdvancedGenerationConfig>(defaultAdvanced);
  const [parameterOverrides, setParameterOverrides] = useState<Record<string, unknown>>({});
  const [advancedOverrides, setAdvancedOverrides] = useState("{}");
  const [advancedView, setAdvancedView] = useState<"goal" | "formula">("goal");
  const [schema, setSchema] = useState<GenerationParameterSchema>(defaultParameterSchema);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaWarning, setSchemaWarning] = useState<string | null>(null);
  const [projectPresets, setProjectPresets] = useState<ContentPreset[]>([]);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [resourceReload, setResourceReload] = useState(0);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetDraft, setPresetDraft] = useState({ name: "", description: "" });
  const [savingPreset, setSavingPreset] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<ResolvedConfigPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<GenerateInput | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const presets = useMemo(() => mergePresetShelf(projectPresets), [projectPresets]);

  useEffect(() => {
    if (!projectId) {
      setSchema(defaultParameterSchema);
      setSchemaWarning(null);
      setProjectPresets([]);
      setPresetError(null);
      setSchemaLoading(false);
      setPresetLoading(false);
      return;
    }
    let alive = true;
    setSchemaLoading(true);
    setPresetLoading(true);
    setSchemaWarning(null);
    setPresetError(null);
    Promise.all([
      api.parameters.schema(projectId),
      api.formulas.list(projectId),
    ])
      .then(([rawSchema, formulaResult]) => {
        if (!alive) return;
        const active = formulaResult.items.find((item) => item.status === "active") || formulaResult.items[0];
        setSchema(normalizeParameterSchema(rawSchema, active));
      })
      .catch((error) => {
        if (!alive) return;
        setSchema(defaultParameterSchema);
        setSchemaWarning(errorMessage(error, "生成参数 Schema 加载失败"));
      })
      .finally(() => alive && setSchemaLoading(false));
    api.presets
      .list(projectId)
      .then((result) => alive && setProjectPresets(result.items))
      .catch((error) => {
        if (!alive) return;
        setProjectPresets([]);
        setPresetError(errorMessage(error, "项目预设加载失败"));
      })
      .finally(() => alive && setPresetLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, resourceReload]);

  const selectedPreset = presets.find((item) => item.id === selectedPresetId);
  const effectiveBodyLength = Number(parameterOverrides.body_max_chars ?? advanced.bodyLength);
  const effectiveCommentThreads = Number(parameterOverrides.comment_thread_max ?? advanced.commentThreads);
  const effectiveStrictEvidence = Number(parameterOverrides.evidence_strictness ?? (advanced.evidenceMode === "strict" ? 100 : 70)) >= 85;

  const applyPreset = (preset: ContentPreset) => {
    const values = preset.values || {};
    const application = preparePresetApplication(preset);
    const legacyConfig = application.legacyConfig;
    // A preset is a complete starting point. Do not leak overrides from the
    // previously selected card into the next card's effective configuration.
    setParameterOverrides(application.parameterValues);
    setAdvanced({ ...defaultAdvanced, ...legacyConfig, ...application.advancedPatch });
    setForm((current) => ({
      ...current,
      goal: typeof values.goal === "string" ? values.goal : current.goal,
      audienceStage: application.audienceStage ?? current.audienceStage,
      entryPoint: application.entryPoint ?? current.entryPoint,
      mustInclude: Array.isArray(values.mustInclude) ? values.mustInclude.map(String).join("\n") : current.mustInclude,
      forbidden: Array.isArray(values.forbidden) ? values.forbidden.map(String).join("\n") : current.forbidden,
    }));
    if (legacyConfig) {
      applyParameterMap(legacyConfigToParameters(legacyConfig));
    }
    applyParameterMap(application.directValues);
    setSelectedPresetId(preset.id);
    toast.push(`已应用预设「${preset.name}」`);
  };

  const applyParameterMap = (values: Record<string, unknown>) => {
    for (const parameter of schema.parameters) {
      if (parameter.id in values) setParameterValue(parameter, values[parameter.id]);
      else if (parameter.path in values) setParameterValue(parameter, values[parameter.path]);
    }
  };

  const getParameterValue = (parameter: GenerationParameterDefinition): unknown => {
    if (Object.prototype.hasOwnProperty.call(parameterOverrides, parameter.id)) return parameterOverrides[parameter.id];
    if (parameter.path === "task.audienceStage") return form.audienceStage;
    if (parameter.path === "task.entry") return form.entryPoint;
    if (parameter.path === "task.mustMention") return lines(form.mustInclude);
    if (parameter.path === "task.forbidden") return lines(form.forbidden);
    if (parameter.path === "task.goal") return form.goal;
    if (parameter.path === "task.mustInclude") return lines(form.mustInclude);
    if (parameter.path === "config.strictEvidence") return advanced.evidenceMode === "strict";
    if (parameter.path === "config.commentsEnabled") return advanced.commentThreads > 0;
    if (parameter.path.startsWith("config.")) {
      const key = parameter.path.slice(7);
      return (advanced as unknown as Record<string, unknown>)[key] ?? parameter.defaultValue;
    }
    return parameter.defaultValue;
  };

  const setParameterValue = (parameter: GenerationParameterDefinition, value: unknown) => {
    setParameterOverrides((current) => ({ ...current, [parameter.id]: value }));
    if (parameter.path === "task.audienceStage") {
      setForm((current) => ({ ...current, audienceStage: String(value) }));
      return;
    }
    if (parameter.id === "evidence_strictness" && typeof value === "number") {
      setAdvanced((current) => ({ ...current, evidenceMode: value >= 85 ? "strict" : value >= 65 ? "balanced" : "creative" }));
      return;
    }
    if (parameter.id === "knowledge_mode" && typeof value === "string") {
      setAdvanced((current) => ({ ...current, knowledgeScope: value === "auto" || value === "full" ? "all" : "selected" }));
      return;
    }
    if (parameter.id === "expression_voice" && typeof value === "string") {
      setAdvanced((current) => ({ ...current, tone: value }));
      return;
    }
    if (parameter.path === "task.entry") {
      setForm((current) => ({ ...current, entryPoint: String(value) }));
      return;
    }
    if (parameter.path === "task.mustMention") {
      setForm((current) => ({ ...current, mustInclude: (Array.isArray(value) ? value.map(String) : lines(String(value ?? ""))).join("\n") }));
      return;
    }
    if (parameter.path === "task.forbidden") {
      setForm((current) => ({ ...current, forbidden: (Array.isArray(value) ? value.map(String) : lines(String(value ?? ""))).join("\n") }));
      return;
    }
    if (parameter.path === "task.goal") {
      setForm((current) => ({ ...current, goal: String(value ?? "") }));
      return;
    }
    if (parameter.path === "task.mustInclude") {
      const valueLines = Array.isArray(value) ? value.map(String) : lines(String(value ?? ""));
      setForm((current) => ({ ...current, mustInclude: valueLines.join("\n") }));
      return;
    }
    if (parameter.path === "config.strictEvidence") {
      setAdvanced((current) => ({ ...current, evidenceMode: value ? "strict" : "balanced" }));
      return;
    }
    if (parameter.path === "config.commentsEnabled") {
      setAdvanced((current) => ({ ...current, commentThreads: value ? Math.max(3, current.commentThreads) : 0 }));
      return;
    }
    if (parameter.path.startsWith("config.")) {
      const key = parameter.path.slice(7);
      setAdvanced((current) => ({ ...current, [key]: value }));
      return;
    }
    const compatibilityKey: Record<string, keyof AdvancedGenerationConfig> = {
      information_breadth: "informationBreadth",
      decision_information_depth: "informationDepth",
      model_temperature: "temperature",
      repair_attempts: "repairRounds",
      comment_thread_max: "commentThreads",
      body_max_chars: "bodyLength",
    };
    const target = compatibilityKey[parameter.id];
    if (target) setAdvanced((current) => ({ ...current, [target]: value }));
  };

  const parameterValues = () =>
    Object.fromEntries(schema.parameters.map((parameter) => [parameter.id, getParameterValue(parameter)]));

  const presetValues = (): ContentPreset["values"] => parameterValues();

  const savePreset = async () => {
    if (!projectId || !presetDraft.name.trim()) return;
    setSavingPreset(true);
    const input = {
      name: presetDraft.name.trim(),
      description: presetDraft.description.trim() || "项目自定义生成参数",
      values: presetValues(),
      isDefault: false,
    };
    try {
      const created = await api.presets.create(projectId, input);
      setProjectPresets((current) => [...current, created]);
      setSelectedPresetId(created.id);
      setSavePresetOpen(false);
      setPresetDraft({ name: "", description: "" });
      toast.push("当前参数已保存为项目预设");
    } catch (error) {
      toast.push(errorMessage(error, "预设保存失败"), "error");
    } finally {
      setSavingPreset(false);
    }
  };

  const copyPreset = async (preset: ContentPreset) => {
    if (!projectId) return;
    const input = window.prompt("复制预设的名称", `${preset.name} · 副本`);
    if (input === null) return;
    const copyName = input.trim() || `${preset.name} · 副本`;
    try {
      const copied = await api.presets.copy(projectId, preset.id, { name: copyName });
      setProjectPresets((current) => [...current, copied]);
      toast.push("已复制为项目预设");
    } catch (error) {
      toast.push(errorMessage(error, "预设复制失败"), "error");
    }
  };

  const setDefaultPreset = async (preset: ContentPreset) => {
    if (!projectId) return;
    try {
      await api.presets.setDefault(projectId, preset.id);
      setProjectPresets((current) => current.map((item) => ({ ...item, isDefault: item.id === preset.id })));
      toast.push(`「${preset.name}」已设为项目默认`);
    } catch (error) {
      toast.push(errorMessage(error, "无法设置默认预设"), "error");
    }
  };

  const updatePreset = async (preset: ContentPreset) => {
    if (!projectId || preset.source !== "project") return;
    try {
      const updated = await api.presets.update(projectId, preset.id, {
        values: presetValues(),
      });
      setProjectPresets((current) => current.map((item) => item.id === preset.id ? updated : item));
      toast.push(`「${preset.name}」已更新为当前参数`);
    } catch (error) {
      toast.push(errorMessage(error, "预设更新失败"), "error");
    }
  };

  const removePreset = async (preset: ContentPreset) => {
    if (!projectId || preset.source !== "project") return;
    try {
      await api.presets.remove(projectId, preset.id);
      setProjectPresets((current) => current.filter((item) => item.id !== preset.id));
      if (selectedPresetId === preset.id) setSelectedPresetId("");
      toast.push("项目预设已删除");
    } catch (error) {
      toast.push(errorMessage(error, "无法删除预设"), "error");
    }
  };

  const parseOverrides = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(advancedOverrides) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      toast.push("完整配置覆盖必须是有效的 JSON 对象", "error");
      return null;
    }
  };

  const buildInput = (): GenerateInput | null => {
    if (!projectId || (mode === "advanced" && !form.topic.trim())) {
      toast.push("请先填写项目和内容主题", "error");
      return null;
    }
    const rawOverrides = mode === "advanced" ? parseOverrides() : {};
    if (rawOverrides === null) return null;
    return {
      projectId,
      mode,
      ...form,
      presetId: selectedPresetId || undefined,
      config: mode === "advanced" ? advanced : undefined,
      overrides: {
        ...rawOverrides,
        ...parameterOverrides,
      },
    };
  };

  const preparePreview = async (event?: FormEvent) => {
    event?.preventDefault();
    const input = buildInput();
    if (!input) return;
    await prepareInputPreview(input);
  };

  const prepareInputPreview = async (rawInput: GenerateInput) => {
    let input: GenerateInput;
    try {
      input = applyPublishingTopology(rawInput, publishingTopology);
    } catch (error) {
      toast.push(errorMessage(error, "发布账号信息不完整"), "error");
      return;
    }
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewInput(input);
    setPreview(null);
    setPreviewError(null);
    const local = localPreview(input, advanced, schema, currentProject?.knowledgeCount);
    try {
      const resolved = await api.config.resolve(projectId, input);
      setPreview(normalizePreview(resolved, local));
    } catch (error) {
      setPreviewError(errorMessage(error, "服务端配置解析失败"));
    } finally {
      setPreviewLoading(false);
    }
  };

  const runGeneration = async () => {
    if (!previewInput || !preview || previewError) return;
    setSubmitting(true);
    try {
      const job = await api.generations.create(previewInput);
      toast.push("生成任务已创建");
      navigate(`/generations/${job.id}`);
    } catch (error) {
      const message = error instanceof ApiError
        ? error.message
        : errorMessage(error, "生成任务创建失败");
      const releaseGuidance = /发布清单|ACTIVE_RELEASE|release/i.test(message)
        ? "。请到「研究与证据 → 发布版本」新建一个发布清单，批准并激活到生成运行时后重试"
        : "";
      toast.push(`生成失败：${message}${releaseGuidance}`, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const resetParameters = () => {
    setAdvanced(defaultAdvanced);
    setParameterOverrides({});
    setForm((current) => ({ ...current, goal: "", mustInclude: "" }));
    setPublishingTopology({ ...DEFAULT_PUBLISHING_TOPOLOGY_DRAFT });
    setSelectedPresetId("");
    toast.push("参数已恢复为系统默认", "info");
  };

  return (
    <div className="page generate-page">
      <V2Hero
        status={<>{currentProject?.name || "当前项目"} · {mode === "simple" ? "简单模式" : "设置模式"}</>}
        title="生成完整内容"
        description="标题、正文、标签和评论区共用同一个信息补全计划；每个参数都能解释它将影响什么。"
      />

      <div className="mode-switch" role="tablist">
        <button type="button" className={mode === "simple" ? "active" : ""} onClick={() => setMode("simple")}>
          <Sparkles size={18} />
          <span><strong>简单模式</strong><small>一键预设 + 4 步必要信息</small></span>
          {mode === "simple" && <Check size={16} />}
        </button>
        <button type="button" className={mode === "advanced" ? "active" : ""} onClick={() => setMode("advanced")}>
          <SlidersHorizontal size={18} />
          <span><strong>设置模式</strong><small>目标 / 公式双视图，共享参数</small></span>
          {mode === "advanced" && <Check size={16} />}
        </button>
      </div>

      <PresetShelf
        presets={presets}
        selectedId={selectedPresetId}
        loading={presetLoading}
        error={presetError}
        compact={mode === "simple"}
        onApply={applyPreset}
        onCopy={copyPreset}
        onUpdate={updatePreset}
        onDefault={setDefaultPreset}
        onDelete={removePreset}
        onSave={() => setSavePresetOpen(true)}
        onRetry={() => setResourceReload((value) => value + 1)}
      />

      {schemaWarning && <div className="inline-load-error" role="alert"><AlertTriangle size={17} /><span><strong>生成参数暂未从服务端加载</strong><small>{schemaWarning}。当前只显示界面默认值，配置预览仍须由服务端确认。</small></span><Button variant="ghost" onClick={() => setResourceReload((value) => value + 1)}>重试</Button></div>}

      <PublishingTopologyPanel value={publishingTopology} onChange={setPublishingTopology} />

      {mode === "simple" ? (
        <IntelligentSimpleFlow
          projects={projects}
          projectId={projectId}
          submitting={submitting || previewLoading}
          selectedPresetId={selectedPresetId || undefined}
          selectedPreset={selectedPreset || presets.find((preset) => preset.isDefault)}
          onProject={setProjectId}
          onPreview={(input) => void prepareInputPreview(input)}
        />
      ) : (
        <form className="advanced-workbench" onSubmit={preparePreview}>
          <div className="advanced-viewbar">
            <div>
              <span>参数编辑视图</span>
              <p>两个视图操作同一份参数；切换不会丢失任何修改。</p>
            </div>
            <div className="view-switch">
              <button type="button" className={advancedView === "goal" ? "active" : ""} onClick={() => setAdvancedView("goal")}><Target size={16} /><span><strong>目标视图</strong><small>按“想达到什么”组织</small></span></button>
              <button type="button" className={advancedView === "formula" ? "active" : ""} onClick={() => setAdvancedView("formula")}><FlaskConical size={16} /><span><strong>公式视图</strong><small>看公式、推理与风险</small></span></button>
            </div>
          </div>
          <section className="trendfit-settings-boundary"><Info size={17} /><div><strong>TrendFit 只有两条显式手工审计入口</strong><p>{TREND_FIT_SETTINGS_BOUNDARY_COPY}</p></div><Badge tone="warning">标签 ≠ 触达保证</Badge></section>

          <div className="advanced-layout">
            <div className="advanced-main">
              <TaskPanel projects={projects} projectId={projectId} form={form} onProject={setProjectId} onForm={setForm} />
              {schemaLoading ? <section className="settings-panel"><Skeleton lines={8} /></section> : advancedView === "goal" ? (
                <GoalParameterView schema={schema} getValue={getParameterValue} setValue={setParameterValue} />
              ) : (
                <FormulaParameterView schema={schema} getValue={getParameterValue} setValue={setParameterValue} />
              )}
              <section className="settings-panel json-overrides">
                <details>
                  <summary><span><Braces size={18} /><span><strong>完整配置 JSON 覆盖</strong><small>仅供高级用户；Schema 校验后安全深合并，不执行代码</small></span></span><ChevronDown size={17} /></summary>
                  <div className="settings-panel__body">
                    <Field label="ResolvedGenerationConfig 局部覆盖" hint="未知值请显式使用 null；此处优先级高于可视化参数。若显式启用 F30，须提供 trendSourceKind、trendSourceRef、sourceObservedAt、relevance、bridgeClarity、timeliness；结果只写入 impactReport 审计快照，不改变写作、规划、选稿、校验或触达预测。">
                      <textarea className="code-editor" rows={10} value={advancedOverrides} onChange={(event) => setAdvancedOverrides(event.target.value)} spellCheck={false} placeholder={'{\n  "informationWindow": { "gaps": ["价格构成"] },\n  "formula": { "variables": { "reader.suspicion": null } }\n}'} />
                    </Field>
                  </div>
                </details>
              </section>
            </div>

            <aside className="advanced-sidebar">
              <section className="settings-panel settings-panel--sticky run-panel">
                <header><div><Settings2 size={19} /><span><h2>本次运行</h2><p>参数、预设和版本将一起保存</p></span></div></header>
                <div className="settings-panel__body form-stack">
                  <div className="run-context">
                    <span><small>当前预设</small><strong>{selectedPreset?.name || "项目默认"}</strong></span>
                    <span><small>参数 Schema</small><strong>v{schema.schemaVersion}</strong></span>
                    <span><small>知识使用</small><strong>{knowledgeLabel(advanced.knowledgeScope)}</strong></span>
                  </div>
                  <div className="run-summary">
                    <span><FileText size={15} />正文上限约 {effectiveBodyLength} 字</span>
                    <span><MessageCircleMore size={15} />最多 {effectiveCommentThreads || 0} 组问答</span>
                    <span><Tags size={15} />按主题分配标签（不承诺触达）</span>
                    <span><ShieldCheck size={15} />{effectiveStrictEvidence ? "严格事实模式" : "允许标注推理"}</span>
                  </div>
                  <Button type="submit" loading={previewLoading || submitting} icon={<Sparkles size={17} />}>预览配置并生成</Button>
                  <Button type="button" variant="ghost" icon={<RotateCcw size={15} />} onClick={resetParameters}>恢复默认参数</Button>
                  <p className="settings-hint">生成前会先检查参数冲突、知识边界和下游影响。</p>
                </div>
              </section>
            </aside>
          </div>
        </form>
      )}

      <Modal
        open={savePresetOpen}
        onClose={() => { if (!savingPreset) setSavePresetOpen(false); }}
        title="保存为项目预设"
        description="预设会保存当前可视化参数和任务倾向，不会保存本次主题、地点或关键对象。"
        footer={<><Button variant="ghost" disabled={savingPreset} onClick={() => setSavePresetOpen(false)}>取消</Button><Button loading={savingPreset} disabled={!presetDraft.name.trim()} onClick={savePreset} icon={<BookmarkPlus size={16} />}>保存预设</Button></>}
      >
        <div className="form-stack">
          <Field label="预设名称" required><input value={presetDraft.name} onChange={(event) => setPresetDraft({ ...presetDraft, name: event.target.value })} placeholder="例如：高证据审慎比较" /></Field>
          <Field label="适用说明"><textarea rows={3} value={presetDraft.description} onChange={(event) => setPresetDraft({ ...presetDraft, description: event.target.value })} placeholder="什么场景下使用，它会重点改变什么？" /></Field>
          <div className="preset-save-summary"><SlidersHorizontal size={18} /><span><strong>将保存 {schema.parameters.length} 个参数值</strong><small>以后可继续修改、设为默认或删除。</small></span></div>
        </div>
      </Modal>

      <ConfigPreviewModal
        open={previewOpen}
        loading={previewLoading}
        error={previewError}
        preview={preview}
        input={previewInput}
        presetName={selectedPreset?.name}
        projectName={currentProject?.name}
        formulaLabel={(typeof schema.formulaVersion === "string" ? schema.formulaVersion : schema.formulaVersion?.version) || "项目当前版本"}
        schema={schema}
        submitting={submitting}
        onClose={() => !submitting && setPreviewOpen(false)}
        onConfirm={runGeneration}
        onRetry={() => { if (previewInput) void prepareInputPreview(previewInput); }}
      />
    </div>
  );
}

function PresetShelf({ presets, selectedId, loading, error, compact, onApply, onCopy, onUpdate, onDefault, onDelete, onSave, onRetry }: {
  presets: ContentPreset[];
  selectedId: string;
  loading: boolean;
  error: string | null;
  compact: boolean;
  onApply: (preset: ContentPreset) => void;
  onCopy: (preset: ContentPreset) => void;
  onUpdate: (preset: ContentPreset) => void;
  onDefault: (preset: ContentPreset) => void;
  onDelete: (preset: ContentPreset) => void;
  onSave: () => void;
  onRetry: () => void;
}) {
  return <section className={`preset-shelf ${compact ? "preset-shelf--compact" : ""}`}>
    <header><div><span>{compact ? "一键开始" : "生成预设"}</span><h2>{compact ? "先选一个最接近的写作任务" : "复用一整组经过说明的参数"}</h2><p>{compact ? "预设会自动填写读者阶段、入口和隐藏变量，你仍可逐步检查。" : "内置预设可复制，项目预设可设为默认或删除。"}</p></div><Button variant="ghost" icon={<BookmarkPlus size={15} />} onClick={onSave}>保存当前</Button></header>
    {error && <div className="inline-load-error" role="alert"><AlertTriangle size={17} /><span><strong>项目预设加载失败</strong><small>{error}。当前只显示内置界面模板，项目预设和默认状态可能不完整。</small></span><Button variant="ghost" onClick={onRetry}>重试</Button></div>}
    {loading ? <Skeleton lines={2} /> : <div className="preset-row">
      {presets.map((preset) => <article key={preset.id} className={`preset-card ${selectedId === preset.id ? "selected" : ""}`}>
        <button className="preset-card__apply" type="button" onClick={() => onApply(preset)}>
          <span className="preset-card__icon">{preset.source === "built-in" ? <Sparkles size={17} /> : <BookmarkPlus size={17} />}</span>
          <span><strong>{preset.name}{preset.isDefault && <Star size={12} fill="currentColor" />}</strong><small>{preset.description}</small><i>{preset.source === "built-in" ? "内置方法" : "项目自定义"}</i></span>
          {selectedId === preset.id && <b><Check size={13} /></b>}
        </button>
        <div className="preset-card__actions">
          {preset.source === "built-in" ? <button type="button" title="复制为项目预设" onClick={() => onCopy(preset)}><Copy size={13} />复制</button> : <><button type="button" title="用当前参数更新" onClick={() => onUpdate(preset)}><RotateCcw size={13} />更新</button><button type="button" title="设为项目默认" onClick={() => onDefault(preset)}><Star size={13} />默认</button><button type="button" title="删除项目预设" aria-label="删除项目预设" onClick={() => onDelete(preset)}><Trash2 size={13} /></button></>}
        </div>
      </article>)}
    </div>}
  </section>;
}

const authorFactCategoryOptions: Array<{ value: PublishingTopologyDraft["factCategory"]; label: string }> = [
  { value: "current_state", label: "当前状态" },
  { value: "intent", label: "本人打算" },
  { value: "constraint", label: "现实限制" },
  { value: "project_contact", label: "已发生项目接触" },
  { value: "purchase", label: "已购买" },
  { value: "service_completion", label: "已完成服务" },
  { value: "recovery", label: "恢复经历" },
  { value: "outcome", label: "结果经历" },
];

function PublishingTopologyPanel({ value, onChange }: {
  value: PublishingTopologyDraft;
  onChange: (value: PublishingTopologyDraft) => void;
}) {
  const individual = value.topology === "confirmed_individual_author";
  return <section className="settings-panel publishing-topology-panel">
    <header><div><ShieldCheck size={19} /><span><h2>发布账号与作者事实</h2><p>本次任务先冻结谁在发帖；项目资料不能自动变成个人经历</p></span></div><Badge tone={individual ? "warning" : "positive"}>{individual ? "个人作者" : "机构账号"}</Badge></header>
    <div className="settings-panel__body form-stack">
      <Field label="发布账号类型" required hint="默认使用机构自有账号。只有确有真实个人作者且事实已人工确认时，才选择个人作者。">
        <select value={value.topology} onChange={(event) => onChange({ ...value, topology: event.target.value as PublishingTopologyDraft["topology"] })}>
          <option value="institution_owned">机构自有账号（默认）</option>
          <option value="confirmed_individual_author">已确认的真实个人作者</option>
        </select>
      </Field>
      {individual && <>
        <Field label="已确认作者事实" required hint="只填一条本次可公开使用的真实事实；不要从项目知识库复制或推断个人经历。">
          <textarea rows={3} value={value.factStatement} onChange={(event) => onChange({ ...value, factStatement: event.target.value })} placeholder="例如：我目前还没决定，只是在比较方案" />
        </Field>
        <div className="field-grid field-grid--three">
          <Field label="事实类别" required><select value={value.factCategory} onChange={(event) => onChange({ ...value, factCategory: event.target.value as PublishingTopologyDraft["factCategory"] })}>{authorFactCategoryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
          <Field label="确认人" required><input value={value.confirmedBy} onChange={(event) => onChange({ ...value, confirmedBy: event.target.value })} placeholder="负责人姓名或工号" /></Field>
          <Field label="确认时间" required><input type="datetime-local" value={value.confirmedAt} onChange={(event) => onChange({ ...value, confirmedAt: event.target.value })} /></Field>
        </div>
        <div className="trendfit-settings-boundary"><Info size={17} /><div><strong>个人作者只回答本人事实</strong><p>楼主回复不会承接价格、地址、预约、效果、恢复结论、适用性或其他项目事实；这些问题仍由机构可追责身份回答。</p></div></div>
      </>}
    </div>
  </section>;
}

function TaskPanel({ projects, projectId, form, onProject, onForm }: {
  projects: ReturnType<typeof useProjects>["projects"];
  projectId: string;
  form: GenerationFormState;
  onProject: (id: string) => void;
  onForm: (form: GenerationFormState) => void;
}) {
  return <section className="settings-panel"><header><div><FileText size={19} /><span><h2>任务、读者与入口</h2><p>定义本次内容要为谁解决什么问题</p></span></div><Badge tone="positive">必填</Badge></header><div className="settings-panel__body form-stack">
    <div className="field-grid field-grid--two"><Field label="项目"><select value={projectId} onChange={(event) => onProject(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="内容入口"><select value={form.entryPoint} onChange={(event) => onForm({ ...form, entryPoint: event.target.value })}>{entryPoints.map((entry) => <option value={entry.id} key={entry.id}>{entry.title}</option>)}</select></Field></div>
    <Field label="内容主题" required><textarea rows={3} value={form.topic} onChange={(event) => onForm({ ...form, topic: event.target.value })} placeholder="写清具体问题与场景" /></Field>
    <div className="field-grid field-grid--two"><Field label="读者阶段"><select value={form.audienceStage} onChange={(event) => onForm({ ...form, audienceStage: event.target.value })}>{stages.map((stage) => <option value={stage.id} key={stage.id}>{stage.title}</option>)}</select></Field><Field label="地点 / 关键对象"><div className="inline-fields"><input value={form.city} onChange={(event) => onForm({ ...form, city: event.target.value })} placeholder="地点" /><input value={form.doctor} onChange={(event) => onForm({ ...form, doctor: event.target.value })} placeholder="人物或对象" /></div></Field></div>
  </div></section>;
}

function GoalParameterView({ schema, getValue, setValue }: ParameterViewProps) {
  return <div className="parameter-sections parameter-sections--goal">
    {schema.groups.map((group) => {
      const parameters = schema.parameters.filter((item) => item.group === group.id);
      if (!parameters.length) return null;
      return <section className="settings-panel parameter-group" key={group.id}><header><div>{groupIcon(group.id)}<span><h2>{group.label}</h2><p>{group.description}</p></span></div><Badge>{parameters.length} 项</Badge></header><div className="parameter-grid">{parameters.map((parameter) => <ParameterCard key={parameter.id} parameter={parameter} schema={schema} value={getValue(parameter)} onChange={(value) => setValue(parameter, value)} detailed={false} />)}</div></section>;
    })}
  </div>;
}

function FormulaParameterView({ schema, getValue, setValue }: ParameterViewProps) {
  return <div className="parameter-sections parameter-sections--formula">
    <section className="formula-view-intro"><div><FlaskConical size={22} /><span><strong>公式不是“平台定律”</strong><p>定义型公式用于组织生产；代理与猜想型公式是当前证据不足时的推理工具。每个参数都会显示来源和适用边界。</p></span></div><Badge tone="purple">Schema v{schema.schemaVersion}</Badge></section>
    {schema.groups.map((group) => {
      const parameters = schema.parameters.filter((item) => item.group === group.id);
      if (!parameters.length) return null;
      return <section className="settings-panel parameter-group" key={group.id}><header><div>{groupIcon(group.id)}<span><h2>{group.label}</h2><p>{group.description}</p></span></div><Badge tone="purple">公式解释</Badge></header><div className="parameter-grid parameter-grid--detailed">{parameters.map((parameter) => <ParameterCard key={parameter.id} parameter={parameter} schema={schema} value={getValue(parameter)} onChange={(value) => setValue(parameter, value)} detailed />)}</div></section>;
    })}
  </div>;
}

interface ParameterViewProps {
  schema: GenerationParameterSchema;
  getValue: (parameter: GenerationParameterDefinition) => unknown;
  setValue: (parameter: GenerationParameterDefinition, value: unknown) => void;
}

function ParameterCard({ parameter, schema, value, onChange, detailed }: {
  parameter: GenerationParameterDefinition;
  schema: GenerationParameterSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  detailed: boolean;
}) {
  const formulas = findFormulaDetails(parameter, schema);
  const trendFitWarning = f30ParameterLinkWarning(parameter.formulaIds);
  const isDiagnosticOrdering = parameter.group === "diagnostic"
    && /DiagnosticEmphasis/u.test(parameter.path)
    && parameter.formulaIds.some(isDiagnosticProxyFormulaId);
  const diagnosticFormula = isDiagnosticOrdering
    ? formulas.find((formula) => isDiagnosticProxyFormulaId(formula.id))
    : undefined;
  const diagnosticRuntime = diagnosticFormula
    ? resolveFormulaRuntimeView(diagnosticFormula, schema.formulaVersion)
    : undefined;
  const diagnosticContractCurrent = diagnosticFormula
    ? hasCanonicalDiagnosticContract(diagnosticFormula.id, diagnosticFormula.diagnosticContract)
      && isDiagnosticProxyFormulaId(diagnosticFormula.id)
      && diagnosticRuntime?.semanticFingerprint === CANONICAL_DIAGNOSTIC_FINGERPRINTS[diagnosticFormula.id]
    : false;
  const increaseEffect = isDiagnosticOrdering
    ? "只把该分项在页面和人工复核清单中排得更靠前；不会改变系统检查顺序、阈值、状态、结论或生成。"
    : parameter.increaseEffect || "增强该参数代表的内容倾向。";
  const decreaseEffect = isDiagnosticOrdering
    ? "只把该分项在人工清单中后移；本参数不调度系统检查，独立硬校验和安全门槛不变。"
    : parameter.decreaseEffect || "减弱该参数代表的内容倾向。";
  const isOutsideRange = typeof value === "number" && parameter.recommendedRange && (value < parameter.recommendedRange[0] || value > parameter.recommendedRange[1]);
  return <article className={`parameter-card ${detailed ? "parameter-card--detailed" : ""} ${isOutsideRange ? "parameter-card--warning" : ""}`}>
    <header><div><span className="parameter-code">{parameter.formulaIds[0] || "CFG"}</span><span><strong>{parameter.label}</strong><small>{parameter.description}</small></span></div><span className="parameter-header-badges">{isDiagnosticOrdering && <Badge tone="warning">显示/人工排序刻度</Badge>}{parameter.evidenceStatus && <Badge tone={/hypothesis|proxy|unknown|sample/u.test(parameter.evidenceStatus) ? "warning" : "neutral"}>{parameterEvidenceLabel(parameter.evidenceStatus)}</Badge>}{isOutsideRange && <Badge tone="warning">超出建议区间</Badge>}</span></header>
    <ParameterInput parameter={parameter} value={value} onChange={onChange} />
    <div className="parameter-novice"><Info size={14} /><p><strong>小白解释</strong>{parameter.noviceExplanation}</p></div>
    {isDiagnosticOrdering && <div className={`parameter-diagnostic-boundary ${diagnosticContractCurrent ? "is-current" : "is-unknown"}`}><Info size={14} /><span><strong>{diagnosticContractCurrent ? "只改变先看哪一项" : "诊断合同语义 unknown"}</strong><small>{diagnosticContractCurrent ? `这个刻度不是百分比、权重、分项得分或合格线；20 个分项当前都没有校准观测，实际值仍为 null/unknown。${diagnosticRuntime?.effectiveHandlersEnabled ? "本版本会按该顺序输出人工复核清单。" : "本版本处理器未启用，本次不会输出该清单。"}` : "当前公式缺少匹配的已复核 diagnosticContract 与语义指纹；页面不推断这个数值的用途，也不会把它包装成分数。"}</small></span></div>}
    {trendFitWarning && <div className="parameter-trendfit-warning"><AlertTriangle size={14} /><span><strong>F30 关联边界</strong><small>{trendFitWarning}</small></span></div>}
    {detailed ? <div className="parameter-explanation">
      {parameter.equation && <div className="parameter-equation"><span>公式</span><code>{parameter.equation}</code></div>}
      <div className="impact-pair"><div><ArrowUp size={14} /><span><strong>调高 / 开启</strong><small>{increaseEffect}</small></span></div><div><ArrowDown size={14} /><span><strong>调低 / 关闭</strong><small>{decreaseEffect}</small></span></div></div>
      {parameter.risk && <div className="parameter-risk"><AlertTriangle size={14} /><span><strong>边界与风险</strong><small>{parameter.risk}</small></span></div>}
      <div className="formula-links">{parameter.formulaIds.map((id) => <span key={id}>{id}{formulas.find((formula) => formula.id === id)?.type === "hypothesis" && <i>待验证</i>}</span>)}{parameter.channels?.map((channel) => <span className="channel" key={channel}>{channelLabelForParameter(channel)}</span>)}</div>
    </div> : <details className="parameter-more"><summary>查看公式、调高/调低影响与风险 <ChevronDown size={13} /></summary><div><code>{parameter.equation || "由项目公式版本提供"}</code><p><ArrowUp size={12} />{increaseEffect}</p><p><ArrowDown size={12} />{decreaseEffect}</p>{parameter.risk && <p className="risk"><AlertTriangle size={12} />{parameter.risk}</p>}</div></details>}
  </article>;
}

function ParameterInput({ parameter, value, onChange }: { parameter: GenerationParameterDefinition; value: unknown; onChange: (value: unknown) => void }) {
  if (parameter.control === "slider") {
    const min = parameter.min ?? 0;
    const max = parameter.max ?? 100;
    const numeric = typeof value === "number" ? value : Number(parameter.defaultValue) || min;
    const diagnosticOrdering = parameter.group === "diagnostic" && /DiagnosticEmphasis/u.test(parameter.path);
    const unit = diagnosticOrdering ? "" : parameter.unit;
    const progress = ((numeric - min) / Math.max(1, max - min)) * 100;
    return <div className="schema-slider"><div><span>{min}{unit}</span><strong>{numeric}{unit}</strong><span>{max}{unit}</span></div><input type="range" min={min} max={max} step={parameter.step ?? 1} value={numeric} onChange={(event) => onChange(Number(event.target.value))} style={{ "--range-progress": `${progress}%` } as React.CSSProperties} />{diagnosticOrdering ? <small>显示/人工复核顺序刻度 · 非百分比、权重或得分</small> : parameter.recommendedRange && <small>建议 {parameter.recommendedRange[0]}–{parameter.recommendedRange[1]}{parameter.unit}</small>}</div>;
  }
  if (parameter.control === "select") return <select value={String(value ?? "")} onChange={(event) => { const option = parameter.options?.find((item) => String(item.value) === event.target.value); onChange(option?.value ?? event.target.value); }}>{parameter.options?.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>;
  if (parameter.control === "toggle") return <button type="button" className={`schema-toggle ${value ? "active" : ""}`} onClick={() => onChange(!value)}><span><i /></span><strong>{value ? "已开启" : "已关闭"}</strong><small>{value ? parameter.increaseEffect : parameter.decreaseEffect}</small></button>;
  if (parameter.control === "list" || parameter.control === "text_list") {
    const listValue = Array.isArray(value) ? value.join("\n") : String(value ?? "");
    return <div className="schema-list"><ListPlus size={15} /><textarea rows={4} value={listValue} onChange={(event) => onChange(lines(event.target.value))} placeholder="每行一项" /></div>;
  }
  if (parameter.control === "multi_select") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return <div className="schema-multi-select">{parameter.options?.map((option) => { const active = selected.includes(String(option.value)); return <button type="button" key={String(option.value)} className={active ? "active" : ""} onClick={() => onChange(active ? selected.filter((item) => item !== String(option.value)) : [...selected, String(option.value)])}><span>{active && <Check size={12} />}</span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>; })}</div>;
  }
  if (parameter.control === "number") return <input type="number" min={parameter.min} max={parameter.max} step={parameter.step} value={Number(value ?? parameter.defaultValue ?? 0)} onChange={(event) => onChange(Number(event.target.value))} />;
  return <input value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} placeholder={parameter.description} />;
}

const looksLikeUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

function ConfigPreviewModal({ open, loading, error, preview, input, presetName, projectName, formulaLabel, schema, submitting, onClose, onConfirm, onRetry }: {
  open: boolean;
  loading: boolean;
  error: string | null;
  preview: ResolvedConfigPreview | null;
  input: GenerateInput | null;
  presetName?: string;
  projectName?: string;
  formulaLabel: string;
  schema: GenerationParameterSchema;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const conflicts = [...(preview?.conflicts || []), ...(preview?.warnings || [])]
    .sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));
  const hasErrors = conflicts.some((item) => item.severity === "error");
  const visibleConflicts = conflicts.filter((item) => item.severity !== "info");
  const infoConflicts = conflicts.filter((item) => item.severity === "info");
  const conflictRow = (conflict: ConfigConflict, index: number) => <div key={`${conflict.title}-${index}`} className={`preview-conflict-row preview-conflict-row--${conflict.severity}`}>{conflict.severity === "error" ? <XCircle size={15} /> : conflict.severity === "warning" ? <AlertTriangle size={15} /> : <Info size={15} />}<span><strong>{conflict.title}</strong><p>{conflict.message}</p>{conflict.suggestion && <small>建议：{conflict.suggestion}</small>}</span></div>;
  const impactGroups = schema.groups
    .map((group) => ({
      ...group,
      items: (preview?.impacts || []).filter((impact) => schema.parameters.find((parameter) => parameter.id === impact.parameterId)?.group === group.id),
    }))
    .filter((group) => group.items.length > 0);
  const ungroupedImpacts = (preview?.impacts || []).filter((impact) => !schema.parameters.some((parameter) => parameter.id === impact.parameterId));
  const formulaVersionLabel = preview?.formulaVersion && !looksLikeUuid(preview.formulaVersion) ? preview.formulaVersion : formulaLabel;
  return <Modal open={open} onClose={onClose} title="生成前配置预览" description="确认本次参数如何继承、是否冲突，以及它们会影响哪些内容环节。" size="wide" footer={<><Button variant="ghost" onClick={onClose}>返回修改</Button><Button disabled={loading || Boolean(error) || hasErrors || !input || !preview} loading={submitting} icon={<Sparkles size={16} />} onClick={onConfirm}>确认并生成 3 个候选</Button></>}>
    {loading ? <div className="preview-loading"><span className="spinner" /><strong>正在解析配置继承与冲突…</strong><p>系统 → 工作区 → 项目 → 预设 → 本次覆盖</p></div> : error ? <div className="preview-loading" role="alert"><AlertTriangle size={22} /><strong>配置解析失败</strong><p>{error}。未取得服务端解析结果前不能创建生成任务。</p><Button variant="secondary" onClick={onRetry}>重试解析</Button></div> : preview && input ? <div className="config-preview">
      <section className="preview-inheritance"><span>系统默认</span><i>→</i><span>工作区</span><i>→</i><span>项目</span><i>→</i>{presetName && <><span className="active">{presetName}</span><i>→</i></>}<span className="active">本次任务</span></section>
      <section className="preview-facts"><div><small>项目</small><strong>{projectName || input.projectId}</strong></div><div><small>读者 / 入口</small><strong>{stageLabel(input.audienceStage)} · {entryLabel(input.entryPoint)}</strong></div><div><small>公式版本</small><strong>{formulaVersionLabel}</strong></div><div><small>知识注入</small><strong>{preview.knowledgeMode || "优先全量"}{preview.knowledgeFiles !== undefined ? ` · ${preview.knowledgeFiles} 份` : ""}</strong></div></section>
      {conflicts.length ? <section className="preview-conflicts"><h3>冲突与提示 <Badge tone={hasErrors ? "danger" : "warning"}>{conflicts.length} 项</Badge></h3>{visibleConflicts.map(conflictRow)}{infoConflicts.length > 0 && <details className="preview-info-toggle"><summary>还有 {infoConflicts.length} 条配置提示 <ChevronDown size={13} /></summary>{infoConflicts.map(conflictRow)}</details>}</section> : <div className="preview-clear"><CheckCircle2 size={16} /><span><strong>没有发现阻断生成的配置冲突</strong><small>未知信息仍会在结果中保留，不会自动当作事实。</small></span></div>}
      <section className="preview-impacts"><h3>参数影响预览 <Badge>{preview.impacts.length} 项</Badge></h3>
        {impactGroups.map((group) => <div className="preview-impact-group" key={group.id}>
          <header><span>{group.label}</span><b>{group.items.length}</b></header>
          {group.items.map((impact) => <div className="preview-impact-row" key={impact.parameterId}>
            <span className={`impact-direction impact-direction--${impact.direction || "changed"}`}>{impact.direction === "higher" ? <ArrowUp size={13} /> : impact.direction === "lower" ? <ArrowDown size={13} /> : <Settings2 size={13} />}</span>
            <span className="preview-impact-row__main"><strong>{impact.label}<b>{isDiagnosticEmphasisParameterId(impact.parameterId) ? `${formatImpactValue(impact.value)}（显示/人工顺序刻度）` : formatImpactValue(impact.value)}</b></strong><p>{impact.summary}</p>{impact.affects?.length ? <small>影响：{impact.affects.join(" · ")}</small> : null}</span>
          </div>)}
        </div>)}
        {ungroupedImpacts.length > 0 && <div className="preview-impact-group"><header><span>其他</span><b>{ungroupedImpacts.length}</b></header>{ungroupedImpacts.map((impact) => <div className="preview-impact-row" key={impact.parameterId}><span className={`impact-direction impact-direction--${impact.direction || "changed"}`}>{impact.direction === "higher" ? <ArrowUp size={13} /> : impact.direction === "lower" ? <ArrowDown size={13} /> : <Settings2 size={13} />}</span><span className="preview-impact-row__main"><strong>{impact.label}<b>{formatImpactValue(impact.value)}</b></strong><p>{impact.summary}</p>{impact.affects?.length ? <small>影响：{impact.affects.join(" · ")}</small> : null}</span></div>)}</div>}
      </section>
      <details className="resolved-config"><summary><Braces size={15} />查看最终解析配置 <ChevronDown size={14} /></summary><pre>{JSON.stringify(preview.resolvedConfig, null, 2)}</pre></details>
    </div> : null}
  </Modal>;
}

function localPreview(input: GenerateInput, advanced: AdvancedGenerationConfig, schema: GenerationParameterSchema, knowledgeCount?: number): ResolvedConfigPreview {
  const conflicts: ConfigConflict[] = [];
  const must = lines(input.mustInclude || "");
  const forbidden = lines(input.forbidden || "");
  const overlap = must.filter((item) => forbidden.some((other) => normalizeText(item) === normalizeText(other)));
  if (overlap.length) conflicts.push({ severity: "error", title: "必须提及与禁止表达冲突", message: `以下内容同时出现在两个列表：${overlap.join("、")}`, suggestion: "删除其中一侧的重复条目后再生成。" });
  if (advanced.informationBreadth >= 82 && advanced.bodyLength < 180 && advanced.commentThreads < 3) conflicts.push({ severity: "warning", title: "信息窗口大于可用表达空间", message: "信息广度较高，但正文很短且评论问答较少，容易把结论压缩成信息堆叠。", suggestion: "增加评论问答承接细节，或者降低信息广度。" });
  if (advanced.evidenceMode === "strict" && knowledgeCount !== undefined && knowledgeCount < 2) conflicts.push({ severity: "warning", title: "严格事实模式可能缺少材料", message: "当前项目知识文件较少，严格模式可能留下较多未知项。", suggestion: "补充事实知识，或接受输出明确标记信息不足。" });
  if (advanced.vigilanceLevel > 75 && advanced.informationDepth < 50) conflicts.push({ severity: "warning", title: "高证据审慎控制与低解释深度不匹配", message: "当前写作控制要求更严格地保留依据、反例和边界，但信息深度可能不足。这个控制值不是读者心理测量。", suggestion: "将信息深度提高到 60 以上，或降低兼容控制值。" });
  if (!advanced.commentThreads && advanced.informationBreadth > 70) conflicts.push({ severity: "warning", title: "评论区已关闭", message: "较大的信息窗口将全部由正文承担，可能牺牲真实表达和阅读节奏。", suggestion: "开启 3–5 组评论问答，或缩小信息窗口。" });
  const impacts = schema.parameters
    .map((parameter): ParameterImpact | null => {
      const value = getInputParameterValue(parameter, input, advanced);
      const changed = JSON.stringify(value) !== JSON.stringify(parameter.defaultValue);
      if (!changed) return null;
      const direction = typeof value === "number" && typeof parameter.defaultValue === "number" ? value > parameter.defaultValue ? "higher" : "lower" : "changed";
      return {
        parameterId: parameter.id,
        label: parameter.label,
        value,
        direction,
        summary: direction === "higher" ? parameter.increaseEffect || parameter.description : direction === "lower" ? parameter.decreaseEffect || parameter.description : parameter.description,
        affects: parameter.group === "information" ? ["信息规划", "正文", "评论区"] : parameter.group === "expression" ? ["标题", "正文", "评论区"] : parameter.group === "evidence" ? ["知识使用", "未知标记", "质量校验"] : ["候选差异", "自动修复"],
        risk: parameter.risk,
      };
    })
    .filter((item): item is ParameterImpact => Boolean(item));
  return {
    resolvedConfig: { schemaVersion: "1.0", task: { theme: input.topic || "由选题卡决定", goal: input.goal || "根据选题卡补全决策信息", audienceStage: input.audienceStage, entry: input.entryPoint, city: input.city || undefined, doctor: input.doctor || undefined, publishingTopology: input.publishingTopology, authorContext: input.authorContext, mustMention: must, forbidden }, opportunityId: input.opportunityId, imageAssetIds: input.imageAssetIds, parameters: inputParameterOverrides(input), legacyConfig: advanced, presetId: input.presetId },
    conflicts,
    warnings: [],
    impacts,
    knowledgeMode: advanced.knowledgeScope === "all" ? "全量优先" : knowledgeLabel(advanced.knowledgeScope),
    knowledgeFiles: knowledgeCount,
  };
}

function normalizePreview(server: ResolvedConfigPreview, fallback: ResolvedConfigPreview): ResolvedConfigPreview {
  const raw = server as unknown as Record<string, unknown>;
  const normalizeConflict = (item: unknown): ConfigConflict => {
    if (typeof item === "string") return { severity: "warning", title: "配置提示", message: item };
    const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { id: typeof value.id === "string" ? value.id : undefined, severity: value.severity === "error" || value.severity === "warning" ? value.severity : "info", title: String(value.title || value.code || "配置提示"), message: String(value.message || value.description || ""), paths: Array.isArray(value.paths) ? value.paths.map(String) : undefined, suggestion: typeof value.suggestion === "string" ? value.suggestion : undefined };
  };
  const serverConflicts = Array.isArray(raw.conflicts) ? raw.conflicts.map(normalizeConflict) : [];
  const serverWarnings = Array.isArray(raw.warnings) ? raw.warnings.map(normalizeConflict) : [];
  const impactSource = Array.isArray(raw.impacts)
    ? raw.impacts
    : Array.isArray(raw.impactPreview)
      ? raw.impactPreview
      : Array.isArray(raw.impactReport)
        ? raw.impactReport
        : raw.impactReport && typeof raw.impactReport === "object" && Array.isArray((raw.impactReport as Record<string, unknown>).parameterTraces)
          ? (raw.impactReport as Record<string, unknown>).parameterTraces as unknown[]
          : [];
  const serverImpacts = impactSource.map((item): ParameterImpact => {
    const value = item as Record<string, unknown>;
    return { parameterId: String(value.parameterId || value.id || value.path || "parameter"), label: String(value.label || value.name || value.path || "参数"), value: value.value, direction: (value.direction || "changed") as ParameterImpact["direction"], summary: String(value.summary || value.message || value.effect || "该参数已参与最终配置。"), affects: Array.isArray(value.affects) ? value.affects.map(String) : undefined, risk: typeof value.risk === "string" ? value.risk : undefined };
  });
  return {
    resolvedConfig: (raw.resolvedConfig || raw.resolved || raw.config || fallback.resolvedConfig) as Record<string, unknown>,
    conflicts: [...fallback.conflicts, ...serverConflicts],
    warnings: [...(fallback.warnings || []), ...serverWarnings],
    impacts: serverImpacts.length ? serverImpacts : fallback.impacts,
    formulaVersion: (() => {
      const value = raw.formulaVersion || raw.formulaVersionId;
      if (value && typeof value === "object") {
        const formula = value as Record<string, unknown>;
        return String(formula.version || formula.id || fallback.formulaVersion || "");
      }
      return String(value || fallback.formulaVersion || "");
    })(),
    knowledgeMode: String(raw.knowledgeMode || fallback.knowledgeMode || ""),
    knowledgeFiles: typeof raw.knowledgeFiles === "number" ? raw.knowledgeFiles : fallback.knowledgeFiles,
    estimatedInputTokens: typeof raw.estimatedInputTokens === "number" ? raw.estimatedInputTokens : undefined,
  };
}

function getInputParameterValue(parameter: GenerationParameterDefinition, input: GenerateInput, advanced: AdvancedGenerationConfig) {
  const overrides = inputParameterOverrides(input);
  if (Object.prototype.hasOwnProperty.call(overrides, parameter.id)) return overrides[parameter.id];
  if (parameter.path === "task.goal") return input.goal;
  if (parameter.path === "task.mustInclude") return lines(input.mustInclude || "");
  if (parameter.path === "config.strictEvidence") return advanced.evidenceMode === "strict";
  if (parameter.path === "config.commentsEnabled") return advanced.commentThreads > 0;
  if (parameter.path.startsWith("config.")) return (advanced as unknown as Record<string, unknown>)[parameter.path.slice(7)];
  return parameter.defaultValue;
}

function inputParameterOverrides(input: GenerateInput): Record<string, unknown> {
  const raw = input.overrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const nested = raw.parameterValues && typeof raw.parameterValues === "object" && !Array.isArray(raw.parameterValues)
    ? raw.parameterValues as Record<string, unknown>
    : {};
  const direct = Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
    key !== "parameterValues"
    && /^[a-z][a-z0-9_]*$/u.test(key)
    && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)),
  ));
  return { ...nested, ...direct };
}

function groupIcon(group: string): ReactNode {
  if (group === "information") return <BrainCircuit size={19} />;
  if (group === "expression") return <MessageCircleMore size={19} />;
  if (group === "evidence") return <ShieldCheck size={19} />;
  return <Settings2 size={19} />;
}

const lines = (value: string) => value.split(/\r?\n|[；;]/).map((item) => item.trim()).filter(Boolean);
const normalizeText = (value: string) => value.toLowerCase().replace(/[\s，。,.；;：:]/g, "");
const stageLabel = (value: string) => stages.find((item) => item.id === value)?.title || value;
const entryLabel = (value: string) => entryPoints.find((item) => item.id === value)?.title || value;
const knowledgeLabel = (value: string) => value === "all" ? "全部知识" : value === "facts" ? "仅事实与约束" : "手动选择";
const formatImpactValue = (value: unknown) => Array.isArray(value) ? `${value.length} 项` : typeof value === "boolean" ? value ? "开启" : "关闭" : String(value ?? "—");
const legacyConfigToParameters = (config: Partial<AdvancedGenerationConfig>): Record<string, unknown> => ({
  ...(typeof config.informationBreadth === "number" ? { information_breadth: config.informationBreadth } : {}),
  ...(typeof config.informationDepth === "number" ? { decision_information_depth: config.informationDepth } : {}),
  ...(typeof config.bodyLength === "number" ? { body_min_chars: Math.min(config.bodyLength, 100), body_max_chars: config.bodyLength } : {}),
  ...(typeof config.commentThreads === "number" ? { comment_thread_min: Math.min(config.commentThreads, 3), comment_thread_max: config.commentThreads } : {}),
  ...(typeof config.tone === "string" ? { expression_voice: config.tone } : {}),
  ...(typeof config.temperature === "number" ? { model_temperature: config.temperature } : {}),
  ...(typeof config.repairRounds === "number" ? { repair_attempts: config.repairRounds } : {}),
  ...(config.evidenceMode ? { evidence_strictness: config.evidenceMode === "strict" ? 95 : config.evidenceMode === "balanced" ? 80 : 55 } : {}),
  ...(config.knowledgeScope ? { knowledge_mode: config.knowledgeScope === "all" ? "auto" : config.knowledgeScope === "facts" ? "progressive" : "progressive" } : {}),
});
const parameterEvidenceLabel = (value: string) => ({ architecture_definition: "架构定义", normative_boundary: "规范边界", operational_default: "工程默认", hypothesis: "待验证猜想", unvalidated_proxy: "未标定代理", sample_observation: "样本观察", user_choice: "用户选择" }[value] || value);
const channelLabelForParameter = (value: string) => ({ H: "标签", "N.imageBrief": "图片", "N.title": "标题", "N.body": "正文", Cref: "评论" }[value] || value);
