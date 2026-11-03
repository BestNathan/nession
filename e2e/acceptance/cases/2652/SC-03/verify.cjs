'use strict';
// #2652 SC-03: successful, refused, timed-out and failed Relay attempts never
// emit a raw scoped credential or credential-bearing URL to Server logs,
// structured errors or other unintended outputs.
const {
  assertRan,
  readSource,
  serverLibTests,
} = require('../../../shared/relay-binding-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const diagnostics = serverLibTests('relay_diagnostics_never');
  assertRan(diagnostics, ['relay_diagnostics_never_include_the_scoped_credential']);
  const reasons = serverLibTests('relay_failure_reason_is_a_bounded_category');
  assertRan(reasons, ['relay_failure_reason_is_a_bounded_category']);

  const websocket = readSource('crates/nession-server/src/server/websocket.rs');
  const safeSites = websocket.match(/sanitized_endpoint\(url\)/g) ?? [];
  if (safeSites.length < 4) {
    throw new Error(
      'every relay attempt/success/failure/timeout log must use sanitized_endpoint: found ' +
        safeSites.length,
    );
  }
  for (const raw of [
    'info!("Relay: trying {}", url)',
    'info!("Relay: connected to {}", url)',
    'warn!("Relay: connect to {} failed: {:#}", url, e)',
    'warn!("Relay: connect to {} timed out (2s)", url)',
  ]) {
    if (websocket.includes(raw)) {
      throw new Error('a credential-bearing URL is still formatted into a relay log: ' + raw);
    }
  }
  if (!websocket.includes('relay_failure_reason(e)')) {
    throw new Error('a failed relay dial must log a bounded category, not the raw error');
  }

  const handler = readSource(
    'crates/nession-server/src/server/handler/server_session_relay_begin_v1.rs',
  );
  if (/Relay begin refused[^;]*\{url\}/s.test(handler)) {
    throw new Error('the refusal log must not interpolate the browser candidate');
  }
  if (handler.includes('using manual URL')) {
    throw new Error('the old manual-URL log line must not return');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the relay diagnostic helper strips userinfo and the credential ' +
      'query and all four attempt/success/failure/timeout logs use it; failures log a bounded ' +
      'category; the refusal names the Agent and never the candidate',
  });
  return (
    'Relay diagnostics carry a sanitized endpoint and a bounded failure category; no relay ' +
    'log or refusal emits the scoped credential or the browser-supplied URL'
  );
});
