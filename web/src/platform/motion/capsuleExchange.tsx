import { createContext, useContext, type CSSProperties } from 'react';

/**
 * How far a drag has carried the App between its two Capsule states.
 *
 * `0` = the Terminal owns the capsule slot (Conversation Form); `1` = the
 * Workspace does (Capability Form). A drag between them is a continuum, and
 * this is the fraction the capsules hand the slot over on — the outgoing form
 * drifts out and fades as the finger travels, the incoming one settles in
 * behind it, so the exchange reads as one object changing state rather than
 * two capsules passing each other (owner follow-up, 2026-10-03).
 *
 * It lives in `platform/` because both sides of the handoff have to agree on
 * it and neither can import the other: the provider is the App's navigation
 * composition (`AppLayers`, app layer) and the consumers are the Terminal's
 * capsule shell and the Workspace's capability capsule. `platform` is the
 * layer beneath all of them and — deliberately — assigns it no product
 * meaning beyond "a motion handoff is in progress"; Web provides nothing and
 * every consumer treats `null` as "no exchange", which is why the Web
 * reciprocal pair is untouched by any of this.
 */
export interface CapsuleExchange {
  /** The handoff fraction between the Terminal (0) and Workspace (1) capsule. */
  progress: number;
}

/**
 * The drift the outgoing Conversation form travels, in px, at full handoff —
 * small on purpose: the capsule steps aside for the incoming form, it does
 * not fly off screen, and the distance is a constant of this composition
 * rather than a design token because it only exists while the two layers are
 * mid-drag.
 */
export const CAPSULE_EXCHANGE_OUT_TRAVEL_PX = 24;

/** The trailing offset the incoming Capability form settles out of, in px. */
export const CAPSULE_EXCHANGE_IN_TRAVEL_PX = 28;

/**
 * Exported as the context itself — a provider alias would trip
 * `react-refresh/only-export-components` in a module that is mostly constants
 * and a hook. Consumers render `<CapsuleExchangeContext.Provider value={…}>`.
 */
export const CapsuleExchangeContext = createContext<CapsuleExchange | null>(null);

/** `null` when no exchange is running — the Web experience, and any App state at rest. */
export function useCapsuleExchange(): CapsuleExchange | null {
  return useContext(CapsuleExchangeContext);
}

/**
 * The style one side of the exchange wears, or `undefined` when it wears none.
 *
 * `yielding` is the form handing the slot over (drifts out and fades, and
 * refuses taps — a faded capsule must not swallow a tap meant as a drag);
 * `arriving` is the one settling in behind the finger. Mid-progress only: at
 * either endpoint, and with no exchange at all, this returns `undefined` so a
 * settled capsule carries no inline style anywhere. Both consumers derive
 * their `data-capsule-exchange` attribute from the same call, so the attribute
 * and the style cannot disagree about whether a handoff is running.
 */
export function capsuleExchangeStyle(
  exchange: CapsuleExchange | null,
  side: 'yielding' | 'arriving',
): CSSProperties | undefined {
  if (!exchange || exchange.progress <= 0 || exchange.progress >= 1) {
    return undefined;
  }
  const travel =
    side === 'yielding' ? CAPSULE_EXCHANGE_OUT_TRAVEL_PX : CAPSULE_EXCHANGE_IN_TRAVEL_PX;
  const distance =
    side === 'yielding' ? -exchange.progress * travel : (1 - exchange.progress) * travel;
  return {
    transform: `translateX(${distance}px)`,
    opacity: side === 'yielding' ? 1 - exchange.progress : exchange.progress,
    pointerEvents: 'none',
  };
}
