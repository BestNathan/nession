'use strict';
// #3800 SC-03 (identity half): duplicate/out-of-order reports, a retired owner
// generation, a recreated same-name Session and a failed observation are all
// fenced away from the current level.
const { run, targetSha, cargoTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

const TESTS = [
  'duplicate_and_out_of_order_reports_are_rejected',
  'an_event_report_cannot_outlive_its_owner_generation',
  'a_reconcile_that_changes_ownership_discards_the_old_owners_report',
  'a_recreated_session_with_the_same_name_does_not_inherit_activity',
  'a_report_for_an_unknown_pane_or_wrong_capability_is_refused',
  'a_duplicate_probe_does_not_clobber_a_newer_event_report',
];

run(({ evidence }) => {
  const sha = targetSha();
  const output = cargoTests(['--lib', 'session::activity::coordinator::tests::'], 90000);
  assertRan(output, TESTS);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': duplicate and older source generations were refused; ' +
      'a report from a retired owner/workload generation was refused; a same-name ' +
      'recreated Session started with no inherited level; an unobserved Pane or ' +
      'capability was refused',
  });
  return 'Session Activity rejects stale incarnations, retried events and retired owners instead of leaking a level';
});
