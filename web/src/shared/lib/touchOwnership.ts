/**
 * Exclusive touch ownership, shared by every surface that reacts to a finger.
 *
 * A long-press gesture arms *after* the touch has already started, so the
 * shell pager and the terminal's touch-scroll owner have both seen the start
 * and may have captured their own state. Stopping propagation only works if
 * the pad's listener runs first — and that is ordering, not authority. This
 * registry is the authority: a surface that owns a finger claims it here, and
 * every other touch consumer checks the claim before acting.
 *
 * The identifier is the browser's `Touch.identifier`, which is unique among
 * the touches of one sequence and is the only identity every consumer sees.
 * A claim is released explicitly when the gesture ends; `releaseAll` is the
 * page-lifetime escape hatch (the sequence cannot survive `pagehide`).
 */
const owners = new Map<number, symbol>();

/**
 * Claim `identifier` for `owner`. Returns a release function that is inert if
 * the identifier has since been claimed again — a stale release from an old
 * gesture must not hand a new finger's ownership away.
 */
export function claimTouchOwnership(identifier: number, owner: string): () => void {
  const token = Symbol(owner);
  owners.set(identifier, token);
  return () => {
    if (owners.get(identifier) === token) {
      owners.delete(identifier);
    }
  };
}

/** Whether some surface currently owns this finger's events. */
export function isTouchOwned(identifier: number): boolean {
  return owners.has(identifier);
}

/** Drop every claim — for pagehide/unload, where no later event will arrive. */
export function releaseAllTouchOwnership(): void {
  owners.clear();
}
