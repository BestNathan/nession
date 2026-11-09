'use strict';
// #565 SC-09: disabled MCP registers no route; enabled MCP leaves the existing
// WebSocket management path intact on the same listener.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const mcp = crateTests('nession-server', ['--test', 'integration', 'mcp::'], 900000);
  assertRan(mcp, [
    'mcp::mcp_disabled_registers_no_http_route',
    'mcp::embedded_mcp_does_not_displace_the_websocket_connection',
  ]);
  const websocket = crateTests('nession-server', ['--test', 'integration', 'websocket::test_'], 900000);
  assertRan(websocket, [
    'websocket::test_server_accepts_connection',
    'websocket::test_client_sessions_list_authenticated',
  ]);
  if (/FAILED/.test(websocket)) throw new Error('the Server WebSocket regression filter reported a failure');
  evidence.push(
    { type: 'runtime', value: 'with [mcp] disabled, POST /mcp reaches no MCP route at ' + sha },
    {
      type: 'runtime',
      value: 'with MCP enabled, server.auth + server.agent.list and the WebSocket regression suite still pass on the same listener',
    },
  );
  return 'MCP disabled adds no route, and enabling it does not displace the WebSocket/Session management path';
});
