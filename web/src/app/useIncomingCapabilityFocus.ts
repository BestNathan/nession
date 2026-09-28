import { useCallback, useEffect, useState } from 'react';
import type { CapabilityFocus } from '@/app/workspace/workspaceContext';

/** Merge focus handed from another App layer (Terminal → Workspace, #1175). */
export function useIncomingCapabilityFocus(
  incomingFocus?: CapabilityFocus,
  onIncomingFocusApplied?: () => void,
) {
  const [focus, setFocus] = useState<CapabilityFocus | undefined>(undefined);

  useEffect(() => {
    if (!incomingFocus) {
      return;
    }
    setFocus(incomingFocus);
    onIncomingFocusApplied?.();
  }, [incomingFocus, onIncomingFocusApplied]);

  const consumeFocus = useCallback(() => {
    setFocus(undefined);
  }, []);

  return { focus, setFocus, consumeFocus };
}
