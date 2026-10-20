import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import {
  createSession,
  attachToSession,
  waitForInteractiveShell,
  readTerminalBuffer,
  submitTerminalCommand,
} from '../../helpers/terminalRegression';

// #1645 SC-10 / #1926 SC-05: a high-rate numbered burst must reach the xterm
// parser exactly once per line — no hole a replay was supposed to fill and no
// duplicate from a snapshot/live overlap. The count is deliberately larger
// than any single frame or queue chunk the Agent emits, so a dropped or
// replayed frame shows up as a missing/duplicated number rather than passing
// on a small sample.
const COUNT = 20_000;
// The check window is the tail: xterm's scrollback budget is profile-dependent
// (10k mobile / 50k desktop), and losing the oldest lines to scrollback is
// correct behavior, not a stream defect. A hole in the tail is not.
const TAIL = 5_000;

for (const mode of ['Relay', 'P2P'] as const) {
  test(`high-volume numbered output reaches the parser exactly once over ${mode}`, async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'real stack available in CI only');
    test.setTimeout(180_000);

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
      expect(await readTerminalBuffer(page)).toContain(`HV-${COUNT}`);
    }).toPass({ timeout: 120_000 });

    const text = await readTerminalBuffer(page);
    const counts = new Map<number, number>();
    for (const match of text.matchAll(/HV-(\d+)/g)) {
      const value = Number(match[1]);
      if (value >= 1 && value <= COUNT) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }

    const duplicated = [...counts.entries()]
      .filter(([, seen]) => seen > 1)
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
