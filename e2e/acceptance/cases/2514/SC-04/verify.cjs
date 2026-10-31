'use strict';
// #2514 SC-04: Pane lifecycle, linked Windows, PID reuse and disappearing
// processes do not produce stale or cross-Session misattribution.
//
// Every snapshot re-reads tmux Pane identity (root PID and TTY) and OS facts;
// nothing is cached across queries. Identity is PID + start time, a vanished
// Pane root is `unavailable` rather than an empty tree, a linked Window keeps
// its memberships while being listed once, and a process that exits during the
// sampling window is stale rather than counted as zero. Orphan/retained-scope
// tracking is not claimed: the reason codes and architecture doc state the
// phase-1 limitation.
const os = require('node:os');
const {
  run, targetSha, checked,
} = require('../../../shared/control-mode-cases.cjs');
const {
  runPaneIdentityTests,
  runProcessDiscoveryTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const platform = checked('uname', ['-sm'], 10000).trim();

  runProcessDiscoveryTests([
    'a_linked_window_is_one_pane_with_every_membership',
    'a_pane_outside_the_requested_session_is_not_in_its_snapshot',
    'a_missing_pane_root_is_not_mistaken_for_an_empty_tree',
    'a_process_that_exited_during_the_window_is_stale_not_zero',
    'the_process_budget_marks_the_pane_that_was_cut',
    'descendants_include_the_root_and_respect_depth',
    'a_real_isolated_session_reports_its_pane_and_descendants',
  ]);
  runPaneIdentityTests([
    'pane_rows_keep_membership_for_a_linked_window',
    'pane_rows_fall_back_to_the_session_id_when_the_name_query_raced',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + platform +
        ': a linked Window kept both Session memberships with one Pane pid, and every snapshot re-read the fresh Pane root rather than caching it',
    },
    {
      type: 'runtime',
      value:
        'a missing Pane root was unavailable, a process that exited during sampling was stale (identity is PID + start time), and a Pane outside the requested Session never entered its snapshot',
    },
    {
      type: 'runtime',
      value:
        'process and depth bounds marked truncation instead of silently dropping members; retained-scope orphan tracking is not claimed by this stateless phase',
    },
  );
  return 'Pane mutation, linked Windows, PID-reuse identity and disappearing processes stay truthful; unsupported orphan tracking is stated rather than invented';
});
