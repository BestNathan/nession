import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { EnvFileInfo } from '@/types';
import { envApi } from '@/capabilities/env';
import { refKey, toRef } from '@/capabilities/env/model/envRef';

export interface EnvironmentProfiles {
  profiles: EnvFileInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * `refKey` set of the profiles sourced into the current Session — the quiet
   * "Active" state. Empty when there is no Session or the state cannot be
   * resolved; a usage failure never takes the list down with it.
   */
  activeKeys: ReadonlySet<string>;
  /** Apply/remove run against this Session; null hides those actions. */
  sessionId: string | null;
  applyToSession: (profile: EnvFileInfo) => Promise<boolean>;
  removeFromSession: (profile: EnvFileInfo) => Promise<boolean>;
  sessionActionPending: boolean;
}

/**
 * The Environment navigator's data (#1202): the profile list plus the current
 * Session's usage of it. Apply/remove stay contextual to the Session they
 * were handed — there is no cross-session bulk operation, and no Terminal
 * remount: the server re-sources, the view re-reads the active state.
 */
export function useEnvironmentProfiles(sessionId: string | null): EnvironmentProfiles {
  const [profiles, setProfiles] = useState<EnvFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKeys, setActiveKeys] = useState<ReadonlySet<string>>(new Set());
  const [sessionActionPending, setSessionActionPending] = useState(false);

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

  const refreshActive = useCallback(async () => {
    if (!sessionId) {
      setActiveKeys(new Set());
      return;
    }
    try {
      const resp = await envApi.getSessionEnvActive(sessionId);
      setActiveKeys(new Set(resp.active.map((a) => refKey(a))));
    } catch {
      setActiveKeys(new Set());
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshActive();
  }, [refreshActive]);

  const runSessionAction = useCallback(
    async (profile: EnvFileInfo, verb: 'apply' | 'unset'): Promise<boolean> => {
      if (!sessionId) {
        return false;
      }
      setSessionActionPending(true);
      try {
        const resp =
          verb === 'apply'
            ? await envApi.applySessionEnv(sessionId, [toRef(profile)])
            : await envApi.unsetSessionEnv(sessionId, [toRef(profile)]);
        if (!resp.success) {
          toast.error(resp.error ?? `Failed to ${verb === 'apply' ? 'apply' : 'remove'} ${profile.name}`);
          return false;
        }
        resp.warnings?.forEach((w) => toast.warning(w));
        await refreshActive();
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Session update failed');
        return false;
      } finally {
        setSessionActionPending(false);
      }
    },
    [sessionId, refreshActive],
  );

  const applyToSession = useCallback(
    (profile: EnvFileInfo) => runSessionAction(profile, 'apply'),
    [runSessionAction],
  );
  const removeFromSession = useCallback(
    (profile: EnvFileInfo) => runSessionAction(profile, 'unset'),
    [runSessionAction],
  );

  return {
    profiles,
    loading,
    error,
    refresh,
    activeKeys,
    sessionId,
    applyToSession,
    removeFromSession,
    sessionActionPending,
  };
}
