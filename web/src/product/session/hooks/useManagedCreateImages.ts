import { useCallback, useEffect, useState } from 'react';
import {
  imagesApi,
  type ImageDescriptor,
  type ImageLibraryEntry,
} from '@/capabilities/images';

const LIBRARY_LIMIT = 200;

export interface ManagedCreateImagesState {
  entries: ImageLibraryEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  projectSource: ImageDescriptor | null;
  projectSourceLoading: boolean;
  projectSourceError: string | null;
  refresh: () => void;
}

/**
 * The Server Catalog revisions a Managed Project Session may name (#3794).
 *
 * The Library is the Server's inventory; this hook never synthesizes a Base
 * or Toolchain. The pinned Project Source image is read by digest so the
 * preview can show its realized source and refuse a stale Git declaration
 * before Create. Every failure stays visible; nothing falls back to Native.
 */
export function useManagedCreateImages(
  isOpen: boolean,
  projectSourceDigest: string | undefined,
): ManagedCreateImagesState {
  const [entries, setEntries] = useState<ImageLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectSource, setProjectSource] = useState<ImageDescriptor | null>(null);
  const [projectSourceLoading, setProjectSourceLoading] = useState(false);
  const [projectSourceError, setProjectSourceError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void imagesApi
      .listLibrary({ offset: 0, limit: LIBRARY_LIMIT })
      .then((page) => {
        if (!cancelled) {
          setEntries(page.entries);
          setTotal(page.total);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setEntries([]);
          setTotal(0);
          setError(cause instanceof Error ? cause.message : 'Image Library is unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, revision]);

  useEffect(() => {
    if (!isOpen || !projectSourceDigest) {
      setProjectSource(null);
      setProjectSourceError(null);
      setProjectSourceLoading(false);
      return;
    }
    let cancelled = false;
    setProjectSourceLoading(true);
    setProjectSourceError(null);
    void imagesApi
      .getImage({ digest: projectSourceDigest })
      .then((descriptor) => {
        if (!cancelled) {
          setProjectSource(descriptor);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setProjectSource(null);
          setProjectSourceError(
            cause instanceof Error ? cause.message : 'Project Source image is unavailable',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProjectSourceLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectSourceDigest, revision]);

  const refresh = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  return {
    entries,
    total,
    loading,
    error,
    projectSource,
    projectSourceLoading,
    projectSourceError,
    refresh,
  };
}
