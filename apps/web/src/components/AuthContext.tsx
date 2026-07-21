import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { demoUser } from '../lib/fixtures';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isDemo: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const canUseDemoFallback = (error: unknown) =>
  !(error instanceof ApiError) || error.status === 404 || error.status >= 500;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    api.auth
      .me()
      .then(setUser)
      .catch(() => {
        const storedDemo = sessionStorage.getItem('content-agent-demo-session');
        if (storedDemo) {
          setUser(demoUser);
          setIsDemo(true);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    try {
      setUser(await api.auth.login(username, password));
      setIsDemo(false);
    } catch (error) {
      if (!canUseDemoFallback(error)) throw error;
      if (!username.trim() || !password.trim()) throw error;
      sessionStorage.setItem('content-agent-demo-session', '1');
      setUser({ ...demoUser, username, displayName: username === 'admin' ? demoUser.displayName : username });
      setIsDemo(true);
    }
  };

  const logout = async () => {
    if (!isDemo) await api.auth.logout().catch(() => undefined);
    sessionStorage.removeItem('content-agent-demo-session');
    setUser(null);
    setIsDemo(false);
  };

  return <AuthContext.Provider value={{ user, loading, isDemo, login, logout, setUser }}>{children}</AuthContext.Provider>;
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
  return children;
}

export function LoginForm({ onSubmit }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form onSubmit={onSubmit} />;
}
