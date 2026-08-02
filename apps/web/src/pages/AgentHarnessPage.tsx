import {
  ArchiveRestore,
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Compass,
  Copy,
  Database,
  Download,
  FileJson,
  FileSearch,
  Images,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  MessageCircleMore,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_HARNESS_METHOD_ID,
  HARNESS_METHOD_PROFILES,
  getHarnessMethodProfile,
  type HarnessMethodId,
} from '@content-agent/agent-harness-core/methods';
import { useNavigate, useParams } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, EmptyState, Field, Modal, Skeleton, useToast } from '../components/Ui';
import { V2Hero, V2Instrument, V2InstrumentCell } from '../components/V2';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import {
  canExportHarnessRun,
  filterHarnessRuns,
  harnessCompletedResultState,
  harnessFailureGuidance,
  harnessReviewBlocked,
  harnessTaskContract,
  shouldWarnHarnessPolling,
  type HarnessRunFilter,
} from '../lib/agent-harness-view';
import { formatDate } from '../lib/utils';
import {
  HARNESS_AUDIENCE_STAGES,
  HARNESS_FINE_TUNE_SUGGESTIONS,
  HARNESS_INTENTS,
  resolveHarnessQuickStart,
  type HarnessAudienceStageId,
  type HarnessIntentId,
} from '../lib/agent-harness-quickstart';
import type { AgentHarnessCandidate, AgentHarnessCapabilities, AgentHarnessCreateInput, AgentHarnessJob, ImageAsset } from '../types';

interface HarnessFineTune {
  topic: string;
  goal: string;
  audience: string;
  entryPoint: string;
  tone: string;
  bodyLength: '' | 'short' | 'medium' | 'long';
  accountIdentity: string;
  callToAction: string;
  publishingNotes: string;
  mustInclude: string;
  forbidden: string;
  notes: string;
  imageAssetIds: string[];
}

type HarnessAssetMode = 'auto' | 'manual' | 'none';

const HARNESS_RUN_PAGE_SIZE = 30;
const HARNESS_IMAGE_LIMIT = 12;

const INITIAL_FINE_TUNE: HarnessFineTune = {
  topic: '', goal: '', audience: '', entryPoint: '', tone: '', bodyLength: '',
  accountIdentity: '', callToAction: '', publishingNotes: '', mustInclude: '', forbidden: '', notes: '',
  imageAssetIds: [],
};

function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,，]/u).map((item) => item.trim()).filter(Boolean))];
}

function statusLabel(job: AgentHarnessJob): string {
  if (job.status === 'queued') return job.candidateCheckpointAt ? '等待最终复核' : '等待独立 Agent';
  if (job.status === 'running') return job.candidateCheckpointAt ? '正在最终复核' : 'Agent 正在自主探索';
  if (job.status === 'completed' && job.reviewStatus === 'blocked') return '候选已保留 · 复核阻断';
  if (job.status === 'completed') return '独立运行完成';
  return '运行未完成';
}

function runKindLabel(kind: AgentHarnessJob['runKind']): string {
  if (kind === 'retry') return '重试运行';
  if (kind === 'revision') return '改稿运行';
  return '原始运行';
}

function traceLabel(action: string): string {
  if (action === 'search_knowledge') return '检索项目知识';
  if (action === 'read_evidence') return '读取证据原文';
  if (action === 'submit_candidates') return '提交完整发布包';
  return action;
}

function publicationCheckLabel(key: AgentHarnessCandidate['publicationChecklist'][number]['key']): string {
  return {
    evidence: '事实与证据',
    simulation_disclosure: '模拟互动披露',
    execution_plan: '真实问题承接',
    asset_authorization: '图片素材授权',
    platform_compliance: '平台合规',
    final_proofread: '终稿校对',
  }[key];
}

function publicationCheckStatus(status: AgentHarnessCandidate['publicationChecklist'][number]['status']): string {
  return { ready: '已就绪', blocked: '阻断', manual_review: '人工复核' }[status];
}

function postingIdentityLabel(value: AgentHarnessCandidate['content']['Cref']['threads'][number]['postingIdentity']): string {
  return { author: '作者本人', brand: '品牌账号', staff: '项目人员', expert: '专业人员', publisher: '发布账号' }[value];
}

function threadStopReasonLabel(value?: AgentHarnessCandidate['content']['Cref']['threads'][number]['stopReason']): string {
  return value ? {
    answered: '问题已回答',
    no_new_gap: '没有新增缺口',
    evidence_boundary: '到达证据边界',
    professional_review: '转专业评估',
  }[value] : '旧运行未记录';
}

function routeOwnerLabel(value: 'publisher' | 'staff' | 'expert'): string {
  return { publisher: '发布账号', staff: '项目人员', expert: '专业人员' }[value];
}

function candidateMarkdown(candidate: AgentHarnessCandidate): string {
  const { N, H, Cref, publishing } = candidate.content;
  return [
    `# ${N.title}`, '', `> 创意命题：${candidate.concept}`, '',
    '## 封面', `主文案：${N.coverHeadline}`, `副文案：${N.coverSubheadline}`, '',
    '## 逐图脚本', `总任务：${N.imageBrief}`,
    ...N.imageSequence.flatMap((item) => [
      '', `### 图 ${item.sequence} · ${item.role}`,
      `来源：${item.source === 'selected_asset' ? `已选素材 ${item.assetId}` : '新设计'}`,
      `画面/制作方向：${item.direction}`, `叠字：${item.overlayText || '无'}`,
      `证据：${item.evidenceIds.join('、') || '无'}`,
    ]),
    '', '## 发布正文', N.body, '', `行动引导：${N.callToAction}`, '', H.hashtags.join(' '),
    '', '## 账号首评', Cref.ownedFirstComment, '', '## 模拟问答参考', Cref.disclaimer,
    ...Cref.threads.flatMap((thread) => [
      '', `**模拟读者问：${thread.question}**`, `${postingIdentityLabel(thread.postingIdentity)}答：${thread.answer}`,
      ...thread.followUps.flatMap((followUp) => [`${followUp.kind === 'counterexample' ? '反例' : '追问'}：${followUp.question}`, `答：${followUp.answer}`]),
      ...(thread.clarification ? [`澄清：${thread.clarification}`] : []),
      ...(thread.nextStep ? [`下一步：${thread.nextStep}`] : []),
      ...(thread.boundary ? [`边界：${thread.boundary}`] : []),
      `停止原因：${threadStopReasonLabel(thread.stopReason)}`,
      `证据：${thread.evidenceIds.join('、') || '无'}`,
    ]),
    '', '## 发布说明', `入口：${publishing.entryPoint}`, `发布身份：${publishing.accountIdentity}`,
    `时机说明：${publishing.timingNote}`, `互动目标：${publishing.interactionGoal}`,
    '', '## aC · 真实问题承接计划（计划，非已执行）',
    `首次响应：${publishing.responseSla || '旧运行未记录'}`,
    '### 问题分流', ...((publishing.liveQuestionRoutes?.length ? publishing.liveQuestionRoutes.map((route) => `- 当${route.when} → ${routeOwnerLabel(route.owner)}：${route.action}`) : ['- 旧运行未记录'])),
    '### 更新触发', ...((publishing.updateTriggers?.length ? publishing.updateTriggers.map((item) => `- ${item}`) : ['- 旧运行未记录'])),
    '### 停止规则', ...((publishing.stopRules?.length ? publishing.stopRules.map((item) => `- ${item}`) : ['- 旧运行未记录'])),
    '', '## 所选素材决策',
    ...candidate.assetDecisions.map((item) =>
      `- ${item.assetId}：${item.decision === 'use' ? '使用' : '舍弃'}；${item.rationale}（证据：${item.evidenceIds.join('、') || '无'}）`),
    '', '## 发布前检查',
    ...candidate.publicationChecklist.map((item) => `- ${publicationCheckLabel(item.key)} · ${publicationCheckStatus(item.status)}：${item.note}`),
    ...(candidate.revisionNotes.instructionApplied.length || candidate.revisionNotes.preservedElements.length
      ? ['', '## 定向改稿记录', `已落实：${candidate.revisionNotes.instructionApplied.join('；')}`, `已保留：${candidate.revisionNotes.preservedElements.join('；')}`]
      : []),
    '', '## 未知与自评', ...candidate.unknowns.map((item) => `- ${item}`), '', candidate.selfReview,
  ].join('\n');
}

