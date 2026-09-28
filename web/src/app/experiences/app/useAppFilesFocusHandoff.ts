import { useEffect, useState } from 'react';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';
import { filesFocusHandoff, parentDirectoryPath } from './appFilesPathUtils';

interface FilesNavigatorHandoff {
  navigateToPath: (path: string) => void;
  openFile: (
    entry: { path: string; name: string; size: number },
    options?: { initialLine?: number },
  ) => void;
}

export function useAppFilesFocusHandoff(
  focus: CapabilityFocus | undefined,
  fileOps: FileOps | null,
  onFocusConsumed: (() => void) | undefined,
  nav: FilesNavigatorHandoff,
) {
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handoff = filesFocusHandoff(focus);
  const handoffKey = handoff ? `${handoff.path}:${handoff.line ?? ''}` : null;

  const { navigateToPath, openFile } = nav;

  useEffect(() => {
    if (!handoffKey || !fileOps || !handoff) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const parent = parentDirectoryPath(handoff.path);
        const { entries } = await fileOps.listDir(parent);
        const entry = entries.find((e) => e.path === handoff.path && !e.is_dir);
        if (cancelled) {
          return;
        }
        if (!entry) {
          setHandoffError('Could not open file — it may have been moved or deleted.');
          onFocusConsumed?.();
          return;
        }
        setHandoffError(null);
        navigateToPath(parent);
        openFile(entry, { initialLine: handoff.line });
        onFocusConsumed?.();
      } catch {
        if (!cancelled) {
          setHandoffError('Could not open file — connection to the agent was interrupted.');
          onFocusConsumed?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handoffKey, fileOps, handoff, onFocusConsumed, navigateToPath, openFile]);

  return handoffError;
}
