'use strict';
// #3399 SC-01: an incremental SessionWatcher poll must publish a same-name
// tmux Session replacement when the only observable difference is the durable
// instance identity. An unchanged B→B poll stays silent, a legacy missing id
// is not manufactured into a transition, and the existing enumeration-failure
// and publication-failure retry protections remain intact.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const FILTER = 'sync::session_watcher';
const REQUIRED = [
  'sync::session_watcher::incarnation_replacement::a_same_name_replacement_with_an_unchanged_shape_is_published',
  'sync::session_watcher::incarnation_replacement::a_legacy_missing_instance_is_not_a_replacement',
  'sync::session_watcher::tests::test_session_changed_detects_instance_replacement',
  'sync::session_watcher::tests::test_session_changed_ignores_the_same_instance',
  'sync::session_watcher::tests::test_session_changed_does_not_manufacture_identity_changes',
  'sync::session_watcher::enumeration_failure::a_failed_enumeration_in_an_incremental_poll_sends_no_gone_and_keeps_tracking',
  'sync::session_watcher::publication_failure::an_enqueue_failure_after_enumeration_keeps_resync_pending_and_republishes_after_recovery',
];

run(({ evidence }) => {
  const sha = targetSha();

  const watcher = crateTests('nession-agent', ['--lib', FILTER], 600_000);
  assertRan(watcher, REQUIRED);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': with the same Session name, windows, clients, size, ' +
      'working directory and foreground command, the incremental watcher published ' +
      'the replacement carrying instance-b; an unchanged instance-b poll published ' +
      'nothing; a legacy missing identity was not manufactured into a replacement; ' +
      'the enumeration-failure and publication-failure retry tests also passed',
  });
  return 'A same-name tmux incarnation replacement is published as a lifecycle transition, with silent unchanged polls and intact retry behavior';
});
