'use strict';
// #3440 SC-07: the browser Session stays mounted across a P2P reconnect and a
// Server outage, using the in-memory Agent Token for its current Agent. A token
// rejection after rotation is recovered through one authenticated attach once
// the Server is back, without a page reload.
//
// The "cannot reuse Token A for Agent B" property is the Agent-side refusal
// proved in SC-01; this Case proves the browser never needs a fresh per-attach
// credential for the ordinary reconnect.
const { test, expect } = require('@playwright/test');
const {
  command,
  countInBuffer,
  createAndAttach,
  verifiedRuntime,
} = require('../../../shared/foreground-resume-browser.cjs');
const {
  authenticateServer,
  openFrames,
  startEndpointStack,
  waitForAgentOnline,
} = require('../../../shared/endpoint-token-cases.cjs');

test.setTimeout(110_000);

const SERVER_TOKEN = 'e2e-test-token';
const TOKEN_A = 'browser-agent-token-3440-aaaa';
const TOKEN_ROTATED = 'browser-agent-token-3440-bbbb';

/**
 * The Server's cached registration token is the value the browser's one
 * refetch will receive. Waiting for it here keeps the rotation episode about
 * the browser's refusal/refetch path, not about a Server that has not yet
 * observed the Agent's re-registration.
 */
async function waitForServerToken(stack, sessionId, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const client = await openFrames(stack.serverUrl);
    try {
      const auth = await authenticateServer(client, SERVER_TOKEN);
      if (auth.status === 'success') {
        const reply = await client.request('server.session.attach', {
          session_id: sessionId,
          preferred_mode: 'p2p',
        }, 20_000);
        last = reply.payload;
        if (last?.status === 'success' && last.agent_token === expected) return last;
      }
    } catch {
      /* the Server is still settling; retry */
    } finally {
      client.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'the Server never cached the expected Agent token; last=' + JSON.stringify(last),
  );
}

