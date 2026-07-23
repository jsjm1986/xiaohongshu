import { ArrowRight, BookOpenText, Boxes, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, Field, Modal, PageHeader, Skeleton, useToast } from '../components/Ui';
import { formatDate } from '../lib/utils';

export function ProjectsPage() {
  const { projects, projectId, setProjectId, addProject, updateProject, removeProject, loading } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', domain: '', description: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; domain: string; description: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await addProject(form);
      setModalOpen(false);
      setForm({ name: '', domain: '', description: '' });
      toast.push('项目已创建');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      await updateProject(editing.id, { name: editing.name, domain: editing.domain, description: editing.description });
      setEditing(null);
      toast.push('项目已更新');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      await removeProject(deleting.id);
      setDeleting(null);
      toast.push('项目已删除');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="PROJECTS" title="项目管理" description="每个项目拥有独立的知识库、公式版本与生成历史。" actions={<Button icon={<Plus size={17} />} onClick={() => setModalOpen(true)}>新建项目</Button>} />
      {loading ? (
        <div className="table-loading"><Skeleton lines={5} /></div>
      ) : (
      <div className="project-grid">
        {projects.map((project, index) => (
          <article className={`project-card ${project.id === projectId ? 'project-card--active' : ''}`} key={project.id}>
            <header><div className={`project-card__mark project-card__mark--${index % 3}`}><Boxes size={21} /></div>
              <div className="card-menu">
                <button type="button" className="icon-button" aria-label="更多操作" onClick={() => setMenuFor(menuFor === project.id ? null : project.id)}><MoreHorizontal size={19} /></button>
                {menuFor === project.id && (
                  <div className="card-menu__pop" onMouseLeave={() => setMenuFor(null)}>
                    <button type="button" onClick={() => { setEditing({ id: project.id, name: project.name, domain: project.domain || '', description: project.description || '' }); setMenuFor(null); }}><Pencil size={14} /> 编辑</button>
                    <button type="button" className="danger" onClick={() => { setDeleting({ id: project.id, name: project.name }); setMenuFor(null); }}><Trash2 size={14} /> 删除</button>
                  </div>
                )}
              </div>
            </header>
            <div className="project-card__title"><h2>{project.name}</h2>{project.id === projectId && <Badge tone="positive">当前项目</Badge>}</div>
            <p>{project.description || '暂无项目说明'}</p>
            <div className="project-card__stats"><span><BookOpenText size={15} /><strong>{project.knowledgeCount || 0}</strong> 份知识</span><span><Sparkles size={15} /><strong>{project.generationCount || 0}</strong> 次生成</span></div>
            <div className="project-card__formula"><span>当前公式</span><strong>{project.activeFormulaVersion || '未设置'}</strong></div>
            <footer><small>更新于 {formatDate(project.updatedAt)}</small><button type="button" onClick={() => { setProjectId(project.id); navigate('/'); }}>{project.id === projectId ? '进入项目' : '切换并进入'} <ArrowRight size={15} /></button></footer>
          </article>
        ))}
        <button type="button" className="project-card project-card--new" onClick={() => setModalOpen(true)}><span><Plus size={24} /></span><strong>创建新项目</strong><p>从空白知识库开始</p></button>
      </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="创建新项目" description="先建立容器，之后可随时补充知识和公式。" footer={<><Button variant="ghost" type="button" onClick={() => setModalOpen(false)}>取消</Button><Button type="submit" form="create-project" loading={saving}>创建项目</Button></>}>
        <form id="create-project" className="form-stack" onSubmit={handleCreate}>
          <Field label="项目名称" required><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：本地家装咨询" required /></Field>
          <Field label="行业领域" hint="分析后会形成项目自己的风险与表达约束"><input value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="例如：家装服务 / 软件工具 / 教育咨询" /></Field>
          <Field label="项目说明"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} placeholder="这个项目面向谁，要解决什么问题？" /></Field>
        </form>
      </Modal>
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title="编辑项目" description="修改名称、行业或说明。" footer={<><Button variant="ghost" type="button" onClick={() => setEditing(null)}>取消</Button><Button type="submit" form="edit-project" loading={saving}>保存</Button></>}>
        <form id="edit-project" className="form-stack" onSubmit={handleUpdate}>
          <Field label="项目名称" required><input value={editing?.name || ''} onChange={(event) => setEditing((current) => current && { ...current, name: event.target.value })} required /></Field>
          <Field label="行业领域"><input value={editing?.domain || ''} onChange={(event) => setEditing((current) => current && { ...current, domain: event.target.value })} /></Field>
          <Field label="项目说明"><textarea value={editing?.description || ''} onChange={(event) => setEditing((current) => current && { ...current, description: event.target.value })} rows={3} /></Field>
        </form>
      </Modal>
      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="删除项目" description="项目会被移除（软删除），其知识库、公式和生成历史将不再显示。此操作在界面上不可撤销。" footer={<><Button variant="ghost" type="button" onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" loading={saving} onClick={handleDelete}>确认删除</Button></>}>
        <p>确定要删除「{deleting?.name}」吗？</p>
      </Modal>
    </div>
  );
}
