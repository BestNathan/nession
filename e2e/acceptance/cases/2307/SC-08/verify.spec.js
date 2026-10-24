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

/// The active xterm buffer kind. A full-screen TUI owns the alternate screen;
/// the shell owns the normal one. Waiting on this transition (rather than on a
/// timer) is what keeps the next keystroke from racing the TUI's exit.
function activeBufferType(page) {
  return page.evaluate(() => {
    const terminal = document.querySelector('.xterm')?.parentElement?.xtermInstance;
    return terminal ? terminal.buffer.active.type : 'missing';
  });
}

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
  await expect.poll(() => activeBufferType(page), { timeout: 20000 }).toBe('alternate');
  await expect.poll(() => countInBuffer(page, '/tmp/sc08-tui-case'), { timeout: 20000 }).toBeGreaterThan(0);

  // 3. Resize while the TUI owns the screen: the terminal stays connected and
  //    the TUI's content keeps rendering. The buffer *kind* is deliberately not
  //    asserted here: a resize may re-attach and bootstrap the screen-only
  //    capture, and this criterion does not claim a full VT-mode restore.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setViewportSize({ width: 900, height: 600 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 20000 });
  await expect.poll(() => countInBuffer(page, '/tmp/sc08-tui-case'), { timeout: 20000 }).toBeGreaterThan(0);

  // 4. Exit the TUI and prove the shell is usable again. Wait until the shell's
  //    screen is what the terminal shows (the prompt is not in the TUI's
  //    screen), then type: measured on Linux, typing 4ms after `:q!` raced
  //    vim's teardown and the marker never reached the shell.
  await command(page, ':q!');
  await expect.poll(() => countInBuffer(page, 'runner:'), { timeout: 20000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
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
  // The second attach was a foreground activation and took the ControlLease
  // (#2286); a real gesture on the original terminal takes it back before it
  // types again.
  await page.locator('.xterm').click();
  await expect(page.getByTestId('terminal-observer-bar')).toBeHidden({ timeout: 20000 });
  // Taking control repaints and may make the terminal answer a query (DA/CPR);
  // those response bytes reach the shell as typed input, so let them land and
  // discard the line before typing the survival marker (observed: the reply
  // was concatenated onto the marker and the shell ran `0cprintf`).
  await page.waitForTimeout(1000);
  await command(page, '\u0003');
  await page.waitForTimeout(300);
  await command(page, '\u0015');
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
