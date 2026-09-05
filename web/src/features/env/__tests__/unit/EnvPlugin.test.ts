import { beforeEach, describe, expect, it } from 'vitest';
import { EnvPlugin } from '@/features/env/EnvPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { EnvFileRef } from '@/types';

const serverFile: EnvFileRef = { name: 'prod.env', source: 'server' };
const agentFile: EnvFileRef = { name: 'local.env', source: 'agent', agent_id: 'a1' };

describe('EnvPlugin', () => {
  let plugin: EnvPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new EnvPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "env" capability name', () => {
    expect(plugin.name).toBe('env');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const pending = plugin.listEnvFiles();
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('client.env.list', { files: [] });
      await expect(pending).resolves.toEqual({ files: [] });

      teardownB();
      await expect(plugin.listEnvFiles()).rejects.toThrow('env feature is not connected');
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });
  });

  describe('env file operations', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('listEnvFiles sends client.env.list with an empty payload', async () => {
      const pending = plugin.listEnvFiles();
      expect(surface.requests[0]).toMatchObject({ type: 'client.env.list', payload: {} });

      const file = { name: 'a.env', source: 'server' as const, size: 3, modified: 1, var_count: 1 };
      surface.resolveNext('client.env.list', { files: [file] });
      await expect(pending).resolves.toEqual({ files: [file] });
    });

    it('getEnvFile sends the ref fields and returns the raw response', async () => {
      const pending = plugin.getEnvFile(serverFile);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.env.get',
        payload: { name: 'prod.env', source: 'server', agent_id: undefined },
      });

      surface.resolveNext('client.env.get', { success: true, content: 'A=1', in_use_by: [] });
      await expect(pending).resolves.toEqual({ success: true, content: 'A=1', in_use_by: [] });
    });

    it('getEnvFile includes agent_id for agent-sourced files', async () => {
      const pending = plugin.getEnvFile(agentFile);
      expect(surface.requests[0]?.payload).toEqual({
        name: 'local.env',
        source: 'agent',
        agent_id: 'a1',
      });
      surface.resolveNext('client.env.get', { success: false, error: 'missing' });
      await expect(pending).resolves.toEqual({ success: false, error: 'missing' });
    });

    it('writeEnvFile defaults force to false and passes content/overwrite through', async () => {
      const pending = plugin.writeEnvFile(serverFile, 'A=1', true);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.env.write',
        payload: {
          name: 'prod.env',
          source: 'server',
          agent_id: undefined,
          content: 'A=1',
          overwrite: true,
          force: false,
        },
      });

      surface.resolveNext('client.env.write', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });

    it('writeEnvFile forwards force when set', async () => {
      const pending = plugin.writeEnvFile(agentFile, 'A=1', false, true);
      expect(surface.requests[0]?.payload).toEqual({
        name: 'local.env',
        source: 'agent',
        agent_id: 'a1',
        content: 'A=1',
        overwrite: false,
        force: true,
      });
      surface.resolveNext('client.env.write', {
        success: false,
        error: 'in use',
        in_use_by: ['a1:sess'],
      });
      await expect(pending).resolves.toEqual({ success: false, error: 'in use', in_use_by: ['a1:sess'] });
    });

    it('deleteEnvFile sends the ref fields and returns the raw response', async () => {
      const pending = plugin.deleteEnvFile(serverFile);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.env.delete',
        payload: { name: 'prod.env', source: 'server', agent_id: undefined },
      });

      surface.resolveNext('client.env.delete', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });
  });

  describe('session env operations', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('applySessionEnv sends the session id and env file refs', async () => {
      const pending = plugin.applySessionEnv('a1:work', [serverFile]);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.env.apply',
        payload: { session_id: 'a1:work', env_files: [serverFile] },
      });

      surface.resolveNext('client.session.env.apply', {
        success: true,
        re_sourced: ['prod.env'],
      });
      await expect(pending).resolves.toEqual({ success: true, re_sourced: ['prod.env'] });
    });

    it('unsetSessionEnv sends the session id and env file refs', async () => {
      const pending = plugin.unsetSessionEnv('a1:work', [serverFile]);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.env.unset',
        payload: { session_id: 'a1:work', env_files: [serverFile] },
      });

      surface.resolveNext('client.session.env.unset', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });

    it('getSessionEnvActive sends the session id', async () => {
      const pending = plugin.getSessionEnvActive('a1:work');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.env.active',
        payload: { session_id: 'a1:work' },
      });

      surface.resolveNext('client.session.env.active', { files: [], active: [] });
      await expect(pending).resolves.toEqual({ files: [], active: [] });
    });

    it('queryAgentEnvState sends the session id', async () => {
      const pending = plugin.queryAgentEnvState('a1:work');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.env.query',
        payload: { session_id: 'a1:work' },
      });

      surface.resolveNext('client.session.env.query', { files: [] });
      await expect(pending).resolves.toEqual({ files: [] });
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "env feature is not connected" and sends nothing', async () => {
      await expect(plugin.listEnvFiles()).rejects.toThrow('env feature is not connected');
      await expect(plugin.getEnvFile(serverFile)).rejects.toThrow('env feature is not connected');
      await expect(plugin.writeEnvFile(serverFile, 'A=1', true)).rejects.toThrow(
        'env feature is not connected',
      );
      await expect(plugin.deleteEnvFile(serverFile)).rejects.toThrow('env feature is not connected');
      await expect(plugin.applySessionEnv('a1:work', [])).rejects.toThrow(
        'env feature is not connected',
      );
      await expect(plugin.unsetSessionEnv('a1:work', [])).rejects.toThrow(
        'env feature is not connected',
      );
      await expect(plugin.getSessionEnvActive('a1:work')).rejects.toThrow(
        'env feature is not connected',
      );
      await expect(plugin.queryAgentEnvState('a1:work')).rejects.toThrow(
        'env feature is not connected',
      );
      expect(surface.requests).toHaveLength(0);
    });
  });
});
