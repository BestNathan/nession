import { beforeEach, describe, expect, it } from 'vitest';
import { ServerPlugin } from '@/features/server/ServerPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { ServerInfo } from '@/types';

function makeServerInfo(): ServerInfo {
  return {
    version: '1.2.3',
    uptime_seconds: 3600,
    agent_count: 2,
    online_agent_count: 1,
    session_count: 4,
  };
}

describe('ServerPlugin', () => {
  let plugin: ServerPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new ServerPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "server" capability name', () => {
    expect(plugin.name).toBe('server');
  });

  describe('serverInfo', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.server.info with an empty payload and resolves the info', async () => {
      const pending = plugin.serverInfo();
      expect(surface.requests).toHaveLength(1);
      expect(surface.requests[0]?.type).toBe('client.server.info');
      expect(surface.requests[0]?.payload).toEqual({});

      const info = makeServerInfo();
      surface.resolveNext('client.server.info', info);
      await expect(pending).resolves.toEqual(info);
    });

    it('propagates transport rejections', async () => {
      const pending = plugin.serverInfo();
      surface.rejectNext('client.server.info', new Error('Connection lost'));
      await expect(pending).rejects.toThrow('Connection lost');
    });
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      // Requests route to B only.
      const pending = plugin.serverInfo();
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('client.server.info', makeServerInfo());
      await expect(pending).resolves.toEqual(makeServerInfo());

      // The final teardown detaches the plugin completely.
      teardownB();
      await expect(plugin.serverInfo()).rejects.toThrow('server feature is not connected');
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });
  });

  describe('unbound plugin', () => {
    it('rejects serverInfo with "server feature is not connected" and sends nothing', async () => {
      await expect(plugin.serverInfo()).rejects.toThrow('server feature is not connected');
      expect(surface.requests).toHaveLength(0);
    });
  });
});
