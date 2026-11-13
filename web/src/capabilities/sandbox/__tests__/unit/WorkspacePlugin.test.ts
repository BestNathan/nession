import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspacePlugin, type AgentWorkspaceDescriptor } from '../../WorkspacePlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

const WORKSPACE: AgentWorkspaceDescriptor = {
  workspace_id: 'ws_123e4567-e89b-42d3-a456-426614174000',
  name: 'fix-terminal',
  namespace: 'default',
  kind: 'managed',
  status: 'available',
  auto_created: true,
  created_at: 1,
  last_used_at: 2,
};

describe('WorkspacePlugin', () => {
  let plugin: WorkspacePlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new WorkspacePlugin();
    surface = createMockPluginSurface();
  });

  it('names its transport and refuses before installation', async () => {
    expect(plugin.name).toBe('workspaces');
    await expect(plugin.list('a1:s1')).rejects.toThrow('not connected');
  });

  it('lists, creates and deletes through the Session units', async () => {
    const release = plugin.install(surface);
    const list = plugin.list('a1:s1');
    expect(surface.requests[0]?.payload).toEqual({ session_id: 'a1:s1' });
    surface.resolveNext('server.workspace.list', {
      success: true,
      workspaces: [WORKSPACE],
    });
    await expect(list).resolves.toEqual([WORKSPACE]);

    const create = plugin.create('a1:s1', 'fix-terminal', { autoCreated: true });
    expect(
      surface.requests.find((request) => request.type === 'server.workspace.create')
        ?.payload,
    ).toEqual({
      session_id: 'a1:s1',
      name: 'fix-terminal',
      auto_created: true,
    });
    surface.resolveNext('server.workspace.create', {
      success: true,
      workspace: WORKSPACE,
    });
    await expect(create).resolves.toEqual(WORKSPACE);

    const remove = plugin.remove('a1:s1', WORKSPACE.workspace_id);
    expect(
      surface.requests.find((request) => request.type === 'server.workspace.delete')
        ?.payload,
    ).toEqual({
      session_id: 'a1:s1',
      workspace_id: WORKSPACE.workspace_id,
    });
    surface.resolveNext('server.workspace.delete', { success: true });
    await expect(remove).resolves.toBeUndefined();
    release();
  });

  it('surfaces an Agent refusal without inventing state', async () => {
    plugin.install(surface);
    const create = plugin.create('a1:s1', 'taken');
    surface.resolveNext('server.workspace.create', {
      success: false,
      error: 'workspace is in use',
    });
    await expect(create).rejects.toThrow('workspace is in use');
  });
});
