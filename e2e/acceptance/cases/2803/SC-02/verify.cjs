'use strict';
// #2803 SC-02: a failed refresh or an offline Agent for the same full Session
// id retains its last successful snapshot with explicit stale/error status; a
// distinct id with the same or a different name never retains; no current
// Session stays empty. The existing #2514 single-Session flow remains green.
const { run, targetSha, webVitest } = require('../../../shared/web-vitest-cases.cjs');

const IDENTITY_FILE =
  'src/product/agent/hooks/__tests__/integration/useAgentProcesses.identity.test.tsx';
const IDENTITY_TESTS = [
  'SC-02: a refresh failure for the same full Session ID retains its snapshot as stale',
  'SC-02: an offline same full Session ID retains its snapshot as stale',
  'SC-02: a distinct Session ID with a different name never retains the previous snapshot',
  'SC-02: no current Session stays empty and reads nothing',
];

const SINGLE_SESSION_FILE =
  'src/product/agent/components/__tests__/integration/AgentProcesses.test.tsx';
const SINGLE_SESSION_TESTS = [
  'observes only the current Session and renders one deduplicated forest',
  'keeps the last snapshot and marks it stale when a refresh fails',
  'never labels another Session with the previous snapshot',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(IDENTITY_FILE, IDENTITY_TESTS);
  webVitest(SINGLE_SESSION_FILE, SINGLE_SESSION_TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the same full Session id kept its last snapshot ' +
      'through a rejected refresh and an offline Agent with explicit stale/error ' +
      'status, a distinct id with the same or a different name never retained it, ' +
      'no current Session stayed empty, and the #2514 current-Session-only forest ' +
      'and stale-refresh contracts still passed',
  });
  return 'Retention is scoped to the same full Session identity; failure for that identity is visibly stale, never another Session\'s data';
});
