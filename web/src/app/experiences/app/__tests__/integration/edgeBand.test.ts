import { describe, it, expect } from 'vitest';
import {
  appEdgeBandReservation,
  edgeBandSide,
  edgeOwnsDrag,
  platformGuardSide,
} from '../../edgeBand';
import { EDGE_BAND_PX, EDGE_PLATFORM_GUARD_PX } from '../../gesture';

/** A 390px App — the App's narrowest shipping portrait width. */
const PHONE = { left: 0, right: 390 };

/** The left band starts after the platform guard and is still 28px wide. */
const LEFT_BAND_START = EDGE_PLATFORM_GUARD_PX;
const LEFT_BAND_END = EDGE_PLATFORM_GUARD_PX + EDGE_BAND_PX;
const RIGHT_BAND_END = PHONE.right - EDGE_PLATFORM_GUARD_PX;
const RIGHT_BAND_START = RIGHT_BAND_END - EDGE_BAND_PX;

describe('EDGE_BAND_PX and EDGE_PLATFORM_GUARD_PX', () => {
  it('keeps the 28px shell band', () => {
    expect(EDGE_BAND_PX).toBe(28);
  });

  it('starts the band after a 24px platform guard', () => {
    expect(EDGE_PLATFORM_GUARD_PX).toBe(24);
    expect(LEFT_BAND_START).toBe(24);
    expect(LEFT_BAND_END).toBe(52);
  });
});

describe('edgeBandSide', () => {
  it('claims the left band after the platform guard', () => {
    expect(edgeBandSide(LEFT_BAND_START, PHONE)).toBe('left');
    expect(edgeBandSide(LEFT_BAND_START + 1, PHONE)).toBe('left');
    expect(edgeBandSide(LEFT_BAND_END, PHONE)).toBe('left');
  });

  it('claims the right band before the platform guard', () => {
    expect(edgeBandSide(RIGHT_BAND_START, PHONE)).toBe('right');
    expect(edgeBandSide(RIGHT_BAND_END, PHONE)).toBe('right');
  });

  it('leaves the platform guard to the OS', () => {
    // The physical-device finding behind #2724: a band starting at the edge
    // loses this strip to Safari's own back gesture.
    expect(edgeBandSide(0, PHONE)).toBeNull();
    expect(edgeBandSide(LEFT_BAND_START - 1, PHONE)).toBeNull();
    expect(edgeBandSide(PHONE.right, PHONE)).toBeNull();
    expect(edgeBandSide(RIGHT_BAND_END + 1, PHONE)).toBeNull();
    expect(platformGuardSide(0, PHONE)).toBe('left');
    expect(platformGuardSide(LEFT_BAND_START - 1, PHONE)).toBe('left');
    expect(platformGuardSide(PHONE.right, PHONE)).toBe('right');
    expect(platformGuardSide(RIGHT_BAND_END + 1, PHONE)).toBe('right');
    expect(platformGuardSide(LEFT_BAND_START, PHONE)).toBeNull();
    expect(platformGuardSide(RIGHT_BAND_END, PHONE)).toBeNull();
  });

  it('leaves the interior to the work surface', () => {
    expect(edgeBandSide(LEFT_BAND_END + 1, PHONE)).toBeNull();
    expect(edgeBandSide(RIGHT_BAND_START - 1, PHONE)).toBeNull();
    expect(edgeBandSide(PHONE.right / 2, PHONE)).toBeNull();
  });

  it('measures from the shell, not from the window', () => {
    // The App is routinely narrower than the viewport — 390px inside a desktop
    // browser, and inside the fixture the browser contract suite drives. The
    // guard and the band both shift with the shell's own edge.
    const inset = { left: 200, right: 590 };

    expect(edgeBandSide(200 + EDGE_PLATFORM_GUARD_PX, inset)).toBe('left');
    expect(edgeBandSide(200 + EDGE_PLATFORM_GUARD_PX + EDGE_BAND_PX, inset)).toBe('left');
    expect(edgeBandSide(200 + EDGE_PLATFORM_GUARD_PX + EDGE_BAND_PX + 1, inset)).toBeNull();
    // x = 20 is at the window's left edge but 180px outside the App.
    expect(edgeBandSide(20, inset)).toBeNull();
    expect(edgeBandSide(590 - EDGE_PLATFORM_GUARD_PX - EDGE_BAND_PX, inset)).toBe('right');
    expect(edgeBandSide(590 - EDGE_PLATFORM_GUARD_PX, inset)).toBe('right');
    expect(edgeBandSide(590 - EDGE_PLATFORM_GUARD_PX + 1, inset)).toBeNull();
  });

  it('resolves a shell narrower than two bands to the left', () => {
    // A 50px shell: the left band covers 24..50 and the right band 0..26.
    // The left is tested first and wins where they overlap; this is a
    // tie-break, not a rule, because at every shipping width they are disjoint.
    const sliver = { left: 0, right: 50 };

    expect(edgeBandSide(25, sliver)).toBe('left');
    expect(edgeBandSide(10, sliver)).toBe('right');
  });

  it('claims nothing outside the shell', () => {
    const inset = { left: 200, right: 590 };

    expect(edgeBandSide(199, inset)).toBeNull();
    expect(edgeBandSide(0, inset)).toBeNull();
    expect(edgeBandSide(-50, inset)).toBeNull();
    expect(edgeBandSide(591, inset)).toBeNull();
    expect(platformGuardSide(199, inset)).toBeNull();
    expect(platformGuardSide(591, inset)).toBeNull();
  });
});

