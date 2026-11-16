'use strict';
// #3705 SC-03: actual packaged nginx runtime-tools stage, real Server backend,
// native TLS-to-TLS upstream, independent Streamable HTTP client and readback.
const { run, targetSha, checked, crateTests, assertRan } =
  require('../../../shared/mcp-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const result = checked('node', ['scripts/mcp-image-ingress.test.mjs'], 1800000);
  if (!result.includes('MCP_IMAGE_INGRESS_TEST PASS')) {
    throw new Error('nginx HTTP/TLS transport proof did not complete');
  }
  const protocol = crateTests(
    'nession-mcp',
    ['--test', 'integration', 'protocol::the_official_client_keeps_the_legacy_lifecycle'],
    900000,
  );
  assertRan(protocol, ['protocol::the_official_client_keeps_the_legacy_lifecycle']);
  evidence.push({
    type: 'runtime',
    value: 'staging ' + sha + ': shipped nginx runtime-tools stage with checkout entrypoint and real Server RPC behind HTTP and TLS; independent client observed 401 bearer refusal, Origin policy, legacy initialize/tools-list/DELETE and modern safe Tool read, without SPA fallback',
  });
  return 'Both nginx HTTP and TLS front doors preserve MCP authentication and protocol lifecycle';
});
