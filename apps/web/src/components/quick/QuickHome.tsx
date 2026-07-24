import { BookOpenText, FolderPlus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useProjects } from '../ProjectContext';
import { Badge, Button, Skeleton } from '../Ui';
import type { Project } from '../../types';

interface Props {
  projects: Project[];
  loading: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  fail: (e: unknown, fallback: string) => void;
  onProjectChosen: (p: Project) => void;
}

/**
 * 极简创作 · 产品首页(卡墙):选项目进工作区,或内联新建直达。
 * 承接原 ProjectKnowledgeTab 的「选项目 / 新建项目」入口(功能不丢,只搬家)。
 */
export function QuickHome({ projects, loading, busy, setBusy, fail, onProjectChosen }: Props) {
  const { addProject } = useProjects();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');

  const cancelCreate = () => {
    setName('');
    setDomain('');
    setCreating(false);
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await addProject({ name: name.trim(), domain: domain.trim() || undefined });
      cancelCreate();
      onProjectChosen(created);
      setBusy(false);
    } catch (e) { fail(e, '创建项目失败'); }
  };

  // 新建内联表单:新建卡展开态与空态共用;Esc / 取消收起并清空
  const createForm = (
    <form
      className="qc-home-create"
      onSubmit={(e) => { e.preventDefault(); void create(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') cancelCreate(); }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="项目名称(必填)"
        aria-label="项目名称"
      />
      <input
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        placeholder="行业(可选,如:医美)"
        aria-label="行业"
      />
      <div className="qc-home-create__actions">
        <Button type="submit" loading={busy} disabled={!name.trim()}>创建</Button>
        <Button type="button" variant="ghost" onClick={cancelCreate}>取消</Button>
      </div>
    </form>
  );

  return (
    <div className="qc-home">
      <header className="qc-home-hero">
        <span className="eyebrow">极简创作</span>
        <h1>选好项目,开始创作</h1>
        <p>传资料、挑选题、点生成——三步出一篇。</p>
      </header>

      {loading ? (
        <Skeleton lines={4} />
      ) : projects.length === 0 ? (
        <div className="qc-project-card qc-project-card--new qc-project-card--empty">
          <FolderPlus size={28} />
          <strong>创建第一个项目,开始极简创作</strong>
          {createForm}
        </div>
      ) : (
        <div className="qc-home-grid">
          {projects.map((p) => (
            <button key={p.id} type="button" className="qc-project-card" onClick={() => onProjectChosen(p)}>
              <span className="qc-project-card__head">
                <strong>{p.name}</strong>
                {p.domain && <Badge tone="neutral">{p.domain}</Badge>}
              </span>
              <span className="qc-project-card__stats">
                <span><BookOpenText size={13} /> {p.knowledgeCount ?? 0} 知识</span>
                <span><Sparkles size={13} /> {p.generationCount ?? 0} 生成</span>
              </span>
              {p.updatedAt && <small className="qc-project-card__date">更新于 {p.updatedAt.slice(0, 10)}</small>}
            </button>
          ))}
          {creating ? (
            <div className="qc-project-card qc-project-card--new qc-project-card--form">{createForm}</div>
          ) : (
            <button type="button" className="qc-project-card qc-project-card--new" onClick={() => setCreating(true)}>
              <FolderPlus size={20} />
              <span>新建项目</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
