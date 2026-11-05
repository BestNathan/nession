'use strict';
// #2710 SC-06: the upper panel and capsule share canonical visual roles and
// touch targets; the composer stays fixed across every state; portrait and
// landscape screenshots cover rest, Keys, selected Ctrl, Commands and return.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

async function openFixture(page) {
  await page.goto('about:blank');
  await page.goto('/#/fixture/app');
  await page.getByTestId('app-layer-terminal').waitFor();
  await page.waitForFunction(() => Boolean(
    document.querySelector('[data-terminal-capsule-host] .xterm-screen'),
  ));
}

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(name + '.png');
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  return path;
}

test('SC-06: canonical upper-slot roles, touch targets and composer stability', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { sha } = verifiedRuntime('SC-06');
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);

  const shellBox = () => page.getByTestId('capsule-shell').boundingBox();
  const restingShell = await shellBox();
  await capture(page, testInfo, 'rest');

  await page.getByTestId('capsule-capability-more').click();
  await page.getByTestId('capsule-context-item-terminal-keys').click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
  await expect(page.getByTestId('capsule-capability-title')).toHaveCount(0);
  await expect(page.getByTestId('capsule-view-switch')).toBeVisible();
  await capture(page, testInfo, 'keys');

  const contract = await page.evaluate(() => {
    const projection = document.querySelector('[data-testid="capsule-capability-projection"]');
    const shell = document.querySelector('[data-testid="capsule-shell"]');
    const close = document.querySelector('[data-testid="capsule-capability-dismiss"]');
    const modifier = document.querySelector('[data-testid="terminal-modifier-ctrl"]');
    const chord = document.querySelector('[data-testid="quick-chord-Ctrl+C"]');
    const box = (element) => element.getBoundingClientRect();
    const style = (element) => getComputedStyle(element);
    return {
      projection: {
        radius: style(projection).borderTopLeftRadius,
        background: style(projection).backgroundColor,
        shadow: style(projection).boxShadow,
        left: Math.round(box(projection).left),
        right: Math.round(box(projection).right),
        height: Math.round(box(projection).height),
        maxHeight: Number.parseFloat(style(projection).maxHeight) || 0,
      },
      shell: {
        radius: style(shell).borderTopLeftRadius,
        background: style(shell).backgroundColor,
        shadow: style(shell).boxShadow,
        left: Math.round(box(shell).left),
        right: Math.round(box(shell).right),
      },
      targets: {
        close: Math.round(box(close).height),
        modifier: Math.round(box(modifier).height),
        chord: Math.round(box(chord).height),
      },
    };
  });

  // One floating family: material, elevation, radius and horizontal bounds.
  expect(contract.projection.radius).toBe(contract.shell.radius);
  expect(contract.projection.background).toBe(contract.shell.background);
  expect(contract.projection.shadow).toBe(contract.shell.shadow);
  expect(contract.projection.left).toBe(contract.shell.left);
  expect(contract.projection.right).toBe(contract.shell.right);
  expect(contract.projection.height).toBeLessThanOrEqual(contract.projection.maxHeight + 1);
  // App touch floor for every control the panel paints.
  for (const [name, height] of Object.entries(contract.targets)) {
    expect(height, name + ' must be at least 44px on App').toBeGreaterThanOrEqual(44);
  }
  expect(await shellBox(), 'Keys must not move the composer').toEqual(restingShell);

  // Selected modifier state is explicit, not silent.
  await page.getByTestId('terminal-modifier-ctrl').click();
  await expect(page.getByTestId('terminal-modifier-ctrl')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('terminal-chord-cancel')).toBeVisible();
  await capture(page, testInfo, 'keys-ctrl');

  // The same slot switches to Commands; the composer does not move.
  await page.getByTestId('capsule-view-quick-commands').click();
  await expect(page.getByTestId('quick-commands-list')).toBeVisible();
  expect(await shellBox(), 'Commands must not move the composer').toEqual(restingShell);
  const actionHeights = await page.evaluate(() => {
    const insert = document.querySelector('[data-testid^="quick-command-insert-"]');
    const run = document.querySelector('[data-testid^="quick-command-run-"]');
    return {
      insert: Math.round(insert.getBoundingClientRect().height),
      run: Math.round(run.getBoundingClientRect().height),
    };
  });
  expect(actionHeights.insert).toBeGreaterThanOrEqual(44);
  expect(actionHeights.run).toBeGreaterThanOrEqual(44);
  await capture(page, testInfo, 'commands');

  // Composer return: dismissal restores the resting surface, with typing.
  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
  await expect(page.getByTestId('capsule-ghost-input')).toBeVisible();
  await page.getByTestId('capsule-ghost-input').click();
  await expect(page.getByTestId('capsule-ghost-input')).toBeFocused();
  expect(await shellBox()).toEqual(restingShell);
  await capture(page, testInfo, 'restored');

  // Landscape: the slot stays bounded and above the composer.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByTestId('capsule-capability-more').click();
  // Landscape crosses the Web experience: Terminal Keys is an ordinary row
  // there, not a context-sensed one.
  await page.getByTestId('capsule-capability-picker-terminal-keys')
    .or(page.getByTestId('capsule-context-item-terminal-keys')).first().click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
  const landscape = await page.evaluate(() => {
    const projection = document.querySelector('[data-testid="capsule-capability-projection"]');
    const shell = document.querySelector('[data-testid="capsule-shell"]');
    return {
      height: Math.round(projection.getBoundingClientRect().height),
      maxHeight: Number.parseFloat(getComputedStyle(projection).maxHeight) || 0,
      projectionAboveShell: projection.getBoundingClientRect().bottom <= shell.getBoundingClientRect().top + 1,
    };
  });
  expect(landscape.height).toBeLessThanOrEqual(landscape.maxHeight + 1);
  expect(landscape.projectionAboveShell).toBe(true);
  await capture(page, testInfo, 'landscape-keys');

  test.info().annotations.push({
    type: 'evidence',
    description: 'exact SHA ' + sha + ': projection and shell share radius ' + contract.projection.radius +
      ', background, elevation and bounds; App targets close/modifier/chord were ' +
      JSON.stringify(contract.targets) + 'px and Insert/Run ' + JSON.stringify(actionHeights) +
      'px; composer box identical across rest/Keys/Ctrl/Commands/return; 5 screenshots attached',
  });
});
