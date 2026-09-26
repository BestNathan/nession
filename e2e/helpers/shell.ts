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
 * `Sessions ← Terminal → Workspace` gesture (#1081).
 *
 * Synthesised rather than driven through Playwright's input APIs, because
 * neither of those can express it: `page.touchscreen` only `tap`s, and a
 * `page.mouse` drag raises mouse events, which the pager does not listen for —
 * `AppLayers` binds `onTouchStart`/`Move`/`End`. Chromium does expose the
 * standard `Touch` constructor, so the events below carry a real `touches`
 * list and a real `target`, which is what lets the gate's walk up from the
 * touch target run for real instead of against a stub.
 *
 * The drag is sent as two moves rather than one, because the pager's axis lock
 * reads the first move's dx/dy ratio and a single teleport from `fromX` to
 * `toX` would read as a pure horizontal jump — passing the lock more easily
 * than any real finger does.
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
