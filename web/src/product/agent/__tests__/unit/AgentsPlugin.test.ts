import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPlugin } from '@/product/agent/AgentsPlugin';
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

  describe('protocol directory (#678 Phase 4)', () => {
    const manifest = {
      provider: 'a1',
      protocols: { 'git.status': { versions: [1] } },
    };

    beforeEach(() => {
      plugin.install(surface);
    });

    it('publishes what the list response carried', async () => {
      // Through `listAgents`, not through a pushed `client.agents.list.response`
      // message. That is not a shortcut in the test: `MessageRouter` hands a
      // correlated reply to its pending request and returns, so the response
      // subscription never sees it. A test that pushed the message instead would
      // have passed against a plugin whose directory is empty in production.
      const pending = plugin.listAgents();
      surface.resolveNext('server.agent.list', {
        agents: [{ ...makeAgent('a1'), protocols: manifest }],
      });
      await pending;

      expect(surface.protocols.manifestFor('a1')).toEqual(manifest);
    });

    it('publishes before the caller can address anything to the agent', async () => {
      // Ordering, not style: a caller that awaited the list and immediately made
      // a git call would otherwise resolve against a directory the response had
      // not reached yet, and send the request unversioned.
      surface.protocols.publish(new Map());
      const pending = plugin.listAgents();
      surface.resolveNext('server.agent.list', {
        agents: [{ ...makeAgent('a1'), protocols: manifest }],
      });
      await pending;

      expect(surface.protocols.manifestFor('a1')).toEqual(manifest);
    });

    it('publishes from the push as well, because both paths go through notify', async () => {
      // `agents.changed` is the path a client that never re-lists depends on,
      // and the server now sends `protocols` on it too. If publishing lived at
      // the call sites instead of in `notify`, this is the one that would be
      // forgotten — and forgetting it looks like nothing, because an empty
      // directory resolves as "Legacy Peer" and the calls keep working.
      surface.pushMessage('agents.changed', {
        agents: [{ ...makeAgent('a1'), protocols: manifest }],
      });

      expect(surface.protocols.manifestFor('a1')).toEqual(manifest);
    });

    it('replaces the snapshot, so an agent the server dropped stops resolving', () => {
      surface.pushMessage('agents.changed', {
        agents: [{ ...makeAgent('a1'), protocols: manifest }],
      });
      surface.pushMessage('agents.changed', { agents: [makeAgent('a2')] });

      expect(surface.protocols.manifestFor('a1')).toBeNull();
      expect(surface.protocols.manifestFor('a2')).toBeNull();
    });

    it('writes to the surface it is currently bound to', () => {
      // A rebind re-points publishing at the new connection, which is what
      // stops a replaced transport's manifest from being trusted. The old
      // surface is left holding whatever it had: nothing clears it, and nothing
      // reads it either, because its service went with it.
      const other = createMockPluginSurface();
      plugin.install(other);

      other.pushMessage('agents.changed', {
        agents: [{ ...makeAgent('a1'), protocols: manifest }],
      });

      expect(other.protocols.manifestFor('a1')).toEqual(manifest);
      expect(surface.protocols.manifestFor('a1')).toBeNull();
    });
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
      surfaceB.resolveNext('server.agent.list', { agents: [makeAgent('b1')] });
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

    it('a consumer registered under the newer binding survives a stale teardown', () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB);

      const cb = vi.fn();
      plugin.onAgentsChanged(cb); // registered under B's generation

      teardownA(); // stale release — must not drop B's consumers

      const agents = [makeAgent('b1')];
      surfaceB.pushMessage('agents.changed', { agents });
      expect(cb).toHaveBeenCalledWith(agents);

      teardownB(); // current release — the consumer dies with its binding
      surfaceB.pushMessage('agents.changed', { agents: [makeAgent('b2')] });
      expect(cb).toHaveBeenCalledTimes(1);
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
      expect(surface.requests[0]?.type).toBe('server.agent.list');
      expect(surface.requests[0]?.payload).toEqual({});

      const agents = [makeAgent('a1')];
      surface.resolveNext('server.agent.list', { agents });
      await expect(pending).resolves.toEqual(agents);
    });

    it('propagates transport rejections', async () => {
      const pending = plugin.listAgents();
      surface.rejectNext('server.agent.list', new Error('Connection lost'));
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
        type: 'server.agent.rename',
        payload: { agent_id: 'a1', display_name: 'New Name' },
      });

      const renamed = makeAgent('a1');
      surface.resolveNext('server.agent.rename', { success: true, agent: renamed });
      await expect(pending).resolves.toEqual(renamed);
    });

    it('rejects with the server-provided error text when not successful', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('server.agent.rename', { success: false, error: 'Agent online' });
      await expect(pending).rejects.toThrow('Agent online');
    });

    it('falls back to "Rename failed" when failing without an error message', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('server.agent.rename', { success: false });
      await expect(pending).rejects.toThrow('Rename failed');
    });

    it('falls back to "Rename failed" when the response carries no agent', async () => {
      const pending = plugin.renameAgent('a1', 'New Name');
      surface.resolveNext('server.agent.rename', { success: true });
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
        type: 'server.agent.delete',
        payload: { agent_id: 'a1' },
      });

      surface.resolveNext('server.agent.delete', { success: true });
      await expect(pending).resolves.toBeUndefined();
    });

    it('rejects with the server-provided error text when not successful', async () => {
      const pending = plugin.deleteAgent('a1');
      surface.resolveNext('server.agent.delete', { success: false, error: 'Agent online' });
      await expect(pending).rejects.toThrow('Agent online');
    });

    it('falls back to "Delete failed" without an error message', async () => {
      const pending = plugin.deleteAgent('a1');
      surface.resolveNext('server.agent.delete', { success: false });
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
