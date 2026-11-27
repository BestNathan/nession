import { useCallback, useState } from 'react';
import type { EnvFileInfo } from '@/types';
import { envApi } from '../envApi';
import { usePullRefresh, type PullRefreshPolicy } from '@/platform/refresh';

export interface EnvironmentProfiles {
  profiles: EnvFileInfo[];
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export interface EnvironmentProfilesOptions {
  connectionRevision?: number;
  enabled?: boolean;
  active?: boolean;
}

/** Env profiles are configuration, not live work: #4602 §2 puts them on the
 *  slow cadence, and they still read on show, resume and reconnect. */
const ENV_PROFILES_POLICY: PullRefreshPolicy = {
  intervalMs: 60_000,
  minIntervalMs: 5_000,
  timeoutMs: 15_000,
  onForeground: true,
  onReconnect: true,
  onActivate: true,
  autoRetry: true,
};

/**
 * The reusable Environment profiles (#1202).
 *
 * The list is independent of any Session. Which profiles a Session includes is
 * the binding's desired selection, read by `useSessionEnvBinding`; this hook
 * must not infer it from a legacy per-profile apply/unset mark.
 *
 * The latest-request fence this hook used to hand-write (#2878) is now the
 * shared pull controller's (#4602): an import or save starts a newer read while
 * an older one may still be in flight, and only the newest may publish.
 */
export function useEnvironmentProfiles(
  options: EnvironmentProfilesOptions = {},
): EnvironmentProfiles {
  const { connectionRevision = 0, enabled = true, active = true } = options;
  const [profiles, setProfiles] = useState<EnvFileInfo[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  const apply = useCallback((files: EnvFileInfo[]) => {
    setProfiles(files);
  }, []);

  const { refresh: pull, status } = usePullRefresh<EnvFileInfo[]>({
    context: ['env-profiles', connectionRevision],
    active,
    enabled,
    pull: async () => {
      const resp = await envApi.listEnvFiles();
      // A typed list error is a partial answer, not a transport failure: the
      // files it did return are still authoritative.
      setServerError(resp.error ?? null);
      return resp.files;
    },
    apply,
    policy: ENV_PROFILES_POLICY,
    label: 'env-profiles',
  });

  const refresh = useCallback(async (): Promise<void> => {
    await pull('manual');
  }, [pull]);

  return {
    profiles,
    loading: status.loading,
    refreshing: status.refreshing,
    stale: status.stale,
    error: serverError ?? status.error,
    refresh,
  };
}