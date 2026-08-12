// web/src/atoms/connection.ts
import { atom } from 'jotai';
import type { P2PConnection, ConnectionState } from '../hooks/useP2PConnection';
import {
  manualOverrideAtom, orderedUrlsAtom, forcedRelayAtom, attachInfoAtom,
} from './session';

// ── Base ────────────────────────────────────────────────────────

/** P2P WebSocket connection state. Written from useP2PConnection ws events. */
export const p2pStateAtom = atom<ConnectionState>('disconnected');
/** Stable P2P connection object. Written from useP2PConnection after construction. */
export const p2pConnectionAtom = atom<P2PConnection | null>(null);

// ── Terminal session state machine ─────────────────────────────

/**
 * Drives all protocol decisions for a terminal session.
 *
 *   idle → connecting        socket created (attachToSessionAtom)
 *   connecting → connected   ws.onopen / relay authenticated
 *   connected → attached     client.attach ok received
 *   connected → reconnecting attach timeout (10s)
 *   connected → failed       agent error (session not found)
 *   attached → reconnecting  socket drop
 *   reconnecting → connecting retry timer fires
 *   reconnecting → failed    max retries (10) exceeded
 *   failed → idle            manual disconnect
 *   any → idle               disconnectAtom / attachToSessionAtom
 */
export const terminalSessionStateAtom = atom<
  'idle' | 'connecting' | 'connected' | 'attached' | 'reconnecting' | 'failed'
>('idle');

/** Survives ConnectionManager rebuilds so reconnects preserve PTY size. */
export const lastResizeAtom = atom<{ cols: number; rows: number } | null>(null);

// ── Derived ─────────────────────────────────────────────────────

/** Currently active P2P URL — manual override, or best candidate, or null in relay. */
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) { return null; }
  return get(manualOverrideAtom) ?? get(orderedUrlsAtom)[0] ?? null;
});

/** Effective transport mode after considering forced relay fallback. */
export const effectiveModeAtom = atom<'p2p' | 'relay'>((get) => {
  if (get(forcedRelayAtom)) { return 'relay'; }
  return get(attachInfoAtom)?.mode === 'p2p' ? 'p2p' : 'relay';
});

/** True while the user manually selected an address that hasn't connected yet. */
export const isSwitchingAtom = atom((get) =>
  get(manualOverrideAtom) !== null && get(p2pStateAtom) !== 'connected',
);
