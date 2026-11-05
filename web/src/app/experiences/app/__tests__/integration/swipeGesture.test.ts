import { describe, it, expect } from 'vitest';
import { EDGE_BAND_PX, EDGE_PLATFORM_GUARD_PX } from '../../gesture';
import {
  SwipeGesture,
  type SwipeGestureOptions,
  type SwipeTouch,
} from '../../swipeGesture';

/**
 * 390 * 0.18 = 70.2, so the commit floor (64px) does not win at this width.
 * Use 400 in tests that need a round threshold (72px).
 */
const WIDE_PHONE = { left: 0, right: 400 };

function element(html: string, selector: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  const found = host.querySelector(selector);
  if (!found) {
    throw new Error(`no element matched ${selector}`);
  }
  return found;
}

function chrome(): Element {
  return element('<div data-testid="shell-chrome"></div>', '[data-testid="shell-chrome"]');
}

function xterm(): Element {
  return element(
    '<div data-terminal-viewport><div class="xterm"><div class="xterm-screen"></div></div></div>',
    '.xterm-screen',
  );
}

interface Harness extends SwipeGesture {
  setIndex: (index: number) => void;
  setPageCount: (pageCount: number) => void;
  setMayPage: (mayPage: boolean) => void;
  setBounds: (bounds: { left: number; right: number } | null) => void;
  advance: (ms: number) => void;
}

function harness(overrides: Partial<SwipeGestureOptions> = {}): Harness {
  let index = 1;
  let pageCount = 3;
  let mayPage = true;
  let bounds: { left: number; right: number } | null = WIDE_PHONE;
  let now = 0;
  const engine = new SwipeGesture({
    getShellBounds: () => bounds,
    getIndex: () => index,
    getPageCount: () => pageCount,
    shellMayPage: () => mayPage,
    now: () => now,
    ...overrides,
  }) as Harness;
  engine.setIndex = (next) => {
    index = next;
  };
  engine.setPageCount = (next) => {
    pageCount = next;
  };
  engine.setMayPage = (next) => {
    mayPage = next;
  };
  engine.setBounds = (next) => {
    bounds = next;
  };
  engine.advance = (ms) => {
    now += ms;
  };
  return engine;
}

function touch(
  clientX: number,
  clientY = 300,
  target: EventTarget | null = chrome(),
  identifier = 1,
): SwipeTouch {
  return { identifier, clientX, clientY, target };
}

function start(
  engine: SwipeGesture,
  clientX: number,
  clientY = 300,
  target: EventTarget | null = chrome(),
): boolean {
  return engine.start(touch(clientX, clientY, target));
}

function move(engine: SwipeGesture, clientX: number, clientY = 300) {
  return engine.move(touch(clientX, clientY));
}

describe('SwipeGesture — candidate and axis ownership', () => {
  it('does not assume ownership at touchstart', () => {
    const engine = harness();

    expect(start(engine, 200)).toBe(true);
    expect(engine.snapshot().phase).toBe('candidate');
    expect(engine.snapshot().offset).toBe(0);
    expect(engine.snapshot().destinationIndex).toBeNull();
  });

  it('ignores movement inside the slop', () => {
    const engine = harness();
    start(engine, 200);
    const result = move(engine, 208, 301);

    expect(result.snapshot.phase).toBe('candidate');
    expect(result.snapshot.offset).toBe(0);
    expect(result.preventDefault).toBe(false);
  });

  it('surrenders to a vertical drag and never revives it in the same contact', () => {
    const engine = harness();
    start(engine, 200, 100);
    // 20 across, 80 down: vertical wins.
    const first = move(engine, 220, 180);
    expect(first.snapshot.phase).toBe('idle');
    expect(first.snapshot.reason).toBe('vertical');
    expect(first.preventDefault).toBe(false);

    // A later horizontal move must not re-open the page.
    const second = move(engine, 360, 180);
    expect(second.snapshot.phase).toBe('idle');
    expect(second.snapshot.offset).toBe(0);
    expect(second.preventDefault).toBe(false);
  });

  it('claims horizontally and reports the destination', () => {
    const engine = harness();
    start(engine, 200);
    const result = move(engine, 230, 302);

    expect(result.snapshot.phase).toBe('navigation');
    expect(result.snapshot.destinationIndex).toBe(0);
    expect(result.snapshot.offset).toBe(30);
    expect(result.preventDefault).toBe(true);
  });
});

