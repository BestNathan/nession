import { useCallback, useState } from 'react';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';

/**
 * The Web shell's Terminal → Files navigation state (#3187).
 *
 * The Terminal only names the reference; Files resolves it against the active
 * Session's CWD and source. This hook owns the cross-surface handoff — choose
 * Files, open the Workspace surface, and hand the focus to Files once.
 */
export function useWebFilesNavigation(
  onToolChange: (tool: 'files') => void,
  onSurfaceChange: (surface: 'workspace') => void,
) {
  const [incomingFileFocus, setIncomingFileFocus] = useState<CapabilityFocus | undefined>();

  const openFileFromTerminal = useCallback(
    (path: string, line?: number, column?: number) => {
      setIncomingFileFocus({ capabilityId: 'files', resourceId: path, line, column });
      onToolChange('files');
      onSurfaceChange('workspace');
    },
    [onSurfaceChange, onToolChange],
  );

  const clearIncomingFileFocus = useCallback(() => {
    setIncomingFileFocus(undefined);
  }, []);

  return { incomingFileFocus, openFileFromTerminal, clearIncomingFileFocus };
}
