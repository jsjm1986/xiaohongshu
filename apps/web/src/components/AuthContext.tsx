import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { isSaasUser, saasPageAllowed } from '../lib/saas-access';
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

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="app-loading"><span className="spinner" /><p>正在读取工作区…</p></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/settings') return <Navigate to="/settings" replace />;
  // SaaS 用户只允许 /quick 与 /settings(及各自子路径),其余一律弹回 /quick。
  // 顺序:mustChangePassword 强制 /settings 在前,/settings 本来就在白名单内,不冲突。
  if (isSaasUser(user) && !saasPageAllowed(location.pathname)) return <Navigate to="/quick" replace />;
  return children;
}

export function LoginForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} />;
}
