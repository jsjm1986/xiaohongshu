import {
  Bell,
  BookOpenText,
  Boxes,
  ChevronDown,
  FileClock,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Microscope,
  Settings,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { EditionSwitch } from "./EditionSwitch";
import { ProjectProvider, useProjects } from "./ProjectContext";

/*
  「极简创作」不在这张表里:它是**版本**,不是频道。放进导航会和知识库、公式版本
  这些资产入口并列,暗示它是工作台的一个页面;实际点进去是换了整套壳。版本切换
  移到顶栏 <EditionSwitch />,两个壳同一位置、双向对称。
*/
const navigation = [
  { to: "/", label: "概览", icon: LayoutDashboard, end: true },
  { to: "/generate", label: "内容生成", icon: Sparkles },
  { to: "/projects", label: "项目管理", icon: Boxes },
  { to: "/knowledge", label: "知识库", icon: BookOpenText },
  { to: "/formulas", label: "公式版本", icon: FlaskConical },
  { to: "/research", label: "研究与证据", icon: Microscope },
  { to: "/history", label: "生成历史", icon: FileClock },
  { to: "/team", label: "团队权限", icon: UsersRound, adminOnly: true },
];

function ShellContent() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { user, logout } = useAuth();
  const { projects, projectId, setProjectId, loading } = useProjects();
  const location = useLocation();
  const navigate = useNavigate();
  const visibleNavigation = navigation.filter(
    (item) => !item.adminOnly || ["系统管理员", "Owner", "Admin"].includes(user?.role || ""),
  );

  const currentNav = [
    ...visibleNavigation,
    { to: "/settings", label: "设置", icon: Settings },
  ]
    .filter((item) =>
      item.to === "/"
        ? location.pathname === "/"
        : location.pathname.startsWith(item.to),
    )
    .at(-1);

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

        <div className="sidebar__section-label">01 · 工作台</div>
        <nav className="sidebar__nav">
          {visibleNavigation.slice(0, 2).map(({ to, label, icon: Icon, end }) => (
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

        <div className="sidebar__section-label">02 · 资产与规则</div>
        <nav className="sidebar__nav">
          {visibleNavigation.slice(2).map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={() => setSidebarOpen(false)}>
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

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
