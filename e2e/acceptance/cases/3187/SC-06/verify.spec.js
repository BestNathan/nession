'use strict';
// #3187 SC-06: missing/inaccessible, directory and unavailable-FileOps targets
// produce actionable, non-destructive results; an observer can still open a
// permitted file; none of this sends PTY input.
const { test, expect } = require('@playwright/test');
const {
  attachExisting,
  verifiedRuntime,
} = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  expectFilesSurface,
  openShell,
  printReference,
  readEditor,
  readTerminalState,
  referencePoint,
  returnToTerminal,
  seedTerminalFiles,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

test('SC-06: missing and directory targets fail without sending input', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-06');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'sc06-failures');
    await printReference(page, expect, 'missing.py');
    const before = await readTerminalState(page);
    await activateReference(page, 'missing.py');
    const error = page.getByTestId('files-web-handoff-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('may have been moved or deleted');
    await expect(error).toContainText('missing.py');
    expect((await readEditor(page)).count).toBe(0);
    await returnToTerminal(page, expect, 'web');
    const afterMissing = await readTerminalState(page);
    expect(afterMissing.text, 'the link sent no PTY input').toBe(before.text);

    await printReference(page, expect, 'folder.py');
    const beforeDirectory = await readTerminalState(page);
    await activateReference(page, 'folder.py');
    await expect(error).toBeVisible();
    await expect(error).toContainText('it is a directory, not a file');
    await returnToTerminal(page, expect, 'web');
    const afterDirectory = await readTerminalState(page);
    expect(afterDirectory.text, 'the directory refusal sent no PTY input').toBe(
      beforeDirectory.text,
    );

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': missing.py and the folder.py directory produced visible, ' +
        'actionable failures with no editor opened and byte-identical terminal buffers',
    });
  } finally {
    await context.close();
  }
});

test('SC-06: unavailable FileOps is a visible state, not a wrong file', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-06');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    // Relay owns only the terminal transport; Files has no provider there, so
    // the capability itself reports the state instead of accepting a path.
    await openShell(page, expect, runtime, 'sc06-relay', 'Relay');
    await printReference(page, expect, 'plain.py:2');
    const before = await readTerminalState(page);
    await activateReference(page, 'plain.py:2');
    await expect(page.getByText('Files is not available here')).toBeVisible();
    await expect(page.getByTestId('file-source-unavailable')).toHaveCount(0);
    await returnToTerminal(page, expect, 'web');
    const after = await readTerminalState(page);
    expect(after.text, 'the unavailable Files path sent no PTY input').toBe(before.text);
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': a Relay-attached Session (no FileOps) showed ' +
        '`Files is not available here` for plain.py:2 with an unchanged terminal buffer',
    });
  } finally {
    await context.close();
  }
});

test('SC-06: an observer can open a permitted file without PTY input', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-06');
  seedTerminalFiles(runtime.home);
  const controllerContext = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const observerContext = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const controller = await controllerContext.newPage();
  const observer = await observerContext.newPage();
  try {
    const name = await openShell(controller, expect, runtime, 'sc06-observer');

    // The second client attaches first and defaults to controller in its own
    // UI; a real terminal gesture on the first client claims the Agent's
    // control lease and broadcasts the observer role to the second (#2286).
    await attachExisting(observer, expect, runtime, name, 'P2P', null);
    const gesture = await referencePoint(controller, 'printf');
    await controller.mouse.click(gesture.x, gesture.y);

    // The observer state is an opt-in notice (#2658): open the capsule's
    // notices to see it, rather than expecting a permanent bar over the grid.
    const notices = observer.getByTestId('terminal-notices-trigger');
    await expect(notices).toBeVisible({ timeout: 30_000 });
    await notices.click();
    await expect(observer.getByTestId('terminal-observer-bar')).toBeVisible();
    await observer.keyboard.press('Escape');
    await expect(observer.getByTestId('terminal-observer-bar')).toBeHidden();

    // Live output from the controller reaches the observer. The observer
    // cannot type, so the controller prints the reference it will open.
    await printReference(controller, expect, 'plain.py:2');
    await expect.poll(
      async () => (await readTerminalState(observer)).text ?? '',
      { timeout: 30_000 },
    ).toContain('plain.py:2');
    const before = await readTerminalState(observer);

    await activateReference(observer, 'plain.py:2');
    await expectFilesSurface(observer, expect, 'web');
    const editor = await readEditor(observer);
    expect(editor.line, 'the observer reached the requested line').toBe(2);
    expect(editor.activeLineText).toBe('plain-line-2');
    await returnToTerminal(observer, expect, 'web');
    const after = await readTerminalState(observer);
    // The observer did not send input; the buffer is byte-identical.
    expect(String(after.text).replace(/\s+$/, '')).toBe(String(before.text).replace(/\s+$/, ''));
    expect(after.xtermCount).toBe(1);

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': a second P2P client attached read-only, saw ' +
        'plain.py:2 arrive from the controller, and opened plain.py at line 2 while its ' +
        'terminal buffer stayed unchanged',
    });
  } finally {
    await observerContext.close();
    await controllerContext.close();
  }
});
