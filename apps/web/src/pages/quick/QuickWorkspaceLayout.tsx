import { NavLink, Navigate, Outlet, useParams } from 'react-router-dom';
import { useProjects } from '../../components/ProjectContext';
import { QuickWorkspaceProvider } from '../../components/quick/QuickWorkspaceContext';
import { AREA_LABELS, AREA_ORDER, areaPath, QUICK_HOME_PATH } from '../../lib/quick-routes';

/**
 * 项目工作区的布局路由:面包屑 + 四区步骤条 + <Outlet/>。
 *
 * 项目由 :projectId 派生(在 projects 列表里查),不再是组件状态——这是路由化的
 * 核心收益:地址与界面之间只有一个真源,刷新和分享都不需要额外记忆。
 */
/*
 * 区段的合法性由路由表本身保证:四个静态子路由 + 一个 `*` 兜底重定向。
 *
 * 这里曾经还有一个 useParams 读 `:area` + parseArea 纠正地址的 effect,是错的:
 * 布局的 path 是 `quick/:projectId`,area 是**子路由的路径段**而不是本层的参数,
 * 所以 rawArea 恒为 undefined,parseArea 每次都判 fallback,那个 effect 于是把
 * 每一次导航都 replace 回 overview——实测四个区点一圈,地址和高亮全程停在总览。
 *
 * 教训是同一件事不要两套机制。判区归路由表,这一层只管项目与外框。
 */
export function QuickWorkspaceLayout() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const { projects, loading } = useProjects();

  // 项目列表还在拉:先不判定"项目不存在",否则直接打开链接会被误弹回卡墙
  if (loading) return <div className="page qc-page"><p className="qc-hint">正在打开工作区…</p></div>;

  const project = projects.find((p) => p.id === projectId);
  if (!project) return <Navigate to={QUICK_HOME_PATH} replace />;

  return (
    // key:换项目时整个工作区重挂,跨区状态一次清空(原 onProjectChosen 的手工清理)
    <QuickWorkspaceProvider key={project.id} project={project}>
      <div className="page qc-page">
        <div className="qc-crumb">
          <NavLink to={QUICK_HOME_PATH} className="qc-crumb__back">‹ 全部项目</NavLink>
          <h1>{project.name}</h1>
          {project.domain && <small>{project.domain}</small>}
        </div>

        {/* NavLink 而不是 button:可中键新开、可右键复制链接,当前态由 router 判定 */}
        <nav className="qc-tabs">
          {AREA_ORDER.map((item) => (
            <NavLink
              key={item}
              to={areaPath(project.id, item)}
              className={({ isActive }) => `qc-tab${isActive ? ' active' : ''}`}
            >
              {AREA_LABELS[item]}
            </NavLink>
          ))}
        </nav>

        <Outlet />
      </div>
    </QuickWorkspaceProvider>
  );
}
