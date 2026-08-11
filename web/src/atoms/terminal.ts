// web/src/atoms/terminal.ts
import { atom } from 'jotai';
import type { AttachInfo, EnvFileRef, Session } from '../types';
import type { P2PConnection, ConnectionState } from '../hooks/useP2PConnection';
import type { AttachChoice } from '../components/env/AttachDialog';

// ── Base atoms ──────────────────────────────────────────────────

/** Current attached session id, e.g. "k8s-agent:1". */
export const sessionIdAtom = atom('');
/** Short session name, e.g. "1". Sent in client.attach/terminal.input payloads. */
export const sessionNameAtom = atom('');
/** Server response from client.session.attach — all candidate addresses + token. */
export const attachInfoAtom = atom<AttachInfo | null>(null);
/** Browser-latency-sorted candidate P2P URLs, best-first. */
export const orderedUrlsAtom = atom<string[]>([]);
/** Selected renderer: webgl (GPU) or canvas (compatibility). */
export const rendererAtom = atom<'webgl' | 'canvas'>('webgl');
/** Env files to source after attach. */
export const envRefsAtom = atom<EnvFileRef[]>([]);
/** Manual address override (null = auto). Set by AddressSelector. */
export const manualOverrideAtom = atom<string | null>(null);
/** True when all P2P candidates have failed and we fell back to relay. */
export const forcedRelayAtom = atom(false);
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

// ── Derived atoms ────────────────────────────────────────────────

/** Currently active P2P URL — manual override, or best candidate, or null in relay. */
export const activeUrlAtom = atom<string | null>((get) => {
  if (get(forcedRelayAtom)) { return null; }
  const override = get(manualOverrideAtom);
  if (override) { return override; }
  return get(orderedUrlsAtom)[0] ?? null;
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

/** True when the user has an active terminal session (dashboard → terminal). */
export const hasActiveSessionAtom = atom((get) => get(sessionIdAtom) !== '');

/** Session ID parsed from the URL pathname, for deep-link restore. */
export const sessionIdFromUrlAtom = atom<string | null>(null);

// ── Action atoms ─────────────────────────────────────────────────

/** Attach to a session: write all base atoms + navigate to terminal route. */
export const attachToSessionAtom = atom(
  null,
  (_get, set, ...args: [Session, AttachChoice, (path: string) => void]) => {
    const [session, choice, navigate] = args;
    set(sessionIdAtom, session.session_id);
    set(sessionNameAtom, session.session_name);
    set(attachInfoAtom, choice.attachInfo);
    set(orderedUrlsAtom, choice.orderedUrls);
    set(rendererAtom, choice.renderer);
    set(envRefsAtom, choice.envRefs ?? []);
    set(manualOverrideAtom, choice.selectedUrl ?? null);
    set(forcedRelayAtom, false);
    set(terminalSessionStateAtom, 'connecting');
    navigate(`/terminal/${encodeURIComponent(session.session_id)}`);
  },
);

/** Disconnect from the current session: clear all atoms + navigate to dashboard. */
export const disconnectAtom = atom(
  null,
  (_get, set, navigate: (path: string) => void) => {
    set(sessionIdAtom, '');
    set(sessionNameAtom, '');
    set(attachInfoAtom, null);
    set(orderedUrlsAtom, []);
    set(manualOverrideAtom, null);
    set(forcedRelayAtom, false);
    set(p2pConnectionAtom, null);
    set(p2pStateAtom, 'disconnected');
    set(terminalSessionStateAtom, 'idle');
    navigate('/');
  },
);

/** Set a manual P2P address override. Resets forcedRelay so the user
 *  can recover from an all-candidates-failed relay fallback by
 *  explicitly picking a route. */
export const switchAddressAtom = atom(
  null,
  (_get, set, url: string | null) => {
    set(manualOverrideAtom, url);
    if (url !== null) { set(forcedRelayAtom, false); }
  },
);
