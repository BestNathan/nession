'use strict';
// #3649 SC-03: a create request distinguishes inherit from an explicit
// replacement, including the empty list. The Server materializes exactly the
// effective Session-owned binding in declaration order, refuses invalid or
// unavailable selections without an environment fallback, and an omitted mode
// keeps the legacy create behavior.
const assert = require('node:assert/strict');
const {
  AGENT_ID,
  assertBindingOrder,
  closeSocket,
  createProject,
  createProjectSession,
  createSessionRaw,
  deleteProject,
  getBinding,
  openAuthenticatedSocket,
  runCase,
  runtimeFromEnv,
  tmuxEnvironment,
  unique,
  waitForTmuxEnvironment,
  writeProfile,
} = require('../../../shared/project-env-3649-cases.cjs');

runCase(async () => {
  const runtime = runtimeFromEnv();
  const projectName = unique('project-env-sc03');
  const profileA = unique('sc03-a') + '.env';
  const profileB = unique('sc03-b') + '.env';
  const evidence = [];
  const sessions = [];
  let socket = await openAuthenticatedSocket(runtime);
  let project;
  let missingProject;

  try {
    await writeProfile(socket, profileA, 'SC03_A=from-a\nSC03_SHARED=first\n');
    await writeProfile(socket, profileB, 'SC03_B=from-b\nSC03_SHARED=second\n');

    project = await createProject(socket, projectName, runtime.home, [profileA, profileB]);
    evidence.push(
      'Project ' + projectName + ' declares ordered Server references [' +
      profileA + ', ' + profileB + ']',
    );

    const inherited = await createProjectSession(
      socket, project, unique('sc03-inherit'), runtime.home, 'inherit',
    );
    sessions.push(inherited.session_id);
    const inheritedBinding = await getBinding(socket, inherited.session_id, unique('sc03-inherit-get'));
    assertBindingOrder(inheritedBinding, [profileA, profileB], 'inherit');
    await waitForTmuxEnvironment(
      runtime.tmux_socket,
      inherited.session_id.split(':')[1],
      'SC03_SHARED',
      'second',
      'inherit materializes the declared order (later wins)',
    );
    evidence.push(
      'inherit mode created ' + inherited.session_id + ' with desired_revision=' +
      inheritedBinding.binding.desired_revision + ' order=[' + profileA + ',' + profileB +
      '] and tmux SC03_SHARED=second',
    );

    const custom = await createProjectSession(
      socket, project, unique('sc03-custom'), runtime.home, 'replace',
      [{ name: profileB, source: 'server' }],
    );
    sessions.push(custom.session_id);
    const customBinding = await getBinding(socket, custom.session_id, unique('sc03-custom-get'));
    assertBindingOrder(customBinding, [profileB], 'custom replacement');
    await waitForTmuxEnvironment(
      runtime.tmux_socket,
      custom.session_id.split(':')[1],
      'SC03_B',
      'from-b',
      'custom replacement applies its file',
    );
    assert.equal(
      tmuxEnvironment(runtime.tmux_socket, custom.session_id.split(':')[1], 'SC03_A'),
      null,
      'custom replacement must not keep the Project default file',
    );
    evidence.push(
      'replace mode created ' + custom.session_id + ' with order=[' + profileB +
      '], tmux SC03_B=from-b and no SC03_A',
    );

    const none = await createProjectSession(
      socket, project, unique('sc03-none'), runtime.home, 'replace', [],
    );
    sessions.push(none.session_id);
    const noneBinding = await getBinding(socket, none.session_id, unique('sc03-none-get'));
    assert.equal(noneBinding.binding?.desired_revision, 0,
      'explicit empty replacement must bind revision 0');
    assert.deepEqual(noneBinding.binding?.desired_profiles ?? [], [],
      'explicit empty replacement must bind no profiles');
    assert.equal(
      tmuxEnvironment(runtime.tmux_socket, none.session_id.split(':')[1], 'SC03_SHARED'),
      null,
      'explicit empty replacement must not inherit the Project defaults',
    );
    evidence.push(
      'replace mode with env_files=[] created ' + none.session_id +
      ' at desired_revision=0 with no managed SC03_SHARED',
    );

    const legacy = await createProjectSession(
      socket, project, unique('sc03-legacy'), runtime.home, undefined,
    );
    sessions.push(legacy.session_id);
    const legacyBinding = await getBinding(socket, legacy.session_id, unique('sc03-legacy-get'));
    assertBindingOrder(legacyBinding, [profileA, profileB], 'legacy omitted mode');
    evidence.push(
      'omitted mode on ' + legacy.session_id + ' kept the legacy inherit-on-empty order [' +
      profileA + ',' + profileB + ']',
    );

    const contradictory = await createSessionRaw(socket, {
      agent_id: AGENT_ID,
      name: unique('sc03-contradictory'),
      working_dir: runtime.home,
      project_id: project.project_id,
      env_selection_mode: 'inherit',
      env_files: [{ name: profileB, source: 'server' }],
    });
    assert.equal(contradictory?.success, false,
      'inherit plus explicit env_files must be refused');
    assert.match(String(contradictory.error), /cannot be combined with env_files/);
    evidence.push('inherit + env_files refused: ' + contradictory.error);

    const unsupported = await createSessionRaw(socket, {
      agent_id: AGENT_ID,
      name: unique('sc03-unsupported'),
      env_selection_mode: 'append',
    });
    assert.equal(unsupported?.success, false,
      'an unsupported selection mode must be refused');
    assert.match(String(unsupported.error), /must be 'inherit' or 'replace'/);
    evidence.push('unsupported mode refused: ' + unsupported.error);

    const noProject = await createSessionRaw(socket, {
      agent_id: AGENT_ID,
      name: unique('sc03-no-project'),
      env_selection_mode: 'inherit',
    });
    assert.equal(noProject?.success, false, 'inherit without a Project must be refused');
    assert.match(String(noProject.error), /requires a Project/);
    evidence.push('inherit without a Project refused: ' + noProject.error);

    missingProject = await createProject(
      socket, unique('project-env-sc03-missing'), runtime.home, ['missing.env'],
    );
    const missing = await createSessionRaw(socket, {
      agent_id: AGENT_ID,
      name: unique('sc03-missing'),
      working_dir: runtime.home,
      project_id: missingProject.project_id,
      env_selection_mode: 'inherit',
    });
    assert.equal(missing?.success, false,
      'a missing inherited reference must fail the create visibly');
    assert.match(String(missing.error), /Env file not found/);
    evidence.push('missing inherited reference refused: ' + missing.error);

    return {
      summary:
        'inherit, explicit replacement (including the empty list) and the legacy ' +
        'omitted-mode payload produced the exact declared Session binding order; ' +
        'contradictory, unsupported, Project-less and missing-reference creates were refused',
      evidence: [{ type: 'protocol', value: evidence.join('; ') }],
    };
  } finally {
    if (project) {
      try {
        await deleteProject(socket, project);
      } catch {
        // Cleanup only.
      }
    }
    if (missingProject) {
      try {
        await deleteProject(socket, missingProject);
      } catch {
        // Cleanup only.
      }
    }
    await closeSocket(socket, sessions);
  }
});
