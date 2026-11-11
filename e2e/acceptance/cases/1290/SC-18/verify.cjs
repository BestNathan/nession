'use strict';
const { run, githubTests, requires, evidence } = require('../../../shared/github-context-cases.cjs');
run(({ evidence: ev }) => {
  githubTests('runtime::client::tests::limits_are_clamped', ['runtime::client::tests::limits_are_clamped_and_cursors_are_opaque_numbers']);
  requires('crates/nession-github/src/runtime/client.rs', ['MAX_LIMIT', 'MAX_RESPONSE_BYTES', 'REQUEST_TIMEOUT', 'Policy::none()', 'has_next', 'next_cursor']);
  ev.push(evidence('runtime', 'every operation has a fixed GET endpoint, page bounds, response byte cap, request timeout, redirect refusal and explicit continuation'));
  return 'Provider operations enforce fixed endpoint/method allowlists, budgets and pagination';
});
