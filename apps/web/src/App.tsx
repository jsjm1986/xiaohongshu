import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute, RootRedirect } from './components/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Ui';
import { QuickShell } from './components/quick/QuickShell';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { FormulasPage } from './pages/FormulasPage';
import { GenerationResultPage } from './pages/GenerationResultPage';
import { GeneratorPage } from './pages/GeneratorPage';
import { HistoryPage } from './pages/HistoryPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { QuickAccountPage } from './pages/QuickAccountPage';
import { QuickChannelPage } from './pages/QuickChannelPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResearchPage } from './pages/ResearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamPage } from './pages/TeamPage';

export default function App() {
  return (
    <ErrorBoundary>
    <ToastProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/*
        两棵独立的路由树。SaaS 用户的树里**根本没有专家页面**——不是渲染出来再
        弹走。改前是「先挂 AppShell,再由内部判断跳转」,实测结果是付费客户首次
        登录稳定停在专家壳里,整条 9 个入口的侧边栏可见可点。
        expertOnly 让 SaaS 用户在 AppShell 挂载之前就被弹回 /quick。
      */}
      <Route element={<ProtectedRoute expertOnly><AppShell /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="generate" element={<GeneratorPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="formulas" element={<FormulasPage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="generations/:id" element={<GenerationResultPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>
      <Route element={<ProtectedRoute><QuickShell /></ProtectedRoute>}>
        <Route path="quick" element={<QuickChannelPage />} />
        <Route path="quick/account" element={<QuickAccountPage />} />
      </Route>
      {/* 兜底也要按用户类型分叉:统一去 / 会让 SaaS 用户再被弹一次 */}
      <Route path="*" element={<RootRedirect />} />
    </Routes>
    </ToastProvider>
    </ErrorBoundary>
  );
}
