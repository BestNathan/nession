import { expect, test, type Page } from '@playwright/test';
import { waitForShell } from '../../helpers/shell';

const APP_URL =
  '/?token=e2e-test-token&server_url=' + encodeURIComponent('ws://localhost:19090/ws');
const FAST_AGENT_URL = 'ws://127.0.0.1:19091/ws';
const STALLED_AGENT_URL = 'ws://127.0.0.1:19092/ws';

/**
 * Browser-side evidence for #1430.
 *
 * The dialog starts one real background latency probe per advertised address.
 * The second candidate below is replaced with a CONNECTING-only WebSocket so
 * its probe cannot finish before addressSelection.ts's 3s deadline.
 *
 * A latency probe never calls WebSocket.send(). The real P2P transport does:
 * its first frame is the client.auth handshake. Recording the first send on the
 * FAST candidate therefore distinguishes "a probe dial happened" from "the
 * actual attach transport started".
 */
interface CriticalPathEvidence {
  slowProbeStartedAt: number | null;
  markAt: number | null;
  firstRealSendAfterMark: number | null;
}

declare global {
  interface Window {
    __nession1430?: CriticalPathEvidence;
  }
}

async function installCriticalPathInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(
    ({ fastUrl, stalledUrl }) => {
      const NativeWebSocket = window.WebSocket;
      const evidence: CriticalPathEvidence = {
        slowProbeStartedAt: null,
        markAt: null,
        firstRealSendAfterMark: null,
      };
      window.__nession1430 = evidence;

      const WrappedWebSocket = new Proxy(NativeWebSocket, {
        construct(Target, args) {
          const url = String(args[0]);

          if (url.startsWith(stalledUrl)) {
            evidence.slowProbeStartedAt ??= performance.now();

            // measureLatency() only assigns onopen/onerror/onclose, reads
            // readyState, and calls close(). Keeping this object CONNECTING makes
            // the browser-side probe resolve only through its own 3s timeout.
            return {
              url,
              readyState: Target.CONNECTING,
              onopen: null,
              onerror: null,
              onclose: null,
              close() {},
            } as unknown as WebSocket;
          }

          const socket = Reflect.construct(Target, args) as WebSocket;
          if (url.startsWith(fastUrl)) {
            const send = socket.send.bind(socket);
            socket.send = ((data: Parameters<WebSocket['send']>[0]) => {
              if (
                evidence.markAt !== null &&
                evidence.firstRealSendAfterMark === null
              ) {
                evidence.firstRealSendAfterMark = performance.now();
              }
              send(data);
            }) as WebSocket['send'];
          }
          return socket;
        },
      });

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        writable: true,
        value: WrappedWebSocket,
      });
    },
    { fastUrl: FAST_AGENT_URL, stalledUrl: STALLED_AGENT_URL },
  );
}

async function readTerminalBuffer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const xtermEl = document.querySelector('.xterm');
    const container = xtermEl?.parentElement;
    const term = (container as Record<string, unknown>)?.xtermInstance as
      | {
          buffer: {
            active: {
              length: number;
              getLine(y: number):
                | { translateToString(): string }
                | undefined;
            };
          };
        }
      | undefined;
    if (!term) {
      return '';
    }
    const lines: string[] = [];
    for (let i = 0; i < term.buffer.active.length; i += 1) {
      const line = term.buffer.active.getLine(i);
      if (line) {
        lines.push(line.translateToString());
      }
    }
    return lines.join('\n');
  });
}

async function waitForInteractiveShell(page: Page): Promise<void> {
  await page.locator('.xterm').waitFor({ state: 'visible', timeout: 20_000 });
  await expect(page.getByTestId('terminal-connecting')).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.getByTestId('terminal-loading')).toBeHidden({
    timeout: 30_000,
  });
  await expect
    .poll(async () => readTerminalBuffer(page), { timeout: 30_000 })
    .toMatch(/runner:\S*\$/m);
}

