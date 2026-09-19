import { describe, expect, it } from 'vitest';
import type { CapabilityId } from '@/product/capability';
import {
  createWorkspaceCapabilityRegistry,
  resolveWorkspaceCapabilities,
} from '../../capabilities';
import type { WorkspaceContext } from '../../workspaceContext';

function workspaceContext(overrides: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    session: {
      session_id: 'agent-a:dev',
      agent_id: 'agent-a',
      session_name: 'dev',
    } as never,
    agent: { agent_id: 'agent-a' } as never,
    agents: [],
    domain: null,
    fileOps: {} as never,
    experience: 'web',
    onToolChange: () => {},
    ...overrides,
  };
}

function snapshotFor(id: CapabilityId, ctx: WorkspaceContext) {
  return resolveWorkspaceCapabilities(ctx).snapshots.find((snapshot) => snapshot.id === id);
}

describe('workspace capability providers', () => {
  it('registers every workspace capability once, in a stable order', () => {
    // One registry, no compatibility path: Files/Session/Agent/Env each state
    // what they are, and Claude Code and Git join them through their own
    // provider shapes — observation for one, the Session alone for the other.
    const registry = createWorkspaceCapabilityRegistry(workspaceContext());

    expect(registry.listIds()).toEqual([
      'files',
      'session',
      'agent',
      'env',
      'claude-code',
      'git',
      'terminal-keys',
    ]);
  });

  it('reports Git as available for a Session and unavailable without one', () => {
    // Presence deliberately does not guess whether the directory is a
    // repository — that answer costs a round trip and belongs to the view, so
    // #750 SC4's four failure states stay reachable instead of collapsing into
    // a hidden capability.
    expect(snapshotFor('git', workspaceContext())?.state).toBe('available');
    expect(snapshotFor('git', workspaceContext({ session: null }))?.state).toBe('unavailable');
  });

  it('resolves scope from the workspace context, not from the provider', () => {
    expect(snapshotFor('session', workspaceContext())?.scope).toEqual({
      workspaceId: undefined,
      locationId: 'agent-a',
      sessionId: 'agent-a:dev',
    });
  });

  it('falls back to the session agent when no agent is selected', () => {
    const ctx = workspaceContext({ agent: undefined });

    expect(snapshotFor('session', ctx)?.scope.locationId).toBe('agent-a');
  });

  it('marks a capability unavailable when the environment cannot offer it', () => {
    const ctx = workspaceContext({ fileOps: null });

    expect(snapshotFor('files', ctx)?.state).toBe('unavailable');
    expect(snapshotFor('session', ctx)?.state).toBe('available');
  });

  it('resolves the whole workspace without diagnostics', () => {
    expect(resolveWorkspaceCapabilities(workspaceContext()).diagnostics).toEqual([]);
  });
});
