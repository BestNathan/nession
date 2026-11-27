import { useContext } from 'react';
import { RefreshScheduler } from './RefreshScheduler';
import { RefreshSignalBus } from './RefreshSignalBus';
import { RefreshRuntimeContext, type RefreshRuntime } from './RefreshRuntimeContext';
import { systemClock } from './types';

/**
 * The composition-wide default, used when no explicit provider is mounted.
 *
 * It is one shared singleton rather than a per-hook instance, so the in-flight
 * budget stays global even on a mount that never declared a provider. A test
 * that needs deterministic time mounts {@link RefreshProvider} with a fake
 * clock instead of reaching for this.
 */
let defaultRuntime: RefreshRuntime | null = null;

function sharedRuntime(): RefreshRuntime {
  if (!defaultRuntime) {
    defaultRuntime = {
      scheduler: new RefreshScheduler({ clock: systemClock }),
      signals: new RefreshSignalBus(),
      clock: systemClock,
    };
  }
  return defaultRuntime;
}

export function useRefreshRuntime(): RefreshRuntime {
  return useContext(RefreshRuntimeContext) ?? sharedRuntime();
}