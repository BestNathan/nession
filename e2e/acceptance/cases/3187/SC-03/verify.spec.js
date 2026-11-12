'use strict';
// #3187 SC-03: relative references resolve against the Session's current CWD
// at activation time; absolute references stay absolute; and missing,
// directory or lookalike targets fail visibly instead of opening another file.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  expectEditorAt,
  expectFilesSurface,
  openShell,
  printReference,
  readEditor,
  returnToTerminal,
  runLine,
  seedTerminalFiles,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

test('SC-03: CWD, ./ and ../ resolve exactly; absolute stays absolute; failures never guess', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-03');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'sc03');
    await runLine(page, expect, 'cd sub');

    // `./child.py` from `sub`: a workspace-root resolver would look for the
    // root's child.py and fail; the CWD resolver opens sub/child.py.
    await printReference(page, expect, './child.py:3');
    await activateReference(page, './child.py:3');
    await expectFilesSurface(page, expect, 'web');
    await expectEditorAt(page, expect, {
      count: 1, line: 3, column: 1, activeLineText: 'child-line-3',
    });
    await expect(page.getByText('sub/child.py', { exact: false }).first()).toBeVisible();
    await returnToTerminal(page, expect, 'web');

    // `../outside.py` pops the real `sub` segment.
    await printReference(page, expect, '../outside.py:2');
    await activateReference(page, '../outside.py:2');
    await expectEditorAt(page, expect, {
      count: 1, line: 2, column: 1, activeLineText: 'outside-line-2',
    });
    await expect(page.getByText('outside.py', { exact: false }).first()).toBeVisible();
    await returnToTerminal(page, expect, 'web');

    // Absolute keeps its absolute meaning on the same source.
    const absolute = path.join(runtime.home, 'src/deep/sibling.py') + ':4';
    await printReference(page, expect, absolute);
    await activateReference(page, absolute);
    await expectEditorAt(page, expect, {
      count: 1, line: 4, column: 1, activeLineText: 'sibling-line-4',
    });
    await returnToTerminal(page, expect, 'web');

    // Missing `target.py` under `sub` must not fall back to
    // src/deep/target.py or other/target.py.
    await printReference(page, expect, 'target.py');
    await activateReference(page, 'target.py');
    const missingError = page.getByTestId('files-web-handoff-error');
    await expect(missingError).toBeVisible();
    await expect(missingError).toContainText('sub/target.py');
    await expect(missingError).toContainText('moved or deleted');
    let editor = await readEditor(page);
    expect(String(editor.text)).not.toContain('other-target-line');
    await returnToTerminal(page, expect, 'web');

    // A directory named like a file is refused, not opened.
    await printReference(page, expect, '../folder.py');
    await activateReference(page, '../folder.py');
    const directoryError = page.getByTestId('files-web-handoff-error');
    await expect(directoryError).toBeVisible();
    await expect(directoryError).toContainText('it is a directory, not a file');
    await returnToTerminal(page, expect, 'web');

    // A basename elsewhere in the source is not a match for `target.py`.
    // Open a valid file first so the next failure must be produced afresh.
    await printReference(page, expect, './child.py:2');
    await activateReference(page, './child.py:2');
    await expectEditorAt(page, expect, {
      count: 1, line: 2, column: 1, activeLineText: 'child-line-2',
    });
    await expect(missingError).toHaveCount(0);
    await returnToTerminal(page, expect, 'web');

    await printReference(page, expect, 'target.py');
    await activateReference(page, 'target.py');
    await expect(missingError).toBeVisible();
    await expect(missingError).toContainText('sub/target.py');
    editor = await readEditor(page);
    expect(String(editor.text)).not.toContain('other-target-line');
    expect(String(editor.text)).not.toContain('target-line-');

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': CWD sub resolved ./child.py and ../outside.py to sub/child.py ' +
        'and outside.py; the absolute ' + absolute + ' opened sibling-line-4; missing ' +
        'sub/target.py, ../folder.py (directory) and a lookalike other/target.py produced ' +
        'visible failures and never opened another file',
    });
  } finally {
    await context.close();
  }
});
