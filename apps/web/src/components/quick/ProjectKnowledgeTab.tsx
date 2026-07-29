import { useEffect, useMemo, useState } from 'react';
import { Trash2, Sparkles, Building2, Lightbulb, Eye, TriangleAlert, Info, FileText, WandSparkles } from 'lucide-react';
import { Button, Field, Modal, useToast } from '../Ui';
import { api } from '../../lib/api';
import { gapStats, pendingCount } from '../../lib/enrich-types';
import { V2Instrument, V2InstrumentCell } from '../V2';
import { KnowledgeEnrichmentModal } from '../knowledge/KnowledgeEnrichmentModal';
import { QuickTaskProgress } from './QuickTaskProgress';
import type { AnalysisTask, InformationGap, KnowledgeFile, Project, ProjectIntelligence, TopicOpportunity } from '../../types';

const CATEGORIES = ['未分类', '知识地图', '项目与服务', '用户与场景', '案例样本', '方法论', '约束'];
const KINDS = ['已知事实', '案例样本', '用户观点', '方法论推理', '猜想', '信息不足', '禁止表达'];

interface Props {
  project: Project | null;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onAnalyzed: (opps: TopicOpportunity[]) => void;
}

export function ProjectKnowledgeTab({ project, busy, setBusy, fail, onAnalyzed }: Props) {
  const toast = useToast();
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [pending, setPending] = useState<File[]>([]);
  const [category, setCategory] = useState('未分类');
  const [kind, setKind] = useState('已知事实');
  const [noteName, setNoteName] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [intel, setIntel] = useState<ProjectIntelligence | null>(null);
  const [topicCount, setTopicCount] = useState(0);
  const [analysisTask, setAnalysisTask] = useState<AnalysisTask | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [recategorizing, setRecategorizing] = useState<string | null>(null);
  const [gaps, setGaps] = useState<InformationGap[]>([]);
  const [enrichOpen, setEnrichOpen] = useState(false);

  useEffect(() => {
    if (!project) { setFiles([]); setIntel(null); setTopicCount(0); setGaps([]); return; }
    let cancelled = false;
    setIntel(null);
    setTopicCount(0);
    setGaps([]);
    api.knowledge.list(project.id).then((r) => { if (!cancelled) setFiles(r.items); }).catch(() => { if (!cancelled) setFiles([]); });
    api.intelligence.get(project.id).then((r) => { if (!cancelled && r.status !== 'missing') setIntel(r); }).catch(() => {});
    api.opportunities.list(project.id).then((r) => { if (!cancelled) setTopicCount(r.items.length); }).catch(() => {});
    api.informationGaps.list(project.id).then((r) => { if (!cancelled) setGaps(r.items); }).catch(() => { if (!cancelled) setGaps([]); });
    return () => { cancelled = true; };
  }, [project]);

  const analyzed = Boolean(intel?.id);
  const stats = useMemo(() => gapStats(gaps), [gaps]);
  const pendingGapCount = pendingCount(stats);

  // stale 感知:知识增删/图片审批/项目资料更新后,后端把审批链置 stale(规则 2);
  // ready 但带 staleReasons 同属「建议重新分析」。draft(已分析未确认)不阻塞,仅提示。
  const staleReasons = intel?.staleReasons ?? [];
  const isStale = intel?.status === 'stale' || (intel?.status === 'ready' && staleReasons.length > 0);
  const isDraft = intel?.status === 'draft';

  const refreshAnalysisTask = () => {
    if (!project) return Promise.resolve();
    return api.intelligence.tasks.list(project.id).then((tasks) => {
      const sorted = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // 知识库补充也建 kind='project' 的任务(analysis_tasks 的 kind 只允许两种值),
      // 不排除的话点「AI 帮我补充」会让这里的分析进度条动起来,看着像在重跑分析。
      setAnalysisTask(sorted.find((t) => t.kind === 'project' && !t.sourceFingerprint?.startsWith('enrich:')) ?? null);
    }).catch(() => { /* 非致命 */ });
  };

  useEffect(() => {
    if (!analyzing) return;
    const timer = window.setInterval(() => { void refreshAnalysisTask(); }, 1800);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzing, project]);

  const createNote = async () => {
    if (!project || !noteContent.trim()) return;
    setBusy(true);
    try {
      await api.knowledge.create(project.id, noteName.trim() || '未命名笔记.md', noteContent, category, kind);
      const r = await api.knowledge.list(project.id);
      setFiles(r.items);
      setNoteName('');
      setNoteContent('');
      toast.push('文本已保存为知识文件');
      setBusy(false);
    } catch (e) { fail(e, '保存文本失败'); }
  };

  const previewFile = async (f: KnowledgeFile) => {
    setPreview({ name: f.name, content: '' });
    setPreviewLoading(true);
    try {
      const full = await api.knowledge.get(f.id);
      setPreview({ name: full.name, content: full.content });
      setPreviewLoading(false);
    } catch (e) { setPreview(null); setPreviewLoading(false); fail(e, '加载预览失败'); }
  };

  const uploadFiles = async (picked: File[]) => {
    if (!project || picked.length === 0) return;
    setBusy(true);
    setPending(picked);
    try {
      for (const f of picked) await api.knowledge.upload(project.id, f, category, kind);
      const r = await api.knowledge.list(project.id);
      setFiles(r.items);
      setPending([]);
      setBusy(false);
    } catch (e) { setPending([]); fail(e, '上传失败'); }
  };

  const removeFile = async (id: string) => {
    if (!project) return;
    setBusy(true);
    try {
      await api.knowledge.remove(id);
      setFiles((cur) => cur.filter((f) => f.id !== id));
      setBusy(false);
    } catch (e) { fail(e, '删除文件失败'); }
  };

  /**
   * 就地改分类。原来只能删除后重传,分类填错一次就得把文件删掉重上一遍。
   * 改完要重取内容地图状态:后端会把已审批的分析链置 stale,界面得跟着提示重新分析。
   */
  const changeCategory = async (file: KnowledgeFile, category: string) => {
    if (!project || category === file.category) return;
    setRecategorizing(file.id);
    try {
      const updated = await api.knowledge.recategorize(file.id, { category });
      setFiles((cur) => cur.map((f) => (f.id === file.id ? updated : f)));
      toast.push(`「${file.name}」已改为「${category}」，建议重新分析`);
      // 分析链已失效,刷新状态让「需要更新」提示立刻出现
      api.intelligence.get(project.id)
        .then((r) => { if (r.status !== 'missing') setIntel(r); })
        .catch(() => { /* 静默:提示晚一步出现不影响改分类本身 */ });
    } catch (e) { fail(e, '改分类失败'); } finally { setRecategorizing(null); }
  };

  const analyze = async () => {
    if (!project) return;
    setBusy(true);
    setAnalyzing(true);
    void refreshAnalysisTask();
    try {
      const result = await api.intelligence.analyze(project.id, true);
      setIntel(result.intelligence);
      const opps = await api.opportunities.list(project.id);
      setTopicCount(opps.items.length);
      setAnalyzing(false);
      setAnalysisTask(null);
      onAnalyzed(opps.items);
      setBusy(false);
    } catch (e) { setAnalyzing(false); fail(e, '分析知识库失败'); }
  };

  const goToTopics = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const opps = await api.opportunities.list(project.id);
      onAnalyzed(opps.items);
      setBusy(false);
    } catch (e) { fail(e, '读取选题失败'); }
  };

  return (
    <div className="qc-step">
      {project && (
        <>
          {analyzed ? (
            <V2Instrument columns={isStale || pendingGapCount > 0 || isDraft ? 4 : 3}>
              {/* text:值是词组不是读数,不该用 31px 读数字号(见 V2InstrumentCell) */}
              <V2InstrumentCell text tone="brand" icon={<Sparkles size={14} />} label="实体" value={intel?.entity || '已分析'} />
              <V2InstrumentCell text tone="ai" icon={<Building2 size={14} />} label="行业" value={intel?.industry || '已建立内容地图'} />
              <V2InstrumentCell tone="ok" icon={<Lightbulb size={14} />} label="可用选题" value={topicCount} unit="个" />
              {isStale && (
                <V2InstrumentCell text tone="warn" icon={<TriangleAlert size={14} />} label="需要更新" value="内容地图待刷新" note={staleReasons.join('；') || '资料有更新'} />
              )}
              {/* 第四格只有一个位置,按优先级让位:资料有缺口比「待确认」更需要用户动手
                  (「待确认」本身写着「不阻塞使用」) */}
              {!isStale && pendingGapCount > 0 && (
                <V2InstrumentCell
                  text tone="warn" icon={<Info size={14} />} label="资料完整度"
                  value={`${stats.supplied}/${stats.total}`}
                  note={`${stats.unknown} 项没有资料,${stats.inferred} 项靠推断`}
                />
              )}
              {!isStale && pendingGapCount === 0 && isDraft && (
                <V2InstrumentCell text tone="ai" icon={<Info size={14} />} label="状态" value="待确认" note="生成时会自动确认,不阻塞使用" />
              )}
            </V2Instrument>
          ) : (
            <V2Instrument columns={2}>
              <V2InstrumentCell text tone="brand" icon={<Sparkles size={14} />} label="状态" value="尚未分析" />
              <V2InstrumentCell text tone="ai" icon={<Lightbulb size={14} />} label="下一步" value="上传知识 → 分析" note="AI 会建立内容地图并生成选题" />
            </V2Instrument>
          )}

          {analyzing && (
            <QuickTaskProgress text="三段模型串联运行:蓝图 → 缺口与策略 → 选题。完成前请勿离开或重复触发。" task={analysisTask} />
          )}

          <Field label="知识文件">
            <ul className="qc-file-list">
              {files.map((f) => (
                <li key={f.id}>
                  <FileText size={14} />
                  <span className="qc-file-name">{f.name}</span>
                  {/* 分类可以就地改,不必再「删除后重传」。改分类会让内容地图失效,
                      因为分类决定这份资料怎么参与生成(reference-corpus 会被排除出生成语料)。 */}
                  <select
                    className="qc-file-cat"
                    value={CATEGORIES.includes(f.category ?? '') ? f.category : '未分类'}
                    disabled={recategorizing === f.id}
                    aria-label={`「${f.name}」的分类`}
                    onChange={(e) => void changeCategory(f, e.target.value)}
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <span className="qc-file-ops">
                    <Button variant="ghost" icon={<Eye size={14} />} onClick={() => void previewFile(f)}>预览</Button>
                    <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => void removeFile(f.id)}>删除</Button>
                  </span>
                </li>
              ))}
              {files.length === 0 && <li className="qc-hint">还没有知识文件</li>}
            </ul>
          </Field>

          {/* 限制写在标签上而不是让用户撞了才知道:后端单文件上限 2 MiB
              (knowledge.service.ts),超了会以 413 失败 */}
          <Field label="上传知识文件（.md / .txt，单个不超过 2 MiB，可多选，选中即上传）">
            <input
              type="file"
              accept=".md,.txt"
              multiple
              disabled={busy}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (picked.length > 0) void uploadFiles(picked);
              }}
            />
            {busy && pending.length > 0 && <small className="qc-hint">正在上传 {pending.length} 个文件…</small>}
          </Field>
          <details className="qc-advanced">
            <summary>上传分类（默认：未分类 / 已知事实；上传后仍可调整分类）</summary>
            <div className="qc-advanced-grid">
              <Field label="分类"><select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label="证据类型"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            </div>
          </details>

          <details className="qc-advanced">
            <summary>或直接录入文本</summary>
            <div className="qc-advanced-grid">
              <Field label="文件名">
                <input value={noteName} onChange={(e) => setNoteName(e.target.value)} placeholder="未命名笔记.md" />
              </Field>
              <Field label="内容" hint="分类与证据类型沿用上方「上传分类」的当前选择">
                <textarea value={noteContent} rows={5} onChange={(e) => setNoteContent(e.target.value)} placeholder="直接粘贴或书写文本内容" />
              </Field>
              <div className="qc-project-row">
                <Button variant="secondary" loading={busy} disabled={!noteContent.trim()} onClick={() => void createNote()}>保存</Button>
              </div>
            </div>
          </details>

          <div className="qc-project-row">
            {analyzed ? (
              <>
                {topicCount > 0 && <Button variant={isStale ? 'secondary' : 'primary'} loading={busy} onClick={() => void goToTopics()}>去创作</Button>}
                {/* 放在「重新分析」旁边:补充完就该重新分析,两个动作挨着最顺 */}
                {pendingGapCount > 0 && (
                  <Button variant="secondary" icon={<WandSparkles size={15} />} disabled={busy || analyzing} onClick={() => setEnrichOpen(true)}>
                    AI 帮我补充({pendingGapCount} 项)
                  </Button>
                )}
                <Button variant={isStale ? 'primary' : 'ghost'} loading={busy} disabled={busy || analyzing} onClick={() => void analyze()}>重新分析</Button>
              </>
            ) : (
              <Button loading={busy} disabled={busy || analyzing} onClick={() => void analyze()}>分析知识库</Button>
            )}
          </div>
        </>
      )}

      <Modal open={preview !== null} title={preview?.name ?? '预览'} description="只读预览,内容按原文展示" onClose={() => setPreview(null)} size="wide">
        {previewLoading ? <p className="qc-hint">正在加载内容…</p> : <pre className="qc-knowledge-preview">{preview?.content || '(文件没有文本内容)'}</pre>}
      </Modal>

      {project && (
        <KnowledgeEnrichmentModal
          open={enrichOpen}
          projectId={project.id}
          onClose={() => setEnrichOpen(false)}
          onComplete={() => {
            // 补充只改知识文件,不动分析结果。刷新文件列表与缺口即可;
            // 「建议重新分析」的提示由弹窗自己弹,这里不重复。
            void api.knowledge.list(project.id).then((r) => setFiles(r.items)).catch(() => {});
            void api.informationGaps.list(project.id).then((r) => setGaps(r.items)).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
