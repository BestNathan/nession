import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvFileRef } from '@/types';
import { envApi } from '@/capabilities/env';
import { refKey } from '@/capabilities/env/model/envRef';

export interface EnvProfileContent {
  /** Raw source text; null while loading or on error. */
  content: string | null;
  /** Sessions currently using this profile, from the same answer. */
  inUseBy: string[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * The read-first detail's content (#1202): one `server.env.get` per selected
 * profile, keyed by identity so a same-name profile at another location loads
 * its own content. Reveal nothing here — masking is a render concern.
 */
export function useEnvProfileContent(ref: EnvFileRef | null): EnvProfileContent {
  const [content, setContent] = useState<string | null>(null);
  const [inUseBy, setInUseBy] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The identity decides when to load; the object is read through a ref so a
  // fresh-but-identical ref never re-triggers a fetch it already has.
  const key = ref === null ? null : refKey(ref);
  const refRef = useRef(ref);
  refRef.current = ref;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = refRef.current;
    const own = ++generation.current;
    if (!current) {
      setContent(null);
      setInUseBy([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await envApi.getEnvFile(current);
      if (own !== generation.current) {
        return;
      }
      if (resp.success) {
        setContent(resp.content ?? '');
        setInUseBy(resp.in_use_by ?? []);
      } else {
        setContent(null);
        setError(resp.error ?? 'Failed to load profile');
      }
    } catch (e) {
      if (own !== generation.current) {
        return;
      }
      setContent(null);
      setError(e instanceof Error ? e.message : 'Failed to load profile');
    } finally {
      if (own === generation.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, key]);

  return { content, inUseBy, loading, error, reload };
}
