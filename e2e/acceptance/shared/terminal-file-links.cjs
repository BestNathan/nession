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
  // prompt is not the CI runner's. The sentinel below proves the PTY is live.
  const { name } = await createAndAttach(page, expect, runtime, prefix, mode, null);
  await command(page, "printf '%s\\n' '__3187_SHELL_READY__'");
  await expect.poll(
    async () => (await readBuffer(page)).includes('__3187_SHELL_READY__'),
    { timeout: 30_000 },
  ).toBe(true);
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
  await command(page, "printf '%s\\n' '__3187_SHELL_READY__'");
  await expect.poll(
    async () => (await readBuffer(page)).includes('__3187_SHELL_READY__'),
    { timeout: 30_000 },
  ).toBe(true);
  return name;
}

let commandCounter = 0;

/**
 * Run a shell command and wait for a fresh completion line.
 *
 * Waiting on the command text itself would pass on the tty echo; a unique
 * marker must appear twice (typed command echo + produced output).
 */
async function runLine(page, expect, text) {
  commandCounter += 1;
  const marker = '__3187_DONE_' + commandCounter + '__';
  await command(page, text);
  await command(page, "printf '%s\\n' '" + marker + "'");
  await expect.poll(
    async () => countInBuffer(page, marker),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(2);
}

/** Print a reference and wait until its output line exists (not just echo). */
async function printReference(page, expect, reference) {
  await command(page, "printf '%s\\n' '" + reference + "'");
  await expect.poll(
    async () => countInBuffer(page, reference),
    { timeout: 30_000 },
  ).toBeGreaterThanOrEqual(2);
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
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const bufferText = line.translateToString();
      const column = bufferText.lastIndexOf(text);
      if (column < 0) continue;
      const row = index - buffer.viewportY;
      if (row < 0 || row >= term.rows) continue;
      const screen = xterm.querySelector('.xterm-screen') || xterm;
      const rect = screen.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      return {
        x: rect.left + (column + 0.5) * cellWidth,
        y: rect.top + (row + 0.5) * cellHeight,
        text: bufferText,
      };
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
};
