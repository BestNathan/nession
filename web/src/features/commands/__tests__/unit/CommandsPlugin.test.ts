import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandsPlugin } from '@/features/commands/CommandsPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

describe('CommandsPlugin', () => {
  let plugin: CommandsPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new CommandsPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "commands" capability name', () => {
    expect(plugin.name).toBe('commands');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      // Requests route to B only.
      const pending = plugin.listCommands();
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('client.commands.list', { commands: [] });
      await expect(pending).resolves.toEqual({ commands: [] });

      // Consumers registered under B receive events through B.
      const cb = vi.fn();
      plugin.onCommandsChanged(cb);
      surfaceB.pushMessage('server.commands.changed', {});
      expect(cb).toHaveBeenCalledTimes(1);

      // The final teardown detaches the plugin completely.
      teardownB();
      await expect(plugin.listCommands()).rejects.toThrow('commands feature is not connected');
      const lateCb = vi.fn();
      plugin.onCommandsChanged(lateCb);
      surfaceB.pushMessage('server.commands.changed', {});
      expect(cb).toHaveBeenCalledTimes(1); // stale consumers were cleared at teardown
      expect(lateCb).not.toHaveBeenCalled(); // no subscription survives on B
    });

    it('a consumer registered under the newer binding survives a stale teardown', () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB);

      const cb = vi.fn();
      plugin.onCommandsChanged(cb); // registered under B's generation

      teardownA(); // stale release — must not drop B's consumers

      surfaceB.pushMessage('server.commands.changed', {});
      expect(cb).toHaveBeenCalledTimes(1);

      teardownB(); // current release — the consumer dies with its binding
      surfaceB.pushMessage('server.commands.changed', {});
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

  describe('onCommandsChanged', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('fires with no arguments on server.commands.changed', () => {
      const cb = vi.fn();
      plugin.onCommandsChanged(cb);
      surface.pushMessage('server.commands.changed', { whatever: true });
      expect(cb).toHaveBeenCalledWith();
    });

    it('the returned unsubscribe stops delivery', () => {
      const cb = vi.fn();
      const unsub = plugin.onCommandsChanged(cb);
      unsub();
      surface.pushMessage('server.commands.changed', {});
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('command CRUD', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('listCommands sends client.commands.list with an empty payload', async () => {
      const pending = plugin.listCommands();
      expect(surface.requests[0]).toMatchObject({ type: 'client.commands.list', payload: {} });

      surface.resolveNext('client.commands.list', {
        commands: [{ id: 'c1', label: 'Deploy', command: 'make deploy' }],
      });
      await expect(pending).resolves.toEqual({
        commands: [{ id: 'c1', label: 'Deploy', command: 'make deploy' }],
      });
    });

    it('addCommand defaults raw to false', async () => {
      const pending = plugin.addCommand('Deploy', 'make deploy');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.commands.add',
        payload: { label: 'Deploy', command: 'make deploy', raw: false },
      });

      surface.resolveNext('client.commands.add', { success: true, id: 'c1' });
      await expect(pending).resolves.toEqual({ success: true, id: 'c1' });
    });

    it('addCommand forwards raw when set', async () => {
      const pending = plugin.addCommand('Deploy', 'make deploy', true);
      expect(surface.requests[0]?.payload).toEqual({
        label: 'Deploy',
        command: 'make deploy',
        raw: true,
      });
      surface.resolveNext('client.commands.add', { success: false, error: 'dupe' });
      await expect(pending).resolves.toEqual({ success: false, error: 'dupe' });
    });

    it('removeCommand sends the id', async () => {
      const pending = plugin.removeCommand('c1');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.commands.remove',
        payload: { id: 'c1' },
      });

      surface.resolveNext('client.commands.remove', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });

    it('updateCommand merges only the provided fields', async () => {
      const pending = plugin.updateCommand('c1', { label: 'Renamed' });
      expect(surface.requests[0]?.payload).toEqual({ id: 'c1', label: 'Renamed' });

      surface.resolveNext('client.commands.update', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });

    it('updateCommand forwards raw: false explicitly when requested', async () => {
      const pending = plugin.updateCommand('c1', { raw: false });
      expect(surface.requests[0]?.payload).toEqual({ id: 'c1', raw: false });
      surface.resolveNext('client.commands.update', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });

    it('propagates transport rejections', async () => {
      const pending = plugin.listCommands();
      surface.rejectNext('client.commands.list', new Error('Connection lost'));
      await expect(pending).rejects.toThrow('Connection lost');
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "commands feature is not connected" and sends nothing', async () => {
      await expect(plugin.listCommands()).rejects.toThrow('commands feature is not connected');
      await expect(plugin.addCommand('a', 'b')).rejects.toThrow('commands feature is not connected');
      await expect(plugin.removeCommand('c1')).rejects.toThrow('commands feature is not connected');
      await expect(plugin.updateCommand('c1', { label: 'x' })).rejects.toThrow(
        'commands feature is not connected',
      );
      expect(surface.requests).toHaveLength(0);
    });
  });
});
