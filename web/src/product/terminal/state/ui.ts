// web/src/terminal/state/ui.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import type { ClipboardNotice } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';

export type { ReconnectBanner } from '@/platform/terminal-runtime/types';

/**
 * Input this Session lost rather than delivered, or `null` (#1307 SC-09).
 *
 * **What is kept, and what is deliberately not.** Only the fact of the loss —
 * how much, why, and when. Never the bytes: the requirement is explicit that
 * input contents do not become durable state (SC-15), and a notice that could
 * re-send them would have to remember them somewhere. That is also why the
 * notice offers no "send again": the answer to "these bytes may already have
 * run" is not a second attempt at running them.
 *
 * **Session-scoped, and it outlives the transport that recorded it.** The
 * queue lives in a `ConnectionManager`, and a transport swap builds a new one;
 * the loss is a fact about what the user typed, which does not stop being true
 * when the socket underneath it is replaced. Holding it here is what keeps the
 * notice on screen across exactly the reconnects that produce it.
 */
export const inputDropAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<InputDrop | null>(null);
});

/**
 * A transient clipboard state for this Session's surface (#2598).
 *
 * `id` lets an identical notice be presented again (a second refused copy is a
 * second event, not a stale render). The notice never carries clipboard bytes
 * beyond the text a **user gesture** can still complete: a remote OSC 52 write
 * blocked by browser permission is held until the user clicks Copy or the
 * notice expires, and it is dropped with the Session's surface.
 */
export interface ClipboardNoticeState {
  readonly id: number;
  readonly notice: ClipboardNotice;
}

export const clipboardNoticeAtomFamily = atomFamily((_sessionId: string) => {
  void _sessionId;
  return atom<ClipboardNoticeState | null>(null);
});
