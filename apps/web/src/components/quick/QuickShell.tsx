import { ArrowUpRight, ChevronDown, LogOut, Settings, Zap } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { ProjectProvider } from '../ProjectContext';
import { isSaasUser, SAAS_ACCOUNT_PATH } from '../../lib/saas-access';

/**
 * 极简创作 · 独立产品壳:无专家侧边栏,顶栏 + 居中内容区。
 * 自带 ProjectProvider(/quick 已从 AppShell 迁出)与 v2 token 作用域(根节点 v2 class 必带)。
 * 顶栏不下放全局项目切换器——项目在首页(QuickHome)自行管理。
 */
function QuickShellContent() {
  const [profileOpen, setProfileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="quick-shell v2">
      <header className="qs-topbar">
        <NavLink to="/quick" className="qs-brand" title="极简创作首页">
          <span className="qs-brand__mark">
            <Zap size={17} strokeWidth={2.2} />
          </span>
          <span className="qs-brand__text">
            <strong>极简创作</strong>
            <small>Content Agent</small>
          </span>
        </NavLink>
        <div className="qs-topbar__right">
          {!isSaasUser(user) && (
            <NavLink to="/" end className="qs-full-link" title="返回完整工作台">
              完整版
              <ArrowUpRight size={14} />
            </NavLink>
          )}
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
                    // SaaS 用户去极简创作自己的账户页;专家用户(从这个壳进来的
                    // 只有他们点了「极简创作」)回专家版设置。
                    navigate(isSaasUser(user) ? SAAS_ACCOUNT_PATH : '/settings');
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
      <main className="qs-main">
        <Outlet />
      </main>
    </div>
  );
}

export function QuickShell() {
  return (
    <ProjectProvider>
      <QuickShellContent />
    </ProjectProvider>
  );
}
