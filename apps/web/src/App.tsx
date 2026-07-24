import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/AuthContext';
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
      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </ToastProvider>
    </ErrorBoundary>
  );
}
