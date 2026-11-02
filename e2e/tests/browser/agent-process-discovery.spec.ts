import { test, expect } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';
import {
  attachToSession,
  createSession,
  readTerminalBuffer,
  submitTerminalCommand,
  waitForInteractiveShell,
} from '../../helpers/terminalRegression';

/**
 * Agent Workspace process discovery (#2514).
 *
 * Real full-stack regression: a typed child process must appear in the current
 * Session's read-only forest, the inspector must put the sanitized command
 * before resources, the two disclosures must be default-closed and grouped,
 * the subtree scope must not change the command, and the Terminal must keep
 * working — discovery is an observation, not a runtime mutation.
 *
 * CI-gated like session-lifecycle.spec.ts: these drive a real tmux-backed
 * agent, which the local e2e webServer stack only provides in CI.
 */
test.describe('Agent process discovery', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test.beforeEach(async ({ page }) => {
    await page.goto('/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws'));
    await waitForShell(page);
  });

  test('drills from the Agent Workspace to a command-first process inspector', async ({ page }, testInfo) => {
    test.skip(!process.env.CI, 'runs in CI only');
    test.setTimeout(240_000);

    const sessionName = `e2e-process-discovery-${testInfo.retry}-${Date.now()}`;
    const secret = `e2e-2514-secret-${Date.now()}`;
    await createSession(page, sessionName);
    await attachToSession(page, sessionName, 'Relay');
    await waitForInteractiveShell(page);

    // A real child with a credential-shaped flag: sanitization must happen
    // before the browser ever holds the string. The compound command keeps the
    // `sh` process alive so its argv is still observable while `sleep` runs.
    await submitTerminalCommand(page, `sh -c 'sleep 120; :' --token ${secret} &`);

    await page.getByTestId('surface-action-open-workspace').click();
    await expect(page.getByTestId('workspace-shell')).toBeVisible();
    await page.getByTestId('workspace-tool-agent').click();
    await expect(page.getByTestId('agent-processes')).toBeVisible({ timeout: 30_000 });

    // Current-Session-only: the Session is identified, never offered as a
    // selector, and there is no Pane/Window grouping in the product UI.
    await expect(page.getByTestId('agent-process-session')).toContainText(sessionName);
    await expect(page.getByTestId('agent-process-session-selector')).toHaveCount(0);
    await expect(page.locator('[data-testid^="process-pane-"]')).toHaveCount(0);
    await expect(page.getByTestId('workspace-tool-process')).toHaveCount(0);

    const tree = page.getByTestId('process-forest');
    // Surface a snapshot refusal instead of waiting out the pane timeout with
    // no diagnosis.
    await expect
      .poll(
        async () => {
          const errorState = page.getByTestId('agent-processes-error');
          if ((await errorState.count()) > 0) {
            throw new Error('process snapshot failed: ' + (await errorState.innerText()));
          }
          return tree.count();
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBeGreaterThan(0);
    // The child starts after the first snapshot; refresh the read-only
    // observation until it is present.
    const refresh = page.getByRole('button', { name: 'Refresh process snapshot' });
    await expect
      .poll(
        async () => {
          const text = await tree.innerText();
          if (text.includes('--token')) {
            return true;
          }
          if (await refresh.isEnabled()) {
            await refresh.click();
          }
          return false;
        },
        { timeout: 45_000, intervals: [1_000] },
      )
      .toBe(true);

    // Pane coverage is stated as Session coverage, not implied per Pane.
    await expect(page.getByTestId('agent-processes')).toContainText(
      /Process tree|Dedicated cgroup/,
    );
    await expect(page.getByTestId('agent-processes')).toContainText(/Partial|Complete/);

    // Agent details is collapsed by default and keyboard-operable.
    const agentDetails = page.getByTestId('agent-details');
    await expect(agentDetails).toHaveJSProperty('open', false);
    await agentDetails.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(agentDetails).toHaveJSProperty('open', true);
    const detailsContent = page.getByTestId('agent-details-content');
    await expect(detailsContent.getByText('Identity & connection', { exact: true })).toBeVisible();
    await expect(detailsContent.getByText('Runtime environment', { exact: true })).toBeVisible();
    await expect(detailsContent.getByText('Capability & discovery', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(agentDetails).toHaveJSProperty('open', false);

    // Select the credential-bearing process by its displayed command, not by
    // an accessible-name regex: the row also carries badges and a PID.
    const rows = tree.getByRole('button');
    const rowCount = await rows.count();
    let selectedCredentialRow = false;
    for (let index = 0; index < rowCount; index += 1) {
      const text = (await rows.nth(index).textContent()) ?? '';
      if (text.includes('--token')) {
        await rows.nth(index).click();
        selectedCredentialRow = true;
        break;
      }
    }
    expect(selectedCredentialRow, 'a credential-bearing process row exists').toBe(true);
    const inspector = page.getByTestId('process-inspector');
    await expect(inspector).toBeVisible();
    const command = page.getByTestId('process-command');
    await expect(command).toContainText('--token');
    await expect(command).toContainText('--token [REDACTED]');
    await expect(inspector).not.toContainText(secret);
    await expect(page.getByTestId('agent-processes')).not.toContainText(secret);

    // Resources follow the command and label their units.
    await expect(page.getByTestId('process-metric-cpu')).toContainText('CPU (% of one CPU)');
    await expect(page.getByTestId('process-metric-rss')).toContainText('RSS (MiB)');
    await expect(page.getByTestId('process-metric-read')).toContainText('Read I/O (KiB/s)');

    // Copy carries exactly the sanitized display string.
    await page.getByRole('button', { name: /Copy command/i }).click();
    let copied = '';
    await expect
      .poll(async () => {
        copied = await page.evaluate(() => navigator.clipboard.readText());
        return copied;
      })
      .toContain('--token [REDACTED]');
    expect(copied).not.toContain(secret);

    // Process details is default-closed, grouped, and survives a resource
    // scope change for the same PID.
    await expect(page.getByTestId('process-details')).toHaveJSProperty('open', false);
    await page.getByTestId('process-details').getByText('Process details', { exact: true }).click();
    await expect(page.getByTestId('process-details')).toHaveJSProperty('open', true);
    await expect(page.getByTestId('process-details-content')).toContainText('Process identity');
    await expect(page.getByTestId('process-details-content')).toContainText('Discovery evidence');
    await page.getByRole('button', { name: 'With descendants' }).click();
    await expect(page.getByTestId('process-details')).toHaveJSProperty('open', true);

    // Selecting another PID resets the optional details; only the metrics
    // scope was ever allowed to change the command.
    await rows.first().click();
    await expect(page.getByTestId('process-details')).toHaveJSProperty('open', false);
    const rootCommand = await page.getByTestId('process-command').innerText();
    await page.getByRole('button', { name: 'With descendants' }).click();
    await expect(page.getByTestId('process-command')).toHaveText(rootCommand);
    await expect(inspector).toContainText(/includes PID \d+/);
    await expect(page.getByTestId('process-metric-elapsed')).toContainText('Elapsed (selected process)');

    // Discovery is read-only: Terminal input still reaches the Pane.
    await page.getByTestId('surface-action-open-terminal').click();
    await expect(page.locator('.xterm')).toBeVisible();
    await submitTerminalCommand(page, 'echo nession-2514-terminal-continuity');
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 20_000 })
      .toContain('nession-2514-terminal-continuity');

    // Mobile: the same current-Session view, with a pushed process detail and
    // a Back to the process list instead of a Session/Pane picker.
    await page.setViewportSize({ width: 390, height: 844 });
    const processesVisible = await page
      .getByTestId('agent-processes')
      .isVisible()
      .catch(() => false);
    if (!processesVisible) {
      await page.getByTestId('app-header-workspace').click();
      await expect(page.getByTestId('workspace-tool-agent')).toBeVisible({ timeout: 30_000 });
      const agentVisible = await page
        .getByTestId('agent-processes')
        .isVisible()
        .catch(() => false);
      if (!agentVisible) {
        await page.getByTestId('workspace-tool-agent').click();
      }
      await expect(page.getByTestId('agent-processes')).toBeVisible({ timeout: 30_000 });
    }
    await expect(page.getByTestId('agent-process-session')).toContainText(sessionName);
    await expect(page.getByTestId('agent-process-session-selector')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const errorState = page.getByTestId('agent-processes-error');
          if ((await errorState.count()) > 0) {
            throw new Error('mobile process snapshot failed: ' + (await errorState.innerText()));
          }
          return page.getByTestId('process-forest').count();
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(0);
    const narrowTree = page.getByTestId('process-forest');
    if (!(await page.getByTestId('process-inspector').isVisible().catch(() => false))) {
      await narrowTree.getByRole('button').first().click();
    }
    await expect(inspector).toBeVisible();
    await inspector.scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const commandBlock = document.querySelector('[data-testid="process-command"]');
      const box = commandBlock ? commandBlock.getBoundingClientRect() : null;
      return {
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        commandWidth: box ? box.width : 0,
      };
    });
    expect(layout.commandWidth).toBeGreaterThan(0);
    expect(layout.commandWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport + 1);

    await page.getByRole('button', { name: 'Back to processes' }).click();
    await expect(page.getByTestId('process-forest')).toBeVisible();
    await expect(page.getByTestId('process-inspector')).toHaveCount(0);
  });
});
