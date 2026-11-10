import { useEffect, useState } from 'react';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';
import { resolveTerminalFileReference } from '@/app/workspace/terminalFileReference';

export interface WebFilesFocusTarget {
  /** Source-canonical path resolved against the Session CWD at activation time. */
  path: string;
  name: string;
  size: number;
  line?: number;
  column?: number;
}

export interface WebFilesFocusHandoffParams {
  focus: CapabilityFocus | undefined;
  fileOps: FileOps | null;
  sessionId: string | undefined;
  onFocusConsumed: (() => void) | undefined;
  onOpenFile: (target: WebFilesFocusTarget) => void;
}

/**
 * Web's Terminal → Files handoff (#3187).
 *
 * The Terminal names a file reference; this hook asks the active Session's
 * bound FileOps to resolve it against the current CWD and verifies the exact
 * target before the layout opens it. A failure is returned as a message the
 * layout can show — never turned into a different file.
 */
export function useFilesWebFocusHandoff({
  focus,
  fileOps,
  sessionId,
  onFocusConsumed,
  onOpenFile,
}: WebFilesFocusHandoffParams): string | null {
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const path = focus?.capabilityId === 'files' ? focus.resourceId : undefined;
  const line = focus?.line;
  const column = focus?.column;
  const handoffKey = path
    ? `${sessionId ?? ''}:${path}:${line ?? ''}:${column ?? ''}`
    : null;

  useEffect(() => {
    // With no provider there is nothing to resolve; consume the focus so a
    // later reattach cannot replay an old navigation unexpectedly. The layout
    // itself renders the explicit source-unavailable state.
    if (handoffKey && !fileOps) {
      onFocusConsumed?.();
    }
  }, [handoffKey, fileOps, onFocusConsumed]);

  useEffect(() => {
    if (!handoffKey || !path || !fileOps || !sessionId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resolution = await resolveTerminalFileReference(fileOps, sessionId, {
          path,
          line,
          column,
        });
        if (cancelled) {
          return;
        }
        if (!resolution.ok) {
          setHandoffError(resolution.reason);
          onFocusConsumed?.();
          return;
        }
        setHandoffError(null);
        const { target } = resolution;
        onOpenFile({
          path: target.path,
          name: target.name,
          size: target.size,
          line: target.line,
          column: target.column,
        });
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
  }, [handoffKey, path, line, column, fileOps, sessionId, onFocusConsumed, onOpenFile]);

  return handoffError;
}
