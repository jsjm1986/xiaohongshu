import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Download,
  FileJson,
  FileText,
  Image,
  Info,
  LoaderCircle,
  MessageCircleMore,
  PackageCheck,
  RefreshCcw,
  Send,
  Settings2,
  Sparkles,
  Tags,
  Target,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  EmptyState,
  useToast,
} from "../components/Ui";
import { V2Hero } from "../components/V2";
import { api } from "../lib/api";
import {
  commentNodeKindLabel,
  commentThreadKindLabel,
  commentThreadKindOf,
  orgAnswerIdentityBadge,
  deploymentSla,
  liveRoutingLines,
  uncoveredGapLabels,
} from "../lib/comment-cref";
import {
  isDiagnosticEmphasisParameterId,
  isDiagnosticProxyFormulaId,
  resolveDiagnosticProxyView,
  resolveValidationReadinessHeuristic,
  type DiagnosticProxyView,
} from "../lib/diagnostic-proxy";
import { demoGenerations } from "../lib/fixtures";
import {
  generationRecordNotice,
  ordinaryDiagnosticsForDisplay,
} from "../lib/generation-record";
import { resolveProductionArtifactView } from "../lib/image-production";
import { resolveOpportunitySelectionAuditView } from "../lib/opportunity-rank";
import { resolveReaderStateView } from "../lib/reader-state";
import { resolveHistoricalTrendFitSnapshot } from "../lib/trend-fit";
import { candidateToMarkdown, formatDate } from "../lib/utils";
import { validationIssueLabel } from "../lib/validation-labels";
import type {
  Candidate,
  DiagnosticProxySnapshot,
  GenerationImpactReport,
  GenerationJob,
  ParameterImpact,
} from "../types";

