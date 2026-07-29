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
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, EmptyState, Field, Modal, Skeleton, useToast } from '../components/Ui';
import { V2Hero, V2Instrument, V2InstrumentCell, V2SecLabel } from '../components/V2';
import { api } from '../lib/api';
import { formatBytes, formatDate } from '../lib/utils';
import { KnowledgeEnrichmentModal } from '../components/knowledge/KnowledgeEnrichmentModal';
import { enrichButtonLabel, gapStats, pendingCount } from '../lib/enrich-types';
import type { EvidenceStatus, InformationGap, KnowledgeFile } from '../types';

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
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);
  const toast = useToast();

  const gapTiers = gapStats(gaps);
  const pendingGapCount = pendingCount(gapTiers);

  const load = () => {
    if (!projectId) {
      setFiles([]);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    api.knowledge.list(projectId)
      .then((result) => setFiles(result.items))
      .catch((error) => setLoadError(error instanceof Error ? error.message : '知识文件加载失败'))
      .finally(() => setLoading(false));
    // 缺口加载失败不算页面失败:这个页面的主体是文件列表,补充入口是附加能力
    api.informationGaps.list(projectId).then((r) => setGaps(r.items)).catch(() => setGaps([]));
  };
  useEffect(load, [projectId]);

  const visibleFiles = useMemo(() => files.filter((file) => (category === 'all' || file.category === category) && (!search || `${file.name}${file.summary || ''}`.toLowerCase().includes(search.toLowerCase()))), [files, search, category]);
  const indexFile = files.find((file) => file.name.toUpperCase() === 'INDEX.MD');
  const kindCounts = useMemo(() => ({
    fact: files.filter((file) => file.kind === '已知事实').length,
    reasoning: files.filter((file) => file.kind === '方法论推理' || file.kind === '猜想').length,
    banned: files.filter((file) => file.kind === '禁止表达').length,
    totalSize: formatBytes(files.reduce((sum, file) => sum + file.size, 0)),
  }), [files]);

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
    setUploading(true);
    try {
      const result = await api.knowledge.upload(projectId, pendingFile, uploadCategory, uploadKind);
      setFiles((current) => [result, ...current]);
      toast.push('知识文件已导入');
      setUploadOpen(false);
      setPendingFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '知识文件导入失败', 'error');
    } finally {
      setUploading(false);
    }
  };

  const resetEntry = () => { setEntryOpen(false); setEntryName(''); setEntryText(''); setEntryCategory('未分类'); setEntryKind('已知事实'); };

  const handleCreate = async () => {
    if (!projectId) return;
    const text = entryText.trim();
    if (!text) { toast.push('请填写知识内容', 'error'); return; }
    let name = entryName.trim();
    if (!name) { toast.push('请填写标题', 'error'); return; }
    if (!/\.(md|txt)$/i.test(name)) name = `${name}.md`;
    if (new Blob([text]).size > 2 * 1024 * 1024) { toast.push('单份知识不能超过 2 MB', 'error'); return; }
    setSaving(true);
    try {
      const result = await api.knowledge.create(projectId, name, text, entryCategory, entryKind);
      setFiles((current) => [result, ...current]);
      toast.push('知识已保存');
      resetEntry();
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (file: KnowledgeFile) => {
    if (!window.confirm(`确定删除「${file.name}」吗？历史内容仍会保留当时的知识快照。`)) return;
    try {
      await api.knowledge.remove(file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
      toast.push('文件已删除');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  const openPreview = async (file: KnowledgeFile) => {
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setPreview({ name: file.name, content: '' });
    try {
      const full = await api.knowledge.get(file.id);
      if (seq !== previewSeq.current) return;
      setPreview({ name: file.name, content: full.content || '（文件为空）' });
    } catch {
      if (seq !== previewSeq.current) return;
      setPreview({ name: file.name, content: '无法加载文件内容。' });
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  return (
    <div className="page knowledge-page">
      <V2Hero
        status={<>{currentProject?.name || '当前项目'} · {indexFile ? '知识地图已就绪 · 可全量注入' : '等待建立索引'}</>}
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
          label="文件总数"
          value={files.length}
          unit="份"
          note={`共 ${kindCounts.totalSize} · 预算内全量注入`}
        />
        <V2InstrumentCell
          tone="ok"
          icon={<CheckCircle2 size={15} />}
          label="已知事实"
          value={kindCounts.fact}
          unit="份"
          note="已确认，可直接引用"
        />
        {gapTiers.total > 0 && (
          <V2InstrumentCell
            tone={pendingGapCount > 0 ? 'warn' : 'ok'}
            icon={<WandSparkles size={15} />}
            label="资料完整度"
            value={`${gapTiers.supplied}/${gapTiers.total}`}
            note={pendingGapCount > 0
              ? `${gapTiers.unknown} 项没有资料，${gapTiers.inferred} 项靠推断`
              : '决策关键信息已齐备'}
          />
        )}
        <V2InstrumentCell
          tone="ai"
          icon={<BrainCircuit size={15} />}
          label="推理与猜想"
          value={kindCounts.reasoning}
          unit="份"
          note="推断内容，需人工复核"
        />
        <V2InstrumentCell
          tone="error"
          icon={<Ban size={15} />}
          label="禁止表达"
          value={kindCounts.banned}
          unit="份"
          note="风险词与承诺边界，约束生效中"
        />
      </V2Instrument>

      <section className="panel knowledge-table-panel">
        <header className="panel__header">
          <div>
            <h2><V2SecLabel>LIB · 文件台账</V2SecLabel>全部知识文件</h2>
            <p>知识库较小时会全量注入；超出上下文预算时，按知识地图继续披露相关文件。</p>
          </div>
        </header>
        <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或摘要" />{search && <button type="button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14} /></button>}</div><label className="filter-select"><Filter size={16} /><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><span className="table-toolbar__count">{visibleFiles.length} 份文件</span></div>
        {loading ? <div className="table-loading"><Skeleton lines={5} /></div> : loadError ? <EmptyState icon={<TriangleAlert size={24} />} title="知识文件加载失败" description={loadError} action={<Button variant="secondary" icon={<RefreshCcw size={16} />} onClick={load}>重试</Button>} /> : visibleFiles.length ? <div className="data-table knowledge-table"><div className="data-table__head"><span>编号</span><span>文件</span><span>知识性质</span><span>分类</span><span>版本 / 更新</span><span /></div>{visibleFiles.map((file, fileIndex) => <div className="data-table__row" key={file.id}><span className="v2-lab-id">K-{String(fileIndex + 1).padStart(3, '0')}</span><span className="file-cell"><i className={file.name.endsWith('.md') ? 'md' : 'txt'}>{file.name.endsWith('.md') ? 'MD' : 'TXT'}</i><span><strong>{file.name}</strong><small>{file.summary || `${formatBytes(file.size)} · 暂无摘要`}</small></span></span><span><Badge tone={file.kind === '已知事实' ? 'positive' : file.kind === '禁止表达' ? 'danger' : file.kind === '猜想' ? 'purple' : file.kind === '方法论推理' ? 'blue' : 'neutral'}>{file.kind || '未标记'}</Badge></span><span>{file.category || '未分类'}</span><span className="version-cell"><strong>v{file.version || 1}</strong><small>{formatDate(file.updatedAt, true)}</small></span><span className="row-actions"><button type="button" className="icon-button" title="删除" aria-label="删除" onClick={() => remove(file)}><Trash2 size={16} /></button><button type="button" className="icon-button" title="查看内容" aria-label="查看内容" onClick={() => void openPreview(file)}><MoreHorizontal size={17} /></button></span></div>)}</div> : <EmptyState icon={<FileText size={24} />} title="没有找到知识文件" description={search || category !== 'all' ? '试试清除搜索或分类条件。' : '导入第一份 Markdown 或文本文件后开始生成。'} action={!search && category === 'all' ? <Button icon={<Plus size={16} />} onClick={() => setUploadOpen(true)}>导入文件</Button> : undefined} />}
      </section>

      <Modal open={uploadOpen} onClose={() => { if (uploading) return; setUploadOpen(false); setPendingFile(null); if (inputRef.current) inputRef.current.value = ''; }} title="导入知识文件" description="首版支持 Markdown 与纯文本，单文件最大 2 MB。" footer={<><Button variant="ghost" disabled={uploading} onClick={() => { setUploadOpen(false); setPendingFile(null); if (inputRef.current) inputRef.current.value = ''; }}>取消</Button><Button loading={uploading} disabled={!pendingFile} onClick={handleUpload}>确认导入</Button></>}>
        <div className="upload-form"><button type="button" className={`dropzone ${pendingFile ? 'dropzone--selected' : ''}`} onClick={() => inputRef.current?.click()}><input ref={inputRef} type="file" accept=".md,.txt,text/markdown,text/plain" onChange={chooseFile} hidden />{pendingFile ? <><CheckCircle2 size={28} /><strong>{pendingFile.name}</strong><span>{formatBytes(pendingFile.size)} · 点击更换</span></> : <><UploadCloud size={30} /><strong>点击选择 .md 或 .txt 文件</strong><span>文件内容只作为数据，不会覆盖 Agent 系统规则</span></>}</button><p className="upload-note">分类与性质只是<strong>标注标签</strong>，用于列表分组和检索，<strong>不会改变文件的读取或提取方式</strong>。所有知识在分析时都以全文一并提供给模型，不按分类走不同解析。</p><div className="field-grid field-grid--two"><Field label="知识分类" hint="仅用于分组和筛选，不影响提取"><select value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="知识性质" hint="标注证据强度，供你和模型参考，不切换提取逻辑"><select value={uploadKind} onChange={(event) => setUploadKind(event.target.value as EvidenceStatus)}>{evidenceKinds.map((item) => <option key={item}>{item}</option>)}</select></Field></div></div>
      </Modal>

      <Modal open={entryOpen} onClose={resetEntry} title="直接录入知识" description="直接输入内容并保存为知识条目，无需先准备文件；保存后与上传文件同等参与分析。" footer={<><Button variant="ghost" onClick={resetEntry}>取消</Button><Button loading={saving} disabled={!entryName.trim() || !entryText.trim()} onClick={handleCreate}>保存知识</Button></>}>
        <div className="upload-form"><Field label="标题" hint="用于列表显示与版本归并；未带 .md/.txt 时自动补 .md"><input value={entryName} onChange={(event) => setEntryName(event.target.value)} placeholder="例如：项目核心卖点与事实边界" maxLength={180} /></Field><Field label="知识内容" hint="支持 Markdown 或纯文本，最大 2 MB"><textarea rows={10} value={entryText} onChange={(event) => setEntryText(event.target.value)} placeholder="在此粘贴或输入知识内容……" /></Field><p className="upload-note">分类与性质只是<strong>标注标签</strong>，用于列表分组和检索，<strong>不会改变内容的读取或提取方式</strong>。所有知识在分析时都以全文一并提供给模型。</p><div className="field-grid field-grid--two"><Field label="知识分类" hint="仅用于分组和筛选，不影响提取"><select value={entryCategory} onChange={(event) => setEntryCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="知识性质" hint="标注证据强度，供你和模型参考，不切换提取逻辑"><select value={entryKind} onChange={(event) => setEntryKind(event.target.value as EvidenceStatus)}>{evidenceKinds.map((item) => <option key={item}>{item}</option>)}</select></Field></div></div>
      </Modal>

      <Modal open={Boolean(preview)} onClose={() => { previewSeq.current += 1; setPreviewLoading(false); setPreview(null); }} title={preview?.name || '文件内容'} description="只读预览。文件内容仅作为数据，不会覆盖 Agent 系统规则。">
        {previewLoading ? <Skeleton lines={6} /> : <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>{preview?.content}</pre>}
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
