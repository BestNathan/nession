'use strict';
// #3439 SC-03 / W1: an HTTP connection that completed one request cannot keep
// a socket (or its hyper task) outside the pre-authentication budget by going
// idle on keep-alive or sending a partial next head, while a streaming body is
// not cut by the same deadline.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'ingress::tests::an_idle_keep_alive_connection_is_closed_at_the_header_deadline',
  'ingress::tests::a_partial_next_request_is_closed_at_the_header_deadline',
  'ingress::tests::a_streaming_response_longer_than_the_header_deadline_is_not_cut',
];

run(({ evidence }) => {
  const sha = targetSha();
  const runtime = crateTests(
    'nession-runtime',
    ['--lib', 'ingress::tests'],
    600_000,
  );
  assertRan(runtime, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      sha +
      ': a keep-alive connection that went idle after one response and one that sent a partial ' +
      'second request were both closed at the per-request header deadline, while a streamed body ' +
      'longer than that deadline was delivered in full',
  });
  return (
    'The HTTP listener bounds every request head (including the idle keep-alive wait) without ' +
    'cutting a streaming response body'
  );
});
