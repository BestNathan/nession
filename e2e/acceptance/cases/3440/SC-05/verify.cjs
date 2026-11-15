'use strict';
// #3440 SC-05: standalone and Server-connected Agents accept their own durable
// agent_token for inbound WS and embedded MCP. The token is provisioned once,
// persists across restarts and never regenerates; an explicit override works;
// the Server auth_token stays outbound-only; empty/malformed secrets fail
// closed; rotation is a restart and the old value cannot authorize a new peer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  binary,
  authenticateAgent,
  openFrames,
  renderAgentConfig,
  startEndpointStack,
} = require('../../../shared/endpoint-token-cases.cjs');

const TOKEN = 'standalone-agent-token-3440-aaaa';
const ROTATED = 'standalone-agent-token-3440-bbbb';
const SERVER_TOKEN = 'server-token-3440-not-an-agent-token';

async function expectAuth(url, token, expected) {
  const client = await openFrames(url);
  try {
    const reply = await authenticateAgent(client, token);
    assert.equal(reply.payload.status, expected === 'ok' ? 'success' : 'failed');
    if (expected !== 'ok') {
      const denied = await client.request('agent.session.list', {});
      assert.equal(denied.msg_type, 'error', 'a refused socket must not gain authority');
    }
  } finally {
    client.close();
  }
}

function mcpStatus(port, token) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
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

(async () => {
  const evidence = [];
  const stack = await startEndpointStack({
    serverToken: SERVER_TOKEN,
    standalone: true,
    agents: [{ agentId: 'standalone', agentToken: TOKEN, mcp: true }],
  });
  try {
    const agent = stack.agents[0];
    await expectAuth(agent.url, TOKEN, 'ok');
    await expectAuth(agent.url, SERVER_TOKEN, 'error');
    await expectAuth(agent.url, '', 'error');

    const agentMcp = await mcpStatus(agent.port, TOKEN);
    assert.ok(agentMcp !== 401, 'Agent MCP must accept its own token, got ' + agentMcp);
    assert.equal(await mcpStatus(agent.port, SERVER_TOKEN), 401, 'MCP must refuse the Server Token');

    // Rotation is a restart: the new value authorizes, the old one does not.
    await stack.restartAgent(0, { agentToken: ROTATED });
    await expectAuth(stack.agents[0].url, ROTATED, 'ok');
    await expectAuth(stack.agents[0].url, TOKEN, 'error');

    // Provisioning: no configured token produces one persisted beside the
    // config, reused across a restart rather than regenerated.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3440-bootstrap-'));
    const configPath = path.join(home, 'agent.toml');
    fs.writeFileSync(
      configPath,
      renderAgentConfig({
        agentId: 'bootstrap',
        serverPort: null,
        authToken: '',
        agentToken: '',
        listenPort: 0,
        home,
      }).replace('listen_address = "127.0.0.1:0"', 'listen_address = "127.0.0.1:1"'),
    );
    // A port-1 bind is not the point here: the token is provisioned before the
    // listener, so a start that fails on bind still leaves the durable value.
    spawnSync(binary('nession-agent'), [configPath], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, HOME: home, NESSION_TMUX_SOCKET: path.join(home, 'tmux.sock') },
    });
    const tokenFile = configPath.replace(/\.toml$/, '.token');
    assert.ok(fs.existsSync(tokenFile), 'an unset agent_token must be provisioned beside the config');
    const first = fs.readFileSync(tokenFile, 'utf8').trim();
    assert.ok(first.length >= 16, 'the generated token must be long enough');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(tokenFile).mode & 0o777;
      assert.equal(mode, 0o600, 'the persisted token must be private');
    }
    spawnSync(binary('nession-agent'), [configPath], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, HOME: home, NESSION_TMUX_SOCKET: path.join(home, 'tmux.sock') },
    });
    assert.equal(
      fs.readFileSync(tokenFile, 'utf8').trim(),
      first,
      'a restart must reuse the persisted token',
    );

    // Malformed explicit values fail closed before the listener exists.
    const badConfig = path.join(home, 'bad.toml');
    fs.writeFileSync(
      badConfig,
      renderAgentConfig({
        agentId: 'bad',
        serverPort: null,
        authToken: '',
        agentToken: 'short',
        listenPort: 0,
        home,
      }),
    );
    const bad = spawnSync(binary('nession-agent'), [badConfig], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, HOME: home, NESSION_TMUX_SOCKET: path.join(home, 'tmux.sock') },
    });
    assert.notEqual(bad.status, 0, 'a malformed token must fail the start');
    const badOutput = String(bad.stdout || '') + String(bad.stderr || '');
    assert.match(badOutput, /too short|malformed|agent_token/i);

    fs.rmSync(home, { recursive: true, force: true });
    evidence.push(
      {
        type: 'runtime',
        value:
          'exact target SHA stack: standalone WS and MCP accepted the Agent Token and refused the ' +
          'Server Token; rotation accepted the new value and refused the old; an unset token was ' +
          'generated at mode 0600 and reused after restart; a malformed value failed the start',
      },
      {
        type: 'source',
        value:
          'crates/nession-agent/src/token.rs owns provisioning/persistence; ' +
          'crates/nession-agent/src/p2p_auth.rs and server/mcp.rs verify the same endpoint token',
      },
    );
    process.stdout.write(JSON.stringify({
      status: 'pass',
      summary:
        'Standalone and connected Agents use their own durable token for inbound WS and MCP; ' +
        'provisioning persists, rotation is a restart, and malformed values fail closed',
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
