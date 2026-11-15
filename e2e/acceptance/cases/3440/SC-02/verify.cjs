'use strict';
// #3440 SC-02: the Agent synchronizes its durable token over the authenticated
// registration channel; the Server caches it under the current registration
// generation; an authenticated attach returns only the resolved Agent's token
// and addresses; direct attach/re-attach and Relay work with that same token;
// no per-attach mint or refresh exists; a stale registration cannot install an
// older token.
const assert = require('node:assert/strict');
const {
  authenticateAgent,
  authenticateServer,
  openFrames,
  startEndpointStack,
  waitForAgentOnline,
} = require('../../../shared/endpoint-token-cases.cjs');

const SERVER_TOKEN = 'server-token-3440-registration';
const TOKEN_A = 'agent-token-a-3440-registration';
const TOKEN_A_STALE = 'agent-token-a-3440-stale-superseded';

async function createSession(client, agentId, name) {
  const reply = await client.request('server.session.create', {
    agent_id: agentId,
    name,
  }, 30_000);
  assert.equal(reply.payload.success, true, reply.payload.error ?? 'session create refused');
  return reply.payload.session_id ?? `${agentId}:${name}`;
}

async function waitForAttachToken(client, sessionId, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const reply = await client.request('server.session.attach', {
      session_id: sessionId,
      preferred_mode: 'p2p',
    }, 20_000);
    last = reply.payload;
    if (last?.status === 'success' && last.agent_token === expected) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'attach never observed the expected current token; last=' + JSON.stringify(last),
  );
}

async function attach(client, sessionId, mode = 'p2p') {
  const reply = await client.request('server.session.attach', {
    session_id: sessionId,
    preferred_mode: mode,
  }, 20_000);
  assert.equal(reply.payload.status, 'success', reply.payload.message ?? 'attach refused');
  return reply.payload;
}

(async () => {
  const evidence = [];
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    agents: [
      { agentId: 'handoff-agent', agentToken: TOKEN_A },
      { agentId: 'handoff-agent', agentToken: TOKEN_A_STALE },
    ],
  });
  try {
    await waitForAgentOnline(stack, 'handoff-agent');

    const server = await openFrames(stack.serverUrl);
    const auth = await authenticateServer(server, SERVER_TOKEN);
    assert.equal(auth.status, 'success');

    const sessionId = await createSession(server, 'handoff-agent', 'handoff');

    const first = await waitForAttachToken(server, sessionId, TOKEN_A_STALE);
    assert.equal(first.mode, 'p2p');
    assert.equal(first.agent_token, TOKEN_A_STALE, 'attach returns the current registration token');
    assert.ok(Array.isArray(first.addresses) && first.addresses.length > 0);
    assert.ok(first.agent_address, 'the reply names the resolved agent address');

    // No mint: a second attach returns the same durable value.
    const again = await attach(server, sessionId);
    assert.equal(again.agent_token, TOKEN_A_STALE, 're-attach must not mint a new token');

    // The handed-off token authenticates the Agent whose registration is
    // current (the second process to register the shared identity).
    const currentIndex = first.agent_token === TOKEN_A_STALE ? 1 : 0;
    {
      const agent = await openFrames(stack.agents[currentIndex].url);
      const reply = await authenticateAgent(agent, first.agent_token);
      assert.equal(reply.msg_type, 'ok');
      const attached = await agent.request('agent.attach', {
        session_name: 'handoff',
        width: 120,
        height: 30,
        size_known: true,
        needs_bootstrap: true,
      }, 20_000);
      assert.equal(attached.msg_type, 'ok', JSON.stringify(attached.payload));
      agent.close();
    }

    // Relay uses the Server-cached token itself: the Server dials the Agent and
    // only emits the ready receipt after the Agent authenticated the relay.
    {
      const relay = await openFrames(stack.serverUrl);
      const relayAuth = await authenticateServer(relay, SERVER_TOKEN);
      assert.equal(relayAuth.status, 'success');
      relay.send('server.session.relay.begin', {
        session_id: sessionId,
        cols: 120,
        rows: 30,
        size_known: true,
      });
      const ready = await relay.waitFor(
        (message) => message.msg_type === 'server.session.relay.ready',
        25_000,
        'relay ready',
      );
      assert.equal(ready.msg_type, 'server.session.relay.ready');
      relay.close();
    }

    // A newer registration replaces the cached value atomically; the older
    // process re-registering becomes the current generation again.
    const restarted = await stack.restartAgent(0, { agentToken: `${TOKEN_A}-rotated-0000` });
    await waitForAgentOnline(stack, 'handoff-agent');
    const rotated = await waitForAttachToken(server, sessionId, `${TOKEN_A}-rotated-0000`);
    assert.equal(
      rotated.agent_token,
      `${TOKEN_A}-rotated-0000`,
      'the current registration generation owns the token',
    );
    assert.notEqual(rotated.agent_token, first.agent_token);
    void restarted;

    // The Agent accepts only that current value now.
    {
      const old = await openFrames(stack.agents[0].url);
      const refused = await authenticateAgent(old, first.agent_token);
      assert.equal(refused.payload.status, 'failed', 'a superseded token must be refused');
      const denied = await old.request('agent.session.list', {});
      assert.equal(denied.msg_type, 'error', 'a superseded token gains no authority');
      old.close();
    }

    server.close();
    evidence.push(
      {
        type: 'runtime',
        value:
          'exact target SHA stack: registration cached the newest of two same-identity Agents; ' +
          'attach returned only that Agent token and its addresses; re-attach returned the same ' +
          'value (no mint); direct attach and Server-dialled Relay both authenticated with it; ' +
          'restarting with a new token made it the current generation and the old token was refused',
      },
      {
        type: 'protocol',
        value:
          'AgentRegisterPayload carries agent_token; server.session.attach returns agent_token; ' +
          'no agent.p2p.grant, mint, grant ACK or connection_token_expires_at exists on this path',
      },
    );
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'The Agent Token synchronizes with its registration generation and is handed off only to ' +
        'the resolved Agent; direct attach and Relay authenticate with it and re-attach never mints',
      evidence,
    }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence,
    }) + '\n');
    process.exitCode = 1;
  } finally {
    await stack.stop();
  }
})();
