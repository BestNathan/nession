'use strict';
// #3802 SC-01: real detached bash and zsh Panes report idle at the prompt and
// working while a foreground command runs, including one that emits no output
// and one named after the shell itself.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runSessionActivityTests } = require('../../../shared/session-activity-cases.cjs');

const TESTS = [
  'explicit_bash_and_zsh_panes_follow_foreground_work',
  'a_silent_interactive_reader_is_working_not_inferred_from_output',
  'a_real_pane_tracks_prompt_foreground_job_and_background_job',
];

run(({ evidence }) => {
  const sha = targetSha();
  runSessionActivityTests('session::activity::shell::runtime_tests::', TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': detached real bash and zsh tmux Panes reported ' +
      'idle at the prompt and working for a silent foreground `sleep` and a ' +
      'blocking `cat`; regaining the prompt returned idle without an output timer',
  });
  return 'A real Shell Pane follows its foreground process group between prompt and work';
});
