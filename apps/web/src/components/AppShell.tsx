import { Bell, ChevronDown, Gauge, LogOut, Menu, Settings, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { EditionSwitch } from "./EditionSwitch";
import { CHANNELS, SETTINGS_CHANNEL } from "../lib/channels";
import { groupNavItems, navItemForPath, visibleNavItems } from "../lib/nav-groups";
import { ProjectProvider, useProjects } from "./ProjectContext";

/*
  频道表下沉到 lib/channels.ts:页面 hero 也要按当前路径取「图标 + 频道名」,
  从 AppShell 导出会让 V2.tsx 反向依赖外层壳。
*/
const navigation = CHANNELS;

function ShellContent() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { user, logout } = useAuth();
  const { projects, projectId, setProjectId, loading } = useProjects();
  const location = useLocation();
  const navigate = useNavigate();
  const visibleNavigation = visibleNavItems(navigation, user?.role);
  const navSections = groupNavItems(navigation, user?.role);

  /*
    顶栏标题取当前频道。原来是 filter + .at(-1),按表尾序取而非最长前缀——靠
    「/」恰好排在表首才没出错。navItemForPath 明确按最长匹配,与 hero 同一套逻辑。
  */
  const currentNav = navItemForPath([...visibleNavigation, SETTINGS_CHANNEL], location.pathname);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="app-shell v2">
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="brand">
          <div className="brand__mark">
            <Sparkles size={21} strokeWidth={2.2} />
          </div>
          <div>
            <strong>内容智造台</strong>
            {/* 壳自报版本,和顶栏切换器的当前态说同一个词 */}
            <span>科研版</span>
          </div>
          <button
            className="sidebar__close"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        {navSections.map(({ group, items }) => (
          <div key={group.id}>
            <div className="sidebar__section-label">{group.label}</div>
            <nav className="sidebar__nav">
              {items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {to === "/generate" && <i>快捷</i>}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}

        <div className="sidebar__spacer" />
        <div className="quota-mini">
          <div>
            <Gauge size={16} />
            <span>轻量运行</span>
            <strong>SQLite</strong>
          </div>
          <span className="v2-console">
            CORE <b>v1.6.0</b> · POLICY <b>3.6.0</b><br />
            <i>●</i> 系统正常 · 无向量服务
          </span>
        </div>
        <nav className="sidebar__nav sidebar__nav--bottom">
          <NavLink to="/settings" onClick={() => setSidebarOpen(false)}>
            <Settings size={18} />
            <span>模型与设置</span>
          </NavLink>
        </nav>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label="关闭导航"
        />
      )}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__left">
            <button
              className="mobile-menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span className="topbar__page">
              {currentNav?.label || "内容详情"}
            </span>
            <span className="topbar__divider" />
            <div className="project-switcher">
              <span className="project-switcher__dot" />
              <select
                value={projectId}
                disabled={loading}
                onChange={(event) => setProjectId(event.target.value)}
                aria-label="当前项目"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
          <div className="topbar__right">
            <EditionSwitch />
            <button
              className="icon-button topbar__notification"
              aria-label="通知"
            >
              <Bell size={19} />
              <i />
            </button>
            <div className="profile-menu">
              <button
                className="profile-button"
                onClick={() => setProfileOpen((value) => !value)}
              >
                <span className="avatar">{user?.displayName.slice(0, 1)}</span>
                <span>
                  <strong>{user?.displayName}</strong>
                  <small>{user?.role}</small>
                </span>
                <ChevronDown size={15} />
              </button>
              {profileOpen && (
                <div className="profile-dropdown">
                  <div>
                    <strong>{user?.displayName}</strong>
                    <span>@{user?.username}</span>
                  </div>
                  <button
                    onClick={() => {
                      setProfileOpen(false);
                      navigate("/settings");
                    }}
                  >
                    <Settings size={16} />
                    账户设置
                  </button>
                  <button onClick={handleLogout}>
                    <LogOut size={16} />
                    退出登录
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <ProjectProvider>
      <ShellContent />
    </ProjectProvider>
  );
}
