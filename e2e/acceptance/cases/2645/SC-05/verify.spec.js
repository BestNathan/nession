'use strict';
// #2645 SC-05 (browser half): a real Server + Agent + browser with a
// shortened P2P credential lease (8s in the E2E/acceptance fixture).
//
// The established direct socket must survive expiry. After expiry, a forced
// physical P2P loss must be recovered automatically by re-attaching through
// the authenticated Server: a fresh credential is presented on the next Agent
// upgrade, the chosen route is unchanged, and the same xterm keeps exactly-once
// terminal I/O. Both Auto and pinned P2P are exercised.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

const BEFORE = 'TTL-2645-BEFORE';
const AFTER = 'TTL-2645-AFTER';
const LEASE_WAIT_MS = 10_000;

function runtimeConfig() {
  return JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
}

async function xtermInput(page, text) {
  await page.evaluate((command) => {
    const element = document.querySelector('.xterm');
    const term = element?.parentElement?.xtermInstance
      ?? element?.parentElement?.parentElement?.xtermInstance;
    if (!term) {
      throw new Error('xterm instance is not mounted');
    }
    term.input(command, true);
  }, text + '\n');
}

async function bufferText(page) {
  return page.evaluate(() => {
    const element = document.querySelector('.xterm');
    const term = element?.parentElement?.xtermInstance
      ?? element?.parentElement?.parentElement?.xtermInstance;
    if (!term) {
      return '';
    }
    const buffer = term.buffer.active;
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join('\n');
  });
}

async function countInBuffer(page, needle) {
  const text = await bufferText(page);
  return text.split(needle).length - 1;
}

async function waitForPrompt(page, expect) {
  await expect.poll(async () => {
    const text = await bufferText(page);
    const lastLine = text.split('\n').reverse().find((line) => line.trim().length > 0) ?? '';
    return lastLine;
  }, { timeout: 30_000, intervals: [500] }).toMatch(/[$#%➜❯λ]/);
}

/** Create and attach one Session over the requested transport mode. */
async function attachDirect(page, expect, runtime, mode) {
  const serverUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

  const create = page.getByTestId('create-session');
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  const sessionName = 'case-2645-' + process.pid + '-' + Date.now();
  const creation = page.getByRole('dialog');
  await expect(creation).toBeVisible();
  await creation.locator('#name').fill(sessionName);
  await creation.getByRole('button', { name: 'Create' }).click();
  const autoAttach = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(autoAttach).toBeVisible({ timeout: 30_000 });
  await autoAttach.getByRole('button', { name: 'Cancel' }).click();
  const row = page.locator('[data-testid="session-item-row"]', { hasText: sessionName });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const modeButton = mode === 'Auto'
    ? dialog.getByRole('button', {
      name: /^Auto\b.*Test paths, pick fastest, fall back to relay/,
    })
    : dialog.getByRole('button', { name: /^P2P\b/ });
  await modeButton.click();
  const attach = dialog.getByRole('button', { name: 'Attach' });
  await expect(attach).toBeEnabled({ timeout: 30_000 });
  await attach.click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });

  await expect(page.locator('.xterm')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 45_000 });
  await waitForPrompt(page, expect);
  return sessionName;
}

