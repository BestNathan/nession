import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RequestPlugin } from '@/services/websocket/plugins/RequestPlugin';
import type { WebSocketServiceCore } from '@/services/websocket/types';

function createMockCore(authenticated = true): WebSocketServiceCore {
  const status: 'authenticated' | 'connected' = authenticated ? 'authenticated' : 'connected';
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    isAuthenticated: vi.fn(() => authenticated),
    getConnectionStatus: vi.fn(() => status),
    onConnectionChange: vi.fn(() => vi.fn()),
    send: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    request: vi.fn(),
    generateMessageId: vi.fn(() => 'msg_req_1'),
    getP2PConnectionInfo: vi.fn(),
  };
}

describe('RequestPlugin', () => {
  let plugin: RequestPlugin;
  let core: WebSocketServiceCore;

  beforeEach(() => {
    plugin = new RequestPlugin();
    core = createMockCore();
    plugin.install(core);
    vi.clearAllMocks();
  });

  it('has name "requests"', () => {
    expect(plugin.name).toBe('requests');
  });

  // ── Auth guard ──────────────────────────────────────────────

  describe('requireAuth guard', () => {
    it('throws when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.listAgents()).rejects.toThrow('Not authenticated');
    });

    it('throws on createSession when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.createSession('a', 's')).rejects.toThrow('Not authenticated');
    });

    it('throws on killSession when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.killSession('s')).rejects.toThrow('Not authenticated');
    });

    it('throws on listEnvFiles when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.listEnvFiles()).rejects.toThrow('Not authenticated');
    });

    it('throws on listCommands when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.listCommands()).rejects.toThrow('Not authenticated');
    });

    it('throws on serverInfo when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.serverInfo()).rejects.toThrow('Not authenticated');
    });
  });

  // ── Agents ──────────────────────────────────────────────────

  describe('listAgents', () => {
    it('requests client.agents.list and returns agents array', async () => {
      const agents = [{ agent_id: 'a1', hostname: 'h1', ip_address: '1.2.3.4', port: 19090, status: 'online' as const, session_count: 0, last_heartbeat: '2026-01-01T00:00:00Z' }];
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ agents });
      const result = await plugin.listAgents();
      expect(result).toEqual(agents);
      expect(core.request).toHaveBeenCalledWith('client.agents.list', {});
    });
  });

  describe('renameAgent', () => {
    it('returns agent on success', async () => {
      const agent = { agent_id: 'a1', hostname: 'h1', ip_address: '1.2.3.4', port: 19090, status: 'online' as const, session_count: 0, last_heartbeat: 'x', display_name: 'New' };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, agent });
      const result = await plugin.renameAgent('a1', 'New');
      expect(result).toEqual(agent);
      expect(core.request).toHaveBeenCalledWith('client.agent.rename', { agent_id: 'a1', display_name: 'New' });
    });

    it('passes null display_name for clear', async () => {
      const agent = { agent_id: 'a1', hostname: 'h1', ip_address: '1.2.3.4', port: 19090, status: 'online' as const, session_count: 0, last_heartbeat: 'x' };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, agent });
      await plugin.renameAgent('a1', null);
      expect(core.request).toHaveBeenCalledWith('client.agent.rename', { agent_id: 'a1', display_name: null });
    });

    it('throws on failure response', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'No such agent' });
      await expect(plugin.renameAgent('a1', 'X')).rejects.toThrow('No such agent');
    });

    it('throws generic error when no message provided', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false });
      await expect(plugin.renameAgent('a1', 'X')).rejects.toThrow('Rename failed');
    });
  });

  describe('deleteAgent', () => {
    it('resolves on success', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await expect(plugin.deleteAgent('a1')).resolves.toBeUndefined();
      expect(core.request).toHaveBeenCalledWith('client.agent.delete', { agent_id: 'a1' });
    });

    it('throws on failure response', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'Agent is online' });
      await expect(plugin.deleteAgent('a1')).rejects.toThrow('Agent is online');
    });

    it('throws generic error when no message provided', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false });
      await expect(plugin.deleteAgent('a1')).rejects.toThrow('Delete failed');
    });

    it('throws when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.deleteAgent('a1')).rejects.toThrow('Not authenticated');
    });
  });

  // ── Server ──────────────────────────────────────────────────

  describe('serverInfo', () => {
    it('returns server info', async () => {
      const info = { version: '1.0.0', uptime_seconds: 100, agent_count: 2, online_agent_count: 1, session_count: 5 };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(info);
      const result = await plugin.serverInfo();
      expect(result).toEqual(info);
      expect(core.request).toHaveBeenCalledWith('client.server.info', {});
    });
  });

  // ── Sessions ────────────────────────────────────────────────

  describe('listSessions', () => {
    it('returns sessions array', async () => {
      const sessions = [{ session_id: 's1', agent_id: 'a1', session_name: 'n1', status: 'active' as const, window_count: 1, attached_clients: 0, last_activity: 'x' }];
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions });
      const result = await plugin.listSessions();
      expect(result).toEqual(sessions);
      expect(core.request).toHaveBeenCalledWith('client.sessions.list', {});
    });

    it('passes agent_id when provided', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] });
      await plugin.listSessions('agent-42');
      expect(core.request).toHaveBeenCalledWith('client.sessions.list', { agent_id: 'agent-42' });
    });
  });

  describe('fetchSessions', () => {
    /** Without `force` in the payload the server answers from its registry, so
     *  the refresh button would not actually re-query agents. */
    it('sends force when requested', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] });
      await plugin.fetchSessions({ force: true });
      expect(core.request).toHaveBeenCalledWith('client.sessions.list', { force: true });
    });

    it('omits force by default', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] });
      await plugin.fetchSessions();
      expect(core.request).toHaveBeenCalledWith('client.sessions.list', {});
    });

    it('combines agent_id and force', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] });
      await plugin.fetchSessions({ agentId: 'a1', force: true });
      expect(core.request).toHaveBeenCalledWith('client.sessions.list', {
        agent_id: 'a1',
        force: true,
      });
    });

    it('returns stale_agents from the response', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        sessions: [],
        stale_agents: ['a1'],
      });
      const result = await plugin.fetchSessions({ force: true });
      expect(result.stale_agents).toEqual(['a1']);
    });

    /** Older servers omit the field entirely; callers should still get a list
     *  they can safely iterate. */
    it('defaults stale_agents to an empty array when absent', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [] });
      const result = await plugin.fetchSessions();
      expect(result.stale_agents).toEqual([]);
    });
  });

  describe('requestAttach', () => {
    it('sends attach request with default p2p mode', async () => {
      const info = { mode: 'p2p' as const, session_id: 's1', agent_address: 'ws://agent/ws', connection_token: 'tok' };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(info);
      const result = await plugin.requestAttach('s1');
      expect(result).toEqual(info);
      expect(core.request).toHaveBeenCalledWith('client.session.attach', {
        session_id: 's1',
        preferred_mode: 'p2p',
      });
    });

    it('sends relay mode with relayUrl', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: 'relay', session_id: 's1' });
      await plugin.requestAttach('s1', 'relay', 'wss://relay.example.com');
      expect(core.request).toHaveBeenCalledWith('client.session.attach', {
        session_id: 's1',
        preferred_mode: 'relay',
        relay_url: 'wss://relay.example.com',
      });
    });
  });

  describe('createSession', () => {
    it('sends create request with env_files', async () => {
      const resp = { success: true, session_id: 'new-sess' };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
      const envFiles = [{ name: 'dev.env', source: 'server' as const }];
      const result = await plugin.createSession('a1', 'my-session', envFiles);
      expect(result).toEqual(resp);
      expect(core.request).toHaveBeenCalledWith('client.session.create', {
        agent_id: 'a1',
        name: 'my-session',
        env_files: envFiles,
      });
    });

    it('defaults env_files to empty array', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.createSession('a1', 's');
      expect(core.request).toHaveBeenCalledWith('client.session.create', {
        agent_id: 'a1',
        name: 's',
        env_files: [],
      });
    });
  });

  describe('killSession', () => {
    it('sends kill request', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      const result = await plugin.killSession('sess-1');
      expect(result).toEqual({ success: true });
      expect(core.request).toHaveBeenCalledWith('client.session.kill', { session_id: 'sess-1' });
    });
  });

  // ── Env files ───────────────────────────────────────────────

  describe('listEnvFiles', () => {
    it('returns env list', async () => {
      const resp = { files: [{ name: 'a.env', source: 'server' as const, size: 100, modified: 0, var_count: 5 }] };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
      const result = await plugin.listEnvFiles();
      expect(result).toEqual(resp);
      expect(core.request).toHaveBeenCalledWith('client.env.list', {});
    });
  });

  describe('getEnvFile', () => {
    it('sends ref fields', async () => {
      const ref = { name: 'a.env', source: 'server' as const, agent_id: 'ag1' };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, content: 'X=1' });
      await plugin.getEnvFile(ref);
      expect(core.request).toHaveBeenCalledWith('client.env.get', {
        name: 'a.env', source: 'server', agent_id: 'ag1',
      });
    });
  });

  describe('writeEnvFile', () => {
    it('sends ref + content + overwrite + force', async () => {
      const ref = { name: 'a.env', source: 'agent' as const };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.writeEnvFile(ref, 'KEY=val', true, true);
      expect(core.request).toHaveBeenCalledWith('client.env.write', {
        name: 'a.env', source: 'agent', agent_id: undefined,
        content: 'KEY=val', overwrite: true, force: true,
      });
    });
  });

  describe('deleteEnvFile', () => {
    it('sends ref fields', async () => {
      const ref = { name: 'a.env', source: 'server' as const };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.deleteEnvFile(ref);
      expect(core.request).toHaveBeenCalledWith('client.env.delete', {
        name: 'a.env', source: 'server', agent_id: undefined,
      });
    });
  });

  describe('applySessionEnv', () => {
    it('sends session_id and env_files', async () => {
      const envFiles = [{ name: 'a.env', source: 'server' as const }];
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.applySessionEnv('s1', envFiles);
      expect(core.request).toHaveBeenCalledWith('client.session.env.apply', {
        session_id: 's1', env_files: envFiles,
      });
    });
  });

  describe('unsetSessionEnv', () => {
    it('sends session_id and env_files', async () => {
      const envFiles = [{ name: 'a.env', source: 'server' as const }];
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.unsetSessionEnv('s1', envFiles);
      expect(core.request).toHaveBeenCalledWith('client.session.env.unset', {
        session_id: 's1', env_files: envFiles,
      });
    });
  });

  describe('getSessionEnvActive', () => {
    it('sends session_id', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ active: [] });
      await plugin.getSessionEnvActive('s1');
      expect(core.request).toHaveBeenCalledWith('client.session.env.active', { session_id: 's1' });
    });
  });

  describe('queryAgentEnvState', () => {
    it('sends session_id', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ sourced_files: [] });
      await plugin.queryAgentEnvState('s1');
      expect(core.request).toHaveBeenCalledWith('client.session.env.query', { session_id: 's1' });
    });
  });

  // ── Commands ────────────────────────────────────────────────

  describe('listCommands', () => {
    it('returns commands', async () => {
      const resp = { commands: [{ id: 'c1', label: 'L', command: 'ls' }] };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
      const result = await plugin.listCommands();
      expect(result).toEqual(resp);
      expect(core.request).toHaveBeenCalledWith('client.commands.list', {});
    });
  });

  describe('addCommand', () => {
    it('sends label, command, raw flag', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, id: 'c1' });
      await plugin.addCommand('My Label', 'echo hi', true);
      expect(core.request).toHaveBeenCalledWith('client.commands.add', {
        label: 'My Label', command: 'echo hi', raw: true,
      });
    });

    it('defaults raw to false', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.addCommand('L', 'cmd');
      expect(core.request).toHaveBeenCalledWith('client.commands.add', {
        label: 'L', command: 'cmd', raw: false,
      });
    });
  });

  describe('removeCommand', () => {
    it('sends id', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.removeCommand('c1');
      expect(core.request).toHaveBeenCalledWith('client.commands.remove', { id: 'c1' });
    });
  });

  describe('updateCommand', () => {
    it('merges id with fields', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.updateCommand('c1', { label: 'NewLabel', raw: true });
      expect(core.request).toHaveBeenCalledWith('client.commands.update', {
        id: 'c1', label: 'NewLabel', raw: true,
      });
    });

    it('handles partial fields', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
      await plugin.updateCommand('c1', { command: 'new-cmd' });
      expect(core.request).toHaveBeenCalledWith('client.commands.update', {
        id: 'c1', command: 'new-cmd',
      });
    });
  });

  // ── Capture Preview ─────────────────────────────────────────

  describe('capturePreview', () => {
    it('throws when not authenticated', async () => {
      const unauthCore = createMockCore(false);
      plugin.install(unauthCore);
      await expect(plugin.capturePreview('a:b', 100)).rejects.toThrow('Not authenticated');
    });

    it('throws on invalid lines', async () => {
      await expect(plugin.capturePreview('a:b', 0)).rejects.toThrow('Invalid lines');
      await expect(plugin.capturePreview('a:b', -1)).rejects.toThrow('Invalid lines');
      await expect(plugin.capturePreview('a:b', 1.5)).rejects.toThrow('Invalid lines');
    });

    it('sends correct msg_type + payload and decodes base64', async () => {
      const ansi = 'hello world';
      const b64 = btoa(ansi);
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        ansi_b64: b64,
        cols: 80,
        rows: 24,
      });
      const result = await plugin.capturePreview('agent1:sess1', 500);
      expect(core.request).toHaveBeenCalledWith('client.session.capture_preview', {
        session_id: 'agent1:sess1',
        lines: 500,
      });
      expect(result).toEqual({ ansi, cols: 80, rows: 24 });
    });

    it('throws on error response', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({
        error: 'Agent offline',
      });
      await expect(plugin.capturePreview('a:b', 100)).rejects.toThrow('Agent offline');
    });

    it('throws when no data returned', async () => {
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await expect(plugin.capturePreview('a:b', 100)).rejects.toThrow('no data returned');
    });
  });

  // ── Claude Code Extension ───────────────────────────────────

  describe('claudeCodeList', () => {
    it('sends extension.claude_code.list request', async () => {
      const req = { agent_id: 'a1', scope: 'global' as const };
      const resp = { available: true, categories: [] };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
      const result = await plugin.claudeCodeList(req);
      expect(result).toEqual(resp);
      expect(core.request).toHaveBeenCalledWith('extension.claude_code.list', req);
    });
  });

  describe('claudeCodeRead', () => {
    it('sends extension.claude_code.read request', async () => {
      const req = { agent_id: 'a1', scope: 'global' as const, path: '/test.txt' };
      const resp = { content: 'test', content_type: 'text/plain', total_size: 4, offset: 0, has_more: false };
      (core.request as ReturnType<typeof vi.fn>).mockResolvedValue(resp);
      const result = await plugin.claudeCodeRead(req);
      expect(result).toEqual(resp);
      expect(core.request).toHaveBeenCalledWith('extension.claude_code.read', req);
    });
  });
});
