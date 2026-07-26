import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '../../components/ProjectContext';
import { useToast } from '../../components/Ui';
import { OverviewTab } from '../../components/quick/OverviewTab';
import { useQuickWorkspace } from '../../components/quick/QuickWorkspaceContext';
import { areaPath, QUICK_HOME_PATH, type QuickArea } from '../../lib/quick-routes';

/**
 * 总览区。薄壳:把 provider 里的跨区状态与路由跳转接给现有的 OverviewTab,
 * 业务逻辑一行不动。
 */
export function QuickOverviewPage() {
  const { project } = useQuickWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  // busy 只在本区有意义(禁用按钮防并发),离开就该清掉,所以留在页面局部
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown, fallback: string) => {
    toast.push(e instanceof Error ? e.message : fallback, 'error');
    setBusy(false);
  };

  return (
    <OverviewTab
      project={project}
      busy={busy}
      setBusy={setBusy}
      fail={fail}
      goTo={(area: QuickArea) => navigate(areaPath(project.id, area))}
      // 项目重命名/改设置:ProjectContext 是项目的真源,更新它即可——
      // 布局路由从 projects 里查 project,列表一变界面就跟上,不需要本地副本。
      onProjectUpdated={() => { /* ProjectContext.updateProject 已经刷新了列表 */ }}
      // 删除动作本身在 OverviewTab 里(它已调用 removeProject),这里只负责离场。
      // replace:被删的项目地址不该留在历史里,后退会撞上一个不存在的项目。
      onProjectDeleted={() => navigate(QUICK_HOME_PATH, { replace: true })}
    />
  );
}
