import { useMemo, type ReactNode } from 'react';
import { RefreshScheduler } from './RefreshScheduler';
import { RefreshSignalBus } from './RefreshSignalBus';
import { RefreshRuntimeContext, type RefreshRuntime } from './RefreshRuntimeContext';
import { systemClock, type RefreshClock } from './types';

export interface RefreshProviderProps {
  children: ReactNode;
  /** Test seam: a fake clock makes every lifecycle assertion deterministic. */
  clock?: RefreshClock;
  maxInFlight?: number;
  maxPerTarget?: number;
  /** Test seam: an isolated bus per provider mount. */
  signals?: RefreshSignalBus;
}

/**
 * One refresh runtime per app composition (#4602 §1).
 *
 * The scheduler is shared so its in-flight budget is genuinely global — a
 * per-surface scheduler would let ten visible lists open ten reads at once. It
 * is created per provider mount rather than held in a module global, so a test
 * (or a second root) gets its own budgets and timers with nothing to reset
 * between cases. Children retire their controllers before this unmounts, which
 * is what leaves no armed due time behind.
 */
export function RefreshProvider({
  children,
  clock = systemClock,
  maxInFlight,
  maxPerTarget,
  signals,
}: RefreshProviderProps) {
  const runtime = useMemo<RefreshRuntime>(() => ({
    scheduler: new RefreshScheduler({
      clock,
      ...(maxInFlight === undefined ? {} : { maxInFlight }),
      ...(maxPerTarget === undefined ? {} : { maxPerTarget }),
    }),
    signals: signals ?? new RefreshSignalBus(() => clock.now()),
    clock,
  }), [clock, maxInFlight, maxPerTarget, signals]);

  return (
    <RefreshRuntimeContext.Provider value={runtime}>
      {children}
    </RefreshRuntimeContext.Provider>
  );
}