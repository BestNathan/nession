'use strict';
// #2514 SC-06 (browser half): the existing Agent capability opens a
// context-first view; Session → Pane → process drill-down preserves focus,
// discloses coverage/fallback evidence, adds no permanent Process chrome, and
// stays usable at a phone width.
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const {
  inspectRoot,
  mobileLayout,
  openAgentProcesses,
  returnToTerminalAndBack,
} = require('../../../shared/process-discovery-browser.js');

test.use({ viewport: { width: 1440, height: 900 } });

test('SC-06: Agent Workspace drills into Sessions and Panes without permanent chrome', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = JSON.parse(fs.readFileSync(process.env.NESSION_ACCEPTANCE_RUNTIME_FILE, 'utf8'));
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  const opened = await openAgentProcesses(page, expect, runtime, sha);

  // The existing Agent capability is the entry; no Process capability appeared.
  await expect(page.getByTestId('agent-detail')).toBeVisible();
  await expect(page.getByTestId('workspace-tool-process')).toHaveCount(0);
  await expect(page.getByTestId('workspace-tool-agent')).toHaveAttribute('aria-pressed', 'true');

  // Session focus: the Session the Workspace was opened from is selected.
  const selectedSession = page
    .getByTestId('agent-process-session-selector')
    .getByRole('button', { name: opened.sessionName });
  await expect(selectedSession).toHaveAttribute('aria-pressed', 'true');

  // Pane drill-down states a method and an honest coverage; a Linux runner
  // without a systemd tmux scope shows the process-tree fallback reason.
  // The method label belongs to the snapshot header, not the Pane section.
  await expect(page.getByTestId('agent-processes')).toContainText(
    /Process tree|Dedicated cgroup/,
  );
  await expect(opened.pane).toContainText(/Partial|Complete|Unavailable/);
  await expect(page.getByTestId('agent-process-diagnostics')).toContainText('Limits');

  const inspector = await inspectRoot(page, expect, opened.pane);
  expect(inspector.command.length).toBeGreaterThan(0);
  expect(inspector.headings[0]).toBe('Executed command');

  // Returning to Terminal and back does not lose the Session focus.
  await returnToTerminalAndBack(page, expect, opened.sessionName);

  const mobile = await mobileLayout(page, expect);
  expect(mobile.visible, 'command and resource blocks stay readable on mobile').toBe(true);
  expect(mobile.documentScrollWidth).toBeLessThanOrEqual(mobile.viewportWidth + 1);
  expect(mobile.commandWidth).toBeLessThanOrEqual(mobile.viewportWidth);

  testInfo.annotations.push({
    type: 'evidence',
    description:
      'exact SHA ' + sha + ': the Agent Workspace showed Session ' + opened.sessionName +
      ' selected, its Panes with method/coverage/fallback reasons, and a command-first inspector; ' +
      'there was no process capability in the Workspace chrome; returning to Terminal and back kept ' +
      'the Session selected; at 390px the command block stayed inside the viewport with no horizontal document overflow',
  });
});
