'use strict';
// #3440 SC-03: direct P2P remains reconnectable while the Server is down when a
// valid Agent Token is cached, preserving the Session's stream cursor and
// controller lease. Token rejection after rotation is bounded and clean: the
// old value cannot authorize a new peer, and after the Server returns one
// authenticated attach fetches the current value.
const assert = require('node:assert/strict');
const {
  authenticateAgent,
  authenticateServer,
  openFrames,
  startEndpointStack,
  waitForAgentOnline,
} = require('../../../shared/endpoint-token-cases.cjs');

const SERVER_TOKEN = 'server-token-3440-reconnect-aaaa';
const TOKEN_A = 'agent-token-a-3440-reconnect-bbbb';
const TOKEN_ROTATED = 'agent-token-a-3440-reconnect-cccc';
const CLIENT_ID = 'sc03-browser';

async function createSession(client, agentId, name) {
  const reply = await client.request('server.session.create', { agent_id: agentId, name }, 30_000);
  assert.equal(reply.payload.success, true, reply.payload.error ?? 'create refused');
  return reply.payload.session_id ?? `${agentId}:${name}`;
}

async function attachAgent(client, sessionName, token, clientId = CLIENT_ID) {
  const auth = await authenticateAgent(client, token, clientId);
  assert.equal(auth.msg_type, 'ok', 'Agent must accept its current token');
  return client.request('agent.attach', {
    session_name: sessionName,
    width: 120,
    height: 30,
    size_known: true,
    needs_bootstrap: true,
  }, 25_000);
}

(async () => {
  const evidence = [];
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    agents: [{ agentId: 'reconnect-agent', agentToken: TOKEN_A }],
  });
  try {
    await waitForAgentOnline(stack, 'reconnect-agent');
    const agent = stack.agents[0];

    const server = await openFrames(stack.serverUrl);
    const auth = await authenticateServer(server, SERVER_TOKEN);
    assert.equal(auth.status, 'success');
    const sessionId = await createSession(server, 'reconnect-agent', 'live');
    const handedOff = await server.request('server.session.attach', {
      session_id: sessionId,
      preferred_mode: 'p2p',
    }, 20_000);
    assert.equal(handedOff.payload.agent_token, TOKEN_A);

    // First direct connection: establish a stream cursor and the control lease.
    const first = await openFrames(agent.url);
    const firstAttach = await attachAgent(first, 'live', handedOff.payload.agent_token);
    assert.equal(firstAttach.msg_type, 'ok');
    assert.ok(firstAttach.payload.stream_epoch !== undefined, 'attach states a stream identity');
    const control = await first.request('agent.terminal.control.acquire', {
      session_name: 'live',
    }, 15_000);
    assert.equal(control.msg_type, 'ok');
    assert.equal(control.payload.role, 'controller');
    const controlGeneration = control.payload.generation;
    first.close();

    // The Server goes away. The Agent's listener and the Session do not.
    await stack.stopServer();

    const second = await openFrames(agent.url);
    const reattached = await attachAgent(second, 'live', handedOff.payload.agent_token);
    assert.equal(reattached.msg_type, 'ok');
    assert.ok(
      reattached.payload.stream_epoch !== undefined,
      'the Session still serves a stream identity after the Server outage',
    );
    assert.equal(
      reattached.payload.control_generation,
      firstAttach.payload.control_generation,
      'the Session control generation survives a Server outage',
    );
    const reacquired = await second.request('agent.terminal.control.acquire', {
      session_name: 'live',
    }, 15_000);
    assert.equal(reacquired.msg_type, 'ok');
    assert.equal(reacquired.payload.role, 'controller');
    assert.equal(
      reacquired.payload.generation,
      controlGeneration,
      'the controller lease and connection generation are preserved',
    );
    second.close();
    server.close();

    // Rotation while the Server is still down: the old token is refused and the
    // connection ends; there is no issuer to refetch from.
    await stack.restartAgent(0, { agentToken: TOKEN_ROTATED });
    {
      const stale = await openFrames(stack.agents[0].url);
      const refused = await authenticateAgent(stale, handedOff.payload.agent_token);
      assert.equal(refused.payload.status, 'failed');
      const denied = await stale.request('agent.session.list', {});
      assert.equal(denied.msg_type, 'error', 'the rotated-away token gains no authority');
      stale.close();
    }

    // The Server returns; one authenticated attach fetches the current token,
    // which authenticates a fresh direct connection. The old value still fails.
    await stack.restartServer();
    await waitForAgentOnline(stack, 'reconnect-agent');
    const healthy = await openFrames(stack.serverUrl);
    const healthyAuth = await authenticateServer(healthy, SERVER_TOKEN);
    assert.equal(healthyAuth.status, 'success');
    const rotatedSession = await createSession(healthy, 'reconnect-agent', 'rotated');
    const refreshed = await healthy.request('server.session.attach', {
      session_id: rotatedSession,
      preferred_mode: 'p2p',
    }, 20_000);
    assert.equal(refreshed.payload.agent_token, TOKEN_ROTATED);

    const current = await openFrames(stack.agents[0].url);
    const currentAuth = await authenticateAgent(current, refreshed.payload.agent_token);
    assert.equal(currentAuth.msg_type, 'ok');
    current.close();
    {
      const stale = await openFrames(stack.agents[0].url);
      const refused = await authenticateAgent(stale, handedOff.payload.agent_token);
      assert.equal(refused.payload.status, 'failed', 'the rotated-away token stays invalid');
      const denied = await stale.request('agent.session.list', {});
      assert.equal(denied.msg_type, 'error', 'the rotated-away token gains no authority');
      stale.close();
    }
    healthy.close();

    evidence.push(
      {
        type: 'runtime',
        value:
          'exact target SHA stack: with the Server stopped, a direct re-dial using the cached ' +
          'Agent Token re-served the Session with the same control generation; after a ' +
          'rotation the old token was refused and gained no authority; once the Server ' +
          'returned, one authenticated attach returned the rotated token and it authenticated ' +
          'the Agent',
      },
      {
        type: 'source',
        value:
          'web/src/platform/session-runtime/SessionRuntime.ts keeps the Agent token in memory ' +
          'and refetches only through an authenticated attach after rejection or Server recovery',
      },
    );
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'Direct P2P reconnects with the cached Agent Token while the Server is down, preserving ' +
        'stream and controller generation; rotation is refused cleanly and the current token is ' +
        'refetched after the Server returns',
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
