import { ChevronDown, Gauge, LogOut, Settings, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { EditionSwitch } from '../EditionSwitch';
import { ProjectProvider } from '../ProjectContext';
import { api } from '../../lib/api';
import { quotaCell, type QuotaSnapshot } from '../../lib/quota-view';
import { isSaasUser, SAAS_ACCOUNT_PATH } from '../../lib/saas-access';
import { useToast } from '../Ui';

/**
 * 极简创作 · 独立产品壳:无专家侧边栏,顶栏 + 居中内容区。
 * 自带 ProjectProvider(/quick 已从 AppShell 迁出)与 v2 token 作用域(根节点 v2 class 必带)。
 * 顶栏不下放全局项目切换器——项目在首页(QuickHome)自行管理。
 */
function QuickShellContent() {
  const [profileOpen, setProfileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  /**
   * 顶栏常驻额度。
   *
   * 原来额度只在【总览】页有一格,而用户真正会花掉额度的地方是【创作】页——在那里
   * 提一批 24 篇时看不见余量,只能撞上 403 才知道不够。付费产品不该让人这样发现
   * 余额问题。放在壳上,四个区都看得见。
   *
   * 只拉一次:额度变化的粒度是"每次生成 +1",没必要轮询;真正需要精确数字的地方
   * (账户页)会自己再拉。
   */
  useEffect(() => {
    let cancelled = false;
    api.workspaces.list()
      .then((list) => {
        const workspaceId = list[0]?.id;
        if (!workspaceId || cancelled) return;
        return api.settings.quota(workspaceId).then((snapshot) => {
          if (!cancelled) setQuota(snapshot);
        });
      })
      .catch(() => { /* 静默:额度读不到不该阻塞整个壳 */ });
    return () => { cancelled = true; };
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : '退出登录失败', 'error');
    }
  };

  const cell = quotaCell(quota);

  return (
    <div className="quick-shell v2">
      <header className="qs-topbar">
        <NavLink to="/quick" className="qs-brand" title="极简创作首页">
          <span className="qs-brand__mark">
            <Zap size={17} strokeWidth={2.2} />
          </span>
          <span className="qs-brand__text">
            <strong>极简创作</strong>
            {/* 壳自报版本,和顶栏切换器的当前态说同一个词 */}
            <small>基础版</small>
          </span>
        </NavLink>
        <div className="qs-topbar__right">
          {/* 额度常驻:BYOK 或读取失败时 quotaCell 返回 null,这一格整体不渲染 */}
          {cell && (
            <NavLink
              to={SAAS_ACCOUNT_PATH}
              className={`qs-quota qs-quota--${cell.tone}`}
              title={cell.note ?? '平台额度剩余生成次数'}
            >
              <Gauge size={13} />
              <strong>{cell.value}</strong>
              <small>{cell.unit}</small>
            </NavLink>
          )}
          {/*
            版本切换器,和专家版顶栏同一个组件、同一个位置。原来这里是单向的
            「完整版 ↗」链接,而回来的入口在专家版**侧边栏**里叫「极简创作」
            ——同一个动作两个名字两个位置。SaaS 用户只有基础版,组件自己返回 null。
          */}
          <EditionSwitch />
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
