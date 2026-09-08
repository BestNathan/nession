import { useMemo, useSyncExternalStore } from 'react';

import { ExplorerStore } from '../ExplorerStore';
import type { ExplorerDataProvider } from '../providers/types';

export function useExplorerStore(provider: ExplorerDataProvider): ExplorerStore {
  const store = useMemo(() => new ExplorerStore(provider), [provider]);

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
