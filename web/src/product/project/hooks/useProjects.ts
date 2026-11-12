import { useCallback, useEffect, useState } from 'react';
import { projectsApi } from '@/product/project';
import type { Project } from '@/product/project/types';

export interface ProjectsState {
  projects: Project[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/**
 * Load the Project list and keep it across transport installs.
 *
 * Projects have no change notification, so this is an explicit read: on mount,
 * on every transport (re)install, and after the caller's own mutations. A
 * not-yet-installed transport is a loading state, not an error — fixture routes
 * install their surface in a parent effect, which runs after this child effect.
 */
export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (projectsApi.connectionRevision() === 0) {
      setLoading(true);
      return;
    }
    setLoading(true);
    try {
      const next = await projectsApi.listProjects();
      setProjects(next);
      setError(null);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Projects could not be loaded');
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = projectsApi.onConnectionChange(() => {
      void refresh();
    });
    void refresh();
    return unsubscribe;
  }, [refresh]);

  return { projects, loading, error, loaded, refresh };
}
