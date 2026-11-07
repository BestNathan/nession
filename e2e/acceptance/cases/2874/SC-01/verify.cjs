'use strict';
// #2874 SC-01: a force-refresh snapshot is captured, a newer authoritative
// Agent report commits while the reply is in flight, and the late snapshot
// must not erase it. Two deterministic interleavings are exercised against a
// real SQLite database + SessionRegistry:
//
//   1. the newer report completed before the projection resumed — the
//      generation check skips the stale rewrite entirely;
//   2. the projection is held (barrier) between its atomic in-memory swap and
//      its persisted rewrite while the newer report arrives — the per-Agent
//      guard serializes them and the newer report applies on top.
//
// Both assert the persisted row and a fresh-registry reload preserve the newer
// report's fields.
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'registry::session::tests::sc01_a_stale_refresh_cannot_erase_a_newer_agent_report',
  'registry::session::tests::sc01_a_refresh_projection_and_a_live_update_are_serialized',
];

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests(
    'nession-server',
    ['--lib', 'registry::session::tests::sc01_'],
    300000,
  );
  assertRan(output, TESTS);

  const measured = [...output.matchAll(/#2874 SC-01 (?:serialization )?measured: ([^\n]+)/g)];
  if (measured.length !== TESTS.length) {
    throw new Error(
      `expected ${TESTS.length} SC-01 measurement lines, found ${measured.length}`,
    );
  }

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a force-refresh snapshot was captured before a newer ' +
      'Agent report; in the completed-before-resume interleaving — ' + measured[0][1] +
      '; in the barrier-held projection interleaving — ' + measured[1][1] +
      '; both the live registry and a fresh reload preserved the newer status and counts',
  });
  return 'A stale force-refresh cannot erase a newer Agent Session report';
});
