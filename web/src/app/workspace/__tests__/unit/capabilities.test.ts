import { describe, expect, it } from 'vitest';
import type { CapabilityId } from '@/features/capabilities';
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
    // what they are, and Claude Code joins them through the same provider shape
    // even though its state comes from observation rather than environment.
    const registry = createWorkspaceCapabilityRegistry(workspaceContext());

    expect(registry.listIds()).toEqual(['files', 'session', 'agent', 'env', 'claude-code']);
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
