import { useEffect, useState } from 'react';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';
import {
  resolveTerminalFileReference,
  sourceParentDirectory,
} from '@/app/workspace/terminalFileReference';

interface FilesNavigatorHandoff {
  navigateToPath: (path: string) => void;
  openFile: (
    entry: { path: string; name: string; size: number },
    options?: { initialLine?: number; initialColumn?: number },
  ) => void;
}

export interface AppFilesFocusHandoffParams {
  focus: CapabilityFocus | undefined;
  fileOps: FileOps | null;
  sessionId: string | undefined;
  onFocusConsumed: (() => void) | undefined;
  nav: FilesNavigatorHandoff;
}

export function useAppFilesFocusHandoff({
  focus,
  fileOps,
  sessionId,
  onFocusConsumed,
  nav,
}: AppFilesFocusHandoffParams) {
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handoff =
    focus?.capabilityId === 'files' && focus.resourceId
      ? { path: focus.resourceId, line: focus.line, column: focus.column }
      : null;
  const handoffKey = handoff
    ? `${sessionId ?? ''}:${handoff.path}:${handoff.line ?? ''}:${handoff.column ?? ''}`
    : null;

  const { navigateToPath, openFile } = nav;
  const handoffPath = handoff?.path;
  const handoffLine = handoff?.line;
  const handoffColumn = handoff?.column;

  useEffect(() => {
    if (!handoffKey || !fileOps || !handoffPath || !sessionId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resolution = await resolveTerminalFileReference(fileOps, sessionId, {
          path: handoffPath,
          line: handoffLine,
          column: handoffColumn,
        });
        if (cancelled) {
          return;
        }
        if (!resolution.ok) {
          setHandoffError(resolution.reason);
          onFocusConsumed?.();
          return;
        }
        const { target } = resolution;
        setHandoffError(null);
        navigateToPath(sourceParentDirectory(target.path));
        openFile(
          { path: target.path, name: target.name, size: target.size },
          { initialLine: target.line, initialColumn: target.column },
        );
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
  }, [
    handoffKey, handoffPath, handoffLine, handoffColumn,
    fileOps, onFocusConsumed, navigateToPath, openFile, sessionId,
  ]);

  return handoffError;
}
