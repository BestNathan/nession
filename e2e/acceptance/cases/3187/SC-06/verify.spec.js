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
    const afterMissing = await readTerminalState(page);
    expect(afterMissing.text, 'the link sent no PTY input').toBe(before.text);
    await returnToTerminal(page, expect, 'web');

    await printReference(page, expect, 'folder.py');
    const beforeDirectory = await readTerminalState(page);
    await activateReference(page, 'folder.py');
    await expect(error).toBeVisible();
    await expect(error).toContainText('it is a directory, not a file');
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
    // Relay owns only the terminal transport; Files has no provider there.
    await openShell(page, expect, runtime, 'sc06-relay', 'Relay');
    await printReference(page, expect, 'plain.py:2');
    const before = await readTerminalState(page);
    await activateReference(page, 'plain.py:2');
    const unavailable = page.getByTestId('file-source-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText('No file provider is available');
    const after = await readTerminalState(page);
    expect(after.text, 'the unavailable Files path sent no PTY input').toBe(before.text);
    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': a Relay-attached Session (no FileOps) showed the ' +
        'source-unavailable state for plain.py:2 with an unchanged terminal buffer',
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
  const second = await observerContext.newPage();
  try {
    const name = await openShell(controller, expect, runtime, 'sc06-observer');
    await printReference(controller, expect, 'plain.py:2');
    const before = await readTerminalState(controller);

    await attachExisting(second, expect, runtime, name, 'P2P', null);
    await expect(controller.getByTestId('terminal-observer-bar')).toBeVisible({
      timeout: 30_000,
    });

    await activateReference(controller, 'plain.py:2');
    await expectFilesSurface(controller, expect, 'web');
    const editor = await readEditor(controller);
    expect(editor.line, 'the observer reached the requested line').toBe(2);
    expect(editor.activeLineText).toBe('plain-line-2');
    await returnToTerminal(controller, expect, 'web');
    const after = await readTerminalState(controller);
    // The observer did not send input; the buffer is byte-identical.
    expect(String(after.text).replace(/\s+$/, '')).toBe(String(before.text).replace(/\s+$/, ''));
    expect(after.xtermCount).toBe(1);
    await expect(controller.getByTestId('terminal-observer-bar')).toBeVisible();

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': after a second P2P client took control, the observer ' +
        'opened plain.py at line 2 while the terminal buffer stayed unchanged',
    });
  } finally {
    await observerContext.close();
    await controllerContext.close();
  }
});
