import {
  BookOpenCheck,
  CircleAlert,
  Database,
  ExternalLink,
  FlaskConical,
  Link2,
  Microscope,
  PackageCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjects } from "../components/ProjectContext";
import { Badge, Button, Field, Modal, PageHeader, Skeleton, useToast } from "../components/Ui";
import { api, ApiError } from "../lib/api";
import { defaultParameterSchema, normalizeParameterSchema } from "../lib/parameter-schema";
import {
  nextExperimentStatus,
  releaseBindingSummary,
  researchStatusLabel,
  researchStatusTone,
  safeResearchUrl,
} from "../lib/research-governance";
import { formatDate } from "../lib/utils";
import type {
  GenerationParameterSchema,
  ResearchCalibrationProposal,
  ResearchClaim,
  ResearchDatasetSnapshot,
  ResearchEvidenceSource,
  ResearchExperiment,
  ResearchExperimentResult,
  ResearchOverview,
  ResearchReleaseManifest,
} from "../types";

type Tab = "overview" | "claims" | "sources" | "datasets" | "experiments" | "calibrations" | "releases";
type CreateKind = Exclude<Tab, "overview"> | "result";

const tabs: Array<{ id: Tab; label: string; icon: typeof Microscope; count?: keyof ResearchOverview["counts"] }> = [
  { id: "overview", label: "总览", icon: Microscope },
  { id: "claims", label: "理论主张", icon: BookOpenCheck, count: "claims" },
  { id: "sources", label: "论文与来源", icon: Link2, count: "evidenceSources" },
  { id: "datasets", label: "实践数据", icon: Database, count: "datasets" },
  { id: "experiments", label: "实验", icon: FlaskConical, count: "experiments" },
  { id: "calibrations", label: "参数校准", icon: SlidersHorizontal, count: "calibrationProposals" },
  { id: "releases", label: "发布版本", icon: PackageCheck, count: "releases" },
];

const claimTypeLabel: Record<string, string> = {
  definition: "项目定义",
  external_research: "外部研究",
  internal_observation: "内部观察",
  inference: "推理",
  hypothesis: "猜想",
  unknown: "信息不足",
};

function initialForm(kind: CreateKind): Record<string, string> {
  if (kind === "claims") return { claimType: "hypothesis", title: "", statement: "", logicalKey: "", evidenceSourceId: "" };
  if (kind === "sources") return { kind: "paper", citation: "", url: "", supports: "", limitations: "", sourceKey: "" };
  if (kind === "datasets") return { kind: "internal_sample", label: "", datasetKey: "", sha256: "", rowCount: "", storageRef: "", provenance: "", limitations: "" };
  if (kind === "experiments") return { title: "", experimentKey: "", hypothesis: "", design: "{}", metrics: "[]", analysisPlan: "{}" };
  if (kind === "calibrations") return { targetKey: "comment_expansion", current: "70", proposed: "70", rationale: "", evidence: "{}", impact: "{}" };
  if (kind === "releases") return { version: "", buildId: "", notes: "" };
  return { result: "{}", conclusion: "inconclusive", datasetSnapshotId: "" };
}

