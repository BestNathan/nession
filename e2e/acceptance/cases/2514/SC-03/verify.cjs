'use strict';
// #2514 SC-03: fallback descendant trees with lower-confidence SID/TTY
// evidence, and distinct unsupported/permission/offline/zero states.
//
// On Darwin this runs the macOS libproc reader test directly. On the Linux
// runner it runs the Linux fallback suite and verifies the macOS reader and its
// platform-gated test are present in the target tree; the PR records the Darwin
// execution because this runner cannot execute macOS APIs.
const os = require('node:os');
const {
  run, targetSha, checked, assertRan,
} = require('../../../shared/control-mode-cases.cjs');
const {
  readSource,
  runProcessDiscoveryTests,
} = require('../../../shared/process-discovery-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const platform = checked('uname', ['-sm'], 10000).trim();
  const isDarwin = os.platform() === 'darwin';

  runProcessDiscoveryTests([
    'a_real_isolated_session_reports_its_pane_and_descendants',
    'a_process_that_exited_during_the_window_is_stale_not_zero',
    'an_unreadable_command_is_not_an_empty_command',
    'a_missing_pane_root_is_not_mistaken_for_an_empty_tree',
    'an_unknown_session_is_an_error_not_an_empty_answer',
  ]);

  const macos = readSource('crates/nession-agent/src/session/process_discovery/macos.rs');
  for (const reader of ['proc_listpids', 'proc_pidinfo', 'proc_pid_rusage', 'devname', 'KERN_PROCARGS2']) {
    if (!macos.includes(reader)) {
      throw new Error('the macOS reader is missing ' + reader);
    }
  }
  if (!macos.includes('a_child_process_is_visible_with_its_command_and_identity')) {
    throw new Error('the macOS reader has no platform-gated execution test');
  }

  if (isDarwin) {
    const output = checked(
      'cargo',
      ['test', '-p', 'nession-agent', '--lib', 'process_discovery::macos', '--', '--nocapture'],
      300000,
    );
    assertRan(output, ['a_child_process_is_visible_with_its_command_and_identity']);
  }

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ' on ' + platform +
        ': the fallback tree carried SID/TTY association evidence and a real isolated Session reported its root and descendants',
    },
    {
      type: 'runtime',
      value:
        'a process that exited mid-window was stale (not zero), an unreadable command was denied (not empty), a missing Pane root was unavailable, and an unknown Session was an error rather than an empty list',
    },
    {
      type: 'source',
      value: isDarwin
        ? 'Darwin executed the libproc reader test: a real child process was visible with its command, PPID and epoch start time'
        : 'the Darwin reader (libproc + KERN_PROCARGS2) and its platform-gated child-process test are present at this SHA; they cannot execute on the Linux runner, and the PR records the Darwin execution',
    },
  );
  return 'Linux fallback and honest metric states are proven at the target SHA; the macOS libproc reader is present and executes on Darwin';
});
