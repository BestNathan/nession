import { useEffect, useMemo, useRef, useState } from 'react';
import type { EnvFileRef } from '@/types';
import { envApi } from '@/capabilities/env';
import { refKey } from '@/capabilities/env/model/envRef';
import {
  changedKeys,
  effectivePreview,
  type EffectivePreview,
  type PreviewEntry,
} from '@/capabilities/env/model/bindingPreview';

export interface BindingPreview {
  current: EffectivePreview | null;
  draft: EffectivePreview | null;
  /** Key names whose effective value differs; values are never exposed. */
  changed: string[];
  /** Profiles whose content could not be read. */
  unavailable: Array<{ ref: EnvFileRef; error: string }>;
  loading: boolean;
}

interface FetchedContent {
  content: string | null;
  error: string | null;
}

const UNREAD: FetchedContent = { content: null, error: 'Profile unavailable' };

function uniqueRefs(refs: EnvFileRef[]): EnvFileRef[] {
  const seen = new Set<string>();
  const out: EnvFileRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

function entriesFor(
  refs: EnvFileRef[],
  contents: ReadonlyMap<string, FetchedContent>,
): PreviewEntry[] {
  return refs.map((ref) => {
    const fetched = contents.get(refKey(ref)) ?? { content: null, error: null };
    return { ref, ...fetched };
  });
}

/**
 * Effective-key preview for an ordered binding draft (#2654).
 *
 * Only the union of the current and draft profile refs is fetched, once per
 * draft, with bounded concurrency. Values stay in this hook's memory to
 * compare revisions; the view renders key names and counts only.
 */
export function useBindingPreview(
  currentRefs: EnvFileRef[],
  draftRefs: EnvFileRef[],
  enabled: boolean,
): BindingPreview {
  const [contents, setContents] = useState<ReadonlyMap<string, FetchedContent>>(new Map());
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, FetchedContent>());
  const generation = useRef(0);

  // The selection is an ordered list of identities; object identity and a new
  // array each render are not meaningful. The ref carries the latest objects;
  // the signature is what decides when a fetch is needed.
  const allRefs = uniqueRefs([...currentRefs, ...draftRefs]);
  const signature = allRefs.map(refKey).join('\u0000');
  const allRefsRef = useRef(allRefs);
  allRefsRef.current = allRefs;

  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setContents(new Map());
      setLoading(false);
      return;
    }

    const refs = allRefsRef.current;
    const gen = ++generation.current;
    const missing = refs.filter((ref) => !cache.current.has(refKey(ref)));
    if (missing.length === 0) {
      setContents(new Map(cache.current));
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    void (async () => {
      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const ref = missing[cursor];
          cursor += 1;
          if (!ref) {
            return;
          }
          try {
            const resp = await envApi.getEnvFile(ref);
            cache.current.set(
              refKey(ref),
              resp.success
                ? { content: resp.content ?? '', error: null }
                : { content: null, error: resp.error ?? UNREAD.error },
            );
          } catch (e) {
            cache.current.set(refKey(ref), {
              content: null,
              error: e instanceof Error ? e.message : UNREAD.error,
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(4, missing.length) }, () => worker()),
      );
      if (!cancelled && generation.current === gen) {
        setContents(new Map(cache.current));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, signature]);

  return useMemo(() => {
    if (!enabled) {
      return {
        current: null,
        draft: null,
        changed: [],
        unavailable: [],
        loading: false,
      };
    }
    const currentEntries = entriesFor(currentRefs, contents);
    const draftEntries = entriesFor(draftRefs, contents);
    const current = effectivePreview(currentEntries);
    const draft = effectivePreview(draftEntries);
    const unavailable = new Map<string, { ref: EnvFileRef; error: string }>();
    for (const entry of [...currentEntries, ...draftEntries]) {
      if (entry.content === null && entry.error !== null) {
        unavailable.set(refKey(entry.ref), { ref: entry.ref, error: entry.error });
      }
    }
    return {
      current,
      draft,
      changed: changedKeys(current, draft),
      unavailable: [...unavailable.values()],
      loading,
    };
  }, [enabled, currentRefs, draftRefs, contents, loading]);
}
