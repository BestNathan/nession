import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCapsuleCapability } from '../../helpers/capsule';
import { waitForShell } from '../../helpers/shell';
import { E2E_TMUX_SOCKET } from '../../runtime';
import {
  readTerminalBuffer,
  readBufferType,
  wheelOverTerminal,
  readScrollMode,
  readViewport,
  readGrid,
  waitForStableGrid,
  waitForTerminal,
  ensureSessionsList,
  createSession,
  attachToSession,
  waitForInteractiveShell,
  sendRawToTerminal,
  submitTerminalCommand,
  expectPtySize,
  countInBuffer,
  ptyProbeInstaller,
  startPtyProbe,
  stopPtyProbe,
  readPane,
  repaintFixtureInstaller,
  lastNonEmptyLine,
  tapCapsuleArrowUp
} from '../../helpers/terminalRegression';

test.describe('Attach bootstrap (#321)', () => {
  // Two browser *contexts*, not two pages: the WebSocket service is a
  // per-storage singleton, so two pages in one context share one connection and
  // one terminal runtime — a second client has to be a second context.
  //
  // The claim under test is the one thing a bootstrap exists for and the one
  // thing live output cannot fake: a client that just attached is shown history
  // that was produced **before** it connected, while the other client sits idle
  // and this one sends nothing.

  const APP_URL =
    '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws');

  /** A marker whose typed form and rendered form differ. */
  const typedForm = (tag: string) => `printf 'BOOT-%s\\n' ${tag}`;
  const renderedForm = (tag: string) => `BOOT-${tag}`;

  test('a second client is shown history it never received live', async ({ page, browser }, testInfo) => {
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const SESSION_NAME = `e2e-bootstrap-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // The marker is printed by the *session*, before the second client exists.
    // Counting `BOOT-a1` and not the command line: the typed form is
    // `printf 'BOOT-%s\n' a1`, so `BOOT-a1` can only be output.
    await submitTerminalCommand(page, typedForm('a1'));
    await expect
      .poll(async () => countInBuffer(page, renderedForm('a1')), { timeout: 15_000 })
      .toBe(1);

    // A second client, with its own storage and its own connection.
    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, SESSION_NAME, 'Relay');
      await waitForInteractiveShell(other);

      // Nobody sends anything from here on. The only carrier of `BOOT-a1` to
      // this client is the bootstrap.
      //
      // Counted as exactly one as well as non-zero: the bootstrap *replaced*
      // this client's buffer rather than appending to it, so a duplicate here
      // would mean the marker arrived twice.
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a1')), { timeout: 20_000 })
        .toBe(1);

      // Live output still flows to both. Printed now, so this marker can only
      // reach the second client through the stream.
      await submitTerminalCommand(page, typedForm('a2'));
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a2')), { timeout: 15_000 })
        .toBe(1);

      // And the history did not come back with it: a live frame appends, and
      // the bootstrap that carried `a1` is not re-sent for one.
      expect(await countInBuffer(other, renderedForm('a1'))).toBe(1);

      // The whole thing survives the second client rebuilding its terminal.
      // This is the case the client answers `needs_bootstrap` for: the xterm is
      // new and holds nothing, so it asks, and what it gets is the session's
      // history — both markers, once each.
      await other.reload();
      await waitForShell(other);
      await waitForInteractiveShell(other);
      await expect
        .poll(async () => countInBuffer(other, renderedForm('a1')), { timeout: 20_000 })
        .toBe(1);
      expect(await countInBuffer(other, renderedForm('a2'))).toBe(1);
    } finally {
      await second.close();
    }
  });

  test('a client attaching mid-stream has no gap and no repeat at the boundary', async ({ page, browser }, testInfo) => {
    // The barrier's own test, and the one the plan called flagship. Everything
    // else asserts that the history *arrives*; this asserts that it *joins*.
    //
    // The producer numbers every line, so the two ways a join can be wrong are
    // both visible in one reading: a **missing** index is a gap at the boundary
    // (live output the snapshot did not include, and the forwarder started
    // after), and a **repeated** index is the opposite failure (the snapshot
    // overlapping output already delivered — #1148's class).
    //
    // Asserted as a set equality rather than "the last line is there": a client
    // that received lines 1..3 and 9..99 passes the latter.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const SESSION_NAME = `e2e-gap-${testInfo.retry}`;
    await createSession(page, SESSION_NAME);
    await attachToSession(page, SESSION_NAME, 'Relay');
    await waitForInteractiveShell(page);

    // Slowed deliberately: the second client has to attach *while* this is
    // still producing, or there is no boundary to be wrong about. ~6s of output
    // with the attach landing a second or two in.
    const TOTAL = 60;
    await submitTerminalCommand(
      page,
      `for i in $(seq 1 ${TOTAL}); do printf 'GAP-%03d\\n' $i; sleep 0.1; done`,
    );

    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, SESSION_NAME, 'Relay');
      await waitForInteractiveShell(other);

      // Wait for the producer to finish, so what is asserted is the whole range
      // rather than a prefix of it.
      await expect
        .poll(async () => countInBuffer(other, `GAP-${String(TOTAL).padStart(3, '0')}`), {
          timeout: 30_000,
        })
        .toBe(1);

      const text = await readTerminalBuffer(other);
      const indices = [...text.matchAll(/GAP-(\d{3})/g)].map((m) => Number(m[1]));

      expect(
        [...indices].sort((a, b) => a - b),
        `the second client's indices are not 1..${TOTAL} each exactly once — a ` +
          `missing one is a gap at the attach boundary, a duplicate is the ` +
          `snapshot overlapping the live stream`,
      ).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    } finally {
      await second.close();
    }
  });

  test("a bootstrap is that session's history and not another session's", async ({ page, browser }, testInfo) => {
    // The negative control. Without it, "the second client sees `BOOT-a1`"
    // would also pass if the marker reached it some other way — a shared
    // buffer, a cached response, a client that never cleared what it had.
    test.skip(!process.env.CI, 'local only — runs in CI workflow only');
    await page.goto(APP_URL);
    await waitForShell(page);

    const WITH_MARKER = `e2e-bootstrap-a-${testInfo.retry}`;
    const WITHOUT = `e2e-bootstrap-b-${testInfo.retry}`;
    // Both created before either is attached. Creating a Session while this
    // client is attached to another one leaves the create dialog on screen —
    // measured: `Create` is clicked, the dialog never closes, and the helper
    // times out waiting for it. Nothing here needs the second Session to be
    // made later, so it is made first.
    await createSession(page, WITH_MARKER);
    await createSession(page, WITHOUT);

    await attachToSession(page, WITH_MARKER, 'Relay');
    await waitForInteractiveShell(page);
    await submitTerminalCommand(page, typedForm('a1'));
    await expect
      .poll(async () => countInBuffer(page, renderedForm('a1')), { timeout: 15_000 })
      .toBe(1);

    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(APP_URL);
      await waitForShell(other);
      await attachToSession(other, WITHOUT, 'Relay');
      await waitForInteractiveShell(other);
      expect(await countInBuffer(other, renderedForm('a1'))).toBe(0);
    } finally {
      await second.close();
    }
  });
});
