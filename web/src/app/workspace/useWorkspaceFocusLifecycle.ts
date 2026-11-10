import { useEffect } from 'react';
import type { FileOps } from '@/capabilities/files';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';

/**
 * Workspace-panel focus lifecycle (#3187).
 *
 * - A Files focus with no provider is retired immediately: leaving it in the
 *   shell would let a later reattach replay an old navigation unexpectedly.
 *   The Workspace keeps showing the capability's explicit unavailable state.
 * - A depth report is cleared when the panel unmounts, so a stale `true`
 *   cannot silence the next Session's Terminal gesture (#1081).
 */
export function useWorkspaceFocusLifecycle(
  focus: CapabilityFocus | undefined,
  fileOps: FileOps | null,
  onFocusConsumed: (() => void) | undefined,
  onDepthChange: ((pushed: boolean) => void) | undefined,
): void {
  useEffect(() => {
    if (focus?.capabilityId === 'files' && fileOps === null) {
      onFocusConsumed?.();
    }
  }, [focus, fileOps, onFocusConsumed]);

  useEffect(() => {
    return () => onDepthChange?.(false);
  }, [onDepthChange]);
}
