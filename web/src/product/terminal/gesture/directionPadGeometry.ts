/**
 * Geometry for the touch direction pad (#2657).
 *
 * The dial is anchored where the long-press began, but must stay fully visible
 * near a viewport edge. Keeping the clamping here — not in the hook or the
 * overlay — lets both agree on the size and lets the origin-dot decision be
 * tested without a DOM.
 */

/** The dial's box. The approved prototype draws a 188px disc. */
export const DIRECTION_PAD_DIAL_SIZE = 188;
/** Space kept between the dial and the viewport edge. */
export const DIRECTION_PAD_DIAL_MARGIN_PX = 8;
/** Displacement below this is not worth pointing back at. */
export const DIRECTION_PAD_ORIGIN_EPSILON_PX = 11;

export interface DirectionPadAnchor {
  /** Dial centre, in viewport-local CSS pixels. */
  readonly x: number;
  readonly y: number;
  /** The dial was moved; the overlay should mark where the finger really is. */
  readonly showOrigin: boolean;
}

/**
 * Clamp the dial centre into a `width × height` viewport.
 *
 * When the viewport is narrower than the dial, the dial is centred rather than
 * pushed outside: `min` then `max` collapse to the same midpoint.
 */
export function clampDirectionPadAnchor(
  originX: number,
  originY: number,
  width: number,
  height: number,
): DirectionPadAnchor {
  const half = DIRECTION_PAD_DIAL_SIZE / 2 + DIRECTION_PAD_DIAL_MARGIN_PX;
  const minX = Math.min(half, width / 2);
  const maxX = Math.max(width - half, width / 2);
  const minY = Math.min(half, height / 2);
  const maxY = Math.max(height - half, height / 2);
  const x = Math.min(Math.max(originX, minX), maxX);
  const y = Math.min(Math.max(originY, minY), maxY);
  return {
    x,
    y,
    showOrigin: Math.hypot(x - originX, y - originY) > DIRECTION_PAD_ORIGIN_EPSILON_PX,
  };
}
