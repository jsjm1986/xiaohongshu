import {
  AlertTriangle,
  ArrowRight,
  Braces,
  Calculator,
  ChevronDown,
  CheckCircle2,
  Copy,
  FlaskConical,
  GitBranch,
  Image,
  Info,
  LockKeyhole,
  Plus,
  RefreshCcw,
  RotateCcw,
  Variable,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjects } from "../components/ProjectContext";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Skeleton,
  useToast,
} from "../components/Ui";
import { V2Hero } from "../components/V2";
import { api } from "../lib/api";
import {
  CANONICAL_DIAGNOSTIC_FINGERPRINTS,
  hasCanonicalDiagnosticContract,
  isDiagnosticProxyFormulaId,
} from "../lib/diagnostic-proxy";
import {
  buildFormulaCalculationVariables,
  calculatorIssueMessage,
  calculatorResultLabel,
  hasAuthoritativeCalculationBoundary,
  isCalculationBoundToFormulaVersion,
  type FormulaCalculatorRawInputs,
} from "../lib/formula-calculator";
import { errorMessage } from "../lib/errors";
import {
  parseReviewedDefaultsSyncResult,
  requestConfirmedFormulaActivation,
  resolveReviewedDefaultsRefresh,
  resolveImageFormulaOutputBoundary,
  resolveFormulaRuntimeView,
  type FormulaRuntimeState,
  type FormulaRuntimeView,
} from "../lib/formula-ui";
import { defaultParameterSchema, normalizeParameterSchema } from "../lib/parameter-schema";
import { hasConsistentTrendFitCalculationResult, isReviewedTrendFitCalculatorContract, resolveTrendSourceBadge, resolveTrendSourceView, sameTrendFitContract, trendSourceOptionsFromAllowedValues, TREND_FIT_NON_CONSUMPTION_COPY } from "../lib/trend-fit";
import { formatDate } from "../lib/utils";
import type {
  FormulaDefinition,
  FormulaCalculationResult,
  FormulaVersion,
  GenerationParameterSchema,
} from "../types";

const typeLabel: Record<FormulaDefinition["type"], string> = {
  architecture: "生产定义",
  normative: "规范约束",
  hypothesis: "待验证猜想",
  proxy: "离线代理",
  validation: "验证设计",
};

const evidenceLabel: Record<string, string> = {
  definition: "项目定义（非实证）",
  bounded: "边界性依据",
  unvalidated: "尚未验证",
  unknown: "证据未知",
  unreviewed: "尚未复核",
};

