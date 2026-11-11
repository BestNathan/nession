'use strict';
// #2877 SC-03: a provable current-subscription inconsistency emits at most one
// active Reconcile Required episode, carrying the correct binding/reason/head;
// ordinary lag and stale/foreign/malformed reports or retired notifications do
// not trigger recovery or leak current subscriber state.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { webVitestFiles } = require('../../../shared/web-vitest-cases.cjs');

const AGENT_TEST =
  'progress_is_response_less_and_only_an_actionable_current_inconsistency_opens_one_episode';
const SERVER_TEST =
  'a_progress_notification_is_forwarded_unchanged_to_the_agent';
const NOTICE_FILE = 'src/product/terminal/__tests__/unit/terminalServer.test.ts';
const NOTICE_TESTS = [
  'routes a strict current-subscription notice by session and drops malformed ones',
  'sends the negotiated response-less progress notification on its own wire (#2877)',
];

run(({ evidence }) => {
  const sha = targetSha();

  const agent = crateTests('nession-agent', ['--lib', AGENT_TEST], 300000);
  assertRan(agent, [AGENT_TEST]);

  const relay = crateTests('nession-server', ['--lib', SERVER_TEST], 300000);
  assertRan(relay, [SERVER_TEST]);

  webVitestFiles([NOTICE_FILE], NOTICE_TESTS, { project: 'unit' });

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': an ahead-of-issued claim opened exactly one episode and ' +
      'repeating it emitted nothing; a stale subscriber generation was ignored without ' +
      'disturbing the active episode; the notice payload named the current ' +
      'subscriber_generation, stream_epoch, reason, action, head_seq and retained floor, ' +
      'and the Web/Relay readers dropped malformed, foreign or stale notices',
  });
  return 'One active Reconcile Required episode per proven inconsistency; stale, foreign, duplicate and ordinary-lag reports stay silent';
});
