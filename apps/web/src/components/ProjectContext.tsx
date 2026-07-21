import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { demoProjects } from '../lib/fixtures';
import type { Project } from '../types';

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | undefined;
  projectId: string;
  setProjectId: (id: string) => void;
  loading: boolean;
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

  const refresh = async () => {
    try {
      const response = await api.projects.list();
      setProjects(response.items);
    } catch {
      setProjects(demoProjects);
    }
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectIdState(projects[0].id);
    if (projectId && projects.length && !projects.some((project) => project.id === projectId)) {
      setProjectIdState(projects[0].id);
    }
  }, [projectId, projects]);

  const setProjectId = (id: string) => {
    setProjectIdState(id);
    localStorage.setItem('content-agent-project', id);
  };

  const addProject = async (input: Pick<Project, 'name' | 'description' | 'domain'>) => {
    let project: Project;
    try {
      const workspaces = await api.workspaces.list().catch(() => []);
      project = await api.projects.create({ ...input, workspaceId: workspaces[0]?.id });
    } catch {
      project = {
        id: `local-${Date.now()}`,
        ...input,
        status: 'active',
        knowledgeCount: 0,
        generationCount: 0,
        updatedAt: new Date().toISOString(),
      };
    }
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
      refresh,
      addProject,
      updateProject,
      removeProject,
    }),
    [projects, projectId, loading],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('useProjects must be used within ProjectProvider');
  return value;
}
