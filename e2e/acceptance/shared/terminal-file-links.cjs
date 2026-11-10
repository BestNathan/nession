'use strict';
// Shared browser machinery for #3187 Terminal file-reference Cases and E2E
// specs. The stack is the real full-stack runner: real Server, Agent, tmux and
// production Web build. Files are seeded in the Agent's file root (the runtime
// home), so relative references resolve through `file.cwd` exactly as a user's
// would.
const fs = require('node:fs');
const path = require('node:path');
const {
  createAndAttach,
  attachExisting,
  command,
  readBuffer,
  countInBuffer,
} = require('./foreground-resume-browser.cjs');

// The CI runner's bash prompt or a local host's zsh prompt.
const SHELL_READY = /[$#%]\s*$/m;

function writeLines(home, relative, lines) {
  const absolute = path.join(home, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, lines.join('\n') + '\n');
  return absolute;
}

/**
 * A small, deterministic tree inside the Agent's file root.
 *
 * `other/target.py` exists specifically to catch a basename scan: a resolver
 * that "found" it from the wrong CWD would open a file the reference never
 * named.
 */
function seedTerminalFiles(home) {
  writeLines(home, 'src/deep/target.py',
    Array.from({ length: 12 }, (_, index) => `target-line-${index + 1}`));
  writeLines(home, 'src/deep/sibling.py',
    Array.from({ length: 5 }, (_, index) => `sibling-line-${index + 1}`));
  writeLines(home, 'sub/child.py',
    Array.from({ length: 6 }, (_, index) => `child-line-${index + 1}`));
  writeLines(home, 'outside.py',
    Array.from({ length: 5 }, (_, index) => `outside-line-${index + 1}`));
  writeLines(home, 'other/target.py',
    Array.from({ length: 4 }, (_, index) => `other-target-line-${index + 1}`));
  writeLines(home, 'notes.md',
    Array.from({ length: 8 }, (_, index) => `notes-line-${index + 1}`));
  writeLines(home, 'plain.py',
    Array.from({ length: 20 }, (_, index) => `plain-line-${index + 1}`));
  fs.mkdirSync(path.join(home, 'folder.py'), { recursive: true });
  fs.writeFileSync(path.join(home, 'folder.py', 'inside.txt'), 'inside\n');
}

async function openShell(page, expect, runtime, prefix, mode = 'P2P') {
  // No prompt pattern: the local acceptance runner uses the host's shell, whose
  // prompt is not the CI runner's. Quiet-before-input lets zsh finish its
  // startup redraw; sending typeahead into that redraw corrupts the buffer
  // text the product is supposed to parse.
  const { name } = await createAndAttach(page, expect, runtime, prefix, mode, null);
  await waitForQuiet(page, expect);
  // The local runner's zsh sets a title with the SCO `ESC k` string, which
  // xterm.js does not consume — its payload (the command's first word) would
  // appear as text and corrupt the references this Case parses. CI's bash has
  // no such setting; `|| true` keeps the command harmless there.
  await command(page, 'unsetopt SET_TITLE 2>/dev/null || true');
  await waitForQuiet(page, expect);
  await command(page, "printf '%s\\n' '__3187_SHELL_READY__'");
  await expect.poll(
    async () => (await readBuffer(page)).includes('__3187_SHELL_READY__'),
    { timeout: 30_000 },
  ).toBe(true);
  await waitForQuiet(page, expect);
  return name;
}

/**
 * The App experience's own session flow (#3089): the Sessions layer is a depth
 * over the Terminal, and its create page leads into the attach sheet.
 */
async function openAppShell(page, expect, runtime, prefix) {
  const wsUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto(
    '/?token=e2e-test-token&server_url=' + encodeURIComponent(wsUrl) + '&experience=app',
  );
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25_000 });
  const browse = page.getByTestId('app-home-browse-sessions');
  if (await browse.isVisible().catch(() => false)) {
    await browse.click();
  }
  await expect(page.getByTestId('app-sessions-surface')).toBeVisible();
  await page.getByTestId('create-session').click();
  const createPage = page.getByTestId('app-create-session-page');
  await expect(createPage).toBeVisible();
  const name = prefix + '-' + Date.now();
  await createPage.locator('#name').fill(name);
  await createPage.getByTestId('create-session-submit').click();
  const sheet = page.getByTestId('app-attach-sheet');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // Files needs the direct Agent transport; select P2P explicitly instead of
  // relying on the saved/auto preference.
  await page.getByTestId('app-attach-settings-entry').click();
  const settings = page.getByTestId('app-attach-settings-page');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: /^P2P\b/ }).click();
  await page.getByTestId('app-attach-settings-submit').click();
  await expect(sheet).toBeVisible();
  const confirm = page.getByTestId('app-attach-confirm');
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(sheet).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('terminal-surface')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
  await waitForQuiet(page, expect);
  await command(page, 'unsetopt SET_TITLE 2>/dev/null || true');
  await waitForQuiet(page, expect);
  await command(page, "printf '%s\\n' '__3187_SHELL_READY__'");
  await expect.poll(
    async () => (await readBuffer(page)).includes('__3187_SHELL_READY__'),
    { timeout: 30_000 },
  ).toBe(true);
  await waitForQuiet(page, expect);
  return name;
}

