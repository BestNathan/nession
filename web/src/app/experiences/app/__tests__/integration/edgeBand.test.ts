import { describe, it, expect } from 'vitest';
import { edgeBandSide, edgeOwnsDrag } from '../../edgeBand';
import { EDGE_BAND_PX } from '../../gesture';

/** A 390px App — the App's narrowest shipping portrait width. */
const PHONE = { left: 0, right: 390 };

describe('EDGE_BAND_PX', () => {
  it('is 28, the middle of the range #473 proposed and #1081 re-proposed', () => {
    expect(EDGE_BAND_PX).toBe(28);
  });
});

describe('edgeBandSide', () => {
  it('claims the left band, including its inner boundary', () => {
    expect(edgeBandSide(0, PHONE)).toBe('left');
    expect(edgeBandSide(EDGE_BAND_PX - 1, PHONE)).toBe('left');
    expect(edgeBandSide(EDGE_BAND_PX, PHONE)).toBe('left');
  });

  it('claims the right band, including its inner boundary', () => {
    expect(edgeBandSide(PHONE.right, PHONE)).toBe('right');
    expect(edgeBandSide(PHONE.right - EDGE_BAND_PX, PHONE)).toBe('right');
  });

  it('leaves the interior to the work surface', () => {
    // One pixel inside each band is already the surface's. This is the half of
    // #1049 that #1081 did not touch, and the one a band-only gesture would
    // have given away: 28 of 390px is 7% of the screen, not 100%.
    expect(edgeBandSide(EDGE_BAND_PX + 1, PHONE)).toBeNull();
    expect(edgeBandSide(PHONE.right - EDGE_BAND_PX - 1, PHONE)).toBeNull();
    expect(edgeBandSide(PHONE.right / 2, PHONE)).toBeNull();
  });

  it('measures from the shell, not from the window', () => {
    // The App is routinely narrower than the viewport — 390px inside a desktop
    // browser, and inside the fixture the browser contract suite drives. A band
    // taken from the window would sit outside the App entirely and the gesture
    // would be dead in exactly the case a test can observe.
    const inset = { left: 200, right: 590 };

    expect(edgeBandSide(200, inset)).toBe('left');
    expect(edgeBandSide(200 + EDGE_BAND_PX, inset)).toBe('left');
    expect(edgeBandSide(200 + EDGE_BAND_PX + 1, inset)).toBeNull();
    // x = 20 is at the window's left edge but 180px outside the App.
    expect(edgeBandSide(20, inset)).toBeNull();
    expect(edgeBandSide(590, inset)).toBe('right');
    expect(edgeBandSide(590 - EDGE_BAND_PX - 1, inset)).toBeNull();
  });

  it('resolves a shell narrower than two bands to the left', () => {
    // A 30px shell puts x = 2..28 in both bands. The left is tested first and
    // wins — a tie-break, not a rule: at every width the App ships (375 and
    // up) the bands are disjoint. Pinned so the degenerate case is a decision
    // rather than whatever the branch order happens to produce.
    const sliver = { left: 0, right: EDGE_BAND_PX + 2 };

    expect(edgeBandSide(5, sliver)).toBe('left');
    // 29 is inside the right band (its inner boundary is 2) and past the left
    // band's, so the tie-break is not what decides it.
    expect(edgeBandSide(29, sliver)).toBe('right');
  });

  it('claims nothing outside the shell', () => {
    // Bounded on both sides. Without the lower bound an inset App's left band
    // would extend to x = -Infinity, and a touch on the page behind it would
    // page the App.
    const inset = { left: 200, right: 590 };

    expect(edgeBandSide(199, inset)).toBeNull();
    expect(edgeBandSide(0, inset)).toBeNull();
    expect(edgeBandSide(-50, inset)).toBeNull();
    expect(edgeBandSide(591, inset)).toBeNull();
  });
});

describe('edgeOwnsDrag', () => {
  it('gives the left band the rightward drag that pulls Sessions in', () => {
    // The Sessions layer slides in from the left (`appLayerPositions.ts`), so
    // the drag that reveals it is a rightward one.
    expect(edgeOwnsDrag('left', 40)).toBe(true);
    expect(edgeOwnsDrag('left', -40)).toBe(false);
  });

  it('gives the right band the leftward drag that pulls Workspace in', () => {
    expect(edgeOwnsDrag('right', -40)).toBe(true);
    expect(edgeOwnsDrag('right', 40)).toBe(false);
  });

  it('treats a zero delta as no direction at all', () => {
    expect(edgeOwnsDrag('left', 0)).toBe(false);
    expect(edgeOwnsDrag('right', 0)).toBe(false);
  });
});
