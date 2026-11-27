import { useCallback, useEffect, useState } from 'react';
import { projectsApi } from '@/product/project';
import type { Project } from '@/product/project/types';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface ProjectsState {
  projects: Project[];
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/** Projects are configuration, not live work: the slow cadence (#4602 §2). */
const PROJECTS_POLICY: PullRefreshPolicy = {
  intervalMs: 30_000,
  minIntervalMs: 3_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * Load the Project list and keep it across transport installs.
 *
 * Projects have no change notification, so this is an explicit read: on mount,
 * on every transport (re)install, on the ordinary cadence while visible, and
 * after the caller's own mutations. A not-yet-installed transport is a loading
 * state, not an error — fixture routes install their surface in a parent effect,
 * which runs after this child effect.
 *
 * **One list state owner, one ordering rule (#3387).** The hand-written
 * request-sequence + connection-generation fence this hook used to carry is now
 * the shared pull controller's (#4602): the installed transport's revision is
 * the read context, so a reinstall retires the previous read before any new
 * answer publishes, and at most one read is in flight per context. An older
 * success cannot resurrect a deleted Project or hide a newly created one, and a
 * late reply from a replaced transport cannot commit at all.
 */
export function useProjects(): ProjectsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [connectionRevision, setConnectionRevision] = useState(
    () => projectsApi.connectionRevision(),
  );

  useEffect(() => {
    const unsubscribe = projectsApi.onConnectionChange(() => {
      setConnectionRevision(projectsApi.connectionRevision());
    });
    // The transport may have changed between render and this effect; read the
    // current revision so the first context is the installed one.
    setConnectionRevision(projectsApi.connectionRevision());
    return unsubscribe;
  }, []);

  const apply = useCallback((next: Project[]) => {
    setProjects(next);
  }, []);

  const { refresh: pull, status } = usePullRefresh<Project[]>({
    context: ['projects', connectionRevision],
    enabled: connectionRevision !== 0,
    pull: () => projectsApi.listProjects(),
    apply,
    policy: PROJECTS_POLICY,
    label: 'projects',
  });

  const refresh = useCallback(async (): Promise<void> => {
    await pull('manual');
  }, [pull]);

  // A not-yet-installed transport is loading, not error; before the first answer
  // of an installed transport the list is also still loading.
  const noAnswerYet = status.lastSuccessAt === null && status.error === null;
  return {
    projects,
    loading: connectionRevision === 0 || status.loading || noAnswerYet,
    refreshing: status.refreshing,
    stale: status.stale,
    error: connectionRevision === 0 ? null : status.error,
    loaded: connectionRevision !== 0 && !noAnswerYet,
    refresh,
  };
}