describe('SwipeGesture — release-only commit and frozen destination', () => {
  it('freezes the destination and clamps reverse travel to zero', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 260);
    expect(engine.snapshot().destinationIndex).toBe(0);

    // Cross back over the origin: the preview clamps, but the contact is still
    // navigation's and no settle happens before release.
    const reversed = move(engine, 150);
    expect(reversed.snapshot.phase).toBe('navigation');
    expect(reversed.snapshot.offset).toBe(0);
    expect(reversed.snapshot.destinationIndex).toBe(0);

    engine.advance(100);
    const end = engine.end(touch(150));
    expect(end.outcome).toBe('snapback');
    expect(end.destinationIndex).toBe(0);
    expect(end.reason).toBe('below-threshold');
  });

  it('allows the contact to recover after a reversal and commit at release', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 300);
    move(engine, 150);
    move(engine, 340);
    engine.advance(300);

    const end = engine.end(touch(340));
    expect(end.outcome).toBe('commit');
    expect(end.travel).toBe(140);
    expect(end.reason).toBe('distance');
  });

  it('commits at the larger of 64px and 18% of the shell width', () => {
    const engine = harness();
    // 400px shell -> 72px threshold.
    start(engine, 200);
    move(engine, 272);
    engine.advance(400);
    expect(engine.end(touch(272)).outcome).toBe('commit');

    const below = harness();
    start(below, 200);
    move(below, 271);
    below.advance(400);
    expect(below.end(touch(271)).outcome).toBe('snapback');
  });

  it('commits a purposeful flick below the distance threshold', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 240);
    engine.advance(50);

    const end = engine.end(touch(240));
    expect(end.travel).toBe(40);
    expect(end.velocity).toBeCloseTo(0.8, 2);
    expect(end.reason).toBe('velocity');
    expect(end.outcome).toBe('commit');
  });

  it('does not let speed alone commit a short travel', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 230);
    engine.advance(1);

    // 30px at 30px/ms is fast, but the minimum travel is 40px.
    expect(engine.end(touch(230)).outcome).toBe('snapback');
  });

  it('does not let a slow 40px drag commit by velocity', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 240);
    engine.advance(200);

    const end = engine.end(touch(240));
    expect(end.travel).toBe(40);
    expect(end.velocity).toBeCloseTo(0.2, 2);
    expect(end.outcome).toBe('snapback');
  });

  it('caps the preview at 80% of the shell width', () => {
    const engine = harness();
    start(engine, EDGE_PLATFORM_GUARD_PX + 10);
    move(engine, 390);

    expect(engine.snapshot().offset).toBe(320);
  });
});

