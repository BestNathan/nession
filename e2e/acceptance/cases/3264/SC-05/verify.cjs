'use strict';
// #3264 SC-05: the official rmcp client negotiates 2026-07-28, performs
// server/discover, tools/list and tools/call without any legacy session or
// initialize, and the transport validates standard headers, client/server
// metadata and version errors.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const protocol = crateTests('nession-mcp', ['--test', 'integration', 'protocol::'], 900000);
  assertRan(protocol, [
    'protocol::the_official_client_negotiates_modern_protocol_without_initialize',
    'protocol::modern_discover_reports_both_versions_and_the_server_identity',
    'protocol::modern_stateless_requests_need_no_initialize_and_advertise_four_tools',
    'protocol::a_modern_request_without_standard_headers_is_a_header_mismatch',
    'protocol::an_unsupported_version_lists_the_supported_versions',
  ]);

  evidence.push({
    type: 'runtime',
    value: 'staging SHA ' + sha + ': an official rmcp client negotiated 2026-07-28 via server/discover and completed tools/list and tools/call with no initialize and no Mcp-Session-Id; the result carried the four Tools and correct content',
  });
  evidence.push({
    type: 'runtime',
    value: 'raw HTTP at the same SHA proved MCP-Protocol-Version/Mcp-Method/Mcp-Name consistency (-32020 HeaderMismatch on missing or mismatched headers), -32022 UnsupportedProtocolVersionError with the supported list, and server metadata in the discover result',
  });
  return 'an official client negotiates the modern stateless protocol and completes discovery and tool calls; required headers, metadata and version errors are validated';
});
