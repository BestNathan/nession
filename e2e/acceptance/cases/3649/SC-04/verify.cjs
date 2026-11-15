'use strict';
// #3649 SC-04: editing the Project's defaults, editing a default ENV file, or
// deleting the Project never retroactively changes an existing Session's
// desired/materialized binding. New Sessions see the updated defaults, and an
// explicit Session reapply remains the separate owner of refreshing content.
const assert = require('node:assert/strict');
const {
  assertBindingOrder,
  closeSocket,
  createProject,
  createProjectSession,
  deleteProject,
  getBinding,
  openAuthenticatedSocket,
  runCase,
  runtimeFromEnv,
  setBinding,
  tmuxEnvironment,
  unique,
  updateProject,
  waitForTmuxEnvironment,
  writeProfile,
} = require('../../../shared/project-env-3649-cases.cjs');
const {
  reapplyBinding,
} = require('../../../shared/session-env-binding-cases.cjs');

runCase(async () => {
  const runtime = runtimeFromEnv();
  const profileA = unique('sc04-a') + '.env';
  const profileB = unique('sc04-b') + '.env';
  const evidence = [];
  const sessions = [];
  let socket = await openAuthenticatedSocket(runtime);
  let project;

  try {
    await writeProfile(socket, profileA, 'SC04_A=first\nSC04_SHARED=first\n');
    await writeProfile(socket, profileB, 'SC04_B=second\nSC04_SHARED=second\n');

    project = await createProject(
      socket, unique('project-env-sc04'), runtime.home, [profileA],
    );
    const stable = await createProjectSession(
      socket, project, unique('sc04-stable'), runtime.home, 'inherit',
    );
    sessions.push(stable.session_id);
    const stableBinding = await getBinding(socket, stable.session_id, unique('sc04-stable-get'));
    assertBindingOrder(stableBinding, [profileA], 'initial inherit');
    const stableHash = stableBinding.binding.desired_profiles[0].content_hash;
    await waitForTmuxEnvironment(
      runtime.tmux_socket, stable.session_id.split(':')[1], 'SC04_SHARED', 'first',
      'initial binding materializes the first content',
    );
    evidence.push('Session ' + stable.session_id + ' bound [' + profileA + '] at revision ' +
      stableBinding.binding.desired_revision);

    const updated = await updateProject(socket, project, [profileB]);
    project = updated;
    const afterProjectEdit = await getBinding(socket, stable.session_id, unique('sc04-after-project'));
    assertBindingOrder(afterProjectEdit, [profileA], 'Project-defaults edit');
    assert.equal(afterProjectEdit.binding.desired_profiles[0].content_hash, stableHash,
      'a Project edit must not change the materialized content hash');
    assert.equal(
      tmuxEnvironment(runtime.tmux_socket, stable.session_id.split(':')[1], 'SC04_SHARED'),
      'first',
      'a Project defaults edit must not mutate the existing Session tmux environment',
    );
    evidence.push('editing Project defaults to [' + profileB +
      '] left ' + stable.session_id + ' desired=[' + profileA + '] and tmux SC04_SHARED=first');

    const fresh = await createProjectSession(
      socket, project, unique('sc04-fresh'), runtime.home, 'inherit',
    );
    sessions.push(fresh.session_id);
    const freshBinding = await getBinding(socket, fresh.session_id, unique('sc04-fresh-get'));
    assertBindingOrder(freshBinding, [profileB], 'new Session after Project edit');
    await waitForTmuxEnvironment(
      runtime.tmux_socket, fresh.session_id.split(':')[1], 'SC04_B', 'second',
      'a new Session sees the updated defaults',
    );
    evidence.push('new Session ' + fresh.session_id + ' inherited the updated [' + profileB + ']');

    await writeProfile(socket, profileA, 'SC04_A=updated\nSC04_SHARED=updated\n');
    const afterFileEdit = await getBinding(socket, stable.session_id, unique('sc04-after-file'));
    assertBindingOrder(afterFileEdit, [profileA], 'ENV file edit');
    assert.equal(afterFileEdit.binding.desired_profiles[0].content_hash, stableHash,
      'an ENV file edit must not rewrite the Session binding without reapply');
    assert.equal(
      tmuxEnvironment(runtime.tmux_socket, stable.session_id.split(':')[1], 'SC04_SHARED'),
      'first',
      'an ENV file edit must not automatically re-materialize the Session',
    );
    evidence.push('editing default file ' + profileA +
      ' left the existing binding revision and tmux value unchanged');

    const reapplied = await reapplyBinding(socket, stable.session_id, unique('sc04-reapply'));
    assert.ok(reapplied.binding.desired_revision > stableBinding.binding.desired_revision,
      'explicit reapply must advance the revision');
    await waitForTmuxEnvironment(
      runtime.tmux_socket, stable.session_id.split(':')[1], 'SC04_SHARED', 'updated',
      'explicit reapply materializes the edited file',
    );
    evidence.push('explicit reapply advanced ' + stable.session_id +
      ' to revision ' + reapplied.binding.desired_revision + ' and materialized SC04_SHARED=updated');

    // The explicit custom replacement is also independent of later Project edits.
    const custom = await createProjectSession(
      socket, project, unique('sc04-custom'), runtime.home, 'replace',
      [{ name: profileA, source: 'server' }],
    );
    sessions.push(custom.session_id);
    await updateProject(socket, project, []);
    const customAfter = await getBinding(socket, custom.session_id, unique('sc04-custom-get'));
    assertBindingOrder(customAfter, [profileA], 'custom replacement after Project edit');
    evidence.push('explicit custom Session ' + custom.session_id +
      ' stayed [' + profileA + '] after the Project defaults were cleared');

    await deleteProject(socket, project);
    project = undefined;
    const afterDelete = await getBinding(socket, stable.session_id, unique('sc04-after-delete'));
    assertBindingOrder(afterDelete, [profileA], 'binding after Project deletion');
    assert.equal(
      tmuxEnvironment(runtime.tmux_socket, stable.session_id.split(':')[1], 'SC04_SHARED'),
      'updated',
      'Project deletion must not revoke the Session environment',
    );
    evidence.push('deleting the Project left both Session bindings and tmux state intact');

    return {
      summary:
        'Project defaults edits, ENV file edits and Project deletion left existing ' +
        'Session bindings and tmux environments unchanged; new Sessions saw updated ' +
        'defaults and explicit reapply remained the only content refresh',
      evidence: [{ type: 'runtime', value: evidence.join('; ') }],
    };
  } finally {
    if (project) {
      try {
        await deleteProject(socket, project);
      } catch {
        // Cleanup only.
      }
    }
    await closeSocket(socket, sessions);
  }
});
