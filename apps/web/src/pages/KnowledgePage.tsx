import {
  BookOpenText,
  CheckCircle2,
  FileText,
  Filter,
  FolderTree,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, EmptyState, Field, Modal, PageHeader, Skeleton, useToast } from '../components/Ui';
import { api } from '../lib/api';
import { demoKnowledge } from '../lib/fixtures';
import { formatBytes, formatDate } from '../lib/utils';
import type { EvidenceStatus, KnowledgeFile } from '../types';

const categories = ['未分类', '知识地图', '项目与服务', '用户与场景', '案例样本', '方法论', '约束'];
const evidenceKinds: EvidenceStatus[] = ['已知事实', '案例样本', '用户观点', '方法论推理', '猜想', '信息不足', '禁止表达'];

export function KnowledgePage() {
  const { projectId, currentProject } = useProjects();
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadCategory, setUploadCategory] = useState('未分类');
  const [uploadKind, setUploadKind] = useState<EvidenceStatus>('已知事实');
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = () => {
    if (!projectId) return;
    setLoading(true);
    api.knowledge.list(projectId).then((result) => setFiles(result.items)).catch(() => setFiles(demoKnowledge.filter((file) => file.projectId === projectId))).finally(() => setLoading(false));
  };
  useEffect(load, [projectId]);

  const visibleFiles = useMemo(() => files.filter((file) => (category === 'all' || file.category === category) && (!search || `${file.name}${file.summary || ''}`.toLowerCase().includes(search.toLowerCase()))), [files, search, category]);
  const indexFile = files.find((file) => file.name.toUpperCase() === 'INDEX.MD');

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
    } catch {
      setFiles((current) => [{ id: `local-${Date.now()}`, projectId, name: pendingFile.name, size: pendingFile.size, category: uploadCategory, kind: uploadKind, status: 'ready', version: 1, updatedAt: new Date().toISOString(), summary: '本地演示导入文件' }, ...current]);
      toast.push('演示模式：文件已加入列表', 'info');
    } finally {
      setUploading(false); setUploadOpen(false); setPendingFile(null); if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (file: KnowledgeFile) => {
    if (!window.confirm(`确定删除「${file.name}」吗？历史内容仍会保留当时的知识快照。`)) return;
    await api.knowledge.remove(file.id).catch(() => undefined);
    setFiles((current) => current.filter((item) => item.id !== file.id));
    toast.push('文件已删除');
  };

  const openPreview = async (file: KnowledgeFile) => {
    setPreviewLoading(true);
    setPreview({ name: file.name, content: '' });
    try {
      const full = await api.knowledge.get(file.id);
      setPreview({ name: file.name, content: full.content || '（文件为空）' });
    } catch {
      setPreview({ name: file.name, content: '无法加载文件内容。' });
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="page knowledge-page">
      <PageHeader eyebrow="KNOWLEDGE" title="项目知识库" description={`「${currentProject?.name || '当前项目'}」的事实、样本、方法与表达边界。`} actions={<Button icon={<UploadCloud size={17} />} onClick={() => setUploadOpen(true)}>导入文件</Button>} />

      <section className="knowledge-overview">
        <div className="knowledge-overview__icon"><FolderTree size={25} /></div>
        <div><span>渐进式知识地图</span><h2>{indexFile ? 'INDEX.md 已就绪' : '建议创建 INDEX.md'}</h2><p>{indexFile ? '知识库较小时会全量注入；超出上下文预算时，按知识地图继续披露相关文件。' : '将文件用途、分类和阅读顺序写入 INDEX.md，让超长知识库仍可稳定使用。'}</p></div>
        <div className="knowledge-overview__stats"><span><strong>{files.length}</strong>份文件</span><span><strong>{formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</strong>总大小</span><Badge tone={indexFile ? 'positive' : 'warning'}>{indexFile ? '可全量注入' : '等待建立索引'}</Badge></div>
      </section>

      <section className="panel knowledge-table-panel">
        <div className="table-toolbar"><div className="search-input"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名或摘要" />{search && <button onClick={() => setSearch('')}><X size={14} /></button>}</div><label className="filter-select"><Filter size={16} /><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><span className="table-toolbar__count">{visibleFiles.length} 份文件</span></div>
        {loading ? <div className="table-loading"><Skeleton lines={5} /></div> : visibleFiles.length ? <div className="data-table knowledge-table"><div className="data-table__head"><span>文件</span><span>知识性质</span><span>分类</span><span>版本 / 更新</span><span /></div>{visibleFiles.map((file) => <div className="data-table__row" key={file.id}><span className="file-cell"><i className={file.name.endsWith('.md') ? 'md' : 'txt'}>{file.name.endsWith('.md') ? 'MD' : 'TXT'}</i><span><strong>{file.name}</strong><small>{file.summary || `${formatBytes(file.size)} · 暂无摘要`}</small></span></span><span><Badge tone={file.kind === '已知事实' ? 'positive' : file.kind === '禁止表达' ? 'danger' : file.kind === '猜想' ? 'warning' : 'neutral'}>{file.kind || '未标记'}</Badge></span><span>{file.category || '未分类'}</span><span className="version-cell"><strong>v{file.version || 1}</strong><small>{formatDate(file.updatedAt, true)}</small></span><span className="row-actions"><button className="icon-button" title="删除" onClick={() => remove(file)}><Trash2 size={16} /></button><button className="icon-button" title="查看内容" onClick={() => void openPreview(file)}><MoreHorizontal size={17} /></button></span></div>)}</div> : <EmptyState icon={<FileText size={24} />} title="没有找到知识文件" description={search || category !== 'all' ? '试试清除搜索或分类条件。' : '导入第一份 Markdown 或文本文件后开始生成。'} action={!search && category === 'all' ? <Button icon={<Plus size={16} />} onClick={() => setUploadOpen(true)}>导入文件</Button> : undefined} />}
      </section>

      <Modal open={uploadOpen} onClose={() => { setUploadOpen(false); setPendingFile(null); }} title="导入知识文件" description="首版支持 Markdown 与纯文本，单文件最大 2 MB。" footer={<><Button variant="ghost" onClick={() => setUploadOpen(false)}>取消</Button><Button loading={uploading} disabled={!pendingFile} onClick={handleUpload}>确认导入</Button></>}>
        <div className="upload-form"><button className={`dropzone ${pendingFile ? 'dropzone--selected' : ''}`} onClick={() => inputRef.current?.click()}><input ref={inputRef} type="file" accept=".md,.txt,text/markdown,text/plain" onChange={chooseFile} hidden />{pendingFile ? <><CheckCircle2 size={28} /><strong>{pendingFile.name}</strong><span>{formatBytes(pendingFile.size)} · 点击更换</span></> : <><UploadCloud size={30} /><strong>点击选择 .md 或 .txt 文件</strong><span>文件内容只作为数据，不会覆盖 Agent 系统规则</span></>}</button><div className="field-grid field-grid--two"><Field label="知识分类"><select value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></Field><Field label="知识性质"><select value={uploadKind} onChange={(event) => setUploadKind(event.target.value as EvidenceStatus)}>{evidenceKinds.map((item) => <option key={item}>{item}</option>)}</select></Field></div></div>
      </Modal>

      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title={preview?.name || '文件内容'} description="只读预览。文件内容仅作为数据，不会覆盖 Agent 系统规则。">
        {previewLoading ? <Skeleton lines={6} /> : <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>{preview?.content}</pre>}
      </Modal>
    </div>
  );
}
