'use strict';
// #3800 SC-02: two Pane providers aggregate into one Session level, a
// specialized owner is not overridden by generic Shell foreground evidence,
// and two specialized claims are an ambiguity rather than a priority race.
//
// The providers are fakes by design: P0 owns the domain and ownership rules,
// not Claude's or the Shell's real observation (#3801/#3802).
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'one_working_pane_makes_the_session_working',
  'all_observed_idle_panes_make_the_session_idle',
  'an_unknown_pane_without_working_makes_the_session_unknown',
  'a_specialized_idle_owner_is_not_overridden_by_generic_foreground_work',
  'a_specialized_unknown_owner_blocks_the_generic_claim',
  'two_specialized_claims_for_one_pane_are_ambiguous_and_unknown',
  'a_generic_claim_owns_the_pane_when_no_specialized_provider_claims_it',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(['--lib', 'session::activity::coordinator::tests::'], 90000);
  assertRan(output, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two live fake Pane providers aggregated ' +
      'working/idle/unknown as any-working > any-unknown > all-idle; a specialized ' +
      'idle or unknown owner was not overridden by a generic Shell working claim; ' +
      'two specialized claims for one Pane produced unknown with no owner',
  });
  return 'Session Activity aggregates every observed Pane and resolves ownership semantically, not by provider order';
});
