import { useCallback, useEffect, useRef, useState } from 'react';
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
 *
 * **One list state owner, one ordering rule (#3387).** A read is an
 * asynchronous answer about a repository the caller may already have moved on
 * from: a mutation's refresh, a later retry, or a reconnect all start a newer
 * read that is the current truth. Only the latest started read from the
 * currently installed transport may commit `projects`, `error`, `loaded` and
 * `loading`. An older success cannot resurrect a deleted Project or hide a
 * newly created one, and an older failure cannot replace a newer error or
 * clear the newer request's loading state.
 */
export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** The identity of the most recently started read. */
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const generation = projectsApi.connectionRevision();
    // Both halves of the fence: a newer read started (`sequence`) or the
    // transport that answered is no longer the installed one (`generation`).
    const current = () =>
      sequence === requestSequence.current &&
      projectsApi.connectionRevision() === generation;

    if (generation === 0) {
      // No transport: loading is the honest state, and this read is the
      // newest answer — any older in-flight read is already stale above.
      setLoading(true);
      return;
    }
    setLoading(true);
    try {
      const next = await projectsApi.listProjects();
      if (!current()) {
        return;
      }
      setProjects(next);
      setError(null);
      setLoaded(true);
    } catch (cause) {
      if (!current()) {
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Projects could not be loaded');
      setLoaded(true);
    } finally {
      if (current()) {
        setLoading(false);
      }
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
