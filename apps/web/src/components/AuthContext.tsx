import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { fallbackPath, isSaasUser, passwordChangePath, saasPageAllowed, SAAS_HOME_PATH } from '../lib/saas-access';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth
      .me()
      .then(setUser)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    setUser(await api.auth.login(username, password));
  };

  const logout = async () => {
    await api.auth.logout().catch(() => undefined);
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, loading, login, logout, setUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}

/**
 * expertOnly:该分支是专家版工作台(AppShell)。SaaS 用户在**壳挂载之前**就被
 * 弹回 /quick —— 改前是先渲染 AppShell 再由内部判断,实测付费客户首次登录稳定
 * 停在专家壳里,整条 9 个入口的侧边栏可见可点。
 */
export function ProtectedRoute({ children, expertOnly }: { children: ReactNode; expertOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-loading"><span className="spinner" /><p>正在读取工作区…</p></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // 强制改密的落点按用户类型分叉:SaaS → /quick/account,专家 → /settings。
  // 改前这里硬编码 /settings,是「SaaS 用户必然落进专家壳」的直接原因。
  const changePath = passwordChangePath(user);
  if (user.mustChangePassword && location.pathname !== changePath) {
    return <Navigate to={changePath} replace />;
  }
  if (expertOnly && isSaasUser(user)) return <Navigate to={SAAS_HOME_PATH} replace />;
  // SaaS 用户只允许 /quick 及子路径,其余一律弹回 /quick
  if (isSaasUser(user) && !saasPageAllowed(location.pathname)) return <Navigate to={SAAS_HOME_PATH} replace />;
  return children;
}

/** 未匹配路由的兜底:按用户类型回各自的首页,而不是统一去 /。 */
export function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading"><span className="spinner" /><p>正在读取工作区…</p></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={fallbackPath(user)} replace />;
}

export function LoginForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} />;
}
