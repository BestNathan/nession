import { useCallback, useState, useSyncExternalStore } from 'react';

import { ExplorerRegistry } from '../registry';

/**
 * Creates a per-Explorer-mount extension registry and re-renders the host
 * whenever contributions change (register/unregister), so row renderers
 * re-resolve decorations/context menus incrementally — no tree remount.
 */
export function useExplorerRegistry(): ExplorerRegistry {
  const [registry] = useState(() => new ExplorerRegistry());
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [registry],
  );
  const getVersion = useCallback(() => registry.getVersion(), [registry]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return registry;
}
