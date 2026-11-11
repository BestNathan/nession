'use strict';
// #3264 SC-06: a 2025-03-26 client still completes initialize,
// notifications/initialized, tools/list and tools/call with the legacy session
// lifecycle, while a modern client is not forced through it.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const protocol = crateTests('nession-mcp', ['--test', 'integration', 'protocol::'], 900000);
  assertRan(protocol, [
    'protocol::the_legacy_initialize_lifecycle_still_works',
    'protocol::the_official_client_keeps_the_legacy_lifecycle',
    'protocol::the_official_client_negotiates_modern_protocol_without_initialize',
  ]);

  evidence.push({
    type: 'runtime',
    value: 'staging SHA ' + sha + ': initialize negotiated 2025-03-26, assigned Mcp-Session-Id, notifications/initialized returned 202, tools/list and tools/call used the session, and DELETE terminated it (later reuse 404)',
  });
  evidence.push({
    type: 'runtime',
    value: 'an official rmcp client in Initialize mode negotiated 2025-03-26 and completed tools/list and tools/call, while the same release served a modern client without initialize or a session',
  });
  return 'legacy 2025-03-26 clients keep the full initialize/session lifecycle, and the modern lifecycle remains independent in the same release';
});