export function GenerationResultPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordSource, setRecordSource] = useState<"loading" | "server" | "fallback">("loading");
  const [selectedId, setSelectedId] = useState("");
  const [revision, setRevision] = useState("");
  const [revising, setRevising] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const load = async () => {
      try {
        const data = await api.generations.get(id);
        if (!alive) return;
        setJob(data);
        setRecordSource("server");
        if (data.status === "queued" || data.status === "running")
          timer = window.setTimeout(load, 1800);
      } catch {
        const stored = sessionStorage.getItem("content-agent-demo-generation");
        const fallback = stored
          ? (JSON.parse(stored) as GenerationJob)
          : demoGenerations.find((item) => item.id === id) ||
            demoGenerations[0];
        if (alive) {
          setJob(fallback);
          setRecordSource("fallback");
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!selectedId && job?.candidates?.[0])
      setSelectedId(job.candidates[0].id);
  }, [job, selectedId]);

  const selected = useMemo(
    () =>
      job?.candidates?.find((candidate) => candidate.id === selectedId) ||
      job?.candidates?.[0],
    [job, selectedId],
  );
  const isFallback = recordSource === "fallback";
  const recordNotice = generationRecordNotice(isFallback);
  const publishable = selected?.validation?.valid === true;
  const impactDetails = useMemo(
    () => {
      const normalized = normalizeImpactReport(
        job?.parameterImpactReport ||
        job?.impactReport ||
        job?.impacts ||
        job?.impactPreview ||
        job?.configPreview?.impacts,
      );
      return normalized.diagnosticProxies.length || !job?.diagnosticProxies?.length
        ? normalized
        : { ...normalized, diagnosticProxies: job.diagnosticProxies };
    },
    [job],
  );
  const impacts = impactDetails.traces;
  const hasImpactReport = impacts.length > 0
    || impactDetails.behaviorInstructions.length > 0
    || impactDetails.formulaResults.length > 0
    || impactDetails.diagnosticProxies.length > 0
    || impactDetails.channels.length > 0
    || impactDetails.warnings.length > 0;
  const selectedValidationReadiness = useMemo(
    () => selected ? resolveValidationReadinessHeuristic(selected.validationHeuristic, selected.score) : null,
    [selected],
  );
  const selectedDiagnosticProxyViews = useMemo(
    () => selected?.diagnostics
      ?.filter((diagnostic) => isDiagnosticProxyFormulaId(diagnostic.formulaId))
      .map(resolveDiagnosticProxyView) || [],
    [selected],
  );
  const ordinaryDiagnostics = useMemo(
    () => ordinaryDiagnosticsForDisplay(selected, isFallback),
    [selected, isFallback],
  );
  const readerStateViews = useMemo(
    () => selected ? readerStates(selected).map(resolveReaderStateView) : [],
    [selected],
  );
  const productionView = useMemo(
    () => selected ? resolveProductionArtifactView(selected) : null,
    [selected],
  );
  const opportunitySelectionView = useMemo(
    () => resolveOpportunitySelectionAuditView(
      job?.opportunitySelectionAudit
      || job?.opportunitySnapshot?.opportunitySelectionAudit
      || selected?.orchestrationSnapshot?.opportunitySelectionAudit,
    ),
    [job, selected],
  );
  const coverageLedger = selected?.gapCoverageLedger;
  const ledgerCompleteness = coverageLedger
    ? coverageLedger.ledgerCompleteness ?? coverageLedger.closureRate
    : null;
  const realizedResolvedRate = coverageLedger?.realizationStatus === "evaluated"
    ? coverageLedger.realizedResolvedRate ?? coverageLedger.resolvedRate
    : coverageLedger?.realizedResolvedRate != null
      ? coverageLedger.realizedResolvedRate
      : null;

  const copyContent = async () => {
    if (!selected) return;
    if (!publishable) {
      toast.push("该候选未通过事实、证据或闭合校验，暂不能复制发布");
      return;
    }
    await navigator.clipboard.writeText(candidateToMarkdown(selected));
    toast.push("完整内容已复制");
  };

  const handleRevise = async () => {
    if (!job || !selected || !revision.trim()) return;
    setRevising(true);
    try {
      const next = await api.generations.revise(job.id, selected.id, revision);
      setJob(next);
      toast.push("已只重新生成受影响的部分");
    } catch {
      setJob((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates?.map((candidate) =>
                candidate.id === selected.id
                  ? {
                      ...candidate,
                      body: `${candidate.body}\n\n【修改说明】${revision.trim()}`,
                    }
                  : candidate,
              ),
            }
          : current,
      );
      toast.push("演示模式：修改说明已记录", "info");
    } finally {
      setRevision("");
      setRevising(false);
    }
  };

  if (loading)
    return (
      <div className="generation-loading">
        <span className="generation-loading__orb">
          <Sparkles size={25} />
        </span>
        <h2>正在读取内容包…</h2>
        <p>我们会同时还原公式、知识和配置快照</p>
      </div>
    );
  if (!job)
    return (
      <EmptyState
        title="未找到这次生成"
        description="记录可能已被删除，或你没有访问权限。"
        action={<Button onClick={() => navigate("/history")}>返回历史</Button>}
      />
    );
  if (job.status === "queued" || job.status === "running")
    return <GenerationRunning job={job} />;
  if (job.status === "failed")
    return (
      <EmptyState
        icon={<TriangleAlert size={25} />}
        title="本次生成没有完成"
        description={job.error || "模型请求或内容验证失败。"}
        action={
          <Button
            onClick={() => navigate("/generate")}
            icon={<RefreshCcw size={16} />}
          >
            重新设置
          </Button>
        }
      />
    );
  if (!selected)
    return (
      <EmptyState
        title="暂无候选内容"
        description="任务已完成，但没有可用的内容包。"
      />
    );

  return (
    <div className="page result-page">
      <Link to="/history" className="v2-back-link">
        <ArrowLeft size={15} /> 返回历史
      </Link>
      <V2Hero
        status={<>{job.projectName} · {job.mode === "simple" ? "简单模式" : "设置模式"} · {formatDate(job.completedAt, true)} · 选题方向:{job.topic}</>}
        title={selected.title}
        actions={
          <>
            {job.qualityStatus === "needs_review" && (
              <Badge tone="warning">
                <TriangleAlert size={13} /> 本次没有候选通过质量门禁
              </Badge>
            )}
            {!publishable && (
              <Badge tone="danger">
                <TriangleAlert size={13} /> 未通过校验，禁止复制与导出
              </Badge>
            )}
            <Button
              variant="secondary"
              icon={<Clipboard size={16} />}
              onClick={copyContent}
              disabled={!publishable}
            >
              复制全部
            </Button>
            <div className="export-menu">
              <Button icon={<Download size={16} />} disabled={!publishable}>
                导出 <ChevronDown size={14} />
              </Button>
              <div className="export-menu__dropdown">
                <button type="button" disabled={!publishable} onClick={() => window.location.assign(api.generations.exportUrl(job.id, selected.id, "markdown"))}>
                  <FileText size={16} />
                  Markdown
                </button>
                <button type="button" disabled={!publishable} onClick={() => window.location.assign(api.generations.exportUrl(job.id, selected.id, "json"))}>
                  <FileJson size={16} />
                  JSON
                </button>
                <button type="button" disabled={!publishable} onClick={() => window.location.assign(api.generations.exportUrl(job.id, selected.id, "docx"))}>
                  <FileText size={16} />
                  DOCX
                </button>
                <button type="button" disabled={!publishable} onClick={() => window.location.assign(api.generations.exportUrl(job.id, selected.id, "pdf"))}>
                  <FileText size={16} />
                  PDF
                </button>
            </div>
          </div>
          </>
        }
      />

      {!publishable && selected.validation && (
        <ValidationSummaryCard candidate={selected} />
      )}

      {job.qualityStatus === "needs_review" && (
        <div className="generation-fallback-notice" role="status">
          <TriangleAlert size={18} />
          <div>
            <strong>没有候选通过自动校验，可以怎么用</strong>
            <p>请逐条查看下方「校验与一般诊断」中的问题项：若是事实或身份类错误，建议调整知识口径或设置后重新生成；若只是形态提醒，可人工复核候选后酌情使用。未通过校验的候选不能导出，这是系统保留的底线。</p>
          </div>
        </div>
      )}

      {recordNotice.isFallback && <div className="generation-fallback-notice" role="status">
        <TriangleAlert size={18} />
        <div><strong>{recordNotice.label}</strong><p>{recordNotice.detail}</p></div>
      </div>}

      {recordSource === "server" && job.releaseManifestId && <section className="generation-release-proof">
        <PackageCheck size={19} />
        <div>
          <strong>本次生成已冻结运行版本：{job.researchSnapshot?.version || job.releaseManifestId}</strong>
          <p>
            提示合同 v{job.researchSnapshot?.promptVersion || "—"} · 参数策略 v{job.researchSnapshot?.parameterPolicyVersion || "—"} ·
            研究文字{job.researchSnapshot?.researchInjectedIntoPrompt === false ? "未自动注入提示词" : "注入状态未记录"}。
          </p>
        </div>
        <Link to="/research">查看证据与发布清单</Link>
      </section>}

      <section className="candidate-compare">
        <header>
          <div>
            <h2>3 个候选版本</h2>
            <p>随机种子 {job.seed || "—"} · 内容可复现</p>
          </div>
          <Badge tone={recordNotice.isFallback ? "warning" : "neutral"}>
            {recordNotice.isFallback ? <TriangleAlert size={13} /> : <Check size={13} />}
            {recordNotice.label}
          </Badge>
        </header>
        <div className="candidate-grid">
          {job.candidates?.map((candidate, index) => {
            const readiness = resolveValidationReadinessHeuristic(candidate.validationHeuristic, candidate.score);
            return <button
              type="button"
              key={candidate.id}
              className={`candidate-card ${candidate.id === selected.id ? "selected" : ""}`}
              onClick={() => setSelectedId(candidate.id)}
            >
              <div className="candidate-card__top">
                <span>0{index + 1}</span>
                <Badge tone={index === 0 ? "purple" : "neutral"}>
                  {candidate.label || "随机候选"}
                </Badge>
                {candidate.id === selected.id && (
                  <i>
                    <Check size={13} />
                  </i>
                )}
              </div>
              <h3>{candidate.title}</h3>
              <p>{candidate.body.replace(/\n/g, " ").slice(0, 92)}…</p>
              <footer>
                <span>
                  <MessageCircleMore size={14} />
                  {candidate.comments.length} 组问答
                </span>
                <span className="candidate-card__score">
                  <strong>{readiness.value ?? "unknown"}</strong> 校验问题启发式（非质量分）
                </span>
              </footer>
            </button>;
          })}
        </div>
        <details className="candidate-matrix-fold">
          <summary>对比 3 个候选 <ChevronDown size={14} /></summary>
        <div className="candidate-matrix">
          <div className="candidate-matrix__row candidate-matrix__head"><span>对照维度</span>{job.candidates?.map((candidate, index) => <strong key={candidate.id}>候选 0{index + 1}</strong>)}</div>
          <div className="candidate-matrix__row"><span>完整表达结构</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.orchestrationSnapshot?.strategy?.label || candidate.orchestrationSnapshot?.strategyName || candidate.label || "基础结构"}</b>)}</div>
          <div className="candidate-matrix__row"><span>图片计划职责</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.imagePlan?.role ? `${imageRoleLabel(candidate.imagePlan.role)}(${candidate.imagePlan.role})` : candidate.orchestrationSnapshot?.strategy?.imageRole || "未生成图片计划"}</b>)}</div>
          <div className="candidate-matrix__row"><span>标题长度</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.title.length} 字</b>)}</div>
          <div className="candidate-matrix__row"><span>正文长度</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.body.length} 字</b>)}</div>
          <div className="candidate-matrix__row"><span>信息补全</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.comments.length} 组问答</b>)}</div>
          <div className="candidate-matrix__row"><span>标签数量</span>{job.candidates?.map((candidate) => <b key={candidate.id}>{candidate.tags.length} 个</b>)}</div>
          <div className="candidate-matrix__row"><span>校验问题启发式（非质量分）</span>{job.candidates?.map((candidate) => { const readiness = resolveValidationReadinessHeuristic(candidate.validationHeuristic, candidate.score); return <b key={candidate.id} className="candidate-matrix__score">{readiness.value ?? "unknown"}</b>; })}</div>
        </div>
        </details>
      </section>

      <section className="package-formula-banner" aria-label="完整内容包公式">
        <div><span>H</span><strong>标签入口</strong><small>主题与语义标记 · 非触达证明</small></div>
        <i>+</i>
        <div><span>N</span><strong>图文叙事</strong><small>源素材观察 · 图片计划/简报 · 标题 · 正文</small></div>
        <i>+</i>
        <div><span>Cref</span><strong>评论参考</strong><small>状态问题与残余缺口</small></div>
        <i>+</i>
        <div><span>aC</span><strong>执行方案</strong><small>身份 · 路由 · 停止规则</small></div>
      </section>

      <div className="result-layout">
        <article className="content-package">
          <div className="package-section package-section--title">
            <div className="package-section__label">
              <span>01</span>
              <strong>N · 标题</strong>
              <Badge tone="blue">搜索入口</Badge>
            </div>
            <h2>{selected.title}</h2>
            <button
              type="button"
              className="copy-mini"
              onClick={() =>
                navigator.clipboard
                  .writeText(selected.title)
                  .then(() => toast.push("标题已复制"))
              }
            >
              <Clipboard size={14} />
              复制
            </button>
          </div>
          <div className="package-section">
            <div className="package-section__label">
              <span>02</span>
              <strong>N · 正文</strong>
              <Badge tone="neutral">{selected.body.length} 字</Badge>
            </div>
            <div className="article-body">
              {selected.body
                .split("\n")
                .map((paragraph, index) =>
                  paragraph ? (
                    <p key={index}>{paragraph}</p>
                  ) : (
                    <br key={index} />
                  ),
                )}
            </div>
          </div>
          <div className="package-section">
            <div className="package-section__label">
              <span>03</span>
              <strong>H · 标签入口</strong>
              <Badge tone="neutral">主题标记 · 不保证触达</Badge>
            </div>
            <div className="tag-list">
              {selected.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <div className="tag-reach-boundary"><Info size={14} /><span>这些标签来自内容主题和入口规划，不证明进入小红书热点榜或热议话题，也不保证曝光、推荐、点击或合格触达。</span></div>
          </div>
          <div className="package-section">
            <div className="package-section__label">
              <span>04</span>
              <strong>Cref · 评论区信息补全</strong>
              <Badge tone="purple">参考范式</Badge>
            </div>
            <div className="scenario-simulation-banner">
              <Badge tone="warning">模拟情景 · 非真实评论</Badge>
              <div><strong>以下角色是潜在读者视角演练，回答只能由可追责身份发布。</strong><p>{selected.commentDisclaimer || "不代表真实用户发言、消费经历或第三方口碑。"}</p></div>
            </div>
            {readerStateViews.length > 0 && (
              <div className="reader-state-strip">
                {readerStateViews.map((state, index) => (
                  <article key={`${state.stage}-${state.entry}-${index}`}>
                    <div className="reader-state-strip__header">
                      <Badge tone={state.kind === "scenario" ? "blue" : "warning"}>
                        {state.kind === "scenario" ? `编排情景假设 ${index + 1}` : `历史兼容情景 ${index + 1}`}
                      </Badge>
                      <strong>{state.stage} · {state.entry}</strong>
                    </div>
                    <p className="reader-state-strip__notice">{state.notice}</p>
                    {state.details.length > 0 && (
                      <dl className="reader-state-details">
                        {state.details.map((detail) => (
                          <div key={detail.id}>
                            <dt>{detail.label}</dt>
                            <dd>{detail.value}</dd>
                            <small>{detail.explanation}</small>
                          </div>
                        ))}
                      </dl>
                    )}
                    {state.hypotheses.length > 0 && (
                      <div className="reader-state-hypotheses">
                        {state.hypotheses.map((hypothesis) => (
                          <section key={hypothesis.id}>
                            <span>{hypothesis.label}</span>
                            <strong>{hypothesis.level}</strong>
                            <small>启发式区间 {hypothesis.range} · calibrated=false（未标定）</small>
                            <p>{hypothesis.basis}</p>
                          </section>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
            {selected.commentOwnedFirstComment && (
              <div className="comment-thread">
                <div className="comment-meta">
                  <Badge tone="positive">可发布首评参考</Badge>
                  <Badge tone="blue">由发布账号身份发布</Badge>
                </div>
                <div className="comment-answer">
                  <span className="comment-avatar comment-avatar--answer">首</span>
                  <p>{selected.commentOwnedFirstComment}</p>
                </div>
              </div>
            )}
            {selected.commentUncoveredGaps && (
              <div className="tag-reach-boundary">
                <Info size={14} />
                <span>
                  本篇未展开缺口（规划期投影，非遗漏错误）：
                  {uncoveredGapLabels(selected.commentUncoveredGaps, selected.orchestrationSnapshot?.gapPlanningCards).join("、") || "无；所有选中缺口已由评论线程或正文承担。"}
                </span>
              </div>
            )}
            <div className="comment-threads">
              {selected.comments.map((comment, index) => {
                // 读者互动层:T1 机构问答(缺省)/ T2 读者互聊 / T3 漂浮短反应;
                // 历史包没有 threadKind,归一化为 T1 渲染,不出错。
                const threadKind = commentThreadKindOf(comment);
                return (
                <div
                  className="comment-thread"
                  key={`${comment.question}-${index}`}
                >
                  <div className="comment-question">
                    <span className="comment-avatar">评</span>
                    <div>
                      <div className="comment-meta">{comment.displayName && <Badge tone="blue">{comment.displayName}</Badge>}{comment.simulated && <Badge tone="warning">{comment.simulationLabel || "模拟潜在读者"}</Badge>}{comment.postingIdentity && threadKind === "org_answer" && (() => { const badge = orgAnswerIdentityBadge(comment.postingIdentity); return <Badge tone={badge?.tone ?? "positive"}>{badge?.text ?? `${identityLabel(comment.postingIdentity)}可追责答复`}</Badge>; })()}</div>
                      <strong>{comment.question}</strong>
                      {comment.purpose && (
                        <small className="comment-purpose">信息任务：{comment.purpose}</small>
                      )}
                    </div>
                  </div>
                  {(comment.surfaceRoleCard || comment.roleCard || comment.densityProxy || comment.replyPlan || comment.discoveryPlan || comment.conversationPlan || comment.threadKind || comment.kind || comment.personaRole || comment.speakerType || comment.stage || comment.function || comment.claimStatus || comment.answerKind) && <details className="comment-density-details">
                    <summary>读者设定与生成依据（审计用） <ChevronDown size={13} /></summary>
                    <div>
                      <div className="comment-meta comment-meta--audit">{comment.threadKind && <Badge tone="purple">{commentThreadKindLabel(comment.threadKind)}</Badge>}{comment.kind && <Badge>{commentNodeKindLabel(comment.kind)}</Badge>}{comment.personaRole && <Badge>{personaRoleLabel(comment.personaRole)}</Badge>}{comment.speakerType && <Badge>{speakerTypeLabel(comment.speakerType)}</Badge>}{comment.stage && <Badge>{comment.stage}</Badge>}{comment.function && <Badge tone="purple">{commentFunctionLabel(comment.function)}</Badge>}{comment.claimStatus && <Badge tone={comment.claimStatus === "verified" ? "positive" : comment.claimStatus === "unknown" ? "warning" : "blue"}>{claimStatusLabel(comment.claimStatus)}</Badge>}{comment.answerKind && <><small className="comment-meta__label">答复类型</small><Badge tone="positive">{commentNodeKindLabel(comment.answerKind)}</Badge></>}</div>
                      {comment.surfaceRoleCard && <>
                        <p><strong>可见人物</strong>：{comment.surfaceRoleCard.displayRole} · {comment.surfaceRoleCard.relationToHost}</p>
                        <p><strong>身份与处境线索</strong>：{comment.surfaceRoleCard.identityCue}；{comment.surfaceRoleCard.situationCue}</p>
                        <p><strong>说话方式</strong>：{comment.surfaceRoleCard.speechPattern} · 目标 {comment.surfaceRoleCard.targetChars[0]}—{comment.surfaceRoleCard.targetChars[1]} 字</p>
                        <p><strong>可选语域线索</strong>：{comment.surfaceRoleCard.lexicalCues?.join(" / ") || "普通口语"}；一人最多自然使用一处，不要求照抄。</p>
                        <p><strong>接话钩子</strong>：{comment.surfaceRoleCard.interactionHook || "按上一句里的具体细节自然接话"}</p>
                        <p><strong>知情边界</strong>：{comment.surfaceRoleCard.knowledgePosition}</p>
                      </>}
                      {comment.roleCard && <>
                        <p><strong>后台决策状态</strong>：{comment.roleCard.stage} · {evidenceStanceLabel(comment.roleCard.evidenceStance)}</p>
                        <p><strong>已有知识</strong>：{comment.roleCard.knowledge.join("；") || "未标注"}</p>
                        <p><strong>现实约束</strong>：{comment.roleCard.constraints.join("；") || "无额外约束"}</p>
                        <p><strong>决策任务</strong>：{comment.roleCard.decisionTask}</p>
                      </>}
                      {comment.densityProxy && <p><strong>密度结构</strong>：1个主缺口＋{comment.densityProxy.auxiliaryDimensionCount}个辅助维度，{comment.densityProxy.constraintCount}个现实约束；约{comment.densityProxy.questionTargetChars}字是软目标，不是质量分。</p>}
                      {comment.replyPlan && <p><strong>后台答复库存</strong>：直接回答、条件、边界、未知、下一问按当前人物关系择需使用；不要求每条全部展开。</p>}
                      {comment.discoveryPlan && <div className="comment-discovery-path">
                        <p><strong>发现路径</strong>：线索 → 一步推断 → 同线程揭示 → 自我核验 → 反例边界</p>
                        <p><strong>线索</strong>：{comment.discoveryPlan.cue}</p>
                        <p><strong>容易完成的判断</strong>：{comment.discoveryPlan.inferencePrompt}</p>
                        <p><strong>及时揭示</strong>：{comment.discoveryPlan.reveal}</p>
                        <p><strong>自检</strong>：{comment.discoveryPlan.selfCheck}</p>
                        <p><strong>边界</strong>：{comment.discoveryPlan.boundary} · 难度 {comment.discoveryPlan.difficulty === "low" ? "低" : "中等"}</p>
                      </div>}
                      {comment.conversationPlan && <div className="comment-discovery-path">
                        <p><strong>对话拓扑</strong>：{conversationTopologyLabel(comment.conversationPlan.topology)} · 目标接话 {comment.conversationPlan.targetFollowUps} 轮</p>
                        <p><strong>开口</strong>：{comment.conversationPlan.openingMove}</p>
                        <p><strong>回复</strong>：{comment.conversationPlan.replyMove}</p>
                        <p><strong>延展</strong>：{comment.conversationPlan.extensionMove}</p>
                      </div>}
                    </div>
                  </details>}
                  {threadKind !== "organic_reaction" && <div className="comment-answer">
                    <span className="comment-avatar comment-avatar--answer">
                      {threadKind === "reader_exchange" ? "聊" : "回"}
                    </span>
                    <div>
                      {threadKind === "reader_exchange" ? (
                        <div className="comment-meta">{comment.replyDisplayName && <Badge tone="blue">{comment.replyDisplayName}</Badge>}<Badge tone="purple">读者互聊{comment.displayName && comment.replyDisplayName ? ` · ${comment.displayName} → ${comment.replyDisplayName}` : ""}</Badge></div>
                      ) : (
                        replyOrgDisplayName(comment) && <div className="comment-meta"><Badge tone="positive">{replyOrgDisplayName(comment)}</Badge></div>
                      )}
                      <p>{primaryCommentAnswer(comment)}</p>
                    </div>
                  </div>}
                  {threadKind !== "organic_reaction" && comment.boundary && <div className="comment-next-step"><Info size={14} /><span>答复边界：{comment.boundary}</span></div>}
                  {threadKind !== "organic_reaction" && comment.evidenceIds?.length ? <div className="comment-next-step"><Info size={14} /><span>证据引用：{comment.evidenceIds.join("、")}</span></div> : null}
                  {comment.followUps?.map((followUp, followUpIndex) => (
                    <div className="comment-follow-up" key={`${followUp.question}-${followUpIndex}`}>
                      {followUp.threadDepth !== undefined && <div className="comment-meta"><Badge>第 {followUp.threadDepth} 层</Badge></div>}
                      <strong>{followUp.displayName ? `${followUp.displayName} · 接话：` : "接话："}{followUp.question}</strong>
                      <p>{followUp.answer}</p>
                      {followUp.boundary && <p>边界：{followUp.boundary}</p>}
                      {followUp.evidenceIds?.length ? <p>证据引用：{followUp.evidenceIds.join("、")}</p> : null}
                      {(followUp.kind || followUp.personaRole || followUp.claimStatus) && <div className="comment-meta comment-meta--audit">{followUp.kind && <Badge>{commentNodeKindLabel(followUp.kind)}</Badge>}{followUp.personaRole && <Badge>{personaRoleLabel(followUp.personaRole)}</Badge>}{followUp.claimStatus && <Badge tone="blue">{claimStatusLabel(followUp.claimStatus)}</Badge>}</div>}
                    </div>
                  ))}
                  {threadKind !== "organic_reaction" && comment.nextStep && <div className="comment-next-step"><ChevronDown size={14} /><span>下一步：{comment.nextStep}</span></div>}
                </div>
                );
              })}
            </div>
            {coverageLedger && <details className="comment-coverage-ledger">
              <summary>查看正文＋评论的信息闭合台账 <Badge>{Math.round((ledgerCompleteness ?? 0) * 100)}% 台账完整</Badge><ChevronDown size={14} /></summary>
              <div className="comment-coverage-summary">
                <article><small>台账完整度</small><strong>{Math.round((ledgerCompleteness ?? 0) * 100)}%</strong><p>只表示每个选中缺口都有归档行，不代表内容已经解决。</p></article>
                <article><small>最终实际解决率</small><strong>{realizedResolvedRate == null ? "待评估" : `${Math.round(realizedResolvedRate * 100)}%`}</strong><p>{realizedResolvedRate == null ? "最终正文与评论尚未完成实现核验，不能用规划值代替。" : "只计算最终可见正文或正确评论主线程中完整实现的缺口。"}</p></article>
                <article><small>线程目标 / 实际</small><strong>{coverageLedger.targetThreadCount} / {coverageLedger.effectiveThreadCount}</strong><p>目标只控制可读性，不能截断必要信息。</p></article>
              </div>
              {coverageLedger.capacityWarning && <div className="comment-capacity-warning">{coverageLedger.capacityWarning}</div>}
              <div className="comment-coverage-entries">{coverageLedger.entries.map((entry) => <article key={entry.gapId}>
                <div><strong>{entry.label}</strong><Badge tone={entry.status === "body_resolved" || entry.status === "thread_resolved" ? "positive" : entry.status === "explicitly_deferred" || entry.status === "planned_for_body" || entry.status === "planned_for_thread" ? "neutral" : "warning"}>{coverageStatusLabel(entry.status)}</Badge>{entry.required && <Badge tone="warning">必要缺口</Badge>}</div>
                <p>{entry.reason}</p>
                {entry.plannedPlacements?.length ? <small>计划位置：{entry.plannedPlacements.map(channelLabel).join(" / ")}</small> : null}
                {entry.actualRealizations?.map((realization, index) => <small key={`${realization.channel}-${realization.threadId || index}`}>实际核验：{channelLabel(realization.channel)}{realization.threadId ? ` · 线程 ${realization.threadId}` : ""} · {realization.resolved ? "完整实现" : `缺少${realization.missing.map(realizationMissingLabel).join("、") || "必要信息"}`}</small>)}
                {entry.requiredInput && <small>还需用户补充：{entry.requiredInput}</small>}
                {entry.verificationPath && <small>核验路径：{entry.verificationPath}</small>}
              </article>)}</div>
            </details>}
            {selected.dialogueThreads?.length ? (
              <details className="dialogue-plan-details">
                <summary>查看评论线程的结构与证据边界 <Badge>{selected.dialogueThreads.length} 条</Badge><ChevronDown size={14} /></summary>
                <div>{selected.dialogueThreads.map((thread) => <article key={thread.id}><div className="comment-meta">{thread.simulated && <Badge tone="warning">{thread.simulationLabel || "模拟情景"}</Badge>}{thread.personaRole && <Badge>{personaRoleLabel(thread.personaRole)}</Badge>}{thread.claimStatus && <Badge tone="blue">{claimStatusLabel(thread.claimStatus)}</Badge>}</div><strong>{thread.questionIntent || thread.gapId || thread.id}</strong><p>{thread.answerRequirements?.join("；") || "按真实提问补全信息"}</p><small>{thread.stage || "阶段未标注"} · {speakerTypeLabel(thread.speakerType)}提问 · {identityLabel(thread.postingIdentity)}可追责答复 · 证据 {thread.evidenceIds?.length || 0} 项{thread.boundaryRequired ? " · 必须说明边界" : ""}</small>{thread.nextStep && <span>下一步：{thread.nextStep}</span>}</article>)}</div>
              </details>
            ) : null}
            <div className="reference-notice">
              <Info size={16} />
              <p>
                <strong>这是信息补全参考，不是虚构口碑。</strong>
                <br />
                请只在真实问题出现时回复，不冒充消费者或第三方。
              </p>
            </div>
          </div>
          <div className="package-section">
            <div className="package-section__label">
              <span>05</span>
              <strong>N · 图片生产链</strong>
              <Badge tone="blue">分层记录</Badge>
            </div>
            <div className="image-brief">
              <span>
                <Image size={22} />
              </span>
              <div>
                <strong>{selected.imagePlan?.role ? `图片计划职责：${imageRoleLabel(selected.imagePlan.role)}` : "图片计划 / imageBrief 文字草稿"}</strong>
                <p>{selected.imagePlan?.composition || selected.imagePlan?.summary || selected.imageBrief || "本次未生成图片计划或文字简报。"}</p>
                {(selected.imagePlan?.sourceAssetId || selected.imagePlan?.primaryAssetId) && <small>计划参考源素材：{selected.imagePlan?.sourceAssetId || selected.imagePlan?.primaryAssetId}</small>}
                {selected.imagePlan?.coverText && <small>封面文字：{selected.imagePlan.coverText}</small>}
              </div>
            </div>
            {selected.imagePlan?.frames?.length ? <ol className="image-frame-list">{selected.imagePlan.frames.map((frame, index) => <li key={`${frame}-${index}`}><span>{index + 1}</span>{frame}</li>)}</ol> : null}
            {selected.imagePlan?.items?.length ? <div className="image-storyboard">{selected.imagePlan.items.map((item, index) => <article key={`${item.assetId || item.role}-${index}`}><span>{item.position}</span><div><strong>{imageRoleLabel(item.role)}</strong><p>{item.informationTask}</p>{item.overlayText && <small>画面文字：{item.overlayText}</small>}</div></article>)}</div> : null}
            {selected.imagePlan?.boundaries?.length ? <div className="image-boundaries"><TriangleAlert size={15} /><span>图片边界：{selected.imagePlan.boundaries.join("；")}</span></div> : null}
            {productionView && <details className="production-fold">
              <summary>产物状态账本 <Badge tone={productionView.recorded ? "positive" : "warning"}>{productionView.recorded ? "productionArtifacts 已记录" : "历史包 · 保守回退"}</Badge><ChevronDown size={14} /></summary>
              <div className="production-artifact-ledger">
              <header><div><strong>产物状态账本</strong><p>观察、计划、文字简报、最终资产、入口截图和部署是六个不同阶段；前一阶段存在不代表后一阶段完成。</p></div><Badge tone={productionView.recorded ? "positive" : "warning"}>{productionView.recorded ? "productionArtifacts 已记录" : "历史包 · 保守回退"}</Badge></header>
              <div className="production-stage-grid">{productionView.stages.map((stage) => <article key={stage.id} className={`production-stage production-stage--${stage.tone}`}><div><strong>{stage.label}</strong><Badge tone={stage.tone}>{stage.status}</Badge></div><p>{stage.explanation}</p><small>{stage.note}</small>{stage.id === "imagePlan" && productionView.sourceAssetId ? <code>source: {productionView.sourceAssetId}</code> : null}{stage.id === "finalImageAsset" && productionView.finalAssetId ? <code>asset: {productionView.finalAssetId}</code> : null}{stage.id === "entrySnapshot" && productionView.snapshotId ? <code>snapshot: {productionView.snapshotId}</code> : null}</article>)}</div>
              <div className="production-alignment-grid">{productionView.alignments.map((alignment) => <article key={alignment.id}><header><strong>{alignment.label}</strong><Badge tone={alignment.tone}>{alignment.status}</Badge></header><small>{alignment.evaluated ? "evaluated=true · 只评价可用产物之间的语义关系" : "evaluated=false · not_evaluated，不得补写结论"}</small><p>{alignment.reasons.join("；") || "没有返回理由。"}</p>{alignment.checks.length ? <details><summary>查看 {alignment.checks.length} 项检查 <ChevronDown size={13} /></summary><ul>{alignment.checks.map((check) => <li key={check.id}><strong>{check.id} · {check.status}</strong><span>{check.reason}</span>{check.anchors.length ? <small>锚点：{check.anchors.join(" / ")}</small> : null}</li>)}</ul></details> : null}</article>)}</div>
              </div>
            </details>}
          </div>
          {selected.deploymentPlan && (
            <div className="package-section deployment-section">
              <div className="package-section__label"><span>06</span><strong>aC · 评论部署计划</strong><Badge tone="warning">计划 ≠ 已部署</Badge></div>
              <div className="deployment-summary">
                <article><small>发布身份</small><strong>{identityLabel(selected.deploymentPlan.postingIdentity)}</strong></article>
                <article><small>首条自有评论</small><strong>{typeof selected.deploymentPlan.ownedFirstComment === "boolean" ? (selected.deploymentPlan.ownedFirstComment ? "需要" : "不需要") : selected.deploymentPlan.ownedFirstComment || "按实际情况"}</strong></article>
                <article><small>优先置顶</small><strong>{selected.deploymentPlan.pinPriority?.map(commentFunctionLabel).join(" / ") || "根据真实问题"}</strong></article>
                {deploymentSla(selected.deploymentPlan) && <article><small>答复时效</small><strong>{deploymentSla(selected.deploymentPlan)}</strong></article>}
              </div>
              <DeploymentDetails plan={selected.deploymentPlan} />
            </div>
          )}
        </article>

        <aside className="result-sidebar">
          <section className="revision-box">
            <div>
              <span>
                <Sparkles size={17} />
              </span>
              <div>
                <h3>继续调整当前候选</h3>
                <p>只会重新生成受影响的环节</p>
              </div>
            </div>
            <textarea
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              rows={4}
              placeholder="例如：保留标题，让正文更像一个人在分享自己的功课笔记…"
            />
            <Button
              onClick={handleRevise}
              disabled={!revision.trim()}
              loading={revising}
              icon={<Send size={15} />}
            >
              发送修改要求
            </Button>
            <small>修改记录会与新版本一起保存</small>
          </section>
          <section className="result-insight">
            <header>
              <h3>校验与分项检查</h3>
              <Badge tone={selectedValidationReadiness?.state === "current" ? "neutral" : "warning"}>{selectedValidationReadiness?.value ?? "unknown"}</Badge>
            </header>
            <p className="validation-readiness-copy"><strong>{selectedValidationReadiness?.label}</strong>{selectedValidationReadiness?.detail}</p>
            {selectedDiagnosticProxyViews.length > 0 && <details className="sidebar-fold">
              <summary>分项复核清单 {selectedDiagnosticProxyViews.length} 项 · 总分 unknown <ChevronDown size={14} /></summary>
              <div className="candidate-diagnostic-proxies">{selectedDiagnosticProxyViews.map((view, index) => <DiagnosticProxyCard view={view} key={`${view.formulaId}-${index}`} />)}</div>
            </details>}
            {ordinaryDiagnostics.length > 0 && <div className="diagnostic-list">
              {ordinaryDiagnostics.map((item, index) => (
                <div key={`${item.name}-${index}`}>
                  <span
                    className={`diagnostic-status diagnostic-status--${item.status}`}
                  >
                    {item.status === "pass" ? (
                      <CheckCircle2 size={15} />
                    ) : item.status === "unknown" ? (
                      <Info size={15} />
                    ) : (
                      <TriangleAlert size={15} />
                    )}
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    {(item.message || item.explanation) && <small>{item.message || item.explanation}</small>}
                  </span>
                  <b>{diagnosticStatusLabel(item.status)}</b>
                </div>
              ))}
            </div>}
            {selectedDiagnosticProxyViews.length === 0 && ordinaryDiagnostics.length === 0 && <p className="diagnostic-empty">没有可核验的诊断合同；状态保持 unknown，不补 0 分。</p>}
          </section>
          {(selected.orchestrationSnapshot || selected.coverageSignature) && (
            <details className="result-insight orchestration-insight sidebar-fold">
              <summary><h3>本候选的结构指纹</h3><Badge tone="purple">可解释去重</Badge><ChevronDown size={15} /></summary>
              {selected.orchestrationSnapshot && <div className="orchestration-summary">
                <strong>{selected.orchestrationSnapshot.strategy?.label || selected.orchestrationSnapshot.strategyName || "完整表达策略"}</strong>
                <p>{selected.orchestrationSnapshot.rationale?.join("；") || selected.orchestrationSnapshot.structuralDifferences?.join("；") || "本候选按独立的标签、图文与评论结构生成。"}</p>
                <dl>
                  <div><dt>开场</dt><dd>{selected.orchestrationSnapshot.strategy?.openingMode || "—"}</dd></div>
                  <div><dt>叙事</dt><dd>{selected.orchestrationSnapshot.strategy?.narrativeMode || "—"}</dd></div>
                  <div><dt>评论模式</dt><dd>{selected.orchestrationSnapshot.strategy?.commentMode || "—"}</dd></div>
                  <div><dt>选中缺口</dt><dd>{selected.orchestrationSnapshot.selectedGapIds?.length || selected.orchestrationSnapshot.gapIds?.length || 0} 个</dd></div>
                </dl>
                {selected.orchestrationSnapshot.personaScenePlan && <details className="final-gap-placements">
                  <summary>人物 × 现场 × 语言合同 <Badge tone="positive">实际用于生成</Badge><ChevronDown size={13} /></summary>
                  <div>
                    <article><strong>楼主人物</strong><span>{selected.orchestrationSnapshot.personaScenePlan.host.identityCue} · {selected.orchestrationSnapshot.personaScenePlan.host.currentStage}</span><small>{selected.orchestrationSnapshot.personaScenePlan.host.lifeContext}；{selected.orchestrationSnapshot.personaScenePlan.host.immediateConstraint}</small></article>
                    <article><strong>刚发生的事</strong><span>{selected.orchestrationSnapshot.personaScenePlan.event.timeAnchor} · {selected.orchestrationSnapshot.personaScenePlan.event.setting}</span><small>{selected.orchestrationSnapshot.personaScenePlan.event.trigger}；摩擦点：{selected.orchestrationSnapshot.personaScenePlan.event.friction}</small></article>
                    <article><strong>自然语言</strong><span>{selected.orchestrationSnapshot.personaScenePlan.host.voiceTraits.join(" / ")}</span><small>常用语气：{selected.orchestrationSnapshot.personaScenePlan.host.speechMarkers.join("、")}</small></article>
                    <article><strong>样本形态目标</strong><span>标题 {selected.orchestrationSnapshot.personaScenePlan.surfaceTargets.titleChars.join("—")} 字 · 正文 {selected.orchestrationSnapshot.personaScenePlan.surfaceTargets.bodyChars.join("—")} 字</span><small>评论 {selected.orchestrationSnapshot.personaScenePlan.surfaceTargets.visibleCommentLines.join("—")} 行；典型单句 {selected.orchestrationSnapshot.personaScenePlan.surfaceTargets.typicalCommentChars.join("—")} 字</small></article>
                  </div>
                </details>}
                {selected.orchestrationSnapshot.gapPlanningCards?.length ? <details className="final-gap-placements"><summary>最终缺口位置（编排真值） <Badge tone="positive">{selected.orchestrationSnapshot.gapPlanningCards.length} 项</Badge><ChevronDown size={13} /></summary><div>{selected.orchestrationSnapshot.gapPlanningCards.map((card) => <article key={card.gapId}><strong>{card.label}</strong><span>{card.plannedPlacements.map(channelLabel).join(" / ") || "未分配"}</span><small>{card.required ? "必要缺口" : "可选缺口"} · {card.evidenceIds.length} 条证据引用</small></article>)}</div></details> : selected.orchestrationSnapshot.channelAllocation ? <details className="final-gap-placements"><summary>最终通道位置（历史兼容快照） <ChevronDown size={13} /></summary><div>{Object.entries(selected.orchestrationSnapshot.channelAllocation).map(([channel, items]) => <article key={channel}><strong>{channelLabel(channel)}</strong><span>{items.length} 项</span><small>{items.join("；") || "无"}</small></article>)}</div></details> : null}
              </div>}
              {selected.coverageSignature && <details className="coverage-details"><summary>查看覆盖签名 <ChevronDown size={14} /></summary><code>{selected.coverageSignature.fingerprint || selected.coverageSignature.value || "未生成指纹"}</code><p>{selected.coverageSignature.topicKey || "当前选题"} · {selected.coverageSignature.strategyId || "策略未标注"} · {selected.coverageSignature.imageRole || selected.coverageSignature.imageRoles?.join("/") || "图片角色未标注"}</p><small>该签名用于降低近期内容结构重复，不代表平台流量预测。</small></details>}
            </details>
          )}
          <section className="result-insight">
            <button
              type="button"
              className="result-insight__toggle"
              onClick={() => setDetailsOpen((value) => !value)}
            >
              <span>
                <BookOpenTextIcon />
                知识与事实边界
              </span>
              <ChevronDown size={17} className={detailsOpen ? "rotate" : ""} />
            </button>
            {detailsOpen && (
              <div className="insight-details">
                <h4>本次使用的来源</h4>
                {selected.sources?.map((source) => (
                  <div className="source-item" key={source.name}>
                    <FileText size={15} />
                    <span>
                      <strong>{source.name}</strong>
                      <small>{source.detail}</small>
                    </span>
                  </div>
                ))}
                {Boolean(selected.unknowns?.length) && (
                  <>
                    <h4>仍然未知</h4>
                    <ul className="unknown-list">
                      {selected.unknowns?.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}
                {Boolean(selected.conflicts?.length) && (
                  <>
                    <h4>知识冲突</h4>
                    <ul className="conflict-list">
                      {selected.conflicts?.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>

      <section className="result-diagnostics" aria-label="诊断与设置回放">
        <h2 className="result-diagnostics__title">诊断与设置回放</h2>
        <p className="result-diagnostics__hint">以下是本次生成的配置解释与系统诊断,默认收起;展开后内容完整保留。</p>
        <details className="result-fold">
          <summary><Target size={16} /> 选题选择依据 <Badge tone={opportunitySelectionView.rankApplied ? "purple" : "warning"}>{opportunitySelectionView.label}</Badge><ChevronDown size={15} /></summary>
          <div className={`result-opportunity-audit result-opportunity-audit--${opportunitySelectionView.state}`}>
            <header><div><span className="impact-report__icon"><Target size={19} /></span><span><h2>选题选择依据</h2><p>{opportunitySelectionView.detail}</p></span></div><Badge tone={opportunitySelectionView.rankApplied ? "purple" : "warning"}>{opportunitySelectionView.label}</Badge></header>
            {opportunitySelectionView.rankView ? <div className="result-opportunity-rank">
              <div className="result-opportunity-rank__summary"><span><strong>{opportunitySelectionView.rankView.title}</strong><small>固定权重 · 未标定 · 非因果 · 不是 F28</small></span><b>{opportunitySelectionView.rankView.valueLabel}</b><Badge tone={opportunitySelectionView.rankView.sortable ? "positive" : "warning"}>{opportunitySelectionView.rankView.stateLabel}</Badge></div>
              <div className="result-opportunity-rank__components">{opportunitySelectionView.rankView.components.map((component) => <article className={component.unknown ? "is-unknown" : ""} key={component.metric}><span><strong>{component.label}</strong><b>{component.unknown ? "unknown" : component.value}</b></span><small>变换 {component.transformedValue} · 权重 {component.weight} · 贡献 {component.contribution}</small><p>来源：{component.source}</p></article>)}</div>
              {(opportunitySelectionView.rankView.inputSources.length > 0 || opportunitySelectionView.rankView.policy?.length) && <div className="result-opportunity-rank__provenance"><span><strong>输入来源</strong>{opportunitySelectionView.rankView.inputSources.map((item) => <small key={item.label}>{item.label}：{item.source}</small>)}</span><span><strong>本次阈值策略</strong>{opportunitySelectionView.rankView.policy?.map((item) => <small key={item.label}>{item.label}：{item.value}</small>)}</span></div>}
              <footer><span><strong>历史覆盖</strong>{opportunitySelectionView.rankView.recentCoverage.value} · {opportunitySelectionView.rankView.recentCoverage.source}</span><span><strong>unknown</strong>{opportunitySelectionView.rankView.unknownMetrics.join("、") || "无"}</span><span><strong>复核原因</strong>{opportunitySelectionView.rankView.reviewReasons.join("；") || "无"}</span></footer>
            </div> : <div className="result-opportunity-rank__not-applied"><Info size={15} /><span>{opportunitySelectionView.state === "explicit_locked" ? "没有启发式排序分项，因为本次选题由用户显式锁定；缺少分数不是 0 分。" : opportunitySelectionView.state === "default_policy" ? "没有候选集合可供排序；默认策略不是一条隐藏的机会得分。" : opportunitySelectionView.state === "revision_inherited" ? "本次只沿用原选题，没有重新排序；不会复制原排序值冒充本次结果。" : opportunitySelectionView.state === "not_applied" ? "服务端只确认本次未排序，未提供可进一步归因的选择方式。" : "没有可核验的服务端排序快照；历史状态保持 unknown。"}</span></div>}
          </div>
        </details>
        {hasImpactReport && <details className="result-fold">
          <summary><Settings2 size={16} /> 参数影响报告 <Badge tone="purple">{impacts.length ? `${impacts.length} 项参数变化` : "审计快照"}</Badge><ChevronDown size={15} /></summary>
          <div className="impact-report">
            <header><div><span className="impact-report__icon"><Settings2 size={19} /></span><span><h2>参数影响报告</h2><p>说明本次非默认参数实际改变了哪些内容环节；这是配置解释，不是平台效果预测。</p></span></div><Badge tone="purple">{impacts.length ? `${impacts.length} 项参数变化` : "审计快照"}</Badge></header>
            <div className="impact-report__grid">{impacts.map((impact) => <article key={impact.parameterId}><span className={`impact-direction impact-direction--${impact.direction || "changed"}`}>{impact.direction === "higher" ? <ArrowUp size={14} /> : impact.direction === "lower" ? <ArrowDown size={14} /> : <Settings2 size={14} />}</span><div><h3>{impact.label}<b>{isDiagnosticEmphasisParameterId(impact.parameterId) ? `${formatImpactValue(impact.value)}（显示/人工顺序刻度）` : formatImpactValue(impact.value)}</b></h3><p>{impact.summary}</p>{impact.affects?.length ? <small>影响环节：{impact.affects.join(" · ")}</small> : null}{impact.risk && <details><summary>查看边界与风险</summary><p>{impact.risk}</p></details>}</div></article>)}</div>
            {(impactDetails.behaviorInstructions.length > 0 || impactDetails.formulaResults.length > 0 || impactDetails.diagnosticProxies.length > 0 || impactDetails.channels.length > 0 || impactDetails.warnings.length > 0) && <div className="impact-report__details">
              {impactDetails.behaviorInstructions.length > 0 && <details><summary><Sparkles size={14} />最终行为指令 <Badge>{impactDetails.behaviorInstructions.length}</Badge><ChevronDown size={13} /></summary><ul>{impactDetails.behaviorInstructions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></details>}
              {impactDetails.formulaResults.length > 0 && <details><summary><FileJson size={14} />公式计算结果 <Badge>{impactDetails.formulaResults.length}</Badge><ChevronDown size={13} /></summary><div className="impact-formula-results">{impactDetails.formulaResults.map((formula) => <FormulaImpactResult formula={formula} key={formula.formulaId} />)}</div></details>}
              {impactDetails.diagnosticProxies.length > 0 && <details><summary><Info size={14} />分项显示 / 人工复核排序 <Badge tone="warning">{impactDetails.diagnosticProxies.length}</Badge><ChevronDown size={13} /></summary><div className="impact-diagnostic-proxies">{impactDetails.diagnosticProxies.map((proxy, index) => <DiagnosticProxyCard view={resolveDiagnosticProxyView(proxy)} key={`${String((proxy as { formulaId?: unknown }).formulaId || "unknown")}-${index}`} compact />)}</div></details>}
              {impactDetails.channels.length > 0 && <details><summary><Tags size={14} />参数侧通道预览（诊断） <Badge>{impactDetails.channels.length}</Badge><ChevronDown size={13} /></summary><div className="impact-channel-note"><Info size={14} /><span>这里只解释参数对通道的倾向，不是最终分配。最终位置以当前候选的编排快照与“最终缺口位置”为准。</span></div><div className="impact-channel-list">{impactDetails.channels.map((channel) => <article key={channel.id}><strong>{channelLabel(channel.id)}</strong><span>{channel.purpose || "参数建议"}</span><b>{channel.count} 项预览</b>{channel.constraints.length > 0 && <small>{channel.constraints.join(" · ")}</small>}</article>)}</div></details>}
              {impactDetails.warnings.length > 0 && <details className="impact-warning-details"><summary><TriangleAlert size={14} />边界与警告 <Badge tone="warning">{impactDetails.warnings.length}</Badge><ChevronDown size={13} /></summary><ul>{impactDetails.warnings.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></details>}
            </div>}
          </div>
        </details>}
      </section>
    </div>
  );
}

function readerStates(candidate: Candidate) {
  const snapshot = candidate.orchestrationSnapshot;
  if (snapshot?.stateSeed) return [snapshot.stateSeed];
  return snapshot?.readerStates || candidate.comments.flatMap((thread) => thread.readerState ? [thread.readerState] : []);
}

function primaryCommentAnswer(comment: Candidate["comments"][number]) {
  if (!comment.followUps?.length) return comment.answer;
  return comment.answer.split(/\n\n追问：/u)[0] || comment.answer;
}

function identityLabel(value?: string) {
  const labels: Record<string, string> = {
    author: "作者",
    brand: "品牌官方",
    staff: "工作人员",
    expert: "专业人员",
    reader_question_template: "读者提问模板",
    publisher: "发布账号",
  };
  return value ? labels[value] || value : "可追责发布者";
}

/**
 * 答复侧展示名:surfaceRoleCard.replyDisplayRole 原样显示;host_account /
 * assistant_account 这类内部 id 形态按 postingIdentity 显示通用文案
 * (publisher 楼主 / staff 机构助理 / expert 机构 IP),不裸露内部 id;历史包
 * 没有 surfaceRoleCard 时不显示(不出空徽标)。"楼主"是平台语境下"发帖账号"
 * 的事实用语,不表示顾客身份——身份性质由 orgAnswerIdentityBadge 表达。
 */
function replyOrgDisplayName(comment: Candidate["comments"][number]) {
  const raw = comment.surfaceRoleCard?.replyDisplayRole?.trim();
  if (!raw) return undefined;
  if (/^[a-z][a-z0-9_]*$/.test(raw)) {
    return comment.postingIdentity === "staff" ? "机构助理"
      : comment.postingIdentity === "publisher" ? "楼主"
      : "机构 IP";
  }
  return raw;
}

function commentFunctionLabel(value?: string) {
  const labels: Record<string, string> = {
    surface_gap: "提出缺口",
    answer: "直接回答",
    clarify: "澄清条件",
    counterexample: "补充反例",
    verification: "核验路径",
    next_step: "下一步",
    boundary: "适用边界",
  };
  return value ? labels[value] || value : "信息补全";
}

function personaRoleLabel(value?: string) {
  const labels: Record<string, string> = {
    first_time_researcher: "初次做功课",
    information_collector: "信息收集者",
    comparison_decider: "比较决策者",
    risk_concerned: "风险顾虑者",
    local_action_seeker: "本地行动者",
    skeptical_returning_reader: "审慎回访者",
  };
  return value ? labels[value] || value : "潜在读者";
}

function speakerTypeLabel(value?: string) {
  const labels: Record<string, string> = {
    simulated_reader: "模拟读者",
    accountable_responder: "可追责答复者",
  };
  return value ? labels[value] || value : "模拟读者";
}

function claimStatusLabel(value?: string) {
  const labels: Record<string, string> = {
    verified: "有证据支持",
    bounded: "有边界回答",
    unknown: "保留未知",
    hypothetical: "假设情景",
  };
  return value ? labels[value] || value : "声明状态未标注";
}

function evidenceStanceLabel(value?: string) {
  const labels: Record<string, string> = {
    evidence_first: "证据优先",
    verification_seeking: "主动核验",
    boundary_sensitive: "边界敏感",
    unknown_aware: "保留未知",
  };
  return value ? labels[value] || value : "证据态度未标注";
}

function coverageStatusLabel(value?: string) {
  const labels: Record<string, string> = {
    planned_for_body: "计划由正文回答",
    planned_for_thread: "计划由评论回答",
    body_resolved: "正文已回答",
    thread_resolved: "评论已回答",
    realization_failed: "最终实现不完整",
    awaiting_user_input: "等待用户条件",
    unknown_with_verification: "保留未知并可核验",
    explicitly_deferred: "明确延后",
  };
  return value ? labels[value] || value : "未归档";
}

function realizationMissingLabel(value: string) {
  const labels: Record<string, string> = {
    answer: "答案/框架",
    condition_or_boundary: "条件或边界",
    evidence: "证据映射",
    findability: "可找到位置",
  };
  return labels[value] || value;
}

function imageRoleLabel(value?: string) {
  const labels: Record<string, string> = {
    cover: "封面入口",
    evidence: "可见证据",
    scene: "真实场景",
    diagram: "解释图示",
    before_after: "前后对照",
    context: "背景说明",
    process: "过程展示",
    comparison: "条件比较",
    summary: "总结信息卡",
  };
  return value ? labels[value] || value : "图片信息载体";
}

function DeploymentDetails({ plan }: { plan: NonNullable<Candidate["deploymentPlan"]> }) {
  const routingLines = liveRoutingLines(plan.liveRouting);
  return (
    <div className="deployment-details">
      {routingLines.length > 0 && <div><strong>真实评论如何路由</strong><ul>{routingLines.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
      {plan.updatePolicy?.length ? <div><strong>更新政策（新高频问题如何回流）</strong><ul>{plan.updatePolicy.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
      {plan.updateTriggers?.length ? <div><strong>何时更新内容</strong><ul>{plan.updateTriggers.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
      {plan.stopRules?.length ? <div className="deployment-stop"><strong>停止规则</strong><ul>{plan.stopRules.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
    </div>
  );
}

function diagnosticStatusLabel(status: string) {
  return status === "pass" ? "通过" : status === "warn" ? "警告" : status === "fail" ? "未通过" : "unknown";
}

/**
 * 未通过校验时的结论卡,三层结构:
 * 1) 一句话结论 + 行动建议;
 * 2) 按 severity+code 聚合的类别行(中文名 ×N,默认可见,一行一条);
 * 3) 每类的系统原文 message 明细(默认折叠,完全相同条目 ×N 合并,不丢原文)。
 */
function ValidationSummaryCard({ candidate }: { candidate: Candidate }) {
  const issues = candidate.validation?.issues || [];
  const groups = new Map<string, { code?: string; severity: string; messages: Map<string, number> }>();
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.code || ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { code: issue.code, severity: issue.severity, messages: new Map() };
      groups.set(key, group);
    }
    group.messages.set(issue.message, (group.messages.get(issue.message) || 0) + 1);
  }
  const countOf = (group: { messages: Map<string, number> }) =>
    [...group.messages.values()].reduce((total, count) => total + count, 0);
  const sorted = [...groups.values()].sort(
    (a, b) =>
      (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1) ||
      countOf(b) - countOf(a),
  );
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warnCount = issues.length - errorCount;
  return (
    <section className="validation-summary" role="alert">
      <header>
        <TriangleAlert size={18} />
        <div>
          <strong>本候选未通过校验,暂不能复制与导出</strong>
          <p>
            {errorCount > 0 ? `${errorCount} 个必须处理的问题` : ""}
            {errorCount > 0 && warnCount > 0 ? " · " : ""}
            {warnCount > 0 ? `${warnCount} 个复核提醒` : ""}
            。事实类问题建议调整知识口径或设置后重新生成;形态提醒可人工复核后酌情使用。
          </p>
        </div>
      </header>
      <div className="validation-summary__groups">
        {sorted.map((group, index) => {
          const label = validationIssueLabel(group.code);
          const total = countOf(group);
          return (
            <details
              key={`${group.severity}-${group.code || "uncoded"}-${index}`}
              className={`validation-summary__group validation-summary__group--${group.severity === "error" ? "error" : "warning"}`}
            >
              <summary>
                <span className="validation-summary__badge">
                  {group.severity === "error" ? "未通过" : "提醒"}
                </span>
                <strong>{label || "系统校验项"}{group.code ? `(${group.code})` : ""}</strong>
                {total > 1 && <b>×{total}</b>}
                <ChevronDown size={13} />
              </summary>
              <ul>
                {[...group.messages.entries()].map(([message, count], messageIndex) => (
                  <li key={`${messageIndex}`}>
                    {message}
                    {count > 1 ? ` ×${count}` : ""}
                    {!label && group.code ? `(系统原文 · ${group.code})` : ""}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function DiagnosticProxyCard({ view, compact = false }: { view: DiagnosticProxyView; compact?: boolean }) {
  return <article className={`diagnostic-proxy-card diagnostic-proxy-card--${view.contractState}`}>
    <header><span>{view.formulaId}</span><div><strong>{view.name}</strong><small>{view.contractState === "current" ? "ordered_component_review_metadata" : "semantics: unknown"}</small></div><Badge tone="warning">总分 unknown</Badge></header>
    <p>{view.summary}</p>
    <div className="diagnostic-proxy-facts"><span><strong>evaluation</strong><b>{view.evaluationStatus}</b></span><span><strong>evidence</strong><b>{view.evidenceStatus}</b></span><span><strong>scoreProduced</strong><b>false</b></span></div>
    {view.components.length > 0 && <details open={!compact && view.contractState === "current"}><summary>查看 {view.components.length} 个分项 <ChevronDown size={13} /></summary><div className="diagnostic-proxy-components">{view.components.map((component) => <div key={component.id}><span className="diagnostic-proxy-order">{component.displayOrder ?? "?"}</span><span><strong>{component.label}</strong><small>{view.contractState === "current" ? `显示顺序刻度 ${component.emphasis} · 人工复核优先级 ${component.manualReviewRank}` : "历史/自定义分项语义 unknown"}</small></span><b>value unknown</b></div>)}</div></details>}
    <footer><TriangleAlert size={13} /><span>{view.warning}</span></footer>
  </article>;
}

function FormulaImpactResult({ formula }: { formula: NonNullable<GenerationImpactReport["formulaResults"]>[number] }) {
  const isTrendFit = formula.formulaId === "F30";
  const trendSnapshot = isTrendFit
    ? resolveHistoricalTrendFitSnapshot(formula.value, formula.calculatorContract)
    : undefined;
  const contractSnapshot = trendSnapshot?.contractSnapshot;
  const excludedReach = contractSnapshot?.excludedResearchOutputs.find((item) => item.metric === "qualifiedIncrementalReach");
  return <article className={isTrendFit ? "is-trendfit" : ""}>
    <span>{formula.formulaId}</span>
    <div><strong>{formula.title || "公式结果"}<b>{trendSnapshot ? (trendSnapshot.displayValue === null ? "unknown" : formatImpactValue(trendSnapshot.displayValue)) : formatImpactValue(formula.value)}</b></strong>
      <p>{trendSnapshot?.summary || formula.interpretation || "该结果参与配置解释。"}</p>
      {trendSnapshot && <small>{trendSnapshot.detail}</small>}
      {isTrendFit && <small>TrendFit ≠ 触达率 · 标签 ≠ 触达保证{contractSnapshot ? " · 合同结构已识别（当时执行状态 unknown）" : " · 合同 unknown"}</small>}
      {excludedReach && <small>合同声明 qualifiedIncrementalReach：{excludedReach.status} · outputProduced=false</small>}
      {Boolean(formula.unknownPaths?.length) && <small>未知变量：{formula.unknownPaths?.join("、")}</small>}
    </div>
  </article>;
}

function formatImpactValue(value: unknown) {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "—");
}

interface NormalizedImpactDetails {
  traces: ParameterImpact[];
  behaviorInstructions: string[];
  formulaResults: NonNullable<GenerationImpactReport["formulaResults"]>;
  diagnosticProxies: DiagnosticProxySnapshot[];
  channels: Array<{ id: string; purpose?: string; count: number; constraints: string[] }>;
  warnings: string[];
}

function normalizeImpactReport(value: unknown): NormalizedImpactDetails {
  if (Array.isArray(value)) {
    return {
      traces: value.map(normalizeImpactTrace),
      behaviorInstructions: [],
      formulaResults: [],
      diagnosticProxies: [],
      channels: [],
      warnings: [],
    };
  }
  if (!value || typeof value !== "object") {
    return { traces: [], behaviorInstructions: [], formulaResults: [], diagnosticProxies: [], channels: [], warnings: [] };
  }
  const report = value as GenerationImpactReport;
  const traces = Array.isArray(report.parameterTraces)
    ? report.parameterTraces.map((trace) => normalizeImpactTrace({
        parameterId: trace.parameterId,
        label: trace.label,
        value: trace.value,
        summary: trace.behaviorInstructions?.join("；") || trace.evidenceNote || "该参数已参与生成配置。",
        affects: trace.channels,
        risk: trace.evidenceNote,
      }))
    : [];
  const allocationPreview = report.advisoryAllocationPreview ?? report.channelAllocation;
  const channels = allocationPreview && typeof allocationPreview === "object"
    ? Object.entries(allocationPreview).map(([id, channel]) => ({
        id,
        purpose: channel?.purpose,
        count: Array.isArray(channel?.information) ? channel.information.length : 0,
        constraints: Array.isArray(channel?.constraints) ? channel.constraints : [],
      }))
    : [];
  return {
    traces,
    behaviorInstructions: Array.isArray(report.behaviorInstructions) ? report.behaviorInstructions : [],
    formulaResults: Array.isArray(report.formulaResults) ? report.formulaResults : [],
    diagnosticProxies: Array.isArray(report.diagnosticProxies) ? report.diagnosticProxies : [],
    channels,
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
  };
}

function normalizeImpactTrace(value: unknown): ParameterImpact {
  const trace = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    parameterId: String(trace.parameterId || trace.id || trace.path || "parameter"),
    label: String(trace.label || trace.name || trace.path || "参数"),
    value: trace.value,
    direction: trace.direction === "higher" || trace.direction === "lower" || trace.direction === "default" ? trace.direction : "changed",
    summary: String(trace.summary || trace.directive || trace.message || trace.effect || "该参数已参与生成配置。"),
    affects: Array.isArray(trace.affects) ? trace.affects.map(String) : Array.isArray(trace.channels) ? trace.channels.map(String) : undefined,
    risk: typeof trace.risk === "string" ? trace.risk : typeof trace.evidenceNote === "string" ? trace.evidenceNote : undefined,
  };
}

function channelLabel(value: string) {
  const labels: Record<string, string> = { H: "标签", "N.imageBrief": "图片方向", "N.title": "标题", "N.body": "正文", Cref: "评论区" };
  return labels[value] || value;
}

function conversationTopologyLabel(value: string) {
  const labels: Record<string, string> = {
    single_exchange: "单次自然回复",
    two_turn: "两轮接话",
    three_person_branch: "第三人分支",
    reaction_then_reply: "反应后轻回复",
    reader_exchange: "读者互聊",
    organic_reaction: "漂浮短反应",
  };
  return labels[value] || value;
}

function BookOpenTextIcon() {
  return <FileText size={16} />;
}

function GenerationRunning({ job }: { job: GenerationJob }) {
  const steps = [
    "读取项目知识",
    "建立事实与冲突清单",
    "规划信息缺口",
    "并行生成 3 个候选",
    "系统规则校验与修复",
  ];
  const progress = job.progress || 24;
  return (
    <div className="generation-progress-page">
      <Link to="/history">
        <ArrowLeft size={16} />
        返回历史
      </Link>
      <div className="generation-progress-card">
        <div className="generation-progress-card__visual">
          <span className="pulse-ring">
            <Sparkles size={28} />
          </span>
          <span className="orbit orbit--one" />
          <span className="orbit orbit--two" />
        </div>
        <Badge tone="blue">
          <LoaderCircle className="spin" size={13} />
          AGENT 正在运行
        </Badge>
        <h1>{job.topic}</h1>
        <p>已创建任务，可以离开此页，完成后会保留在生成历史中。</p>
        <div className="generation-progress-bar">
          <span style={{ width: `${progress}%` }} />
        </div>
        <strong className="generation-progress-value">{progress}%</strong>
        <div className="generation-step-list">
          {steps.map((step, index) => {
            const threshold = (index + 1) * 20;
            const complete = progress >= threshold;
            const current = progress < threshold && progress >= threshold - 20;
            return (
              <div
                key={step}
                className={complete ? "complete" : current ? "current" : ""}
              >
                <span>
                  {complete ? (
                    <Check size={14} />
                  ) : current ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <p>{step}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
