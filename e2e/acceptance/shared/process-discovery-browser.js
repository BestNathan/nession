'use strict';
// Shared exact-SHA browser proof for #2514's Agent Workspace SCs.
//
// The flow is one real run against the full-stack-local Server + Agent + tmux
// runtime: create a Session, attach, type a command through xterm's own input
// path, open Workspace -> Agent, and inspect the read-only process snapshot.
// The command carries a credential-shaped flag so redaction is observed on the
// wire path rather than asserted from a fixture.

const SECRET = 'nession-e2e-2514-secret';
const TYPED_COMMAND = "sh -c 'sleep 120; :' --token " + SECRET + ' &';

async function openAgentProcesses(page, expect, runtime, targetSha) {
  if (!/^[a-f0-9]{40}$/i.test(targetSha || '')) {
    throw new Error('An exact 40-character target SHA is required');
  }
  const serverUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(serverUrl));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 30_000 });

  // ── Create a Session ──
  const create = page.getByTestId('create-session');
  await expect(create).toBeEnabled({ timeout: 30_000 });
  await create.click();
  const sessionName = 'case-2514-' + process.pid + '-' + Date.now();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(sessionName);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const autoAttach = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(autoAttach).toBeVisible({ timeout: 30_000 });
  await autoAttach.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('[data-testid="session-item-row"]', { hasText: sessionName }))
    .toBeVisible({ timeout: 30_000 });

  // ── Attach so the typed command has a live PTY ──
  const row = page.locator('[data-testid="session-item-row"]', { hasText: sessionName });
  await row.getByRole('button').first().click();
  const attach = page.getByRole('dialog');
  await expect(attach).toBeVisible();
  await attach.getByRole('button', { name: /^Relay\b/ }).click();
  const attachButton = attach.getByRole('button', { name: 'Attach' });
  await expect(attachButton).toBeEnabled({ timeout: 30_000 });
  await attachButton.click();
  await expect(attach).not.toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 45_000 });
  await expect.poll(
    async () => page.evaluate(() => {
      const element = document.querySelector('.xterm');
      const container = element && element.parentElement;
      return Boolean(container && container.xtermInstance);
    }),
    { timeout: 30_000 },
  ).toBe(true);

  // Same path as a user's typing: xterm's input API drives the PTY.
  await page.evaluate((command) => {
    const element = document.querySelector('.xterm');
    element.parentElement.xtermInstance.input(command, true);
  }, TYPED_COMMAND + '\n');

  // ── Workspace -> Agent ──
  await page.getByTestId('surface-action-open-workspace').click();
  await expect(page.getByTestId('workspace-shell')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('workspace-tool-agent').click();
  await expect(page.getByTestId('agent-detail')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('agent-processes')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('agent-process-session-selector')).toBeVisible({
    timeout: 30_000,
  });

  const pane = page.locator('[data-testid^="process-pane-"]').first();
  await expect(pane).toBeVisible({ timeout: 60_000 });
  // The typed child may start after the first snapshot. Refresh the read-only
  // observation until it is present; a hidden refresh is not a hidden wait.
  const refresh = page.getByRole('button', { name: 'Refresh process snapshot' });
  await expect.poll(async () => {
    const text = await pane.innerText();
    if (text.includes('sh -c')) {
      return true;
    }
    if (await refresh.isEnabled()) {
      await refresh.click();
    }
    return false;
  }, { timeout: 90_000, intervals: [1_500] }).toBe(true);

  const snapshotHeader = await page.getByTestId('agent-processes').innerText();
  if (snapshotHeader.includes(SECRET)) {
    throw new Error('the raw secret reached the browser');
  }

  return {
    sha: targetSha,
    sessionName,
    typedCommand: TYPED_COMMAND,
    secret: SECRET,
    pane,
    snapshotHeader,
  };
}

/** Select the Pane root and open the inspector. */
async function inspectRoot(page, expect, pane) {
  await pane.getByRole('button').first().click();
  await expect(page.getByTestId('process-inspector')).toBeVisible({ timeout: 15_000 });
  return captureInspector(page);
}

/** Select the `sh -c …` row that carries the redacted token. */
async function inspectCredentialBearingProcess(page, expect, pane) {
  const row = pane.getByRole('button', { name: /sh -c/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('process-inspector')).toBeVisible({ timeout: 15_000 });
  return captureInspector(page);
}

async function captureInspector(page) {
  return page.evaluate(() => {
    const text = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.textContent || '' : '';
    };
    const order = Array.from(document.querySelectorAll('[data-testid="process-inspector"] h4'))
      .map((heading) => heading.textContent || '');
    return {
      command: text('[data-testid="process-command"]'),
      headings: order,
      cpu: text('[data-testid="process-metric-cpu"]'),
      rss: text('[data-testid="process-metric-rss"]'),
      threads: text('[data-testid="process-metric-threads"]'),
      elapsed: text('[data-testid="process-metric-elapsed"]'),
      read: text('[data-testid="process-metric-read"]'),
      write: text('[data-testid="process-metric-write"]'),
      agentText: text('[data-testid="agent-processes"]'),
    };
  });
}

