'use strict';
// #2999 SC-01: a live Session bound to Profile A survives a same-name create
// that selects Profile B (and one that selects no profile). Both must be
// refused by the real Agent, and neither refusal may clear or replace A.
const assert = require('node:assert/strict');
const {
  authenticate,
  createSessionWithProfiles,
  emitFailure,
  emitPass,
  getBinding,
  killSession,
  openSocket,
  tmuxHasSession,
  unique,
  waitForAgent,
  waitForSession,
  writeProfile,
} = require('../../../shared/session-env-binding-cases.cjs');
const { verifiedRuntime } = require('../../../shared/foreground-resume-browser.cjs');

function names(binding) {
  return (binding?.binding?.desired_profiles ?? []).map((entry) => entry.profile.name);
}

(async () => {
  let owner;
  let duplicate;
  let sessionId;
  try {
    const { runtime, sha } = verifiedRuntime('SC-01');
    const profileA = unique('sc2999-a') + '.env';
    const profileB = unique('sc2999-b') + '.env';
    const sessionName = unique('sc2999-dup');
    const refA = { name: profileA, source: 'server' };
    const refB = { name: profileB, source: 'server' };

    owner = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    await authenticate(owner, 'owner');
    await waitForAgent(owner, 'owner');
    await writeProfile(owner, profileA, 'SC2999_A=alpha\n');
    await writeProfile(owner, profileB, 'SC2999_B=beta\n');

    const created = await createSessionWithProfiles(owner, sessionName, [refA]);
    assert.equal(created.success, true, 'the initial create must succeed: ' + JSON.stringify(created));
    sessionId = created.session_id;
    await waitForSession(owner, sessionId);
    const first = await getBinding(owner, sessionId, unique('sc2999-bind'));
    assert.equal(first.binding?.desired_revision, 1);
    assert.deepEqual(names(first), [profileA]);

    duplicate = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    await authenticate(duplicate, 'duplicate');

    const withProfile = await createSessionWithProfiles(duplicate, sessionName, [refB]);
    assert.equal(withProfile.success, false, 'the duplicate-name create must be refused');
    const afterProfile = await getBinding(owner, sessionId, unique('sc2999-bind'));
    assert.equal(afterProfile.binding?.desired_revision, 1);
    assert.deepEqual(names(afterProfile), [profileA]);
    assert.ok(tmuxHasSession(runtime.tmux_socket, sessionName),
      'the existing tmux Session must survive the refused create');

    const withoutProfile = await createSessionWithProfiles(duplicate, sessionName, []);
    assert.equal(withoutProfile.success, false, 'the no-profile duplicate must be refused');
    const afterEmpty = await getBinding(owner, sessionId, unique('sc2999-bind'));
    assert.equal(afterEmpty.binding?.desired_revision, 1);
    assert.deepEqual(names(afterEmpty), [profileA]);

    emitPass(
      'Exact-SHA full stack kept the live Session and its Profile A binding through a refused same-name create ' +
      'that selected Profile B and one that selected no profiles.',
      [
        { type: 'runtime', value: 'target_sha=' + sha + ' profile=' + runtime.profile },
        { type: 'protocol', value: 'refused duplicate with Profile B: ' + JSON.stringify(withProfile.error ?? null) },
        { type: 'protocol', value: 'refused duplicate without profiles: ' + JSON.stringify(withoutProfile.error ?? null) },
        { type: 'protocol', value: 'binding after refusals: desired_revision=' + afterEmpty.binding.desired_revision + ' profiles=' + names(afterEmpty).join(',') },
        { type: 'runtime', value: 'tmux session ' + sessionName + ' still present' },
      ],
    );
  } catch (error) {
    emitFailure(error);
  } finally {
    if (sessionId && owner) {
      try {
        await killSession(owner, sessionId, unique('sc2999-kill'));
      } catch {
        // The verdict is already recorded; cleanup is best effort.
      }
    }
    owner?.close();
    duplicate?.close();
  }
})();