export function ResearchPage() {
  const { projectId, currentProject } = useProjects();
  const [overview, setOverview] = useState<ResearchOverview | null>(null);
  const [schema, setSchema] = useState<GenerationParameterSchema>(defaultParameterSchema);
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const [resultExperiment, setResultExperiment] = useState<ResearchExperiment | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [releaseBindings, setReleaseBindings] = useState({ datasets: [] as string[], results: [] as string[], calibrations: [] as string[] });
  const toast = useToast();

  const load = async (quiet = false) => {
    if (!projectId) return;
    if (!quiet) setLoading(true);
    try {
      const [research, rawSchema] = await Promise.all([
        api.research.overview(projectId),
        api.parameters.schema(projectId).catch(() => null),
      ]);
      setOverview(research);
      setSchema(normalizeParameterSchema(rawSchema));
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "研究资料加载失败", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [projectId]);

  const openCreate = (kind: CreateKind, experiment?: ResearchExperiment) => {
    setCreateKind(kind);
    setResultExperiment(experiment ?? null);
    setForm(initialForm(kind));
    setReleaseBindings({ datasets: [], results: [], calibrations: [] });
  };

  const closeCreate = () => {
    setCreateKind(null);
    setResultExperiment(null);
  };

  const act = async (key: string, action: () => Promise<unknown>, success: string) => {
    if (!projectId || busy) return;
    setBusy(key);
    try {
      await action();
      await load(true);
      toast.push(success);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "操作失败";
      toast.push(message, "error");
    } finally {
      setBusy("");
    }
  };

  const submitCreate = async () => {
    if (!projectId || !createKind) return;
    setBusy(`create:${createKind}`);
    try {
      if (createKind === "claims") {
        const claim = await api.research.createClaim(projectId, {
          logicalKey: form.logicalKey || undefined,
          title: form.title,
          statement: form.statement,
          claimType: form.claimType,
          scope: [currentProject?.domain || "project"],
        });
        if (form.evidenceSourceId) await api.research.linkEvidence(projectId, claim.id, {
          evidenceSourceId: form.evidenceSourceId, relation: "context", strength: "unrated",
          note: "新建时关联；需人工复核来源支持范围与主张是否一致。",
        });
      } else if (createKind === "sources") {
        await api.research.createSource(projectId, {
          sourceKey: form.sourceKey || undefined, kind: form.kind, citation: form.citation,
          url: form.url || undefined, supports: form.supports, limitations: form.limitations,
        });
      } else if (createKind === "datasets") {
        await api.research.createDataset(projectId, {
          datasetKey: form.datasetKey || undefined, kind: form.kind, label: form.label,
          sha256: form.sha256.trim().toLowerCase(), rowCount: form.rowCount ? Number(form.rowCount) : undefined,
          storageRef: form.storageRef, provenance: form.provenance, limitations: form.limitations, schema: {},
        });
      } else if (createKind === "experiments") {
        await api.research.createExperiment(projectId, {
          experimentKey: form.experimentKey || undefined, title: form.title, hypothesis: form.hypothesis,
          design: parseJsonField(form.design, "实验设计"), metrics: parseJsonField(form.metrics, "指标"),
          analysisPlan: parseJsonField(form.analysisPlan, "分析计划"),
        });
      } else if (createKind === "calibrations") {
        const parameter = schema.parameters.find((item) => item.id === form.targetKey);
        await api.research.createCalibration(projectId, {
          targetType: "parameter", targetKey: form.targetKey,
          current: { value: parseParameterValue(form.current, parameter?.control) },
          proposed: { value: parseParameterValue(form.proposed, parameter?.control) },
          rationale: form.rationale, evidence: parseJsonField(form.evidence, "证据说明"),
          impact: parseJsonField(form.impact, "影响说明"),
        });
      } else if (createKind === "releases") {
        await api.research.createRelease(projectId, {
          version: form.version, buildId: form.buildId, notes: form.notes,
          bindings: {
            datasetSnapshotIds: releaseBindings.datasets,
            experimentResultIds: releaseBindings.results,
            calibrationProposalIds: releaseBindings.calibrations,
          },
        });
      } else if (createKind === "result" && resultExperiment) {
        await api.research.createExperimentResult(projectId, resultExperiment.id, {
          result: parseJsonField(form.result, "实验结果"), conclusion: form.conclusion,
          datasetSnapshotId: form.datasetSnapshotId || undefined,
        });
      }
      closeCreate();
      await load(true);
      toast.push("已保存为可审计记录；尚未批准的内容不会影响运行时");
    } catch (error) {
      toast.push(error instanceof Error ? error.message : "创建失败", "error");
    } finally {
      setBusy("");
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const includes = (value: unknown) => !needle || JSON.stringify(value).toLowerCase().includes(needle);
    return {
      claims: overview?.claims.filter(includes) ?? [],
      sources: overview?.evidenceSources.filter(includes) ?? [],
      datasets: overview?.datasets.filter(includes) ?? [],
      experiments: overview?.experiments.filter(includes) ?? [],
      calibrations: overview?.calibrationProposals.filter(includes) ?? [],
      releases: overview?.releases.filter(includes) ?? [],
    };
  }, [overview, query]);

  if (loading) return <><PageHeader title="研究与证据" description="正在装载版本化研究记录" /><Skeleton lines={8} /></>;

  return <div className="research-page">
    <PageHeader
      eyebrow="Research & Evidence"
      title="研究与证据中心"
      description={`管理 ${currentProject?.name || "当前项目"} 的理论、论文、实践数据、实验、校准和发布基线。`}
      actions={<>
        <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={() => void load()} loading={loading}>刷新</Button>
        {tab !== "overview" && <Button icon={<Plus size={16} />} onClick={() => openCreate(tab)}>新建{tabs.find((item) => item.id === tab)?.label}</Button>}
      </>}
    />

    <section className="research-isolation">
      <ShieldCheck size={22} />
      <div><strong>研究记录与生成运行时默认隔离</strong><p>论文、猜想和实验结果不会自动写入提示词；参数校准必须“批准 → 绑定发布清单 → 激活”才生效。单次生成的人工设置仍优先。</p></div>
      <Badge tone="positive">边界已启用</Badge>
    </section>

    <nav className="research-tabs" aria-label="研究资料分类">
      {tabs.map(({ id, label, icon: Icon, count }) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
        <Icon size={16} /><span>{label}</span>{count && <i>{overview?.counts[count] ?? 0}</i>}
      </button>)}
    </nav>

    {tab !== "overview" && <label className="research-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前分类" /></label>}

    {tab === "overview" && overview && <Overview overview={overview} onTab={setTab} />}
    {tab === "claims" && <ClaimList items={filtered.claims} busy={busy} approve={(item, status) => act(`claim:${item.id}`, () => api.research.reviewClaim(projectId, item.id, status), `主张已${status === "approved" ? "批准" : "拒绝"}`)} />}
    {tab === "sources" && <SourceList items={filtered.sources} busy={busy} approve={(item, status) => act(`source:${item.id}`, () => api.research.reviewSource(projectId, item.id, status), `来源已${status === "approved" ? "批准" : "拒绝"}`)} />}
    {tab === "datasets" && <DatasetList items={filtered.datasets} busy={busy} approve={(item, status) => act(`dataset:${item.id}`, () => api.research.reviewDataset(projectId, item.id, status), `数据快照已${status === "approved" ? "批准" : "拒绝"}`)} />}
    {tab === "experiments" && <ExperimentList items={filtered.experiments} busy={busy} onResult={(item) => openCreate("result", item)} transition={(item, status) => act(`experiment:${item.id}`, () => api.research.transitionExperiment(projectId, item.id, status), `实验状态已更新为${researchStatusLabel[status]}`)} reviewResult={(result, status) => act(`result:${result.id}`, () => api.research.reviewExperimentResult(projectId, result.id, status), `结果已${status === "approved" ? "批准" : "拒绝"}`)} />}
    {tab === "calibrations" && <CalibrationList items={filtered.calibrations} schema={schema} busy={busy} approve={(item, status) => act(`calibration:${item.id}`, () => api.research.reviewCalibration(projectId, item.id, status), `校准提案已${status === "approved" ? "批准，等待绑定发布" : "拒绝"}`)} />}
    {tab === "releases" && <ReleaseList items={filtered.releases} busy={busy} review={(item, status) => act(`release:${item.id}`, () => api.research.reviewRelease(projectId, item.id, status), `发布清单已${status === "approved" ? "批准" : "拒绝"}`)} activate={(item) => act(`release:${item.id}`, () => api.research.activateRelease(projectId, item.id), `${item.version} 已激活`)} />}

    <Modal open={Boolean(createKind)} onClose={closeCreate} title={createTitle(createKind)} description={createDescription(createKind)} footer={<><Button variant="secondary" onClick={closeCreate}>取消</Button><Button loading={busy.startsWith("create:")} onClick={() => void submitCreate()}>保存草稿</Button></>}>
      {createKind && <CreateForm kind={createKind} form={form} setForm={setForm} overview={overview} schema={schema} bindings={releaseBindings} setBindings={setReleaseBindings} />}
    </Modal>
  </div>;
}

function Overview({ overview, onTab }: { overview: ResearchOverview; onTab: (tab: Tab) => void }) {
  const active = overview.activeRelease;
  const cards = [
    ["claims", "理论主张", overview.counts.claims, "定义、观察、推理与猜想分开记录"],
    ["sources", "论文与来源", overview.counts.evidenceSources, "同时写明支持范围和不支持范围"],
    ["datasets", "实践数据", overview.counts.datasets, "数据指纹、来源与局限固定存档"],
    ["experiments", "实验版本", overview.counts.experiments, `${overview.counts.experimentResults} 个登记结果`],
    ["calibrations", "参数校准", overview.counts.calibrationProposals, "审批后仍需发布清单激活"],
  ] as const;
  return <div className="research-overview">
    <section className="research-active-release">
      <div className="research-active-release__icon"><PackageCheck size={25} /></div>
      <div><small>当前生成运行基线</small><h2>{active?.version || "尚未管理"}</h2><p>{active?.notes || "尚未建立发布清单。"}</p></div>
      {active && <div className="research-version-grid">
        <span><small>公式</small><strong>{shortDigest(active.formulaDigest)}</strong></span>
        <span><small>提示合同</small><strong>v{active.promptVersion} · {shortDigest(active.promptDigest)}</strong></span>
        <span><small>参数策略</small><strong>v{active.parameterPolicyVersion} · {shortDigest(active.parameterPolicyDigest)}</strong></span>
        <span><small>证据目录</small><strong>{active.evidenceCatalogVersion}</strong></span>
      </div>}
    </section>
    <div className="research-metric-grid">{cards.map(([id, title, value, detail]) => <button key={id} onClick={() => onTab(id)}><strong>{value}</strong><span>{title}</span><small>{detail}</small></button>)}</div>
    <section className="research-boundary-grid">
      <article><ShieldCheck size={19} /><div><strong>不会自动注入</strong><p>研究文字不直接进入生成提示词，避免未批准猜想改变文案。</p></div></article>
      <article><FlaskConical size={19} /><div><strong>实验不会自动套用</strong><p>完成或支持假设都不等于可发布；结果还需独立复核。</p></div></article>
      <article><SlidersHorizontal size={19} /><div><strong>校准可追溯</strong><p>每次生成冻结发布清单 ID 与参数、提示、公式、证据目录指纹。</p></div></article>
    </section>
    <p className="research-catalog-note">证据目录 {overview.catalog.version} · SHA-256 {shortDigest(overview.catalog.digest)}。目录引用只在明确支持范围内成立，不等于为全部公式提供因果证据。</p>
  </div>;
}

function ClaimList({ items, busy, approve }: { items: ResearchClaim[]; busy: string; approve: (item: ResearchClaim, status: string) => void }) {
  return <div className="research-list">{items.map((item) => <article className="research-card" key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><Badge tone="purple">{claimTypeLabel[item.claimType] || item.claimType}</Badge><span>v{item.version}</span></div><small>{item.evidenceCount ?? 0} 个证据链接</small></header>
    <h3>{item.title}</h3><p>{item.statement}</p>
    {typeof item.metadata?.boundary === "string" && <aside><strong>适用边界</strong>{item.metadata.boundary}</aside>}
    <footer><code>{item.logicalKey}</code><ReviewButtons status={item.status} loading={busy === `claim:${item.id}`} onReview={(status) => approve(item, status)} /></footer>
  </article>)}</div>;
}

function SourceList({ items, busy, approve }: { items: ResearchEvidenceSource[]; busy: string; approve: (item: ResearchEvidenceSource, status: string) => void }) {
  return <div className="research-list">{items.map((item) => { const url = safeResearchUrl(item.url); return <article className="research-card research-card--source" key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><Badge>{item.kind}</Badge><span>v{item.version}</span></div><small>关联 {item.claimCount ?? 0} 个主张</small></header>
    <h3>{item.citation}</h3>{url && <a href={url} target="_blank" rel="noreferrer">查看原始来源 <ExternalLink size={13} /></a>}
    <div className="research-support-grid"><section><strong>这个来源支持</strong><p>{item.supports || "尚未说明"}</p></section><section><strong>这个来源不支持 / 局限</strong><p>{item.limitations || "尚未说明，批准前必须补全"}</p></section></div>
    <footer><code>{item.sourceKey}</code><ReviewButtons status={item.status} loading={busy === `source:${item.id}`} onReview={(status) => approve(item, status)} /></footer>
  </article>; })}</div>;
}

function DatasetList({ items, busy, approve }: { items: ResearchDatasetSnapshot[]; busy: string; approve: (item: ResearchDatasetSnapshot, status: string) => void }) {
  return <div className="research-list">{items.map((item) => <article className="research-card" key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><Badge>{item.kind}</Badge><span>v{item.version}</span></div><small>{item.rowCount ?? "?"} 条记录</small></header>
    <h3>{item.label}</h3><p><strong>来源：</strong>{item.provenance || "尚未说明"}</p><aside><strong>局限</strong>{item.limitations || "批准前必须补全"}</aside>
    <div className="research-digest"><span>SHA-256</span><code title={item.sha256}>{shortDigest(item.sha256)}</code><span>{item.storageRef}</span></div>
    <footer><code>{item.datasetKey}</code><ReviewButtons status={item.status} loading={busy === `dataset:${item.id}`} onReview={(status) => approve(item, status)} /></footer>
  </article>)}</div>;
}

function ExperimentList({ items, busy, onResult, transition, reviewResult }: { items: ResearchExperiment[]; busy: string; onResult: (item: ResearchExperiment) => void; transition: (item: ResearchExperiment, status: ResearchExperiment["status"]) => void; reviewResult: (item: ResearchExperimentResult, status: string) => void }) {
  return <div className="research-list">{items.map((item) => { const next = nextExperimentStatus(item.status); return <article className="research-card research-card--experiment" key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><span>v{item.version}</span></div><code>{item.experimentKey}</code></header>
    <h3>{item.title}</h3><aside><strong>预先声明的假设</strong>{item.hypothesis}</aside>
    <details><summary>实验设计与分析计划</summary><pre>{JSON.stringify({ design: item.design, metrics: item.metrics, analysisPlan: item.analysisPlan }, null, 2)}</pre></details>
    {item.results?.map((result) => <section className="research-result" key={result.id}><header><strong>结果 v{result.version}</strong><Badge tone={researchStatusTone(result.status)}>{researchStatusLabel[result.status] || result.status}</Badge><Badge tone={result.conclusion === "supports" ? "positive" : result.conclusion === "contradicts" ? "danger" : "warning"}>{result.conclusion}</Badge></header><pre>{JSON.stringify(result.result, null, 2)}</pre>{["draft", "under_review"].includes(result.status) && <ReviewButtons status={result.status} loading={busy === `result:${result.id}`} onReview={(status) => reviewResult(result, status)} />}</section>)}
    <footer><span>{formatDate(item.createdAt)}</span><div>{["running", "completed", "replicated"].includes(item.status) && <Button variant="secondary" onClick={() => onResult(item)}>登记结果</Button>}{next && <Button loading={busy === `experiment:${item.id}`} onClick={() => transition(item, next)}>推进到{researchStatusLabel[next]}</Button>}</div></footer>
  </article>; })}</div>;
}

function CalibrationList({ items, schema, busy, approve }: { items: ResearchCalibrationProposal[]; schema: GenerationParameterSchema; busy: string; approve: (item: ResearchCalibrationProposal, status: string) => void }) {
  return <div className="research-list">{items.map((item) => { const parameter = schema.parameters.find((entry) => entry.id === item.targetKey); return <article className="research-card" key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><Badge>{item.targetType}</Badge></div>{item.appliedReleaseId && <small>发布 {shortDigest(item.appliedReleaseId)}</small>}</header>
    <h3>{parameter?.label || item.targetKey}</h3><div className="research-calibration-values"><span><small>当前值</small><strong>{String(item.current?.value ?? "未知")}</strong></span><b>→</b><span><small>建议值</small><strong>{String(item.proposed?.value ?? "未知")}</strong></span></div>
    <p>{item.rationale}</p>{parameter && <aside><strong>参数影响</strong>{parameter.increaseEffect} {parameter.risk}</aside>}
    <footer><code>{item.targetKey}</code><ReviewButtons status={item.status} loading={busy === `calibration:${item.id}`} onReview={(status) => approve(item, status)} /></footer>
  </article>; })}</div>;
}

function ReleaseList({ items, busy, review, activate }: { items: ResearchReleaseManifest[]; busy: string; review: (item: ResearchReleaseManifest, status: string) => void; activate: (item: ResearchReleaseManifest) => void }) {
  return <div className="research-list">{items.map((item) => <article className={`research-card research-card--release ${item.status === "active" ? "is-active" : ""}`} key={item.id}>
    <header><div><Badge tone={researchStatusTone(item.status)}>{researchStatusLabel[item.status] || item.status}</Badge><span>App {item.appVersion}</span></div><small>{formatDate(item.activatedAt || item.createdAt)}</small></header>
    <h3>{item.version}</h3><p>{item.notes || "没有版本说明"}</p><aside><strong>已绑定</strong>{releaseBindingSummary(item)}</aside>
    <div className="research-release-contract"><span>公式 <code>{shortDigest(item.formulaDigest)}</code></span><span>执行 <code>{shortDigest(item.executionPolicyDigest)}</code></span><span>提示 <code>{shortDigest(item.promptDigest)}</code></span><span>参数 <code>{shortDigest(item.parameterPolicyDigest)}</code></span><span>证据 <code>{shortDigest(item.evidenceCatalogDigest)}</code></span></div>
    <footer><code>{shortDigest(item.id)}</code><div>{item.status === "draft" && <><Button variant="danger" loading={busy === `release:${item.id}`} onClick={() => review(item, "rejected")}>拒绝</Button><Button loading={busy === `release:${item.id}`} onClick={() => review(item, "approved")}>批准</Button></>}{item.status === "approved" && <Button loading={busy === `release:${item.id}`} onClick={() => activate(item)}>激活到生成运行时</Button>}</div></footer>
  </article>)}</div>;
}

function ReviewButtons({ status, loading, onReview }: { status: string; loading: boolean; onReview: (status: string) => void }) {
  if (!["draft", "under_review"].includes(status)) return null;
  return <div><Button variant="danger" loading={loading} onClick={() => onReview("rejected")}>拒绝</Button><Button loading={loading} onClick={() => onReview("approved")}>批准</Button></div>;
}

function CreateForm({ kind, form, setForm, overview, schema, bindings, setBindings }: { kind: CreateKind; form: Record<string, string>; setForm: (value: Record<string, string>) => void; overview: ResearchOverview | null; schema: GenerationParameterSchema; bindings: { datasets: string[]; results: string[]; calibrations: string[] }; setBindings: (value: { datasets: string[]; results: string[]; calibrations: string[] }) => void }) {
  const field = (key: string) => ({ value: form[key] || "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value }) });
  if (kind === "claims") return <div className="research-form"><Field label="主张类型" required><select {...field("claimType")}><option value="definition">项目定义</option><option value="external_research">外部研究</option><option value="internal_observation">内部观察</option><option value="inference">推理</option><option value="hypothesis">猜想</option><option value="unknown">信息不足</option></select></Field><Field label="标题" required><input {...field("title")} /></Field><Field label="完整陈述" required hint="陈述一件可被证伪或复核的事，不要把猜想写成事实。"><textarea rows={5} {...field("statement")} /></Field><Field label="逻辑键" hint="可留空自动生成；同一主张新版本应沿用同一逻辑键。"><input {...field("logicalKey")} /></Field><Field label="关联来源" hint="这里只建立上下文链接，不自动宣称该来源支持主张。"><select {...field("evidenceSourceId")}><option value="">稍后关联</option>{overview?.evidenceSources.map((item) => <option key={item.id} value={item.id}>{item.citation}</option>)}</select></Field></div>;
  if (kind === "sources") return <div className="research-form"><Field label="来源类型" required><select {...field("kind")}><option value="paper">论文</option><option value="official_document">官方文件</option><option value="internal_observation">内部观察</option><option value="dataset">数据集</option><option value="unknown">待核实来源</option></select></Field><Field label="引用信息" required hint="建议包含作者、年份、标题和出版物。"><textarea rows={3} {...field("citation")} /></Field><Field label="原文链接"><input type="url" {...field("url")} /></Field><Field label="这个来源实际支持什么" required><textarea rows={4} {...field("supports")} /></Field><Field label="不支持什么 / 适用局限" required><textarea rows={4} {...field("limitations")} /></Field><Field label="来源键"><input {...field("sourceKey")} /></Field></div>;
  if (kind === "datasets") return <div className="research-form"><Field label="快照名称" required><input {...field("label")} /></Field><Field label="数据类型" required><select {...field("kind")}><option value="internal_sample">内部样本</option><option value="experiment">实验数据</option><option value="live_observation">线上观察</option><option value="external">外部数据</option></select></Field><Field label="SHA-256" required hint="64 位小写十六进制；用于确认后续引用的是同一份数据。"><input {...field("sha256")} /></Field><Field label="记录数"><input type="number" min="0" {...field("rowCount")} /></Field><Field label="存储位置"><input {...field("storageRef")} /></Field><Field label="来源与采集方法" required><textarea rows={4} {...field("provenance")} /></Field><Field label="样本局限" required><textarea rows={4} {...field("limitations")} /></Field><Field label="数据键"><input {...field("datasetKey")} /></Field></div>;
  if (kind === "experiments") return <div className="research-form"><Field label="实验标题" required><input {...field("title")} /></Field><Field label="待检验假设" required hint="先写假设，再预注册，之后才能开始和登记结果。"><textarea rows={4} {...field("hypothesis")} /></Field><Field label="实验键"><input {...field("experimentKey")} /></Field><Field label="设计 JSON" required><textarea rows={5} className="code-input" {...field("design")} /></Field><Field label="指标 JSON 数组" required><textarea rows={3} className="code-input" {...field("metrics")} /></Field><Field label="分析计划 JSON" required><textarea rows={5} className="code-input" {...field("analysisPlan")} /></Field></div>;
  if (kind === "calibrations") { const parameter = schema.parameters.find((item) => item.id === form.targetKey); return <div className="research-form"><Field label="生成参数" required><select {...field("targetKey")}>{schema.parameters.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</select></Field>{parameter && <aside className="research-parameter-help"><strong>{parameter.equation || parameter.label}</strong><p>{parameter.noviceExplanation}</p><small>调高：{parameter.increaseEffect || "查看参数说明"}<br />调低：{parameter.decreaseEffect || "查看参数说明"}<br />证据：{parameter.evidenceNote || "尚无校准证据"}</small></aside>}<div className="research-form__pair"><Field label="当前值" required><input {...field("current")} /></Field><Field label="建议值" required><input {...field("proposed")} /></Field></div><Field label="为什么建议调整" required><textarea rows={4} {...field("rationale")} /></Field><Field label="证据引用 JSON" required hint="建议登记数据快照 ID、实验结果 ID，以及它没有证明什么。"><textarea rows={4} className="code-input" {...field("evidence")} /></Field><Field label="预计影响与风险 JSON" required><textarea rows={4} className="code-input" {...field("impact")} /></Field></div>; }
  if (kind === "releases") return <div className="research-form"><Field label="版本号" required hint="例如 0.2.0 或 2026.07.1；创建后运行合同指纹会被冻结。"><input {...field("version")} /></Field><Field label="构建号"><input {...field("buildId")} /></Field><Field label="版本说明" required><textarea rows={4} {...field("notes")} /></Field><BindingPicker title="已批准数据快照" items={(overview?.datasets ?? []).filter((item) => item.status === "approved").map((item) => [item.id, `${item.label} · ${shortDigest(item.sha256)}`])} selected={bindings.datasets} onChange={(datasets) => setBindings({ ...bindings, datasets })} /><BindingPicker title="已批准实验结果" items={(overview?.experiments ?? []).flatMap((experiment) => experiment.results.filter((item) => item.status === "approved").map((item) => [item.id, `${experiment.title} · 结果 v${item.version}`] as [string, string]))} selected={bindings.results} onChange={(results) => setBindings({ ...bindings, results })} /><BindingPicker title="已批准参数校准" items={(overview?.calibrationProposals ?? []).filter((item) => item.status === "approved").map((item) => [item.id, `${item.targetKey}: ${String(item.current.value)} → ${String(item.proposed.value)}`])} selected={bindings.calibrations} onChange={(calibrations) => setBindings({ ...bindings, calibrations })} /></div>;
  return <div className="research-form"><Field label="结论方向" required><select {...field("conclusion")}><option value="supports">支持预注册假设</option><option value="contradicts">反驳预注册假设</option><option value="inconclusive">结果不确定</option><option value="not_analyzed">尚未分析</option></select></Field><Field label="关联数据快照"><select {...field("datasetSnapshotId")}><option value="">不关联</option>{overview?.datasets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="结果 JSON" required hint="保存观察值、样本量、效应量/不确定性与异常；不能只写结论。"><textarea rows={9} className="code-input" {...field("result")} /></Field></div>;
}

function BindingPicker({ title, items, selected, onChange }: { title: string; items: Array<[string, string]>; selected: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="research-binding-picker"><legend>{title}</legend>{items.length ? items.map(([id, label]) => <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={(event) => onChange(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} /><span>{label}</span></label>) : <p>暂无可绑定的已批准记录</p>}</fieldset>;
}

function parseJsonField(value: string, label: string): unknown {
  try { return JSON.parse(value || "{}"); } catch { throw new Error(`${label}不是有效 JSON`); }
}

function parseParameterValue(value: string, control?: string): unknown {
  if (["slider", "number"].includes(control || "")) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("参数值必须是数字");
    return number;
  }
  if (control === "toggle") return value === "true";
  return value;
}

function shortDigest(value?: string | null): string { return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—"; }
function createTitle(kind: CreateKind | null): string { return kind === "result" ? "登记实验结果" : `新建${tabs.find((item) => item.id === kind)?.label || "研究记录"}`; }
function createDescription(kind: CreateKind | null): string { return kind === "releases" ? "发布清单冻结公式、执行、提示、参数和证据目录版本；批准后仍需单独激活。" : kind === "calibrations" ? "校准值不会在保存或批准时立即生效，必须进入已激活发布清单。" : kind === "result" ? "结果与结论分开登记，支持假设不等于证明因果或可直接上线。" : "先保存草稿，再由有权限的成员复核；不要把观察、推理和猜想混写成事实。"; }
