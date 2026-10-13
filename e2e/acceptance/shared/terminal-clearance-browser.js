/**
 * Source-aligned browser proof for #1482 SC-06 / SC-08 and #1347 SC-12.
 * Runs against the exact-SHA full-stack-local Server + Agent + tmux runtime.
 */
async function verifyTerminalClearance(page, expect, runtime, targetSha) {
  if (!/^[a-f0-9]{40}$/i.test(targetSha || '')) {
    throw new Error('An exact 40-character target SHA is required');
  }
  const serverUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 20000 });

  const create = page.getByTestId('create-session');
  await expect(create).toBeEnabled({ timeout: 20000 });
  await create.click();
  const name = 'case-1482-' + process.pid + '-' + Date.now();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const autoAttach = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(autoAttach).toBeVisible({ timeout: 15000 });
  await autoAttach.getByRole('button', { name: 'Cancel' }).click();

  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByRole('button').first().click();
  const attach = page.getByRole('dialog');
  await expect(attach).toBeVisible();
  await attach.getByRole('button', { name: /^Relay\b/ }).click();
  const attachButton = attach.getByRole('button', { name: 'Attach' });
  await expect(attachButton).toBeEnabled({ timeout: 15000 });
  await attachButton.click();
  await expect(attach).not.toBeVisible({ timeout: 10000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 25000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30000 });

  await expect.poll(async () => page.evaluate(() => {
    const element = document.querySelector('.xterm');
    return Boolean(element && element.parentElement && element.parentElement.xtermInstance);
  }), { timeout: 15000 }).toBe(true);
  // Drive the same xterm input/PTY path as the user, not a synthetic DOM-only fixture.
  await page.evaluate((command) => {
    const el = document.querySelector('.xterm');
    el.parentElement.xtermInstance.input(command, true);
  }, 'seq 1 200\n');
  await expect.poll(async () => page.evaluate(() => {
    const el = document.querySelector('.xterm');
    return el.parentElement.xtermInstance.buffer.active.baseY;
  }), { timeout: 30000 }).toBeGreaterThan(100);

  const geometry = () => page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    const viewport = document.querySelector('[data-terminal-viewport]');
    const shell = document.querySelector('[data-testid="capsule-shell"]');
    const screen = viewport?.querySelector('.xterm-screen');
    const element = viewport?.querySelector('.xterm');
    const term = element?.parentElement?.xtermInstance;
    if (!(host instanceof HTMLElement) || !(viewport instanceof HTMLElement) ||
        !(shell instanceof HTMLElement) || !(screen instanceof HTMLElement) || !term) return null;
    const inset = Number.parseFloat(getComputedStyle(viewport).paddingBottom);
    const occlusion = Number.parseFloat(getComputedStyle(host).getPropertyValue('--nession-local-terminal-capsule-occlusion')) || 0;
    const viewportBox = viewport.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const gridBox = screen.getBoundingClientRect();
    const buffer = term.buffer.active;
    const cellHeight = gridBox.height / term.rows;
    const cursorBottom = gridBox.top + (buffer.cursorY + 1) * cellHeight;
    const contentLine = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString()?.trim() || '';
    return {
      inset, occlusion,
      contentBottom: viewportBox.bottom - inset,
      shellTop: shellBox.top,
      // Measure actual rendered xterm cell geometry, not only a declared CSS inset.
      gridBottom: gridBox.bottom,
      cursorBottom,
      cellHeight,
      rows: term.rows,
      cursorRow: buffer.cursorY,
      cursorLineNonEmpty: contentLine.length > 0,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      bufferType: buffer.type,
      mode: host.getAttribute('data-terminal-scroll-mode'),
      viewportHeight: viewportBox.height,
    };
  });
  const valid = (g) => g && g.mode === 'following' && g.occlusion > 0 &&
    g.inset > 0 && g.rows > 0 && g.cellHeight > 0 && g.cursorLineNonEmpty &&
    g.viewportY === g.baseY &&
    g.contentBottom <= g.shellTop + 1 &&
    g.gridBottom <= g.shellTop + 1 &&
    g.cursorBottom <= g.shellTop + 1;
  // Capture the *same* geometry snapshot that satisfied the assertion. A
  // second evaluate after an expect.poll success can see the next layout
  // frame (or a transient empty cursor line) and report a false SC-08 failure.
  const captureFollow = async (timeout = 20000) => {
    let verified = null;
    await expect.poll(async () => {
      const sample = await geometry();
      if (!valid(sample)) return false;
      verified = sample;
      return true;
    }, { timeout }).toBe(true);
    return verified;
  };
  const web = await captureFollow();

  const screen = await page.locator('.xterm-screen').boundingBox();
  if (!screen) throw new Error('xterm screen has no measurable box');
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await geometry())?.mode, { timeout: 10000 }).toBe('history');
  await expect.poll(async () => (await geometry())?.inset, { timeout: 10000 }).toBe(0);
  await expect.poll(async () => {
    const g = await geometry();
    return g && g.viewportY < g.baseY;
  }, { timeout: 10000 }).toBe(true);
  const history = await geometry();

  await page.mouse.wheel(0, 5000);
  const restored = await captureFollow(15000);

  await page.setViewportSize({ width: 390, height: 844 });
  const app = await captureFollow();

  // Exercise a second App size: a change in safe area/capsule position must not
  // leave the terminal with a stale clearance, even after history was visited.
  await page.setViewportSize({ width: 375, height: 667 });
  const compactApp = await captureFollow();

  // Return to Web and verify the follow-mode clearance survives responsive
  // layout transitions. Alternate-screen TUI control is tested by terminal E2E.
  await page.setViewportSize({ width: 1440, height: 900 });
  const webRestored = await captureFollow();

  return {
    target_sha: targetSha, case_issue: 1482, revalidates: '#1347 SC-12',
    web, history, restored, app, compactApp, webRestored,
    evidence_kind: 'computed-css-and-rendered-xterm-cell-geometry',
  };
}

module.exports = { verifyTerminalClearance };
