import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPlugin } from '@/features/agents/AgentsPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { Agent } from '@/types';

function makeAgent(agentId: string): Agent {
  return {
    agent_id: agentId,
    hostname: `host-${agentId}`,
    ip_address: '127.0.0.1',
    port: 19090,
    status: 'online',
    session_count: 0,
    last_heartbeat: '2026-01-01T00:00:00Z',
  };
}

describe('AgentsPlugin', () => {
  let plugin: AgentsPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new AgentsPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "agents" capability name', () => {
    expect(plugin.name).toBe('agents');
  });

  describe('binding lifecycle', () => {
    it('teardown unsubscribes the change listeners and clears registered consumers', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      const teardown = plugin.install(surface);
      teardown();

      surface.pushMessage('agents.changed', { agents: [makeAgent('a1')] });
      surface.pushMessage('client.agents.list.response', { agents: [makeAgent('a2')] });
      expect(cb).not.toHaveBeenCalled();
    });

    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      // Requests route to B only.
      const pending = plugin.listAgents();
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('client.agents.list', { agents: [makeAgent('b1')] });
      await expect(pending).resolves.toEqual([makeAgent('b1')]);

      // Consumers registered under B receive events through B.
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      surfaceB.pushMessage('agents.changed', { agents: [makeAgent('b2')] });
      expect(cb).toHaveBeenCalledWith([makeAgent('b2')]);

      // The final teardown detaches the plugin completely.
      teardownB();
      await expect(plugin.listAgents()).rejects.toThrow('agents feature is not connected');
      const lateCb = vi.fn();
      plugin.onAgentsChanged(lateCb);
      surfaceB.pushMessage('agents.changed', { agents: [makeAgent('b3')] });
      expect(cb).toHaveBeenCalledTimes(1); // stale consumers were cleared at teardown
      expect(lateCb).not.toHaveBeenCalled(); // no subscription survives on B
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });
  });

  describe('onAgentsChanged', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('fires with the unwrapped list on agents.changed', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      const agents = [makeAgent('a1')];
      surface.pushMessage('agents.changed', { agents });
      expect(cb).toHaveBeenCalledWith(agents);
    });

    it('fires on client.agents.list.response as well (current double-subscribe behavior)', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      const agents = [makeAgent('a2')];
      surface.pushMessage('client.agents.list.response', { agents });
      expect(cb).toHaveBeenCalledWith(agents);
    });

    it('ignores payloads without an agents field', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      surface.pushMessage('agents.changed', {});
      surface.pushMessage('agents.changed', { agents: undefined });
      surface.pushMessage('client.agents.list.response', { unrelated: true });
      expect(cb).not.toHaveBeenCalled();
    });

    it('the returned unsubscribe stops delivery', () => {
      const cb = vi.fn();
      const unsub = plugin.onAgentsChanged(cb);
      unsub();
      surface.pushMessage('agents.changed', { agents: [makeAgent('a1')] });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('listAgents', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.agents.list and resolves with the unwrapped agent list', async () => {
      const pending = plugin.listAgents();
      expect(surface.requests).toHaveLength(1);
      expect(surface.requests[0]?.type).toBe('client.agents.list');
      expect(surface.requests[0]?.payload).toEqual({});

      const agents = [makeAgent('a1')];
      surface.resolveNext('client.agents.list', { agents });
      await expect(pending).resolves.toEqual(agents);
    });

    it('propagates transport rejections', async () => {
      const pending = plugin.listAgents();
      surface.rejectNext('client.agents.list', new Error('Connection lost'));
      await expect(pending).rejects.toThrow('Connection lost');
    });
  });

  describe('renameAgent', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.agent.rename with agent_id and display_name and resolves the agent', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.agent.rename',
        payload: { agent_id: 'a1', display_name: 'New Name' },
      });

      const renamed = makeAgent('a1');
      surface.resolveNext('client.agent.rename', { success: true, agent: renamed });
      await expect(pending).resolves.toEqual(renamed);
    });

    it('rejects with the server-provided error text when not successful', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('client.agent.rename', { success: false, error: 'Agent online' });
      await expect(pending).rejects.toThrow('Agent online');
    });

    it('falls back to "Rename failed" when failing without an error message', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('client.agent.rename', { success: false });
      await expect(pending).rejects.toThrow('Rename failed');
    });

    it('falls back to "Rename failed" when the response carries no agent', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('client.agent.rename', { success: true });
      await expect(pending).rejects.toThrow('Rename failed');
    });
  });

  describe('deleteAgent', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.agent.delete with the agent_id and resolves on success', async () => {
      const pending = plugin.deleteAgent('a1');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.agent.delete',
        payload: { agent_id: 'a1' },
      });

      surface.resolveNext('client.agent.delete', { success: true });
      await expect(pending).resolves.toBeUndefined();
    });

    it('rejects with the server-provided error text when not successful', async () => {
      const pending = plugin.deleteAgent('a1');
      surface.resolveNext('client.agent.delete', { success: false, error: 'Agent online' });
      await expect(pending).rejects.toThrow('Agent online');
    });

    it('falls back to "Delete failed" without an error message', async () => {
      const pending = plugin.deleteAgent('a1');
      surface.resolveNext('client.agent.delete', { success: false });
      await expect(pending).rejects.toThrow('Delete failed');
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "agents feature is not connected" and sends nothing', async () => {
      await expect(plugin.listAgents()).rejects.toThrow('agents feature is not connected');
      await expect(plugin.renameAgent('a1', 'x')).rejects.toThrow('agents feature is not connected');
      await expect(plugin.deleteAgent('a1')).rejects.toThrow('agents feature is not connected');
      expect(surface.requests).toHaveLength(0);
    });
  });
});
