'use strict';
// #2514 SC-01: Linux independent per-Pane cgroup discovery.
//
// At the exact target SHA this Case proves, with synthetic but real on-disk
// cgroup fixtures and a real isolated tmux server:
//   - a `tmux-spawn-*.scope` is recognized as the dedicated per-Pane scope and
//     resolved under the cgroup root;
//   - membership is read recursively through nested cgroup.procs files;
//   - a scope that contains the Agent is rejected as shared, not claimed;
//   - linked Windows keep every Session membership while the Pane and its
//     processes are listed once;
//   - enumeration is bounded by process and depth limits;
//   - a real isolated tmux Session reports its Pane root and descendants.
//
// The runner's own tmux may not be systemd-integrated, so the dedicated-scope
// fixture is the executable proof of the discovery contract; the real Session
// proves the same snapshot projection end to end.
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
    'a_tmux_scope_is_recognized_and_resolved_under_the_cgroup_root',
    'cgroup_membership_reads_nested_scopes_and_proves_the_pane_root',
    'a_scope_that_contains_the_agent_is_shared',
    'a_scope_without_the_pane_root_is_not_evidence',
    'a_linked_window_is_one_pane_with_every_membership',
    'descendants_include_the_root_and_respect_depth',
    'the_process_budget_marks_the_pane_that_was_cut',
    'a_real_isolated_session_reports_its_pane_and_descendants',
  ]);
  runPaneIdentityTests(['pane_rows_keep_membership_for_a_linked_window']);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + platform +
        ': a tmux-spawn scope was resolved under the cgroup root, nested cgroup.procs were read recursively, and the Pane root had to be present before membership was claimed',
    },
    {
      type: 'runtime',
      value:
        'a cgroup containing the Agent was rejected as shared; linked Window rows kept both Session memberships while the Pane and its process list appeared once; process and depth bounds marked truncation',
    },
    {
      type: 'runtime',
      value:
        'a real isolated tmux server reported its Pane root and descendants through the same snapshot projection',
    },
  );
  return 'Linux dedicated per-Pane cgroup discovery is verified, including recursive membership, shared-scope rejection, linked-Window deduplication and bounded enumeration';
});
