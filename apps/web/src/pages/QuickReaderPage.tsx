import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, useToast } from '../components/Ui';
import { CandidateSwitch } from '../components/quick/CandidateSwitch';
import { NoteAlertBar } from '../components/quick/NoteAlertBar';
import { NoteCard } from '../components/quick/NoteCard';
import { ReaderDetail, type ExportFormat } from '../components/quick/ReaderDetail';
import { WaitCard } from '../components/quick/WaitCard';
import { api } from '../lib/api';
import { clampCandidateIndex } from '../lib/note-view';
import { readerCandidateToMarkdown } from '../lib/publish-copy';
import { readerPath } from '../lib/quick-nav';
import { areaPath, QUICK_HOME_PATH } from '../lib/quick-routes';
import { failureReason } from '../lib/retry-plan';
import { retryJobOnce } from '../lib/single-retry';
import { readerNeighbors } from '../lib/reader-navigation';
import type { GenerationJob, Project, ReaderCandidate, ReaderJob } from '../types';

/**
 * 独立阅读页 /quick/read/:jobId。
 *
 * 原来「查看」是产出列表里的手风琴:同一页展开一块两千多像素高的详情,上下还挂着
 * 别的任务行。读一篇文案要在列表里滚,列表本身也被撑散;而这一屏要同时承载
 * 「第 37 条在排队」和正文全文两种完全不同的阅读姿态。
 *
 * 这里只做一件事:读一篇。顶部是返回原处 + 上一篇/下一篇;下面分两层——预览区
 * (候选切换条 + 校验细条 + NoteCard 仿真笔记)在上,工作区(ReaderDetail:校验全文/
 * 判断依据/发布方案/导出/改稿)在下。
 */
