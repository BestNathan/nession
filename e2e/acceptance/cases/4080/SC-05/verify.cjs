'use strict';
// #4080 SC-05: a real isolated Agent + tmux Session with an applied
// `github.env`-like binding proves Session override, Agent fallback,
// binding-update visibility and cross-Session isolation, with no real
// personal token. The GitHub API is a loopback fake inside the test.
const {run, targetSha, crateTests, assertRan, isolatedTmuxEnv} = require('../../../shared/mcp-cases.cjs');

const TEST = 'session_env_4080::a_real_session_binding_selects_the_github_credential_per_request';

run(({evidence}) => {
  const sha = targetSha();
  const out = crateTests(
    'nession-agent',
    ['--test', 'integration', TEST],
    900000,
    isolatedTmuxEnv('nession-4080-sc05'),
  );
  assertRan(out, [TEST]);
  evidence.push({
    type: 'runtime',
    value:
      'exact staging ' + sha + ': a real isolated Agent+tmux Session with an applied github.env binding ' +
      'authenticated a loopback GitHub read with its Session token; a second Session used its own token; ' +
      'a re-applied binding revision was used by the next request without an Agent restart; the unbound ' +
      'Session resolved to the Agent baseline; no real credential was used',
  });
  return 'Session-first GitHub credential resolution with Agent fallback';
});
