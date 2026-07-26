import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../components/ProjectContext';
import { useToast } from '../components/Ui';
import { QuickHome } from '../components/quick/QuickHome';
import { areaPath } from '../lib/quick-routes';

/**
 * /quick —— 项目卡墙。
 *
 * 这个组件原来是整个频道的壳:19 个 useState、四区标签切渲染、外加一份
 * sessionStorage 记忆来模拟"回到原处"。四个区改成真路由后,那些状态搬进了
 * QuickWorkspaceProvider(由 /quick/:projectId 布局持有),这里只剩一件事:
 * 选项目,然后进它的工作区。
 */
export function QuickChannelPage() {
  const { projects, loading } = useProjects();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  return (
    <div className="page qc-page">
      <QuickHome
        projects={projects}
        loading={loading}
        busy={busy}
        setBusy={setBusy}
        fail={fail}
        onProjectChosen={(p) => navigate(areaPath(p.id))}
      />
    </div>
  );
}