export function QuickReaderPage() {
  const { jobId = '' } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [job, setJob] = useState<ReaderJob | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  /** 同项目的任务列表:只为算上一篇/下一篇与返回目标,不在这页渲染 */
  const [siblings, setSiblings] = useState<GenerationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revisingId, setRevisingId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 候选下标:预览区(NoteCard)与工作区(ReaderDetail)共用,所以归页面持有 */
  const [activeIndex, setActiveIndex] = useState(0);
  /** 「看详情」滚到工作区校验全文 */
  const workbenchRef = useRef<HTMLDivElement | null>(null);

  const fail = (e: unknown, fallback: string) =>
    toast.push(e instanceof Error ? e.message : fallback, 'error');

  const load = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fresh = await api.generations.reader(jobId);
      setJob(fresh);
    } catch (e) {
      // 直接打开一个不存在/无权限的 id 是正常路径(收藏了旧链接),给页面级
      // 说明而不是一个空白页加一条 toast。
      setLoadError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  // 换一篇要回到第一个候选:上一篇选了第 3 版,下一篇可能只有 1 版,
  // 沿用旧下标会让 NoteCard 与工作区读到不同候选(Math.min 各自兜底)。
  useEffect(() => { setActiveIndex(0); }, [jobId]);

  // 项目名与相邻任务:拿到 job 才知道 projectId,所以跟在后面拉。
  // 失败不影响阅读——顶栏少一个项目名和翻页,正文照读。
  useEffect(() => {
    const projectId = job?.projectId;
    if (!projectId) return;
    let cancelled = false;
    void Promise.all([
      api.projects.list().then((res) => res.items.find((p) => p.id === projectId) ?? null).catch(() => null),
      api.generations.list(projectId).then((res) => res.items).catch(() => [] as GenerationJob[]),
    ]).then(([p, list]) => {
      if (cancelled) return;
      setProject(p);
      setSiblings(list);
    });
    return () => { cancelled = true; };
  }, [job?.projectId]);

  // 未完成任务:等待卡要走秒,并按 3s 续拉直到落地
  const inFlight = job?.status === 'queued' || job?.status === 'running';
  useEffect(() => {
    if (!inFlight) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => { void load(); }, 3000);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [inFlight, load]);

  const revise = async (candidate: ReaderCandidate, instruction: string) => {
    setRevisingId(candidate.id);
    try {
      await api.generations.revise(jobId, candidate.id, instruction);
      setJob(await api.generations.reader(jobId));
      toast.push('已按意见修改');
    } catch (e) { fail(e, '修改失败'); } finally { setRevisingId(null); }
  };

  const retry = async () => {
    if (!project || !job) return;
    setRetrying(true);
    try {
      const result = await retryJobOnce({
        project,
        // ReaderJob 是 GenerationJob 的投影;retryJobOnce 只读配方相关字段,
        // 而阅读投影不带 resolvedConfig,所以用列表里的同一条(它带 task 配方)。
        job: siblings.find((j) => j.id === job.id) ?? (job as unknown as GenerationJob),
        deps: { opportunities: api.opportunities, presets: api.presets, generationBatches: api.generationBatches },
      });
      for (const w of result.warnings) toast.push(w, 'info');
      toast.push('已按同款重新提交，消耗 1 次额度');
    } catch (e) { fail(e, '重试失败'); } finally { setRetrying(false); }
  };

  const exportAs = (candidate: ReaderCandidate, format: ExportFormat) => {
    if (format === 'markdown') {
      const blob = new Blob([readerCandidateToMarkdown(candidate)], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${job?.topic || '文案'}-${candidate.candidateIndex + 1}.md`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    window.location.assign(api.generations.exportUrl(jobId, candidate.id, format));
  };

  const neighbors = readerNeighbors(siblings, jobId);

  /**
   * 返回产出区。
   *
   * 直接打开一个阅读链接(收藏/别人发的)时浏览器没有可回退的历史,所以不用
   * history.back(),而是直接进那个项目的产出区地址。四区改成真路由之后这里不再
   * 需要 sessionStorage 记忆——地址本身就是记忆。
   *
   * job 还没拉到(首屏或打不开)时退回卡墙:此时连 projectId 都不知道。
   */
  const backToHistory = () =>
    navigate(job?.projectId ? areaPath(job.projectId, 'history') : QUICK_HOME_PATH);

  return (
    <div className="page qc-reader-page">
      <header className="qc-reader-page__bar">
        <button type="button" className="qc-crumb__back" onClick={backToHistory}>
          <ArrowLeft size={14} />返回产出
        </button>
        <div className="qc-reader-page__title">
          <h1>{job?.topic || (loading ? '正在打开…' : '这一篇')}</h1>
          <small>
            {project?.name}
            {job?.createdAt && `${project?.name ? ' · ' : ''}${new Date(job.createdAt).toLocaleString()}`}
          </small>
        </div>
        {/* 上一篇/下一篇:批量产出的典型动作是连着读十几篇,回列表再点开一次是多余的往返 */}
        {(neighbors.previous || neighbors.next) && (
          <div className="qc-reader-page__pager">
            <Button
              variant="ghost"
              icon={<ChevronLeft size={14} />}
              disabled={!neighbors.previous}
              title={neighbors.previous?.topic || undefined}
              onClick={() => neighbors.previous && navigate(readerPath(neighbors.previous.id))}
            >
              上一篇
            </Button>
            <small className="qc-hint">{neighbors.position} / {neighbors.total}</small>
            <Button
              variant="ghost"
              disabled={!neighbors.next}
              title={neighbors.next?.topic || undefined}
              onClick={() => neighbors.next && navigate(readerPath(neighbors.next.id))}
            >
              下一篇<ChevronRight size={14} />
            </Button>
          </div>
        )}
      </header>

      {loading && !job && <p className="qc-hint">正在读取这一篇…</p>}

      {loadError && (
        <div className="quick-card">
          <div className="quick-card__body">
            <p className="qc-hint">打不开这一篇：{loadError}</p>
            <div className="qc-actions">
              <Button variant="secondary" onClick={() => void load()}>重新读取</Button>
              <Button variant="ghost" onClick={backToHistory}>返回产出</Button>
            </div>
          </div>
        </div>
      )}

      {job && inFlight && (
        <WaitCard job={job as unknown as GenerationJob} now={now} />
      )}

      {job?.status === 'failed' && (() => {
        // 与产出区同一套归类:原文是中文前缀套英文模型层报错,用户读不出该怎么办
        const reason = failureReason(job.error);
        return (
        <div className="quick-card">
          <div className="quick-card__body">
            <p className="qc-hint qc-hint--error">生成失败：{reason.label}</p>
            {reason.raw && reason.raw !== reason.label && (
              <details className="qc-failure-raw">
                <summary>技术细节</summary>
                <p>{reason.raw}</p>
              </details>
            )}
            <div className="qc-actions">
              <Button
                variant="secondary"
                icon={<RotateCcw size={13} />}
                loading={retrying}
                // 余额不足/密钥失效这类重试注定再败,还白扣一次额度
                disabled={retrying || !project || reason.blocking}
                onClick={() => void retry()}
              >
                按同款重试
              </Button>
              <small className="qc-hint">
                {reason.blocking ? '这类原因重试仍会失败，请先解决上述问题' : '重试消耗 1 次额度'}
              </small>
            </div>
          </div>
        </div>
        );
      })()}

      {job && job.status === 'completed' && job.candidates.length === 0 && (
        <p className="qc-hint">这次生成没有可展示的候选。</p>
      )}

      {/* 排队中/失败的任务不进 NoteCard:半成品套上笔记外壳会像已经发布过了,
          这两种状态各自有 WaitCard 与失败块。 */}
      {job && job.status === 'completed' && job.candidates.length > 0 && (() => {
        // 与工作区共用同一个夹法,见 clampCandidateIndex 的注释
        const current = job.candidates[clampCandidateIndex(activeIndex, job.candidates.length)]!;
        return (
          <>
            {/* 标签走 candidateDiffView,与工作区差异表同源;单候选时组件自己不渲染 */}
            <CandidateSwitch candidates={job.candidates} activeIndex={activeIndex} onPick={setActiveIndex} />

            <NoteAlertBar
              validation={current.validation}
              onSeeDetail={() => workbenchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            />

            <NoteCard candidate={current} job={job} projectName={project?.name} />

            <div className="xhs-workbench" ref={workbenchRef}>
              <ReaderDetail
                job={job}
                activeIndex={activeIndex}
                onExport={exportAs}
                onRevise={revise}
                revisingId={revisingId}
                onRetry={() => void retry()}
                retrying={retrying}
              />
            </div>
          </>
        );
      })()}
    </div>
  );
}
