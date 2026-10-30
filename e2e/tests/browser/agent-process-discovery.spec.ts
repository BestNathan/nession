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
 * Real full-stack regression: a typed child process must appear in the Agent
 * Workspace's read-only snapshot, the inspector must put the sanitized command
 * before resources, the subtree scope must not change that command, and the
 * Terminal must keep working — discovery is an observation, not a runtime
 * mutation.
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
    // before the browser ever holds the string.
    await submitTerminalCommand(page, `sh -c 'sleep 30' --token ${secret} &`);

    await page.getByTestId('surface-action-open-workspace').click();
    await expect(page.getByTestId('workspace-shell')).toBeVisible();
    await page.getByTestId('workspace-tool-agent').click();
    await expect(page.getByTestId('agent-processes')).toBeVisible({ timeout: 30_000 });

    // The Workspace keeps the Session it was opened from selected.
    await expect(
      page.getByTestId('agent-process-session-selector').getByRole('button', { name: sessionName }),
    ).toHaveAttribute('aria-pressed', 'true');

    // No permanent process chrome appeared in the capability row.
    await expect(page.getByTestId('workspace-tool-process')).toHaveCount(0);

    const pane = page.locator('[data-testid^="process-pane-"]').first();
    await expect(pane).toBeVisible({ timeout: 60_000 });
    // The child starts after the first snapshot; refresh the read-only
    // observation until it is present.
    const refresh = page.getByRole('button', { name: 'Refresh process snapshot' });
    await expect
      .poll(
        async () => {
          const text = await pane.innerText();
          if (text.includes('sleep 30')) {
            return true;
          }
          if (await refresh.isEnabled()) {
            await refresh.click();
          }
          return false;
        },
        { timeout: 90_000, intervals: [1_500] },
      )
      .toBe(true);

    // Pane coverage is stated, not implied.
    await expect(pane).toContainText(/Process tree|Dedicated cgroup/);
    await expect(pane).toContainText(/Partial|Complete/);

    // Select the credential-bearing process: command first, raw secret absent.
    await pane.getByRole('button', { name: /sh -c/ }).first().click();
    const inspector = page.getByTestId('process-inspector');
    await expect(inspector).toBeVisible();
    const command = page.getByTestId('process-command');
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

    // The resource scope changes only the metric set, never the command.
    await pane.getByRole('button').first().click();
    const rootCommand = await page.getByTestId('process-command').innerText();
    await page.getByRole('button', { name: 'With descendants' }).click();
    await expect(page.getByTestId('process-command')).toHaveText(rootCommand);
    await expect(inspector).toContainText(/includes PID \d+/);
    await expect(page.getByTestId('process-metric-elapsed')).toContainText('Elapsed (selected process)');

    // Mobile: command and resources stay inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(inspector).toBeVisible();
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

    // Discovery is read-only: Terminal input still reaches the Pane.
    await page.getByTestId('surface-action-open-terminal').click();
    await expect(page.locator('.xterm')).toBeVisible();
    await submitTerminalCommand(page, 'echo nession-2514-terminal-continuity');
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 20_000 })
      .toContain('nession-2514-terminal-continuity');
  });
});
