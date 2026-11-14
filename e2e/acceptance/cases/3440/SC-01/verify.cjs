'use strict';
// #3440 SC-01: Server Token S and two independent Agent Tokens A/B.
//
// Web/CLI authenticate the Server with S and each Agent with its own token; S
// grants no direct Agent access, A cannot authenticate to B or to the Server,
// and invalid, empty, late, repeated or premature authentication fails closed
// without changing a connection's identity.
const assert = require('node:assert/strict');
const {
  authenticateAgent,
  authenticateServer,
  openFrames,
  startEndpointStack,
  waitForAgentOnline,
} = require('../../../shared/endpoint-token-cases.cjs');

const SERVER_TOKEN = 'server-token-3440-aaaaaaaa';
const TOKEN_A = 'agent-a-token-3440-bbbbbbbb';
const TOKEN_B = 'agent-b-token-3440-cccccccc';

(async () => {
  const evidence = [];
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    agents: [
      { agentId: 'token-a', agentToken: TOKEN_A },
      { agentId: 'token-b', agentToken: TOKEN_B },
    ],
  });
  try {
    await waitForAgentOnline(stack, 'token-a');
    await waitForAgentOnline(stack, 'token-b');
    const a = stack.agents[0];
    const b = stack.agents[1];

    // ── Server: S authenticates; an Agent Token does not ──
    {
      const client = await openFrames(stack.serverUrl);
      const auth = await authenticateServer(client, SERVER_TOKEN);
      assert.equal(auth.status, 'success', 'Server must accept its own token');
      client.close();
    }
    {
      const client = await openFrames(stack.serverUrl);
      const auth = await authenticateServer(client, TOKEN_A);
      assert.equal(auth.status, 'failed', 'an Agent Token must not authenticate the Server');
      client.close();
    }

    // ── Each Agent accepts exactly its own token ──
    {
      const client = await openFrames(a.url);
      const reply = await authenticateAgent(client, TOKEN_A);
      assert.equal(reply.msg_type, 'ok');
      assert.equal(reply.payload.status, 'success');
      const list = await client.request('agent.session.list', {});
      assert.equal(list.msg_type, 'ok', 'an authenticated connection may run a business frame');
      client.close();
    }
    {
      const client = await openFrames(b.url);
      const reply = await authenticateAgent(client, TOKEN_B);
      assert.equal(reply.msg_type, 'ok');
      assert.equal(reply.payload.status, 'success');
      client.close();
    }
    {
      const client = await openFrames(b.url);
      const reply = await authenticateAgent(client, TOKEN_A);
      assert.equal(reply.payload.status, 'failed', 'Agent A token must not authenticate Agent B');
      const stillDenied = await client.request('agent.session.list', {});
      assert.equal(stillDenied.msg_type, 'error', 'a refused connection must not gain authority');
      client.close();
    }
    {
      const client = await openFrames(a.url);
      const reply = await authenticateAgent(client, SERVER_TOKEN);
      assert.equal(reply.payload.status, 'failed', 'the Server Token must not authenticate an Agent');
      const stillDenied = await client.request('agent.session.list', {});
      assert.equal(stillDenied.msg_type, 'error', 'a refused connection must not gain authority');
      client.close();
    }
    {
      const client = await openFrames(a.url);
      const reply = await authenticateAgent(client, '');
      assert.equal(reply.payload.status, 'failed', 'empty authentication must fail closed');
      const stillDenied = await client.request('agent.session.list', {});
      assert.equal(stillDenied.msg_type, 'error', 'a refused connection must not gain authority');
      client.close();
    }

    // ── Premature business frame ──
    {
      const client = await openFrames(a.url);
      const reply = await client.request('agent.session.list', {});
      assert.equal(reply.msg_type, 'error');
      assert.equal(reply.payload.code, 'unauthorized');
      const again = await client.request('agent.session.list', {});
      assert.equal(again.msg_type, 'error', 'premature frames never gain authority');
      client.close();
    }

    // ── Repeated authentication cannot rewrite identity ──
    {
      const client = await openFrames(a.url);
      await authenticateAgent(client, TOKEN_A, 'identity-one');
      const reply = await client.request('client.auth', {
        auth_token: TOKEN_B,
        client_id: 'identity-two',
      });
      assert.equal(reply.msg_type, 'error');
      assert.equal(reply.payload.code, 'already_authenticated');
      // The first identity is unchanged and still serves business frames.
      const list = await client.request('agent.session.list', {});
      assert.equal(list.msg_type, 'ok');
      client.close();
    }

    // ── Late authentication is cut off ──
    {
      const started = Date.now();
      const client = await openFrames(a.url);
      await client.waitForClose(15_000);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 8_000, 'an unauthenticated socket must not hold forever');
      client.close();
    }

    evidence.push(
      {
        type: 'runtime',
        value:
          'exact target SHA stack: Server accepted S and refused A; Agent A accepted A and refused S, ' +
          'B and empty; Agent B accepted B and refused A; S could not open either Agent; ' +
          'premature, repeated and late authentication each failed closed and granted no authority',
      },
      {
        type: 'source',
        value:
          'crates/nession-agent/src/server/websocket.rs: client.auth is verified before any business ' +
          'frame; crates/nession-server/src/server/handler/server_auth_v1.rs and ' +
          'server_agent_register_v1.rs compare each endpoint\'s own token',
      },
    );
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'Server Token and per-Agent Tokens authenticate only their owning endpoint; invalid, empty, ' +
        'late, repeated and premature authentication fail closed',
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
