// web/src/atoms/connection.ts
import { atom } from 'jotai';
import type { P2PConnection, ConnectionState } from '../hooks/useP2PConnection';
import {
  manualOverrideAtom, forcedRelayAtom, attachInfoAtom, agentIdAtom,
} from './session';
import { probeResultsAtom } from './probe';

// ── Base ────────────────────────────────────────────────────────

export const p2pStateAtom = atom<ConnectionState>('disconnected');
export const p2pConnectionAtom = atom<P2PConnection | null>(null);

/** Monotonic counter bumped by switchAddressAtom on every route switch. Its
 *  sole purpose is to force useP2PConnection's connection object identity to
 *  change — which in turn re-runs the p2pConnectionAtom effect and rebuilds
 *  Terminal.tsx's xterm view — even when the resolved activeUrl does not change
 *  (e.g. switching Auto → an explicit route that Auto already resolved to). */
export const p2pEpochAtom = atom(0);

// ── Derived ─────────────────────────────────────────────────────

/** Fastest reachable URL from the probe cache for the current agent. */
const fastestProbedUrlAtom = atom<string | null>((get) => {
  const probe = get(probeResultsAtom).get(get(agentIdAtom) ?? '');
  if (!probe?.orderedUrls.length) { return null; }
  return probe.orderedUrls[0] ?? null;
});

/** Currently active P2P URL.
 *  1. manualOverride (user explicitly picked a route)
 *  2. fastest reachable from probe results
 *  3. null — no known-reachable address, don't connect
 */
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) { return null; }
  return get(manualOverrideAtom) ?? get(fastestProbedUrlAtom);
});

export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) { return 'relay'; }
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

export const isSwitchingAtom = atom((get) =>
  get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected',
);