describe('SwipeGesture — routes and no-destination resistance', () => {
  it('resists instead of paging when the Workspace layer does not exist', () => {
    const engine = harness();
    engine.setPageCount(2);
    engine.setIndex(1);

    start(engine, 300);
    const result = move(engine, 210);

    expect(result.snapshot.phase).toBe('resisting');
    expect(result.snapshot.destinationIndex).toBeNull();
    expect(result.snapshot.offset).toBeCloseTo(-16.2, 5);
    expect(result.preventDefault).toBe(true);

    engine.advance(100);
    const end = engine.end(touch(210));
    expect(end.outcome).toBe('snapback');
    expect(end.reason).toBe('no-destination');
  });

  it('lets a resisting contact reverse into the direction that exists', () => {
    const engine = harness();
    engine.setPageCount(2);
    engine.setIndex(1);

    start(engine, 300);
    move(engine, 210);
    expect(engine.snapshot().phase).toBe('resisting');

    // Reverse to the right: Sessions is a real destination.
    move(engine, 390);
    expect(engine.snapshot().phase).toBe('navigation');
    expect(engine.snapshot().destinationIndex).toBe(0);

    engine.advance(200);
    expect(engine.end(touch(390)).outcome).toBe('commit');
  });

  it('a rightward drag from Sessions has no page to reach', () => {
    const engine = harness();
    engine.setIndex(0);

    start(engine, 300);
    expect(move(engine, 400).snapshot.phase).toBe('resisting');
    engine.advance(100);
    expect(engine.end(touch(400)).outcome).toBe('snapback');
  });
});

