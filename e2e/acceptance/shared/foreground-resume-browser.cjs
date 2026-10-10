'use strict';
// Source-aligned browser helpers for #1213 post-merge Cases. The browser,
// Server, Agent and tmux all come from the exact target-SHA full-stack runner.
const fs = require('node:fs');

function verifiedRuntime(criterion) {
  if (process.env.NESSION_ACCEPTANCE_CRITERION !== criterion) {
    throw new Error('unexpected Acceptance criterion');
  }
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('exact target SHA is required');
  const contract = String(process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256 || '');
  if (!/^[0-9a-f]{64}$/.test(contract)) throw new Error('trusted Issue contract digest is required');
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  if (runtime.target_sha !== sha || runtime.profile !== 'full-stack-local' ||
      !Number.isInteger(runtime.server_port) || runtime.server_port <= 0) {
    throw new Error('real full-stack runtime must match the exact target SHA');
  }
  return { runtime, sha, contract };
}

async function readBuffer(page) {
  return page.evaluate(() => {
    const terminal = document.querySelector('.xterm')?.parentElement?.xtermInstance;
    if (!terminal) return '';
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString());
    }
    return lines.join('\n');
  });
}

async function countInBuffer(page, needle) {
  return (await readBuffer(page)).split(needle).length - 1;
}

async function command(page, text) {
  await page.evaluate(value => {
    const terminal = document.querySelector('.xterm')?.parentElement?.xtermInstance;
    if (!terminal) throw new Error('xterm not attached');
    terminal.input(value + '\n', true);
  }, text);
}

async function createAndAttach(page, expect, runtime, prefix) {
  const wsUrl = 'ws://127.0.0.1:' + runtime.server_port + '/ws';
  await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent(wsUrl));
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 25000 });
  const name = prefix + '-' + Date.now();
  const create = page.getByTestId('create-session');
  await expect(create).toBeEnabled({ timeout: 25000 });
  await create.click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#name').fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const attachOnCreate = page.getByRole('dialog').filter({ hasText: 'Attach' });
  await expect(attachOnCreate).toBeVisible({ timeout: 15000 });
  await attachOnCreate.getByRole('button', { name: 'Cancel' }).click();
  const row = page.locator('[data-testid="session-item-row"]', { hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();
  dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^Relay\b/ }).click();
  const attach = dialog.getByRole('button', { name: 'Attach' });
  await expect(attach).toBeEnabled({ timeout: 15000 });
  await attach.click();
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30000 });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({ timeout: 30000 });
  await expect.poll(async () => /runner:\S*\$/m.test(await readBuffer(page)), { timeout: 30000 }).toBe(true);
  await expect(page.locator('.xterm')).toHaveCount(1);
  await page.locator('.xterm').evaluate(el => el.setAttribute('data-1213-case-instance', 'original'));
  return { name, wsUrl };
}

async function assertTerminalContinuous(page, expect, before, after) {
  await expect(page.getByTestId('shell')).toBeVisible();
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.xterm')).toHaveAttribute('data-1213-case-instance', 'original');
  // Unique rendered markers use shell expansion, so the echoed *typed* command
  // cannot satisfy the assertions before the tty produces actual output.
  await command(page, "printf '" + after + "-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, after + '-1213'), { timeout: 30000 }).toBe(1);
  expect(await countInBuffer(page, before + '-1213')).toBe(1);
}

module.exports = { verifiedRuntime, createAndAttach, command, countInBuffer, assertTerminalContinuous };
