import type { Page } from '@playwright/test';

/**
 * Touch sequences for the Terminal's long-press direction pad (#2657).
 *
 * `page.touchscreen` only taps, and Playwright's mouse path raises mouse
 * events — neither can express hold → move → release with a stable touch
 * target. Chromium exposes the standard `Touch`/`TouchEvent` constructors, so
 * these helpers dispatch real touch events on the element that received
 * `touchstart`, exactly as a phone browser does. Every later event targets the
 * stored element rather than re-sampling `elementFromPoint`, so a test that
 * replaces content mid-gesture would reproduce the detached-target defect
 * instead of hiding it.
 */
const STORE_KEY = '__nessionE2ETerminalTouch';

interface Point {
  x: number;
  y: number;
}

interface StoredTouch {
  identifier: number;
  target: Element;
}

export async function startTerminalTouch(
  page: Page,
  point: Point,
  identifier = 7,
): Promise<void> {
  await page.evaluate(({ x, y, id, storeKey }) => {
    const target = document.elementFromPoint(x, y);
    if (!(target instanceof Element)) {
      throw new Error(`no element at ${x},${y}`);
    }
    const touch = new Touch({ identifier: id, target, clientX: x, clientY: y });
    (window as unknown as Record<string, unknown>)[storeKey] = { identifier: id, target };
    target.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
  }, { ...point, id: identifier, storeKey: STORE_KEY });
}

/** Move the tracked finger; returns whether the page prevented the default. */
export async function moveTerminalTouch(
  page: Page,
  point: Point,
  { cancelable = true }: { cancelable?: boolean } = {},
): Promise<boolean> {
  return page.evaluate(({ x, y, isCancelable, storeKey }) => {
    const stored = (window as unknown as Record<string, unknown>)[storeKey] as
      StoredTouch | undefined;
    if (!stored) {
      throw new Error('no terminal touch is in progress');
    }
    const touch = new Touch({
      identifier: stored.identifier,
      target: stored.target,
      clientX: x,
      clientY: y,
    });
    const event = new TouchEvent('touchmove', {
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
      bubbles: true,
      cancelable: isCancelable,
    });
    stored.target.dispatchEvent(event);
    return event.defaultPrevented;
  }, { ...point, isCancelable: cancelable, storeKey: STORE_KEY });
}

export async function endTerminalTouch(page: Page, point: Point): Promise<void> {
  await finishTerminalTouch(page, 'touchend', point);
}

export async function cancelTerminalTouch(page: Page, point: Point): Promise<void> {
  await finishTerminalTouch(page, 'touchcancel', point);
}

async function finishTerminalTouch(
  page: Page,
  type: 'touchend' | 'touchcancel',
  point: Point,
): Promise<void> {
  await page.evaluate(({ x, y, eventType, storeKey }) => {
    const stored = (window as unknown as Record<string, unknown>)[storeKey] as
      StoredTouch | undefined;
    if (!stored) {
      throw new Error('no terminal touch is in progress');
    }
    const touch = new Touch({
      identifier: stored.identifier,
      target: stored.target,
      clientX: x,
      clientY: y,
    });
    stored.target.dispatchEvent(new TouchEvent(eventType, {
      touches: [],
      targetTouches: [],
      changedTouches: [touch],
      bubbles: true,
      cancelable: true,
    }));
    delete (window as unknown as Record<string, unknown>)[storeKey];
  }, { ...point, eventType: type, storeKey: STORE_KEY });
}
