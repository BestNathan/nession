'use strict';
// #2999 SC-02: two coordinated same-name creates (one accepted, one refused)
// cannot erase or replace the accepted Session's binding. Includes the delayed
// case where the refusal settles after the accepted create is already bound.
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
  let other;
  const created = [];
  try {
    const { runtime, sha } = verifiedRuntime('SC-02');
    const profileA = unique('sc2999-a') + '.env';
    const profileB = unique('sc2999-b') + '.env';
    const refA = { name: profileA, source: 'server' };
    const refB = { name: profileB, source: 'server' };

    owner = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    await authenticate(owner, 'owner');
    await waitForAgent(owner, 'owner');
    other = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
    await authenticate(other, 'other');
    await writeProfile(owner, profileA, 'SC2999_A=alpha\n');
    await writeProfile(owner, profileB, 'SC2999_B=beta\n');

    // Concurrent attempts on the same fresh name: the Agent accepts exactly one.
    const raceName = unique('sc2999-race');
    const [replyA, replyB] = await Promise.all([
      createSessionWithProfiles(owner, raceName, [refA]),
      createSessionWithProfiles(other, raceName, [refB]),
    ]);
    const successCount = [replyA.success, replyB.success].filter(Boolean).length;
    assert.equal(successCount, 1,
      'exactly one coordinated create must succeed: ' + JSON.stringify([replyA, replyB]));
    const accepted = replyA.success
      ? { profile: profileA, reply: replyA }
      : { profile: profileB, reply: replyB };
    const refused = replyA.success ? replyB : replyA;
    assert.equal(refused.success, false);

    const raceId = accepted.reply.session_id;
    assert.ok(raceId, 'the accepted create must answer a session_id');
    await waitForSession(owner, raceId);
    created.push(raceId);
    const raceBinding = await getBinding(owner, raceId, unique('sc2999-race-bind'));
    assert.equal(raceBinding.binding?.desired_revision, 1);
    assert.deepEqual(names(raceBinding), [accepted.profile]);
    assert.ok(tmuxHasSession(runtime.tmux_socket, raceName),
      'the accepted Session must exist in tmux');

    // Delayed refusal: the accepted create is already bound when the duplicate
    // is attempted. The refusal must leave that binding untouched.
    const delayedName = unique('sc2999-delayed');
    const first = await createSessionWithProfiles(owner, delayedName, [refA]);
    assert.equal(first.success, true, 'the delayed scenario create must succeed');
    await waitForSession(owner, first.session_id);
    created.push(first.session_id);
    const delayedRefusal = await createSessionWithProfiles(other, delayedName, [refB]);
    assert.equal(delayedRefusal.success, false);
    const delayedBinding = await getBinding(owner, first.session_id, unique('sc2999-delayed-bind'));
    assert.equal(delayedBinding.binding?.desired_revision, 1);
    assert.deepEqual(names(delayedBinding), [profileA]);

    emitPass(
      'Exact-SHA full stack accepted one of two coordinated same-name creates and kept its binding; a later ' +
      'refused duplicate did not erase it.',
      [
        { type: 'runtime', value: 'target_sha=' + sha + ' profile=' + runtime.profile },
        { type: 'protocol', value: 'coordinated replies success=' + [replyA.success, replyB.success].join(',') + ' accepted=' + accepted.profile },
        { type: 'protocol', value: 'accepted binding: desired_revision=' + raceBinding.binding.desired_revision + ' profiles=' + names(raceBinding).join(',') },
        { type: 'protocol', value: 'delayed refused duplicate success=false; binding still ' + names(delayedBinding).join(',') },
        { type: 'runtime', value: 'tmux Sessions ' + raceName + ' and ' + delayedName + ' still present' },
      ],
    );
  } catch (error) {
    emitFailure(error);
  } finally {
    for (const sessionId of created) {
      try {
        await killSession(owner, sessionId, unique('sc2999-kill'));
      } catch {
        // The verdict is already recorded; cleanup is best effort.
      }
    }
    owner?.close();
    other?.close();
  }
})();
