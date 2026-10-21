import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import {
  createSession,
  attachToSession,
  waitForInteractiveShell,
  readTerminalBuffer,
  readBufferType,
  readGrid,
  countInBuffer,
  waitForStableGrid,
  sendRawToTerminal,
  submitTerminalCommand,
} from '../../helpers/terminalRegression';

// #1645 SC-10 / #1926 SC-05: a high-rate numbered burst must reach the xterm
// parser exactly once per line — no hole a replay was supposed to fill and no
// duplicate from a snapshot/live overlap. The count is deliberately larger
// than any single frame or queue chunk the Agent emits, so a dropped or
// replayed frame shows up as a missing/duplicated number rather than passing
// on a small sample.
const COUNT = 5_000;
// The check window is the tail: xterm's scrollback budget is profile-dependent
// (10k mobile / 50k desktop), and losing the oldest lines to scrollback is
// correct behavior, not a stream defect. A hole in the tail is not.
const TAIL = 2_000;

// Read only the last rows while the burst is still streaming. Serializing the
// whole buffer on every poll blocks the page's event loop long enough
// that the WebSocket stops draining, which is a property of the witness, not
// of the stream under test. The full buffer is read once, after the last line.
async function readBufferTail(
  page: import('@playwright/test').Page,
  lines = 40,
): Promise<string> {
  return page.evaluate((count) => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement;
    const term = (container as Record<string, unknown>)?.xtermInstance as
      | { buffer: { active: { length: number; getLine(y: number): { translateToString(): string } | undefined } } }
      | undefined;
    if (!term) { return ''; }
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - count);
    const out: string[] = [];
    for (let i = start; i < buffer.length; i += 1) {
      out.push(buffer.getLine(i)?.translateToString() ?? '');
    }
    return out.join('\n');
  }, lines);
}

for (const mode of ['Relay', 'P2P'] as const) {
  test(`high-volume numbered output reaches the parser exactly once over ${mode}`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    // Session creation/attach plus the burst. The readiness wait below is the
    // real bound; a stall is a finding, not a reason to extend the timeout.
    test.setTimeout(240_000);

    const sessionName = `e2e-consistency-hv-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    // The echoed command line spells `HV-/` but no `HV-<digits>`, so every
    // numeric match below comes from the stream output itself. Waiting for the
    // LAST line — not a `echo DONE` marker, whose text is echoed at the prompt
    // the moment the command is submitted — is what makes the buffer read a
    // complete prefix rather than a mid-stream sample.
    await submitTerminalCommand(page, `seq 1 ${COUNT} | sed 's/^/HV-/'`);

    await expect(async () => {
      expect(await readBufferTail(page)).toContain(`HV-${COUNT}`);
    }).toPass({ timeout: 180_000 });

    const text = await readTerminalBuffer(page);
    const counts = new Map<number, number>();
    for (const match of text.matchAll(/HV-(\d+)/g)) {
      const value = Number(match[1]);
      if (value >= 1 && value <= COUNT) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }

    // A separate-process (PTY) bootstrap is explicitly unverified: a producer
    // racing the capture can put a prefix line in both the snapshot and the
    // live stream. That prefix is outside the synchronized guarantee, and the
    // criterion scopes duplicates to the retained tail alongside missing
    // lines. A tail line delivered twice is still a failure.
    const duplicated = [...counts.entries()]
      .filter(([value, seen]) => seen > 1 && value > COUNT - TAIL)
      .map(([value]) => value);
    const missingTail: number[] = [];
    for (let value = COUNT - TAIL + 1; value <= COUNT; value += 1) {
      if (!counts.has(value)) {
        missingTail.push(value);
      }
    }

    expect(duplicated, 'a line was delivered more than once').toEqual([]);
    expect(missingTail, 'a line in the tail window never reached the parser').toEqual([]);
  });
}

// #2130 / #1926 SC-07: a screen that owns the terminal. The alternate screen
// must stay the active buffer through an authoritative resize, receive the
// same size the browser grid reports, and leave no TUI content in normal
// scrollback when it exits. Markers are built from printf arguments so the
// command line the PTY echoes never contains the resolved marker.
for (const mode of ['Relay', 'P2P'] as const) {
  test(`alternate screen survives an authoritative resize and exits cleanly over ${mode}`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    test.setTimeout(120_000);

    const sessionName = `e2e-consistency-tui-${mode.toLowerCase()}-${testInfo.retry}-${Date.now()}`;
    await page.goto(
      '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'),
    );
    await waitForShell(page);
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, mode);
    await waitForInteractiveShell(page);

    await submitTerminalCommand(
      page,
      `printf '\\033[?1049h'; printf '\\033[?1h\\033[?1000h\\033[?2004h'; ` +
        `printf 'ALT-%s-TUI\\n' 2130; ` +
        `while :; do sleep 0.5; printf 'ALT-%s-SIZE %s\\n' 2130 "$(stty size)"; done`,
    );

    await expect(async () => {
      expect(await readBufferType(page)).toBe('alternate');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-TUI');
    }).toPass({ timeout: 15_000 });

    // The controller suppresses the PTY half of a resize while the webfont is
    // still loading (`metricsAreProvisional`), but still resizes the local
    // grid. Wait for the face before measuring, or the grid moves while the
    // PTY legitimately does not follow.
    await waitForStableGrid(page);
    await page.evaluate(async () => { await document.fonts.ready; });

    // The browser grid changes while the TUI owns the screen: the alternate
    // buffer must stay active and the pane must report the same size from
    // inside it.
    const before = await readGrid(page);
    // Grow, not shrink: tmux keeps the largest attached client's size, and
    // the suite's PTY-follow proof (#1187) is a growth assertion.
    await page.setViewportSize({ width: 1600, height: 1000 });
    let after = before;
    await expect(async () => {
      after = await readGrid(page);
      expect(after.rows).toBeGreaterThan(before.rows);
    }).toPass({ timeout: 15_000 });

    await expect(async () => {
      expect(await readBufferType(page)).toBe('alternate');
      expect(await readTerminalBuffer(page)).toContain(
        `ALT-2130-SIZE ${after.rows} ${after.cols}`,
      );
    }).toPass({ timeout: 15_000 });

    // Interrupt the loop, then leave the alternate screen from the shell.
    await sendRawToTerminal(page, '\x03');
    await submitTerminalCommand(page, `printf '\\033[?1049l'; echo ALT-2130-BACK`);

    await expect(async () => {
      expect(await readBufferType(page)).toBe('normal');
      expect(await readTerminalBuffer(page)).toContain('ALT-2130-BACK');
    }).toPass({ timeout: 15_000 });

    // Nothing owned by the alternate screen may leak into normal scrollback.
    expect(await countInBuffer(page, 'ALT-2130-TUI')).toBe(0);

  });
}
