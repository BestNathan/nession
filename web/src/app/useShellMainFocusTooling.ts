import { useCallback } from 'react';
import type { CapabilityId } from '@/product/capability';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';
import type { Surface } from '@/app/patterns/SessionHeader';

/** Tool changes and capsule → Workspace handoff with focus (#1175). */
export function useShellMainFocusTooling(
  setFocus: (focus: CapabilityFocus | undefined) => void,
  onToolChange: (tool: CapabilityId) => void,
  onSurfaceChange: (surface: Surface) => void,
) {
  const openTool = useCallback(
    (id: CapabilityId) => {
      setFocus(undefined);
      onToolChange(id);
    },
    [onToolChange, setFocus],
  );

  const openWorkspaceFromCapsule = useCallback(
    (id: CapabilityId, resourceId?: string) => {
      setFocus({ capabilityId: id, resourceId });
      onToolChange(id);
      onSurfaceChange('workspace');
    },
    [setFocus, onToolChange, onSurfaceChange],
  );

  return { openTool, openWorkspaceFromCapsule };
}