function CandidateCard({
  candidate,
  jobId,
  onRevise,
  imageSnapshot,
  canRevise,
  canExport,
}: {
  candidate: AgentHarnessCandidate;
  jobId: string;
  onRevise: (candidate: AgentHarnessCandidate) => void;
  imageSnapshot?: AgentHarnessJob['imageSnapshot'];
  canRevise: boolean;
  canExport: boolean;
}) {
  const toast = useToast();
  const errors = candidate.validation.issues.filter((issue) => issue.severity === 'error');
  const warnings = candidate.validation.issues.filter((issue) => issue.severity === 'warning');
  const copy = async () => {
    if (!candidate.validation.valid) {
      toast.push('该候选仍有硬校验阻断，暂不能复制或导出', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(candidateMarkdown(candidate));
      toast.push('已复制完整发布包');
    } catch (error) {
      toast.push(errorMessage(error, '复制失败，请检查浏览器剪贴板权限'), 'error');
    }
  };
  const download = (format: 'markdown' | 'json') => window.location.assign(api.agentHarness.exportUrl(jobId, candidate.id, format));
  const { N, H, Cref, publishing } = candidate.content;
  const imageById = new Map((imageSnapshot ?? []).map((image) => [image.assetId, image]));
  const assetLabel = (assetId: string) => imageById.get(assetId)?.filename || assetId;
  return <article className="harness-candidate">
    <header>
      <div><span className="v2-lab-id">PACKAGE-{candidate.candidateIndex + 1}</span><h3>{N.title}</h3><p>{candidate.concept}</p></div>
      <div className="harness-candidate__actions">
        <Badge tone={candidate.validation.valid ? 'positive' : 'danger'}>{candidate.validation.valid ? '可导出' : `${errors.length} 项阻断`}</Badge>
        <Button variant="ghost" icon={<Copy size={14} />} disabled={!candidate.validation.valid || !canExport} title={!canExport ? '缺少导出权限' : undefined} onClick={() => void copy()}>复制整包</Button>
        <Button variant="ghost" icon={<Pencil size={14} />} disabled={!canRevise} title={!canRevise ? '缺少改稿权限' : undefined} onClick={() => onRevise(candidate)}>定向改稿</Button>
        <Button variant="ghost" icon={<Download size={14} />} disabled={!candidate.validation.valid || !canExport} title={!canExport ? '缺少导出权限' : undefined} onClick={() => download('markdown')}>MD</Button>
        <Button variant="ghost" icon={<FileJson size={14} />} disabled={!candidate.validation.valid || !canExport} title={!canExport ? '缺少导出权限' : undefined} onClick={() => download('json')}>JSON</Button>
      </div>
    </header>
    <div className="harness-package-grid">
      <section><small>封面</small><strong>{N.coverHeadline}</strong><p>{N.coverSubheadline}</p></section>
      <section><small>发布信息</small><p>入口：{publishing.entryPoint}</p><p>身份：{publishing.accountIdentity}</p><p>时机：{publishing.timingNote}</p><p>互动目标：{publishing.interactionGoal}</p><p>首次响应：{publishing.responseSla || '旧运行未记录'}</p></section>
      <section><small>行动引导</small><p>{N.callToAction}</p><div className="harness-tags">{H.hashtags.map((tag) => <span key={tag}>{tag.startsWith('#') ? tag : `#${tag}`}</span>)}</div></section>
    </div>
    <section className="harness-copy-section"><small>正文</small><p className="harness-body">{N.body}</p></section>
    <details className="harness-images" open>
      <summary><Images size={15} />逐图脚本 · {N.imageSequence.length} 张</summary>
      <p className="harness-disclaimer">{N.imageBrief}</p>
      <div className="harness-image-sequence">{N.imageSequence.map((item) => <article key={`${item.sequence}-${item.assetId}`}>
        <b>{item.sequence}</b><div><strong>{item.role}</strong><p>{item.direction}</p><small>{item.source === 'selected_asset' ? `已选素材 · ${assetLabel(item.assetId)}` : '新设计'} · 叠字：{item.overlayText || '无'}</small></div>
      </article>)}</div>
      {candidate.assetDecisions.length > 0 && <div className="harness-asset-decisions">{candidate.assetDecisions.map((item) => <p key={item.assetId}><Badge tone={item.decision === 'use' ? 'positive' : 'neutral'}>{item.decision === 'use' ? '使用' : '舍弃'}</Badge><b title={item.assetId}>{assetLabel(item.assetId)}</b><span>{item.rationale}<small>证据：{item.evidenceIds.join(' · ') || '无'}</small></span></p>)}</div>}
    </details>
    <details className="harness-comments" open>
      <summary><MessageCircleMore size={15} />首评与模拟问答 · {Cref.threads.length} 条线程</summary>
      <div className="harness-owned-comment"><small>账号首评</small><p>{Cref.ownedFirstComment}</p></div>
      <p className="harness-disclaimer">{Cref.disclaimer}</p>
      {Cref.threads.map((thread) => <article className="harness-thread" key={thread.id}>
        <div className="harness-thread__meta"><Badge tone="warning">模拟读者提问</Badge><Badge tone="blue">{postingIdentityLabel(thread.postingIdentity)}答复</Badge><span>证据 {thread.evidenceIds.length} 项</span></div>
        <strong>问：{thread.question}</strong><p>答：{thread.answer}</p>
        {thread.followUps.map((followUp, index) => <div className="harness-thread__follow-up" key={`${thread.id}-${index}`}><b>{followUp.kind === 'counterexample' ? '反例' : '追问'}：{followUp.question}</b><span>{followUp.answer}</span></div>)}
        <div className="harness-thread__resolution"><p><b>澄清</b>{thread.clarification || '旧运行未记录'}</p><p><b>下一步</b>{thread.nextStep || '旧运行未记录'}</p><p><b>停止原因</b>{threadStopReasonLabel(thread.stopReason)}</p></div>
        {thread.boundary && <small>边界：{thread.boundary}</small>}
      </article>)}
    </details>
    <section className="harness-execution-plan" aria-label="真实问题承接计划">
      <header><div><span className="v2-lab-id">aC · EXECUTION PLAN</span><h4>真实问题承接计划</h4></div><Badge tone="warning">计划，非已执行</Badge></header>
      <div className="harness-execution-plan__summary"><span><small>首次响应</small><strong>{publishing.responseSla || '旧运行未记录'}</strong></span><span><small>问题分流</small><strong>{publishing.liveQuestionRoutes?.length ?? 0} 条</strong></span><span><small>更新触发</small><strong>{publishing.updateTriggers?.length ?? 0} 条</strong></span></div>
      <div className="harness-execution-plan__grid">
        <section><h5>真实问题分流</h5>{publishing.liveQuestionRoutes?.length ? publishing.liveQuestionRoutes.map((route, index) => <p key={`${route.when}-${index}`}><b>{routeOwnerLabel(route.owner)}</b><span>当{route.when}：{route.action}</span></p>) : <p className="legacy">旧运行未记录</p>}</section>
        <section><h5>何时更新参考包</h5>{publishing.updateTriggers?.length ? publishing.updateTriggers.map((item) => <p key={item}>{item}</p>) : <p className="legacy">旧运行未记录</p>}</section>
        <section><h5>何时停止或转人工</h5>{publishing.stopRules?.length ? publishing.stopRules.map((item) => <p key={item}>{item}</p>) : <p className="legacy">旧运行未记录</p>}</section>
      </div>
    </section>
    {candidate.revisionNotes.instructionApplied.length > 0 && <section className="harness-revision-notes"><strong>定向改稿记录</strong><p>已落实：{candidate.revisionNotes.instructionApplied.join('；')}</p><p>已保留：{candidate.revisionNotes.preservedElements.join('；')}</p></section>}
    <details className="harness-audit">
      <summary><ShieldCheck size={15} />发布前检查、证据与未知</summary>
      <div className="harness-checklist">{candidate.publicationChecklist.map((item) => <p key={item.key} className={item.status}><Badge tone={item.status === 'ready' ? 'positive' : item.status === 'blocked' ? 'danger' : 'warning'}>{item.status === 'ready' ? '已就绪' : item.status === 'blocked' ? '阻断' : '人工复核'}</Badge><span>{item.note}</span></p>)}</div>
      <div className="harness-audit__grid">
        <section><strong>证据声明</strong>{candidate.citations.length ? candidate.citations.map((citation, index) => <p key={index}>{citation.statement}<small>{citation.evidenceIds.join(' · ')}</small></p>) : <p>未声明项目事实</p>}</section>
        <section><strong>独立事实盘点</strong>{candidate.claimAudit?.length ? candidate.claimAudit.map((claim, index) => <p key={index}>{claim.statement}<small>{claim.classification} · {claim.evidenceIds.join(' · ') || '无证据'}</small></p>) : <p>未识别需登记的项目事实</p>}</section>
        <section><strong>显式未知与自评</strong>{candidate.unknowns.length ? candidate.unknowns.map((unknown) => <p key={unknown}>{unknown}</p>) : <p>无额外未知项</p>}<p>{candidate.selfReview || '未提供自评摘要'}</p></section>
      </div>
      {(errors.length > 0 || warnings.length > 0) && <ul className="harness-issues">{[...errors, ...warnings].map((issue, index) => <li className={issue.severity} key={`${issue.code}-${index}`}><b>{issue.severity === 'error' ? '阻断' : '复核'}</b>{issue.message}</li>)}</ul>}
    </details>
  </article>;
}

export function AgentHarnessPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { projectId, currentProject, setProjectId } = useProjects();
  const [form, setForm] = useState<HarnessFineTune>(INITIAL_FINE_TUNE);
  const [intentId, setIntentId] = useState<HarnessIntentId>('decision');
  const [methodProfileId, setMethodProfileId] = useState<HarnessMethodId>(DEFAULT_HARNESS_METHOD_ID);
  const [audienceStageId, setAudienceStageId] = useState<HarnessAudienceStageId>(getHarnessMethodProfile(DEFAULT_HARNESS_METHOD_ID).audienceStage);
  const [audienceStageAdjusted, setAudienceStageAdjusted] = useState(false);
  const [topicMode, setTopicMode] = useState<'agent_discovery' | 'user_defined'>('agent_discovery');
  const [assetMode, setAssetMode] = useState<HarnessAssetMode>('auto');
  const [jobs, setJobs] = useState<AgentHarnessJob[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsFetched, setJobsFetched] = useState(0);
  const [jobsLoadingMore, setJobsLoadingMore] = useState(false);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AgentHarnessCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [trash, setTrash] = useState<AgentHarnessJob[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashFetched, setTrashFetched] = useState(0);
  const [trashLoadingMore, setTrashLoadingMore] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [selected, setSelected] = useState<AgentHarnessJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  const [revisionCandidate, setRevisionCandidate] = useState<AgentHarnessCandidate | null>(null);
  const [revisionInstruction, setRevisionInstruction] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [activeCandidateId, setActiveCandidateId] = useState('');
  const [runQuery, setRunQuery] = useState('');
  const [runFilter, setRunFilter] = useState<HarnessRunFilter>('all');
  const sequence = useRef(0);
  const submitLock = useRef(false);
  const actionLock = useRef(false);
  const pollFailures = useRef(0);
  const methodShelfRef = useRef<HTMLDivElement>(null);
  const methodShelfPositioned = useRef(false);
  const toast = useToast();

  const methodShelfMetrics = () => {
    const shelf = methodShelfRef.current;
    const cards = shelf
      ? Array.from(shelf.querySelectorAll<HTMLButtonElement>('[data-method-id]'))
      : [];
    if (!shelf || !cards.length) return null;
    const stride = cards.length > 1
      ? Math.max(1, cards[1]!.offsetLeft - cards[0]!.offsetLeft)
      : Math.max(1, cards[0]!.offsetWidth);
    const gap = Math.max(0, stride - cards[0]!.offsetWidth);
    const visibleCount = Math.max(1, Math.floor((shelf.clientWidth + gap) / stride));
    return { shelf, cards, visibleCount };
  };

  const scrollMethodPageTo = (startIndex: number, behavior: ScrollBehavior = 'smooth') => {
    const metrics = methodShelfMetrics();
    if (!metrics) return;
    const { shelf, cards, visibleCount } = metrics;
    const boundedStart = Math.max(0, Math.min(startIndex, Math.max(0, cards.length - visibleCount)));
    shelf.scrollTo({ left: cards[boundedStart]!.offsetLeft - cards[0]!.offsetLeft, behavior });
  };

  const revealMethod = (id: HarnessMethodId, behavior: ScrollBehavior = 'smooth') => {
    const metrics = methodShelfMetrics();
    if (!metrics) return;
    const selectedIndex = metrics.cards.findIndex((card) => card.dataset.methodId === id);
    if (selectedIndex < 0) return;
    const centeredStart = selectedIndex - Math.floor(metrics.visibleCount / 2);
    scrollMethodPageTo(centeredStart, behavior);
  };

  const browseMethods = (direction: -1 | 1) => {
    const metrics = methodShelfMetrics();
    if (!metrics) return;
    const firstVisible = metrics.cards.reduce((best, card, index) => (
      Math.abs((card.offsetLeft - metrics.cards[0]!.offsetLeft) - metrics.shelf.scrollLeft)
        < Math.abs((metrics.cards[best]!.offsetLeft - metrics.cards[0]!.offsetLeft) - metrics.shelf.scrollLeft)
        ? index : best
    ), 0);
    scrollMethodPageTo(firstVisible + direction * metrics.visibleCount);
  };

  useLayoutEffect(() => {
    revealMethod(methodProfileId, methodShelfPositioned.current ? 'smooth' : 'auto');
    methodShelfPositioned.current = true;
  }, [methodProfileId]);

  useEffect(() => {
    const shelf = methodShelfRef.current;
    if (!shelf || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => revealMethod(methodProfileId, 'auto'));
    });
    observer.observe(shelf);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [methodProfileId]);

  const loadImages = async (requestedProjectId: string, requestSequence: number) => {
    setImageError(null);
    try {
      const result = await api.imageAssets.list(requestedProjectId, { limit: HARNESS_IMAGE_LIMIT, offset: 0, observationStatus: 'approved' });
      if (requestSequence === sequence.current && requestedProjectId === projectId) setImages(result.items);
    } catch (error) {
      if (requestSequence === sequence.current && requestedProjectId === projectId) {
        setImages([]);
        setImageError(errorMessage(error, '已批准图片加载失败，本次仍可不使用已有图片'));
      }
    }
  };

  const loadCapabilities = async (requestedProjectId: string, requestSequence: number) => {
    setCapabilityError(null);
    try {
      const result = await api.agentHarness.capabilities(requestedProjectId);
      if (requestSequence === sequence.current && requestedProjectId === projectId) setCapabilities(result);
    } catch (error) {
      if (requestSequence === sequence.current && requestedProjectId === projectId) {
        setCapabilities(null);
        setCapabilityError(errorMessage(error, '权限状态读取失败，操作已安全禁用'));
      }
    }
  };

  const loadTrash = async (requestedProjectId = projectId) => {
    if (!requestedProjectId) return;
    const requestSequence = sequence.current;
    setTrashLoading(true); setTrashError(null); setTrashLoadingMore(false);
    try {
      const result = await api.agentHarness.trash(requestedProjectId, { limit: HARNESS_RUN_PAGE_SIZE, offset: 0 });
      if (requestSequence !== sequence.current || requestedProjectId !== projectId) return;
      setTrash(result.items); setTrashTotal(result.total); setTrashFetched(result.items.length);
    } catch (error) {
      if (requestSequence === sequence.current && requestedProjectId === projectId) setTrashError(errorMessage(error, '回收站加载失败'));
    } finally {
      if (requestSequence === sequence.current && requestedProjectId === projectId) setTrashLoading(false);
    }
  };

  const openTrash = () => {
    setTrashOpen(true);
    void loadTrash();
  };

  const loadList = async () => {
    const requestSequence = ++sequence.current;
    setLoading(true); setLoadError(null); setJobsLoadingMore(false);
    try {
      let detail: AgentHarnessJob | null = null;
      if (routeId) {
        detail = await api.agentHarness.get(routeId);
        if (detail.projectId !== projectId) {
          setProjectId(detail.projectId);
          if (requestSequence === sequence.current) setLoading(false);
          return;
        }
      }
      if (!projectId) {
        setJobs([]); setJobsTotal(0); setJobsFetched(0); setSelected(null); setImages([]);
        setCapabilities(null); setTrash([]); setTrashTotal(0); setTrashFetched(0);
        return;
      }
      void loadImages(projectId, requestSequence);
      void loadCapabilities(projectId, requestSequence);
      const result = await api.agentHarness.list(projectId, { limit: HARNESS_RUN_PAGE_SIZE, offset: 0 });
      if (requestSequence !== sequence.current) return;
      const listedJobs = detail && !result.items.some((item) => item.id === detail?.id) ? [detail, ...result.items] : result.items;
      setJobs(listedJobs); setJobsTotal(result.total); setJobsFetched(result.items.length);
      const active = detail ?? (selected?.projectId === projectId ? await api.agentHarness.get(selected.id) : result.items[0] ? await api.agentHarness.get(result.items[0].id) : null);
      if (requestSequence !== sequence.current) return;
      setSelected(active);
      if (!routeId && active) navigate(`/agent-harness/${encodeURIComponent(active.id)}`, { replace: true });
    } catch (error) {
      if (requestSequence === sequence.current) setLoadError(errorMessage(error, 'Agent 运行列表加载失败'));
    } finally {
      if (requestSequence === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void loadList();
    return () => { sequence.current += 1; };
  }, [projectId, routeId]);

  useEffect(() => {
    const candidates = selected?.candidates ?? [];
    if (!candidates.length) {
      setActiveCandidateId('');
      return;
    }
    setActiveCandidateId((current) => candidates.some((candidate) => candidate.id === current) ? current : candidates[0]!.id);
  }, [selected?.id, selected?.candidates]);

  useEffect(() => {
    if (!selected || !['queued', 'running'].includes(selected.status)) return;
    let cancelled = false;
    let timer: number | undefined;
    const selectedId = selected.id;
    pollFailures.current = 0;
    setPollWarning(null);
    const poll = async () => {
      try {
        const next = await api.agentHarness.get(selectedId);
        if (cancelled) return;
        pollFailures.current = 0;
        setPollWarning(null);
        setSelected(next);
        setJobs((current) => current.map((job) => job.id === next.id ? next : job));
        if (['queued', 'running'].includes(next.status)) timer = window.setTimeout(() => void poll(), 1500);
      } catch (error) {
        if (cancelled) return;
        pollFailures.current += 1;
        if (shouldWarnHarnessPolling(pollFailures.current)) {
          setPollWarning(errorMessage(error, '运行状态连续刷新失败，当前进度可能已过期'));
        }
        timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selected?.id, selected?.status]);

  const totals = useMemo(() => ({
    completed: jobs.filter((job) => job.status === 'completed').length,
    running: jobs.filter((job) => ['queued', 'running'].includes(job.status)).length,
    valid: selected?.candidates?.filter((candidate) => candidate.validation.valid).length ?? 0,
  }), [jobs, selected]);

  const quickInput = useMemo(() => {
    const overrides: Partial<AgentHarnessCreateInput> = {};
    if (form.bodyLength) overrides.bodyLength = form.bodyLength;
    const textOverrides: Array<[keyof AgentHarnessCreateInput, string]> = [
      ['goal', form.goal], ['audience', form.audience], ['entryPoint', form.entryPoint], ['tone', form.tone],
      ['accountIdentity', form.accountIdentity], ['callToAction', form.callToAction],
      ['publishingNotes', form.publishingNotes], ['notes', form.notes],
    ];
    for (const [key, value] of textOverrides) if (value.trim()) (overrides as Record<string, unknown>)[key] = value.trim();
    const mustInclude = lines(form.mustInclude); const forbidden = lines(form.forbidden);
    if (mustInclude.length) overrides.mustInclude = mustInclude;
    if (forbidden.length) overrides.forbidden = forbidden;
    if (assetMode === 'manual') overrides.imageAssetIds = form.imageAssetIds;
    if (assetMode === 'none') overrides.imageAssetIds = [];
    return resolveHarnessQuickStart({
      projectId,
      intentId,
      methodProfileId,
      audienceStageId,
      useCustomTopic: topicMode === 'user_defined',
      customTopic: form.topic,
      approvedImageAssetIds: images.map((image) => image.id),
      useApprovedImages: assetMode === 'auto',
      overrides,
    });
  }, [projectId, intentId, methodProfileId, audienceStageId, topicMode, assetMode, form, images]);

  const selectedIntent = HARNESS_INTENTS.find((item) => item.id === intentId)!;
  const selectedMethod = getHarnessMethodProfile(methodProfileId);
  const selectedAudienceStage = HARNESS_AUDIENCE_STAGES.find((item) => item.id === audienceStageId)!;
  const customTopicMissing = topicMode === 'user_defined' && !form.topic.trim();
  const activeCandidate = selected?.candidates?.find((candidate) => candidate.id === activeCandidateId) ?? selected?.candidates?.[0];
  const visibleJobs = useMemo(() => filterHarnessRuns(jobs, runQuery, runFilter), [jobs, runQuery, runFilter]);
  const taskContract = useMemo(() => harnessTaskContract(selected?.task), [selected?.task]);
  const failureGuidance = selected?.status === 'failed' ? harnessFailureGuidance(selected.error) : null;
  const completedResultState = harnessCompletedResultState(selected);
  const reviewBlocked = harnessReviewBlocked(selected);
  const canRun = capabilities?.canRun === true;
  const canRevise = capabilities?.canRevise === true;
  const canEdit = capabilities?.canEdit === true;
  const canExport = capabilities?.canExport === true;

  const chooseMethod = (id: HarnessMethodId) => {
    const method = getHarnessMethodProfile(id);
    setMethodProfileId(id);
    setAudienceStageId(method.audienceStage);
    setAudienceStageAdjusted(false);
  };

  const selectJob = (job: AgentHarnessJob) => {
    navigate(`/agent-harness/${encodeURIComponent(job.id)}`);
  };

  const loadMoreJobs = async () => {
    if (!projectId || jobsLoadingMore || jobsFetched >= jobsTotal) return;
    const requestedProjectId = projectId;
    const requestSequence = sequence.current;
    setJobsLoadingMore(true);
    try {
      const result = await api.agentHarness.list(requestedProjectId, { limit: HARNESS_RUN_PAGE_SIZE, offset: jobsFetched });
      if (requestSequence !== sequence.current || requestedProjectId !== projectId) return;
      setJobs((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !known.has(item.id))];
      });
      setJobsTotal(result.total);
      setJobsFetched((current) => current + result.items.length);
    } catch (error) {
      if (requestSequence === sequence.current && requestedProjectId === projectId) {
        toast.push(errorMessage(error, '更多 Agent 运行加载失败'), 'error');
      }
    } finally {
      if (requestSequence === sequence.current && requestedProjectId === projectId) setJobsLoadingMore(false);
    }
  };

  const loadMoreTrash = async () => {
    if (!projectId || trashLoadingMore || trashFetched >= trashTotal) return;
    const requestedProjectId = projectId;
    const requestSequence = sequence.current;
    setTrashLoadingMore(true);
    try {
      const result = await api.agentHarness.trash(requestedProjectId, { limit: HARNESS_RUN_PAGE_SIZE, offset: trashFetched });
      if (requestSequence !== sequence.current || requestedProjectId !== projectId) return;
      setTrash((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !known.has(item.id))];
      });
      setTrashTotal(result.total);
      setTrashFetched((current) => current + result.items.length);
    } catch (error) {
      if (requestSequence === sequence.current && requestedProjectId === projectId) {
        toast.push(errorMessage(error, '更多回收站记录加载失败'), 'error');
      }
    } finally {
      if (requestSequence === sequence.current && requestedProjectId === projectId) setTrashLoadingMore(false);
    }
  };

  const adoptJob = (job: AgentHarnessJob, message: string) => {
    setSelected(job);
    setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
    setJobsTotal((total) => total + 1);
    navigate(`/agent-harness/${encodeURIComponent(job.id)}`);
    toast.push(message);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || customTopicMissing || !canRun || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      let job: AgentHarnessJob;
      try {
        job = await api.agentHarness.create(quickInput);
      } catch (error) {
        const message = errorMessage(error, 'Agent 创作启动失败');
        if (!message.includes('没有可用项目证据') || !window.confirm('当前项目没有可用事实证据。本次只能生成不含项目事实的通用参考内容，仍要继续吗？')) throw error;
        job = await api.agentHarness.create({ ...quickInput, allowUngrounded: true });
      }
      adoptJob(job, 'Agent 已开始找题并创作 3 套方案');
    } catch (error) {
      toast.push(errorMessage(error, 'Agent 创作启动失败'), 'error');
    } finally { submitLock.current = false; setSubmitting(false); }
  };

  const retry = async () => {
    if (!selected || !canRun || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try { adoptJob(await api.agentHarness.retry(selected.id), '已创建独立重试运行，原结果保持不变'); }
    catch (error) { toast.push(errorMessage(error, '重试失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const retryReview = async () => {
    if (!selected || !canRun || !reviewBlocked || actionLock.current) return;
    actionLock.current = true; setActionBusy(true);
    try {
      const next = await api.agentHarness.retryReview(selected.id);
      setSelected(next); setJobs((current) => current.map((job) => job.id === next.id ? next : job));
      toast.push('已只重试最终复核，不会重新检索或生成候选');
    } catch (error) { toast.push(errorMessage(error, '最终复核重试失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const revise = async () => {
    if (!selected || !canRevise || !revisionCandidate || !revisionInstruction.trim() || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try {
      const job = await api.agentHarness.revise(selected.id, revisionCandidate.id, revisionInstruction.trim());
      setRevisionCandidate(null); setRevisionInstruction('');
      adoptJob(job, '已创建独立改稿运行，原候选保持不变');
    } catch (error) { toast.push(errorMessage(error, '改稿提交失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const remove = async () => {
    if (!selected || !canEdit || actionLock.current) return;
    actionLock.current = true;
    const deleted = selected;
    setActionBusy(true);
    try {
      await api.agentHarness.remove(deleted.id);
      const remaining = jobs.filter((job) => job.id !== deleted.id);
      setJobs(remaining);
      setJobsTotal((total) => Math.max(0, total - 1));
      setTrash((current) => [{ ...deleted, deletedAt: new Date().toISOString() }, ...current.filter((item) => item.id !== deleted.id)]);
      setTrashTotal((total) => total + 1);
      setSelected(null);
      navigate(remaining[0] ? `/agent-harness/${encodeURIComponent(remaining[0].id)}` : '/agent-harness');
      toast.push('已删除本次 Agent 运行', 'success', {
        label: '撤销',
        run: () => void api.agentHarness.restore(deleted.id).then((restored) => {
          setTrash((current) => current.filter((item) => item.id !== deleted.id));
          setTrashTotal((total) => Math.max(0, total - 1));
          adoptJob(restored, '已恢复 Agent 运行');
        }).catch((error) => toast.push(errorMessage(error, '恢复失败'), 'error')),
      });
    } catch (error) { toast.push(errorMessage(error, '删除失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const restoreFromTrash = async (id: string) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try {
      const restored = await api.agentHarness.restore(id);
      setTrash((current) => current.filter((item) => item.id !== id));
      setTrashTotal((total) => Math.max(0, total - 1));
      adoptJob(restored, '已从回收站恢复 Agent 运行');
      setTrashOpen(false);
    } catch (error) { toast.push(errorMessage(error, '恢复失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const selectFinalCandidate = async (candidateId: string) => {
    if (!selected || !canEdit || actionLock.current) return;
    actionLock.current = true; setActionBusy(true);
    try {
      const next = await api.agentHarness.select(selected.id, candidateId);
      setSelected(next); setJobs((current) => current.map((job) => job.id === next.id ? next : job));
      toast.push('已记录最终候选，下一步可人工批准');
    } catch (error) { toast.push(errorMessage(error, '选择候选失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const approveFinalCandidate = async () => {
    if (!selected || !canExport || !selected.selectedCandidateId || actionLock.current) return;
    actionLock.current = true; setActionBusy(true);
    try {
      const next = await api.agentHarness.approve(selected.id, approvalNotes.trim());
      setSelected(next); setJobs((current) => current.map((job) => job.id === next.id ? next : job));
      toast.push('候选已人工批准，可按批准版本导出');
    } catch (error) { toast.push(errorMessage(error, '批准失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const purgeFromTrash = async (id: string) => {
    if (!canEdit || actionLock.current || !window.confirm('永久删除后，候选、证据快照和运行轨迹均不可恢复。确认继续？')) return;
    actionLock.current = true; setActionBusy(true);
    try {
      await api.agentHarness.purge(id);
      setTrash((current) => current.filter((item) => item.id !== id));
      setTrashTotal((total) => Math.max(0, total - 1));
      toast.push('已永久删除运行及其快照');
    } catch (error) { toast.push(errorMessage(error, '永久删除失败'), 'error'); }
    finally { actionLock.current = false; setActionBusy(false); }
  };

  const copyLink = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/agent-harness/${selected.id}`);
      toast.push('已复制独立运行链接');
    } catch (error) {
      toast.push(errorMessage(error, '复制链接失败，请检查浏览器剪贴板权限'), 'error');
    }
  };

  return <div className="page agent-harness-page">
    <V2Hero
      status={<>{currentProject?.name || '未选择项目'} · 独立实验频道</>}
      title="Agent 创作"
      description="这个频道还在测试中：流程和界面都可能调整，导出仍要过同一套硬校验。不读取八轮分析、缺口池、表达策略、选题机会或原编排计划。Agent 直接从原始项目证据和你明确选择的已批准图片观察出发，自主检索、构思、自评并提交三套完整发布参考包。"
      actions={<a className="v2-hero__link" href="/generate"><Sparkles size={15} />切换到结构化创作</a>}
    />

    <div className="harness-boundary"><Bot size={20} /><div><strong>第二种执行范式，而不是旧频道的增强开关</strong><p>两个频道只共享项目原始资料、模型基础设施和真实性边界；创意发现、规划、候选与历史完全分开。重试与改稿都会产生新运行，不覆盖旧结果。</p></div></div>

    {!loading && !loadError && <V2Instrument columns={3}>
      <V2InstrumentCell tone="ai" icon={<Bot size={15} />} label="独立运行" value={jobsTotal} unit="次" note="含原始、重试与改稿运行" />
      <V2InstrumentCell tone="blue" icon={<Clock3 size={15} />} label="已加载运行中" value={totals.running} unit="次" note="当前已加载记录中的进行中任务" />
      <V2InstrumentCell tone="ok" icon={<ShieldCheck size={15} />} label="当前可导出候选" value={totals.valid} unit="套" note="通过确定性检查与模型辅助事实盘点" />
    </V2Instrument>}

    <div className="harness-layout">
      <form className="panel harness-form harness-quick-form" onSubmit={submit}>
        <div className="panel__header"><div><span className="v2-lab-id">一步开始</span><h2>不用写提示词，选一个最接近的方向</h2><p>推荐项已经选好。直接开始也可以，Agent 会先从项目资料找题，再给你 3 套完整方案选择。</p></div><Badge tone="positive">零必填</Badge></div>
        <div className="harness-form__body">
          <section className="harness-quick-step">
            <div className="harness-quick-step__title"><Target size={17} /><div><strong>这次最想帮读者做什么？</strong><small>不确定就保留推荐项</small></div></div>
            <div className="harness-choice-grid harness-choice-grid--intent">
              {HARNESS_INTENTS.map((option) => <button type="button" key={option.id} aria-pressed={intentId === option.id} className={intentId === option.id ? 'selected' : ''} onClick={() => setIntentId(option.id)}>
                <span>{option.recommended && <i>推荐</i>}<strong>{option.title}</strong>{intentId === option.id && <Check size={15} />}</span><small>{option.description}</small>
              </button>)}
            </div>
          </section>

          <section className="harness-quick-step harness-method-step">
            <div className="harness-method-heading">
              <div className="harness-quick-step__title"><Sparkles size={17} /><div><strong>想要哪种成品写法？</strong><small>选择后会自动带入读者阶段、内容入口和正文篇幅</small></div></div>
              <div className="harness-method-heading__tools">
                <span><b>{selectedMethod.label}</b><small>{HARNESS_METHOD_PROFILES.length} 种写法</small></span>
                <div aria-label="浏览成品写法">
                  <button type="button" aria-label="查看前面的写法" onClick={() => browseMethods(-1)}><ChevronLeft size={15} /></button>
                  <button type="button" aria-label="查看更多写法" onClick={() => browseMethods(1)}><ChevronRight size={15} /></button>
                </div>
              </div>
            </div>
            <div className="harness-method-shelf" ref={methodShelfRef} tabIndex={0} aria-label="成品写法列表">
              <div className="harness-method-shelf__track">
                {HARNESS_METHOD_PROFILES.map((method) => <button type="button" key={method.id} data-method-id={method.id} aria-pressed={methodProfileId === method.id} className={methodProfileId === method.id ? 'selected' : ''} onClick={() => chooseMethod(method.id)}>
                  <span><span>{method.recommended && <i>推荐</i>}<strong>{method.label}</strong></span>{methodProfileId === method.id && <span className="harness-method-selected"><Check size={12} />已选</span>}</span>
                  <p>{method.description}</p>
                  <small>{method.entryRoute === 'search' ? '搜索入口' : method.entryRoute === 'recommendation' ? '推荐流入口' : '主页入口'}<b>·</b>{method.bodyLength === 'short' ? '短正文' : method.bodyLength === 'medium' ? '中正文' : '长正文'}</small>
                </button>)}
              </div>
            </div>
            <div className="harness-method-detail">
              <div><small>正文负责</small><p>{selectedMethod.bodyRole}</p></div>
              <div><small>评论负责</small><p>{selectedMethod.commentRole}</p></div>
              <div><small>不能越过</small><p>{selectedMethod.boundaryPolicy}</p></div>
            </div>
          </section>

          <section className="harness-quick-step">
            <div className="harness-quick-step__title"><Compass size={17} /><div><strong>读者大概走到哪一步？</strong><small>只选最像的，不需要分析用户画像</small></div></div>
            <div className="harness-choice-grid harness-choice-grid--stage">
              {HARNESS_AUDIENCE_STAGES.map((option) => <button type="button" key={option.id} aria-pressed={audienceStageId === option.id} className={audienceStageId === option.id ? 'selected' : ''} onClick={() => { setAudienceStageId(option.id); setAudienceStageAdjusted(true); }}>
                <span>{audienceStageId === option.id && <i>{audienceStageAdjusted ? '已调整' : '方法带入'}</i>}<strong>{option.title}</strong>{audienceStageId === option.id && <Check size={15} />}</span><small>{option.description}</small>
              </button>)}
            </div>
          </section>

          <div className="harness-auto-summary">
            <Sparkles size={19} /><div><strong>现在开始，Agent 会这样做</strong><p>{topicMode === 'agent_discovery' ? '从项目资料自主找题' : `围绕“${form.topic.trim() || '待填写主题'}”创作`} · {selectedIntent.title} · 采用“{selectedMethod.label}” · 面向{selectedAudienceStage.title}的读者 · 生成 3 套方案</p><small>{assetMode === 'auto' ? `自动检查 ${Math.min(images.length, 12)} 张已批准素材并逐张决定使用或舍弃` : assetMode === 'manual' ? `只检查你选中的 ${form.imageAssetIds.length} 张素材` : '本次不使用已有图片素材'}</small></div>
          </div>

          <details className="harness-fine-tune">
            <summary><span><Pencil size={15} /><span><strong>我有明确要求</strong><small>主题、语气、禁词、素材等都可以在这里改；不改也能生成</small></span></span><ChevronDown size={16} /></summary>
            <div className="harness-fine-tune__body">
              <section><h3>选题方式</h3><div className="harness-topic-mode">
                <button type="button" className={topicMode === 'agent_discovery' ? 'selected' : ''} onClick={() => setTopicMode('agent_discovery')}><Bot size={16} /><span><strong>让 Agent 自己找题</strong><small>从项目资料里找最值得写的角度</small></span>{topicMode === 'agent_discovery' && <Check size={14} />}</button>
                <button type="button" className={topicMode === 'user_defined' ? 'selected' : ''} onClick={() => setTopicMode('user_defined')}><Pencil size={16} /><span><strong>我有明确主题</strong><small>只在你已经知道要写什么时使用</small></span>{topicMode === 'user_defined' && <Check size={14} />}</button>
              </div>{topicMode === 'user_defined' && <Field label="明确主题" required><input value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} placeholder="例如：只有三天假，行动前应该先核验什么" maxLength={500} />{customTopicMissing && <small className="harness-field-error">请输入主题，或切回“让 Agent 自己找题”</small>}</Field>}</section>

              <section><h3>覆盖系统推荐（可选）</h3><p className="harness-combo-note">点击输入框右侧可选常用值；选中后仍可继续修改，也可以直接输入自己的要求。</p><div className="harness-form__row"><Field label="生成目标"><input list="harness-goal-options" value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder={String(quickInput.goal || '')} /><datalist id="harness-goal-options">{HARNESS_FINE_TUNE_SUGGESTIONS.goals.map((value) => <option key={value} value={value} />)}</datalist></Field><Field label="目标读者"><input list="harness-audience-options" value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} placeholder={String(quickInput.audience || '')} /><datalist id="harness-audience-options">{HARNESS_FINE_TUNE_SUGGESTIONS.audiences.map((value) => <option key={value} value={value} />)}</datalist></Field></div>
              <div className="harness-form__row"><Field label="内容入口"><input list="harness-entry-options" value={form.entryPoint} onChange={(event) => setForm({ ...form, entryPoint: event.target.value })} placeholder={String(quickInput.entryPoint || '')} /><datalist id="harness-entry-options">{HARNESS_FINE_TUNE_SUGGESTIONS.entryPoints.map((value) => <option key={value} value={value} />)}</datalist></Field><Field label="发布身份"><input list="harness-identity-options" value={form.accountIdentity} onChange={(event) => setForm({ ...form, accountIdentity: event.target.value })} placeholder="选择常用身份，或直接填写" /><datalist id="harness-identity-options">{HARNESS_FINE_TUNE_SUGGESTIONS.accountIdentities.map((value) => <option key={value} value={value} />)}</datalist></Field></div>
              <div className="harness-form__row"><Field label="语气"><input list="harness-tone-options" value={form.tone} onChange={(event) => setForm({ ...form, tone: event.target.value })} placeholder={String(quickInput.tone || '')} /><datalist id="harness-tone-options">{HARNESS_FINE_TUNE_SUGGESTIONS.tones.map((value) => <option key={value} value={value} />)}</datalist></Field><Field label="正文长度"><select value={form.bodyLength} onChange={(event) => setForm({ ...form, bodyLength: event.target.value as HarnessFineTune['bodyLength'] })}><option value="">跟随方法（{selectedMethod.bodyLength === 'short' ? '短' : selectedMethod.bodyLength === 'medium' ? '中' : '长'}）</option><option value="short">短，快速看完</option><option value="medium">中，充分说明</option><option value="long">长，完整展开</option></select></Field></div>
              <Field label="行动引导"><input list="harness-cta-options" value={form.callToAction} onChange={(event) => setForm({ ...form, callToAction: event.target.value })} placeholder={String(quickInput.callToAction || '')} /><datalist id="harness-cta-options">{HARNESS_FINE_TUNE_SUGGESTIONS.callsToAction.map((value) => <option key={value} value={value} />)}</datalist></Field>
              <Field label="发布说明"><div className="harness-template-input"><select aria-label="选择常用发布说明" value="" onChange={(event) => { if (event.target.value) setForm({ ...form, publishingNotes: event.target.value }); }}><option value="">选择常用说明（选后仍可修改）</option>{HARNESS_FINE_TUNE_SUGGESTIONS.publishingNotes.map((value) => <option key={value} value={value}>{value}</option>)}</select><textarea value={form.publishingNotes} onChange={(event) => setForm({ ...form, publishingNotes: event.target.value })} rows={3} maxLength={1000} placeholder="也可以直接填写排期、互动目标或审核要求" /></div></Field></section>

              <section><h3>事实与表达边界（可选）</h3><div className="harness-form__row"><Field label="必须包含" hint="每行一项"><textarea value={form.mustInclude} onChange={(event) => setForm({ ...form, mustInclude: event.target.value })} rows={3} /></Field><Field label="禁止出现" hint="每行一项"><textarea value={form.forbidden} onChange={(event) => setForm({ ...form, forbidden: event.target.value })} rows={3} /></Field></div><Field label="其他说明"><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={2} maxLength={2000} /></Field></section>

              <section><h3>图片素材</h3><div className="harness-asset-mode">
                <button type="button" className={assetMode === 'auto' ? 'selected' : ''} onClick={() => setAssetMode('auto')}><strong>Agent 自动判断</strong><small>检查最近 12 张已批准素材，逐张决定使用或舍弃</small></button>
                <button type="button" className={assetMode === 'manual' ? 'selected' : ''} onClick={() => setAssetMode('manual')}><strong>我来指定</strong><small>从最近 12 张已批准素材中选择</small></button>
                <button type="button" className={assetMode === 'none' ? 'selected' : ''} onClick={() => setAssetMode('none')}><strong>不用已有图片</strong><small>只生成新设计的逐图脚本</small></button>
              </div>{imageError && <p className="harness-field-error" role="status">{imageError}，已切换为无已有素材模式。</p>}{assetMode === 'manual' && (images.length ? <div className="harness-image-picker">{images.map((image) => <label key={image.id} className={form.imageAssetIds.includes(image.id) ? 'selected' : ''}><input type="checkbox" checked={form.imageAssetIds.includes(image.id)} onChange={() => setForm((current) => ({ ...current, imageAssetIds: current.imageAssetIds.includes(image.id) ? current.imageAssetIds.filter((id) => id !== image.id) : current.imageAssetIds.length < 12 ? [...current.imageAssetIds, image.id] : current.imageAssetIds }))} /><img src={image.contentUrl || api.imageAssets.contentUrl(projectId, image.id)} alt="" /><span><strong>{image.filename}</strong><small>已批准观察</small></span></label>)}</div> : <div className="harness-image-empty"><ImageIcon size={16} />暂无可用的已批准图片观察</div>)}</section>
            </div>
          </details>

          <Button type="submit" icon={<Sparkles size={16} />} loading={submitting} disabled={!projectId || customTopicMissing || !canRun} title={!canRun ? capabilityError || '缺少创作权限' : undefined}>让 Agent 开始创作 3 套方案</Button>
          <p className="harness-submit-note">你不需要先想好标题、结构、语气或图片顺序；生成后再从 3 套完整方案里选择和改稿。</p>
        </div>
      </form>
      <section className="panel harness-runs">
        <div className="panel__header"><div><h2>本频道运行</h2><p>不会混入结构化频道生成历史。</p></div><div className="harness-run-tools"><Button variant="ghost" icon={<ArchiveRestore size={14} />} onClick={openTrash}>回收站</Button><Button variant="ghost" icon={<RefreshCcw size={14} />} onClick={() => void loadList()}>刷新</Button></div></div>
        {!loading && !loadError && jobs.length > 0 && <div className="harness-run-filters"><label><Search size={14} /><span className="sr-only">搜索运行</span><input value={runQuery} onChange={(event) => setRunQuery(event.target.value)} placeholder="搜索主题、目标或改稿要求" /></label><select aria-label="按运行状态筛选" value={runFilter} onChange={(event) => setRunFilter(event.target.value as HarnessRunFilter)}><option value="all">全部状态</option><option value="active">进行中</option><option value="completed">已完成</option><option value="failed">未完成</option></select></div>}
        {loading ? <Skeleton lines={5} /> : loadError ? <EmptyState icon={<TriangleAlert size={22} />} title="加载失败" description={loadError} action={<Button variant="secondary" onClick={() => void loadList()}>重试</Button>} /> : visibleJobs.length ? <><div className="harness-run-list">{visibleJobs.map((job) => <button type="button" key={job.id} aria-current={selected?.id === job.id ? 'true' : undefined} className={selected?.id === job.id ? 'active' : ''} onClick={() => selectJob(job)}><span className={`harness-run-icon ${job.status}`}>{job.status === 'running' ? <LoaderCircle className="spin" size={16} /> : job.status === 'completed' ? <CheckCircle2 size={16} /> : job.status === 'failed' ? <CircleAlert size={16} /> : <Clock3 size={16} />}</span><span><strong>{job.topic}</strong><small>{runKindLabel(job.runKind)} · {statusLabel(job)} · {formatDate(job.createdAt, true)}</small></span><b>{job.progress}%</b></button>)}</div>{jobsFetched < jobsTotal && <div className="harness-load-more"><Button variant="ghost" loading={jobsLoadingMore} onClick={() => void loadMoreJobs()}>加载更多（已显示 {jobs.length}/{jobsTotal}）</Button></div>}</> : jobs.length ? <EmptyState icon={<Search size={22} />} title="没有匹配的运行" description="调整关键词或状态筛选后再试。当前搜索范围为已加载的运行。" action={<Button variant="secondary" onClick={() => { setRunQuery(''); setRunFilter('all'); }}>清除筛选</Button>} /> : <EmptyState icon={<Bot size={22} />} title="还没有 Agent 运行" description="左侧提交第一项独立创作任务。" />}
      </section>
    </div>

    {selected && <section className="harness-result">
      <div className="harness-result__header"><div><span className="v2-lab-id">HARNESS RUN · {runKindLabel(selected.runKind)}</span><h2>{selected.topic}</h2><p>{selected.goal}</p>{selected.instruction && <p>改稿要求：{selected.instruction}</p>}</div><div className="harness-result__actions"><Badge tone={selected.status === 'completed' && !reviewBlocked ? 'positive' : selected.status === 'failed' || reviewBlocked ? 'danger' : 'blue'}>{statusLabel(selected)}</Badge><Button variant="ghost" icon={<Link2 size={14} />} onClick={() => void copyLink()}>复制链接</Button><Button variant="ghost" icon={<Download size={14} />} disabled={!canExport || !canExportHarnessRun(selected)} title={!canExport ? '缺少导出权限' : undefined} onClick={() => window.location.assign(api.agentHarness.runExportUrl(selected.id, 'markdown'))}>导出整次</Button><Button variant="ghost" icon={<RotateCcw size={14} />} loading={actionBusy} disabled={!canRun || !['completed', 'failed'].includes(selected.status)} title={!canRun ? '缺少创作权限' : undefined} onClick={() => void retry()}>重新运行</Button><Button variant="danger" icon={<Trash2 size={14} />} loading={actionBusy} disabled={!canEdit} title={!canEdit ? '缺少编辑权限' : undefined} onClick={() => void remove()}>删除</Button></div></div>
      {selected.parentJobId && <div className="harness-lineage">本次由旧运行派生：{selected.parentDeleted ? <span>源运行已在回收站</span> : <button type="button" onClick={() => navigate(`/agent-harness/${selected.parentJobId}`)}>{selected.parentJobId.slice(0, 8)}</button>}</div>}
      <details className="harness-task-contract"><summary><ShieldCheck size={15} />复核本次冻结的创作合同</summary><div className="harness-task-contract__grid"><section><small>选题 / 方法</small><strong>{taskContract.topicMode} · {taskContract.methodLabel}</strong><p>{taskContract.audienceStage} · {taskContract.entryPoint} · {taskContract.bodyLength}</p></section><section><small>正文 / 评论职责</small><p><b>正文：</b>{taskContract.bodyRole}</p><p><b>评论：</b>{taskContract.commentRole}</p></section><section><small>真实性边界</small><p>{taskContract.boundaryPolicy}</p><p>必须包含：{taskContract.mustInclude.join('、') || '无'} · 禁止：{taskContract.forbidden.join('、') || '无'}</p><p>批准图片快照：{taskContract.imageCount} 张</p></section></div></details>
      {['queued', 'running'].includes(selected.status) && <div className="harness-progress" role="status" aria-live="polite"><div role="progressbar" aria-label="Agent 运行进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={selected.progress}><span style={{ width: `${selected.progress}%` }} /></div><p><LoaderCircle className="spin" size={15} />{selected.status === 'queued' ? `等待队列中${selected.queuePosition ? ` · 第 ${selected.queuePosition}${selected.queueLength && selected.queueLength >= selected.queuePosition ? `/${selected.queueLength}` : ''} 位` : ''}` : 'Agent 正在自主决定下一步'}；页面可关闭，任务会在独立队列继续运行。<b>{selected.progress}%</b></p></div>}
      {pollWarning && ['queued', 'running'].includes(selected.status) && <div className="harness-result-notice warning" role="alert"><TriangleAlert size={18} /><div><strong>状态刷新暂时中断</strong><p>{pollWarning}。后台任务不会因此停止；可等待自动恢复或手动刷新。</p><Button variant="secondary" onClick={() => void loadList()}>立即刷新</Button></div></div>}
      {selected.status === 'failed' && failureGuidance && <div className="harness-failure" role="alert"><TriangleAlert size={19} /><div><strong>本次没有产生候选</strong><p>{failureGuidance.message}</p><Button variant="secondary" icon={failureGuidance.action === 'retry' ? <RotateCcw size={14} /> : <Sparkles size={14} />} loading={actionBusy} onClick={() => failureGuidance.action === 'retry' ? void retry() : navigate('/settings')}>{failureGuidance.actionLabel}</Button></div></div>}
      {selected.status === 'completed' && <>
        {completedResultState === 'missing_candidates' && <div className="harness-result-notice error" role="alert"><CircleAlert size={18} /><div><strong>运行已结束，但候选结果缺失</strong><p>这不是可发布的空结果，可能来自历史迁移或异常写入。原运行保留用于审计，请创建独立重试运行。</p><Button variant="secondary" icon={<RotateCcw size={14} />} loading={actionBusy} onClick={() => void retry()}>创建独立重试运行</Button></div></div>}
        {reviewBlocked && <div className="harness-result-notice warning" role="alert"><TriangleAlert size={18} /><div><strong>候选已保留，最终复核未完成</strong><p>{selected.reviewError || '事实盘点或结构化复核未完成，因此三套候选仍被硬性阻断。可只重试最终复核，不会重新检索、读证据或生成正文。'}</p><Button variant="secondary" icon={<RotateCcw size={14} />} loading={actionBusy} disabled={!canRun} onClick={() => void retryReview()}>只重试最终复核</Button></div></div>}
        {completedResultState === 'all_blocked' && !reviewBlocked && <div className="harness-result-notice warning" role="alert"><TriangleAlert size={18} /><div><strong>所有候选均被自动校验阻断</strong><p>候选仍保留用于核对问题，但暂不能复制或导出。请查看每套的具体阻断项，再决定改稿或创建独立重试。</p><Button variant="secondary" icon={<RotateCcw size={14} />} loading={actionBusy} onClick={() => void retry()}>创建独立重试运行</Button></div></div>}
        <div className="harness-run-summary">
          <section><small>创作决策摘要</small><p>{selected.decisionSummary || '未提供摘要'}</p></section>
          <section><small>最终自评 / 事实盘点</small><p>{selected.reviewSummary || '未提供摘要'}</p><p>{selected.claimAuditSummary || '未提供事实盘点摘要'}</p></section>
          <section><small>运行成本与素材</small><p>{selected.usage?.modelCalls ?? 0} 次模型调用 · {selected.usage?.toolCalls ?? 0} 次工具动作 · {selected.usage?.replans ?? 0} 次重规划</p><p>{selected.imageSnapshot?.length ?? 0} 张已批准图片快照</p></section>
        </div>
        <details className="harness-trace-panel">
          <summary><FileSearch size={16} />自主探索轨迹 · {selected.traces?.length ?? 0} 步</summary>
          <div>{selected.traces?.map((trace) => <article key={trace.sequence}><span>{trace.sequence}</span><i>{trace.action === 'search_knowledge' ? <Search size={15} /> : trace.action === 'read_evidence' ? <Database size={15} /> : <Send size={15} />}</i><div><strong>{traceLabel(trace.action)}</strong><p>{trace.summary || '无额外摘要'}</p></div></article>)}</div>
        </details>
        {selected.candidates?.length ? <section className="harness-candidate-chooser" aria-label="候选方案对照">
          <header><div><span className="v2-lab-id">COMPARE · THEN FOCUS</span><h3>先对照三套差异，再聚焦阅读一套</h3><p>这里比较的是结构与可用状态，不是未经标定的质量排名。</p></div><span>{selected.candidates.filter((candidate) => candidate.validation.valid).length}/{selected.candidates.length} 套可用</span></header>
          <div className="harness-approval" role="status" aria-live="polite"><div><strong>{selected.approvalStatus === 'approved' ? '已人工批准' : selected.selectedCandidateId ? '已选择终稿候选' : '尚未选择终稿'}</strong><small>{selected.approvedAt ? `批准于 ${formatDate(selected.approvedAt, true)}` : '选择候选后，再进行人工复核批准'}</small></div><input aria-label="批准备注" value={approvalNotes} onChange={(event) => setApprovalNotes(event.target.value)} maxLength={2000} placeholder="批准备注（可选）" /><Button variant="secondary" loading={actionBusy} disabled={!canExport || !selected.selectedCandidateId || selected.approvalStatus === 'approved'} onClick={() => void approveFinalCandidate()}>批准所选终稿</Button></div>
          <div className="harness-candidate-tabs">{selected.candidates.map((candidate) => {
            const issueCount = candidate.validation.issues.filter((issue) => issue.severity === 'error').length;
            return <button type="button" key={candidate.id} aria-pressed={activeCandidate?.id === candidate.id} className={activeCandidate?.id === candidate.id ? 'selected' : ''} onClick={() => setActiveCandidateId(candidate.id)}>
              <span><i>方案 {candidate.candidateIndex + 1}</i><Badge tone={candidate.validation.valid ? 'positive' : 'danger'}>{candidate.validation.valid ? '可用' : `${issueCount} 阻断`}</Badge></span>
              <strong>{candidate.content.N.title}</strong><p>{candidate.concept}</p>
              <small>{candidate.content.N.body.length} 字正文 · {candidate.content.Cref.threads.length} 条问答 · {candidate.content.N.imageSequence.length} 张图</small>
            </button>;
          })}</div>
          {activeCandidate && <div className="harness-final-choice"><span>当前聚焦：方案 {activeCandidate.candidateIndex + 1}</span><Button variant="secondary" loading={actionBusy} disabled={!canEdit || !activeCandidate.validation.valid || selected.selectedCandidateId === activeCandidate.id} onClick={() => void selectFinalCandidate(activeCandidate.id)}>{selected.selectedCandidateId === activeCandidate.id ? '已选为终稿' : '选为终稿候选'}</Button></div>}
          <div className="harness-candidate-matrix" role="table" aria-label="候选结构对照">
            <div role="row"><span role="columnheader">对照维度</span>{selected.candidates.map((candidate) => <strong role="columnheader" key={candidate.id}>方案 {candidate.candidateIndex + 1}</strong>)}</div>
            <div role="row"><span role="rowheader">入口 / 身份</span>{selected.candidates.map((candidate) => <b role="cell" key={candidate.id}>{candidate.content.publishing.entryPoint}<small>{candidate.content.publishing.accountIdentity}</small></b>)}</div>
            <div role="row"><span role="rowheader">正文 / 评论</span>{selected.candidates.map((candidate) => <b role="cell" key={candidate.id}>{candidate.content.N.body.length} 字<small>{candidate.content.Cref.threads.length} 条线程</small></b>)}</div>
            <div role="row"><span role="rowheader">执行承接</span>{selected.candidates.map((candidate) => <b role="cell" key={candidate.id}>{candidate.content.publishing.responseSla || '旧运行未记录'}<small>{candidate.content.publishing.liveQuestionRoutes?.length ?? 0} 条分流</small></b>)}</div>
          </div>
        </section> : null}
        <div className="harness-candidates">{activeCandidate && <CandidateCard key={activeCandidate.id} jobId={selected.id} candidate={activeCandidate} imageSnapshot={selected.imageSnapshot} onRevise={setRevisionCandidate} canRevise={canRevise} canExport={canExport} />}</div>
        {selected.derivedRuns?.length ? <section className="harness-derived"><h3>由本次派生的运行</h3>{selected.derivedRuns.map((run) => <button type="button" key={run.id} onClick={() => navigate(`/agent-harness/${run.id}`)}><span>{runKindLabel(run.runKind)}</span><strong>{run.topic}</strong><small>{statusLabel(run)} · {formatDate(run.createdAt, true)}</small></button>)}</section> : null}
      </>}
    </section>}

    <Modal open={trashOpen} title="Agent 运行回收站" description="删除记录保留 30 天，期间可恢复；也可永久删除候选、证据快照和轨迹。" onClose={() => setTrashOpen(false)}>
      {trashLoading ? <Skeleton lines={4} /> : trashError ? <EmptyState icon={<TriangleAlert size={22} />} title="回收站加载失败" description={trashError} action={<Button variant="secondary" onClick={() => void loadTrash()}>重试</Button>} /> : trash.length ? <><div className="harness-trash-list">{trash.map((job) => <article key={job.id}><div><strong>{job.topic}</strong><small>{runKindLabel(job.runKind)} · 删除于 {formatDate(job.deletedAt || job.updatedAt, true)} · 自动清理 {job.purgeAfter ? formatDate(job.purgeAfter, true) : '未记录'}</small></div><div><Button variant="secondary" icon={<ArchiveRestore size={14} />} loading={actionBusy} disabled={!canEdit} onClick={() => void restoreFromTrash(job.id)}>恢复</Button><Button variant="danger" icon={<Trash2 size={14} />} loading={actionBusy} disabled={!canEdit} onClick={() => void purgeFromTrash(job.id)}>永久删除</Button></div></article>)}</div>{trashFetched < trashTotal && <div className="harness-load-more"><Button variant="ghost" loading={trashLoadingMore} onClick={() => void loadMoreTrash()}>加载更多（已显示 {trash.length}/{trashTotal}）</Button></div>}</> : <EmptyState icon={<ArchiveRestore size={22} />} title="回收站为空" description="删除的 Agent 运行会在 30 天保留期内出现在这里。" />}
    </Modal>

    <Modal open={Boolean(revisionCandidate)} title="创建独立改稿运行" description="只修订当前所选发布包，不再生成另外两套；原候选保持不变。" onClose={() => { setRevisionCandidate(null); setRevisionInstruction(''); }} footer={<><Button variant="secondary" onClick={() => { setRevisionCandidate(null); setRevisionInstruction(''); }}>取消</Button><Button loading={actionBusy} disabled={!canRevise || !revisionInstruction.trim()} onClick={() => void revise()}>提交改稿</Button></>}>
      <Field label="修改要求" required><textarea rows={6} maxLength={2000} value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} placeholder="例如：保留事实边界，把正文改得更口语，并强化开头冲突。" /></Field>
    </Modal>
  </div>;
}
