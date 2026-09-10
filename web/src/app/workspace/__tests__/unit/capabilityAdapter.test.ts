import { describe, expect, it, vi } from 'vitest';
import { resolveCapabilityPresences } from '@/features/capabilities';
import {
  createLegacyWorkspaceCapabilityRegistry,
  resolveLegacyWorkspaceCapabilities,
} from '../../capabilities';
import type { WorkspaceContext } from '../../toolTypes';

function workspaceContext(): WorkspaceContext {
  return {
    session: {
      session_id: 'agent-a:dev',
      agent_id: 'agent-a',
      session_name: 'dev',
      status: 'active',
      window_count: 1,
      attached_clients: 1,
      last_activity: '2026-09-10T00:00:00Z',
    },
    agent: undefined,
    agents: [],
    domain: null,
    fileOps: null,
    experience: 'web',
    onToolChange: vi.fn(),
  };
}

describe('legacy WorkspaceTool capability adapter', () => {
  it('adapts existing workspace tools without importing Claude Code into the migration registry', () => {
    const registry = createLegacyWorkspaceCapabilityRegistry(workspaceContext());

    expect(registry.listIds()).toEqual(['files', 'session', 'agent', 'env']);
  });

  it('runs WorkspaceTool -> registry -> snapshot -> presence with scoped state', () => {
    const result = resolveLegacyWorkspaceCapabilities(workspaceContext());

    expect(result.diagnostics).toEqual([]);
    expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual([
      'files',
      'session',
      'agent',
      'env',
    ]);

    const files = result.snapshots.find((snapshot) => snapshot.id === 'files');
    const session = result.snapshots.find((snapshot) => snapshot.id === 'session');

    expect(files).toMatchObject({
      state: 'unavailable',
      scope: {
        locationId: 'agent-a',
        sessionId: 'agent-a:dev',
      },
      views: [{ id: 'workspace-tool:files', label: 'Files' }],
    });
    expect(session?.state).toBe('available');

    const presence = resolveCapabilityPresences(result.snapshots, {
      surface: 'workspace',
    });

    expect(presence.find((item) => item.capabilityId === 'files')?.level).toBe('hidden');
    expect(presence.find((item) => item.capabilityId === 'session')?.level).toBe(
      'discoverable',
    );
  });
});
