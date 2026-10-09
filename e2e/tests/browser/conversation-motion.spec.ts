import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux). CI-only, like every spec here.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * The running indicators under `prefers-reduced-motion: reduce`.
 *
 * ## Why this is a browser test and not a class assertion
 *
 * `#1363` requires that every shimmer and icon animation has a static fallback
 * under reduced motion. The obvious check — that the element carries
 * `motion-reduce:animate-none` — proves the class is in the source and nothing
 * about what the browser does with it: the variant only works if Tailwind
 * emitted the rule, if the media query is the one Playwright emulates, and if
 * nothing later in the cascade re-declares the animation. So the assertion is
 * the *computed* animation, read under an emulated preference.
 *
 * ## Why the complement matters more than the assertion
 *
 * `animate-none` applied unconditionally would pass the reduced-motion case and
 * quietly remove the indicator for every reader who never asked for that. The
 * second test is what makes the first one about reduced motion rather than
 * about the class being absent.
 *
 * This is the failure `#1363` round 4 named: the app's global rule zeroes
 * `--motion-shell-duration`, which reaches Nession's own token-driven motion and
 * does nothing at all to Tailwind's utilities — `animate-spin` compiles to a
 * literal `animation: spin 1s linear infinite`.
 */

test('a running indicator stops, and still says it is running', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The `ready` corpus ends in a tool that never stopped, so its group carries
  // the running indicator without any gesture to make it appear.
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=ready');

  const running = page.getByTestId('conversation-tool-group-running');
  await expect(running).toBeVisible();

  // Legible with the animation gone. The icon is `aria-hidden` and the state is
  // stated in text, which is what lets the static fallback be a *static* one
  // rather than a different glyph.
  await expect(running).toContainText('still running');

  const animation = await running
    .locator('svg')
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe('none');
});

test('the same indicator does animate when motion is not reduced', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#/fixture/workspace?capability=claude-code&conversation=ready');

  const running = page.getByTestId('conversation-tool-group-running');
  await expect(running).toBeVisible();

  const animation = await running
    .locator('svg')
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).not.toBe('none');
});
