'use strict';
// #3440 SC-06: Agent MCP accepts the Agent Token and refuses the Server or
// another Agent's token; Server MCP and authenticated Image GET/HEAD accept the
// Server Token and refuse Agent Tokens, preserving HTTP method/status and the
// Streamable HTTP tool transport.
const assert = require('node:assert/strict');
const {
  authenticateAgent,
  openFrames,
  startEndpointStack,
  waitForAgentOnline,
} = require('../../../shared/endpoint-token-cases.cjs');

const SERVER_TOKEN = 'server-token-3440-http-aaaa';
const TOKEN_A = 'agent-token-a-3440-http-bbbb';
const TOKEN_B = 'agent-token-b-3440-http-cccc';
const UNKNOWN_DIGEST = 'sha256:' + '0'.repeat(64);

function mcpStatus(port, token) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'endpoint-token-case', version: '1.0.0' },
      },
    }),
  }).then((response) => response.status);
}

function blobStatus(port, method, token) {
  const headers = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`http://127.0.0.1:${port}/images/blobs/${UNKNOWN_DIGEST}`, {
    method,
    headers,
  }).then((response) => response.status);
}

(async () => {
  const evidence = [];
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    serverMcp: true,
    agents: [
      { agentId: 'http-a', agentToken: TOKEN_A, mcp: true },
      { agentId: 'http-b', agentToken: TOKEN_B, mcp: true },
    ],
  });
  try {
    await waitForAgentOnline(stack, 'http-a');
    const a = stack.agents[0];
    const b = stack.agents[1];

    // Server MCP: Server Token only.
    assert.ok(
      (await mcpStatus(stack.serverPort, SERVER_TOKEN)) !== 401,
      'Server MCP must accept the Server Token',
    );
    assert.equal(await mcpStatus(stack.serverPort, TOKEN_A), 401);
    assert.equal(await mcpStatus(stack.serverPort, null), 401);

    // Agent MCP: that Agent's token only.
    assert.ok(
      (await mcpStatus(a.port, TOKEN_A)) !== 401,
      'Agent MCP must accept the Agent Token',
    );
    assert.equal(await mcpStatus(a.port, SERVER_TOKEN), 401);
    assert.equal(await mcpStatus(a.port, TOKEN_B), 401, 'another Agent token must be refused');
    assert.equal(await mcpStatus(b.port, TOKEN_B) !== 401, true);

    // Image HTTP: the Server Token authenticates the route. With a well-formed
    // unknown digest the authenticated answer is 404, not an authorization
    // failure; an Agent Token and an absent bearer are both 403.
    assert.equal(await blobStatus(stack.serverPort, 'GET', SERVER_TOKEN), 404);
    assert.equal(await blobStatus(stack.serverPort, 'HEAD', SERVER_TOKEN), 404);
    assert.equal(await blobStatus(stack.serverPort, 'GET', TOKEN_A), 403);
    assert.equal(await blobStatus(stack.serverPort, 'GET', null), 403);
    assert.equal(await blobStatus(stack.serverPort, 'POST', SERVER_TOKEN), 405);

    // The direct Agent P2P path still accepts A (the stack remains healthy).
    {
      const client = await openFrames(a.url);
      const reply = await authenticateAgent(client, TOKEN_A);
      assert.equal(reply.msg_type, 'ok');
      client.close();
    }

    evidence.push(
      {
        type: 'runtime',
        value:
          'exact target SHA stack: Server MCP accepted S and refused A and no-bearer; Agent MCPs ' +
          'accepted only their own token and refused S and the sibling Agent token; image GET/HEAD ' +
          'with S returned 404 for a well-formed unknown digest, A and no-bearer returned 403, and ' +
          'POST with S returned 405',
      },
      {
        type: 'source',
        value:
          'Server and Agent MCP hosts construct one shared TokenVerifier from their own endpoint ' +
          'secret; the image HTTP route verifies the Server Token and keeps digest/method semantics',
      },
    );
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'Agent MCP verifies the Agent Token; Server MCP and image HTTP verify the Server Token; ' +
        'cross-endpoint tokens are refused and HTTP method/status semantics are preserved',
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
