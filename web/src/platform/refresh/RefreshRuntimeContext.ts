import { createContext } from 'react';
import type { RefreshScheduler } from './RefreshScheduler';
import type { RefreshSignalBus } from './RefreshSignalBus';
import type { RefreshClock } from './types';

export interface RefreshRuntime {
  scheduler: RefreshScheduler;
  signals: RefreshSignalBus;
  clock: RefreshClock;
}

export const RefreshRuntimeContext = createContext<RefreshRuntime | null>(null);