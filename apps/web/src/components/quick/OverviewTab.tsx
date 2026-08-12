import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Gauge, Layers, Lightbulb, Map, RefreshCw, Server, Trash2, TriangleAlert } from 'lucide-react';
import { useProjects } from '../ProjectContext';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import {
  deriveNextAction,
  parseCities,
  parseDoctors,
  formatCities,
  formatDoctors,
  type AnalysisState,
  type QuickTab,
} from '../../lib/quick-channel-state';
import { V2Instrument, V2InstrumentCell, type V2InstrumentTone } from '../V2';
import { quotaCell, type QuotaSnapshot } from '../../lib/quota-view';
import { overviewDigest } from '../../lib/overview-digest';
import type { GenerationJob, Project, ProjectIntelligence, TopicOpportunity } from '../../types';

interface Props {
  project: Project;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  goTo: (tab: QuickTab) => void;
  onProjectUpdated: (p: Project) => void;
  onProjectDeleted: () => void;
}

type OverviewSource = 'intelligence' | 'opportunities' | 'generations' | 'quota';

const SOURCE_LABELS: Record<OverviewSource, string> = {
  intelligence: '内容地图',
  opportunities: '选题池',
  generations: '产出记录',
  quota: '额度',
};

// 内容地图仪表格:tone 与文案按分析态给(V2InstrumentTone 无 muted,未分析用 blue 灰蓝表达「未知」)
const MAP_CELL: Record<AnalysisState, { tone: V2InstrumentTone; value: string }> = {
  none: { tone: 'blue', value: '未分析' },
  draft: { tone: 'ai', value: '待确认' },
  stale: { tone: 'warn', value: '需更新' },
  ready: { tone: 'ok', value: '已就绪' },
  failed: { tone: 'error', value: '分析失败' },
};

