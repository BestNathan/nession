#!/usr/bin/env node
// Headless WebSocket driver for the native macOS runtime fixture (#4584 SC-02).
//
// Authenticates to the isolated local Server and issues one explicit
// `server.session.processes` request, then asserts the Agent's real snapshot
// comes back over the relay. This exercises the on-demand macOS process
// discovery path (proc_pid_rusage / proc_pidinfo) without a browser. It uses
// Node's built-in WebSocket (Node >= 22), so it carries no npm dependency.
//
// usage: native-macos-runtime-driver.mjs WS_URL TOKEN AGENT_ID:SESSION_NAME
// stdout: one JSON object {ok, platform, methods, pane_count, process_count, ...}
// exit: 0 on a real snapshot, 1 on refusal/error/timeout, 2 on bad usage.
import process from 'node:process';

const [, , url, token, sessionId] = process.argv;
if (!url || !token || !sessionId) {
  console.error('usage: native-macos-runtime-driver.mjs WS_URL TOKEN AGENT_ID:SESSION_NAME');
  process.exit(2);
}

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();

function send(msgType, payload) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ msg_type: msgType, id, timestamp: Date.now(), payload }));
  });
}

function finish(obj, code) {
  console.log(JSON.stringify(obj));
  try { ws.close(); } catch { /* already closed */ }
  process.exit(code);
}

const timer = setTimeout(() => finish({ ok: false, error: 'timeout waiting for server reply' }, 1), 20_000);

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  const waiter = pending.get(msg.id);
  if (waiter) {
    pending.delete(msg.id);
    waiter.resolve(msg);
  }
});

ws.addEventListener('error', (ev) => {
  clearTimeout(timer);
  finish({ ok: false, error: 'websocket error: ' + (ev.message || 'unknown') }, 1);
});

ws.addEventListener('open', async () => {
  try {
    // The central Server's browser/client auth route is `server.auth`
    // (`client.auth` is the Agent P2P handshake, a different endpoint).
    const auth = await send('server.auth', { auth_token: token, client_id: 'native-fixture' });
    if (auth.payload?.status !== 'success') {
      throw new Error('server.auth failed: ' + JSON.stringify(auth.payload));
    }
    const reply = await send('server.session.processes', { session_id: sessionId });
    const snapshot = reply.payload?.snapshot;
    if (!snapshot) {
      clearTimeout(timer);
      finish({ ok: false, refused: reply.payload ?? null }, 1);
    }
    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
    const processCount = panes.reduce((n, p) => n + (Array.isArray(p.processes) ? p.processes.length : 0), 0);
    clearTimeout(timer);
    finish({
      ok: true,
      platform: snapshot.platform,
      methods: snapshot.methods,
      session_name: snapshot.session_name,
      pane_count: panes.length,
      process_count: processCount,
      truncated: snapshot.truncated,
    }, 0);
  } catch (err) {
    clearTimeout(timer);
    finish({ ok: false, error: String(err?.message || err) }, 1);
  }
});