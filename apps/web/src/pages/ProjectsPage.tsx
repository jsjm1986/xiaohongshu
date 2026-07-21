import { ArrowRight, BookOpenText, Boxes, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { Badge, Button, Field, Modal, PageHeader, useToast } from '../components/Ui';
import { formatDate } from '../lib/utils';

export function ProjectsPage() {
  const { projects, projectId, setProjectId, addProject } = useProjects();
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', domain: '', description: '' });
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

  return (
    <div className="page">
      <PageHeader eyebrow="PROJECTS" title="项目管理" description="每个项目拥有独立的知识库、公式版本与生成历史。" actions={<Button icon={<Plus size={17} />} onClick={() => setModalOpen(true)}>新建项目</Button>} />
      <div className="project-grid">
        {projects.map((project, index) => (
          <article className={`project-card ${project.id === projectId ? 'project-card--active' : ''}`} key={project.id}>
            <header><div className={`project-card__mark project-card__mark--${index % 3}`}><Boxes size={21} /></div><button className="icon-button"><MoreHorizontal size={19} /></button></header>
            <div className="project-card__title"><h2>{project.name}</h2>{project.id === projectId && <Badge tone="positive">当前项目</Badge>}</div>
            <p>{project.description || '暂无项目说明'}</p>
            <div className="project-card__stats"><span><BookOpenText size={15} /><strong>{project.knowledgeCount || 0}</strong> 份知识</span><span><Sparkles size={15} /><strong>{project.generationCount || 0}</strong> 次生成</span></div>
            <div className="project-card__formula"><span>当前公式</span><strong>{project.activeFormulaVersion || '未设置'}</strong></div>
            <footer><small>更新于 {formatDate(project.updatedAt)}</small><button onClick={() => { setProjectId(project.id); navigate('/'); }}>{project.id === projectId ? '进入项目' : '切换并进入'} <ArrowRight size={15} /></button></footer>
          </article>
        ))}
        <button className="project-card project-card--new" onClick={() => setModalOpen(true)}><span><Plus size={24} /></span><strong>创建新项目</strong><p>从空白知识库开始</p></button>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="创建新项目" description="先建立容器，之后可随时补充知识和公式。" footer={<><Button variant="ghost" type="button" onClick={() => setModalOpen(false)}>取消</Button><Button type="submit" form="create-project" loading={saving}>创建项目</Button></>}>
        <form id="create-project" className="form-stack" onSubmit={handleCreate}>
          <Field label="项目名称" required><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：本地家装咨询" required /></Field>
          <Field label="行业领域" hint="分析后会形成项目自己的风险与表达约束"><input value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="例如：家装服务 / 软件工具 / 教育咨询" /></Field>
          <Field label="项目说明"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} placeholder="这个项目面向谁，要解决什么问题？" /></Field>
        </form>
      </Modal>
    </div>
  );
}
