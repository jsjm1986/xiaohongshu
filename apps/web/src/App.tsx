import { Navigate, Route, Routes } from 'react-router-dom';
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
import { QuickReaderPage } from './pages/QuickReaderPage';
import { QuickWorkspaceLayout } from './pages/quick/QuickWorkspaceLayout';
import { QuickOverviewPage } from './pages/quick/QuickOverviewPage';
import { QuickKnowledgePage } from './pages/quick/QuickKnowledgePage';
import { QuickCreatePage } from './pages/quick/QuickCreatePage';
import { QuickHistoryPage } from './pages/quick/QuickHistoryPage';
import { QuickAreaFallback } from './pages/quick/QuickAreaFallback';
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
        {/*
          固定段必须写在 :projectId 之前才读得顺(React Router 的 rank 规则本身
          就让静态段优先,顺序只是给人看的)。quick-routes.ts 的
          QUICK_RESERVED_SEGMENTS 记着这张名单,新增固定段要一起加——
          否则一个叫 "read" 的项目 id 会被吃掉。
        */}
        <Route path="quick/account" element={<QuickAccountPage />} />
        {/* 阅读是独立页,不是产出列表里的手风琴:一篇文案有自己的地址,可收藏、可分享、
            可前进后退,读的时候屏幕上没有别的任务行 */}
        <Route path="quick/read/:jobId" element={<QuickReaderPage />} />
        {/*
          四个区是真频道,不是 useState 切渲染。地址里带 projectId:刷新停在原处、
          链接可分享、浏览器前进后退在四区之间走。跨区状态由布局路由的
          QuickWorkspaceProvider 持有,所以去产出区看一眼再回创作区,勾选还在。
        */}
        <Route path="quick/:projectId" element={<QuickWorkspaceLayout />}>
          {/* /quick/:id → 默认区。index 路由只匹配一次,相对路径在这里是安全的 */}
          <Route index element={<QuickAreaFallback />} />
          <Route path="overview" element={<QuickOverviewPage />} />
          <Route path="knowledge" element={<QuickKnowledgePage />} />
          <Route path="create" element={<QuickCreatePage />} />
          <Route path="history" element={<QuickHistoryPage />} />
          {/*
            认不出的区段(手改地址、旧收藏、拼错):纠正到默认区,而不是白屏。

            必须用绝对路径。相对的 <Navigate to="overview"> 在通配路由里是**追加**
            而不是替换——实测 /quick/:id/nope 会滚成
            /quick/:id/nope/overview/overview/overview/… 无限增长,因为每次重定向后
            仍然匹配 `*`,再追加一次。
          */}
          <Route path="*" element={<QuickAreaFallback />} />
        </Route>
      </Route>
      {/* 兜底也要按用户类型分叉:统一去 / 会让 SaaS 用户再被弹一次 */}
      <Route path="*" element={<RootRedirect />} />
    </Routes>
    </ToastProvider>
    </ErrorBoundary>
  );
}