describe('edgeOwnsDrag', () => {
  it('gives the left band the rightward drag that pulls Sessions in', () => {
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

describe('appEdgeBandReservation', () => {
  function shell(rect: { left: number; right: number }): HTMLDivElement {
    const element = document.createElement('div');
    element.dataset.experience = 'app';
    element.getBoundingClientRect = () => ({
      left: rect.left,
      right: rect.right,
      top: 0,
      bottom: 800,
      width: rect.right - rect.left,
      height: 800,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.appendChild(element);
    return element;
  }

  it('reserves the platform guard and the shell band for a target inside the app', () => {
    const root = shell(PHONE);
    const child = document.createElement('div');
    root.appendChild(child);

    expect(appEdgeBandReservation(child, 0)).toBe(true);
    expect(appEdgeBandReservation(child, EDGE_PLATFORM_GUARD_PX - 1)).toBe(true);
    expect(appEdgeBandReservation(child, EDGE_PLATFORM_GUARD_PX)).toBe(true);
    expect(appEdgeBandReservation(child, LEFT_BAND_END)).toBe(true);
    expect(appEdgeBandReservation(child, LEFT_BAND_END + 1)).toBe(false);
    expect(appEdgeBandReservation(child, RIGHT_BAND_START - 1)).toBe(false);
    expect(appEdgeBandReservation(child, RIGHT_BAND_START)).toBe(true);
    expect(appEdgeBandReservation(child, PHONE.right - EDGE_PLATFORM_GUARD_PX)).toBe(true);
    expect(appEdgeBandReservation(child, PHONE.right)).toBe(true);

    root.remove();
  });

  it('resolves a text target through its parent element', () => {
    const root = shell(PHONE);
    const text = document.createTextNode('terminal');

    expect(appEdgeBandReservation(text, 4)).toBe(false);

    const parent = document.createElement('span');
    parent.appendChild(text);
    root.appendChild(parent);
    expect(appEdgeBandReservation(text, 4)).toBe(true);

    root.remove();
  });

  it('reserves nothing outside an app experience', () => {
    const loose = document.createElement('div');
    document.body.appendChild(loose);

    expect(appEdgeBandReservation(loose, 2)).toBe(false);
    expect(appEdgeBandReservation(null, 2)).toBe(false);

    loose.remove();
  });
});
