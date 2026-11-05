import { expect, type Page } from '@playwright/test';

/**
 * Wait until the shell is fully rendered.
 *
 * `Shell` renders a `[data-testid="shell"]` root
 * that is always present after a successful login. Waiting for it is a
 * reliable signal that the WebSocket handshake, agent/session fetch and
 * initial render have completed.
 *
 * In CI, cargo build + agent startup can take 30-60 seconds, so we use a
 * generous 90-second timeout.
 */
export async function waitForShell(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="shell"]')).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * Dispatch a horizontal touch drag on the App shell — the
 * `Sessions ← Terminal → Workspace` gesture (#1081, #2724).
 *
 * Synthesised rather than driven through Playwright's input APIs, because
 * neither of those can express it: `page.touchscreen` only `tap`s, and a
 * `page.mouse` drag raises mouse events, which the pager does not listen for —
 * the App shell binds native Touch Events, owned by `Touch.identifier`.
 * Chromium does expose the standard `Touch` constructor, so the events below
 * carry a real `touches` list and a real `target`, which is what lets the
 * gate's walk up from the touch target run for real instead of against a stub.
 *
 * The drag is sent as two moves rather than one so the first move crosses the
 * candidate's 12px slop with a real horizontal axis, rather than teleporting
 * from `fromX` to `toX` in a single event.
 */
export async function swipeHorizontally(
  page: Page,
  { y, fromX, toX }: { y: number; fromX: number; toX: number },
): Promise<void> {
  await page.evaluate(
    ({ y: clientY, fromX: startX, toX: endX }) => {
      const targetAt = (x: number) =>
        document.elementFromPoint(x, clientY) ?? document.body;

      const send = (type: string, x: number) => {
        const target = targetAt(x);
        const touch = new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY,
        });
        const ended = type === 'touchend';
        target.dispatchEvent(
          new TouchEvent(type, {
            touches: ended ? [] : [touch],
            targetTouches: ended ? [] : [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          }),
        );
      };

      send('touchstart', startX);
      send('touchmove', startX + (endX - startX) / 2);
      send('touchmove', endX);
      send('touchend', endX);
    },
    { y, fromX, toX },
  );
}

/**
 * The visible shape of a touch sequence, for tests that need to inspect the
 * App *during* a drag (#2724) instead of dispatching it atomically.
 *
 * The start is dispatched on the element under the finger so the shell's
 * work-surface gate runs against a real target. Moves and the end are
 * dispatched on that same target with the same `Touch.identifier`, which is
 * exactly the ownership a physical finger has: the browser's `touchend` also
 * reports it in `changedTouches`, and no pointer event participates.
 */
const SWIPE_TOUCH_KEY = '__nessionE2eSwipeTouch';

async function dispatchSwipeEvent(
  page: Page,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  point: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ eventType, x, y, key }) => {
      const windowWithTouch = window as unknown as Record<string, unknown>;
      const stored = windowWithTouch[key] as
        | { identifier: number; target: EventTarget | null }
        | undefined;

      if (eventType === 'touchstart') {
        const target = document.elementFromPoint(x, y) ?? document.body;
        const identifier = 1;
        const touch = new Touch({ identifier, target, clientX: x, clientY: y });
        windowWithTouch[key] = { identifier, target };
        target.dispatchEvent(new TouchEvent('touchstart', {
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        }));
        return;
      }

      if (!stored) {
        throw new Error(`no swipe touch in progress for ${eventType}`);
      }
      const touch = new Touch({
        identifier: stored.identifier,
        target: stored.target,
        clientX: x,
        clientY: y,
      });
      const ended = eventType === 'touchend' || eventType === 'touchcancel';
      const target = stored.target ?? document.body;
      target.dispatchEvent(new TouchEvent(eventType, {
        touches: ended ? [] : [touch],
        targetTouches: ended ? [] : [touch],
        changedTouches: [touch],
        bubbles: true,
        cancelable: true,
      }));
      if (ended) {
        delete windowWithTouch[key];
      }
    },
    { eventType: type, x: point.x, y: point.y, key: SWIPE_TOUCH_KEY },
  );
}

/** Start a touch the caller can inspect and continue. */
export async function startSwipeTouch(page: Page, point: { x: number; y: number }): Promise<void> {
  await dispatchSwipeEvent(page, 'touchstart', point);
}

/** Continue the touch started by `startSwipeTouch`. */
export async function moveSwipeTouch(page: Page, point: { x: number; y: number }): Promise<void> {
  await dispatchSwipeEvent(page, 'touchmove', point);
}

/** Release the touch. */
export async function endSwipeTouch(page: Page, point: { x: number; y: number }): Promise<void> {
  await dispatchSwipeEvent(page, 'touchend', point);
}

/** Cancel the touch the way the browser does when the OS takes the edge. */
export async function cancelSwipeTouch(page: Page, point: { x: number; y: number }): Promise<void> {
  await dispatchSwipeEvent(page, 'touchcancel', point);
}

/**
 * A second finger landing during a touch sequence (#2724 multitouch).
 *
 * The App shell must abandon the owned contact rather than page under two
 * fingers, so this dispatches a two-touch `touchstart` and leaves cleanup to
 * the page (the shell stands down immediately).
 */
export async function addSecondSwipeTouch(
  page: Page,
  first: { x: number; y: number },
  second: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ first: a, second: b, key }) => {
      const windowWithTouch = window as unknown as Record<string, unknown>;
      const stored = windowWithTouch[key] as
        | { identifier: number; target: EventTarget | null }
        | undefined;
      if (!stored) {
        throw new Error('no swipe touch in progress for multitouch');
      }
      const target = stored.target ?? document.body;
      const one = new Touch({
        identifier: stored.identifier,
        target,
        clientX: a.x,
        clientY: a.y,
      });
      const two = new Touch({ identifier: 2, target, clientX: b.x, clientY: b.y });
      target.dispatchEvent(new TouchEvent('touchstart', {
        touches: [one, two],
        targetTouches: [one, two],
        changedTouches: [two],
        bubbles: true,
        cancelable: true,
      }));
      delete windowWithTouch[key];
    },
    { first, second, key: SWIPE_TOUCH_KEY },
  );
}

/**
 * Emit the pointer events a browser generates for a touch that is still held.
 *
 * The App shell must not treat either as the end of a native-touch drag: they
 * race the touch sequence and are not its owner (#2724).
 */
export async function dispatchTouchPointerCancellation(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const windowWithTouch = window as unknown as Record<string, unknown>;
    const stored = windowWithTouch[key] as
      | { identifier: number; target: EventTarget | null }
      | undefined;
    const target = stored?.target ?? document.body;
    target.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'touch',
    }));
    target.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'touch',
    }));
  }, SWIPE_TOUCH_KEY);
}
