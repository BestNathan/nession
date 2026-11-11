'use strict';
// #2681 SC-03: restricted mode denies direct and private/host-local egress,
// while only the authenticated host-side proxy channel is usable.
const assert = require('node:assert/strict');
const { run } = require('../../../shared/control-mode-cases.cjs');
const {
  probeCapabilities, runLinuxRuntimeTest, runtimeEvidence, pending, capabilityLine,
} = require('../../../shared/sandbox-cases.cjs');

const capabilities = probeCapabilities();
if (!capabilities.network_restricted) {
  pending('This runner cannot create a network namespace plus the trusted bridge/proxy channel',
    [{ type: 'blocked', value: capabilityLine(capabilities) }]);
} else {
  run(({ evidence }) => {
    const output = runLinuxRuntimeTest(
      'a_restricted_network_denies_direct_and_private_egress',
    );
    const facts = runtimeEvidence(output);
    assert.equal(facts.direct_denied, true, 'a direct connection must fail');
    assert.equal(facts.proxy_private_denied, true, 'the proxy must refuse a private destination');
    assert.equal(facts.allowed_succeeded, true, 'an allowed destination must succeed through the proxy');
    assert.equal(facts.channel_identity_denied, true, 'a non-bridge peer must not use the proxy');
    assert.equal(facts.control_after_release_denied, true, 'a post-release control connection must not be retained');
    evidence.push(
      { type: 'runtime', value: 'execution ' + facts.execution_id + ' had no direct egress outside the proxy channel' },
      { type: 'runtime', value: 'the proxy refused a private destination: ' + facts.proxy_response },
      { type: 'runtime', value: 'a non-bridge peer was rejected by SO_PEERCRED identity' },
      { type: 'runtime', value: 'an allowed destination succeeded through the proxy with HTTP ' + facts.allowed_status },
      { type: 'runtime', value: 'a post-release forged control hello was closed instead of being queued' },
      { type: 'runtime', value: 'proxy endpoint: ' + facts.proxy_endpoint },
    );
    return 'Restricted networking denied direct and private destinations and accepted only the execution-authenticated proxy channel';
  });
}
