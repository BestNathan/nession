'use strict';
// #2514 SC-06 (browser half): the existing Agent capability opens a compact,
// current-Session-only view with no Session/Pane navigation. Agent details and
// Process details are default-closed, keyboard-operable disclosures; the
// inspector keeps command/resources visible, the disclosure survives a resource
// scope change and resets on another PID, and the App/narrow layout pushes a
// process detail with a Back that restores the process list.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const {
  closeAgentDetails,
  inspectRoot,
  mobileLayout,
  openAgentDetails,
  openAgentProcesses,
  returnToTerminalAndBack,
  selectRowContaining,
  setProcessDetails,
} = require('../../../shared/process-discovery-browser.js');

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-06: Agent Workspace shows the current Session forest with grouped disclosures', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const opened = await openAgentProcesses(page, expect, runtime, sha);

  // The existing Agent capability is the entry; no Process capability appeared.
  await expect(page.getByTestId('agent-detail')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-process')).toHaveCount(0);
  await expect(page.getByTestId('workspace-tool-agent')).toHaveAttribute('aria-pressed', 'true');

  // Current-Session-only: the Session is identified, but never offered as a
  // selector, and there is no Pane/Window product grouping.
  await expect(page.getByTestId('agent-process-session')).toContainText(opened.sessionName);
  await expect(page.getByTestId('agent-process-session-selector')).toHaveCount(0);
  await expect(page.locator('[data-testid^="process-pane-"]')).toHaveCount(0);
  await expect(opened.tree).toBeVisible();

  // Session-level method/coverage is stated, not implied.
  await expect(page.getByTestId('agent-processes')).toContainText(
    /Process tree|Dedicated cgroup/,
  );
  await expect(page.getByTestId('agent-processes')).toContainText(
    /Partial|Complete|Unavailable/,
  );
  await expect(page.getByTestId('agent-process-diagnostics')).toContainText('Limits');

  // Agent details is collapsed by default and keyboard-operable.
  const details = await openAgentDetails(page, expect);
  await closeAgentDetails(page, expect, details.details);

  // The command is first; identity/discovery evidence is optional.
  const selected = await inspectRoot(page, expect, opened.tree);
  expect(selected.command.length).toBeGreaterThan(0);
  expect(selected.headings[0]).toBe('Executed command');
  await expect(page.getByTestId('process-details')).toHaveJSProperty('open', false);
  await setProcessDetails(page, expect, true);

  // Same PID scope change keeps the disclosure; a different PID resets it.
  await page.getByRole('button', { name: 'With descendants' }).click();
  await expect(page.getByTestId('process-details')).toHaveJSProperty('open', true);
  await selectRowContaining(opened.tree, '--token');
  await expect(page.getByTestId('process-details')).toHaveJSProperty('open', false);

  // Returning to Terminal and back does not lose the current Session.
  await returnToTerminalAndBack(page, expect, opened.sessionName);

  const mobile = await mobileLayout(page, expect, {
    rowText: '--token',
    sessionName: opened.sessionName,
  });
  expect(mobile.visible, 'command and resource blocks stay readable on mobile').toBe(true);
  expect(mobile.documentScrollWidth).toBeLessThanOrEqual(mobile.viewportWidth + 1);
  expect(mobile.commandWidth).toBeLessThanOrEqual(mobile.viewportWidth);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Agent Workspace showed current Session ' + opened.sessionName +
      ' with one process forest and no Session selector or Pane grouping; Agent details was closed ' +
      'by default and opened from the keyboard into Identity/connection, Runtime and Capability groups; ' +
      'Process details stayed closed by default, survived a resource-scope change and reset on another PID; ' +
      'returning to Terminal and back kept the Session, and at 390px the pushed detail had a Back to the ' +
      'process list with no horizontal overflow',
  });
});
