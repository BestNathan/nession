// web/src/atoms/session.ts
import { atom, getDefaultStore } from 'jotai';
import type { AttachInfo, EnvFileRef, Session, ProbedAddress } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';
import { p2pConnectionAtom, p2pStateAtom } from './connection';
import { terminalSessionStateAtom } from '../terminal/state/session';

// ── Base atoms ──────────────────────────────────────────────────

export const sessionIdAtom = atom('');
export const sessionNameAtom = atom('');
export const attachInfoAtom = atom<AttachInfo | null>(null);
export const orderedUrlsAtom = atom<string[]>([]);
export const manualOverrideAtom = atom<string | null>(null);
export const forcedRelayAtom = atom(false);
export const rendererAtom = atom<'webgl' | 'canvas'>('webgl');
export const envRefsAtom = atom<EnvFileRef[]>([]);

/** Currently open attach dialog session (shared between Dashboard & SessionDropdown). */
export const attachDialogSessionAtom = atom<Session | null>(null);

// ── Derived atoms (read-only) ───────────────────────────────────

export const agentIdAtom = atom<string | null>((get) => {
  const sid = get(sessionIdAtom);
  return sid ? sid.split(':')[0] : null;
});

export const addressesAtom = atom<ProbedAddress[]>((get) =>
  get(attachInfoAtom)?.addresses ?? [],
);

export const hasActiveSessionAtom = atom((get) => get(sessionIdAtom) !== '');

/** Session ID parsed from the URL pathname, for deep-link restore. */
export const sessionIdFromUrlAtom = atom<string | null>(null);

// ── Action atoms ─────────────────────────────────────────────────

export const attachToSessionAtom = atom(
  null,
  (_get, set, payload: { session: Session; choice: AttachChoice; navigate: (path: string) => void }) => {
    const { session, choice, navigate } = payload;
    set(sessionIdAtom, session.session_id);
    set(sessionNameAtom, session.session_name);
    set(attachInfoAtom, choice.attachInfo);
    set(orderedUrlsAtom, choice.orderedUrls);
    set(rendererAtom, choice.renderer);
    set(envRefsAtom, choice.envRefs ?? []);
    set(manualOverrideAtom, choice.selectedUrl ?? null);
    set(forcedRelayAtom, false);
    set(attachDialogSessionAtom, null);
    set(terminalSessionStateAtom, 'connecting');
    navigate(`/terminal/${encodeURIComponent(session.session_id)}`);
  },
);

export const disconnectAtom = atom(
  null,
  (_get, set, navigate: (path: string) => void) => {
    set(sessionIdAtom, '');
    set(sessionNameAtom, '');
    set(attachInfoAtom, null);
    set(orderedUrlsAtom, []);
    set(manualOverrideAtom, null);
    set(forcedRelayAtom, false);
    set(envRefsAtom, []);
    set(attachDialogSessionAtom, null);
    set(p2pConnectionAtom, null);
    set(p2pStateAtom, 'disconnected');
    set(terminalSessionStateAtom, 'idle');
    navigate('/');
  },
);

export const switchAddressAtom = atom(
  null,
  (_get, set, url: string | null) => {
    set(manualOverrideAtom, url);
    set(forcedRelayAtom, false);
    // Force full disconnect: clear connection + reset state to idle.
    // The Terminal effect's idle case tears down any pending
    // timeout/subscription.  useP2PConnection will react to activeUrl
    // change and create a fresh socket, and the bridge picks up
    // p2pState='connected' from the NEW socket.
    set(p2pConnectionAtom, null);
    set(terminalSessionStateAtom, 'idle');
    setTimeout(() => {
      getDefaultStore().set(terminalSessionStateAtom, 'connecting');
    }, 0);
  },
);

// The import from ./connection creates a circular dependency between
// session.ts and connection.ts. This is fine because:
// 1. session.ts imports connection.ts for p2pConnectionAtom/p2pStateAtom (write-only)
// 2. connection.ts imports session.ts for derived atoms (read-only)
// 3. Jotai atoms support circular imports — atom definitions don't execute at import time
