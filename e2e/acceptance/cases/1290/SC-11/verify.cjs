'use strict';
const { run, githubTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests::auth_fingerprint_is_stable', ['runtime::client::tests::auth_fingerprint_is_stable_and_never_the_token']);
  requires('crates/nession-github/src/runtime/client.rs', ['bearer_auth(token)', 'auth_fingerprint', 'FakeGithub']);
  const tokenUse = require('../../../shared/github-context-cases.cjs').source('crates/nession-github/src/runtime/client.rs');
  if (/tracing::|println!|dbg!/.test(tokenUse)) throw new Error('the client logs directly; a token-bearing path must not log');
  ev.push(evidence('runtime', 'the credential is used only as a request header; the cache key carries a hash prefix, and error messages/evidence contain neither the token nor a raw auth header'));
  return 'Real Agent authentication is never exposed through payloads, state, errors or diagnostics';
});
