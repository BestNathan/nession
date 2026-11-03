import { describe, expect, it } from 'vitest';
import {
  DIRECTION_PAD_DIAL_SIZE,
  clampDirectionPadAnchor,
} from '../../directionPadGeometry';

describe('clampDirectionPadAnchor', () => {
  it('keeps a dial that fits away from the viewport edges where the finger is', () => {
    expect(clampDirectionPadAnchor(200, 300, 400, 800)).toEqual({
      x: 200,
      y: 300,
      showOrigin: false,
    });
  });

  it('clamps the dial inside the viewport and marks the true origin', () => {
    const anchor = clampDirectionPadAnchor(6, 4, 400, 800);

    // Half the 188px dial plus the 8px margin.
    expect(anchor.x).toBe(DIRECTION_PAD_DIAL_SIZE / 2 + 8);
    expect(anchor.y).toBe(DIRECTION_PAD_DIAL_SIZE / 2 + 8);
    expect(anchor.showOrigin).toBe(true);
  });

  it('hides the origin dot for a displacement the user cannot notice', () => {
    const anchor = clampDirectionPadAnchor(100, 300, 400, 800);

    expect(anchor.x).toBe(DIRECTION_PAD_DIAL_SIZE / 2 + 8);
    expect(anchor.showOrigin).toBe(false);
  });

  it('centres the dial when the viewport is smaller than the dial', () => {
    expect(clampDirectionPadAnchor(10, 10, 100, 80)).toEqual({
      x: 50,
      y: 40,
      showOrigin: true,
    });
  });
});
