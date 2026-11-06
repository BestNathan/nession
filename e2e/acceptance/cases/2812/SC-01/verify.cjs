'use strict';
// #2812 SC-01: in an isolated Agent/tmux runtime, `new-session` succeeds and
// the required post-create `resize-window` fails. The create must not leave an
// unowned, unreported live Session: it returns the resize failure, removes the
// Session tmux created, and the same name can be created again.
//
// The test injects both the failure and the Session table through the Agent's
// fake-tmux seam, so the observation is the create path itself (presence before
// and after, kill target, and the retry), not a timing inference.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run,
  targetSha,
  crateTests,
  assertRan,
} = require('../../../shared/control-mode-cases.cjs');

const RESIZE =
  'tmux::manager::create_recovery_tests::' +
  'a_post_create_resize_failure_removes_the_created_session_and_the_retry_succeeds';

// The fake needs no server, but the case still owns its socket so the test
// binary can never reach the runner's shared tmux server.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2812-sc01-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();

  const output = crateTests('nession-agent', ['--lib', RESIZE], 300000, tmuxEnv);
  assertRan(output, [RESIZE]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': new-session created session state, the injected ' +
      'resize-window refused with "injected resize failure"; create returned that ' +
      'error, issued kill-session for the created name, session state was gone, ' +
      'and a second create of the same name with resize healthy succeeded',
  });
  return 'A failed post-create resize removes the Session tmux created and leaves the name safely retryable';
});
