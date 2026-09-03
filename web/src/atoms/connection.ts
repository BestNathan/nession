// web/src/atoms/connection.ts
import { atom } from 'jotai';
import type { P2PConnection, P2PConnectionState as ConnectionState } from '@/services/socket/p2pTypes';
import {
  manualOverrideAtom, forcedRelayAtom, attachInfoAtom, agentIdAtom, orderedUrlsAtom,
} from './session';
import { probeResultsAtom } from './probe';
import { resolveAutoP2pUrl } from '../lib/resolveAutoP2pUrl';

// ── Base ────────────────────────────────────────────────────────

export const p2pStateAtom = atom<ConnectionState>('disconnected');
export const p2pConnectionAtom = atom<P2PConnection | null>(null);

/** @deprecated Route identity is owned by SessionRuntime; kept for compat during migration. */
export const p2pEpochAtom = atom(0);

// ── Derived ─────────────────────────────────────────────────────

/** Currently active P2P URL.
 *  1. manualOverride (user explicitly picked a route)
 *  2. orderedUrls from attach choice (dialog / deep-link restore)
 *  3. fastest reachable from probe results
 *  4. legacy agent_address or first candidate from attachInfo
 */
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) { return null; }
  const manual = get(manualOverrideAtom);
  if (manual) { return manual; }
  const probe = get(probeResultsAtom).get(get(agentIdAtom) ?? '');
  return resolveAutoP2pUrl(
    get(orderedUrlsAtom),
    probe?.orderedUrls ?? [],
    get(attachInfoAtom),
  );
});

export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) { return 'relay'; }
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

export const isSwitchingAtom = atom((get) =>
  get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected',
);
