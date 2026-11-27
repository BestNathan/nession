import { useContext } from 'react';
import { RefreshRuntimeContext, type RefreshRuntime } from './RefreshRuntimeContext';

/** The ambient refresh runtime. Throws rather than silently creating a private
 *  scheduler, which would defeat the shared in-flight budget. */
export function useRefreshRuntime(): RefreshRuntime {
  const runtime = useContext(RefreshRuntimeContext);
  if (!runtime) {
    throw new Error('usePullRefresh requires a <RefreshProvider> ancestor');
  }
  return runtime;
}