describe('SwipeGesture — work-surface and edge arbitration', () => {
  it('refuses an interior xterm start', () => {
    const engine = harness();
    expect(start(engine, 200, 300, xterm())).toBe(false);
    expect(engine.snapshot().reason).toBe('surface-interior');
    expect(engine.snapshot().phase).toBe('idle');
  });

  it('leaves the platform guard to the OS', () => {
    // The outer strip is where Safari/Android recognise their own back
    // gesture; the shell must not claim it (#2724).
    const engine = harness();
    expect(start(engine, 4, 300, xterm())).toBe(false);
    expect(engine.snapshot().reason).toBe('platform-guard');
    expect(engine.snapshot().phase).toBe('idle');
  });

  it('allows the left band after the platform guard to pull Sessions in', () => {
    const engine = harness();
    expect(start(engine, EDGE_PLATFORM_GUARD_PX + 2, 300, xterm())).toBe(true);
    expect(move(engine, 100).snapshot.destinationIndex).toBe(0);
  });

  it('allows the right band before the platform guard to pull Workspace in', () => {
    const engine = harness();
    expect(start(engine, WIDE_PHONE.right - EDGE_PLATFORM_GUARD_PX - 2, 300, xterm())).toBe(true);
    expect(move(engine, 300).snapshot.destinationIndex).toBe(2);
  });

  it('surrenders the band when the drag moves the other way', () => {
    const engine = harness();
    start(engine, EDGE_PLATFORM_GUARD_PX + 2, 300, xterm());
    const result = move(engine, -60);

    expect(result.snapshot.phase).toBe('idle');
    expect(result.snapshot.reason).toBe('edge-direction');
    expect(result.snapshot.offset).toBe(0);
  });

  it('measures the guard and band from the shell, not the window', () => {
    const inset = { left: 182, right: 572 };
    const engine = harness();
    engine.setBounds(inset);

    expect(start(engine, 182 + EDGE_PLATFORM_GUARD_PX + 2, 300, xterm())).toBe(true);
    expect(move(engine, 250).snapshot.destinationIndex).toBe(0);

    const outside = harness();
    outside.setBounds(inset);
    expect(start(outside, 2, 300, xterm())).toBe(false);
    expect(outside.snapshot().reason).toBe('surface-interior');

    const guard = harness();
    guard.setBounds(inset);
    expect(start(guard, 184, 300, xterm())).toBe(false);
    expect(guard.snapshot().reason).toBe('platform-guard');
  });

  it('declines a work-surface start when the shell cannot be measured', () => {
    const engine = harness();
    engine.setBounds(null);

    expect(start(engine, 2, 300, xterm())).toBe(false);
    expect(engine.snapshot().reason).toBe('unmeasurable-shell');
  });

  it('does not page from shell chrome inside the platform guard', () => {
    // The edge belongs to the OS even when the touch lands on shell chrome:
    // the Terminal's outer strip is chrome, and claiming it would still lose
    // to Safari's back gesture.
    const engine = harness();
    expect(start(engine, 2, 300, chrome())).toBe(false);
    expect(engine.snapshot().reason).toBe('platform-guard');
  });

  it('still pages from shell chrome after the platform guard', () => {
    const engine = harness();
    expect(start(engine, EDGE_PLATFORM_GUARD_PX + 2, 300, chrome())).toBe(true);
    expect(move(engine, -80).snapshot.destinationIndex).toBe(2);
  });

  it('declines every start on a layer whose depth owns its leave', () => {
    const engine = harness();
    engine.setMayPage(false);

    expect(start(engine, 2, 300, chrome())).toBe(false);
    expect(engine.snapshot().reason).toBe('shell-standdown');
  });

  it('declines a start on an interactive owner even inside the band', () => {
    const button = element('<button type="button">Sessions</button>', 'button');
    const engine = harness();

    expect(start(engine, 2, 300, button)).toBe(false);
    expect(engine.snapshot().reason).toBe('interactive-owner');
  });

  it('declines a work-surface start while its text is selected', () => {
    const surface = element(
      '<div data-terminal-viewport><div class="xterm"><div class="xterm-screen">echo hello</div></div></div>',
      '.xterm-screen',
    );
    document.body.appendChild(surface);
    const range = document.createRange();
    range.selectNodeContents(surface);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    const engine = harness();
    expect(start(engine, 2, 300, surface)).toBe(false);
    expect(engine.snapshot().reason).toBe('selection');

    document.getSelection()?.removeAllRanges();
    surface.remove();
  });

  it('declines a start on the capability row at the shell edge', () => {
    // A nested horizontal scroller owns its drags fully (#2724). Claiming at
    // the edge would still spend the first pixels of the row's own pan.
    const row = element(
      '<nav data-testid="workspace-capability-capsule"><div data-testid="workspace-capability-scroll"></div></nav>',
      '[data-testid="workspace-capability-scroll"]',
    );
    const engine = harness();

    expect(start(engine, 2, 300, row)).toBe(false);
    expect(engine.snapshot().reason).toBe('interactive-owner');
  });

  it('declines a start on an open Capsule Peek', () => {
    const peek = element(
      '<div role="region" data-testid="capsule-capability-projection"><button>Open</button></div>',
      '[data-testid="capsule-capability-projection"]',
    );
    const engine = harness();

    expect(start(engine, 2, 300, peek)).toBe(false);
    expect(engine.snapshot().reason).toBe('interactive-owner');
  });

  it('still pages from an unclassifiable target', () => {
    // The rule names what is excluded, not a whitelist.
    const engine = harness();
    start(engine, 200, 300, null);
    expect(move(engine, 280).snapshot.destinationIndex).toBe(0);
  });
});

describe('SwipeGesture — cancellation', () => {
  it('cancels an owned navigation without committing', () => {
    const engine = harness();
    start(engine, 200);
    move(engine, 300);
    const snapshot = engine.cancel('native-touchcancel');

    expect(snapshot.phase).toBe('idle');
    expect(snapshot.offset).toBe(0);
    expect(snapshot.reason).toBe('native-touchcancel');
    expect(snapshot.destinationIndex).toBeNull();
  });

  it('keeps the cancellation reason when no contact is active', () => {
    const engine = harness();
    expect(engine.cancel('multitouch').reason).toBe('multitouch');
  });

  it('reports a candidate release as none, not a snapback', () => {
    const engine = harness();
    start(engine, 200);
    const end = engine.end();

    expect(end.outcome).toBe('none');
    expect(end.reason).toBe('candidate');
  });

  it('ignores a second identifier while one contact is tracked', () => {
    const engine = harness();
    start(engine, 200);

    expect(engine.start(touch(300, 300, chrome(), 2))).toBe(false);
    expect(engine.trackedIdentifier()).toBe(1);
  });
});

describe('SwipeGesture — the band is still 28px', () => {
  it('pins the starting value', () => {
    expect(EDGE_BAND_PX).toBe(28);
  });
});
