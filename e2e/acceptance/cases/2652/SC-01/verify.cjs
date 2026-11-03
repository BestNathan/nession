'use strict';
// #2652 SC-01: an authenticated Relay begin naming an unrelated or forged
// relay_url is refused before any outbound dial or token disclosure. The
// binding is Server-owned (the Agent's registered endpoint set), and ambiguous
// spellings — userinfo, query, fragment, alternate host/port/path — are
// refused rather than normalized into a match.
const {
  assertBefore,
  assertRan,
  readSource,
  serverLibTests,
} = require('../../../shared/relay-binding-cases.cjs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();

  const binding = serverLibTests('relay_url_');
  assertRan(binding, [
    'relay_url_binds_registered_spellings_to_the_server_owned_string',
    'relay_url_rejects_foreign_and_ambiguous_endpoints',
  ]);

  const refusal = serverLibTests('relay_begin_refuses');
  assertRan(refusal, [
    'relay_begin_refuses_an_unregistered_manual_endpoint_before_grant',
  ]);
  const noDial = serverLibTests('relay_begin_refusal_never_dials');
  assertRan(noDial, [
    'relay_begin_refusal_never_dials_a_listening_foreign_target',
  ]);

  const handler = readSource(
    'crates/nession-server/src/server/handler/server_session_relay_begin_v1.rs',
  );
  // The target is bound before the credential exists: minting after the check
  // is what makes "refused before grant/dial" structural rather than timing.
  assertBefore(
    handler,
    'agent_bound_relay_url(',
    '.mint(',
    'relay target binding must precede credential minting',
  );
  if (!handler.includes('Relay URL is not an address registered for Agent')) {
    throw new Error('the refusal must state the endpoint-binding rule');
  }
  if (handler.includes('vec![url.clone()]')) {
    throw new Error('a browser-supplied relay_url must never become the dialed endpoint');
  }
  // The refusal names the Agent, never the candidate.
  if (/not an address registered[^;]*\{url\}/s.test(handler)) {
    throw new Error('the refusal must not interpolate the browser candidate');
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': registry binding tests reject foreign/ambiguous endpoints; ' +
      'the handler refuses an unregistered manual relay_url before minting or granting a ' +
      'credential, and never dials the browser-supplied spelling',
  });
  return (
    'A manual relay_url binds only to an endpoint the Agent registered; foreign and ' +
    'ambiguous spellings are refused before mint, grant, or dial'
  );
});
