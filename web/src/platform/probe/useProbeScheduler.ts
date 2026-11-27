// React bridge for the React-free probe scheduler (#4618).
//
// The scheduler owns the background task; this hook only subscribes. The
// external-store pattern mirrors `useSessionRuntimeSnapshot` — Jotai remains
// for UI preferences, runtime-owned facts flow through subscribe/getSnapshot.

import { useMemo, useSyncExternalStore } from 'react';
import { probeScheduler } from './ProbeScheduler';
import type { AddressProbeState, ProbeSnapshot } from './types';

/** Subscribe to the whole probe snapshot (any target's publication re-renders). */
export function useProbeSnapshot(): ProbeSnapshot {
  return useSyncExternalStore(probeScheduler.subscribe, probeScheduler.getSnapshot, probeScheduler.getSnapshot);
}

/** Per-address states for one target, in publication (inventory) order. */
export function useProbeTargetStates(targetId: string | null): AddressProbeState[] {
  const snapshot = useProbeSnapshot();
  return useMemo(() => {
    if (!targetId) {
      return [];
    }
    const states: AddressProbeState[] = [];
    for (const state of snapshot.states.values()) {
      if (state.targetId === targetId) {
        states.push(state);
      }
    }
    return states;
  }, [targetId, snapshot]);
}
