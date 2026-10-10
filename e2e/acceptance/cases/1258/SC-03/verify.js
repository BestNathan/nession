'use strict';
// Staging SC-03: verify the real Server dispatch behavior on an exact merged SHA.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { runtimeFromEnv, verifyOnlineAgent } = require('../../../../../acceptance/shared/protocol-online-agent.js');

const repo = path.resolve(__dirname, '../../../../..');
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket open timeout')); }, 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); }, { once: true });
  });
}
function request(ws, wire, payload, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(wire + ' timeout')); }, 8000);
    const onMessage = event => {
      let answer;
      try { answer = JSON.parse(String(event.data)); } catch { return; }
      if (answer.id !== id || answer.msg_type !== wire) return;
      cleanup();
      resolve(answer);
    };
    const onClose = () => { cleanup(); reject(new Error('WebSocket closed waiting for ' + wire)); };
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.send(JSON.stringify({ msg_type: wire, id, timestamp: Date.now(), payload }));
  });
}
async function main() {
  const runtime = runtimeFromEnv();
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), target);
  assert.equal(runtime.target_sha, target);
  assert.equal(runtime.profile, 'full-stack-local');

  const live = await verifyOnlineAgent(runtime);
  assert.equal(live.status, 'pass');
  const ws = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  try {
    const auth = await request(ws, 'server.auth', { auth_token: 'e2e-test-token', client_id: null }, '1258-auth');
    assert.equal(auth.payload?.status, 'success');
    const info = await request(ws, 'server.info', {}, '1258-info');
    assert.equal(typeof info.payload?.version, 'string');
    assert.ok(info.payload.online_agent_count >= 1, 'real Agent must be online');
    assert.ok(info.payload.agent_count >= info.payload.online_agent_count);
    const manifest = JSON.stringify(info.payload.protocol_manifest);
    assert.ok(manifest.includes('server.session.relay.end'), 'relay.end Unit absent from live manifest');
    assert.ok(manifest.includes('server.session.list'), 'session.list Unit absent from live manifest');
    const sessions = await request(ws, 'server.session.list', { force: false }, '1258-sessions');
    assert.ok(Array.isArray(sessions.payload?.sessions), 'server.session.list must return a sessions array');
    console.log(JSON.stringify({
      status: 'pass',
      summary: 'Exact-SHA full-stack Server preserves auth, agent registration, info/manifest and session.list Unit behavior over real WebSocket.',
      evidence: [
        ...live.evidence,
        { type: 'protocol', value: 'server.info id=1258-info version=' + info.payload.version + ' online_agent_count=' + info.payload.online_agent_count },
        { type: 'protocol', value: 'server.info advertises server.session.relay.end@v1 and server.session.list' },
        { type: 'protocol', value: 'server.session.list id=1258-sessions sessions=' + sessions.payload.sessions.length },
        { type: 'runtime', value: 'checked-out exact staging SHA=' + target },
      ],
    }));
  } finally {
    ws.close();
  }
}
main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ status: 'fail', summary: message,
    evidence: [{ type: 'protocol', value: 'SC-03 exact-SHA live Server Unit invariant failed' }] }));
  process.exitCode = 1;
});