async function submitTerminalCommand(page: Page, command: string): Promise<void> {
  await page.evaluate((data) => {
    const xtermEl = document.querySelector('.xterm');
    const term = (xtermEl?.parentElement as
      | { xtermInstance?: { input(data: string, wasUserInput: boolean): void } }
      | null)?.xtermInstance;
    if (!term) {
      throw new Error('xtermInstance not mounted');
    }
    term.input(data, true);
  }, `${command}\n`);
}

test.describe('Attach critical path (#1430)', () => {
  test('fresh create starts real P2P attach before a sibling probe can time out', async ({
    page,
  }, testInfo) => {
    test.skip(!process.env.CI, 'real tmux/agent stack runs in CI');
    test.setTimeout(90_000);

    await installCriticalPathInstrumentation(page);
    await page.goto(APP_URL);
    await waitForShell(page);

    const createButton = page.getByTestId('create-session');
    await expect(createButton).toBeEnabled({ timeout: 60_000 });
    await createButton.click();

    const createDialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Create Session' });
    await expect(createDialog).toBeVisible();

    const sessionName = `e2e-attach-critical-path-${testInfo.retry}-${Date.now()}`;
    await page.locator('#name').fill(sessionName);
    await createDialog.getByRole('button', { name: 'Create' }).click();
    await expect(createDialog).not.toBeVisible({ timeout: 10_000 });

    // A create ACK selects the fresh Session and opens its ordinary Attach
    // dialog. Auto requests P2P attach info and starts the background browser
    // probe immediately.
    const attachDialog = page.getByRole('dialog').filter({ hasText: 'Attach' });
    await expect(attachDialog).toBeVisible({ timeout: 10_000 });
    const attachButton = attachDialog.getByRole('button', { name: 'Attach' });
    await expect(attachButton).toBeEnabled({ timeout: 10_000 });

    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__nession1430?.slowProbeStartedAt ?? null,
          ),
        { timeout: 10_000, intervals: [50] },
      )
      .not.toBeNull();

    // Mark immediately before confirm. The stalled candidate's measurement is
    // still pending. Before #1430, useAddressPlan/testAddresses introduced a
    // second all-candidate Promise.all barrier here; the real P2P transport
    // could not send anything until that ~3s timeout completed.
    await page.evaluate(() => {
      const evidence = window.__nession1430;
      if (!evidence) {
        throw new Error('#1430 instrumentation missing');
      }
      evidence.markAt = performance.now();
      evidence.firstRealSendAfterMark = null;
    });

    await attachButton.click();
    await expect(attachDialog).not.toBeVisible({ timeout: 5_000 });

    // Probe sockets never send frames, so this can only be the real P2P
    // WebSocket's auth/attach path. Give it 2s: old behavior is structurally
    // unable to satisfy this while the sibling probe has a 3s deadline.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__nession1430?.firstRealSendAfterMark ?? null,
          ),
        { timeout: 2_000, intervals: [25, 50, 100] },
      )
      .not.toBeNull();

    const timing = await page.evaluate(() => {
      const evidence = window.__nession1430;
      if (
        !evidence ||
        evidence.markAt === null ||
        evidence.firstRealSendAfterMark === null ||
        evidence.slowProbeStartedAt === null
      ) {
        throw new Error('incomplete #1430 timing evidence');
      }
      return {
        probeWasAlreadyPending:
          evidence.slowProbeStartedAt <= evidence.markAt,
        attachStartMs:
          evidence.firstRealSendAfterMark - evidence.markAt,
      };
    });

    expect(timing.probeWasAlreadyPending).toBe(true);
    expect(timing.attachStartMs).toBeLessThan(2_000);

    // The early dial must also become a usable terminal, not merely create a
    // socket. Input round-trip proves the chosen fast candidate owns the real
    // session transport.
    await waitForInteractiveShell(page);
    const marker = `nession-1430-ok-${testInfo.retry}`;
    await submitTerminalCommand(page, `echo ${marker}`);
    await expect
      .poll(async () => readTerminalBuffer(page), { timeout: 15_000 })
      .toContain(marker);
  });
});
