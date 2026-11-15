'use strict';
// Shared exact-SHA steps for the #3649 Project ENV default Cases.
//
// One socket owner remains `session-env-binding-cases.cjs`: this module only
// adds Project CRUD and the create-time selection-mode request, so SC-03 and
// SC-04 exercise the same real Server/Agent/tmux path the binding Cases use.
const assert = require('node:assert/strict');
const {
  AGENT_ID,
  authenticate,
  emitFailure,
  emitPass,
  getBinding,
  killSession,
  openSocket,
  request,
  runtimeFromEnv,
  setBinding,
  tmuxEnvironment,
  unique,
  waitForAgent,
  waitForSession,
  waitForTmuxEnvironment,
  writeProfile,
} = require('./session-env-binding-cases.cjs');

function runCase(fn) {
  fn()
    .then(({ summary, evidence }) => emitPass(summary, evidence))
    .catch((error) => emitFailure(error));
}

async function openAuthenticatedSocket(runtime) {
  const socket = await openSocket('ws://127.0.0.1:' + runtime.server_port + '/ws');
  await authenticate(socket, 'project-env-3649');
  await waitForAgent(socket, 'project-env-3649');
  return socket;
}

function projectPayload(name, locationPath, envProfileIds) {
  return {
    name,
    locations: [{ agent_id: AGENT_ID, path: locationPath }],
    session_defaults:
      envProfileIds === undefined
        ? undefined
        : { env_profile_ids: envProfileIds },
  };
}

async function createProject(socket, name, locationPath, envProfileIds) {
  const reply = await request(
    socket,
    'server.project.create',
    projectPayload(name, locationPath, envProfileIds),
    unique('project-env-create-' + name),
  );
  assert.equal(reply.payload?.success, true,
    'Project create failed: ' + JSON.stringify(reply.payload));
  const project = reply.payload?.project;
  assert.ok(project?.project_id, 'Project create must answer a project');
  return project;
}

async function updateProject(socket, project, envProfileIds) {
  const reply = await request(
    socket,
    'server.project.update',
    {
      project_id: project.project_id,
      name: project.name,
      description: project.description ?? null,
      source: project.source ?? null,
      locations: project.locations,
      session_defaults:
        envProfileIds === undefined
          ? null
          : { env_profile_ids: envProfileIds },
      image_digest: project.image_digest ?? null,
    },
    unique('project-env-update'),
  );
  assert.equal(reply.payload?.success, true,
    'Project update failed: ' + JSON.stringify(reply.payload));
  return reply.payload.project;
}

async function deleteProject(socket, project) {
  const reply = await request(
    socket,
    'server.project.delete',
    { project_id: project.project_id },
    unique('project-env-delete'),
  );
  assert.equal(reply.payload?.success, true,
    'Project delete failed: ' + JSON.stringify(reply.payload));
}

/** One raw create; a refusal is data, not a thrown error. */
async function createSessionRaw(socket, payload) {
  const reply = await request(
    socket,
    'server.session.create',
    payload,
    unique('project-env-session-create'),
    45_000,
  );
  return reply.payload;
}

async function createProjectSession(socket, project, name, workingDir, mode, envFiles) {
  const payload = {
    agent_id: AGENT_ID,
    name,
    working_dir: workingDir,
    project_id: project.project_id,
    env_files: envFiles ?? [],
  };
  if (mode !== undefined) {
    payload.env_selection_mode = mode;
  }
  const reply = await createSessionRaw(socket, payload);
  assert.equal(reply?.success, true,
    'Session create failed: ' + JSON.stringify(reply));
  await waitForSession(socket, reply.session_id);
  return reply;
}

function bindingNames(response) {
  return (response.binding?.desired_profiles ?? []).map((entry) => entry.profile.name);
}

function assertBindingOrder(response, names, label) {
  assert.deepEqual(bindingNames(response), names, label + ' binding order');
}

async function closeSocket(socket, sessionIds) {
  for (const sessionId of sessionIds) {
    try {
      await killSession(socket, sessionId, unique('project-env-kill'));
    } catch {
      // The verdict already exists; cleanup is best-effort.
    }
  }
  socket.close();
}

module.exports = {
  AGENT_ID,
  assertBindingOrder,
  bindingNames,
  closeSocket,
  createProject,
  createProjectSession,
  createSessionRaw,
  deleteProject,
  getBinding,
  openAuthenticatedSocket,
  request,
  runCase,
  runtimeFromEnv,
  setBinding,
  tmuxEnvironment,
  unique,
  updateProject,
  waitForTmuxEnvironment,
  writeProfile,
};
