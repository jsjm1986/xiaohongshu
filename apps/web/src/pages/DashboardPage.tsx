import {
  ArrowRight,
  BookOpenText,
  Boxes,
  CheckCircle2,
  Clock3,
  FileClock,
  FlaskConical,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  PageHeader,
  Skeleton,
} from "../components/Ui";
import { useProjects } from "../components/ProjectContext";
import { api } from "../lib/api";
import { demoGenerations, demoKnowledge } from "../lib/fixtures";
import { formatDate } from "../lib/utils";
import type { GenerationJob, KnowledgeFile } from "../types";

export function DashboardPage() {
  const { currentProject, projectId } = useProjects();
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!projectId) {
      setHistory([]);
      setKnowledge([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all([
      api.generations
        .list(projectId)
        .then((data) => data.items)
        .catch(() =>
          demoGenerations.filter((item) => item.projectId === projectId),
        ),
      api.knowledge
        .list(projectId)
        .then((data) => data.items)
        .catch(() =>
          demoKnowledge.filter((item) => item.projectId === projectId),
        ),
    ])
      .then(([generationItems, knowledgeItems]) => {
        setHistory(generationItems);
        setKnowledge(knowledgeItems);
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  const completed = history.filter((item) => item.status === "completed");
  const validationSummary = useMemo(() => {
    const states = completed.flatMap((job) =>
      job.candidates?.map((candidate) => candidate.validation?.valid) || [],
    );
    const known = states.filter((value): value is boolean => typeof value === "boolean");
    return {
      passed: known.filter(Boolean).length,
      known: known.length,
      unknown: states.length - known.length,
    };
  }, [completed]);
  const hasFormula = Boolean(currentProject?.activeFormulaVersion);
  const readiness = 20 + (knowledge.length > 0 ? 50 : 0) + (hasFormula ? 30 : 0);

  if (!projectId)
    return (
      <div className="page dashboard-page">
        <PageHeader
          eyebrow="WELCOME"
          title="从第一个项目开始"
          description="项目会把知识库、公式版本和生成记录隔离开。"
        />
        <section className="panel">
          <EmptyProject onCreate={() => navigate("/projects")} />
        </section>
      </div>
    );

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="WORKSPACE OVERVIEW"
        title={`上午好，继续完善「${currentProject?.name || "当前项目"}」`}
        description="从项目知识出发，把每一次生成变成可解释、可复用的内容资产。"
        actions={
          <Button
            icon={<Sparkles size={17} />}
            onClick={() => navigate("/generate")}
          >
            开始生成
          </Button>
        }
      />

      <section className="metric-grid">
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--coral">
            <FileClock size={20} />
          </div>
          <div>
            <span>累计生成</span>
            <strong>
              {currentProject?.generationCount ?? history.length}
              <small>次</small>
            </strong>
            <p>
              <TrendingUp size={13} />近 7 天新增 {Math.min(history.length, 12)}{" "}
              次
            </p>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--blue">
            <BookOpenText size={20} />
          </div>
          <div>
            <span>知识文件</span>
            <strong>
              {currentProject?.knowledgeCount ?? knowledge.length}
              <small>份</small>
            </strong>
            <p>
              {knowledge.reduce((sum, item) => sum + item.size, 0) > 1024 * 1024
                ? `${(knowledge.reduce((sum, item) => sum + item.size, 0) / 1024 / 1024).toFixed(1)} MB`
                : "轻量全量注入"}
            </p>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-card__icon metric-card__icon--purple">
            <FlaskConical size={20} />
          </div>
          <div>
            <span>当前公式</span>
            <strong className="metric-card__version">
              {currentProject?.activeFormulaVersion || "尚未启用"}
            </strong>
            <p>
              <CheckCircle2 size={13} />
              已启用·版本锁定
            </p>
          </div>
        </article>
        <article className="metric-card metric-card--quality">
          <div className="metric-card__icon metric-card__icon--green">
            <CheckCircle2 size={20} />
          </div>
          <div>
            <span>候选校验状态</span>
            <strong>
              {validationSummary.known ? `${validationSummary.passed}/${validationSummary.known}` : "unknown"}
              <small>通过/已记录</small>
            </strong>
            <p>{validationSummary.unknown ? `${validationSummary.unknown} 个历史候选没有校验状态` : "只统计明确的通过/未通过，不合成质量分"}</p>
          </div>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel recent-panel">
          <header className="panel__header">
            <div>
              <h2>最近生成</h2>
              <p>当前项目的最新任务</p>
            </div>
            <Link to="/history">
              查看全部 <ArrowRight size={15} />
            </Link>
          </header>
          {loading ? (
            <Skeleton lines={4} />
          ) : (
            <div className="recent-list">
              {history.slice(0, 4).map((job) => (
                <button
                  key={job.id}
                  onClick={() =>
                    job.status === "completed" &&
                    navigate(`/generations/${job.id}`)
                  }
                >
                  <span
                    className={`recent-list__state recent-list__state--${job.status}`}
                  >
                    {job.status === "completed" ? (
                      <CheckCircle2 size={17} />
                    ) : job.status === "failed" ? (
                      <TriangleAlert size={17} />
                    ) : (
                      <Clock3 size={17} />
                    )}
                  </span>
                  <span className="recent-list__main">
                    <strong>{job.topic}</strong>
                    <small>
                      {job.projectName || currentProject?.name} ·{" "}
                      {job.mode === "simple" ? "简单模式" : "设置模式"} ·{" "}
                      {formatDate(job.createdAt, true)}
                    </small>
                  </span>
                  <span className="recent-list__meta">
                    {job.status === "completed" ? (
                      <>
                        <b>{job.candidates?.length || 3}</b> 个候选
                      </>
                    ) : (
                      <Badge tone={job.status === "failed" ? "danger" : "blue"}>
                        {job.status === "failed" ? "失败" : "生成中"}
                      </Badge>
                    )}
                  </span>
                  <ArrowRight size={17} />
                </button>
              ))}
            </div>
          )}
        </article>

        <aside className="panel readiness-panel">
          <header className="panel__header">
            <div>
              <h2>项目准备度</h2>
              <p>生成前的必要条件</p>
            </div>
            <Badge tone={readiness >= 70 ? "positive" : "warning"}>{readiness}%</Badge>
          </header>
          <div className="readiness-score">
            <div className="readiness-score__bar">
              <span style={{ width: `${readiness}%` }} />
            </div>
            <p>{readiness >= 70 ? "已具备生成条件" : "继续补充项目知识与公式"}</p>
          </div>
          <div className="check-list">
            <Link to="/knowledge">
              <span className={`check-list__icon ${knowledge.length ? "check-list__icon--ok" : "check-list__icon--warn"}`}>
                {knowledge.length ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}
              </span>
              <span>
                <strong>项目知识库</strong>
                <small>{knowledge.length} 份文件已就绪</small>
              </span>
              <ArrowRight size={15} />
            </Link>
            <Link to="/formulas">
              <span className={`check-list__icon ${hasFormula ? "check-list__icon--ok" : "check-list__icon--warn"}`}>
                {hasFormula ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}
              </span>
              <span>
                <strong>公式版本</strong>
                <small>
                  {currentProject?.activeFormulaVersion ? `${currentProject.activeFormulaVersion} 正在使用` : "进入公式页启用默认版本"}
                </small>
              </span>
              <ArrowRight size={15} />
            </Link>
            <Link to="/settings">
              <span className="check-list__icon check-list__icon--ok">
                <CheckCircle2 size={17} />
              </span>
              <span>
                <strong>知识注入策略</strong>
                <small>预算内全量，超限后按索引渐进披露</small>
              </span>
              <ArrowRight size={15} />
            </Link>
          </div>
        </aside>
      </section>

      <section className="quick-start">
        <div className="quick-start__icon">
          <Sparkles size={24} />
        </div>
        <div>
          <span>不确定从哪里开始？</span>
          <h2>用简单模式，4 步完成第一篇内容</h2>
          <p>
            只需选项目、写主题、选用户阶段，其余参数会从项目默认值自动补齐。
          </p>
        </div>
        <Button variant="secondary" onClick={() => navigate("/generate")}>
          进入向导 <ArrowRight size={16} />
        </Button>
      </section>
    </div>
  );
}

function EmptyProject({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <Boxes size={24} />
      </div>
      <h3>还没有可用项目</h3>
      <p>创建项目后，就可以导入 Markdown / TXT 知识并生成完整内容包。</p>
      <Button onClick={onCreate}>创建第一个项目</Button>
    </div>
  );
}
