import { useCallback, useEffect, useState } from 'react';
import type { EnvFileInfo } from '@/types';
import { envApi } from '@/capabilities/env';

export interface EnvironmentProfiles {
  profiles: EnvFileInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * The reusable Environment profiles (#1202).
 *
 * The list is independent of any Session. Which profiles a Session includes is
 * the binding's desired selection, read by `useSessionEnvBinding`; this hook
 * must not infer it from a legacy per-profile apply/unset mark.
 */
export function useEnvironmentProfiles(): EnvironmentProfiles {
  const [profiles, setProfiles] = useState<EnvFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await envApi.listEnvFiles();
      setProfiles(resp.files);
      if (resp.error) {
        setError(resp.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load environments');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { profiles, loading, error, refresh };
}
