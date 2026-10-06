/**
 * Terminal Keys — a capability of the Terminal and of nothing else (`#826` §7).
 *
 * ## Why this is not under `capabilities/`
 *
 * It was, and the layer gate rejected it: a capability slice may import only
 * from `platform` and `shared`, and everything this one is made of — the key
 * row, the chord, the capsule it projects through — is `product/terminal`
 * machinery. There is no transport to own and no Workspace view to contribute,
 * which is what the `capabilities/` slices have in common; what is left is a
 * Terminal concept, so it lives with the Terminal's other concepts.
 *
 * The app layer still decides that it appears, and where. This states what it
 * is.
 *
 * No JSX here on purpose — `react-refresh/only-export-components` wants a file
 * to export either components or things, and this one is things. The key row is
 * `TerminalKeysProjection`. The body must still mount it with
 * `createElement` — calling the component function directly would run its hooks
 * on the Peek host's fiber, and switching from a real Peek (Git) to Terminal
 * Keys would change that host's hook count and crash on the next interaction.
 */
import { createElement } from 'react';
import { Keyboard } from 'lucide-react';
import type { CapabilityState } from '@/product/capability';
import type { CapabilityContextBinding } from '@/app/contextSignals';
import type { CapsuleProjectionBinding } from '@/app/capsuleProjections';
import { TerminalKeysProjection } from '@/product/terminal/TerminalKeysProjection';

export const TERMINAL_KEYS_ID = 'terminal-keys';
export const TERMINAL_KEYS_TITLE = 'Terminal Keys';
export const TERMINAL_KEYS_SHORT_TITLE = 'Keys';

/**
 * Reachable wherever there is a terminal to type into, and *sensed* where there
 * is no physical keyboard to type with (#1347 SC-37).
 *
 * Two questions, and the second is the one this capability answers that no
 * other does: is there a Session for the keys to reach, and is the user on a
 * touch surface. Web answers the first alone — the keys stay listed and
 * reachable, because a physical keyboard makes them optional rather than
 * absent. App answers both: the keys are `relevant`, which is the lifecycle's
 * word for "earned contextual presence", and the Context Disclosure lists them
 * without anything lighting the Work Ring — context is not work.
 */
export function resolveTerminalKeysState(context: {
  sessionId?: string;
  experience?: 'web' | 'app';
}): CapabilityState {
  if (!context.sessionId) {
    return 'unavailable';
  }
  return context.experience === 'app' ? 'relevant' : 'available';
}

/**
 * Terminal Keys as a *context sense* (#1347 SC-37/40).
 *
 * The capability's own statement of when the device itself makes it worth
 * surfacing: a touch surface with a Terminal to type into. It is the reference
 * context-sensed capability, the way Claude Code is the reference work-sensed
 * one, and the two feed the same disclosure through their own registries.
 *
 * Two things this must not do, and does not: it never reports work (the ring
 * answers `working`, and these keys are not working), and it never fires on
 * Web — a physical keyboard makes the keys optional, which is `available`
 * rather than `relevant`.
 */
export const terminalKeysContext: CapabilityContextBinding = {
  id: TERMINAL_KEYS_ID,
  sense: (context) => {
    if (context.experience !== 'app' || !context.sessionId) {
      return null;
    }
    return {
      capabilityId: TERMINAL_KEYS_ID,
      summary: 'Touch controls for Terminal',
    };
  },
};

export const terminalKeysProjection: CapsuleProjectionBinding = {
  id: TERMINAL_KEYS_ID,
  // The one capability here with no Workspace view to borrow a glyph from —
  // which is exactly the case `CapsuleProjectionBinding.icon` exists for: the
  // Terminal row draws identity for these keys or the column stays empty.
  icon: Keyboard,
  // A Terminal-local capability with a Peek and no Workspace view (#1046), and
  // since 2026-10-03 no longer a family of its own: the accessory variant is
  // retired (`SC-38`), so selecting it — from a sensed row or the ordinary list —
  // opens its Peek, the same single step every other capability takes.
  // The keys are tapped, not typed into, and the soft keyboard is the one thing
  // that would make them unusable: it covers the row the user is reaching for,
  // and it takes the vertical space the key row needs. So this one projection
  // claims input focus while it is up (#1034 §5) — the capsule blurs the field
  // when it appears and steps it out when the field is tapped back.
  //
  // The flag is deliberately *not* on Git's projection, and that asymmetry is
  // the design: a Peek is read while you go on typing (`git commit`), so taking
  // the keyboard from it would be a regression, not a consistency fix. Nothing
  // here names the capsule; nothing in the capsule names this.
  ownsInputFocus: true,
  // Nothing to add at Peek and no Workspace view to open: the key row is the
  // capability in full, which is the lower bound `capability-emergence.md`
  // allows a Terminal-local capability to stop at.
  body: ({ sendText, sendPhysKey, disabled }) =>
    createElement(TerminalKeysProjection, {
      sendSeq: sendText,
      sendPhysKey: (key) => {
        // `seq` is absent on a semantic key by construction, so the two arms
        // cannot both apply — and the fallback exists only for a host that
        // cannot send semantic keys at all.
        if (key.semanticKey && sendPhysKey) {
          sendPhysKey(key);
        } else if (key.seq) {
          sendText(key.seq);
        }
      },
      disabled,
    }),
};
