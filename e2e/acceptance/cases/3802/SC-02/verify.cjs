'use strict';
// #3802 SC-02: a backgrounded job does not hold the Pane working; a pipeline,
// a shell builtin and SIGINT converge without an output-silence heuristic; a
// foreground TUI is foreground work.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runSessionActivityTests } = require('../../../shared/session-activity-cases.cjs');

const TESTS = [
  'a_real_pane_tracks_prompt_foreground_job_and_background_job',
  'a_pipeline_and_a_shell_builtin_converge_truthfully',
  'a_foreground_job_of_any_kind_is_working',
  'the_shells_own_group_in_the_foreground_is_the_prompt',
];

run(({ evidence }) => {
  const sha = targetSha();
  runSessionActivityTests('session::activity::shell::', TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a backgrounded `sleep &` left the Shell idle; a ' +
      '`sleep | cat` pipeline was working and SIGINT returned it to idle; the ' +
      '`read` builtin was not fabricated into a foreground job; a foreground ' +
      'TUI-shaped process group and a `bash -c` child named `bash` classify as working',
  });
  return 'Shell foreground work is decided by the process group, so background, pipeline, builtin and TUI converge truthfully';
});
