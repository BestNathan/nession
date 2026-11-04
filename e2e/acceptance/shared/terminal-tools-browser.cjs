'use strict';
// Shared exact-SHA machinery for the #2710 Terminal Keys / Quick Commands Cases.
//
// The live half drives the real Server, Agent and tmux runtime through the real
// Web app. Terminal bytes are verified with the committed `pty-probe.sh`
// fixture, which puts the PTY in a known mode and echoes every byte back
// through `cat -v` — so a Case reads the *rendered* bytes, not a test hook.
// Geometry comes from the production DOM: the capsule shell, the upper-slot
// surface, and the transformed xterm screen.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  createAndAttach, command, readBuffer,
} = require('./foreground-resume-browser.cjs');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TOKEN = 'e2e-test-token';

/** Open the real session at `viewport`, after the desktop create/attach flow. */
async function openSession(page, expect, runtime, prefix, viewport = { width: 390, height: 844 }) {
  const { name } = await createAndAttach(
    page, expect, runtime, prefix + '-' + Date.now(), 'Relay', null,
  );
  await page.setViewportSize(viewport);
  await expect(page.getByTestId('terminal-capsule')).toBeVisible({ timeout: 15_000 });
  return name;
}

/** Open one capability's upper-slot view from the real `+` list. */
async function openCapability(page, expect, id) {
  await page.getByTestId('capsule-capability-more').click();
  const row = page.getByTestId(`capsule-capability-picker-${id}`)
    .or(page.getByTestId(`capsule-context-item-${id}`));
  await expect(row.first()).toBeVisible({ timeout: 10_000 });
  await row.first().click();
  await expect(page.getByTestId('capsule-capability-projection')).toBeVisible();
}

async function dismissCapability(page, expect) {
  await page.getByTestId('capsule-capability-dismiss').click();
  await expect(page.getByTestId('capsule-capability-projection')).toHaveCount(0);
}

/** The instance marker that proves the xterm node survived a layout change. */
async function markTerminal(page) {
  await page.locator('.xterm').evaluate((element) => {
    element.setAttribute('data-2710-terminal', 'original');
  });
}

async function terminalIdentityCount(page) {
  return page.locator('.xterm[data-2710-terminal="original"]').count();
}

/**
 * One geometry snapshot from the production DOM.
 *
 * `screenRect` is the rendered, transformed screen box; `cursorBottom` is the
 * cursor row's bottom in viewport coordinates. `dockTop` is the highest open
 * floating surface (the shell when the upper slot is empty). `rows` and
 * `paneSize` are the dimensions that must not move.
 */
async function terminalGeometry(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-terminal-capsule-host]');
    const viewport = document.querySelector('[data-terminal-viewport]');
    const shell = document.querySelector('[data-testid="capsule-shell"]');
    const dock = document.querySelector('[data-testid="terminal-capsule"]');
    const projection = document.querySelector('[data-testid="capsule-capability-projection"]');
    const context = document.querySelector('[data-testid="capsule-context-disclosure"]');
    const screen = viewport?.querySelector('.xterm-screen');
    const term = viewport?.querySelector('.xterm')?.parentElement?.xtermInstance;
    if (!(host instanceof HTMLElement) || !(shell instanceof HTMLElement) ||
        !(dock instanceof HTMLElement) || !(screen instanceof HTMLElement) || !term) {
      return null;
    }
    const style = getComputedStyle(host);
    const screenBox = screen.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const cellHeight = screenBox.height / term.rows;
    const buffer = term.buffer.active;
    const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString()?.trim() || '';
    const upper = projection || context;
    return {
      rows: term.rows,
      cellHeight,
      bufferType: buffer.type,
      mouseTrackingMode: term.modes.mouseTrackingMode,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      cursorY: buffer.cursorY,
      cursorLine,
      cursorBottom: screenBox.top + (buffer.cursorY + 1) * cellHeight,
      screenTop: screenBox.top,
      screenBottom: screenBox.bottom,
      screenTransform: getComputedStyle(screen).transform,
      dockTop: dockBox.top,
      dockBottom: dockBox.bottom,
      shellTop: shellBox.top,
      shellBox: {
        x: Math.round(shellBox.x), y: Math.round(shellBox.y),
        width: Math.round(shellBox.width), height: Math.round(shellBox.height),
      },
      upperTop: upper ? upper.getBoundingClientRect().top : null,
      upperHeight: upper ? upper.getBoundingClientRect().height : 0,
      panelClearance: Number.parseFloat(
        style.getPropertyValue('--nession-local-terminal-capsule-panel-clearance'),
      ) || 0,
      occlusion: Number.parseFloat(
        style.getPropertyValue('--nession-local-terminal-capsule-occlusion'),
      ) || 0,
      mode: host.getAttribute('data-terminal-scroll-mode'),
    };
  });
}

