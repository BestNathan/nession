'use strict';
// #2812 SC-02: a post-create Environment Binding persistence failure and a
// timeout after tmux creation are each reconciled safely, with no false
// success. A same-named Session that existed before the create, or one the
// attempt cannot prove it created, is never removed.
//
// Every step is deterministic: the binding directory is blocked by a regular
// file (no permission-dependent failure), and the timeout is a bounded
// marker-controlled wait in the injected tmux, not an arbitrary sleep.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const BINDING =
  'tmux::manager::create_recovery_tests::' +
  'a_binding_persistence_failure_removes_the_created_session_and_leaves_no_binding';
const TIMEOUT =
  'tmux::manager::create_recovery_tests::' +
  'a_post_create_timeout_removes_the_created_session_and_the_retry_succeeds';
const CANCELLED_OWNED =
  'tmux::manager::create_recovery_tests::' +
  'a_cancelled_create_removes_a_session_it_can_prove_it_created';
const CANCELLED_FOREIGN =
  'tmux::manager::create_recovery_tests::' +
  'a_cancelled_create_that_cannot_prove_ownership_leaves_the_session_and_says_so';
const FALLBACK_LEFTOVER =
  'tmux::manager::create_recovery_tests::' +
  'a_fallback_create_that_cannot_deliver_the_token_reports_the_session_it_left';
const PRE_EXISTING =
  'tmux::manager::create_recovery_tests::' +
  'a_pre_existing_same_named_session_is_not_touched';

// The fake needs no server, but the case still owns its socket so the test
// binary can never reach the runner's shared tmux server.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2812-sc02-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();

  const binding = crateTests('nession-agent', ['--lib', BINDING], 300000, tmuxEnv);
  assertRan(binding, [BINDING]);

  const timeout = crateTests('nession-agent', ['--lib', TIMEOUT], 300000, tmuxEnv);
  assertRan(timeout, [TIMEOUT]);

  const cancelledOwned = crateTests(
    'nession-agent',
    ['--lib', CANCELLED_OWNED],
    300000,
    tmuxEnv,
  );
  assertRan(cancelledOwned, [CANCELLED_OWNED]);

  const cancelledForeign = crateTests(
    'nession-agent',
    ['--lib', CANCELLED_FOREIGN],
    300000,
    tmuxEnv,
  );
  assertRan(cancelledForeign, [CANCELLED_FOREIGN]);

  const fallbackLeftover = crateTests(
    'nession-agent',
    ['--lib', FALLBACK_LEFTOVER],
    300000,
    tmuxEnv,
  );
  assertRan(fallbackLeftover, [FALLBACK_LEFTOVER]);

  const preExisting = crateTests('nession-agent', ['--lib', PRE_EXISTING], 300000, tmuxEnv);
  assertRan(preExisting, [PRE_EXISTING]);

  evidence.push(
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': record_created_binding failed (its directory was ' +
        'blocked by a regular file) after tmux created the Session; create returned ' +
        'the binding error, removed the Session, wrote no binding.json, and the ' +
        'corrected retry succeeded with the binding recorded',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': the create deadline expired while a post-create step ' +
        'was held; the create reported a timeout (not success), removed the Session ' +
        'tmux had created, and the same name was created again afterwards',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': cancellation during new-session removed the Session ' +
        'that carried this attempt\'s ownership token and returned a timeout; a ' +
        'Session without the token was left untouched, no kill-session was issued ' +
        'for it, and the error stated the ownership could not be proven',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a legacy-fallback create that created the Session ' +
        'but failed to type the environment could not prove ownership; it left the ' +
        'Session untouched, issued no kill-session, and its error named both the ' +
        'original send-keys failure and the unprovable leftover',
    },
    {
      type: 'runtime',
      value:
        'exact SHA ' + sha + ': a Session present before the create was refused as ' +
        '"already exists", no kill-session targeted it, and its state survived',
    },
  );
  return 'Post-create binding failure, timeout, and cancellation are reconciled without false success or loss of a Session the create cannot prove it owns';
});
