// web/src/product/session/state/session.ts
//
// The client's model of the Session it is attached to: identity, the choice it
// was attached with, and the attach dialog. Moved out of `atoms/` in #801
// Phase 5 — "a Session atom belongs to the Session owner"; `atoms/` was a
// directory named after a state-management technology, not an owner.
import { atom } from 'jotai';
import type { AttachInfo, EnvFileRef, Session, ProbedAddress } from '@/types';
import type { AttachChoice } from '@/product/session/components/AttachDialog';
import { p2pStateAtom, routeIntentEpochAtom } from '@/platform/attach/state/transport';
import { terminalSessionStateAtom } from '@/product/terminal/state/session';

export const sessionIdAtom = atom('');
export const sessionNameAtom = atom('');
export const attachInfoAtom = atom<AttachInfo | null>(null);
export const orderedUrlsAtom = atom<string[]>([]);
export const manualOverrideAtom = atom<string | null>(null);
export const forcedRelayAtom = atom(false);
/** The renderer this attachment was opened with, from its AttachChoice. */
export const rendererAtom = atom<'webgl' | 'canvas'>('webgl');
/** Env files this attachment was opened with, from its AttachChoice. */
export const envRefsAtom = atom<EnvFileRef[]>([]);

/** Currently open attach dialog session (the session-first shell's attach flow). */
export const attachDialogSessionAtom = atom<Session | null>(null);

/** Why the attach dialog is open: 'attach' (confirm → attach) or 'configure'
 *  (Save → persist the profile only, never attach/reconnect).
 *  Invariant: reset to 'attach' wherever `attachDialogSessionAtom` is cleared —
 *  `attachToSessionAtom`, `disconnectAtom`, and `useSessionFirstAttach.cancelAttach`.
 *  Every dialog opener sets the intent explicitly when opening: requestAttach /
 *  openAttachSettings (useSessionFirstAttach) and useSessionFirstDeepLink's
 *  restore opener (requestConfigForRestore). */
export type AttachDialogIntent = 'attach' | 'configure';

export const attachDialogIntentAtom = atom<AttachDialogIntent>('attach');

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
  (get, set, payload: { session: Session; choice: AttachChoice; navigate: (path: string) => void }) => {
    const { session, choice, navigate } = payload;
    // Re-attaching the session the client is ALREADY attached to keeps the
    // leased SessionRuntime alive (sessionIdAtom does not change), but the
    // dialog confirm carries a fresh connection token (the server mints one
    // per attach-info request). Without a route-intent bump the runtime would
    // silently rebuild its agent socket under the stale 'attached' phase and
    // never re-issue client.attach — freezing the terminal (#668). Bumping
    // the epoch routes the confirm through handleRouteIntentChange, the same
    // disconnect → reconnect cycle a manual address switch uses. Attaching a
    // DIFFERENT session needs no bump: the sessionId change releases the old
    // runtime and leases a fresh one from phase 'idle'.
    if (get(sessionIdAtom) === session.session_id) {
      set(routeIntentEpochAtom, get(routeIntentEpochAtom) + 1);
    }
    set(sessionIdAtom, session.session_id);
    set(sessionNameAtom, session.session_name);
    set(attachInfoAtom, choice.attachInfo);
    set(orderedUrlsAtom, choice.orderedUrls);
    set(rendererAtom, choice.renderer);
    set(envRefsAtom, choice.envRefs ?? []);
    set(manualOverrideAtom, choice.selectedUrl ?? null);
    set(forcedRelayAtom, false);
    set(attachDialogSessionAtom, null);
    set(attachDialogIntentAtom, 'attach');
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
    set(attachDialogIntentAtom, 'attach');
    set(p2pStateAtom, 'disconnected');
    set(terminalSessionStateAtom, 'idle');
    navigate('/');
  },
);
