import {
  Ban,
  BookOpenText,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Filter,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  TriangleAlert,
  UploadCloud,
  X,
  WandSparkles,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, EmptyState, Field, Modal, Skeleton, useToast } from '../components/Ui';
import { V2Hero, V2Instrument, V2InstrumentCell, V2SecLabel } from '../components/V2';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatBytes, formatDate } from '../lib/utils';
import { KnowledgeEnrichmentModal } from '../components/knowledge/KnowledgeEnrichmentModal';
import { enrichButtonLabel, gapStats, pendingCount } from '../lib/enrich-types';
import {
  actionableGaps,
  categoryCoverage,
  fileStats,
  historyVersions,
  latestFiles,
  preflightHeadline,
  TIER_LABEL,
  TIER_NOTE,
  TIER_TONE,
} from '../lib/knowledge-instrument';
import type { EvidenceStatus, InformationGap, KnowledgeFile, KnowledgePreflight } from '../types';

const categories = ['未分类', '知识地图', '项目与服务', '用户与场景', '案例样本', '方法论', '约束'];
const evidenceKinds: EvidenceStatus[] = ['已知事实', '案例样本', '用户观点', '方法论推理', '猜想', '信息不足', '禁止表达'];

export function KnowledgePage() {
  const { projectId, currentProject } = useProjects();
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  /* 缺口只用于「资料完整度」与补充入口;这个页面本身是文件管理视角。 */
  const [gaps, setGaps] = useState<InformationGap[]>([]);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState('');
  const [preflightError, setPreflightError] = useState('');
  const [gapsError, setGapsError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadCategory, setUploadCategory] = useState('未分类');
  const [uploadKind, setUploadKind] = useState<EvidenceStatus>('已知事实');
  const [uploading, setUploading] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [entryName, setEntryName] = useState('');
  const [entryText, setEntryText] = useState('');
  const [entryCategory, setEntryCategory] = useState('未分类');
  const [entryKind, setEntryKind] = useState<EvidenceStatus>('已知事实');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
    version?: number;
    history: KnowledgeFile[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);
  const activeProjectId = useRef(projectId);
  const loadSeq = useRef(0);
  const preflightSeq = useRef(0);
  const gapsSeq = useRef(0);
  activeProjectId.current = projectId;
  const toast = useToast();
  const navigate = useNavigate();

  const gapTiers = gapStats(gaps);
  const pendingGapCount = pendingCount(gapTiers);
  /** 完善度预检:答案到生成那一步站不站得住。与生成端同判据,服务端纯计算。 */
  const [preflight, setPreflight] = useState<KnowledgePreflight | null>(null);
  const headline = preflightHeadline(preflight);
  const openGaps = actionableGaps(preflight);
  const coverage = categoryCoverage(preflight);

  const loadPreflight = async (requestedProjectId = projectId) => {
    if (!requestedProjectId) return;
    const seq = ++preflightSeq.current;
    setPreflightError('');
    try {
      const result = await api.knowledge.preflight(requestedProjectId);
      if (activeProjectId.current !== requestedProjectId || seq !== preflightSeq.current) return;
      setPreflight(result);
    } catch (error) {
      if (activeProjectId.current !== requestedProjectId || seq !== preflightSeq.current) return;
      setPreflight(null);
      setPreflightError(errorMessage(error, '知识生成预检加载失败'));
    }
  };

  const loadGaps = async (requestedProjectId = projectId) => {
    if (!requestedProjectId) return;
    const seq = ++gapsSeq.current;
    setGapsError('');
    try {
      const result = await api.informationGaps.list(requestedProjectId);
      if (activeProjectId.current !== requestedProjectId || seq !== gapsSeq.current) return;
      setGaps(result.items);
    } catch (error) {
      if (activeProjectId.current !== requestedProjectId || seq !== gapsSeq.current) return;
      setGaps([]);
      setGapsError(errorMessage(error, '信息缺口加载失败'));
    }
  };

  const loadProject = async (requestedProjectId: string) => {
    if (!requestedProjectId) {
      setFiles([]);
      setGaps([]);
      setPreflight(null);
      setLoadError(null);
      setLoadedProjectId('');
      setPreflightError('');
      setGapsError('');
      setLoading(false);
      return;
    }
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setLoadedProjectId('');
    void loadPreflight(requestedProjectId);
    void loadGaps(requestedProjectId);
    try {
      const result = await api.knowledge.list(requestedProjectId);
      if (activeProjectId.current !== requestedProjectId || seq !== loadSeq.current) return;
      setFiles(result.items);
      setLoadedProjectId(requestedProjectId);
    } catch (error) {
      if (activeProjectId.current !== requestedProjectId || seq !== loadSeq.current) return;
      setLoadError(errorMessage(error, '知识文件加载失败'));
    } finally {
      if (activeProjectId.current === requestedProjectId && seq === loadSeq.current) setLoading(false);
    }
  };
  const load = () => loadProject(projectId);

  useEffect(() => {
    loadSeq.current += 1;
    preflightSeq.current += 1;
    gapsSeq.current += 1;
    previewSeq.current += 1;
    setFiles([]);
    setGaps([]);
    setPreflight(null);
    setLoadedProjectId('');
    setLoadError(null);
    setPreflightError('');
    setGapsError('');
    setPreview(null);
    setPreviewLoading(false);
    setEnrichOpen(false);
    setSearch('');
    setCategory('all');
    setUploadOpen(false);
    setPendingFile(null);
    setEntryOpen(false);
    setEntryName('');
    setEntryText('');
    setUploading(false);
    setSaving(false);
    if (inputRef.current) inputRef.current.value = '';
    void loadProject(projectId);
    return () => {
      loadSeq.current += 1;
      preflightSeq.current += 1;
      gapsSeq.current += 1;
      previewSeq.current += 1;
    };
  }, [projectId]);

  /*
   * 列表与计数一律基于「每个文件名的最新版本」。
   *
   * /api/knowledge 返回全部版本(service.list 不折叠),此前页面直接按行渲染与计数:
   * 一份资料被 AI 补充过一次就显示成两行、编号占两个、「2 份文件」、字节两版相加,
   * 而且同一份资料在「已知事实」和「推理与猜想」里各占一个计数。生成端只读最新版,
   * 界面必须和它一致。历史版本移到详情弹窗里回看。
   */
  const currentFiles = useMemo(() => latestFiles(files), [files]);
  const visibleFiles = useMemo(() => currentFiles.filter((file) => (category === 'all' || file.category === category) && (!search || `${file.name}${file.summary || ''}`.toLowerCase().includes(search.toLowerCase()))), [currentFiles, search, category]);
  const indexFile = currentFiles.find((file) => file.name.toUpperCase() === 'INDEX.MD');
  const stats = useMemo(() => fileStats(files), [files]);
  const knowledgeStatus = loadedProjectId !== projectId
    ? loadError ? '知识状态不可用' : '知识状态加载中'
    : indexFile ? '知识地图已就绪' : '等待建立索引';

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name)) {
      toast.push('只支持 .md 和 .txt 文件', 'error');
      event.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.push('单个知识文件不能超过 2 MB', 'error');
      event.target.value = '';
      return;
    }
    setPendingFile(file);
  };

  const handleUpload = async () => {
    if (!pendingFile || !projectId) return;
    const requestedProjectId = projectId;
    const requestedFile = pendingFile;
    setUploading(true);
    try {
      const result = await api.knowledge.upload(requestedProjectId, requestedFile, uploadCategory, uploadKind);
      if (activeProjectId.current !== requestedProjectId) return;
      setFiles((current) => [result, ...current]);
      // 新资料可能让原本无依据的答案有了支撑,预检要重算
      void loadPreflight(requestedProjectId);
      toast.push('知识文件已导入');
      setUploadOpen(false);
      setPendingFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (error) {
      if (activeProjectId.current === requestedProjectId) {
        toast.push(errorMessage(error, '知识文件导入失败'), 'error');
      }
    } finally {
      if (activeProjectId.current === requestedProjectId) setUploading(false);
    }
  };

  const resetEntry = () => { setEntryOpen(false); setEntryName(''); setEntryText(''); setEntryCategory('未分类'); setEntryKind('已知事实'); };

  const handleCreate = async () => {
    if (!projectId) return;
    const requestedProjectId = projectId;
    const text = entryText.trim();
    if (!text) { toast.push('请填写知识内容', 'error'); return; }
    let name = entryName.trim();
    if (!name) { toast.push('请填写标题', 'error'); return; }
    if (!/\.(md|txt)$/i.test(name)) name = `${name}.md`;
    if (new Blob([text]).size > 2 * 1024 * 1024) { toast.push('单份知识不能超过 2 MB', 'error'); return; }
    setSaving(true);
    try {
      const result = await api.knowledge.create(requestedProjectId, name, text, entryCategory, entryKind);
      if (activeProjectId.current !== requestedProjectId) return;
      setFiles((current) => [result, ...current]);
      void loadPreflight(requestedProjectId);
      toast.push('知识已保存');
      resetEntry();
    } catch (error) {
      if (activeProjectId.current === requestedProjectId) {
        toast.push(errorMessage(error, '保存失败'), 'error');
      }
    } finally {
      if (activeProjectId.current === requestedProjectId) setSaving(false);
    }
  };

  const remove = async (file: KnowledgeFile) => {
    /*
     * 删的是「当前生效版本」这一行。有历史版本时,删完上一版会自动变成生效版本
     * ——实测:生成端的 window function 先过滤 deleted_at 再排名,所以删 v2 之后
     * v1 成为 rank 1,生成从此读 v1 的内容。这不是「删掉一份资料」,是「回退一版」,
     * 必须说明白,否则用户以为只是清理列表。
     */
    const history = historyVersions(files, file.name);
    const previous = history[0];
    const confirmText = previous
      ? `「${file.name}」当前生效的是 v${file.version ?? 1}。删除后会回退到 v${previous.version ?? 1}，生成将改用那一版的内容。确定删除吗？`
      : `确定删除「${file.name}」吗？这是它唯一的版本，删除后该项目不再有这份资料。`;
    if (!window.confirm(confirmText)) return;
    const requestedProjectId = projectId;
    try {
      await api.knowledge.remove(file.id);
      if (activeProjectId.current !== requestedProjectId) return;
      setFiles((current) => current.filter((item) => item.id !== file.id));
      toast.push(previous ? `已回退到 v${previous.version ?? 1}` : '文件已删除');
      // 资料变了,答案的证据支撑也就变了,预检必须重算
      void loadPreflight(requestedProjectId);
    } catch (error) {
      if (activeProjectId.current === requestedProjectId) {
        toast.push(errorMessage(error, '删除失败'), 'error');
      }
    }
  };

  const openPreview = async (file: KnowledgeFile) => {
    const seq = ++previewSeq.current;
    const requestedProjectId = projectId;
    setPreviewLoading(true);
    /*
     * 打开的是哪一版就显示哪一版的历史。点历史里的某一版时,它自己不该再出现在
     * 自己的历史列表里——historyVersions 按文件名取全部版本、去掉最高版,所以这里
     * 要排除当前正在看的这一版。
     */
    const history = historyVersions(files, file.name).filter((item) => item.id !== file.id);
    const base = { name: file.name, version: file.version, history };
    setPreview({ ...base, content: '' });
    try {
      const full = await api.knowledge.get(file.id);
      if (activeProjectId.current !== requestedProjectId || seq !== previewSeq.current) return;
      setPreview({ ...base, content: full.content || '（文件为空）' });
    } catch {
      if (activeProjectId.current !== requestedProjectId || seq !== previewSeq.current) return;
      setPreview({ ...base, content: '无法加载文件内容。' });
    } finally {
      if (activeProjectId.current === requestedProjectId && seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  return (
    <div className="page knowledge-page">
      {/*
        status 原文案是「知识地图已就绪 · 可全量注入」——后半句是无条件为真的话:
        前端不查预算,真实判定在服务端(assertKnowledgeContextBudget /
        selectKnowledgeContext)。只报索引状态,不替服务端承诺注入方式。
      */}
      <V2Hero
        status={<>{currentProject?.name || '当前项目'} · {knowledgeStatus}</>}
        title="项目知识库"
        description={`「${currentProject?.name || '当前项目'}」的事实、样本、方法与表达边界。`}
        actions={
          <>
{pendingGapCount > 0 && (
              <button type="button" className="v2-hero__link" onClick={() => setEnrichOpen(true)}>
                <WandSparkles size={15} /> {enrichButtonLabel(pendingGapCount)}
              </button>
            )}
            <button type="button" className="v2-hero__link" onClick={() => setEntryOpen(true)}>
              <PenLine size={15} /> 直接录入
            </button>
            <Button icon={<UploadCloud size={17} />} onClick={() => setUploadOpen(true)}>导入文件</Button>
          </>
        }
      />

      <V2Instrument>
        <V2InstrumentCell
          tone="blue"
          icon={<BookOpenText size={15} />}
          label="资料份数"
          value={stats.fileCount}
          unit="份"
          note={stats.versionCount > stats.fileCount
            // 有历史版本时说清计数口径:生成只用最新版,份数按文件算不按版本算
            ? `共 ${formatBytes(stats.totalBytes)} · ${stats.versionCount} 个版本，生成用最新版`
            : `共 ${formatBytes(stats.totalBytes)}`}
        />
        {/*
          预检替代原先的「已知事实 N 份 / 资料完整度 N/M」。
          原实现按版本数计数,且把「有答案」等同于「可直接引用」——而生成端真正要求的是
          答案有证据支撑。预检与生成端同判据,所以这里显示的能生成/不能生成是可信的。
        */}
        {headline && (
          <V2InstrumentCell
            tone={headline.tone}
            icon={<CheckCircle2 size={15} />}
            label="生成就绪度"
            value={headline.text}
            note={headline.nextStep
              || (preflight!.requiredOpen.length
                ? `必答缺口:${preflight!.requiredOpen.map((item) => item.label).join('、')}`
                : '按必答缺口是否落实判断，与生成端同一判据')}
          />
        )}
        {preflight && preflight.tiers.evidence_backed > 0 && (
          <V2InstrumentCell
            tone={TIER_TONE.evidence_backed}
            icon={<CheckCircle2 size={15} />}
            label={TIER_LABEL.evidence_backed}
            value={preflight.tiers.evidence_backed}
            unit="条"
            note={TIER_NOTE.evidence_backed}
          />
        )}
        {preflight && preflight.tiers.approved_only > 0 && (
          <V2InstrumentCell
            tone={TIER_TONE.approved_only}
            icon={<BrainCircuit size={15} />}
            label={TIER_LABEL.approved_only}
            value={preflight.tiers.approved_only}
            unit="条"
            note={TIER_NOTE.approved_only}
          />
        )}
        {preflight && preflight.tiers.will_be_dropped > 0 && (
          <V2InstrumentCell
            tone={TIER_TONE.will_be_dropped}
            icon={<TriangleAlert size={15} />}
            label={TIER_LABEL.will_be_dropped}
            value={preflight.tiers.will_be_dropped}
            unit="条"
            note={TIER_NOTE.will_be_dropped}
          />
        )}
        {preflight && preflight.tiers.blank > 0 && (
          <V2InstrumentCell
            tone={TIER_TONE.blank}
            icon={<WandSparkles size={15} />}
            label={TIER_LABEL.blank}
            value={preflight.tiers.blank}
            unit="条"
            note={TIER_NOTE.blank}
          />
        )}
        {stats.banned > 0 && (
          <V2InstrumentCell
            tone="error"
            icon={<Ban size={15} />}
            label="禁止表达"
            value={stats.banned}
            unit="份"
            note="风险词与承诺边界，约束生效中"
          />
        )}
      </V2Instrument>

      {(preflightError || gapsError) && (
        <div className="inline-load-error" role="alert">
          <TriangleAlert size={17} />
          <span>
            <strong>资料完整度暂不可用</strong>
            <small>{[preflightError, gapsError].filter(Boolean).join('；')}。文件台账仍可管理，但页面不会据此显示生成就绪或缺口数量。</small>
          </span>
          <Button variant="ghost" onClick={() => { if (preflightError) void loadPreflight(projectId); if (gapsError) void loadGaps(projectId); }}>重试</Button>
        </div>
      )}

      {/*
        分析未就绪时的下一步引导。
        用户传完资料后最需要的就是这一句——此前页面只显示一堆文件,没有任何指引,
        而仪表盘还错报「可以生成」。放在仪表盘下方、文件列表上方,是视线的下一站。
      */}
      {headline?.needsAnalysis && projectId && (
        <section className="panel next-step-panel" role="status">
          <div className="next-step-panel__body">
            <div>
              <h2><V2SecLabel>LIB · 下一步</V2SecLabel>{headline.text.replace(/^下一步:/u, '')}</h2>
              <p>{headline.nextStep}</p>
            </div>
            {/*
              去科研版自己的分析界面(/generate 默认 simple 模式渲染
              IntelligentSimpleFlow,项目分析、蓝图确认、缺口池都在那里),
              不是快捷版工作台——这个页面属于科研版,跳到基础版是串了产品线。
            */}
            <Button
              icon={<WandSparkles size={16} />}
              onClick={() => navigate('/generate')}
            >
              去分析
            </Button>
          </div>
        </section>
      )}

      {preflight && (openGaps.length > 0 || coverage.some((row) => row.settled < row.total)) && (
        <section className="panel">
          <header className="panel__header">
            <div>
              <h2><V2SecLabel>LIB · 完善建议</V2SecLabel>还要补什么</h2>
              <p>{preflight.note}</p>
            </div>
          </header>
          <div className="panel__body">
            {openGaps.length > 0 && (
              <ul className="preflight-gap-list">
                {openGaps.slice(0, 12).map((gap) => (
                  <li key={gap.id} className={`preflight-gap preflight-gap--${gap.tier}`}>
                    <div className="preflight-gap__top">
                      <strong>{gap.label}</strong>
                      {gap.required && <Badge tone="warning">必答</Badge>}
                      <Badge tone={gap.tier === 'will_be_dropped' ? 'danger' : 'neutral'}>
                        {TIER_LABEL[gap.tier]}
                      </Badge>
                    </div>
                    {/* 原因是用户能动手的唯一线索,必须逐条列出,不能只给一个档位标签 */}
                    <ul className="preflight-gap__reasons">
                      {gap.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {openGaps.length > 12 && (
              <p className="upload-note">另有 {openGaps.length - 12} 条待处理,补完上面几条后会重新统计。</p>
            )}
            {coverage.some((row) => row.settled < row.total) && (
              <div className="preflight-coverage">
                <strong>按分类看覆盖</strong>
                <ul>
                  {coverage.map((row) => (
                    <li key={row.category} className={row.settled < row.total ? 'is-open' : ''}>
                      <span>{row.category}</span>
                      <span>{row.settled}/{row.total}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preflight.warnings.length > 0 && (
              <p className="upload-note" role="alert">{preflight.warnings.join('；')}</p>
            )}
          </div>
        </section>
      )}

      <section className="panel knowledge-table-panel">
        <header className="panel__header">
          <div>
            <h2><V2SecLabel>LIB · 文件台账</V2SecLabel>全部知识文件</h2>
            <p>每份资料只显示当前生效的版本，历史版本在「查看内容」里回看。生成与分析都只使用最新版。</p>
          </div>
        </header>
        <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或摘要" />{search && <button type="button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div><label className="filter-select"><Filter size={16} /><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><span className="table-toolbar__count">{visibleFiles.length} 份文件</span></div>
        {loading ? <div className="table-loading"><Skeleton lines={5} /></div> : loadError ? <EmptyState icon={<TriangleAlert size={24} />} title="知识文件加载失败" description={loadError} action={<Button variant="secondary" icon={<RefreshCcw size={16} />} onClick={load}>重试</Button>} /> : visibleFiles.length ? <div className="data-table knowledge-table"><div className="data-table__head"><span>编号</span><span>文件</span><span>知识性质</span><span>分类</span><span>版本 / 更新</span><span /></div>{visibleFiles.map((file, fileIndex) => <div className="data-table__row" key={file.id}><span className="v2-lab-id">K-{String(fileIndex + 1).padStart(3, '0')}</span><span className="file-cell"><i className={file.name.endsWith('.md') ? 'md' : 'txt'}>{file.name.endsWith('.md') ? 'MD' : 'TXT'}</i><span><strong>{file.name}</strong><small>{file.summary || `${formatBytes(file.size)} · 暂无摘要`}</small></span></span><span><Badge tone={file.kind === '已知事实' ? 'positive' : file.kind === '禁止表达' ? 'danger' : file.kind === '猜想' ? 'purple' : file.kind === '方法论推理' ? 'blue' : 'neutral'}>{file.kind || '未标记'}</Badge></span><span>{file.category || '未分类'}</span><span className="version-cell"><strong>v{file.version || 1}</strong><small>{formatDate(file.updatedAt, true)}</small></span><span className="row-actions"><button type="button" className="icon-button" title="删除" aria-label="删除" onClick={() => remove(file)}><Trash2 size={16} /></button><button type="button" className="icon-button" title="查看内容" aria-label="查看内容" onClick={() => void openPreview(file)}><MoreHorizontal size={17} /></button></span></div>)}</div> : <EmptyState icon={<FileText size={24} />} title="没有找到知识文件" description={search || category !== 'all' ? '试试清除搜索或分类条件。' : '导入第一份 Markdown 或文本文件后开始生成。'} action={!search && category === 'all' ? <Button icon={<Plus size={16} />} onClick={() => setUploadOpen(true)}>导入文件</Button> : undefined} />}
      </section>

      <Modal open={uploadOpen} onClose={() => { if (uploading) return; setUploadOpen(false); setPendingFile(null); if (inputRef.current) inputRef.current.value = ''; }} title="导入知识文件" description="首版支持 Markdown 与纯文本，单文件最大 2 MB。" footer={<><Button variant="ghost" disabled={uploading} onClick={() => { setUploadOpen(false); setPendingFile(null); if (inputRef.current) inputRef.current.value = ''; }}>取消</Button><Button loading={uploading} disabled={!pendingFile} onClick={handleUpload}>确认导入</Button></>}>
        <div className="upload-form"><button type="button" className={`dropzone ${pendingFile ? 'dropzone--selected' : ''}`} onClick={() => inputRef.current?.click()}><input ref={inputRef} type="file" accept=".md,.txt,text/markdown,text/plain" onChange={chooseFile} hidden />{pendingFile ? <><CheckCircle2 size={28} /><strong>{pendingFile.name}</strong><span>{formatBytes(pendingFile.size)} · 点击更换</span></> : <><UploadCloud size={30} /><strong>点击选择 .md 或 .txt 文件</strong><span>文件内容只作为数据，不会覆盖 Agent 系统规则</span></>}</button><p className="upload-note">分析时会读取文件全文；但<strong>分类与知识性质会影响内容如何参与生成</strong>。只有符合证据规则的内容才可作为事实依据，「猜想」「信息不足」只作参考，「禁止表达」用于约束输出。</p><div className="field-grid field-grid--two"><Field label="知识分类" hint="用于组织、检索与知识使用范围"><select value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="知识性质" hint="决定内容能否作为事实依据被引用"><select value={uploadKind} onChange={(event) => setUploadKind(event.target.value as EvidenceStatus)}>{evidenceKinds.map((item) => <option key={item}>{item}</option>)}</select></Field></div></div>
      </Modal>

      <Modal open={entryOpen} onClose={resetEntry} title="直接录入知识" description="直接输入内容并保存为知识条目，无需先准备文件；保存后与上传文件同等参与分析。" footer={<><Button variant="ghost" onClick={resetEntry}>取消</Button><Button loading={saving} disabled={!entryName.trim() || !entryText.trim()} onClick={handleCreate}>保存知识</Button></>}>
        <div className="upload-form"><Field label="标题" hint="用于列表显示与版本归并；未带 .md/.txt 时自动补 .md"><input value={entryName} onChange={(event) => setEntryName(event.target.value)} placeholder="例如：项目核心卖点与事实边界" maxLength={180} /></Field><Field label="知识内容" hint="支持 Markdown 或纯文本，最大 2 MB"><textarea rows={10} value={entryText} onChange={(event) => setEntryText(event.target.value)} placeholder="在此粘贴或输入知识内容……" /></Field>{/*
  原文案说「分类与性质只是标注标签，不会改变内容的读取或提取方式」——和后端相反。
  knowledge.service.recategorize 的注释写得很清楚:「分类不是标签——它决定这份资料
  怎么参与生成」;api.ts 的客户端注释也是同一句。分析时确实是全文一并提供(这部分为真),
  但性质会经 evidenceStatus 映射,决定哪些主张能被当作已知事实引用。
*/}
<p className="upload-note">分析时会把全文一并提供给模型；但<strong>知识性质会影响内容怎么被引用</strong>——标为「已知事实」的才可能作为事实依据，「猜想」「信息不足」只作参考。填错可以随时改。</p><div className="field-grid field-grid--two"><Field label="知识分类" hint="用于分组和筛选"><select value={entryCategory} onChange={(event) => setEntryCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="知识性质" hint="决定内容能否作为事实依据被引用"><select value={entryKind} onChange={(event) => setEntryKind(event.target.value as EvidenceStatus)}>{evidenceKinds.map((item) => <option key={item}>{item}</option>)}</select></Field></div></div>
      </Modal>

      <Modal open={Boolean(preview)} onClose={() => { previewSeq.current += 1; setPreviewLoading(false); setPreview(null); }} title={preview ? `${preview.name}${preview.version ? ` · v${preview.version}` : ''}` : '文件内容'} description="只读预览。文件内容仅作为数据，不会覆盖 Agent 系统规则。">
        {previewLoading ? <Skeleton lines={6} /> : <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>{preview?.content}</pre>}
        {/*
          历史版本入口。列表折叠成一行后,旧版本只能从这里回看——但要说清生成用的是哪一版,
          否则「能看到 v1」会被误解成「v1 还在参与生成」。
        */}
        {preview && preview.history.length > 0 && (
          <div className="preview-versions">
            <strong>历史版本</strong>
            <p className="upload-note">生成只使用最新版；历史版本仅供回看与比对。</p>
            <ul>
              {preview.history.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => void openPreview(item)}>
                    v{item.version ?? 1} · {formatBytes(item.size)} · {formatDate(item.updatedAt, true)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {projectId && (
        <KnowledgeEnrichmentModal
          open={enrichOpen}
          projectId={projectId}
          onClose={() => setEnrichOpen(false)}
          onComplete={load}
        />
      )}
    </div>
  );
}