let commandCounter = 0;

/**
 * Wait until the terminal has stopped changing.
 *
 * The local runner's zsh repaints its prompt and line editor asynchronously.
 * Sending the next command into that repaint makes zLE merge the typed line
 * with command output in the visible buffer — the product would then parse a
 * token the user never produced. Waiting for quiet before each write keeps the
 * screen (and therefore the parser's input) honest.
 */
async function waitForQuiet(page, expect, quietMs = 500, timeoutMs = 20_000) {
  let last = null;
  let since = Date.now();
  await expect.poll(async () => {
    const state = await readTerminalState(page);
    const text = state.text ?? '';
    // An empty buffer is not a settled shell: on attach there is a window
    // before zsh paints its first prompt in which "quiet" would be a lie.
    if (text.trim() === '') {
      return false;
    }
    if (text !== last) {
      last = text;
      since = Date.now();
      return false;
    }
    return Date.now() - since >= quietMs;
  }, { timeout: timeoutMs, intervals: [100] }).toBe(true);
}

/**
 * Run a shell command and wait for a fresh completion line.
 *
 * Waiting on the command text itself would pass on the tty echo; a unique
 * marker must appear twice (typed command echo + produced output).
 */
async function runLine(page, expect, text) {
  await waitForQuiet(page, expect);
  commandCounter += 1;
  const marker = '__3187_DONE_' + commandCounter + '__';
  await command(page, text);
  await command(page, "printf '%s\\n' '" + marker + "'");
  await expect.poll(
    async () => countInBuffer(page, marker),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(2);
  await waitForQuiet(page, expect);
}

/** Print a reference and wait until its output line exists (not just echo). */
async function printReference(page, expect, reference) {
  await waitForQuiet(page, expect);
  // The leading space is deliberate: a shell that emits an SCO `ESC k` title
  // leaks its payload as visible text, and without a separator the command's
  // first word would fuse with the reference (e.g. `printftarget.py`). The
  // product's matcher already accepts a whitespace boundary.
  await command(page, "printf ' %s\\n' '" + reference + "'");
  await expect.poll(
    async () => countInBuffer(page, reference),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(2);
  await waitForQuiet(page, expect);
}

/**
 * The screen coordinates of the newest visible occurrence of `needle`.
 *
 * Coordinates come from xterm's own cell box, so wide characters, padding and
 * the Experience inset cannot shift the click off the drawn text.
 */
async function referencePoint(page, needle) {
  return page.evaluate((text) => {
    const xterms = Array.from(document.querySelectorAll('.xterm')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (xterms.length !== 1) {
      throw new Error('expected exactly one visible xterm, found ' + xterms.length);
    }
    const xterm = xterms[0];
    const term = xterm.parentElement.xtermInstance;
    if (!term) {
      throw new Error('xterm instance missing');
    }
    const buffer = term.buffer.active;
    // The matcher reads *logical* lines (wrapped continuations joined), so a
    // long path can be underlined across several physical rows. Find it in the
    // same joined text, then map the start back to its physical cell.
    const logical = [];
    for (let start = 0; start < buffer.length;) {
      let end = start;
      while (
        end + 1 < buffer.length &&
        buffer.getLine(end + 1)?.isWrapped === true
      ) {
        end += 1;
      }
      const parts = [];
      for (let index = start; index <= end; index += 1) {
        parts.push(buffer.getLine(index)?.translateToString() ?? '');
      }
      logical.push({ start, end, text: parts.join('') });
      start = end + 1;
    }
    for (let index = logical.length - 1; index >= 0; index -= 1) {
      const entry = logical[index];
      const found = entry.text.lastIndexOf(text);
      if (found < 0) continue;
      let remaining = found;
      for (let physical = entry.start; physical <= entry.end; physical += 1) {
        const lineText = buffer.getLine(physical)?.translateToString() ?? '';
        if (remaining >= lineText.length) {
          remaining -= lineText.length;
          continue;
        }
        const row = physical - buffer.viewportY;
        if (row < 0 || row >= term.rows) break;
        const screen = xterm.querySelector('.xterm-screen') || xterm;
        const rect = screen.getBoundingClientRect();
        const cellWidth = rect.width / term.cols;
        const cellHeight = rect.height / term.rows;
        return {
          x: rect.left + (remaining + 0.5) * cellWidth,
          y: rect.top + (row + 0.5) * cellHeight,
          text: entry.text,
        };
      }
    }
    throw new Error('reference not found in the visible terminal: ' + text);
  }, needle);
}

async function activateReference(page, needle, options = {}) {
  const point = await referencePoint(page, needle);
  if (options.touch) {
    await page.touchscreen.tap(point.x, point.y);
    return point;
  }
  // Two moves, because xterm asks the link provider on hover and a synthetic
  // click alone can arrive before the provider has answered.
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(150);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(100);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function readEditor(page) {
  return page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll('.cm-editor')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (editors.length === 0) {
      return { count: 0 };
    }
    if (editors.length > 1) {
      return { count: editors.length };
    }
    const editor = editors[0];
    const content = editor.querySelector('.cm-content');
    const active = editor.querySelector('.cm-activeLine');
    return {
      count: 1,
      line: Number(editor.getAttribute('data-selection-line')),
      column: Number(editor.getAttribute('data-selection-column')),
      activeLineText: active ? active.textContent : null,
      text: content ? content.textContent : '',
      marker: editor.getAttribute('data-3187-editor-instance'),
    };
  });
}

function expectEditorAt(page, expect, expected) {
  return expect.poll(async () => readEditor(page), { timeout: 20_000 }).toMatchObject(expected);
}

async function markEditor(page) {
  await page.evaluate(() => {
    const editor = Array.from(document.querySelectorAll('.cm-editor')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!editor) throw new Error('visible editor missing');
    editor.setAttribute('data-3187-editor-instance', 'original');
  });
}

async function expectFilesSurface(page, expect, experience) {
  if (experience === 'app') {
    await expect(page.getByTestId('app-page-header')).toBeVisible();
    await expect(page.getByTestId('app-page-back')).toBeVisible();
  } else {
    await expect(page.getByTestId('file-workspace')).toBeVisible();
    await expect(page.getByTestId('files-web-layout')).toBeVisible();
  }
  await expect(page.locator('.cm-editor')).toBeVisible();
}

/** Return from Files to the still-mounted Terminal. */
async function returnToTerminal(page, expect, experience) {
  if (experience === 'app') {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const back = page.getByTestId('app-page-back');
      if (!(await back.isVisible().catch(() => false))) break;
      await back.click();
      await page.waitForTimeout(300);
    }
    await expect(page.getByTestId('app-page-header')).toHaveCount(0);
  } else {
    await page.getByTestId('surface-action-open-terminal').click();
  }
  await expect(page.getByTestId('terminal-surface')).toBeVisible();
}

async function readTerminalState(page) {
  return page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll('.xterm')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (visible.length !== 1) return { xtermCount: visible.length, text: null };
    const xterm = visible[0];
    const term = xterm.parentElement.xtermInstance;
    if (!term) return { xtermCount: 1, text: null };
    const buffer = term.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString());
    }
    return {
      xtermCount: document.querySelectorAll('.xterm').length,
      instanceMarker: xterm.getAttribute('data-3187-terminal-instance'),
      text: lines.join('\n'),
      viewportY: buffer.viewportY,
      scrollTop: xterm.querySelector('.xterm-viewport')?.scrollTop ?? 0,
    };
  });
}

async function markTerminal(page) {
  await page.evaluate(() => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!xterm) throw new Error('visible xterm missing');
    xterm.setAttribute('data-3187-terminal-instance', 'original');
  });
}

async function terminalScreenCenter(page) {
  return page.evaluate(() => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!xterm) throw new Error('visible xterm missing');
    const screen = xterm.querySelector('.xterm-screen') || xterm;
    const rect = screen.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function scrollTerminal(page, deltaY) {
  const point = await terminalScreenCenter(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}

module.exports = {
  SHELL_READY,
  attachExisting,
  activateReference,
  expectEditorAt,
  expectFilesSurface,
  markEditor,
  markTerminal,
  openAppShell,
  openShell,
  printReference,
  readEditor,
  readTerminalState,
  referencePoint,
  returnToTerminal,
  runLine,
  scrollTerminal,
  seedTerminalFiles,
  waitForQuiet,
};