/** The selected-PID vs PPID-descendant resource scope (#2514 SC-09). */
async function subtreeScope(page, expect) {
  await page.getByRole('button', { name: 'With descendants' }).click();
  const scopeText = await page.getByTestId('process-inspector').innerText();
  const count = scopeText.match(/(\d+) processes · includes PID (\d+)/);
  if (!count) {
    throw new Error('subtree scope did not state its membership: ' + scopeText);
  }
  return {
    processes: Number(count[1]),
    selectedPid: Number(count[2]),
    cpu: await page.getByTestId('process-metric-cpu').innerText(),
    rss: await page.getByTestId('process-metric-rss').innerText(),
    read: await page.getByTestId('process-metric-read').innerText(),
    elapsed: await page.getByTestId('process-metric-elapsed').innerText(),
    command: await page.getByTestId('process-command').innerText(),
  };
}

/** Copy through the visible affordance and read what the browser received. */
async function copySanitizedCommand(page, expect) {
  await page.getByRole('button', { name: /Copy command/i }).click();
  let copied = '';
  await expect.poll(
    async () => {
      copied = await page.evaluate(() => navigator.clipboard.readText());
      return copied;
    },
    { timeout: 10_000 },
  ).toContain('[REDACTED]');
  return copied;
}

/** Command-first detail and resource semantics at a phone width. */
async function mobileLayout(page, expect, options = {}) {
  await page.setViewportSize({ width: 390, height: 844 });

  // A narrow viewport is the App experience, which starts on Terminal. Enter
  // its Workspace layer and re-establish the same selected process before
  // measuring the layout.
  if ((await page.getByTestId('agent-processes').count()) === 0) {
    await page.getByTestId('app-header-workspace').click();
    // Wait for the App Workspace capability row before asking for Agent.
    await expect(page.getByTestId('workspace-tool-agent')).toBeVisible({ timeout: 30_000 });
    if ((await page.getByTestId('agent-processes').count()) === 0) {
      await page.getByTestId('workspace-tool-agent').click();
    }
    await expect(page.getByTestId('agent-processes')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="process-pane-"]').first()).toBeVisible({
      timeout: 60_000,
    });
  }
  if ((await page.getByTestId('process-inspector').count()) === 0) {
    const pane = page.locator('[data-testid^="process-pane-"]').first();
    const refresh = page.getByRole('button', { name: 'Refresh process snapshot' });
    if (options.rowText) {
      await expect.poll(async () => {
        const text = await pane.innerText();
        if (text.includes(options.rowText)) {
          return true;
        }
        if (await refresh.isEnabled()) {
          await refresh.click();
        }
        return false;
      }, { timeout: 90_000, intervals: [1_500] }).toBe(true);
    }
    const row = options.rowText
      ? pane.getByRole('button', { name: new RegExp(options.rowText) }).first()
      : pane.getByRole('button').first();
    await row.click();
  }
  await expect(page.getByTestId('process-inspector')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('process-inspector').scrollIntoViewIfNeeded();
  return page.evaluate(() => {
    const command = document.querySelector('[data-testid="process-command"]');
    const inspector = document.querySelector('[data-testid="process-inspector"]');
    const commandBox = command ? command.getBoundingClientRect() : null;
    const inspectorBox = inspector ? inspector.getBoundingClientRect() : null;
    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      commandWidth: commandBox ? commandBox.width : 0,
      commandHeight: commandBox ? commandBox.height : 0,
      inspectorWidth: inspectorBox ? inspectorBox.width : 0,
      commandText: command ? command.textContent || '' : '',
      visible: Boolean(commandBox && commandBox.width > 0 && commandBox.height > 0 &&
        inspectorBox && inspectorBox.width > 0),
    };
  });
}

/** Return to Terminal and prove the Session still echoes after discovery. */
async function terminalContinuity(page, expect) {
  await page.getByTestId('surface-action-open-terminal').click();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const element = document.querySelector('.xterm');
    element.parentElement.xtermInstance.input('echo nession-2514-terminal-continuity\n', true);
  });
  await expect.poll(
    async () => page.evaluate(() => {
      const element = document.querySelector('.xterm');
      const term = element && element.parentElement && element.parentElement.xtermInstance;
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
    }),
    { timeout: 20_000 },
  ).toContain('nession-2514-terminal-continuity');
}

module.exports = {
  SECRET,
  TYPED_COMMAND,
  captureInspector,
  copySanitizedCommand,
  inspectCredentialBearingProcess,
  inspectRoot,
  mobileLayout,
  openAgentProcesses,
  subtreeScope,
  terminalContinuity,
};
