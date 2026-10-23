'use strict';
// Exact-SHA source-aligned Case for #2307 SC-08: the migrated Control Mode
// client keeps a normal shell, a full-screen TUI (vim), resize, exit, the
// bootstrap capture and both P2P/Relay attach paths working through the real
// provisioned stack. Screen-only capture is evidence of the screen, never a
// claim of complete VT restoration.
const { test, expect } = require('@playwright/test');
const {
  verifiedRuntime, createAndAttach, attachExisting, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

test('SC-08: shell, full-screen TUI, resize, exit, capture bootstrap and P2P/Relay', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const { runtime, sha } = verifiedRuntime('SC-08');
  expect(runtime.tmux_socket).toMatch(/\.sock$/);

  // 1. Normal shell: a marker produced by the tty (shell expansion keeps the
  //    echoed command from satisfying the assertion).
  const { name } = await createAndAttach(page, expect, runtime, 'case-2307-shell', 'Relay');
  await command(page, "printf 'SC08-SHELL-%s\\n' 2307");
  await expect.poll(() => countInBuffer(page, 'SC08-SHELL-2307'), { timeout: 20000 }).toBe(1);

  // 2. Full-screen TUI on the alternate screen. The status line names the
  //    file, which is the one piece of vim's screen a shell echo cannot fake.
  await command(page, "vim -u NONE -N -c 'set laststatus=2' /tmp/sc08-tui-case");
  await expect.poll(() => countInBuffer(page, '/tmp/sc08-tui-case'), { timeout: 20000 }).toBeGreaterThan(0);

  // 3. Resize while the TUI owns the screen: the terminal stays connected and
  //    the TUI keeps rendering.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 20000 });
  await expect.poll(() => countInBuffer(page, '/tmp/sc08-tui-case'), { timeout: 20000 }).toBeGreaterThan(0);

  // 4. Exit the TUI and prove the shell is usable again.
  await command(page, ':q!');
  await command(page, "printf 'SC08-AFTER-%s\\n' 2307");
  await expect.poll(() => countInBuffer(page, 'SC08-AFTER-2307'), { timeout: 20000 }).toBe(1);

  // 5. Bootstrap capture: a second attach sees the pre-attach screen/history,
  //    without claiming a full VT restore.
  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    await attachExisting(second, expect, runtime, name, 'Relay');
    await expect.poll(() => countInBuffer(second, 'SC08-SHELL-2307'), { timeout: 20000 }).toBeGreaterThan(0);
    await expect.poll(() => countInBuffer(second, 'SC08-AFTER-2307'), { timeout: 20000 }).toBeGreaterThan(0);
  } finally {
    await secondContext.close();
  }
  // The original client survives the second subscriber's attach and close.
  await command(page, "printf 'SC08-SURVIVED-%s\\n' 2307");
  await expect.poll(() => countInBuffer(page, 'SC08-SURVIVED-2307'), { timeout: 20000 }).toBe(1);

  // 6. P2P attach path remains functional alongside Relay.
  const p2pContext = await browser.newContext();
  try {
    const p2p = await p2pContext.newPage();
    await createAndAttach(p2p, expect, runtime, 'case-2307-p2p', 'P2P');
    await command(p2p, "printf 'SC08-P2P-%s\\n' 2307");
    await expect.poll(() => countInBuffer(p2p, 'SC08-P2P-2307'), { timeout: 20000 }).toBe(1);
  } finally {
    await p2pContext.close();
  }
});
