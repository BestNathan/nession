// web/src/atoms/session.ts
import { atom } from 'jotai';
import type { AttachInfo, EnvFileRef, Session, ProbedAddress } from '../types';
import type { AttachChoice } from '../components/env/AttachDialog';
import { p2pStateAtom, routeIntentEpochAtom } from './connection';
import { terminalSessionStateAtom } from '../terminal/state/session';
import { probeResultsAtom } from './probe';
import { resolveAutoP2pUrl } from '../lib/resolveAutoP2pUrl';

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
    set(p2pStateAtom, 'disconnected');
    set(terminalSessionStateAtom, 'idle');
    navigate('/');
  },
);

export const switchAddressAtom = atom(
  null,
  (get, set, url: string | null) => {
    // No-op when the user re-selects the route they're already on — same
    // manualOverride source.  Without this guard the unconditional
    // disconnect/reconnect cycle below would flash a spinner (isSwitching
    // becomes true while p2pState catches up) for what is logically a no-op,
    // and needlessly tear down a live P2P socket.
    //
    // Two no-op cases:
    //   1. Explicit URL re-selected (url === currentOverride !== null)
    //   2. Auto re-selected (url === null && currentOverride === null)
    //
    // The Auto → explicit-same-URL case is intentionally NOT short-circuited:
    // there manualOverride changes (null → url) so the source of the URL
    // changed and the epoch bump / rebuild still has to fire.
    // Re-probe latency changes also don't come through here (they update
    // probeResultsAtom directly), so a same-source Auto selection truly
    // means "no state change needed".
    const currentOverride = get(manualOverrideAtom);
    if (url === currentOverride) {
      return;
    }

    // Explicit → Auto when Auto would resolve to the same URL: clear override only.
    // Skips disconnect/reconnect and useAddressPlan async re-probe (orderedUrls already set).
    if (url === null && currentOverride !== null) {
      const probe = get(probeResultsAtom).get(get(agentIdAtom) ?? '');
      const autoUrl = resolveAutoP2pUrl(
        get(orderedUrlsAtom),
        probe?.orderedUrls ?? [],
        get(attachInfoAtom),
      );
      if (autoUrl === currentOverride) {
        const terminalState = get(terminalSessionStateAtom);
        if (terminalState !== 'failed') {
          set(manualOverrideAtom, null);
          return;
        }
        set(manualOverrideAtom, null);
        set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
        return;
      }
    }

    set(manualOverrideAtom, url);
    set(forcedRelayAtom, false);
    // Bump the route epoch so SessionRuntime detects the route change and the
    // terminal rebuilds its view against the new socket — even when the
    // resolved activeUrl does not change (e.g. Auto → an explicit route that
    // Auto already resolved to).
    set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
  },
);

// The imports below create a circular dependency between session.ts,
// connection.ts, and terminal/state/session.ts. This is fine because:
// 1. session.ts imports connection.ts for p2pStateAtom/routeIntentEpochAtom (write-only)
// 2. connection.ts imports session.ts for derived atoms (read-only)
// 3. session.ts imports terminal/state/session.ts for terminalSessionStateAtom (write-only)
// 4. terminal/state/session.ts imports atoms/session.ts (sessionId/sessionName, read-only)
//    and atoms/connection.ts (effectiveModeAtom, read-only)
// 5. Jotai atoms support circular imports — atom definitions don't execute at import time
