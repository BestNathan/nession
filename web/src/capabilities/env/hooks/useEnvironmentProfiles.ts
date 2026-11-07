import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * Latest-request owner (#2878). An import or save starts a newer list read
   * while an older one may still be in flight; only the newest request may
   * write the list, error or loading. A late answer from a superseded request
   * is discarded rather than overwriting the just-imported Profile.
   */
  const requestGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const resp = await envApi.listEnvFiles();
      if (requestGenerationRef.current !== generation) { return; }
      setProfiles(resp.files);
      if (resp.error) {
        setError(resp.error);
      }
    } catch (e) {
      if (requestGenerationRef.current !== generation) { return; }
      setError(e instanceof Error ? e.message : 'Failed to load environments');
    } finally {
      if (requestGenerationRef.current === generation) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { profiles, loading, error, refresh };
}