for (const mode of ['P2P', 'Auto']) {
  test(`SC-05: a ${mode} direct Session renews its expired credential after a physical loss`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const runtime = runtimeConfig();
    const sentTypes = [];
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        if (typeof frame.payload !== 'string') { return; }
        try {
          const parsed = JSON.parse(frame.payload);
          if (parsed.msg_type) { sentTypes.push(parsed.msg_type); }
        } catch {
          // Non-JSON frames are not protocol messages.
        }
      });
    });
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      const tracked = window;
      tracked.__e2e2645Sockets = [];
      window.WebSocket = new Proxy(Native, {
        construct(Target, args) {
          const socket = Reflect.construct(Target, args);
          tracked.__e2e2645Sockets.push(socket);
          return socket;
        },
      });
    });

    const sessionName = await attachDirect(page, expect, runtime, mode);
    await page.locator('.xterm').evaluate((node) => {
      node.setAttribute('data-e2e-2645-instance', 'original');
    });

    const agentSockets = () => page.evaluate((serverPort) => {
      const sockets = window.__e2e2645Sockets ?? [];
      return sockets
        .filter((socket) => {
          try {
            return new URL(socket.url).port !== String(serverPort);
          } catch {
            return false;
          }
        })
        .map((socket) => ({ url: socket.url, readyState: socket.readyState }));
    }, runtime.server_port);

    await expect.poll(async () => {
      const sockets = await agentSockets();
      return sockets.filter((socket) => socket.readyState === 1).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    // The attach probe opens and closes its own short-lived Agent socket; the
    // terminal transport is the most recently opened live one.
    const openAgents = (await agentSockets()).filter((socket) => socket.readyState === 1);
    const openAgent = openAgents[openAgents.length - 1];
    const originalToken = new URL(openAgent.url).searchParams.get('token');
    expect(originalToken, 'the direct route presents a credential').toBeTruthy();

    // The marker is passed through `%s` so the echoed command line does not
    // itself contain it: only the printed output counts.
    await xtermInput(page, "printf 'TTL-2645-%s\\n' BEFORE");
    await expect.poll(async () => countInBuffer(page, BEFORE), { timeout: 20_000 }).toBe(1);
    const attachRequestsBefore = sentTypes
      .filter((type) => type === 'server.session.attach').length;

    // Expiry alone must not close the established P2P socket.
    await page.waitForTimeout(LEASE_WAIT_MS);
    const stillHealthy = (await agentSockets()).some(
      (socket) => socket.readyState === 1 && socket.url.includes(originalToken),
    );
    expect(stillHealthy, 'credential expiry closed a healthy direct socket').toBe(true);

    // Physical loss after expiry. The Server connection that issues the
    // replacement stays up; only the Agent socket is cut.
    await page.evaluate((serverPort) => {
      for (const socket of window.__e2e2645Sockets ?? []) {
        try {
          if (new URL(socket.url).port !== String(serverPort) && socket.readyState === 1) {
            socket.close(4000, 'e2e p2p credential expiry loss');
          }
        } catch {
          // Ignore malformed URLs; only tracked sockets are considered.
        }
      }
    }, runtime.server_port);

    // Automatic recovery must present a different credential and be preceded
    // by an authenticated Server attach.
    await expect.poll(async () => {
      const sockets = await agentSockets();
      return sockets.filter((socket) => {
        if (socket.readyState !== 1) { return false; }
        try {
          return new URL(socket.url).searchParams.get('token') !== originalToken;
        } catch {
          return false;
        }
      }).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(
      () => sentTypes.filter((type) => type === 'server.session.attach').length,
      { timeout: 15_000 },
    ).toBeGreaterThan(attachRequestsBefore);

    await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('.xterm')).toHaveAttribute('data-e2e-2645-instance', 'original');
    expect(sentTypes, 'renewal must not change the chosen route to Relay')
      .not.toContain('server.session.relay.begin');

    // Exactly-once continuity across the renewal on the same renderer.
    await xtermInput(page, "printf 'TTL-2645-%s\\n' AFTER");
    await expect.poll(async () => countInBuffer(page, AFTER), { timeout: 20_000 }).toBe(1);
    expect(await countInBuffer(page, BEFORE)).toBe(1);

    testInfo.annotations.push({
      type: 'evidence',
      description:
        runtime.target_sha + ': ' + mode + ' direct Session {session ' + sessionName + '} stayed connected ' +
        'past the 8s lease, then after a forced physical P2P loss re-attached with a different credential ' +
        'preceded by a server.session.attach, kept the same xterm, and delivered ' + BEFORE + '/' + AFTER +
        ' exactly once without changing route to Relay',
    });
  });
}