/** The tmux pane the Session owns; nession never uses tmux's default socket. */
function paneSize(runtime, sessionName) {
  const socket = String(runtime.tmux_socket || process.env.NESSION_TMUX_SOCKET || '');
  if (!socket.endsWith('.sock')) {
    throw new Error('the runtime must state its isolated tmux socket');
  }
  return execFileSync(
    'tmux',
    ['-S', socket, 'display', '-p', '-t', `=${sessionName}:`, '#{pane_width}x#{pane_height}'],
    { encoding: 'utf8' },
  ).trim();
}

function ptyProbeInstaller() {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'e2e', 'fixtures', 'pty-probe.sh'), 'utf8');
  return `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d > pty-probe.sh`;
}

async function sendRaw(page, data) {
  await page.evaluate((value) => {
    const xterm = Array.from(document.querySelectorAll('.xterm')).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const term = xterm?.parentElement?.xtermInstance;
    if (!term) throw new Error('xterm is not attached');
    term.input(value, true);
  }, data);
}

/** Put the probe in the PTY's cwd and start it in `mode`. */
async function startPtyProbe(page, expect, mode) {
  await command(page, ptyProbeInstaller());
  await command(page, `sh pty-probe.sh ${mode}`);
  await expect.poll(async () => (await readBuffer(page)).includes(`PTY-PROBE READY ${mode}`), {
    timeout: 20_000,
  }).toBe(true);
}

/** Kill `cat -v` and restore every mode a probe may have set. */
async function stopPtyProbe(page) {
  await sendRaw(page, '\x03');
  await page.waitForTimeout(200);
  await command(
    page,
    "printf '\\033[?1049l\\033[?1000l\\033[?1002l\\033[?1006l\\033[?1l\\033[?2004l'",
  );
  await page.waitForTimeout(200);
}

/** Authenticated Server socket for the two saved-command operations. */
function openServerSocket(runtime) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('server socket open timeout'));
    }, 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('server socket open failed'));
    }, { once: true });
  });
}

function serverRequest(socket, wire, payload, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(wire + ' timeout'));
    }, 20_000);
    const onMessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (parsed.id !== id || parsed.msg_type !== wire) return;
      cleanup();
      resolve(parsed.payload);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ msg_type: wire, id, timestamp: Date.now(), payload }));
  });
}

/** Seed one saved command through the owning protocol, as a user's client would. */
async function addSavedCommand(runtime, suffix, { label, command: text }) {
  const socket = await openServerSocket(runtime);
  try {
    const auth = await serverRequest(socket, 'server.auth', {
      auth_token: TOKEN,
      client_id: null,
    }, '2710-auth-' + suffix);
    if (auth?.status !== 'success') {
      throw new Error('server.auth failed for the saved-command seed');
    }
    const reply = await serverRequest(socket, 'server.commands.add', {
      label,
      command: text,
      raw: false,
    }, '2710-add-' + suffix);
    if (reply?.success !== true) {
      throw new Error('server.commands.add failed: ' + JSON.stringify(reply));
    }
    return reply.id;
  } finally {
    socket.close();
  }
}

module.exports = {
  addSavedCommand,
  command,
  dismissCapability,
  markTerminal,
  openCapability,
  openSession,
  paneSize,
  readBuffer,
  sendRaw,
  startPtyProbe,
  stopPtyProbe,
  terminalGeometry,
  terminalIdentityCount,
};
