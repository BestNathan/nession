'use strict';
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const {
  verifiedRuntime, createAndAttach, attachExisting, command, countInBuffer,
} = require('../../../shared/foreground-resume-browser.cjs');

test('SC-10: real P2P cursor resume and explicit truncated retention window', async ({ page, context, browser }, info) => {
  test.setTimeout(112_000);
  const { runtime, sha, contract } = verifiedRuntime('SC-10');
  expect(runtime.tmux_socket).toMatch(/\.sock$/);
  const installMonitor = async targetPage => {
    await targetPage.addInitScript(() => {
      const Original = window.WebSocket;
      window.__sc10 = { sockets: [], epochs: [], outputCursors: [], resumes: [] };
      window.WebSocket = new Proxy(Original, {
        construct(Target, args) {
          const ws = Reflect.construct(Target, args);
          window.__sc10.sockets.push(ws);
          ws.addEventListener('message', event => {
            if (typeof event.data !== 'string') return;
            try {
              const msg = JSON.parse(event.data);
              const payload = msg.payload || {};
              if (Number.isSafeInteger(payload.stream_epoch)) window.__sc10.epochs.push(payload.stream_epoch);
              if (Number.isSafeInteger(payload.stream_seq)) window.__sc10.outputCursors.push(payload.stream_seq);
            } catch { /* binary / application data */ }
          });
          return ws;
        },
      });
      const send = Original.prototype.send;
      Original.prototype.send = function (data) {
        if (typeof data === 'string') {
          try {
            const frame = JSON.parse(data);
            if (frame.msg_type === 'agent.terminal.stream.resume') {
              window.__sc10.resumes.push({
                epoch: frame.payload?.stream_epoch,
                after: frame.payload?.after_seq,
              });
            }
          } catch { /* preserve raw frame */ }
        }
        return send.call(this, data);
      };
    });
  };

  await installMonitor(page);
  const { name } = await createAndAttach(page, expect, runtime, 'case-1213-stream', 'P2P');
  await command(page, "printf 'SC10-START-%s\\n' 1213");
  await expect.poll(() => countInBuffer(page, 'SC10-START-1213'), { timeout: 20000 }).toBe(1);
  const before = await page.evaluate(() => ({
    requests: window.__sc10.resumes.length,
    cursor: window.__sc10.outputCursors.at(-1) ?? null,
  }));
  expect(before.cursor).not.toBeNull();
  await page.locator('.xterm').evaluate(el => el.setAttribute('data-sc10-terminal-instance', 'before'));

  // A separate P2P peer keeps the Agent's attached stream active while A's
  // physical WebSockets disappear. It is an observer: no control transfer.
  const peerContext = await browser.newContext();
  try {
    const peer = await peerContext.newPage();
    await installMonitor(peer);
    await attachExisting(peer, expect, runtime, name, 'P2P');
    await expect.poll(() => countInBuffer(peer, 'SC10-START-1213'), { timeout: 20000 }).toBe(1);
    await expect.poll(async () => peer.evaluate(() => window.__sc10.epochs.length), {
      timeout: 12000,
    }).toBeGreaterThan(0);

    try {
      await context.setOffline(true);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        for (const ws of window.__sc10.sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.close(4000, 'SC10 consumer suspended');
        }
      });
      // Real tmux sends output while the disconnected consumer cannot read.
      // 6500 paced writes push the Agent's 4096-event retention window beyond
      // an old cursor; the second live P2P peer observes the producer.
      const producer = 'for i in $(seq 1 6500); do printf "SC10-SEQ-%05d\\n" "$i"; sleep 0.002; done; printf "SC10-TAIL-%s\\n" 1213';
      execFileSync('tmux', ['-S', runtime.tmux_socket, 'send-keys', '-t', name, producer, 'Enter'], {
        timeout: 10000,
      });
      await expect.poll(() => countInBuffer(peer, 'SC10-TAIL-1213'), { timeout: 65000 }).toBe(1);

      // Request a genuinely old stream cursor from the live Agent. We assert
      // its explicit truncation contract rather than inventing a gap or
      // pretending a capture-pane snapshot is a complete replay.
      const reply = await peer.evaluate(async ({ sessionName, agentPort }) => {
        const epoch = window.__sc10.epochs.at(-1);
        if (!Number.isSafeInteger(epoch)) throw new Error('missing real stream epoch');
        const ws = window.__sc10.sockets.find(s =>
          new URL(s.url).port === String(agentPort) && s.readyState === WebSocket.OPEN);
        if (!ws) throw new Error('real Agent P2P socket not available');
        return new Promise((resolve, reject) => {
          const id = 'sc10-gap-' + Date.now();
          const timeout = setTimeout(() => reject(new Error('retention probe timed out')), 8000);
          const listener = event => {
            if (typeof event.data !== 'string') return;
            try {
              const message = JSON.parse(event.data);
              if (message.id !== id) return;
              ws.removeEventListener('message', listener);
              clearTimeout(timeout);
              resolve(message.payload);
            } catch { /* ignore other messages */ }
          };
          ws.addEventListener('message', listener);
          ws.send(JSON.stringify({
            id, msg_type: 'agent.terminal.stream.resume', timestamp: Date.now(),
            payload: { session_name: sessionName, stream_epoch: epoch, after_seq: 0 },
          }));
        });
      }, { sessionName: name, agentPort: runtime.agent_port });
      expect(reply.epoch_match).toBe(true);
      expect(reply.complete).toBe(false);
      expect(reply.first_available_seq).toBeGreaterThan(1);
    } finally {
      await context.setOffline(false);
    }

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('shell')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.xterm')).toHaveAttribute('data-sc10-terminal-instance', 'before', {
      timeout: 30000,
    });
    await expect.poll(() => countInBuffer(page, 'SC10-TAIL-1213'), { timeout: 30000 }).toBe(1);
    const observed = await page.evaluate(() => ({
      requests: window.__sc10.resumes.length,
      resumed: window.__sc10.resumes.slice(-4),
    }));
    expect(observed.requests).toBeGreaterThan(before.requests);
    expect(observed.resumed.some(r => r.epoch !== undefined && Number.isSafeInteger(r.after))).toBe(true);
    const evidence = {
      issue: 1213, criterion: 'SC-10', target_sha: sha, contract_sha256: contract,
      real_stack: true, mode: 'P2P', selected_session: name,
      producer: '6500 paced tmux writes while consumer offline',
      separate_observer_kept_agent_stream_alive: true,
      first_available_beyond_old_cursor: true, complete_false_verified: true,
      original_xterm_preserved: true, resume_request_observed: true,
      resumed_terminal_tail_output_once: true,
    };
    await info.attach('sc-10-retained-gap-evidence.json', {
      body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
    });
    console.log('CASE_EVIDENCE ' + JSON.stringify(evidence));
  } finally {
    await peerContext.close();
  }
});
