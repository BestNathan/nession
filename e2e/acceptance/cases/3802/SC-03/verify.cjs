'use strict';
// #3802 SC-03: Shell yields to a specialized owner; unsupported evidence is
// unknown; Session/Pane replacement does not carry state; the terminal keeps
// its attach/input/resize path while activity reconciles.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runSessionActivityTests } = require('../../../shared/session-activity-cases.cjs');

const TESTS = [
  'a_specialized_idle_owner_is_not_overridden_by_generic_foreground_work',
  'a_specialized_foreground_is_yielded_not_claimed',
  'a_shell_without_group_evidence_is_unknown_not_idle',
  'a_recreated_session_with_the_same_name_does_not_inherit_activity',
  'a_real_pane_keeps_its_terminal_while_activity_reconciles',
];

run(({ evidence }) => {
  const sha = targetSha();
  runSessionActivityTests('session::activity::', TESTS);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a specialized owner kept its idle level against ' +
      'generic Shell evidence and an agent CLI was not claimed by Shell; a ' +
      'shell with no process-group evidence was unknown; a recreated same-name ' +
      'Session inherited nothing; a real Pane kept attach/input/resize while ' +
      'reconciling and its activity disappeared when killed',
  });
  return 'Shell never overwrites a specialized owner, and unsupported or replaced Pane evidence stays unknown without disturbing the terminal';
});
