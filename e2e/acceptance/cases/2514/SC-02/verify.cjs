'use strict';
// #2514 SC-02: shared/unreadable/unsupported cgroups fall back to the process
// tree without claiming dedicated scope.
//
// The executable proof is the same discovery path used in production: each
// rejected scope reason is produced by `dedicated_cgroup_at` (ordinary/shared
// cgroup, cgroup v1), the Pane falls back to `process_tree` with `partial`
// coverage, and the real isolated Session test passes under whichever method
// the runner actually exposes rather than assuming a systemd tmux.
const os = require('node:os');
const {
  run, targetSha, checked,
} = require('../../../shared/control-mode-cases.cjs');
const {
  runProcessDiscoveryTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const platform = checked('uname', ['-sm'], 10000).trim();

  runProcessDiscoveryTests([
    'a_shared_or_ordinary_cgroup_is_not_a_dedicated_scope',
    'a_cgroup_v1_process_falls_back_with_its_own_reason',
    'a_missing_pane_root_is_not_mistaken_for_an_empty_tree',
    'a_pane_outside_the_requested_session_is_not_in_its_snapshot',
    'a_real_isolated_session_reports_its_pane_and_descendants',
  ]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + platform +
        ': an ordinary/shared cgroup and a cgroup v1 process were rejected with their own reason codes, not claimed as dedicated scope',
    },
    {
      type: 'runtime',
      value:
        'the negative cgroup fixtures produced each fallback reason; a rejected scope never claimed dedicated coverage, and the fallback Pane reported method=process_tree with coverage=partial',
    },
    {
      type: 'runtime',
      value:
        'a missing Pane root and a Pane outside the requested Session stayed distinct from an empty process tree',
    },
  );
  return 'Shared, unreadable and unsupported cgroups fall back to process-tree discovery and never claim dedicated scope';
});
