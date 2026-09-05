import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeUtf8Base64 } from '@/lib/encoding';
import { SessionsPlugin } from '@/features/sessions/SessionsPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';
import type { Session } from '@/types';

function makeSession(agentId: string, sessionName: string): Session {
  return {
    session_id: `${agentId}:${sessionName}`,
    agent_id: agentId,
    session_name: sessionName,
    status: 'detached',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
  };
}

describe('SessionsPlugin', () => {
  let plugin: SessionsPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new SessionsPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "sessions" capability name', () => {
    expect(plugin.name).toBe('sessions');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      // Requests route to B only.
      const pending = plugin.listSessions();
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('client.sessions.list', { sessions: [makeSession('b', 's1')] });
      await expect(pending).resolves.toEqual([makeSession('b', 's1')]);

      // Consumers registered under B receive events through B.
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      surfaceB.pushMessage('sessions.changed', { sessions: [makeSession('b', 's2')] });
      expect(cb).toHaveBeenCalledWith([makeSession('b', 's2')]);

      // The final teardown detaches the plugin completely.
      teardownB();
      await expect(plugin.listSessions()).rejects.toThrow('sessions feature is not connected');
      const lateCb = vi.fn();
      plugin.onSessionsChanged(lateCb);
      surfaceB.pushMessage('sessions.changed', { sessions: [makeSession('b', 's3')] });
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

  describe('onSessionsChanged', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('fires with the unwrapped list on sessions.changed', () => {
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      const sessions = [makeSession('a', 's1')];
      surface.pushMessage('sessions.changed', { sessions });
      expect(cb).toHaveBeenCalledWith(sessions);
    });

    it('fires on client.sessions.list.response as well (current double-subscribe behavior)', () => {
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      const sessions = [makeSession('a', 's2')];
      surface.pushMessage('client.sessions.list.response', { sessions });
      expect(cb).toHaveBeenCalledWith(sessions);
    });

    it('ignores payloads without a sessions field', () => {
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      surface.pushMessage('sessions.changed', {});
      surface.pushMessage('sessions.changed', { sessions: undefined });
      surface.pushMessage('client.sessions.list.response', { unrelated: true });
      expect(cb).not.toHaveBeenCalled();
    });

    it('the returned unsubscribe stops delivery', () => {
      const cb = vi.fn();
      const unsub = plugin.onSessionsChanged(cb);
      unsub();
      surface.pushMessage('sessions.changed', { sessions: [makeSession('a', 's1')] });
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('fetchSessions', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.sessions.list with an empty payload and fills stale_agents with []', async () => {
      const pending = plugin.fetchSessions();
      expect(surface.requests).toHaveLength(1);
      expect(surface.requests[0]?.type).toBe('client.sessions.list');
      expect(surface.requests[0]?.payload).toEqual({});

      const sessions = [makeSession('a', 's1')];
      surface.resolveNext('client.sessions.list', { sessions });
      await expect(pending).resolves.toEqual({ sessions, stale_agents: [] });
    });

    it('adds agent_id and force to the payload only when truthy', async () => {
      const pending = plugin.fetchSessions({ agentId: 'a1', force: true });
      expect(surface.requests[0]?.payload).toEqual({ agent_id: 'a1', force: true });

      surface.resolveNext('client.sessions.list', { sessions: [], stale_agents: ['a1'] });
      await expect(pending).resolves.toEqual({ sessions: [], stale_agents: ['a1'] });
    });

    it('does not add falsey option keys to the payload', async () => {
      const pending = plugin.fetchSessions({ force: false });
      expect(surface.requests[0]?.payload).toEqual({});
      surface.resolveNext('client.sessions.list', { sessions: [] });
      await expect(pending).resolves.toEqual({ sessions: [], stale_agents: [] });
    });
  });

  describe('listSessions', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('unwraps the sessions list for all agents', async () => {
      const pending = plugin.listSessions();
      expect(surface.requests[0]).toMatchObject({ type: 'client.sessions.list', payload: {} });

      const sessions = [makeSession('a', 's1'), makeSession('a', 's2')];
      surface.resolveNext('client.sessions.list', { sessions });
      await expect(pending).resolves.toEqual(sessions);
    });

    it('forwards the optional agentId filter', async () => {
      const pending = plugin.listSessions('a1');
      expect(surface.requests[0]?.payload).toEqual({ agent_id: 'a1' });
      surface.resolveNext('client.sessions.list', { sessions: [] });
      await expect(pending).resolves.toEqual([]);
    });
  });

  describe('createSession', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.session.create with env_files defaulting to [] and returns the raw response', async () => {
      const pending = plugin.createSession('a1', 'work');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.create',
        payload: { agent_id: 'a1', name: 'work', env_files: [] },
      });

      surface.resolveNext('client.session.create', { success: true, session_id: 'a1:work' });
      await expect(pending).resolves.toEqual({ success: true, session_id: 'a1:work' });
    });

    it('passes env_files through unchanged', async () => {
      const envFiles = [{ name: 'prod.env', source: 'server' as const }];
      const pending = plugin.createSession('a1', 'work', envFiles);
      expect(surface.requests[0]?.payload).toEqual({
        agent_id: 'a1',
        name: 'work',
        env_files: envFiles,
      });

      // Failure responses pass through raw — the caller decides (oracle behavior).
      surface.resolveNext('client.session.create', { success: false, error: 'exists' });
      await expect(pending).resolves.toEqual({ success: false, error: 'exists' });
    });
  });

  describe('killSession', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.session.kill and returns the raw response', async () => {
      const pending = plugin.killSession('a1:work');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.kill',
        payload: { session_id: 'a1:work' },
      });

      surface.resolveNext('client.session.kill', { success: true });
      await expect(pending).resolves.toEqual({ success: true });
    });
  });

  describe('requestAttach', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('sends client.session.attach with preferred_mode p2p by default', async () => {
      const pending = plugin.requestAttach('a1:work');
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.attach',
        payload: { session_id: 'a1:work', preferred_mode: 'p2p' },
      });

      surface.resolveNext('client.session.attach', { mode: 'p2p', session_id: 'a1:work' });
      await expect(pending).resolves.toEqual({ mode: 'p2p', session_id: 'a1:work' });
    });

    it('adds relay_url when relaying', async () => {
      const pending = plugin.requestAttach('a1:work', 'relay', 'wss://relay.example');
      expect(surface.requests[0]?.payload).toEqual({
        session_id: 'a1:work',
        preferred_mode: 'relay',
        relay_url: 'wss://relay.example',
      });
      surface.resolveNext('client.session.attach', {
        mode: 'relay',
        session_id: 'a1:work',
        session_name: 'work',
      });
      await expect(pending).resolves.toEqual({
        mode: 'relay',
        session_id: 'a1:work',
        session_name: 'work',
      });
    });

    it('omits relay_url when not provided', async () => {
      const pending = plugin.requestAttach('a1:work', 'relay');
      expect(surface.requests[0]?.payload).toEqual({
        session_id: 'a1:work',
        preferred_mode: 'relay',
      });
      surface.resolveNext('client.session.attach', { mode: 'relay', session_id: 'a1:work' });
      await expect(pending).resolves.toEqual({ mode: 'relay', session_id: 'a1:work' });
    });
  });

  describe('capturePreview', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('rejects non-positive or fractional line counts without sending', async () => {
      await expect(plugin.capturePreview('a1:work', 0)).rejects.toThrow('Invalid lines: 0');
      await expect(plugin.capturePreview('a1:work', -5)).rejects.toThrow('Invalid lines: -5');
      await expect(plugin.capturePreview('a1:work', 2.5)).rejects.toThrow('Invalid lines: 2.5');
      expect(surface.requests).toHaveLength(0);
    });

    it('decodes the base64 ANSI payload', async () => {
      const pending = plugin.capturePreview('a1:work', 100);
      expect(surface.requests[0]).toMatchObject({
        type: 'client.session.capture_preview',
        payload: { session_id: 'a1:work', lines: 100 },
      });

      const ansi = '[32mhello world[0m';
      surface.resolveNext('client.session.capture_preview', {
        ansi_b64: encodeUtf8Base64(ansi),
        cols: 120,
        rows: 40,
      });
      await expect(pending).resolves.toEqual({ ansi, cols: 120, rows: 40 });
    });

    it('rejects with the server error text', async () => {
      const pending = plugin.capturePreview('a1:work', 100);
      surface.resolveNext('client.session.capture_preview', {
        error: 'session vanished',
      });
      await expect(pending).rejects.toThrow('session vanished');
    });

    it('rejects when no data was returned', async () => {
      const pending = plugin.capturePreview('a1:work', 100);
      surface.resolveNext('client.session.capture_preview', { ansi_b64: undefined });
      await expect(pending).rejects.toThrow('Capture failed: no data returned');
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "sessions feature is not connected" and sends nothing', async () => {
      await expect(plugin.listSessions()).rejects.toThrow('sessions feature is not connected');
      await expect(plugin.fetchSessions()).rejects.toThrow('sessions feature is not connected');
      await expect(plugin.createSession('a1', 'x')).rejects.toThrow(
        'sessions feature is not connected',
      );
      await expect(plugin.killSession('a1:x')).rejects.toThrow('sessions feature is not connected');
      await expect(plugin.requestAttach('a1:x')).rejects.toThrow('sessions feature is not connected');
      await expect(plugin.capturePreview('a1:x', 10)).rejects.toThrow(
        'sessions feature is not connected',
      );
      expect(surface.requests).toHaveLength(0);
    });
  });
});
