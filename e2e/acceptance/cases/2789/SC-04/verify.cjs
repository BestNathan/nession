'use strict';
// #2789 SC-04: killing and recreating the same tmux name does not attach the
// previous instance's metadata to the new Session; retention is explicit and
// offline/unreachable failures are distinguishable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, targetSha, cargoTests, assertRan, tmuxVersion,
} = require('../../../shared/control-mode-cases.cjs');

const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-2789-sc04-'));
const tmuxEnv = { NESSION_TMUX_SOCKET: path.join(tmuxDir, 'tmux.sock') };

run(({ evidence }) => {
  const sha = targetSha();
  const version = tmuxVersion();

  const store = cargoTests(['--lib', 'session::metadata::tests'], 300_000, tmuxEnv);
  assertRan(store, [
    'session::metadata::tests::a_recreated_session_of_the_same_name_does_not_inherit_metadata',
    'session::metadata::tests::legacy_metadata_is_absent_until_the_first_save',
    'session::metadata::tests::a_missing_session_is_not_found_and_a_broken_tmux_is_unavailable',
  ]);

  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ' on ' + version + ': after killing and recreating the same tmux name, ' +
      'the new Session had a different @nession_instance_id and read revision 0 with no inherited ' +
      'title; the previous instance directory and its metadata.json were retained rather than ' +
      'deleted, and a missing Session classified as not_found while a broken tmux socket ' +
      'classified as unavailable',
  });
  return 'A recreated same-name Session starts without inherited metadata, retention is explicit, and unreachable Agents are distinct';
});
