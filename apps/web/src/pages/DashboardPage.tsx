import {
  ArrowRight,
  BookOpenText,
  Boxes,
  CheckCircle2,
  Clock3,
  FileClock,
  FlaskConical,
  RefreshCcw,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
} from "../components/Ui";
import { V2Hero, V2Instrument, V2InstrumentCell } from "../components/V2";
import { useProjects } from "../components/ProjectContext";
import { api } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDate } from "../lib/utils";
import type { GenerationJob, KnowledgeFile } from "../types";

export function DashboardPage() {
  const { currentProject, projectId } = useProjects();
  const [history, setHistory] = useState<GenerationJob[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => {
    if (!projectId) {
      setHistory([]);
      setKnowledge([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    Promise.all([
      api.generations.list(projectId).then((data) => data.items),
      api.knowledge.list(projectId).then((data) => data.items),
    ])
      .then(([generationItems, knowledgeItems]) => {
        setHistory(generationItems);
        setKnowledge(knowledgeItems);
      })
      .catch((error) => setLoadError(errorMessage(error, '项目概览加载失败')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
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

  if (!loading && loadError)
    return (
      <div className="page dashboard-page">
        <V2Hero
          status={<>{currentProject?.name || "当前项目"} · 数据不可用</>}
          title="项目概览暂时无法加载"
          description="系统不会用演示数据替代真实项目记录。"
        />
        <section className="panel">
          <EmptyState icon={<TriangleAlert size={24} />} title="项目数据加载失败" description={loadError} action={<Button variant="secondary" icon={<RefreshCcw size={16} />} onClick={load}>重试</Button>} />
        </section>
      </div>
    );

  return (
    <div className="page dashboard-page">
      <V2Hero
        status={<>{currentProject?.name || "当前项目"} · 系统正常</>}
        title={<>上午好，继续完善「{currentProject?.name || "当前项目"}」</>}
        description="从项目知识出发，把每一次生成变成可解释、可复用的内容资产。"
        actions={
          <>
            <Link className="v2-hero__link" to="/generate">
              进入向导 <ArrowRight size={15} />
            </Link>
            <Button icon={<Sparkles size={17} />} onClick={() => navigate("/generate")}>
              开始生成
            </Button>
          </>
        }
      />

      <V2Instrument>
        <V2InstrumentCell
          tone="brand"
          icon={<FileClock size={15} />}
          label="累计生成"
          value={currentProject?.generationCount ?? history.length}
          unit="次"
          note={<><TrendingUp size={13} /> 近 7 天新增 {Math.min(history.length, 12)} 次</>}
        />
        <V2InstrumentCell
          tone="blue"
          icon={<BookOpenText size={15} />}
          label="知识文件"
          value={currentProject?.knowledgeCount ?? knowledge.length}
          unit="份"
          note={knowledge.reduce((sum, item) => sum + item.size, 0) > 1024 * 1024
            ? `${(knowledge.reduce((sum, item) => sum + item.size, 0) / 1024 / 1024).toFixed(1)} MB`
            : "轻量全量注入"}
        />
        <V2InstrumentCell
          tone="ai"
          icon={<FlaskConical size={15} />}
          label="当前公式"
          value={currentProject?.activeFormulaVersion || "尚未启用"}
          mono
          note={<><CheckCircle2 size={13} /> 已启用·版本锁定</>}
        />
        <V2InstrumentCell
          tone="ok"
          icon={<CheckCircle2 size={15} />}
          label="候选校验状态"
          value={validationSummary.known ? `${validationSummary.passed}/${validationSummary.known}` : "unknown"}
          unit="通过/已记录"
          note={validationSummary.unknown ? `${validationSummary.unknown} 个历史候选没有校验状态` : "只统计明确的通过/未通过，不合成质量分"}
        />
      </V2Instrument>

      <section className="v2-dash-grid">
        <article className="panel v2-recent">
          <header className="panel__header">
            <div>
              <h2><span className="v2-sec-label">REC · 02</span>最近生成</h2>
              <p>当前项目的最新任务</p>
            </div>
            <Link to="/history">
              查看全部 <ArrowRight size={15} />
            </Link>
          </header>
          {loading ? (
            <Skeleton lines={4} />
          ) : (
            <table className="v2-lab-table">
              <thead>
                <tr><th>编号</th><th>主题</th><th>模式</th><th>时间</th><th>状态</th></tr>
              </thead>
              <tbody>
                {history.slice(0, 4).map((job, index) => (
                  <tr key={job.id} onClick={() => job.status === "completed" && navigate(`/generations/${job.id}`)} style={{ cursor: job.status === "completed" ? "pointer" : "default" }}>
                    <td className="v2-lab-id">EXP-{String(history.length - index).padStart(3, "0")}</td>
                    <td className="v2-lab-topic">
                      <strong>{job.topic}</strong>
                      <small>{job.projectName || currentProject?.name}</small>
                    </td>
                    <td className="v2-lab-time">{job.mode === "simple" ? "简单" : "设置"}</td>
                    <td className="v2-lab-time">{formatDate(job.createdAt, true)}</td>
                    <td>
                      {job.status === "completed" ? (
                        <span className="v2-lab-state v2-lab-state--ok"><i />完成</span>
                      ) : job.status === "failed" ? (
                        <span className="v2-lab-state v2-lab-state--fail"><i />失败</span>
                      ) : (
                        <span className="v2-lab-state v2-lab-state--run"><i />生成中</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>

        <aside className="panel v2-readiness">
          <header className="panel__header">
            <div>
              <h2><span className="v2-sec-label">SYS · 03</span>项目准备度</h2>
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
