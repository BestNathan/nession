import type { DirectionPadDirection } from './directionPadEngine';

/** What the overlay renders while the pad owns the finger (#2657). */
export interface DirectionPadView {
  readonly phase: 'armed' | 'moving';
  readonly direction: DirectionPadDirection | null;
  readonly gear: number;
  readonly rate: number;
  readonly count: number;
  /** Dial center, in the viewport's own CSS pixels. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** The real finger origin, in the viewport's own CSS pixels. */
  readonly originX: number;
  readonly originY: number;
  /** The dial was shifted to stay visible; show where the finger really is. */
  readonly showOrigin: boolean;
}