export function FormulasPage() {
  const { projectId, currentProject } = useProjects();
  const [versions, setVersions] = useState<FormulaVersion[]>([]);
  const [schema, setSchema] = useState<GenerationParameterSchema>(defaultParameterSchema);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schemaWarning, setSchemaWarning] = useState<string | null>(null);
  const [selected, setSelected] = useState<FormulaVersion | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonValue, setJsonValue] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncingDefaults, setSyncingDefaults] = useState(false);
  const toast = useToast();

  const load = () => {
    if (!projectId) {
      setVersions([]);
      setSelected(null);
      setLoadError(null);
      setSchemaWarning(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    setSchemaWarning(null);
    Promise.all([
      api.formulas.list(projectId),
      api.parameters.schema(projectId)
        .then((value) => ({ value, error: null as string | null }))
        .catch((error) => ({ value: null, error: errorMessage(error, "参数 Schema 加载失败") })),
    ])
      .then(([result, schemaResult]) => {
        const active = result.items.find((item) => item.status === "active") || result.items[0];
        setVersions(result.items);
        setSelected(active || null);
        setSchema(normalizeParameterSchema(schemaResult.value, active));
        setSchemaWarning(schemaResult.error);
      })
      .catch((error) => setLoadError(errorMessage(error, "公式版本加载失败")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [projectId]);

  useEffect(() => {
    if (!selected) return;
    setJsonValue(JSON.stringify({
      name: selected.name,
      description: selected.description,
      config: selected.config || {},
      formulas: selected.formulas || [],
    }, null, 2));
  }, [selected]);

  const mappedFormulaIds = useMemo(
    () => new Set(schema.parameters.flatMap((parameter) => parameter.formulaIds)),
    [schema],
  );

  const activate = async (version: FormulaVersion) => {
    if (activatingId) return;
    setActivatingId(version.id);
    try {
      const result = await requestConfirmedFormulaActivation(versions, version, api.formulas.activate);
      if (!result.ok) {
        toast.push(result.message, "error");
        return;
      }
      setVersions(result.state.versions);
      setSelected(result.state.selected);
      toast.push(`${version.version} 已由服务端确认启用；只有已复核且有有效处理器的公式会执行`);
    } finally {
      setActivatingId(null);
    }
  };

  const createVersion = async () => {
    if (!projectId || !selected) return;
    setSaving(true);
    try {
      const result = await api.formulas.create({
        projectId,
        parentId: selected.id,
        name: selected.name || "完整文案公式",
        description: "从当前版本复制",
        formulas: selected.formulas,
        config: selected.config,
      });
      setVersions((current) => [result, ...current]);
      setSelected(result);
      setNewOpen(false);
      toast.push("草稿版本已创建");
    } catch (error) {
      toast.push(errorMessage(error, "公式草稿创建失败"), "error");
    } finally {
      setSaving(false);
    }
  };

  const syncReviewedDefaults = async () => {
    if (!projectId || syncingDefaults) return;
    setSyncingDefaults(true);
    let migrationConfirmed = false;
    try {
      const result = parseReviewedDefaultsSyncResult(
        await api.formulas.ensureReviewedDefaults(projectId),
        projectId,
      );
      if (!result.changed) {
        setSyncOpen(false);
        toast.push("服务端未派生新版本：当前没有可安全迁移的官方历史默认，或已经是最新版本；自定义公式不会被覆盖。", "info");
        return;
      }
      migrationConfirmed = true;
      const refreshed = await api.formulas.list(projectId);
      const state = resolveReviewedDefaultsRefresh(refreshed.items, result);
      setVersions(state.versions);
      setSelected(state.selected);
      setSchema((current) => ({ ...current, formulas: state.selected.formulas ?? [] }));
      setSyncOpen(false);
      toast.push("已由服务端派生并选中新 active 版本；旧 active 已归档，迁移审计已保留。自定义公式没有被覆盖。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "同步请求失败";
      toast.push(
        migrationConfirmed
          ? `服务端已确认派生新版本，但页面刷新失败：${detail}。请重新打开公式版本页。`
          : detail,
        "error",
      );
    } finally {
      setSyncingDefaults(false);
    }
  };

  const createFromDsl = async () => {
    if (!projectId || !selected) return;
    setSaving(true);
    try {
      const parsed = JSON.parse(jsonValue) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("根节点必须是 JSON 对象");
      if (parsed.formulas !== undefined && !Array.isArray(parsed.formulas)) throw new Error("formulas 必须是数组");
      const saved = await api.formulas.create({
        projectId,
        parentId: selected.id,
        name: typeof parsed.name === "string" ? parsed.name : selected.name,
        description: typeof parsed.description === "string" ? parsed.description : "从专家 JSON DSL 创建",
        config: parsed.config && typeof parsed.config === "object" ? parsed.config as Record<string, unknown> : selected.config,
        formulas: Array.isArray(parsed.formulas) ? parsed.formulas as FormulaDefinition[] : selected.formulas,
      } as Partial<FormulaVersion> & { parentId: string });
      setVersions((current) => [saved, ...current]);
      setSelected(saved);
      setAdvancedOpen(false);
      toast.push("Schema 校验通过，已创建新的公式草稿");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "JSON 结构不正确", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page formulas-page">
      <V2Hero
        status={<>{currentProject?.name || "当前项目"} · 当前启用 {versions.find((version) => version.status === "active")?.version || "无"}</>}
        title="公式版本"
        description={`「${currentProject?.name || "当前项目"}」的生产定义、规范边界、待验证推理与行为参数映射。`}
        actions={<><Button variant="secondary" icon={<GitBranch size={17} />} onClick={() => setSyncOpen(true)} disabled={!projectId}>同步已复核默认公式</Button><Button icon={<Plus size={17} />} onClick={() => setNewOpen(true)} disabled={!selected}>创建新版本</Button></>}
      />
      {loading ? <Skeleton lines={8} /> : loadError ? (
        <section className="panel"><EmptyState icon={<AlertTriangle size={24} />} title="公式版本加载失败" description={loadError} action={<Button variant="secondary" icon={<RefreshCcw size={16} />} onClick={load}>重试</Button>} /></section>
      ) : (
        <div className="formula-layout">
          <aside className="version-list">
            <header><h2>版本记录</h2><Badge>{versions.length} 个版本</Badge></header>
            {versions.map((version) => <button type="button" key={version.id} className={selected?.id === version.id ? "selected" : ""} onClick={() => setSelected(version)}><span className={`version-dot version-dot--${version.status}`} /><span><strong>{version.version}<Badge tone={version.status === "active" ? "positive" : version.status === "draft" ? "warning" : "neutral"}>{version.status === "active" ? "已启用" : version.status === "draft" ? "草稿" : "已归档"}</Badge></strong><small>{version.description}</small><i>{formatDate(version.createdAt)} · {version.formulas?.length ?? version.formulaCount ?? 0} 个公式单元</i></span><ArrowRight size={15} /></button>)}
          </aside>

          {selected ? <main className="formula-detail">
            {schemaWarning && <section className="formula-behavior-note"><AlertTriangle size={18} /><div><strong>参数映射暂未从服务端加载</strong><p>{schemaWarning}。当前参数映射只用于保持页面结构，不代表服务端已确认配置；请重试加载后再据此调整生成参数。</p></div><Button variant="ghost" icon={<RefreshCcw size={15} />} onClick={load}>重试</Button></section>}
            <header className="formula-detail__header"><div className="formula-detail__mark"><FlaskConical size={24} /></div><div><span>版本 {selected.version}</span><h2>{selected.name}</h2><p>{selected.description}</p></div><div className="formula-detail__actions">{selected.status === "active" ? <Badge tone="positive"><CheckCircle2 size={13} />当前启用</Badge> : <Button variant="secondary" loading={activatingId === selected.id} disabled={Boolean(activatingId)} onClick={() => activate(selected)}>启用此版本</Button>}</div></header>
            <div className="formula-meta"><span><GitBranch size={16} /><small>版本状态</small><strong>{selected.status === "active" ? "不可变已锁定" : selected.status === "archived" ? "已归档未启用" : "未启用草稿"}</strong></span><span><FlaskConical size={16} /><small>真实公式单元</small><strong>{selected.formulas?.length ?? selected.formulaCount ?? 0} 个</strong></span><span><LockKeyhole size={16} /><small>未知值策略</small><strong>保持 unknown</strong></span></div>

            <section className="formula-behavior-note"><Info size={18} /><div><strong>实施程度、公式身份和处理器状态必须分开看</strong><p>“部分实现、条件计算器、诊断代理、研究协议”都不是生成质量公式。实际运行以服务端 effective handlers 为准；它只证明对应处理器已启用，不证明整条方程、所有声明阶段或现实效果成立。pending_review、unreviewed 和缺少元数据均不执行可选处理器。</p><p>{selected.executionAudit?.auditScope?.description || selected.auditScope?.description || "当前视图仅描述版本默认能力，不代表某次生成任务的实际执行或效果。"}</p></div><Badge tone="purple">{mappedFormulaIds.size} 个公式有 Schema 关联</Badge></section>

            <section className="formula-registry">
              <header><div><h3>公式定义与证据状态</h3><p>这里展示后端返回的真实定义，不再用伪造的 0–100 分数替代公式。</p></div><Button variant="ghost" icon={<Braces size={16} />} onClick={() => setAdvancedOpen(true)}>专家 JSON DSL</Button></header>
              {selected.formulas?.length ? <div className="formula-card-list">{selected.formulas.map((formula) => <FormulaCard key={`${selected.id}-${formula.id}`} formula={formula} version={selected} mappedParameters={schema.parameters.filter((parameter) => parameter.formulaIds.includes(formula.id))} />)}</div> : <div className="formula-empty"><AlertTriangle size={22} /><div><strong>这个版本没有返回公式定义</strong><p>可以查看版本配置或从当前项目重新创建默认公式版本；系统不会用演示分数填补缺失定义。</p></div></div>}
            </section>

            <section className="formula-equation"><span>CONTENT PACKAGE · 生产装配定义</span><div><b>H</b><i>+</i><b>N</b><i>+</i><b>C<small>ref</small></b><i>=</i><strong>Wᴵ × Wˣ × Evidence</strong></div><p>标题承接入口，正文建立理解，评论区继续信息补全；三者共用同一个信息缺口计划，并受知识与证据边界约束。</p></section>
          </main> : <div className="formula-detail formula-empty"><AlertTriangle size={22} /><div><strong>当前项目没有公式版本</strong><p>创建项目默认版本后才能使用公式视图。</p></div></div>}
        </div>
      )}

      <Modal open={newOpen} onClose={() => { if (!saving) setNewOpen(false); }} title="创建公式草稿" description="已启用版本不会被修改，系统将创建一份独立副本。" footer={<><Button variant="ghost" disabled={saving} onClick={() => setNewOpen(false)}>取消</Button><Button loading={saving} onClick={createVersion} icon={<Copy size={16} />}>复制为草稿</Button></>}>
        <div className="version-copy-preview"><span><FlaskConical size={20} /></span><div><strong>{selected?.version || "当前公式"} → 新草稿</strong><p>真实公式定义、变量、表达式与项目配置将一并复制。</p></div></div>
      </Modal>

      <Modal open={syncOpen} onClose={() => !syncingDefaults && setSyncOpen(false)} title="同步已复核默认公式" description="这是显式的公式管理操作，不会在读取版本列表时自动执行。" footer={<><Button variant="ghost" disabled={syncingDefaults} onClick={() => setSyncOpen(false)}>取消</Button><Button loading={syncingDefaults} onClick={() => void syncReviewedDefaults()} icon={<GitBranch size={16} />}>确认同步并保留审计</Button></>}>
        <div className="form-stack">
          <div className="dsl-notice"><GitBranch size={17} /><p><strong>仅迁移服务端明确识别的官方历史默认</strong><br />如可安全迁移，服务端会派生新的 active 版本、归档旧 active，并记录迁移审计；页面随后重新读取版本列表并选中新 active。</p></div>
          <div className="formula-calculator-boundary"><AlertTriangle size={15} /><p><strong>这不是覆盖自定义公式。</strong> 自定义或语义不匹配的公式不会被替换，仍保持 pending_review / fail closed。没有 formula.manage 权限时，服务端会正常拒绝并在这里显示错误。</p></div>
        </div>
      </Modal>

      <Modal open={advancedOpen} onClose={() => setAdvancedOpen(false)} title="专家 JSON DSL" description="只接受 FormulaVersion Schema 允许的安全表达式；保存操作会创建新草稿，不会原地修改当前版本。" footer={<><Button variant="ghost" onClick={() => setAdvancedOpen(false)}>关闭</Button><Button loading={saving} onClick={createFromDsl}>校验并创建新草稿</Button></>}>
        <div className="dsl-notice"><Braces size={17} /><p><strong>可编辑变量、表达式和项目配置</strong><br />任意 JavaScript、函数或未知操作符都会被后端 Schema 拒绝。只有参数注册表中存在行为映射的变量会影响生成。</p></div>
        <Field label="公式版本 JSON"><textarea className="code-editor" rows={16} value={jsonValue} onChange={(event) => setJsonValue(event.target.value)} spellCheck={false} /></Field>
      </Modal>
    </div>
  );
}

const runtimeStatePresentation: Record<FormulaRuntimeState, { label: string; detail: string; tone: "positive" | "warning" | "danger" | "neutral" }> = {
  handlers_enabled: { label: "有效处理器已启用", detail: "服务端确认至少一个已注册处理器当前有效；这不等于整条方程或全部阶段已实现", tone: "positive" },
  pending_review: { label: "待复核，不执行", detail: "语义或实现尚未通过兼容性复核；即使有 Schema 关联也不会执行", tone: "warning" },
  unreviewed: { label: "未复核，不执行", detail: "服务端没有已复核的执行注册，不参与生成", tone: "warning" },
  handlers_disabled: { label: "可选处理器已停用", detail: "公式已复核，但当前版本没有启用其可选处理器；始终开启的安全机制需另看控制方式", tone: "neutral" },
  no_effective_handler: { label: "无有效可选处理器", detail: "服务端未返回当前有效的可选处理器；实际机制和控制方式仍需分别查看", tone: "neutral" },
  unknown: { label: "执行状态未知", detail: "服务端未返回足够的运行时元数据；不能据 Schema 关联推断为已执行", tone: "neutral" },
};

const implementationPresentation = {
  active: { label: "限定范围内已实现", tone: "positive" as const },
  partial: { label: "部分实现", tone: "warning" as const },
  conditional: { label: "条件执行", tone: "warning" as const },
  "protocol-only": { label: "研究协议，未运行", tone: "neutral" as const },
  "not-implemented": { label: "未实现", tone: "danger" as const },
};

const executionClassLabel: Record<string, string> = {
  "direct-executable": "直接生成机制",
  "derived-calculator": "条件计算器（不参与生成/选稿）",
  "diagnostic-proxy": "诊断代理（非质量总分）",
  protocol: "研究协议（当前未运行）",
  hypothesis: "待验证假设机制",
  "not-implemented": "未实现",
};

const roleLabel: Record<string, string> = {
  "direct-generation": "直接生成",
  "parameter-guidance": "参数指导",
  "conditional-calculator": "条件计算",
  "diagnostic-proxy": "分项诊断",
  "deterministic-mechanism": "确定性机制",
  "research-protocol": "研究协议",
};

const controlModeLabel: Record<string, string> = {
  "fully-gated": "完全受公式开关控制",
  "partially-gated": "仅部分受公式开关控制",
  "always-on": "始终开启，不由公式开关停用",
  "not-running": "当前不运行",
};

const implementationRuntimeStateLabel: Record<string, string> = {
  "not-reviewed": "尚未复核，机制不运行",
  "not-running": "当前机制不运行",
  "always-on": "始终开启机制正在工作",
  "mixed-active": "部分可选处理器与始终开启机制同时工作",
  "always-on-core-only": "仅始终开启的核心机制工作",
  "calculator-ready": "条件计算器已就绪，尚未代表已算出结果",
  "handler-active": "已复核的可选处理器正在工作",
  disabled: "可选处理器已停用",
};

const stageLabel: Record<string, string> = {
  configuration: "参数配置",
  calculation: "条件计算",
  generation: "生成",
  planning: "规划",
  diagnostic: "诊断",
  evaluation: "评价",
  validation: "校验",
  "knowledge-update": "知识更新",
};

const runtimeStatusLabel = (value?: string): string => {
  if (value === "reviewed" || value === "approved") return "已复核";
  if (value === "pending_review") return "待复核";
  if (value === "unreviewed") return "未复核";
  if (value === "enabled") return "已启用";
  if (value === "disabled") return "已停用";
  return value || "未返回";
};

const evidenceStatusLabel = (value?: string): string => value ? evidenceLabel[value] || value : "未返回";
const stagesText = (stages: string[]): string => stages.length ? stages.map((stage) => stageLabel[stage] || stage).join("、") : "无";

function RuntimeFacts({ runtime }: { runtime: FormulaRuntimeView }) {
  const presentation = runtimeStatePresentation[runtime.state];
  const implementation = runtime.implementationStatus ? implementationPresentation[runtime.implementationStatus] : undefined;
  const handlerText = runtime.effectiveHandlers.map((item) => `${item.kind}: ${item.handlers.join("、")}`).join(" · ");
  const registeredHandlerText = runtime.registeredHandlers.map((item) => `${item.kind}: ${item.handlers.join("、")}`).join(" · ");
  if (!runtime.hasServerMetadata) {
    return <div className="formula-runtime-status formula-runtime-status--unknown"><div><strong>{presentation.label}</strong><p>{presentation.detail}</p></div><small>当前 FormulaVersion DTO 未提供服务端执行审计字段。</small></div>;
  }
  return <div className={`formula-runtime-status formula-runtime-status--${runtime.state}`}>
    <div><strong>{presentation.label}</strong><p>{presentation.detail}</p></div>
    <dl>
      <div><dt>机制当前状态</dt><dd>{runtime.implementationRuntimeState ? implementationRuntimeStateLabel[runtime.implementationRuntimeState] || runtime.implementationRuntimeState : "未返回"}</dd></div>
      <div><dt>实施程度</dt><dd>{implementation?.label || "未返回"}</dd></div>
      <div><dt>执行身份</dt><dd>{runtime.executionClass ? executionClassLabel[runtime.executionClass] || runtime.executionClass : "未返回"}</dd></div>
      <div><dt>控制方式</dt><dd>{runtime.controlMode ? controlModeLabel[runtime.controlMode] || runtime.controlMode : "未返回"}{runtime.disableable === false ? " · 不可完整停用" : ""}</dd></div>
      <div><dt>有效证据状态</dt><dd>{evidenceStatusLabel(runtime.effectiveEvidenceStatus)}</dd></div>
      <div><dt>语义兼容复核</dt><dd>{runtimeStatusLabel(runtime.compatibilityStatus)}</dd></div>
      <div><dt>处理器状态</dt><dd>{runtimeStatusLabel(runtime.handlerState)}</dd></div>
      <div><dt>有效处理器</dt><dd>{handlerText || "无"}</dd></div>
      <div><dt>已注册处理器</dt><dd>{registeredHandlerText || "无"}</dd></div>
    </dl>
    <div className="formula-runtime-copy"><span><strong>当前实际机制</strong>{runtime.actualExecution || "服务端未提供说明"}</span><span><strong>实施边界</strong>{runtime.implementationBoundary || "服务端未提供说明"}</span></div>
    <div className="formula-stage-grid">
      <span><strong>已实现阶段</strong>{stagesText(runtime.implementedStages)}</span>
      <span><strong>声明阶段</strong>{stagesText(runtime.declaredStages)}</span>
      <span><strong>当前有效派发</strong>{stagesText(runtime.effectiveDispatchStages)}</span>
      <span className={runtime.nonDispatchedStages.length ? "has-gap" : ""}><strong>声明但未派发</strong>{stagesText(runtime.nonDispatchedStages)}</span>
    </div>
    {runtime.executionRoles.length ? <div className="formula-runtime-roles"><strong>运行身份</strong>{runtime.executionRoles.map((role) => <Badge key={role}>{roleLabel[role] || role}</Badge>)}</div> : null}
    <details><summary><Braces size={14} />审计依据与代码位置 <ArrowRight size={13} /></summary><div className="formula-runtime-audit"><p><strong>声明证据：</strong>{evidenceStatusLabel(runtime.declaredEvidenceStatus)}</p><p><strong>数据要求：</strong>{runtime.dataRequirement || "未返回"}</p><p><strong>已注册派发：</strong>{stagesText(runtime.registeredDispatchStages)}</p><p><strong>代码位置：</strong>{runtime.codeLocations.join("、") || "未返回"}</p></div></details>
  </div>;
}

const calculatorFieldCopy: Record<"F17" | "F21" | "F30", Array<{
  path: string;
  label: string;
  explanation: string;
  unitPath?: string;
  control?: "number" | "text" | "select";
  placeholder?: string;
}>> = {
  F17: [
    { path: "regretBefore", label: "regretBefore · 阅读前决策遗憾", explanation: "在同一个自定义量表上，阅读前预期会承担的遗憾。", unitPath: "regretBeforeUnit" },
    { path: "regretAfter", label: "regretAfter · 阅读后决策遗憾", explanation: "使用完全相同量表估计阅读后的遗憾。", unitPath: "regretAfterUnit" },
    { path: "cognitiveCost", label: "cognitiveCost · 认知成本", explanation: "理解、核验和比较信息占用的成本，同样必须换算到这把量尺。", unitPath: "cognitiveCostUnit" },
  ],
  F21: [
    { path: "pExposure", label: "pExposure · 曝光概率", explanation: "目标入口发生曝光的概率，范围 0–1。" },
    { path: "pNoticeGivenExposure", label: "pNoticeGivenExposure · 已曝光后被注意", explanation: "分母只包含已经曝光的人，范围 0–1。" },
    { path: "pEnterGivenNotice", label: "pEnterGivenNotice · 已注意后进入", explanation: "分母只包含已经注意到入口的人，范围 0–1。" },
    { path: "pConsumeGivenEnter", label: "pConsumeGivenEnter · 已进入后消费信息", explanation: "分母只包含已经进入内容的人，范围 0–1。" },
  ],
  F30: [
    { path: "trendSourceKind", label: "trendSourceKind · 明确来源类型", explanation: "只能显式选择小红书热点榜条目、小红书热议话题或其他明确来源；不选就保持 unknown。", control: "select" },
    { path: "trendSourceRef", label: "trendSourceRef · 来源引用", explanation: "只接受不含用户名密码的绝对 http(s) URL，或以 id:、title:、source: 开头并带具体内容的引用；只有 #标签、待生成标签或泛称都不够具体。", control: "text", placeholder: "https://… 或 id:… / title:… / source:…" },
    { path: "sourceObservedAt", label: "sourceObservedAt · 观察时间", explanation: "填写带秒与时区的 RFC3339 时间；没有实际观察记录就留空并保持 unknown。", control: "text", placeholder: "2026-07-14T10:30:00+08:00 或 2026-07-14T02:30:00Z" },
    { path: "relevance", label: "relevance · 主题相关性", explanation: "手工判断内容主题与所声明趋势的直接相关程度，0–1；不是需求量或曝光率。" },
    { path: "bridgeClarity", label: "bridgeClarity · 连接清晰度", explanation: "手工判断趋势与内容主题之间的连接是否清楚，0–1；不是点击概率。" },
    { path: "timeliness", label: "timeliness · 时效贴合度", explanation: "相对于上面记录的来源与观察时间做手工判断，0–1；不是官方排名。" },
  ],
};

function isCalculatorFormula(formula: FormulaDefinition): formula is FormulaDefinition & { id: "F17" | "F21" | "F30" } {
  return formula.id === "F17" || formula.id === "F21" || formula.id === "F30";
}

function FormulaScenarioCalculator({ formula, version, runtime }: {
  formula: FormulaDefinition & { id: "F17" | "F21" | "F30" };
  version: FormulaVersion;
  runtime: FormulaRuntimeView;
}) {
  const [inputs, setInputs] = useState<FormulaCalculatorRawInputs>({});
  const [result, setResult] = useState<FormulaCalculationResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const fields = calculatorFieldCopy[formula.id];
  const trendSource = formula.id === "F30" ? resolveTrendSourceView(inputs.trendSourceKind) : undefined;
  const trendSourceBadge = trendSource ? resolveTrendSourceBadge(trendSource, result) : undefined;
  const trendSourceOptions = formula.id === "F30"
    ? trendSourceOptionsFromAllowedValues(formula.variables?.find((variable) => variable.path === "trendSourceKind")?.allowedValues)
    : [];
  const reviewedCalculatorRuntime = runtime.state === "handlers_enabled"
    && runtime.effectiveHandlersEnabled
    && runtime.effectiveHandlers.some((item) => item.kind === "calculator" && item.handlers.length > 0);
  const trendContract = formula.id === "F30"
    && isReviewedTrendFitCalculatorContract(formula.calculatorContract, runtime, formula.variables ?? [])
    ? formula.calculatorContract
    : undefined;
  const available = runtime.executionClass === "derived-calculator"
    && reviewedCalculatorRuntime
    && Boolean(version.digest?.trim())
    && (formula.id !== "F30" || Boolean(trendContract));

  const update = (path: string, value: string) => {
    setInputs((current) => ({ ...current, [path]: value }));
    setResult(null);
    setRequestError(null);
  };

  const calculate = async () => {
    if (!available || calculating) return;
    setCalculating(true);
    setRequestError(null);
    try {
      const response = await api.formulas.calculate(
        version.id,
        formula.id,
        buildFormulaCalculationVariables(formula, inputs),
      );
      if (
        !isCalculationBoundToFormulaVersion(response, formula.id, version)
        || !hasAuthoritativeCalculationBoundary(response)
        || (formula.id === "F30" && (
          !sameTrendFitContract(formula.calculatorContract, response.calculatorContract)
          || !hasConsistentTrendFitCalculationResult(response)
        ))
      ) {
        throw new Error("服务端返回的计算边界声明不完整，结果已拒绝展示。");
      }
      setResult(response);
    } catch (error) {
      setResult(null);
      setRequestError(error instanceof Error ? error.message : "情景计算请求失败，请稍后重试。");
    } finally {
      setCalculating(false);
    }
  };

  const clear = () => {
    setInputs({});
    setResult(null);
    setRequestError(null);
  };

  if (formula.id === "F30" && !trendContract) {
    return <section className="formula-scenario-calculator" aria-label="F30 计算合同不可用">
      <header>
        <div><Calculator size={17} /><span><strong>F30 计算合同 unknown</strong><small>公式编号本身不能证明这是规范 TrendFit 计算器。</small></span></div>
        <Badge tone="warning">不可计算</Badge>
      </header>
      <div className="trend-contract trend-contract__missing"><AlertTriangle size={15} /><span><strong>未返回完整且已复核的合同、六项变量与 F30 计算处理器</strong><small>为避免把自定义或待复核的 F30 误写成规范 TrendFit，这里不展示规范字段、来源类别、输入说明或结果语义。</small></span></div>
      <div className="formula-calculator-actions"><Button type="button" icon={<Calculator size={15} />} disabled>计算不可用</Button><small>请先由服务端完成语义兼容复核；UI 不会根据标题、公式编号或旧快照自行补齐。</small></div>
    </section>;
  }

  return <section className="formula-scenario-calculator" aria-label={`${formula.id} 手工情景计算器`}>
    <header>
      <div><Calculator size={17} /><span><strong>手工情景计算器</strong><small>只计算你明确输入的假设，不会自动推断缺失值。</small></span></div>
      <Badge tone="warning">不参与生成 / 规划 / 选稿</Badge>
    </header>
    <div className="formula-calculator-boundary">
      <Info size={15} />
      <p><strong>输入不足 = unknown。</strong> 这里的结果只是手工情景值，不是内容质量分、真实人群测量或营销效果证明，也不会被任何内容生成、规划或候选选稿流程读取。</p>
    </div>
    {formula.id === "F17" ? <p className="formula-calculator-help">先自行定义一把可比较的量尺，例如“同一份 0–10 决策问卷分”。三个单位文字必须完全一致；仅写相同单位并不能让原本不可比的量自动变得可比。</p> : formula.id === "F21" ? <p className="formula-calculator-help">四项都是有明确条件分母的概率。请填 0–1 小数；例如 0.25 表示 25%，任何一项越界都会由服务端明确拒绝。</p> : <p className="formula-calculator-help"><strong>三项数值语义：</strong>相关性、连接清晰度、时效贴合度都是你为本次情景手工给出的 0–1 未标定判断。来源类型、引用和观察时间用于防止脱离来源计算；它们不是第四个得分，也不连接平台实时数据。</p>}
    {formula.id === "F30" ? <div className={`trend-contract ${trendContract ? "is-reviewed" : "is-unknown"}`}>
      {trendContract ? <>
        <header><span><strong>{trendContract.outputMetric} · 手工未标定情景指标</strong><small>输出范围 {trendContract.outputRange?.join("–")} · {trendContract.outputSemantics}</small></span><Badge tone="warning">所有下游 consumedBy=false</Badge></header>
        <div className="trend-contract__consumers">{(["generation", "planning", "selection", "validation"] as const).map((consumer) => <span key={consumer}><strong>{consumer}</strong><small>不消费</small></span>)}</div>
        {trendContract.excludedResearchOutputs.map((output) => <article key={output.protocolId}><span><strong>{output.metric}</strong><Badge tone="warning">{output.status} · outputProduced=false</Badge></span><p>{output.reason}</p><details><summary>要研究该结果还缺什么 <ChevronDown size={13} /></summary><ul>{output.requiredObservations.map((item) => <li key={item}>{item}</li>)}</ul></details></article>)}
      </> : <div className="trend-contract__missing"><AlertTriangle size={15} /><span><strong>TrendFit 合同 unknown</strong><small>当前公式定义没有返回完整、已复核的 calculatorContract，计算按钮保持禁用。</small></span></div>}
    </div> : null}
    {formula.id === "F30" && trendSource ? <div className="trend-source-boundary">
      <header><Info size={15} /><span><strong>当前趋势来源：{trendSource.label}</strong><small>{trendSource.explanation}</small></span><Badge tone={trendSourceBadge?.formatAccepted ? "blue" : "warning"}>{trendSourceBadge?.label || "unknown"}</Badge></header>
      <div>{trendSourceOptions.map((option) => <span key={option.value}><strong>{option.label}</strong><small>{option.explanation}</small></span>)}</div>
      <p>{TREND_FIT_NON_CONSUMPTION_COPY} “合格增量触达”属于另一个尚未执行的研究协议。</p>
    </div> : null}
    <div className={`formula-calculator-grid formula-calculator-grid--${formula.id.toLowerCase()}`}>
      {fields.map((field) => <div className="formula-calculator-field" key={field.path}>
        <Field label={field.label} hint={field.explanation} required>
          {field.control === "select" ? <select aria-label={field.label} value={inputs[field.path] ?? ""} onChange={(event) => update(field.path, event.target.value)}><option value="">未提供（unknown）</option>{trendSourceOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select> : <input
              aria-label={field.label}
              type={field.control === "text" ? "text" : "number"}
              inputMode={field.control === "text" ? "text" : "decimal"}
              step={field.control === "text" ? undefined : "any"}
              min={formula.id === "F21" || formula.id === "F30" ? 0 : undefined}
              max={formula.id === "F21" || formula.id === "F30" ? 1 : undefined}
              value={inputs[field.path] ?? ""}
              onChange={(event) => update(field.path, event.target.value)}
              placeholder={field.placeholder || (formula.id === "F21" || formula.id === "F30" ? "0–1" : "输入数值")}
            />}
        </Field>
        {field.unitPath ? <Field label={`${field.unitPath} · 单位`} hint="三个单位必须非空且完全一致" required>
          <input
            aria-label={`${field.unitPath} · 单位`}
            type="text"
            value={inputs[field.unitPath] ?? ""}
            onChange={(event) => update(field.unitPath!, event.target.value)}
            placeholder="例如：同一问卷分"
          />
        </Field> : null}
      </div>)}
    </div>
    <div className="formula-calculator-actions">
      <Button type="button" icon={<Calculator size={15} />} loading={calculating} disabled={!available} onClick={calculate}>计算情景值</Button>
      <Button type="button" variant="ghost" icon={<RotateCcw size={15} />} disabled={calculating} onClick={clear}>清空并回到 unknown</Button>
      {!available ? <small>{!version.digest?.trim() ? "当前版本未返回可绑定的服务端摘要 digest，不能计算。" : "当前版本没有返回已复核且有效的 calculator 处理器，不能计算。"}</small> : null}
    </div>
    <div className={`formula-calculator-result formula-calculator-result--${requestError ? "invalid" : result?.status ?? "unknown"}`} role="status" aria-live="polite">
      {requestError ? <><strong>请求未产生结果</strong><p>{requestError}</p></> : result?.status === "computed" && typeof result.value === "number" ? <><strong>{calculatorResultLabel(formula.id, result.value, result.unit ?? undefined)}</strong><p>{formula.id === "F30" ? "服务端只根据本次显式来源与三项手工输入计算未标定的 TrendFit；它不是触达率、热点排名或标签收益，也不会进入生成链路。" : "服务端安全计算器已完成本次手工情景计算；这不是质量分，也不会进入生成链路。"}</p></> : result ? <><strong>{result.status === "unknown" ? "结果：unknown（输入不足）" : "结果：invalid（输入不合法）"}</strong>{result.issues.length ? <ul>{result.issues.map((issue, index) => <li key={`${issue.path}-${issue.code}-${index}`}>{calculatorIssueMessage(issue)}</li>)}</ul> : <p>{result.status === "unknown" ? "至少一个必要输入缺失。" : "服务端拒绝了这组输入。"}</p>}</> : <><strong>结果：unknown</strong><p>尚未提交一组完整输入，系统不会猜测缺失值。</p></>}
    </div>
  </section>;
}

function FormulaCard({ formula, version, mappedParameters }: {
  formula: FormulaDefinition;
  version: FormulaVersion;
  mappedParameters: GenerationParameterSchema["parameters"];
}) {
  const runtime = resolveFormulaRuntimeView(formula, version);
  const imageOutputBoundary = resolveImageFormulaOutputBoundary(formula.id, runtime);
  const presentation = runtimeStatePresentation[runtime.state];
  const implementation = runtime.implementationStatus ? implementationPresentation[runtime.implementationStatus] : undefined;
  const diagnosticFormulaId = isDiagnosticProxyFormulaId(formula.id) ? formula.id : undefined;
  const currentDiagnosticContract = diagnosticFormulaId
    ? hasCanonicalDiagnosticContract(diagnosticFormulaId, formula.diagnosticContract)
      && runtime.semanticFingerprint === CANONICAL_DIAGNOSTIC_FINGERPRINTS[diagnosticFormulaId]
    : false;
  const handlerText = runtime.effectiveHandlers
    .map((item) => `${item.kind}: ${item.handlers.join("、")}`)
    .join(" · ");
  return <article className="formula-definition-card">
    <header><span className="formula-id">{formula.id}</span><div><h4>{formula.title}</h4><p>{formula.purpose}</p></div><div className="formula-statuses"><Badge tone={formula.type === "hypothesis" || formula.type === "proxy" ? "warning" : "purple"}>{typeLabel[formula.type]}</Badge>{implementation ? <Badge tone={implementation.tone}>{implementation.label}</Badge> : null}<Badge tone={runtime.effectiveEvidenceStatus === "unvalidated" || runtime.effectiveEvidenceStatus === "unknown" || runtime.effectiveEvidenceStatus === "unreviewed" ? "warning" : "neutral"}>{evidenceStatusLabel(runtime.effectiveEvidenceStatus ?? formula.evidenceStatus)}</Badge><Badge tone={presentation.tone}>{presentation.label}</Badge></div></header>
    <div className="formula-definition-body"><div className="formula-definition-equation"><span>数学表达</span><code>{formula.equation || "—"}</code></div><div className="formula-plain"><Info size={14} /><p><strong>小白说明</strong>{formula.plainLanguage || formula.purpose}</p></div>
      <RuntimeFacts runtime={runtime} />
      {formula.id === "F28" ? <section className="formula-opportunity-boundary" aria-label="F28 与机会排序边界">
        <Info size={15} /><div><strong>F28 不是当前选题卡排序器</strong><p>当前产品使用的是独立的 OpportunityRankHeuristicV1（机会排序启发式 V1）：固定权重且未标定，不是因果效果预测。没有 F28 所需的真实需求与竞品有效覆盖观测时，F28 仍保持研究协议；不得用启发式排序值冒充 F28 结果。</p></div><Badge tone="warning">协议 ≠ 启发式</Badge>
      </section> : null}
      {diagnosticFormulaId ? <section className="formula-diagnostic-boundary" aria-label={`${diagnosticFormulaId} 分项诊断合同`}>
        {currentDiagnosticContract ? <>
          <header><Info size={15} /><div><strong>只排列分项，不产生质量总分</strong><p>emphasis 只改变页面显示顺序和人工复核清单的先后；调高不会改变系统实际校验顺序、合格线、分项状态、生成或选稿。</p></div><Badge tone="warning">components-only</Badge></header>
          <div className="formula-diagnostic-facts"><span><strong>{formula.diagnosticContract!.componentDefinitions.length}</strong><small>个分项，当前均为 unknown/null</small></span><span><strong>无阈值</strong><small>missing 不会换算成 0</small></span><span><strong>无总分</strong><small>禁止求和、平均或 0—100 包装</small></span></div>
          <details><summary>查看合同边界 <ChevronDown size={13} /></summary><ul>{formula.diagnosticContract!.boundaries.map((boundary) => <li key={boundary}>{boundary}</li>)}</ul></details>
        </> : <header><AlertTriangle size={15} /><div><strong>诊断合同语义 unknown</strong><p>当前公式指纹或 diagnosticContract 与已复核的 {diagnosticFormulaId} 定义不匹配。页面不会沿用旧 emphasis、分项数值、排序含义或总分。</p></div><Badge tone="warning">fail closed</Badge></header>}
      </section> : null}
      {imageOutputBoundary ? <section className="formula-image-output-boundary" aria-label={`${formula.id} 图片产物边界`}>
        <header><Image size={16} /><div><strong>{imageOutputBoundary.label}</strong><p>{imageOutputBoundary.detail}</p></div><Badge tone="warning">Preview / Img 未完整落实</Badge></header>
        <div><span><strong>当前实现范围</strong>{imageOutputBoundary.completedScope.join("；")}</span><span><strong>当前缺失产物</strong>{imageOutputBoundary.absentScope.join("；")}</span></div>
      </section> : null}
      {isCalculatorFormula(formula) ? <FormulaScenarioCalculator formula={formula} version={version} runtime={runtime} /> : null}
      {formula.variables?.length ? <details><summary><Variable size={14} />{formula.variables.length} 个变量 <ArrowRight size={13} /></summary><div className="formula-variable-list">{formula.variables.map((variable) => <div key={variable.path}><code>{variable.path}</code><span>{variable.description}</span><Badge>{variable.valueType}{variable.required ? " · 必填" : ""}</Badge></div>)}</div></details> : null}
      {formula.expression ? <details><summary><Braces size={14} />查看安全表达式 AST <ArrowRight size={13} /></summary><pre>{JSON.stringify(formula.expression, null, 2)}</pre></details> : null}
    </div>
    <footer>{runtime.effectiveHandlersEnabled ? <><CheckCircle2 size={15} /><span><strong>有效处理器已启用</strong><small>{handlerText}{imageOutputBoundary ? " · 仅派发计划/文字范围，Preview 与 Img 未完整落实" : runtime.directGenerationMechanism ? " · 包含限定范围内的直接生成处理器" : " · 不代表生成质量或现实效果"}{mappedParameters.length ? ` · Schema 关联：${mappedParameters.map((parameter) => parameter.label).join("、")}` : ""}</small></span></> : <><Info size={15} /><span><strong>{presentation.label}</strong><small>{mappedParameters.length ? `仅有 Schema 关联：${mappedParameters.map((parameter) => parameter.label).join("、")}` : presentation.detail}</small></span></>}</footer>
  </article>;
}
