import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, FileOps } from '@/capabilities/files';
import { fuzzyMatchesFile } from './appFilesFuzzy';
import { buildAppFilesSearchIndex } from './appFilesSearchIndex';

export type AppFilesSearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useAppFilesSearch(fileOps: FileOps | null, active: boolean) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AppFilesSearchStatus>('idle');
  const [index, setIndex] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!active || !fileOps) {
      setStatus('idle');
      setIndex([]);
      setError(null);
      setQuery('');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    setError(null);
    void buildAppFilesSearchIndex(fileOps, controller.signal)
      .then((entries) => {
        if (controller.signal.aborted) {
          return;
        }
        setIndex(entries);
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
    return index.filter((entry) => fuzzyMatchesFile(query, entry.name, entry.path));
  }, [index, query, status]);

  return {
    query,
    setQuery,
    status,
    error,
    results,
    retry: () => {
      setRetryToken((t) => t + 1);
    },
  };
}
