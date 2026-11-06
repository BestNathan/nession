'use strict';
// #2803 SC-03: the Web fixture's Agent capability starts on agent-a:dev, then
// moves to agent-b:dev — the same Session name on another Agent — without
// remounting. Agent A's sanitized process row and inspector must never appear
// under B; B offline/error/pending are truthful states; the selected process
// resets on the identity change; and returning to A recovers A's own snapshot.
const { test, expect } = require('@playwright/test');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

const A_COMMAND = 'agent-a-worker --task alpha --auth [REDACTED]';
const B_COMMAND = 'agent-b-worker --task beta --auth [REDACTED]';
const B_ERROR = 'agent-b process discovery failed: permission denied';

function row(page, command) {
  return page.getByTestId('process-forest').getByText(command, { exact: true });
}

test('SC-03: the same-name switch keeps Agent A out of Agent B in offline and error states', async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- Agent B offline ----
  await page.goto('/#/fixture/workspace?capability=agent&agentProcesses=offline');
  await expect(page.getByTestId('agent-detail')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('agent-process-session')).toContainText('dev');
  await expect(row(page, A_COMMAND)).toBeVisible();

  // A is the selected process; the switch must reset that observation too.
  await row(page, A_COMMAND).click();
  await expect(page.getByTestId('process-command')).toContainText(A_COMMAND);

  await page.evaluate(() => window.fixtureAgentProcesses.select('agent-b:dev'));
  await expect(page.getByTestId('agent-processes-offline')).toBeVisible();
  await expect(page.getByTestId('agent-detail').getByRole('heading', { name: 'agent-b', exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-process-session')).toContainText('dev');
  await expect(page.getByText(A_COMMAND)).toHaveCount(0);
  await expect(page.getByTestId('process-forest')).toHaveCount(0);
  await expect(page.getByTestId('process-inspector')).toHaveCount(0);
  await expect(page.getByTestId('agent-processes-error')).not.toContainText('Showing the last snapshot');

  // ---- Agent B rejecting ----
  await page.goto('/#/fixture/workspace?capability=agent&agentProcesses=error');
  await expect(page.getByTestId('agent-detail')).toBeVisible({ timeout: 20_000 });
  await expect(row(page, A_COMMAND)).toBeVisible();
  await page.evaluate(() => window.fixtureAgentProcesses.select('agent-b:dev'));

  const error = page.getByTestId('agent-processes-error');
  await expect(error).toContainText(B_ERROR);
  // The failure belongs to B; A's snapshot is not offered as B's last-known data.
  await expect(error).not.toContainText('Showing the last snapshot');
  await expect(page.getByText(A_COMMAND)).toHaveCount(0);
  await expect(page.getByTestId('process-forest')).toHaveCount(0);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900: agent-a:dev was sampled and its process ' +
      'selected, then the mounted Agent capability moved to agent-b:dev (same name); ' +
      'offline showed the Agent-B identity with no A rows, inspector or snapshot header, ' +
      'and a rejecting read showed B\'s own error without offering A\'s snapshot as stale',
  });
});

test('SC-03: pending, release, recovery and the narrow selection reset stay on the current Session', async ({ page }, testInfo) => {
  test.setTimeout(110_000);
  const { sha } = verifiedRuntime('SC-03');
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---- Agent B pending, then released ----
  await page.goto('/#/fixture/workspace?capability=agent&agentProcesses=pending');
  await expect(page.getByTestId('agent-detail')).toBeVisible({ timeout: 20_000 });
  await expect(row(page, A_COMMAND)).toBeVisible();

  await page.evaluate(() => window.fixtureAgentProcesses.select('agent-b:dev'));
  // B is in flight: a truthful loading state, not A's rows under B's identity.
  await expect(page.getByTestId('agent-processes-snapshot-loading')).toBeVisible();
  await expect(page.getByText(A_COMMAND)).toHaveCount(0);
  await expect(page.getByTestId('agent-processes-error')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureAgentProcesses.betaRequests())).toBe(1);

  await page.evaluate(() => window.fixtureAgentProcesses.releasePending());
  await expect(row(page, B_COMMAND)).toBeVisible();
  await expect(page.getByText(A_COMMAND)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fixtureAgentProcesses.pendingSettled())).toBe(true);
  // One read on demand; no polling.
  expect(await page.evaluate(() => window.fixtureAgentProcesses.betaRequests())).toBe(1);

  // Returning to A is a new observation of A's own full Session id.
  await page.evaluate(() => window.fixtureAgentProcesses.select('agent-a:dev'));
  await expect(row(page, A_COMMAND)).toBeVisible();
  await expect(page.getByText(B_COMMAND)).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureAgentProcesses.selected())).toBe('agent-a:dev');

  // ---- Narrow (App-like) width: the pushed selection resets with the switch ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/fixture/workspace?capability=agent&agentProcesses=offline');
  await expect(page.getByTestId('agent-detail')).toBeVisible({ timeout: 20_000 });
  await expect(row(page, A_COMMAND)).toBeVisible();
  await row(page, A_COMMAND).click();
  await expect(page.getByTestId('process-inspector')).toBeVisible();

  await page.evaluate(() => window.fixtureAgentProcesses.select('agent-b:dev'));
  await expect(page.getByTestId('agent-processes-offline')).toBeVisible();
  await expect(page.getByTestId('process-inspector')).toHaveCount(0);
  await expect(page.getByText(A_COMMAND)).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(overflow, 'the same-name switch does not force horizontal overflow').toBe(true);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ' at 1440x900 and 390x844: agent-b:dev stayed pending on ' +
      'exactly one on-demand read with a loading state and no A rows, then resolved to ' +
      'B\'s own sanitized command with no polling; returning to agent-a:dev recovered A\'s ' +
      'snapshot, and at 390px selecting A then switching to offline B reset the pushed ' +
      'detail with no A content and no horizontal overflow',
  });
});
