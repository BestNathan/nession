'use strict';
// #2789 SC-01: a Session with absent metadata renders a valid fallback; a
// title/description/tags save survives an Agent restart while the tmux Session
// survives, and the Session's tmux identity is unchanged.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

// The Agent's tmux socket is private to this Case, like the filtered test
// harness; the lazy resolution does not create the directory.
const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2789-sc01-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const store = cargoTests(['--lib', 'session::metadata::tests'], 300_000, tmuxEnv);
  assertRan(store, [
    'session::metadata::tests::legacy_metadata_is_absent_until_the_first_save',
    'session::metadata::tests::metadata_persists_across_a_store_restart',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': a legacy tmux Session read as revision 0 ' +
      'with no title/tags/created_at, and a first save persisted title, description and tags ' +
      'through a fresh store instance (the Agent-restart shape) with the same tmux name and ' +
      'the same @nession_instance_id before and after the save',
  });
  return 'Absent metadata falls back safely and a save survives an Agent restart without changing tmux identity';
});
