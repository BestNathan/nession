import { ProtocolDirectory } from '@/platform/protocol';
import type { PluginSurface } from '@/platform/socket/types';
import {
  workspaceApi,
  type AgentWorkspaceDescriptor,
} from '@/capabilities/sandbox';

const CREATED_AT = 1_760_000_000;

interface FixtureWorkspacesState {
  workspaces: AgentWorkspaceDescriptor[];
  created: number;
}

function seed(): FixtureWorkspacesState {
  return {
    created: 0,
    workspaces: [
      {
        workspace_id: 'ws_00000000-0000-4000-8000-000000000001',
        name: 'fixture-workspace',
        namespace: 'default',
        kind: 'managed',
        status: 'available',
        auto_created: false,
        created_at: CREATED_AT,
        last_used_at: CREATED_AT + 60,
        updated_at: CREATED_AT + 60,
        lower_digests: [
          `sha256:${'c'.repeat(64)}`,
        ],
        overlay_storage: true,
        used_bytes: 2_097_152,
        consumers: [],
        mounted: false,
        lease_count: 0,
      },
      {
        workspace_id: 'ws_00000000-0000-4000-8000-000000000002',
        name: 'fixture-session-auto',
        namespace: 'default',
        kind: 'managed',
        status: 'in_use',
        auto_created: true,
        created_at: CREATED_AT,
        last_used_at: CREATED_AT + 120,
        updated_at: CREATED_AT + 120,
        lower_digests: [
          `sha256:${'d'.repeat(64)}`,
          `sha256:${'e'.repeat(64)}`,
        ],
        overlay_storage: true,
        used_bytes: 4_194_304,
        consumers: ['fixture-session'],
        mounted: true,
        lease_count: 1,
        detail: 'Leased by the active execution.',
      },
      {
        workspace_id: 'project_location:devbox-01:/Users/nathan/code/nession',
        name: 'nession',
        namespace: 'project:project-00000000-0000-4000-8000-000000000001',
        kind: 'project_location',
        status: 'unobserved',
        auto_created: false,
        created_at: CREATED_AT,
        last_used_at: CREATED_AT + 180,
        updated_at: CREATED_AT + 180,
        path: '/Users/nathan/code/nession',
        detail:
          'User-owned Project Existing Location; the Agent never creates, copies or deletes it.',
      },
    ],
  };
}

/**
 * A canned Agent Workspace registry for the fixture (#3407, #3408).
 *
 * The list/create/delete semantics mirror the Agent's contract: create is
 * idempotent by name, and delete is refused while the Workspace is leased.
 * It is not a second registry authority.
 */
function answerWorkspaces(
  state: FixtureWorkspacesState,
  type: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (type === 'server.workspace.list') {
    return Promise.resolve({
      success: true,
      workspaces: state.workspaces.map((workspace) => ({ ...workspace })),
    });
  }
  if (type === 'server.workspace.create') {
    const name = String(payload.name ?? '').trim();
    if (name.length === 0) {
      return Promise.resolve({ success: false, error: 'Workspace name is required' });
    }
    const existing = state.workspaces.find(
      (workspace) => workspace.namespace === 'default' && workspace.name === name,
    );
    if (existing) {
      return Promise.resolve({ success: true, workspace: { ...existing } });
    }
    state.created += 1;
    const workspace: AgentWorkspaceDescriptor = {
      workspace_id: `ws_00000000-0000-4000-8000-00000000${String(1000 + state.created).slice(-4)}`,
      name,
      namespace: 'default',
      kind: 'managed',
      status: 'available',
      auto_created: payload.auto_created === true,
      created_at: CREATED_AT + state.created,
      last_used_at: CREATED_AT + state.created,
    };
    state.workspaces = [...state.workspaces, workspace];
    return Promise.resolve({ success: true, workspace: { ...workspace } });
  }
  if (type === 'server.workspace.delete') {
    const workspaceId = String(payload.workspace_id ?? '');
    const workspace = state.workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) {
      return Promise.resolve({ success: false, error: 'Workspace not found' });
    }
    if (workspace.kind === 'project_location') {
      return Promise.resolve({
        success: false,
        error: 'Project Existing Locations are user-owned and never deleted here',
      });
    }
    if (workspace.status === 'in_use') {
      return Promise.resolve({
        success: false,
        error: 'Workspace is leased by an execution and cannot be deleted',
      });
    }
    state.workspaces = state.workspaces.filter((item) => item.workspace_id !== workspaceId);
    return Promise.resolve({ success: true });
  }
  return Promise.reject(new Error(`fixture Workspace surface does not answer ${type}`));
}

export function fixtureWorkspacesSurface(): PluginSurface {
  const state = seed();
  return {
    connectionState: 'connected',
    protocols: new ProtocolDirectory(),
    send: () => undefined,
    subscribe: () => () => undefined,
    onBinary: () => () => undefined,
    waitForConnection: () => Promise.resolve(),
    onConnectionStateChange: () => () => undefined,
    request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
      return answerWorkspaces(state, type, payload) as Promise<T>;
    },
  };
}

/** Bind the Workspace transport for a fixture route's lifetime. */
export function installWorkspaceSurface(): () => void {
  return workspaceApi.install(fixtureWorkspacesSurface());
}