export function OverviewTab({ project, busy, setBusy, fail, goTo, onProjectUpdated, onProjectDeleted }: Props) {
  const { updateProject, removeProject } = useProjects();
  const toast = useToast();
  const [intel, setIntel] = useState<ProjectIntelligence | null>(null);
  const [opps, setOpps] = useState<TopicOpportunity[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [renaming, setRenaming] = useState('');
  const [domain, setDomain] = useState('');
  const [description, setDescription] = useState('');
  const [citiesInput, setCitiesInput] = useState('');
  const [doctorsInput, setDoctorsInput] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<OverviewSource, string>>>({});
  const loadSequence = useRef(0);
  const activeProjectId = useRef(project.id);
  activeProjectId.current = project.id;

  const loadOverview = async (targetProjectId = project.id, workspaceId = project.workspaceId) => {
    const sequence = ++loadSequence.current;
    setLoadingData(true);
    setLoadErrors({});
    const results = await Promise.allSettled([
      api.intelligence.get(targetProjectId),
      api.opportunities.list(targetProjectId),
      api.generations.list(targetProjectId),
      api.settings.quota(workspaceId),
    ] as const);
    if (sequence !== loadSequence.current || activeProjectId.current !== targetProjectId) return;

    const errors: Partial<Record<OverviewSource, string>> = {};
    const [intelligenceResult, opportunitiesResult, generationsResult, quotaResult] = results;
    if (intelligenceResult.status === 'fulfilled') {
      setIntel(intelligenceResult.value.status === 'missing' ? null : intelligenceResult.value);
    } else errors.intelligence = errorMessage(intelligenceResult.reason, '内容地图读取失败');
    if (opportunitiesResult.status === 'fulfilled') setOpps(opportunitiesResult.value.items);
    else errors.opportunities = errorMessage(opportunitiesResult.reason, '选题池读取失败');
    if (generationsResult.status === 'fulfilled') setJobs(generationsResult.value.items);
    else errors.generations = errorMessage(generationsResult.reason, '产出记录读取失败');
    if (quotaResult.status === 'fulfilled') setQuota(quotaResult.value);
    else errors.quota = errorMessage(quotaResult.reason, '额度读取失败');
    setLoadErrors(errors);
    setLoadingData(false);
  };

  // 挂载/换项目时四路并行读取。每一路单独保留失败语义，不能把网络故障
  // 显示成“未分析”“0 个选题”或“没有产出”。
  useEffect(() => {
    loadSequence.current += 1;
    setIntel(null);
    setOpps([]);
    setJobs([]);
    setQuota(null);
    setLoadErrors({});
    void loadOverview(project.id, project.workspaceId);
    setRenaming(project.name);
    setDomain(project.domain ?? '');
    setDescription(project.description ?? '');
    setCitiesInput(formatCities(project.cities));
    setDoctorsInput(formatDoctors(project.doctors));
    return () => { loadSequence.current += 1; };
    // Requests are scoped by ids; text-field resets also happen when either id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.workspaceId]);

  // 分析态推导(组件侧):ready 带 staleReasons 与 status='stale' 同属「需更新」;analyzing/queued 视为 none
  const staleReasons = intel?.staleReasons ?? [];
  const analyzing = intel?.status === 'analyzing' || intel?.status === 'queued';
  const analysis: AnalysisState = !intel?.id
    ? 'none'
    : intel.status === 'ready' && staleReasons.length > 0
      ? 'stale'
      : intel.status === 'stale'
        ? 'stale'
        : intel.status === 'draft'
          ? 'draft'
          : intel.status === 'failed'
            ? 'failed'
            : intel.status === 'ready'
              ? 'ready'
              : 'none';

  const collectedCount = opps.filter((o) => o.collectionStatus === 'collected').length;
  const activeCount = opps.filter((o) => o.collectionStatus !== 'collected' && o.collectionStatus !== 'archived').length;

  const action = deriveNextAction({
    hasKnowledge: (project.knowledgeCount ?? 0) > 0,
    analysis,
    topicCount: opps.length,
    generationCount: jobs.length,
  });
  const actionNote = analyzing ? '分析进行中' : action.note;

  const digest = overviewDigest(jobs);
  const quotaInfo = quotaCell(quota);
  const mapCell = loadErrors.intelligence
    ? { tone: 'error' as const, value: '读取失败' }
    : loadingData && !intel
      ? { tone: 'blue' as const, value: '读取中' }
      : MAP_CELL[analysis];
  const mapNote = loadErrors.intelligence
    ? loadErrors.intelligence
    : analysis === 'stale'
    ? staleReasons.join('；') || '资料有更新'
    : analysis === 'failed'
      ? intel?.error || undefined
      : analysis === 'draft'
        ? '生成时会自动确认,不阻塞使用'
        : undefined;
  const coreDataUnavailable = loadingData || Boolean(
    loadErrors.intelligence || loadErrors.opportunities || loadErrors.generations,
  );
  const sourceFailures = (Object.keys(loadErrors) as OverviewSource[])
    .map((source) => ({ source, message: loadErrors[source] }))
    .filter((item): item is { source: OverviewSource; message: string } => Boolean(item.message));

  const rename = async () => {
    if (!renaming.trim() || renaming.trim() === project.name) return;
    setBusy(true);
    try {
      const updated = await updateProject(project.id, { name: renaming.trim() });
      onProjectUpdated(updated);
      setBusy(false);
    } catch (e) { fail(e, '重命名失败'); }
  };

  const saveSettings = async () => {
    setBusy(true);
    try {
      const updated = await updateProject(project.id, {
        domain: domain.trim() || undefined,
        description: description.trim() || undefined,
        cities: parseCities(citiesInput),
        doctors: parseDoctors(doctorsInput),
      });
      toast.push('项目设置已保存');
      onProjectUpdated(updated);
      setBusy(false);
    } catch (e) { fail(e, '保存项目设置失败'); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await removeProject(project.id);
      setConfirmDelete(false);
      setBusy(false);
      onProjectDeleted();
    } catch (e) { fail(e, '删除项目失败'); }
  };

  return (
    <div className="qc-step">
      {sourceFailures.length > 0 && (
        <div className="inline-load-error" role="alert">
          <TriangleAlert size={15} />
          <span>
            <strong>总览数据未完整加载</strong>
            <small>{sourceFailures.map(({ source, message }) => `${SOURCE_LABELS[source]}：${message}`).join('；')}</small>
          </span>
          <Button variant="ghost" icon={<RefreshCw size={14} />} loading={loadingData} onClick={() => void loadOverview()}>重试</Button>
        </div>
      )}
      {/* 有额度可显示时扩到 5 格(BYOK 或读取失败时 quotaCell 返回 null,保持 4 格) */}
      <V2Instrument columns={4}>
        {/* text:「已就绪」「待刷新」是状态词不是读数,不用 31px 读数字号 */}
        <V2InstrumentCell text tone={mapCell.tone} icon={<Map size={14} />} label="内容地图" value={mapCell.value} note={mapNote} />
        <V2InstrumentCell tone="brand" icon={<FileText size={14} />} label="知识文件" value={project.knowledgeCount ?? 0} unit="个" />
        <V2InstrumentCell text={Boolean(loadErrors.opportunities) || loadingData} tone={loadErrors.opportunities ? 'error' : 'ai'} icon={<Lightbulb size={14} />} label="选题池" value={loadErrors.opportunities ? '读取失败' : loadingData ? '读取中' : opps.length} unit={loadErrors.opportunities || loadingData ? undefined : '个'} note={loadErrors.opportunities || loadingData ? loadErrors.opportunities : `未处理 ${activeCount} · 收藏 ${collectedCount}`} />
        <V2InstrumentCell text={Boolean(loadErrors.generations) || loadingData} tone={loadErrors.generations ? 'error' : 'ok'} icon={<Layers size={14} />} label="累计产出" value={loadErrors.generations ? '读取失败' : loadingData ? '读取中' : jobs.length} unit={loadErrors.generations || loadingData ? undefined : '篇'} note={loadErrors.generations} />
      </V2Instrument>

      {/* 额度单独一行:V2Instrument 是 4 列固定网格,塞第 5 格会让它独占第二行的
          四分之一宽,排版是坏的。这里另起一行两格:额度 + 计费口径。
          「各消耗 1 次」是核对过的——consumePlatformQuota 在生成、按意见修改、
          知识库分析三处各 +1,修改同样计费,不能只说生成。 */}
      {quotaInfo && (
        <V2Instrument columns={2}>
          <V2InstrumentCell
            tone={quotaInfo.tone}
            icon={<Gauge size={14} />}
            label="平台额度"
            value={quotaInfo.value}
            unit={quotaInfo.unit}
            note={quotaInfo.note}
          />
          <V2InstrumentCell
            text
            tone="blue"
            icon={<Server size={14} />}
            label="计费方式"
            value="平台额度"
            note="生成、按意见修改、知识库分析各消耗 1 次"
          />
        </V2Instrument>
      )}

      {/* 工作台主体:左「产出质量」右「下一步」。原来这里只有一个按钮加三行链接,
          在放宽后的面板里撑不住,也没回答运营每天真正的问题:哪些能发、还剩什么要处理。 */}
      <div className="qc-board">
        <section className="qc-board__card">
          <h3 className="qc-board__title">产出质量</h3>
          {loadErrors.generations ? (
            <p className="qc-hint qc-hint--error" role="alert">产出记录读取失败，当前不显示质量统计。</p>
          ) : loadingData ? (
            <p className="qc-hint" role="status">正在读取产出记录…</p>
          ) : digest.settled === 0 ? (
            <p className="qc-hint">还没有已完成的产出。</p>
          ) : (
            <>
              <div className="qc-quality-bar" role="img"
                aria-label={`可直接发布 ${digest.publishable} 篇，需人工核对 ${digest.needsReview} 篇，失败 ${digest.failed} 篇`}>
                <i className="qc-quality-bar__ok" style={{ width: `${digest.publishableRatio * 100}%` }} />
                <i className="qc-quality-bar__warn" style={{ width: `${digest.needsReviewRatio * 100}%` }} />
                <i className="qc-quality-bar__err" style={{ width: `${digest.failedRatio * 100}%` }} />
              </div>
              {/* 计数为 0 走中性灰:绿色的「0 可直接发布」会被读成好消息,而它相反 */}
              <ul className="qc-quality-legend">
                <li><b className={digest.publishable === 0 ? 'is-zero' : undefined}>{digest.publishable}</b><span>可直接发布</span></li>
                <li><b className={digest.needsReview === 0 ? 'is-zero' : undefined}>{digest.needsReview}</b><span>需人工核对</span></li>
                <li><b className={digest.failed === 0 ? 'is-zero' : undefined}>{digest.failed}</b><span>失败待重试</span></li>
              </ul>
              <p className="qc-board__foot">
                共 {digest.total} 篇
                {digest.inFlight > 0 && ` · ${digest.inFlight} 篇进行中`}
                {/* 「可直接发布」= 至少一个候选通过可发布校验,不是效果判断 */}
                <small>「可直接发布」指已通过可发布校验，仍建议人工过一遍</small>
              </p>
            </>
          )}
        </section>

        <section className="qc-board__card">
          <h3 className="qc-board__title">下一步</h3>
          <Button icon={<ArrowRight size={16} />} disabled={analyzing || busy || coreDataUnavailable} onClick={() => goTo(action.tab)}>{coreDataUnavailable ? loadingData ? '正在读取数据' : '数据未完整加载' : action.label}</Button>
          {!coreDataUnavailable && actionNote && <small className="qc-hint">{actionNote}</small>}
          <ul className="qc-todo">
            {!loadErrors.opportunities && activeCount > 0 && (
              <li><button type="button" onClick={() => goTo('create')}>
                <b>{activeCount}</b> 个选题待处理
              </button></li>
            )}
            {!loadErrors.generations && digest.needsReview > 0 && (
              <li><button type="button" onClick={() => goTo('history')}>
                <b>{digest.needsReview}</b> 篇需人工核对
              </button></li>
            )}
            {!loadErrors.generations && digest.failed > 0 && (
              <li><button type="button" onClick={() => goTo('history')}>
                <b>{digest.failed}</b> 篇失败可重试
              </button></li>
            )}
            {!coreDataUnavailable && activeCount === 0 && digest.needsReview === 0 && digest.failed === 0 && (
              <li className="qc-todo__clear">没有待处理事项</li>
            )}
          </ul>
        </section>
      </div>

      {!loadErrors.generations && digest.recent.length > 0 && (
        <div className="qc-overview-recent">
          <span className="qc-overview-recent__label">最近产出</span>
          <ul>
            {digest.recent.map((job) => {
              const state = job.status === 'failed'
                ? { text: '失败', tone: 'error' as const }
                : job.status === 'queued' || job.status === 'running'
                  ? { text: '进行中', tone: 'warn' as const }
                  : job.qualityStatus === 'passed'
                    ? { text: '已通过校验', tone: 'ok' as const }
                    : { text: '需核对', tone: 'warn' as const };
              return (
                <li key={job.id}>
                  <button type="button" onClick={() => goTo('history')}>
                    <strong>{job.topic || '未命名选题'}</strong>
                    <span className={`qc-badge qc-badge--${state.tone}`}>{state.text}</span>
                    <small>{job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <details className="qc-advanced">
        <summary>项目设置</summary>
        <div className="qc-advanced-grid">
          <Field label="重命名">
            <div className="qc-project-row">
              <input value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <Button variant="ghost" loading={busy} onClick={() => void rename()}>保存</Button>
            </div>
          </Field>
          <Field label="行业">
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="如:医美" />
          </Field>
          <Field label="说明">
            <textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder="项目背景、定位等" />
          </Field>
          <Field label="城市" hint="多个城市用逗号或顿号分隔">
            <input value={citiesInput} onChange={(e) => setCitiesInput(e.target.value)} placeholder="如:上海、杭州" />
          </Field>
          <Field label="医生" hint="每行一个名字">
            <textarea value={doctorsInput} rows={3} onChange={(e) => setDoctorsInput(e.target.value)} placeholder={'每行一个医生名字\n如:张三\n李四'} />
          </Field>
          <div className="qc-project-row">
            <Button variant="secondary" loading={busy} onClick={() => void saveSettings()}>保存设置</Button>
            <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>删除项目</Button>
          </div>
        </div>
      </details>

      <Modal open={confirmDelete} title="删除项目" description={`确定删除「${project.name}」？此操作不可撤销。`} onClose={() => setConfirmDelete(false)}
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>取消</Button><Button loading={busy} onClick={() => void doDelete()}>确认删除</Button></>}>
        <p className="qc-hint">项目及其知识、选题、历史都将被移除。</p>
      </Modal>
    </div>
  );
}
