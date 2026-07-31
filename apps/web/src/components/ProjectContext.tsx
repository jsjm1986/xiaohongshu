import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { Project } from '../types';

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | undefined;
  projectId: string;
  setProjectId: (id: string) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addProject: (input: Pick<Project, 'name' | 'description' | 'domain'>) => Promise<Project>;
  updateProject: (id: string, input: Partial<Project>) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectIdState] = useState(localStorage.getItem('content-agent-project') || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.projects.list();
      setProjects(response.items);
    } catch (requestError) {
      setError(errorMessage(requestError, '项目列表加载失败'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (loading || error) return;
    const nextId = projects.some((project) => project.id === projectId)
      ? projectId
      : projects[0]?.id ?? '';
    if (nextId === projectId) return;
    setProjectIdState(nextId);
    if (nextId) {
      localStorage.setItem('content-agent-project', nextId);
    } else {
      localStorage.removeItem('content-agent-project');
    }
  }, [projectId, projects, loading, error]);

  const setProjectId = (id: string) => {
    setProjectIdState(id);
    if (id) localStorage.setItem('content-agent-project', id);
    else localStorage.removeItem('content-agent-project');
  };

  const addProject = async (input: Pick<Project, 'name' | 'description' | 'domain'>) => {
    const project = await api.projects.create(input);
    setProjects((current) => [project, ...current]);
    setProjectId(project.id);
    return project;
  };

  const updateProject = async (id: string, input: Partial<Project>) => {
    const updated = await api.projects.update(id, input);
    setProjects((current) => current.map((item) => (item.id === id ? updated : item)));
    return updated;
  };

  const removeProject = async (id: string) => {
    await api.projects.remove(id);
    setProjects((current) => {
      const next = current.filter((item) => item.id !== id);
      if (id === projectId) setProjectId(next[0]?.id ?? '');
      return next;
    });
  };

  const value = useMemo(
    () => ({
      projects,
      currentProject: projects.find((project) => project.id === projectId),
      projectId,
      setProjectId,
      loading,
      error,
      refresh,
      addProject,
      updateProject,
      removeProject,
    }),
    [projects, projectId, loading, error],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProjects must be used within ProjectProvider');
  return value;
}
