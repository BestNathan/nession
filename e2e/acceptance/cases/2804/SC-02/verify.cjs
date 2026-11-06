'use strict';
// #2804 SC-02: a reconnect-triggered full re-sync whose tmux enumeration fails
// stays pending instead of consuming the intent and reporting every Session
// gone. After recovery the real snapshot is published; a genuinely observed
// empty list still emits gone for the Sessions that are really gone.
const {
  run, targetSha, crateTests, assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const RECONNECT =
  'sync::session_watcher::enumeration_failure::' +
  'a_failed_reconnect_resync_stays_pending_and_converges_after_recovery';

run(({ evidence }) => {
  const sha = targetSha();

  const reconnect = crateTests('nession-agent', ['--lib', RECONNECT], 600000);
  assertRan(reconnect, [RECONNECT]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': after a reconnect intent, a forced list_sessions Err ' +
      'published no frames and left handle.is_sync_needed() true; the next ' +
      'successful query cleared the intent and published the full real snapshot, ' +
      'and a genuine Ok([]) still emitted gone',
  });
  return 'A failed reconnect re-sync remains pending and converges after recovery, while a genuine empty snapshot still deletes';
});
