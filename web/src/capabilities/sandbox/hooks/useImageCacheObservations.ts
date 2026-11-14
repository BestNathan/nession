import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ImageCacheObservation } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { sandboxApi } from '../SandboxPlugin';

/** Measured Agent cache observations keyed by image digest. */
export interface ImageCacheObservationsState {
  observations: Map<string, ImageCacheObservation>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const ACTIVE_PHASES: ReadonlySet<ImageCacheObservation['phase']> = new Set([
  'resumable',
  'downloading',
  'verifying',
]);

/** Whether an observation is still changing and worth re-reading. */
export function observationIsActive(observation: ImageCacheObservation): boolean {
  return observation.active || ACTIVE_PHASES.has(observation.phase);
}

const POLL_INTERVAL_MS = 2_000;

/**
 * Per-digest Agent cache transfer observations (#3412, #3408).
 *
 * The Agent is the authority: this hook only re-reads the authenticated
 * Session context while an observation is still active. A read failure keeps
 * the last measured observations and reports the failure instead of inventing
 * a state. Verifying is not mount-ready; only `verified` is.
 */
export function useImageCacheObservations(
  sessionId: string | null,
  digests: readonly string[],
): ImageCacheObservationsState {
  const digestKey = useMemo(() => [...new Set(digests)].sort().join(','), [digests]);
  const requested = useMemo(
    () => (digestKey.length === 0 ? [] : digestKey.split(',')),
    [digestKey],
  );
  const [observations, setObservations] = useState<Map<string, ImageCacheObservation>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (sessionId === null || requested.length === 0) {
      setObservations(new Map());
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const read = () => {
      setLoading(true);
      sandboxApi
        .imageCacheObservations(sessionId, requested)
        .then((next) => {
          if (cancelled) {
            return;
          }
          const map = new Map(next.map((observation) => [observation.digest, observation]));
          setObservations(map);
          setError(null);
          if (next.some(observationIsActive)) {
            timer = setTimeout(read, POLL_INTERVAL_MS);
          }
        })
        .catch((failure: unknown) => {
          if (!cancelled) {
            setError(
              failure instanceof Error
                ? failure.message
                : 'Agent image cache progress is unavailable',
            );
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    };

    read();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [sessionId, requested, revision]);

  const refresh = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  return { observations, loading, error, refresh };
}
