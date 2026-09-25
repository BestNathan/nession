// e2e/specs/fixture-app.spec.ts
import { expect, test } from '@playwright/test';

// Local runs are forbidden: the webServer stack compiles and runs
// nession-server/agent (which operate tmux), and globalSetup executes
// `tmux kill-server` — disturbs the developer's local tmux. CI-only:
// .github/workflows/e2e.yml sets CI=true.
test.skip(!process.env.CI, 'local only — runs in CI workflow only');

test.use({ viewport: { width: 390, height: 844 } });

test('canonical App fixture renders the Terminal root', async ({ page }) => {
  await page.goto('/#/fixture/app');

  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('app-layer-root')).toBeVisible();
  await expect(page.getByTestId('app-layer-root')).toHaveAttribute(
    'data-layer',
    'terminal',
  );

  // single-row header: sessions + workspace affordances, NO switcher, NO
  // duplicated floating buttons. Exactly one header line — the pager mounted
  // every page at once and therefore rendered two permanently (#1049), which
  // is also why a second one reappearing means a layer is mounted that should
  // not be.
  await expect(page.getByTestId('session-header-line')).toHaveCount(1);
  await expect(page.getByTestId('session-header-line').first()).toBeVisible();
  await expect(page.getByTestId('app-header-sessions')).toBeVisible();
  await expect(page.getByTestId('app-header-workspace')).toBeVisible();
  await expect(page.getByTestId('surface-switcher')).toHaveCount(0);
  await expect(page.getByTestId('app-spatial-open-sessions')).toHaveCount(0);

  // the Terminal layer is the root and fills the viewport
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  await page.screenshot({ path: 'test-results/canonical-app-terminal.png', fullPage: true });
});

test('an emerged capability does not reflow the terminal (#826)', async ({ page }) => {
  // Measured in a real browser because jsdom has no layout: the unit test for
  // the clearance hook models the DOM shape, and this is what says the shape
  // matches reality.
  //
  // The occlusion is not advisory — `--terminal-content-bottom-inset` derives
  // from it and `TerminalViewport` spends it as `padding-bottom` inside a
  // `box-border` element xterm is mounted in, so a wrong number is height the
  // terminal loses and re-fits for.
  await page.goto('/#/fixture/app');
  await expect(page.getByTestId('app-layer-terminal')).toBeInViewport();

  const read = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-terminal-capsule-host]')!;
      const well = document.querySelector('[data-testid="terminal-well"]')!;
      const xterm = document.querySelector('[data-testid="fixture-terminal"]')!;
      const box = (el: Element) => {
        const b = el.getBoundingClientRect();
        return `${Math.round(b.top)}:${Math.round(b.height)}`;
      };
      return {
        well: box(well),
        xterm: box(xterm),
        occlusion: getComputedStyle(host).getPropertyValue('--terminal-capsule-occlusion').trim(),
      };
    });

  /**
   * Read only once the numbers have stopped moving.
   *
   * The clearance is published by a layout effect and then re-published by a
   * ResizeObserver, and the shell's width measurement settles a frame or two
   * after the route renders. A single read can therefore catch a transient
   * value — which is a fault in this test, not in the product: the claim is
   * about the settled geometry on both sides of the emergence.
   */
  const geometry = async () => {
    let previous = await read();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(50);
      const next = await read();
      if (JSON.stringify(next) === JSON.stringify(previous)) {
        return next;
      }
      previous = next;
    }
    return previous;
  };

  const dormant = await geometry();

  await page.getByTestId('capsule-capability-more').click();
  await page.getByTestId('capsule-capability-picker-git').click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();

  const emerged = await geometry();

  // The work surface is where it was, to the pixel. Compared with both sides in
  // the message: a bare mismatch here says nothing about which side moved.
  expect({ well: emerged.well, xterm: emerged.xterm }).toEqual({
    well: dormant.well,
    xterm: dormant.xterm,
  });
  // …and so is the height the terminal reserves, because a projection floats
  // over the scrollback rather than being laid out beside it.
  expect({ occlusion: emerged.occlusion }).toEqual({ occlusion: dormant.occlusion });
  expect(emerged.occlusion).not.toBe('0px');

  // Dismissal returns to the same numbers, which is what "continuity" means.
  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  expect(await geometry()).toEqual(dormant);
});

test('App workspace page shows the files plugin app layout', async ({ page }) => {
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-header-workspace').click();

  await expect(page.getByTestId('app-tool-header')).toBeVisible();
  await expect(page.getByTestId('workspace-shell')).toBeVisible();
  await expect(page.getByTestId('files-app-layout')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-bar')).toBeVisible();

  await page.screenshot({ path: 'test-results/canonical-app-workspace.png', fullPage: true });
});