test('SC-07: durable Agent token keeps the Session mounted across reconnect and Server outage', async ({ page }) => {
  const { sha } = verifiedRuntime('SC-07');
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    agents: [{ agentId: 'browser-agent', agentToken: TOKEN_A }],
  });
  try {
    await waitForAgentOnline(stack, 'browser-agent');
    await page.addInitScript(() => {
      window.__sc07 = { marker: 'same-document', sockets: [], frames: [], seq: 0 };
      const Original = window.WebSocket;
      window.WebSocket = new Proxy(Original, {
        construct(Target, args) {
          const socket = Reflect.construct(Target, args);
          const entry = { url: String(args[0]), socket };
          const send = socket.send.bind(socket);
          socket.send = (data) => {
            if (typeof data === 'string') {
              window.__sc07.seq += 1;
              window.__sc07.frames.push({ seq: window.__sc07.seq, url: entry.url, data });
            }
            return send(data);
          };
          window.__sc07.sockets.push(entry);
          return socket;
        },
      });
    });

    const runtime = { server_port: stack.serverPort, home: stack.home };
    const { name: sessionName } = await createAndAttach(page, expect, runtime, 'sc07', 'P2P', null);
    await expect(page.getByTestId('terminal-connecting')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId('terminal-surface')).toBeVisible();
    await page.locator('.xterm').evaluate((element) => {
      element.setAttribute('data-sc07-terminal', 'original');
    });
    await command(page, "printf ' SC07-ALIVE-1\\n'");
    await expect.poll(() => countInBuffer(page, 'SC07-ALIVE-1'), { timeout: 25_000 })
      .toBeGreaterThanOrEqual(2);

    const agentPort = stack.agents[0].port;
    const agentSockets = () => page.evaluate(
      (port) => window.__sc07.sockets.filter((entry) => entry.url.includes(':' + port)).length,
      agentPort,
    );
    const firstSockets = await agentSockets();
    expect(firstSockets).toBeGreaterThan(0);

    // ── Server outage: the P2P terminal is independent ──
    await stack.stopServer();
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('terminal-surface')).toBeVisible();
    expect(await page.evaluate(() => window.__sc07.marker)).toBe('same-document');
    expect(await page.locator('.xterm').getAttribute('data-sc07-terminal')).toBe('original');

    // ── P2P reconnect with the cached token while the Server is down ──
    // Same Agent identity, same port, same token: only the process restarted.
    await stack.restartAgent(0, { reusePort: true });
    await expect.poll(agentSockets, { timeout: 30_000 }).toBeGreaterThan(firstSockets);
    await expect.poll(async () => {
      await command(page, "printf ' SC07-RECONNECTED-2\\n'");
      return countInBuffer(page, 'SC07-RECONNECTED-2');
    }, { timeout: 35_000 }).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.__sc07.marker)).toBe('same-document');
    expect(await page.locator('.xterm').getAttribute('data-sc07-terminal')).toBe('original');

    // ── Rotation: the Server returns; the cached token is now invalid ──
    const beforeRotation = await agentSockets();
    const agentAuthFrames = () => page.evaluate((port) => window.__sc07.frames
      .filter((frame) => frame.url.includes(':' + port))
      .map((frame) => ({ seq: frame.seq, data: frame.data })), agentPort);
    await stack.restartServer();
    await waitForAgentOnline(stack, 'browser-agent');
    // The browser needs its own authenticated Server connection for the
    // refetch round trip; rotate only once it is back.
    await expect(page.locator('[aria-label="Server connected"]')).toBeVisible({ timeout: 30_000 });
    await stack.restartAgent(0, { reusePort: true, agentToken: TOKEN_ROTATED });
    await waitForAgentOnline(stack, 'browser-agent');
    await waitForServerToken(stack, `browser-agent:${sessionName}`, TOKEN_ROTATED);

    // The browser re-dials with the token it already holds, and the Agent
    // refuses it. Recovery may be a P2P re-attach with the value fetched
    // through the authenticated attach, or the Server Relay when that fetch
    // lands before the Server observed the re-registration; both keep the
    // Session in the same document. What this Case fixes is that recovery is
    // driven by the in-memory token and an authenticated attach, never by a
    // credential minted for this attach.
    const deadline = Date.now() + 60_000;
    let recovered = 0;
    while (Date.now() < deadline) {
      const typed = await command(page, "printf ' SC07-ROTATED-3\\n'").then(() => true).catch(() => false);
      if (typed) {
        recovered = await countInBuffer(page, 'SC07-ROTATED-3');
        if (recovered >= 2) break;
      }
      await page.waitForTimeout(2_000);
    }
    expect(recovered).toBeGreaterThanOrEqual(2);
    await expect.poll(agentSockets, { timeout: 20_000 }).toBeGreaterThan(beforeRotation);

    // The refused value is the one the browser already held: reconnection
    // presents the in-memory Agent Token, and the Agent's refusal is what
    // starts the refetch episode.
    const authFrames = await agentAuthFrames();
    expect(authFrames.some(
      (frame) => frame.data.includes('client.auth') && frame.data.includes(TOKEN_A),
    )).toBe(true);

    expect(await page.evaluate(() => window.__sc07.marker)).toBe('same-document');
    await expect(page.locator('.xterm')).toHaveCount(1);

    test.info().annotations.push({
      type: 'evidence',
      description:
        'exact SHA ' + sha + ': browser attached over P2P with the handed-off Agent token; ' +
        'stopping the Server left the Session and terminal mounted in the same document; ' +
        'restarting the Agent on the same port/token reconnected with the cached token while the ' +
        'Server was down, keeping the same terminal DOM; after the Agent token was rotated the ' +
        'browser re-dialled with the value it already held, the Agent refused it, and the Session ' +
        'recovered in the same document without a page reload through the authenticated ' +
        'attach/Relay path',
    });
  } finally {
    await stack.stop();
  }
});
