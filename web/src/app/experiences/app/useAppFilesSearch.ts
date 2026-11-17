import { useEffect, useMemo, useState } from 'react';
import type { FileOps } from '@/capabilities/files';
import { fuzzyMatchesFile } from './appFilesFuzzy';
import {
  buildAppFilesSearchIndex,
  type AppFilesSearchIncompleteReason,
  type AppFilesSearchIndex,
} from './appFilesSearchIndex';

export type AppFilesSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The state Search shows before any scan has run. */
const EMPTY_INDEX: AppFilesSearchIndex = {
  files: [],
  complete: true,
  incompleteReason: null,
};

export function useAppFilesSearch(fileOps: FileOps | null, active: boolean) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AppFilesSearchStatus>('idle');
  const [index, setIndex] = useState(EMPTY_INDEX);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!active || !fileOps) {
      setStatus('idle');
      setIndex(EMPTY_INDEX);
      setError(null);
      setQuery('');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    setError(null);
    void buildAppFilesSearchIndex(fileOps, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          return;
        }
        setIndex(result);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      controller.abort();
    };
  }, [active, fileOps, retryToken]);

  const results = useMemo(() => {
    if (status !== 'ready') {
      return [];
    }
    return index.files.filter((entry) => fuzzyMatchesFile(query, entry.name, entry.path));
  }, [index, query, status]);

  const incompleteReason: AppFilesSearchIncompleteReason | null =
    status === 'ready' ? index.incompleteReason : null;

  return {
    query,
    setQuery,
    status,
    error,
    results,
    /** True when the scan stopped before covering the whole Workspace. */
    incomplete: incompleteReason !== null,
    incompleteReason,
    retry: () => {
      setRetryToken((t) => t + 1);
    },
  };
}
