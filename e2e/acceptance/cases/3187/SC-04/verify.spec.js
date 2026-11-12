'use strict';
// #3187 SC-04: path opens normally; line/column position visibly; the same
// file re-activation moves the mounted editor; out-of-range locations clamp;
// and a previewable text opens raw/source when a line is requested.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');
const {
  activateReference,
  expectEditorAt,
  expectFilesSurface,
  markEditor,
  openShell,
  printReference,
  readEditor,
  returnToTerminal,
  seedTerminalFiles,
} = require('../../../shared/terminal-file-links.cjs');

test.setTimeout(110_000);

test('SC-04: line/column positioning, same-file reposition, clamp and raw preview', async ({ browser }) => {
  const { runtime, sha } = verifiedRuntime('SC-04');
  seedTerminalFiles(runtime.home);
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const page = await context.newPage();
  try {
    await openShell(page, expect, runtime, 'sc04');

    // A plain path opens the file at its start.
    await printReference(page, expect, 'plain.py');
    await activateReference(page, 'plain.py');
    await expectFilesSurface(page, expect, 'web');
    await expectEditorAt(page, expect, {
      count: 1, line: 1, column: 1, activeLineText: 'plain-line-1',
    });
    await returnToTerminal(page, expect, 'web');

    // `path:line` and `path:line:column` position the visible cursor.
    await printReference(page, expect, 'plain.py:12');
    await activateReference(page, 'plain.py:12');
    await expectEditorAt(page, expect, {
      count: 1, line: 12, column: 1, activeLineText: 'plain-line-12',
    });
    await returnToTerminal(page, expect, 'web');

    await printReference(page, expect, 'plain.py:12:4');
    await activateReference(page, 'plain.py:12:4');
    await expectEditorAt(page, expect, {
      count: 1, line: 12, column: 4, activeLineText: 'plain-line-12',
    });
    await markEditor(page);
    await returnToTerminal(page, expect, 'web');

    // Same file, new location: the mounted editor moves instead of no-op or
    // remount.
    await printReference(page, expect, 'plain.py:3:2');
    await activateReference(page, 'plain.py:3:2');
    await expectEditorAt(page, expect, {
      count: 1, line: 3, column: 2, activeLineText: 'plain-line-3', marker: 'original',
    });
    await returnToTerminal(page, expect, 'web');

    // Out-of-range line and column clamp to the document's end. The seeded
    // file ends with a newline, so the document's last line is the empty 21st.
    await printReference(page, expect, 'plain.py:999:999');
    await activateReference(page, 'plain.py:999:999');
    await expectEditorAt(page, expect, {
      count: 1, line: 21, column: 1, activeLineText: '',
    });
    await returnToTerminal(page, expect, 'web');

    // Previewable text without a location renders preview; a line reference
    // must switch the same view to source at that line.
    await printReference(page, expect, 'notes.md');
    await activateReference(page, 'notes.md');
    const viewer = page.locator('[data-testid="file-content-viewer"]');
    await expect(viewer).toHaveAttribute('data-mode', 'preview');
    await returnToTerminal(page, expect, 'web');

    await printReference(page, expect, 'notes.md:5:2');
    await activateReference(page, 'notes.md:5:2');
    await expect(viewer).toHaveAttribute('data-mode', 'source');
    await expectEditorAt(page, expect, {
      count: 1, line: 5, column: 2, activeLineText: 'notes-line-5',
    });

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': plain.py opened at 1, then visible positions 12:1, 12:4 and ' +
        '3:2 (same mounted editor); 999:999 clamped to the document end (line 21, the empty ' +
        'line after the trailing newline); notes.md previewed without a location and ' +
        'notes.md:5:2 switched the same view to source at line 5 column 2',
    });
  } finally {
    await context.close();
  }
});
